import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';
import { saveCatalogFile, readCatalogFile } from './catalog-files';
import { registerFileRef, assertFileAccess } from './file-authorization';
import { assetUrl, parseProjectState, stateAssets } from '../garment-editor/project-state';
import type { CustomizationState } from '../garment-editor/mockup-types';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function listProjects(tenant: string) {
  return (await catalogDatabase().query(`SELECT p.id,p.name,p.revision,p.updated_at,
    (SELECT r.state_json->'elements'->0->>'image' FROM garment_mockup_revisions r WHERE r.project_id=p.id AND r.revision=p.revision) thumbnail
    FROM garment_mockup_projects p WHERE p.tenant_id=$1 AND p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT 100`,[tenant])).rows;
}
export async function projectDetail(tenant: string,id: string,revision?: number) {
  z.uuid().parse(id);
  const p=(await catalogDatabase().query('SELECT * FROM garment_mockup_projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL',[id,tenant])).rows[0];
  if(!p)throw new CatalogHttpError(404,'工程不存在');
  const r=revision??p.revision;
  const data=r ? (await catalogDatabase().query('SELECT state_json FROM garment_mockup_revisions WHERE project_id=$1 AND revision=$2',[id,r])).rows[0] : null;
  if(r && !data)throw new CatalogHttpError(404,'工程版本不存在');
  return {id:p.id,name:p.name,revision:p.revision,viewRevision:r,state:(data?.state_json??{elements:[]}) as CustomizationState};
}
export async function saveProject(tenant: string,user: string,input: unknown) {
  const b=z.object({id:z.uuid(),name:z.string().trim().min(1).max(120),expectedRevision:z.number().int().nonnegative(),requestId:z.uuid(),state:z.unknown()}).parse(input);
  const state=parseProjectState(b.state),hash=digest({...b,state});
  return catalogTransaction(async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",['garment-project:'+b.id]);
    const p=(await c.query('SELECT * FROM garment_mockup_projects WHERE id=$1 FOR UPDATE',[b.id])).rows[0];
    if(p && (p.tenant_id!==tenant || p.deleted_at))throw new CatalogHttpError(404,'工程不存在');
    const previous=(await c.query('SELECT revision,request_hash FROM garment_mockup_revisions WHERE project_id=$1 AND request_id=$2',[b.id,b.requestId])).rows[0];
    if(previous){if(previous.request_hash!==hash)throw new CatalogHttpError(409,'重复保存编号对应不同内容');return {id:b.id,revision:previous.revision};}
    if((p?.revision??0)!==b.expectedRevision)throw new CatalogHttpError(409,'工程已在另一个窗口更新，请另存副本或重新打开');
    const ids=stateAssets(state);
    const assets=ids.length ? await c.query('SELECT id FROM garment_mockup_assets WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[tenant,ids]) : {rowCount:0};
    if(assets.rowCount!==ids.length)throw new CatalogHttpError(404,'工程文件不存在或不属于当前账号');
    if(!p)await c.query('INSERT INTO garment_mockup_projects(id,tenant_id,created_by,name) VALUES($1,$2,$3,$4)',[b.id,tenant,user,b.name]);
    const revision=b.expectedRevision+1;
    await c.query('INSERT INTO garment_mockup_revisions(project_id,revision,state_json,request_id,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6)',[b.id,revision,state,b.requestId,hash,user]);
    await c.query('UPDATE garment_mockup_projects SET name=$2,revision=$3,updated_at=now() WHERE id=$1',[b.id,b.name,revision]);
    return {id:b.id,revision};
  });
}
export async function readAsset(tenant: string,id: string) {
  z.uuid().parse(id);
  const r=(await catalogDatabase().query('SELECT file_id,name,source FROM garment_mockup_assets WHERE id=$1 AND tenant_id=$2',[id,tenant])).rows[0];
  if(!r)throw new CatalogHttpError(404,'成衣效果图文件不存在');
  return {...await readCatalogFile(r.file_id),name:r.name,source:r.source};
}
export async function storeAsset(tenant: string,bytes: Buffer,name: string,source: Record<string,unknown>={}) {
  if(bytes.length>25*1024*1024)throw new CatalogHttpError(413,'图片不能超过 25MB');
  let asset='';
  await saveCatalogFile(bytes,name.slice(0,200),'production',async(c,fileId)=>{
    // Serialize shared-content registration and quota accounting for this tenant.
    await c.query('SELECT id FROM tenants WHERE id=$1 AND NOT disabled FOR UPDATE',[tenant]);
    const existing=(await c.query('SELECT id FROM garment_mockup_assets WHERE tenant_id=$1 AND file_id=$2',[tenant,fileId])).rows[0];
    if(existing){asset=existing.id;return;}
    const owned=await c.query('SELECT 1 FROM tenant_file_refs WHERE tenant_id=$1 AND file_id=$2 LIMIT 1',[tenant,fileId]);
    if(!owned.rowCount){
      const updated=await c.query(`UPDATE tenant_usage u SET bytes_used=bytes_used+$2 FROM tenants t
        WHERE u.tenant_id=$1 AND t.id=u.tenant_id AND u.bytes_used+u.bytes_reserved+$2<=t.storage_quota_bytes RETURNING u.tenant_id`,[tenant,bytes.length]);
      if(!updated.rowCount)throw new CatalogHttpError(413,'存储空间不足');
    }
    asset=randomUUID();
    await c.query('INSERT INTO garment_mockup_assets(id,tenant_id,file_id,name,source) VALUES($1,$2,$3,$4,$5)',[asset,tenant,fileId,name.slice(0,200),source]);
    await registerFileRef(fileId,tenant,'garment-mockup',name.slice(0,200),c);
  });
  return {id:asset,url:assetUrl(asset)};
}
export async function importAsset(tenant: string,input: unknown) {
  const b=z.object({fileId:z.uuid().optional(),variantId:z.uuid().optional(),assetVersionId:z.uuid().optional(),face:z.enum(['front','back']).optional()}).parse(input);
  if(b.variantId){
    const r=(await catalogDatabase().query(`SELECT a.file_id,a.id version_id,s.style_code,v.color_name,w.id view_id,w.crop,w.face
      FROM garment_variants v JOIN garment_styles s ON s.id=v.style_id
      JOIN garment_asset_versions a ON a.id=COALESCE($4::uuid,v.current_asset_version_id) AND a.variant_id=v.id JOIN garment_views w ON w.asset_version_id=a.id
      WHERE v.id=$1 AND s.tenant_id=$2 AND w.face=$3`,[b.variantId,tenant,b.face??'front',b.assetVersionId??null])).rows[0];
    if(!r)throw new CatalogHttpError(404,'未找到该款色的指定面');
    const file=await readCatalogFile(r.file_id),m=await sharp(file.bytes).metadata();
    const crop=r.crop as {x:number;y:number;width:number;height:number};
    const left=Math.round(crop.x*m.width!),top=Math.round(crop.y*m.height!);
    const bytes=await sharp(file.bytes).extract({left,top,width:Math.min(m.width!-left,Math.round(crop.width*m.width!)),height:Math.min(m.height!-top,Math.round(crop.height*m.height!))}).png().toBuffer();
    return storeAsset(tenant,bytes,`${r.style_code}-${r.color_name}-${r.face}.png`,{kind:'catalog',variantId:b.variantId,assetVersionId:r.version_id,viewId:r.view_id,face:r.face});
  }
  if(!b.fileId)throw new CatalogHttpError(400,'缺少文件编号');
  await assertFileAccess(b.fileId,tenant);
  const file=await readCatalogFile(b.fileId);
  return storeAsset(tenant,file.bytes,'已有图稿.png',{kind:'project-artwork',sourceFileId:b.fileId});
}
