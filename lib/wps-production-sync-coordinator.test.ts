import { describe, expect, it, vi } from 'vitest';
import { coordinateProductionSync } from './wps-production-sync-coordinator';
import { emptyWpsProductionState, type WpsProductionState } from './wps-production';
import { newerProductionState } from './production-artwork-snapshot';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function run(state = deferred<string>(), wps = deferred<string>()) {
  const controller = new AbortController(), onState = vi.fn();
  const promise = coordinateProductionSync({ signal: controller.signal, isCurrent: () => true, readState: () => state.promise, readWps: () => wps.promise, onState });
  // Attach a rejection handler before intentionally rejecting either branch.
  const settled = promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  return { state, wps, controller, onState, settled };
}

describe('real production sync coordinator', () => {
  it('waits for delayed saved state even after WPS fails, before releasing request ownership', async () => {
    const t = run(), done = vi.fn(); void t.settled.then(done);
    const error = new Error('WPS 503'); t.wps.reject(error); await drain();
    expect(done).not.toHaveBeenCalled();
    t.state.resolve('saved'); await drain();
    expect(t.onState).toHaveBeenCalledExactlyOnceWith('saved');
    expect((await t.settled).error).toBe(error);
  });
  it('publishes saved state immediately while WPS stays pending, then preserves it on WPS failure', async () => {
    const t = run(), done = vi.fn(); void t.settled.then(done);
    t.state.resolve('saved'); await drain();
    expect(t.onState).toHaveBeenCalledExactlyOnceWith('saved'); expect(done).not.toHaveBeenCalled();
    const error = new Error('late WPS failure'); t.wps.reject(error);
    expect((await t.settled).error).toBe(error); expect(t.onState).toHaveBeenCalledTimes(1);
  });
  it('returns both successful values and does not treat a failed state read as successful sync', async () => {
    const ok = run(); ok.wps.resolve('live'); await drain(); expect(ok.onState).not.toHaveBeenCalled();
    ok.state.resolve('saved'); expect((await ok.settled).value).toEqual({ state: 'saved', wps: 'live' });
    const failed = run(), error = new Error('state unavailable'); failed.state.reject(error); failed.wps.resolve('live');
    expect((await failed.settled).error).toBe(error); expect(failed.onState).not.toHaveBeenCalled();
  });
  it('preserves the WPS authorization error and existing snapshot when both reads fail', async () => {
    const t = run(), error = Object.assign(new Error('authorize WPS'), { authorizeUrl: '/wps-connect?qa=1' });
    let saved = 'existing'; t.onState.mockImplementation(value => { saved = value; });
    t.state.reject(new Error('state failed')); t.wps.reject(error);
    expect((await t.settled).error).toBe(error); expect(saved).toBe('existing');
    expect((await t.settled).error.authorizeUrl).toBe('/wps-connect?qa=1');
  });
  it('accepts no delayed snapshot after editing cancels the request', async () => {
    const t = run(); t.controller.abort(); t.state.resolve('stale'); t.wps.resolve('live');
    expect((await t.settled).error).toBe(t.controller.signal.reason); expect(t.onState).not.toHaveBeenCalled();
  });
  it('keeps an already accepted snapshot when a later timeout occurs, preserving TimeoutError', async () => {
    const t = run(); t.state.resolve('saved'); await drain();
    const timeout = new DOMException('同步超时', 'TimeoutError'); t.controller.abort(timeout); t.wps.reject(new Error('fetch aborted'));
    expect((await t.settled).error).toBe(timeout); expect(t.onState).toHaveBeenCalledExactlyOnceWith('saved');
  });
  it('runs two requests and prevents the older completion from publishing over a newer request', async () => {
    let owner = 'old', saved = 'existing'; const published: string[] = [];
    const oldState = deferred<string>(), oldWps = deferred<string>(), newState = deferred<string>(), newWps = deferred<string>();
    const start = (id: string, state: ReturnType<typeof deferred<string>>, wps: ReturnType<typeof deferred<string>>) => coordinateProductionSync({
      signal: new AbortController().signal, isCurrent: () => owner === id, readState: () => state.promise, readWps: () => wps.promise,
      onState: value => { saved = value; published.push(value); },
    });
    const old = start('old', oldState, oldWps); await drain(); owner = 'new'; const fresh = start('new', newState, newWps);
    newState.resolve('new snapshot'); newWps.resolve('new live'); await fresh;
    oldState.resolve('old snapshot'); oldWps.resolve('old live'); await old;
    expect(saved).toBe('new snapshot'); expect(published).toEqual(['new snapshot']);
  });
  it('uses the actual revision guard when an active read arrives after a newer local save', async () => {
    const initial = emptyWpsProductionState(); let saved: WpsProductionState | null = { ...initial, revision: 8 };
    const t = deferred<WpsProductionState>(), wps = deferred<string>();
    const request = coordinateProductionSync({ signal: new AbortController().signal, isCurrent: () => true, readState: () => t.promise, readWps: () => wps.promise,
      onState: state => { saved = newerProductionState(saved, state); },
    });
    t.resolve({ ...initial, revision: 3 }); wps.resolve('live'); await request;
    expect(saved!.revision).toBe(8);
  });
  it('still starts state reading when the WPS reader throws synchronously', async () => {
    const onState = vi.fn(), error = new Error('sync throw');
    await expect(coordinateProductionSync({ signal: new AbortController().signal, isCurrent: () => true, readState: async () => 'saved', readWps: () => { throw error; }, onState })).rejects.toBe(error);
    expect(onState).toHaveBeenCalledExactlyOnceWith('saved');
  });
});
