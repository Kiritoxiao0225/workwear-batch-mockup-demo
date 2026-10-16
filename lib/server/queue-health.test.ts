import { expect, it } from 'vitest';
import { queueAlarm, queueStuck, type QueueHealth } from './queue-health';

const health = (patch: Partial<QueueHealth>): QueueHealth => ({ queued: 0, running: 0, oldestQueuedMinutes: null, externalWorkerSeenSecondsAgo: 5, ...patch });

it('calls the queue stuck only when work waits and nothing runs', () => {
  expect(queueStuck(health({ queued: 4, oldestQueuedMinutes: 90 }))).toBe(true);
  expect(queueStuck(health({ queued: 4, running: 2, oldestQueuedMinutes: 90 })), 'a busy queue is not stuck').toBe(false);
  expect(queueStuck(health({ queued: 1, oldestQueuedMinutes: 2 })), 'not yet three minutes').toBe(false);
  expect(queueStuck(health({}))).toBe(false);
});

it('raises the alarm once, repeats it every ten minutes, and rearms after recovery', async () => {
  let clock = 0, current = health({ queued: 4, oldestQueuedMinutes: 5 });
  const lines: string[] = [];
  const tick = queueAlarm({ check: async () => current, log: message => lines.push(message), now: () => clock });
  await tick(); clock = 60_000; await tick(); clock = 9 * 60_000; await tick();
  expect(lines).toEqual(['[queue-alarm] 客户任务排队 5 分钟没人处理']);
  clock = 10 * 60_000; current = health({ queued: 4, oldestQueuedMinutes: 15 }); await tick();
  expect(lines).toHaveLength(2);
  current = health({}); clock = 11 * 60_000; await tick();
  current = health({ queued: 1, oldestQueuedMinutes: 3 }); clock = 12 * 60_000; await tick();
  expect(lines).toHaveLength(3);
});
