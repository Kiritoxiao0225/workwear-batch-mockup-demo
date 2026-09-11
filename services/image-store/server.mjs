import { createServer } from 'node:http';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, link, unlink, readFile, statfs } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const mime = bytes => bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
  : bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg'
  : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
export function signature(key, expires, secret) { return createHmac('sha256', secret).update(`GET\n${key}\n${expires}`).digest('hex'); }
export async function imageStore(config) {
  const { root, prefix, token, signingKey, deleteToken, backupUrl, backupToken } = config;
  if (!root || !/^[a-z0-9][a-z0-9/-]+[a-z0-9]$/.test(prefix) || prefix.includes('//') || token?.length < 32 || signingKey?.length < 32 || !token || !signingKey) throw new Error('Invalid image store configuration');
  if (backupUrl && (!backupUrl.startsWith('https://') && !config.test || !backupToken)) throw new Error('Invalid backup configuration');
  await mkdir(root, { recursive: true });
  // A production service must have the configured volume mounted, not an overlay directory.
  if (!config.test) {
    const mounts = await readFile('/proc/mounts', 'utf8');
    if (!mounts.split('\n').some(line => line.split(' ')[1] === root && !line.startsWith('overlay '))) throw new Error('Persistent image volume is not mounted');
  }
  let active = 0;
  const server = createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    let temporary;
    try {
      const url = new URL(req.url, 'http://image-store');
      if (url.pathname === '/healthz' && req.method === 'GET') {
        const disk = await statfs(root);
        return send(disk.bavail * disk.bsize > 1024 ** 3 || config.test ? 200 : 503, { ready: true, service: 'workwear-image-store', version: 1, backupConfigured: Boolean(backupUrl) });
      }
      const key = url.pathname.slice('/v1/objects/'.length);
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`^${escaped}/(?:production/)?objects/([0-9a-f]{2})/([0-9a-f]{64})$`).exec(key);
      if (!url.pathname.startsWith('/v1/objects/') || !match || match[1] !== match[2].slice(0,2)) return send(400, { error: 'Invalid object key' });
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      const writer = equal(bearer, token);
      const expires = url.searchParams.get('expires');
      const signed = /^\d{10}$/.test(expires ?? '') && Number(expires) > Date.now()/1000 && Number(expires) <= Date.now()/1000 + 901 && equal(url.searchParams.get('signature'), signature(key, expires, signingKey));
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!writer && !signed) return send(401, { error: 'Unauthorized' });
      } else if (req.method === 'DELETE') {
        if (!deleteToken || !equal(bearer, deleteToken) || !key.startsWith(`${prefix}/production/objects/`)) return send(403, { error: 'Forbidden' });
      } else if (req.method !== 'PUT' || !writer) return send(401, { error: 'Unauthorized' });
      if (active >= 8) return send(503, { error: 'Image storage is busy; retry later' });
      active++;
      try {
        const destination = path.join(root, key);
        if (req.method === 'DELETE') {
          await unlink(destination).catch(e => { if (e.code !== 'ENOENT') throw e; });
          const dir = await open(path.dirname(destination), 'r').catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
          if (dir) { try { await dir.sync(); } finally { await dir.close(); } }
          return send(200, { deleted: true }); // Independent backup is deliberately retained.
        }
        if (req.method === 'PUT') {
          if (Number(req.headers['content-length']) > 64 * 1024 ** 2) return send(413, { error: 'Image too large' });
          const disk = await statfs(root);
          if (!config.test && disk.bavail * disk.bsize < 1024 ** 3) return send(507, { error: 'Insufficient storage' });
          await mkdir(path.dirname(destination), { recursive: true });
          temporary = `${destination}.${randomUUID()}.tmp`;
          const file = await open(temporary, 'wx', 0o600);
          let length = 0;
          const digest = createHash('sha256');
          try {
            for await (const chunk of req) {
              length += chunk.length;
              if (length > 64 * 1024 ** 2) { const e = new Error('Image too large'); e.status = 413; throw e; }
              digest.update(chunk); await file.writeFile(chunk);
            }
            await file.sync();
          } finally { await file.close(); }
          if (!length || digest.digest('hex') !== match[2]) return send(422, { error: 'SHA-256 mismatch' });
          const bytes = await readFile(temporary);
          if (!mime(bytes)) return send(415, { error: 'Unsupported image' });
          try { await link(temporary, destination); }
          catch (e) { if (e.code !== 'EEXIST') throw e; if (hash(await readFile(destination)) !== match[2]) return send(409, { error: 'Existing object is corrupt' }); }
          const dir = await open(path.dirname(destination), 'r');
          try { await dir.sync(); } finally { await dir.close(); }
          // Acknowledgement requires an independently durable copy. Retried PUT repairs a missing backup.
          if (backupUrl) {
            const copied = await fetch(`${backupUrl}/v1/objects/${key}`, { method: 'PUT', headers: { Authorization: `Bearer ${backupToken}`, 'Content-Type': mime(bytes) }, body: bytes, signal: AbortSignal.timeout(90000), redirect: 'error' });
            if (!copied.ok || (await copied.json()).sha256 !== match[2]) return send(502, { error: 'Independent backup failed; image has not been confirmed saved' });
          }
          return send(200, { sha256: match[2], byteLength: length, backedUp: Boolean(backupUrl) });
        }
        const bytes = await readFile(destination);
        if (hash(bytes) !== match[2] || !mime(bytes)) return send(500, { error: 'Stored image failed verification' });
        res.writeHead(200, { 'Content-Type': mime(bytes), 'Content-Length': bytes.length, 'X-Image-SHA256': match[2], 'Cache-Control': 'private, max-age=900', ETag: `"${match[2]}"`, 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Referrer-Policy': 'no-referrer' });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } finally { active--; }
    } catch (e) {
      if (!res.headersSent) send(e.code === 'ENOENT' ? 404 : e.status ?? 500, { error: e.code === 'ENOENT' ? 'Image not found' : 'Image storage operation failed' });
      else res.destroy();
      if (e.code !== 'ENOENT') console.error('[image-store]', e.code ?? e.name);
    } finally { if (temporary) await unlink(temporary).catch(() => {}); }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await imageStore({ root: process.env.IMAGE_ROOT || '/data/images', prefix: process.env.IMAGE_PREFIX || 'workwear-mockup/prod', token: process.env.IMAGE_TOKEN, signingKey: process.env.IMAGE_SIGNING_KEY, deleteToken: process.env.IMAGE_DELETE_TOKEN, backupUrl: process.env.IMAGE_BACKUP_URL, backupToken: process.env.IMAGE_BACKUP_TOKEN });
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('[image-store] ready'));
  process.once('SIGTERM', () => server.close());
}
