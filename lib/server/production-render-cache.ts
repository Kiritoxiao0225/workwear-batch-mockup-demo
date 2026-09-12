import { CONFIRMATION_FRAME } from '@/lib/confirmation-frame';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProductionMockupVersion, ProductionUnit } from '@/lib/wps-production';
import { WPS_COMPOSITOR_VERSION } from '@/lib/wps-production';
import { productionPlacementGeometry } from '@/lib/production-garment';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { fileSha256, readCatalogFile } from './catalog-files';
import { productionStateKey, saveProductionFile } from './production-storage';
import { productionPreviewUnits, renderProductionMockup } from './wps-production-assets';
import { readCloudProductionPreviewState } from './production-cloud-state';
import { queueReplacedFiles } from './production-replaced-files';

function sourceFingerprint(version: ProductionMockupVersion, units: ProductionUnit[]) {
  return fileSha256(JSON.stringify({ garment: version.garment, units: units.map(unit => ({ id: unit.id, garment: unit.garment,
    placement: unit.placement, confirmedPlacement: Boolean(unit.gateA), artwork: unit.artwork?.validation.sha256 })) },
  (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value));
}
async function renderFingerprint(version: ProductionMockupVersion, units: ProductionUnit[]) {
  const frame = await readFile(path.join(process.cwd(), 'public', CONFIRMATION_FRAME.assetPath));
  return fileSha256(JSON.stringify({ compositor: WPS_COMPOSITOR_VERSION, frame: fileSha256(frame),
    garment: { sha256: version.garment?.sha256, width: version.garment?.width, height: version.garment?.height,
      views: version.garment?.views.map(({ face, crop }) => ({ face, crop })) },
    overlays: units.map(unit => {
      const artwork = unit.artwork!.validation;
      const bounds = artwork.contentBounds ?? artwork;
      return { sha256: artwork.sha256, geometry: productionPlacementGeometry(unit.garment!, unit.placement!, bounds.width / bounds.height), rotation: unit.placement!.rotation };
    }) }));
}

async function publishCurrent(version: ProductionMockupVersion, originalUnits: ProductionUnit[], inputHash: string, fileId: string) {
  const expected = sourceFingerprint(version, originalUnits);
  return catalogTransaction(async client => {
    const state = await readCloudProductionPreviewState(version.id, client, true);
    if (!state) { await queueReplacedFiles(client, [fileId]); return false; }
    const latest = state.mockupVersions.find(candidate => candidate.id === version.id);
    if (!latest) { await queueReplacedFiles(client, [fileId]); return false; }
    const units = latest.unitIds.map(id => state.units.find(unit => unit.id === id)!);
    if (sourceFingerprint(latest, units) !== expected) { await queueReplacedFiles(client, [fileId]); return false; }
    const removed = await client.query('SELECT file_id FROM production_renders WHERE state_key=$1 AND version_id=$2 AND file_id<>$3', [productionStateKey(), version.id, fileId]);
    await client.query(`INSERT INTO production_renders(state_key,version_id,input_hash,file_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(state_key,version_id) DO UPDATE SET input_hash=EXCLUDED.input_hash,file_id=EXCLUDED.file_id,updated_at=now()`, [productionStateKey(), version.id, inputHash, fileId]);
    await queueReplacedFiles(client, removed.rows.map(row => row.file_id));
    return true;
  });
}

const rendering = new Map<string, Promise<Buffer>>();
function renderPixels(version: ProductionMockupVersion, units: ProductionUnit[], hash: string) {
  const active = rendering.get(hash);
  if (active) return active;
  const work = renderProductionMockup(version, units);
  rendering.set(hash, work);
  void work.finally(() => { if (rendering.get(hash) === work) rendering.delete(hash); }).catch(() => {});
  return work;
}

/** A preview can display verified source pixels without waiting for durable output storage.
 * The caller must schedule persist in Next after(); delivery still awaits savedProductionRender.
 */
export async function prepareProductionPreview(version: ProductionMockupVersion, originalUnits: ProductionUnit[]) {
  const units = await productionPreviewUnits(originalUnits, version);
  const hash = await renderFingerprint(version, units);
  const hit = await catalogDatabase().query(`SELECT c.file_id,EXISTS(
    SELECT 1 FROM production_renders r WHERE r.state_key=$2 AND r.version_id=$3 AND r.input_hash=c.input_hash AND r.file_id=c.file_id
  ) AS is_current FROM production_render_cache c JOIN files f ON f.id=c.file_id
    WHERE c.input_hash=$1 AND f.status='ready' AND f.gc_state='active'`, [hash, productionStateKey(), version.id]);
  if (hit.rowCount) {
    const cached = await readCatalogFile(hit.rows[0].file_id);
    return { bytes: cached.bytes, persist: async () => {
      if (!await publishCurrent(version, originalUnits, hash, hit.rows[0].file_id)) throw new Error('合成期间要求或位置已变化，旧预览没有发布为当前结果');
    } };
  }
  // A concurrent writer may own the durable claim. Do not make the preview wait
  // for its OSS upload/verification; the same instance shares in-flight pixels.
  const bytes = await renderPixels(version, units, hash);
  return { bytes, persist: async () => { await savedProductionRender(version, originalUnits, { hash, bytes }); } };
}

/** Durable input cache plus a short renewable claim; rendering never holds a state/database lock. */
export async function savedProductionRender(version: ProductionMockupVersion, originalUnits: ProductionUnit[], prepared?: { hash: string; bytes: Buffer }) {
  const units = await productionPreviewUnits(originalUnits, version);
  const hash = await renderFingerprint(version, units);
  const owner = randomUUID();
  const operationKey = `render:${hash}`;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const hit = await catalogDatabase().query(`SELECT c.file_id,EXISTS(
        SELECT 1 FROM production_renders r WHERE r.state_key=$2 AND r.version_id=$3 AND r.input_hash=c.input_hash AND r.file_id=c.file_id
      ) AS is_current FROM production_render_cache c JOIN files f ON f.id=c.file_id
      WHERE c.input_hash=$1 AND f.status='ready' AND f.gc_state='active'`, [hash, productionStateKey(), version.id]);
    if (hit.rowCount) {
      // File integrity and current-input publication are independent checks.
      // Complete both before returning, without serializing OSS and SQL waits.
      const [cached] = await Promise.all([
        readCatalogFile(hit.rows[0].file_id),
        publishCurrent(version, originalUnits, hash, hit.rows[0].file_id).then(current => {
          if (!current) throw new Error('合成期间要求或位置已变化，请读取最新效果图');
        }),
      ]);
      return cached;
    }
    const claim = await catalogDatabase().query(`INSERT INTO production_operations(operation_key,owner,lease_until) VALUES($1,$2,now()+interval '5 minutes')
      ON CONFLICT(operation_key) DO UPDATE SET owner=EXCLUDED.owner,lease_until=EXCLUDED.lease_until,updated_at=now()
      WHERE production_operations.lease_until<now() RETURNING owner`, [operationKey, owner]);
    if (!claim.rowCount) { await new Promise(resolve => setTimeout(resolve, 500)); continue; }
    try {
      const png = prepared?.hash === hash ? prepared.bytes : await renderPixels(version, units, hash);
      const saved = await saveProductionFile(png, `${version.id}.png`);
      await catalogDatabase().query(`INSERT INTO production_render_cache(input_hash,file_id) VALUES($1,$2)
        ON CONFLICT(input_hash) DO UPDATE SET file_id=EXCLUDED.file_id`, [hash, saved.id]);
      if (!await publishCurrent(version, originalUnits, hash, saved.id)) throw new Error('合成期间要求或位置已变化，旧图已保留但没有作为当前效果图返回');
      return { file: { id: saved.id, sha256: saved.sha256, width: saved.width, height: saved.height,
        byte_length: saved.byteLength, mime_type: saved.mimeType }, bytes: png };
    } finally { await catalogDatabase().query('DELETE FROM production_operations WHERE operation_key=$1 AND owner=$2', [operationKey, owner]); }
  }
  throw new Error('效果图仍在生成，请稍后刷新；图层与 PNG 已保存');
}
