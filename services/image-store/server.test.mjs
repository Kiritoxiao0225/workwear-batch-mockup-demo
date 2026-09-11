import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { imageStore, signature } from './server.mjs';
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const sha = createHash('sha256').update(bytes).digest('hex');
const key = `workwear-mockup/prod/production/objects/${sha.slice(0,2)}/${sha}`;
const token = 'a'.repeat(64), signingKey = 'b'.repeat(64), deleteToken = 'c'.repeat(64);
test('durable immutable storage, independent backup, signatures and deletion boundaries', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'image-store-test-'));
  const replica = await imageStore({root:path.join(root,'replica'), prefix:'workwear-mockup/prod', token, signingKey, test:true});
  await new Promise(resolve=>replica.listen(0,'127.0.0.1',resolve));
  const backupUrl = `http://127.0.0.1:${replica.address().port}`;
  const main = await imageStore({root:path.join(root,'main'), prefix:'workwear-mockup/prod', token, signingKey, deleteToken, backupUrl, backupToken:token, test:true});
  await new Promise(resolve=>main.listen(0,'127.0.0.1',resolve));
  const url = `http://127.0.0.1:${main.address().port}/v1/objects/${key}`;
  const put = () => fetch(url,{method:'PUT',headers:{Authorization:`Bearer ${token}`},body:bytes});
  try {
    assert.equal((await fetch(url)).status,401);
    assert.equal((await fetch(url,{method:'PUT',body:bytes})).status,401);
    assert.equal((await fetch(url,{method:'PUT',headers:{Authorization:`Bearer ${token}`},body:Buffer.from('bad')})).status,422);
    assert.equal((await put()).status,200);
    assert.deepEqual(await readFile(path.join(root,'replica',key)),bytes);
    assert.deepEqual(await (await put()).json(),{sha256:sha,byteLength:bytes.length,backedUp:true});
    const expires = String(Math.floor(Date.now()/1000)+300);
    const signed = `${url}?expires=${expires}&signature=${signature(key,expires,signingKey)}`;
    const good = await fetch(signed); assert.equal(good.status,200); assert.deepEqual(Buffer.from(await good.arrayBuffer()),bytes);
    assert.equal((await fetch(signed.replace('signature=','signature=0'))).status,401);
    const past = String(Math.floor(Date.now()/1000)-1);
    assert.equal((await fetch(`${url}?expires=${past}&signature=${signature(key,past,signingKey)}`)).status,401);
    assert.equal((await fetch(url,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}})).status,403);
    assert.equal((await fetch(url.replace('/production/','/'),{method:'DELETE',headers:{Authorization:`Bearer ${deleteToken}`}})).status,403);
    await writeFile(path.join(root,'main',key),Buffer.from('corruption'));
    assert.equal((await put()).status,409);
    await writeFile(path.join(root,'main',key),bytes);
    assert.equal((await fetch(url,{method:'DELETE',headers:{Authorization:`Bearer ${deleteToken}`}})).status,200);
    assert.equal((await fetch(signed)).status,404);
    assert.deepEqual(await readFile(path.join(root,'replica',key)),bytes);
    await new Promise(resolve=>replica.close(resolve));
    assert.equal((await put()).status,500); // Existing primary is not reported saved while replica is unavailable.
  } finally { await new Promise(resolve=>main.close(resolve)); if(replica.listening) await new Promise(resolve=>replica.close(resolve)); await rm(root,{recursive:true,force:true}); }
});
