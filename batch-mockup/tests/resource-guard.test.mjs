import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdmissionGate } from '../runtime/resource-guard.mjs';
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
