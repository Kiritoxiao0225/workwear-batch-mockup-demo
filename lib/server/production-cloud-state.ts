import type { WpsProductionState } from '@/lib/wps-production';
import { isDeepStrictEqual } from 'node:util';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { productionFileReferences, productionStateKey } from './production-storage';
import { queueReplacedFiles } from './production-replaced-files';

export async function readCloudProductionState(): Promise<WpsProductionState> {
  const row = (await catalogDatabase().query('SELECT state_jsonb FROM production_states WHERE state_key=$1', [productionStateKey()])).rows[0];
  if (!row) throw new Error('云端生产状态尚未初始化；请先完成迁移');
  return row.state_jsonb;
}

/** Preview requests arrive in parallel. Transfer only this version and its units,
 * while retaining the state-row lock when publishing a current render pointer. */
export async function readCloudProductionPreviewState(versionId: string, client: CatalogQueryClient = catalogDatabase(), lock = false) {
  const row = (await client.query(`SELECT jsonb_build_object(
    'mockupVersions', COALESCE((SELECT jsonb_agg(v) FROM jsonb_array_elements(s.state_jsonb->'mockupVersions') v WHERE v->>'id'=$2), '[]'::jsonb),
    'units', COALESCE((SELECT jsonb_agg(u) FROM jsonb_array_elements(s.state_jsonb->'units') u WHERE u->>'id' IN (
      SELECT jsonb_array_elements_text(v->'unitIds') FROM jsonb_array_elements(s.state_jsonb->'mockupVersions') v WHERE v->>'id'=$2
    )), '[]'::jsonb)
  ) AS state_jsonb FROM production_states s WHERE s.state_key=$1${lock ? ' FOR UPDATE OF s' : ''}`, [productionStateKey(), versionId])).rows[0];
  return row ? row.state_jsonb as Pick<WpsProductionState, 'mockupVersions' | 'units'> : null;
}

