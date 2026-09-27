import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { backupFresh, BACKUP_INTERVAL_MS, readBackupReceipt, type BackupReceipt } from './catalog-offsite-backup';

// A backup heap failure or timeout must not take down paid production tasks.
export function backupChild({ timeoutMs = 20 * 60 * 1000, script = path.join(process.cwd(), 'scripts/catalog-offsite-backup.ts'), force = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'backup-child-'));
  let child: ChildProcess;
  const result = new Promise<BackupReceipt | null>((resolve, reject) => {
    child = fork(script, force ? ['--force'] : [], { execArgv: ['--max-old-space-size=512', '--import', 'tsx'],
      env: { ...process.env, NODE_OPTIONS: '', CATALOG_BACKUP_TMPDIR: directory }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let receipt: BackupReceipt | null = null, received = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('message', message => {
      const value = message as { type?: string; receipt?: BackupReceipt | null };
      if (value.type === 'backup-complete') { receipt = value.receipt ?? null; received = true; }
    });
    child.once('error', error => { clearTimeout(timer); rmSync(directory, { recursive: true, force: true }); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      rmSync(directory, { recursive: true, force: true });
      if (code === 0 && received) resolve(receipt);
      else reject(Error(timedOut ? 'Backup child timed out' : 'Backup child failed (check schema, storage and credentials)'));
    });
  });
  return { result, stop: () => child?.kill('SIGKILL') };
}

export function startOffsiteBackup() {
  const enabled = process.env.CATALOG_OFFSITE_BACKUP_ENABLED === '1' && process.env.BATCH_WORKER_SCOPE === 'main';
  let closed = false, running: Promise<void> | null = null, job: ReturnType<typeof backupChild> | null = null;
  let lastAttempt = 0, receipt: BackupReceipt | null = null, error: string | null = null;
  async function tick() {
    if (!enabled || closed || running || Date.now() - lastAttempt < 15 * 60 * 1000) return;
    lastAttempt = Date.now();
    running = (async () => {
      try {
        receipt = await readBackupReceipt();
        if (closed) return;
        if (!backupFresh(receipt, BACKUP_INTERVAL_MS)) {
          job = backupChild();
          const value = await job.result;
          if (value) receipt = value;
        }
        error = null;
      } catch { error = 'backup_failed'; console.error('[database-backup] failed; last verified receipt retained'); }
      finally { job = null; }
    })().finally(() => { running = null; });
    await running;
  }
  const timer = enabled ? setInterval(() => { void tick(); }, 60000) : undefined;
  if (enabled) void tick();
  return {
    status: () => ({ enabled, isolated: true, running: !!job, lastSuccessAt: receipt?.at ?? null, snapshotAt: receipt?.snapshotAt ?? receipt?.at ?? null, error, ready: !enabled || backupFresh(receipt) }),
    close: async () => { closed = true; if (timer) clearInterval(timer); job?.stop(); await running; },
  };
}
