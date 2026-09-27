import {createHash} from 'node:crypto';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {S3Client,PutObjectCommand,GetObjectCommand,ListObjectsV2Command,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {backupCatalog} from './catalog-backup';
import {catalogTransaction} from './catalog-database';

const intervalMs=6*60*60*1000,retentionMs=7*24*60*60*1000;
const prefix='workwear-mockup/prod/backups/scheduled-v1/';
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
type Receipt={at:string;key:string;sha256:string;archiveSHA256:string;bytes:number;tables:number};
export async function runOffsiteBackup(force=false):Promise<Receipt|null>{
 const {CATALOG_R2_ENDPOINT:endpoint,CATALOG_R2_ACCESS_KEY_ID:accessKeyId,CATALOG_R2_ACCESS_KEY_SECRET:secretAccessKey,CATALOG_R2_BUCKET:Bucket}=process.env;
 if(!endpoint||!accessKeyId||!secretAccessKey||!Bucket)throw Error('R2 backup configuration missing');
 const client=new S3Client({region:'auto',endpoint,credentials:{accessKeyId,secretAccessKey},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
 try{return await catalogTransaction(async db=>{
  await db.query("SET LOCAL statement_timeout='15min'");
  const lock=await db.query("SELECT pg_try_advisory_xact_lock(hashtext('catalog-offsite-backup')) AS locked");
  if(!lock.rows[0]?.locked)return null;
  const prior=(await db.query("SELECT content_json FROM batch_documents WHERE workspace='main' AND path='ops/database-backup.json'")).rows[0]?.content_json as Receipt|undefined;
  if(!force&&prior&&Date.now()-Date.parse(prior.at)<intervalMs)return prior;
  const backup=await backupCatalog();
  if(backup.payload.migrations.at(-1)?.name!=='023_garment_mockup.sql'||!backup.payload.tables.users?.length)throw Error('Refusing uninitialized database backup');
  const at=new Date().toISOString(),Body=await promisify(gzip)(JSON.stringify(backup));
  const archiveSHA256=sha(Body),Key=prefix+at.replaceAll(':','-')+'-'+archiveSHA256+'.json.gz';
  await client.send(new PutObjectCommand({Bucket,Key,Body,ContentType:'application/gzip',IfNoneMatch:'*'}),{abortSignal:AbortSignal.timeout(300000)});
  const read=await client.send(new GetObjectCommand({Bucket,Key}),{abortSignal:AbortSignal.timeout(300000)});
  if(!read.Body||sha(await read.Body.transformToByteArray())!==archiveSHA256)throw Error('Offsite backup readback mismatch');
  const receipt={at,key:Key,sha256:backup.sha256,archiveSHA256,bytes:Body.length,tables:Object.keys(backup.payload.tables).length};
  await db.query(`INSERT INTO batch_documents(workspace,path,content_json) VALUES('main','ops/database-backup.json',$1)
   ON CONFLICT(workspace,path) DO UPDATE SET content_json=EXCLUDED.content_json,content_gzip=NULL,revision=batch_documents.revision+1,updated_at=now()`,[receipt]);
  // Delete only this scheduler's expired archives, after a new one was verified.
  let token:string|undefined;
  do{const list=await client.send(new ListObjectsV2Command({Bucket,Prefix:prefix,ContinuationToken:token}),{abortSignal:AbortSignal.timeout(30000)});
   for(const item of list.Contents||[])if(item.Key&&/^\d{4}-\d{2}-\d{2}T[\d.-]+Z-[a-f0-9]{64}\.json\.gz$/.test(item.Key.slice(prefix.length))&&item.LastModified&&item.LastModified.getTime()<Date.now()-retentionMs){
    await client.send(new DeleteObjectCommand({Bucket,Key:item.Key}),{abortSignal:AbortSignal.timeout(30000)});
   }token=list.IsTruncated?list.NextContinuationToken:undefined;
  }while(token);
  return receipt;
 });}finally{client.destroy();}
}
export function startOffsiteBackup(){
 const enabled=process.env.CATALOG_OFFSITE_BACKUP_ENABLED==='1'&&process.env.BATCH_WORKER_SCOPE==='main';
 let closed=false,running:Promise<void>|null=null,lastAttempt=0,lastSuccessAt:string|null=null,error:string|null=null;
 async function tick(){
  if(!enabled||closed||running||Date.now()-lastAttempt<15*60*1000)return;
  lastAttempt=Date.now();running=(async()=>{
   try{const result=await runOffsiteBackup();if(result){lastSuccessAt=result.at;error=null;console.log('[database-backup] verified',result.at,result.bytes);}}
   catch(e){error=e instanceof Error?e.name:'Error';console.error('[database-backup] failed',error);}
  })().finally(()=>{running=null;});await running;
 }
 const timer=enabled?setInterval(()=>{void tick();},60000):undefined;
 if(enabled)void tick();
 return {status:()=>({enabled,lastSuccessAt,error,ready:!enabled||!!lastSuccessAt&&Date.now()-Date.parse(lastSuccessAt)<8*60*60*1000}),close:async()=>{closed=true;if(timer)clearInterval(timer);await running;}};
}
