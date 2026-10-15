import { randomUUID } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { INTERNAL_TENANT_ID } from './catalog-auth';
import { releaseQuota, reserveQuota, settleQuota } from './quota';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { fileSha256, inspectCatalogImage, readCatalogFile, saveCatalogFile } from './catalog-files';
import { CatalogHttpError } from './catalog-auth';
import { loadBodyGeometry } from './catalog-body-geometry';

const safeFilename = z.string().min(1).max(255).refine(s => !s.includes('/') && !s.includes('\\') && s !== '.' && s !== '..', '文件名不得包含目录');
const entrySchema = z.object({ filename: safeFilename, styleCode: z.string().min(1).nullable(), colorName: z.string().min(1).nullable(), layout: z.enum(['front_back', 'front_only', 'unresolved']), sha256: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().positive(), height: z.number().int().positive(), byteLength: z.number().int().positive(), hasAlpha: z.boolean(), issue: z.string().nullable(), sources: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()) }).strict();
export const manifestSchema = z.object({ schemaVersion: z.literal(1), sourceNamespace: z.string().min(1).max(100), sourceRoot: z.string(), outputDirectory: z.string(), entries: z.array(entrySchema).min(1).max(10000), sourceIssues: z.array(z.object({ path: z.string(), issue: z.string() }).strict()) }).strict();
export type CatalogManifest = z.infer<typeof manifestSchema>;

