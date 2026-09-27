import {createHash} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {catalogTransaction} from './catalog-database';
import {runOffsiteBackup} from './catalog-offsite-backup';

const {send}=vi.hoisted(()=>({send:vi.fn()}));
vi.mock('@aws-sdk/client-s3',()=>({
 S3Client:vi.fn(function(){return{send,destroy:vi.fn()};}),
 PutObjectCommand:vi.fn(function(input){return{kind:'put',input};}),
 HeadObjectCommand:vi.fn(function(input){return{kind:'head',input};}),
 ListObjectsV2Command:vi.fn(function(input){return{kind:'list',input};}),
 DeleteObjectCommand:vi.fn(function(input){return{kind:'delete',input};}),
}));
vi.mock('./catalog-database',()=>({catalogTransaction:vi.fn()}));
vi.mock('./catalog-backup',()=>({backupCatalog:async()=>({sha256:'payload-sha',payload:{migrations:[{name:'023_garment_mockup.sql'}],tables:{users:[{id:'existing-user'}]}}})}));
const query=vi.fn();
let stored:Buffer,wrong:'digest'|'length'|null;
beforeEach(()=>{
 vi.clearAllMocks();wrong=null;
 for(const name of ['ENDPOINT','ACCESS_KEY_ID','ACCESS_KEY_SECRET','BUCKET'])vi.stubEnv('CATALOG_R2_'+name,'test');
 query.mockImplementation(async(sql:string)=>({rows:sql.includes('pg_try_advisory')?[{locked:true}]:[],rowCount:0}));
 vi.mocked(catalogTransaction).mockImplementation(operation=>operation({query}));
 send.mockImplementation(async(command:{kind:string;input:{Body:Buffer;ContentMD5:string}})=>{
  if(command.kind==='put'){
   stored=command.input.Body;
   expect(command.input.ContentMD5).toBe(createHash('md5').update(stored).digest('base64'));
  }
  if(command.kind==='head')return{ContentLength:stored.length+(wrong==='length'?1:0),ETag:'"'+(wrong==='digest'?'wrong':createHash('md5').update(stored).digest('hex'))+'"'};
  return{};
 });
});
afterEach(()=>vi.unstubAllEnvs());
it('records success only after the stored digest and length match the uploaded snapshot',async()=>{
 const result=await runOffsiteBackup(true);
 expect(result).toMatchObject({verification:'r2-content-md5+head',archiveMD5:createHash('md5').update(stored).digest('hex'),bytes:stored.length});
 expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO batch_documents'))).toBe(true);
});
it.each(['digest','length'] as const)('does not mark success or delete old backups after a stored %s mismatch',async(kind)=>{
 wrong=kind;
 await expect(runOffsiteBackup(true)).rejects.toThrow('readback mismatch');
 expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO batch_documents'))).toBe(false);
 expect(send.mock.calls.some(([command])=>['list','delete'].includes(command.kind))).toBe(false);
});
