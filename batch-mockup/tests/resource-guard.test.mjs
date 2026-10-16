import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdmissionGate, idleRecycle } from '../runtime/resource-guard.mjs';
const MiB = 1024 ** 2;
test('memory pressure pauses admission and recovers with hysteresis', () => {
 let available = 3000, rss = 500;
 const gate = createAdmissionGate({ sample: () => ({ available: available * MiB, total: 8000 * MiB, rss: rss * MiB }), draining: () => false, rssMiB: 1500, reserveMiB: 1000 });
 assert.equal(gate.check().paused, false);
 available = 1100; assert.equal(gate.check().reason, 'memory_pressure');
 available = 1400; assert.equal(gate.check().paused, true);
 available = 2000; assert.equal(gate.check().paused, false);
 rss = 1600; assert.equal(gate.check().paused, true);
 rss = 1300; assert.equal(gate.check().paused, true);
 rss = 1000; assert.equal(gate.check().paused, false);
});
test('drain and missing metrics stop admission without killing an existing task', () => {
 const gate = createAdmissionGate({ draining: () => true, sample: () => { throw Error('not called'); } });
 assert.equal(gate.check().reason, 'deployment_drain');
 const failed = createAdmissionGate({ draining: () => false, sample: () => { throw Error('unavailable'); } });
 assert.equal(failed.check().reason, 'memory_sample_unavailable');
});
test('pause and resume are logged once each, so a stuck worker shows up in the logs', () => {
 let rss = 500; const lines = [];
 const gate = createAdmissionGate({ sample: () => ({ available: 6000 * MiB, total: 8000 * MiB, rss: rss * MiB }), draining: () => false, rssMiB: 768, reserveMiB: 1000, log: message => lines.push(message) });
 gate.check(); rss = 900; gate.check(); gate.check(); rss = 500; gate.check(); gate.check();
 assert.deepEqual(lines, ['[batch-worker] 暂停领单', '[batch-worker] 恢复领单']);
});
test('a worker paused on its own memory and idle for a minute is due for a fresh process', () => {
 let rss = 1150, busy = false, clock = 0; const log = () => {};
 const admission = createAdmissionGate({ sample: () => ({ available: 6000 * MiB, total: 8000 * MiB, rss: rss * MiB }), draining: () => false, rssMiB: 768, reserveMiB: 1000, log });
 const due = idleRecycle({ admission, busy: () => busy, idleMs: 60_000, now: () => clock });
 admission.check(); assert.equal(due(), false);
 clock = 59_000; assert.equal(due(), false);
 clock = 60_000; assert.equal(due(), true);
 busy = true; clock = 120_000; assert.equal(due(), false, 'never while a task runs');
 busy = false; clock = 150_000; assert.equal(due(), false, 'the idle minute starts again');
 rss = 500; admission.check(); clock = 300_000; assert.equal(due(), false, 'recovered on its own');
});
