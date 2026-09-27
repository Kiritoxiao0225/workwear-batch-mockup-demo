// Run with node scripts/ops/release-worker-patch.mjs <output-directory> --deploy.
// The platform's existing base image is retained; only the reviewed safety patch
// is copied, so unrelated local product changes cannot enter this release.
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { productionPreflight, contract } from './production-preflight.mjs';
import { platformQuery } from './zeabur-api.mjs';
await productionPreflight();
const dir = resolve(process.argv[2] || 'output/stability-release');
const s = contract.workers.main.service, e = contract.environment;
const files = ['scripts/artwork-worker.ts', 'scripts/catalog-offsite-backup.ts',
 'lib/server/catalog-database.ts', 'lib/server/catalog-backup.ts', 'lib/server/catalog-backup-stream.ts',
 'lib/server/catalog-backup-scheduler.ts', 'lib/server/catalog-offsite-backup.ts', 'lib/server/garment-mockup-ai.ts',
 'batch-mockup/runtime/worker.mjs', 'batch-mockup/runtime/resource-guard.mjs',
 ...(await readdir('db/migrations')).filter(f => f.endsWith('.sql')).sort().map(f => 'db/migrations/' + f)];
const before = await platformQuery('query($s:ObjectID!,$e:ObjectID!){service(_id:$s){image(environmentID:$e){reference} status(environmentID:$e)}}', { s, e });
if (before.service.status !== 'SUSPENDED') throw Error('Drain and suspend workers before deployment');
const base = before.service.image.reference, hash = createHash('sha256'), hashes = {};
for (const f of files) {
 const bytes = await readFile(f); hash.update(f).update(bytes); hashes[f] = createHash('sha256').update(bytes).digest('hex');
 await mkdir(dirname(dir + '/patch/' + f), { recursive: true }); await copyFile(f, dir + '/patch/' + f);
}
const sha256 = hash.digest('hex');
await writeFile(dir + '/patch/Dockerfile', `FROM ${base}\nWORKDIR /app\nCOPY scripts ./scripts\nCOPY lib ./lib\nCOPY batch-mockup ./batch-mockup\nCOPY db ./db\nRUN node --import tsx --input-type=module -e "await import('./lib/server/catalog-backup-scheduler.ts'); await import('./batch-mockup/runtime/resource-guard.mjs'); await import('./lib/server/garment-mockup-ai.ts')"\nENV STABILITY_RELEASE_SHA256=${sha256}\nCMD ["npm", "run", "artwork:worker"]\n`);
execFileSync('zip', ['-qr', '-X', dir + '/release.zip', '.'], { cwd: dir + '/patch' });
const receipt = { at: new Date().toISOString(), base, sha256, files: hashes, service: s };
await writeFile(dir + '/release.json', JSON.stringify(receipt, null, 2));
if (process.argv.includes('--deploy')) {
 const token = process.env.ZEABUR_TOKEN || (await readFile(homedir() + '/.config/zeabur/cli.yaml', 'utf8')).match(/^token:\s*["']?([^\s"']+)/m)?.[1];
 const post = (route, body) => fetch('https://api.zeabur.com' + route, { method: 'POST', headers: { Cookie: 'token=' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(55000) });
 const bytes = await readFile(dir + '/release.zip');
 const session = await post('/v2/upload', { content_hash: createHash('sha256').update(bytes).digest('base64'), content_hash_algorithm: 'sha256', content_length: bytes.length });
 if (session.status !== 201) throw Error('Upload session failed');
 const upload = await session.json();
 const put = await fetch(upload.presign_url, { method: upload.presign_method, headers: { ...upload.presign_header, 'Content-Type': upload.presign_header?.['Content-Type'] || 'application/zip', 'Content-Length': String(bytes.length) }, body: bytes, signal: AbortSignal.timeout(60000) });
 if (!put.ok) throw Error('Upload failed');
 const prepared = await post(`/v2/upload/${upload.upload_id}/prepare`, { upload_type: 'existing_service', service_id: s, environment_id: e });
 receipt.upload = upload.upload_id; receipt.prepareStatus = prepared.status;
 await writeFile(dir + '/release.json', JSON.stringify(receipt, null, 2));
 if (!prepared.ok) throw Error('Build submission failed');
}
console.log(JSON.stringify({ sha256, submitted: !!receipt.upload }));
