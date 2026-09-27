import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { backupChild } from './catalog-backup-scheduler';
it('contains a hanging backup in its child and leaves the parent available', async () => {
 const dir = await mkdtemp(path.join(tmpdir(), 'backup-child-test-'));
 try {
  const script = path.join(dir, 'hang.mjs'); await writeFile(script, 'setInterval(() => {}, 1000)');
  const child = backupChild({ script, timeoutMs: 500 });
  await expect(child.result).rejects.toThrow('timed out');
  expect(process.pid).toBeGreaterThan(0);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
it('requires a success receipt as well as a clean child exit', async () => {
 const dir = await mkdtemp(path.join(tmpdir(), 'backup-child-test-'));
 try {
  const script = path.join(dir, 'exit.mjs'); await writeFile(script, 'process.exit(0)');
  await expect(backupChild({ script }).result).rejects.toThrow('failed');
 } finally { await rm(dir, { recursive: true, force: true }); }
});
