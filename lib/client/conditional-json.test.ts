import { afterEach, expect, it, vi } from 'vitest';
import { ConditionalJsonReader } from './conditional-json';
import { conditionalJson } from '../server/conditional-json';
import { artworkPollDelay } from '../artwork-polling';
afterEach(() => vi.unstubAllGlobals());
it('returns fresh independent responses for coalesced reads and reuses a 304 body', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(conditionalJson({ revision: 1 })).mockResolvedValueOnce(new Response(null, { status: 304 }));
  vi.stubGlobal('fetch', fetcher);
  const reader = new ConditionalJsonReader('/state');
  const first = await Promise.all([reader.read(), reader.read()]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await first[0].json()).toEqual({ revision: 1 }); expect(await first[1].json()).toEqual({ revision: 1 });
  expect(await (await reader.read()).json()).toEqual({ revision: 1 });
  expect(fetcher.mock.calls[1][1].headers['If-None-Match']).toBeTruthy();
});
it('does not let a pre-mutation response populate the post-mutation cache', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(conditionalJson({ revision: 2 })).mockResolvedValueOnce(new Response(null, { status: 304 }));
  vi.stubGlobal('fetch', fetcher);
  const reader = new ConditionalJsonReader('/state');
  const old = reader.read(); reader.invalidate();
  await reader.read(); finish(conditionalJson({ revision: 1 })); await old;
  expect(await (await reader.read()).json()).toEqual({ revision: 2 });
});
it('hashes derived geometry and worker status even when the production revision is unchanged', () => {
  const first = conditionalJson({ revision: 5, geometry: 1, workerOnline: true });
  const request = new Request('http://localhost', { headers: { 'If-None-Match': first.headers.get('etag')! } });
  expect(conditionalJson({ revision: 5, geometry: 1, workerOnline: true }, request).status).toBe(304);
  expect(conditionalJson({ revision: 5, geometry: 2, workerOnline: true }, request).status).toBe(200);
  expect(conditionalJson({ revision: 5, geometry: 1, workerOnline: false }, request).status).toBe(200);
  expect(artworkPollDelay([], false)).toBe(30_000);
  expect(artworkPollDelay([{ status: 'unknown' }], true)).toBe(60_000);
  expect(artworkPollDelay([{ status: 'running' }], false)).toBe(2500);
});