export async function readCloudProductionSourceOrder(): Promise<string[]> {
  const row = (await catalogDatabase().query("SELECT state_jsonb->'sourceRecordOrder' AS source_order FROM production_states WHERE state_key=$1", [productionStateKey()])).rows[0];
  if (!row) throw new Error('云端生产状态尚未初始化；请先完成迁移');
  return row.source_order ?? [];
}
export async function writeCloudProductionState(client: CatalogQueryClient, state: WpsProductionState, key = productionStateKey()) {
  const refs = productionFileReferences(state);
  const ids = [...new Set(refs.map(ref => ref.id))].sort();
  if (ids.length) {
    const ready = await client.query("SELECT id FROM files WHERE id=ANY($1::uuid[]) AND status='ready' AND gc_state='active' ORDER BY id FOR SHARE", [ids]);
    if (ready.rowCount !== ids.length) throw new Error('生产状态包含未完成上传或正在回收的文件');
  }
  const removed = await client.query(`SELECT DISTINCT file_id FROM production_file_refs WHERE state_key=$1 AND NOT(file_id=ANY($2::uuid[]))
    UNION SELECT file_id FROM production_renders WHERE state_key=$1 AND NOT(version_id=ANY($3::text[])) AND file_id IS NOT NULL`, [key, ids, state.mockupVersions.map(version => version.id)]);
  await queueReplacedFiles(client, removed.rows.map(row => row.file_id));
  await client.query(`INSERT INTO production_states(state_key,revision,state_jsonb) VALUES($1,$2,$3::jsonb)
    ON CONFLICT(state_key) DO UPDATE SET revision=EXCLUDED.revision,state_jsonb=EXCLUDED.state_jsonb,updated_at=now()`, [key, state.revision, state]);
  await client.query('DELETE FROM production_file_refs WHERE state_key=$1', [key]);
  if (refs.length) await client.query(`INSERT INTO production_file_refs(state_key,ref_key,file_id)
    SELECT $1,ref,id::uuid FROM jsonb_to_recordset($2::jsonb) AS r(ref text,id text)`, [key, refs]);
  await client.query('DELETE FROM production_renders WHERE state_key=$1 AND NOT(version_id=ANY($2::text[]))', [key, state.mockupVersions.map(version => version.id)]);
}
/** Expensive validation happens before this short compare-and-swap transaction. */
export async function commitCloudProductionState(current: WpsProductionState, next: WpsProductionState, receipt?: { id: string; hash: string }) {
  return catalogTransaction(async client => {
    const row = (await client.query('SELECT revision FROM production_states WHERE state_key=$1 FOR UPDATE', [productionStateKey()])).rows[0];
    if (!row || Number(row.revision) !== current.revision) return false;
    // Enqueue holds a share lock on this state row. Membership cannot change
    // between its snapshot check and insertion, including from another browser.
    const allIds = new Set([...current.units, ...next.units].map(unit => unit.id));
    const changed = [...allIds].filter(id => current.units.find(unit => unit.id === id)?.sharedArtworkId !== next.units.find(unit => unit.id === id)?.sharedArtworkId);
    const affectedGroups = new Set([...current.units, ...next.units].filter(unit => changed.includes(unit.id)).map(unit => unit.sharedArtworkId).filter(Boolean));
    const changedMembership = [...new Set([...changed, ...[...current.units, ...next.units].filter(unit => unit.sharedArtworkId && affectedGroups.has(unit.sharedArtworkId)).map(unit => unit.id)])];
    if (changedMembership.length) {
      const jobs = await client.query("SELECT 1 FROM artwork_jobs WHERE state_key=$1 AND unit_id=ANY($2::text[]) AND status IN ('queued','running','unknown') LIMIT 1", [productionStateKey(), changedMembership]);
      if (jobs.rowCount) throw new Error('图案正在制作，暂不能更改共用关系');
    }
    // Existing references already protect these files from collection. Moving a
    // Logo or editing text does not require deleting/reinserting every reference.
    const references = (state: WpsProductionState) => productionFileReferences(state).sort((a, b) => a.ref.localeCompare(b.ref));
    const oldRefs = references(current), newRefs = references(next);
    const sameReferences = isDeepStrictEqual(oldRefs, newRefs);
    const sameVersions = isDeepStrictEqual(current.mockupVersions.map(v => v.id).sort(), next.mockupVersions.map(v => v.id).sort());
    if (sameVersions) {
      if (!sameReferences) {
        const oldByRef = new Map(oldRefs.map(ref => [ref.ref, ref.id]));
        const newByRef = new Map(newRefs.map(ref => [ref.ref, ref.id]));
        const changed = newRefs.filter(ref => oldByRef.get(ref.ref) !== ref.id);
        const removed = oldRefs.filter(ref => !newByRef.has(ref.ref)).map(ref => ref.ref);
        // The existing protect_production_ref trigger locks and verifies every
        // inserted/updated file. Unchanged references remain protected from GC.
        if (changed.length) await client.query(`INSERT INTO production_file_refs(state_key,ref_key,file_id)
          SELECT $1,ref,id::uuid FROM jsonb_to_recordset($2::jsonb) AS r(ref text,id text)
          ON CONFLICT(state_key,ref_key) DO UPDATE SET file_id=EXCLUDED.file_id`, [productionStateKey(), changed]);
        if (removed.length) await client.query('DELETE FROM production_file_refs WHERE state_key=$1 AND ref_key=ANY($2::text[])', [productionStateKey(), removed]);
        const retainedIds = new Set(newRefs.map(ref => ref.id));
        await queueReplacedFiles(client, [...new Set(oldRefs.map(ref => ref.id).filter(id => !retainedIds.has(id)))]);
      }
      await client.query('UPDATE production_states SET revision=$2,state_jsonb=$3::jsonb,updated_at=now() WHERE state_key=$1', [productionStateKey(), next.revision, next]);
    } else await writeCloudProductionState(client, next);
    if (receipt) await client.query('INSERT INTO production_save_receipts(operation_id,state_key,request_hash,revision) VALUES($1,$2,$3,$4)', [receipt.id, productionStateKey(), receipt.hash, next.revision]);
    return true;
  });
}
export async function completedProductionSave(receipt: { id: string; hash: string }) {
  const row = (await catalogDatabase().query('SELECT state_key,request_hash FROM production_save_receipts WHERE operation_id=$1', [receipt.id])).rows[0];
  if (!row) return false;
  if (row.state_key !== productionStateKey() || row.request_hash !== receipt.hash) throw new Error('相同保存操作 ID 不能用于不同内容');
  return true;
}
