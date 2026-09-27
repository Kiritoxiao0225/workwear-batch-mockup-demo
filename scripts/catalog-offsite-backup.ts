import { runOffsiteBackup } from '../lib/server/catalog-offsite-backup';
import { closeCatalogDatabase } from '../lib/server/catalog-database';
try {
  const receipt = await runOffsiteBackup(process.argv.includes('--force'));
  if (process.send) await new Promise<void>((resolve, reject) => process.send!({ type: 'backup-complete', receipt }, error => error ? reject(error) : resolve()));
  else console.log(JSON.stringify(receipt));
} catch {
  console.error('[database-backup] failed; no success recorded');
  process.exitCode = 1;
} finally {
  await closeCatalogDatabase();
  if (process.connected) process.disconnect?.();
}
