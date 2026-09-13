import { randomUUID } from 'node:crypto';
import { tick } from '../application/execute';
import { closeDatabase } from '../adapters/postgres';
const workerId = `local-${randomUUID()}`;
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
while (!stopping) {
    try {
        await tick(workerId);
    }
    catch (e) {
        console.error('Worker:', e instanceof Error ? e.message : String(e));
    }
    await new Promise(r => setTimeout(r, 300));
}
await closeDatabase();