function colorFromSource(filename: string, style: string) {
  let color = path.parse(filename).name;
  if (color.startsWith(`${style}-`)) color = color.slice(style.length + 1);
  else if (style === '3301SRX' && color.startsWith(style)) color = color.slice(style.length);
  if (style === '6片纯棉铜扣XDMY') color = color.replace(/[14]$/u, '');
  return color.replace(/-?调色后$/u, '').replace(/\s*\([123]\)$/u, '').replace(/(?:前|后)$/u, '').trim();
}
export async function buildCatalogManifest(sourceRoot: string): Promise<CatalogManifest> {
  const root = await realpath(sourceRoot);
  const outputDirectory = path.join(root, '全部处理');
  const sourceGroups: { style: string; directory: string; files: string[] }[] = [];
  for (const section of await readdir(root, { withFileTypes: true })) {
    if (!section.isDirectory() || !section.name.startsWith('底图部分汇总')) continue;
    for (const group of await readdir(path.join(root, section.name), { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const directory = path.join(root, section.name, group.name);
      sourceGroups.push({ style: group.name, directory, files: (await readdir(directory)).filter(f => /\.(png|jpe?g|webp)$/i.test(f)) });
    }
  }
  sourceGroups.sort((a, b) => b.style.length - a.style.length);
  const sourceIssues: CatalogManifest['sourceIssues'] = [];
  for (const group of sourceGroups) for (const filename of group.files) {
    const location = path.join(group.directory, filename);
    if ((await stat(location)).size === 0) sourceIssues.push({ path: path.relative(root, location), issue: '源文件为 0 字节，未生成对应底图' });
  }
  const entries: CatalogManifest['entries'] = [];
  for (const filename of (await readdir(outputDirectory)).filter(f => f.endsWith('.png')).sort()) {
    const bytes = await readFile(path.join(outputDirectory, filename));
    const metadata = await inspectCatalogImage(bytes);
    const group = sourceGroups.find(g => filename.startsWith(`${g.style}-`));
    const colorName = group ? filename.slice(group.style.length + 1, -4) : null;
    const ambiguous = !group || /男款.*女款/u.test(group.style) || !colorName;
    const sources: CatalogManifest['entries'][number]['sources'] = [];
    if (group && !ambiguous) for (const candidate of group.files) {
      if (/\(3\)\./.test(candidate) && group.style === 'NS-2288') continue;
      if (colorFromSource(candidate, group.style) !== colorName) continue;
      const source = await readFile(path.join(group.directory, candidate));
      if (source.length) sources.push({ path: path.relative(root, path.join(group.directory, candidate)), sha256: fileSha256(source) });
    }
    const layout = ambiguous ? 'unresolved' : metadata.width === 2560 && metadata.height === 1536 ? 'front_back' : 'front_only';
    entries.push({ filename, styleCode: ambiguous ? null : group!.style, colorName: ambiguous ? null : colorName, layout, sha256: metadata.sha256, width: metadata.width, height: metadata.height, byteLength: metadata.byteLength, hasAlpha: metadata.hasAlpha, sources,
      issue: ambiguous ? '文件名包含多个款号或无法唯一归属；保留文件，等待确认具体款式' : null });
  }
  return manifestSchema.parse({ schemaVersion: 1, sourceNamespace: 'normalized-garments-v1', sourceRoot: root, outputDirectory, entries, sourceIssues });
}
type AssetInput = {
  namespace: string; styleCode: string; colorName: string; layout: 'front_back' | 'front_only';
  bytes: Buffer; filename: string; provenance: Record<string, unknown>;
  sources: { fileId: string; sourcePath: string }[];
  expectedAssetVersionId?: string; actorId?: string;
  /** Owner of the resulting style and files. Existing callers are all internal-facing. */
  tenantId?: string;
};
export async function importCatalogAsset(input: AssetInput) {
  if (!input.styleCode.trim() || !input.colorName.trim() || input.styleCode.length > 200 || input.colorName.length > 100) throw new CatalogHttpError(400, '款号和颜色必填，款号最多 200 字、颜色最多 100 字');
  const tenantId = input.tenantId ?? INTERNAL_TENANT_ID;
  const thumbBytes = await sharp(input.bytes).resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  const reservationId = randomUUID();
  // Capacity is held before any object is written, because the object store commits on its
  // own and would otherwise leave bytes behind that nobody accounted for.
  const known = await catalogDatabase().query(
    'SELECT 1 FROM garment_styles WHERE tenant_id=$1 AND source_namespace=$2 AND style_code=$3',
    [tenantId, input.namespace, input.styleCode]);
  await catalogTransaction(client => reserveQuota(client, {
    id: reservationId, tenantId,
    bytes: input.bytes.length + thumbBytes.length,
    styles: known.rowCount ? 0 : 1,
  }));
  try {
    return await importReservedAsset(input, tenantId, reservationId, thumbBytes);
  } catch (error) {
    await releaseQuota(reservationId, tenantId).catch(() => {});
    throw error;
  }
}
async function importReservedAsset(input: AssetInput, tenantId: string, reservationId: string, thumbBytes: Buffer) {
  const file = await saveCatalogFile(input.bytes, input.filename);
  const thumbnail = await saveCatalogFile(thumbBytes, `${input.filename}.thumb.webp`);
  const faces = input.layout === 'front_back' ? ['front', 'back'] : ['front'];
  const crops = faces.map(face => ({ x: face === 'back' ? 0.5 : 0, y: 0, width: input.layout === 'front_back' ? 0.5 : 1, height: 1 }));
  // Prepare geometry before publishing the new asset as the current version.
  await loadBodyGeometry({ fileId: file.id, sha256: file.sha256, width: file.width, height: file.height, crops }, input.bytes);
  let addedBytes = 0; let addedStyles = 0;
  const result = await catalogTransaction(async client => {
    // `xmax = 0` distinguishes a real insert from the conflict branch, so quota counts the
    // style only when one was actually created.
    const style = await client.query('INSERT INTO garment_styles(id,tenant_id,source_namespace,style_code,name) VALUES($1,$2,$3,$4,$4) ON CONFLICT(tenant_id,source_namespace,style_code) DO UPDATE SET style_code=EXCLUDED.style_code RETURNING id,(xmax = 0) AS inserted', [randomUUID(), tenantId, input.namespace, input.styleCode]);
    addedStyles = style.rows[0].inserted ? 1 : 0;
    // Access is granted by a tenant-owned reference, not by knowing the id or the content hash.
    for (const [id, purpose, size] of [[file.id, 'garment', input.bytes.length], [thumbnail.id, 'garment-thumb', thumbBytes.length]] as const) {
      const added = await client.query('INSERT INTO tenant_file_refs(tenant_id,file_id,purpose,display_name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING file_id', [tenantId, id, purpose, input.filename]);
      // A file this tenant already references costs no additional capacity.
      if (added.rowCount) addedBytes += size;
    }
    for (const source of input.sources) {
      await client.query('INSERT INTO tenant_file_refs(tenant_id,file_id,purpose,display_name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [tenantId, source.fileId, 'asset-source', source.sourcePath]);
    }
    const variants = await client.query('INSERT INTO garment_variants(id,style_id,color_name) VALUES($1,$2,$3) ON CONFLICT(style_id,color_name) DO UPDATE SET color_name=EXCLUDED.color_name RETURNING id,current_asset_version_id', [randomUUID(), style.rows[0].id, input.colorName]);
    const variant = variants.rows[0];
    const existing = await client.query('SELECT id,layout FROM garment_asset_versions WHERE variant_id=$1 AND file_id=$2', [variant.id, file.id]);
    if (existing.rowCount) {
      if (existing.rows[0].layout !== input.layout) throw new Error(`相同文件已有不同视图布局：${input.filename}`);
      // A later source inventory can add evidence without replacing pixels or standards.
      for (const source of input.sources) {
        const added = await client.query('INSERT INTO asset_sources(asset_version_id,file_id,source_path) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING file_id', [existing.rows[0].id, source.fileId, source.sourcePath]);
        if (added.rowCount) await client.query('INSERT INTO audit_events(id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)', [randomUUID(), input.actorId ?? null, 'asset.addSourceCandidate', existing.rows[0].id, { sourcePath: source.sourcePath, fileId: source.fileId }]);
      }
      return { variantId: variant.id as string, assetVersionId: existing.rows[0].id as string, fileId: file.id, reused: true };
    }
    if (variant.current_asset_version_id && variant.current_asset_version_id !== input.expectedAssetVersionId) throw new CatalogHttpError(409, `款式 ${input.styleCode} / ${input.colorName} 已有其他底图，请在商品详情中明确换版`);
    if (input.expectedAssetVersionId && variant.current_asset_version_id !== input.expectedAssetVersionId) throw new CatalogHttpError(409, '底图已经换版，请刷新后重新上传');
    const next = await client.query('SELECT COALESCE(MAX(version),0)+1 AS version FROM garment_asset_versions WHERE variant_id=$1', [variant.id]);
    const id = randomUUID();
    await client.query('INSERT INTO garment_asset_versions(id,variant_id,version,file_id,thumbnail_file_id,layout,provenance) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, variant.id, next.rows[0].version, file.id, thumbnail.id, input.layout, input.provenance]);
    for (const face of (input.layout === 'front_back' ? ['front', 'back'] : ['front'])) {
      const crop = { x: face === 'back' ? 0.5 : 0, y: 0, width: input.layout === 'front_back' ? 0.5 : 1, height: 1 };
      await client.query('INSERT INTO garment_views(id,asset_version_id,face,crop) VALUES($1,$2,$3,$4)', [randomUUID(), id, face, crop]);
    }
    for (const source of input.sources) await client.query('INSERT INTO asset_sources(asset_version_id,file_id,source_path) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [id, source.fileId, source.sourcePath]);
    await client.query('UPDATE garment_variants SET current_asset_version_id=$2 WHERE id=$1', [variant.id, id]);
    await client.query('INSERT INTO audit_events(id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)', [randomUUID(), input.actorId ?? null, 'asset.import', id, { filename: input.filename, sha256: file.sha256, previousAssetVersionId: variant.current_asset_version_id }]);
    return { variantId: variant.id as string, assetVersionId: id, fileId: file.id, reused: false };
  });
  // Settle with what was actually added: a de-duplicated file or an existing style costs
  // nothing, and the unused part of the reservation goes back.
  await settleQuota(reservationId, tenantId, { bytes: addedBytes, styles: addedStyles });
  return result;
}
async function verifiedSourcePath(root: string, relative: string) {
  const canonicalRoot = await realpath(root);
  const resolved = await realpath(path.resolve(root, relative));
  if (!resolved.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error(`来源路径越界：${relative}`);
  return resolved;
}
export async function importCatalogManifest(raw: unknown, progress: (message: string) => void = () => {}, tenantId = INTERNAL_TENANT_ID) {
  const manifest = manifestSchema.parse(raw);
  const hash = fileSha256(JSON.stringify(manifest));
  const batch = await catalogDatabase().query('INSERT INTO import_batches(id,tenant_id,manifest_hash,source_namespace,manifest) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,manifest_hash) DO UPDATE SET manifest_hash=EXCLUDED.manifest_hash RETURNING id', [randomUUID(), tenantId, hash, manifest.sourceNamespace, manifest]);
  const batchId = batch.rows[0].id as string;
  for (const entry of manifest.entries) {
    await catalogDatabase().query("INSERT INTO import_items(batch_id,filename,status) VALUES($1,$2,'pending') ON CONFLICT DO NOTHING", [batchId, entry.filename]);
    try {
      const outputPath = await verifiedSourcePath(manifest.outputDirectory, entry.filename);
      const bytes = await readFile(outputPath);
      if (fileSha256(bytes) !== entry.sha256) throw new Error(`底图在清单建立后发生变化：${entry.filename}`);
      if (entry.layout === 'unresolved' || !entry.styleCode || !entry.colorName) {
        const file = await saveCatalogFile(bytes, entry.filename);
        await catalogDatabase().query("UPDATE import_items SET status='quarantined',file_id=$3,error=$4,updated_at=now() WHERE batch_id=$1 AND filename=$2", [batchId, entry.filename, file.id, entry.issue]);
        continue;
      }
      const sources: AssetInput['sources'] = [];
      for (const source of entry.sources) {
        const original = await readFile(await verifiedSourcePath(manifest.sourceRoot, source.path));
        if (fileSha256(original) !== source.sha256) throw new Error(`原文件在清单建立后发生变化：${source.path}`);
        const saved = await saveCatalogFile(original, path.basename(source.path));
        sources.push({ fileId: saved.id, sourcePath: source.path });
      }
      const imported = await importCatalogAsset({ tenantId, namespace: manifest.sourceNamespace, styleCode: entry.styleCode, colorName: entry.colorName, bytes, filename: entry.filename, layout: entry.layout, sources,
        provenance: { manifestHash: hash, originalFilename: entry.filename, processing: '已有规范成品；本次不重绘', sourceMappingStatus: 'filename_candidates_not_reviewed', sourceCandidateCount: sources.length, layoutBasis: '已确认的规范成品：双面左正右反；单面保留场景' } });
      await catalogDatabase().query("UPDATE import_items SET status='imported',file_id=$3,asset_version_id=$4,error=NULL,updated_at=now() WHERE batch_id=$1 AND filename=$2", [batchId, entry.filename, imported.fileId, imported.assetVersionId]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await catalogDatabase().query("UPDATE import_items SET status='failed',error=$3,updated_at=now() WHERE batch_id=$1 AND filename=$2", [batchId, entry.filename, message]);
      progress(`失败 ${entry.filename}：${message}`);
    }
    progress(`已处理 ${entry.filename}`);
  }
  const summary = await catalogDatabase().query('SELECT status,count(*)::int AS count FROM import_items WHERE batch_id=$1 GROUP BY status ORDER BY status', [batchId]);
  return { batchId, manifestHash: hash, counts: summary.rows as { status: string; count: number }[] };
}
export async function verifyCatalogFiles() {
  const files = await catalogDatabase().query("SELECT id FROM files WHERE status='ready' ORDER BY id");
  for (const file of files.rows) await readCatalogFile(file.id);
  return { verifiedFiles: files.rowCount };
}
