import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep, extname } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { tmpdir } from 'node:os';
import { readdir } from 'node:fs/promises';
const storage = new AsyncLocalStorage();
export const withFileStorage = (adapter, action) => storage.run(adapter, action);
export const checkpoint = () => storage.getStore()?.flush() ?? Promise.resolve();
export async function readBytes(path) { return storage.getStore() ? storage.getStore().readBytes(resolve(path)) : readFile(path); }
export async function materialize(path) {
  if (!storage.getStore()) return path;
  const bytes = await readBytes(path), local = resolve(tmpdir(), 'workwear-batch-assets', hash(bytes)+extname(path));
  await mkdir(dirname(local), { recursive: true }); const temp=local+'.'+randomUUID()+'.tmp';await writeFile(temp,bytes,{mode:0o600});await rename(temp,local);return local;
}
export async function listDirectories(path) {
  if (storage.getStore()) return storage.getStore().listDirectories(resolve(path));
  return readdir(path).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
}
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function jsonFile(path, fallback) {
  if (storage.getStore()) return storage.getStore().readJSON(resolve(path), fallback);
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export async function atomicFile(path, value) {
  if (storage.getStore()) return storage.getStore().writeBytes(resolve(path), Buffer.from(value));
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, value, { mode: 0o600 });
  await rename(temp, path);
}
export const saveJSON = (path, value) => storage.getStore() ? storage.getStore().writeJSON(resolve(path), value) : atomicFile(path, JSON.stringify(value, null, 2) + '\n');
export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function assetPath(root, asset) {
  const base = resolve(root, 'public'), path = resolve(base, asset);
  if (!path.startsWith(base + sep)) throw fail('图片路径无效');
  return path;
}
