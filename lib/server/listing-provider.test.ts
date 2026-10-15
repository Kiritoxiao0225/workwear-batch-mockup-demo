import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { callPlanModel, generateListingImage, providerReason } from './listing-provider';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('listing image call', () => {
  it('fetches a finished image again instead of giving it up when the download stalls', async () => {
    const seen: string[] = [];
    let downloads = 0;
    const fetchImplementation = (async (url: string) => {
      seen.push(String(url).split('?')[0]);
      if (String(url).includes('files-api')) return json({ success: true, data: { file_url: 'https://files.example/ref.png' } });
      if (String(url).endsWith('/images/generations')) return json({ id: 'task-unified-1' });
      if (String(url).includes('/tasks/')) return json({ status: 'completed', results: ['https://cdn.example/out.png'], usage: { credits_used: 1.7 } });
      if (++downloads < 3) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    const hooks: string[] = [];
    const result = await generateListingImage({ prompt: 'p', references: [Buffer.from('x')], ratio: 'square' }, {
      env: { EVOLINK_API_KEY: 'k', LISTING_IMAGE_PROVIDER: 'evolink' }, fetchImplementation, pollMs: 1,
      beforeSubmit: async () => { hooks.push('submit'); }, receipt: async id => { hooks.push(id); },
    });
    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(result.credits).toBe(1.7);
    expect(hooks).toEqual(['submit', 'task-unified-1']);
    expect(seen.filter(u => u.endsWith('/images/generations'))).toHaveLength(1);
    expect(downloads).toBe(3);
  });

  it('gives every reference upload its own name, so concurrent jobs never swap colours', async () => {
    const names: string[] = [];
    const fetchImplementation = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('files-api')) { const b = JSON.parse(String(init!.body)); names.push(`${b.file_name}|${b.base64_data.slice(0, 16)}`); return json({ success: true, data: { file_url: 'https://files.example/' + b.file_name } }); }
      if (String(url).endsWith('/images/generations')) return json({ id: 'task-unified-3' });
      if (String(url).includes('/tasks/')) return json({ status: 'completed', results: ['https://cdn.example/out.png'] });
      return new Response(new Uint8Array([9]));
    }) as typeof fetch;
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]), call = () => generateListingImage({ prompt: 'p', references: [jpeg, jpeg], ratio: 'square' }, {
      env: { EVOLINK_API_KEY: 'k', LISTING_IMAGE_PROVIDER: 'evolink' }, fetchImplementation, pollMs: 1, beforeSubmit: async () => {}, receipt: async () => {} });
    await Promise.all([call(), call(), call()]);
    expect(new Set(names.map(n => n.split('|')[0])).size).toBe(6);
    expect(names.every(n => n.includes('.jpeg|data:image/jpeg'))).toBe(true);
  });

  it('marks a task the provider failed as not charged', async () => {
    const fetchImplementation = (async (url: string) => {
      if (String(url).endsWith('/images/generations')) return json({ id: 'task-unified-2' });
      return json({ status: 'failed', error: { message: '内容不合规' } });
    }) as typeof fetch;
    await expect(generateListingImage({ prompt: 'p', references: [], ratio: 'square' }, {
      env: { EVOLINK_API_KEY: 'k', LISTING_IMAGE_PROVIDER: 'evolink' }, fetchImplementation, pollMs: 1, beforeSubmit: async () => {}, receipt: async () => {},
    })).rejects.toMatchObject({ notCharged: true });
  });
});

describe('the Codex relay (images when LISTING_IMAGE_PROVIDER=cliproxy)', () => {
  it('sends the references in order at the shape\'s size; a failed image is not charged', async () => {
    vi.stubEnv('CLIPROXY_API_KEY', 'k'); vi.stubEnv('CLIPROXY_API_BASE_URL', 'https://relay.example/v1');
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer();
    const calls: { url: string; form: FormData }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url: String(url), form: init.body as FormData }); return json({ data: [{ b64_json: png.toString('base64') }] }); });
    const hooks = { env: { LISTING_IMAGE_PROVIDER: 'cliproxy' }, beforeSubmit: async () => {}, receipt: async () => {} };
    try {
      const made = await generateListingImage({ prompt: 'p', references: [png, png], ratio: 'portrait' }, hooks);
      expect(made.bytes.equals(png)).toBe(true);
      expect(calls[0].url).toBe('https://relay.example/v1/images/edits');
      expect(calls[0].form.get('size')).toBe('1152x1536');
      expect(calls[0].form.getAll('image[]')).toHaveLength(2);
      vi.stubGlobal('fetch', async () => json({ error: {} }, 429));
      await expect(generateListingImage({ prompt: 'p', references: [png], ratio: 'square' }, hooks)).rejects.toMatchObject({ notCharged: true });
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });
});

describe('the analysis call', () => {
  it('reads a streamed answer as it comes, and keeps the request id from the first piece', async () => {
    const pieces = ['{"id":"chatcmpl-1","model":"m","choices":[{"delta":{"content":"{\\"ok"},"finish_reason":null}]}', '{"id":"chatcmpl-1","choices":[{"delta":{"content":"\\":true}"},"finish_reason":"stop"}]}', '{"choices":[],"usage":{"total_tokens":9}}'];
    let sent: { stream?: boolean } = {}, url = '';
    const fetchImplementation = (async (target: string, init?: RequestInit) => {
      url = target; sent = JSON.parse(String(init!.body));
      const text = pieces.map(p => `data: ${p}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(new ReadableStream({ start(c) { const b = new TextEncoder().encode(text); c.enqueue(b.slice(0, 50)); c.enqueue(b.slice(50)); c.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;
    const ids: string[] = [];
    const call = await callPlanModel({ model: 'm' }, { env: { LISTING_PLAN_PROVIDER: 'cliproxy', CLIPROXY_API_KEY: 'sk-test-0123456789', CLIPROXY_API_BASE_URL: 'https://relay.test/v1/' }, fetchImplementation, beforeSubmit: async () => {}, receipt: async id => { ids.push(id); } });
    expect(url).toBe('https://relay.test/v1/chat/completions');
    expect(sent.stream).toBe(true);
    expect(call.content).toBe('{"ok":true}');
    expect(call.usage).toEqual({ total_tokens: 9 });
    expect(ids).toEqual(['chatcmpl-1']);
  });

  it('goes to EvoLink unless moved to the relay, as live', async () => {
    let url = '';
    const fetchImplementation = (async (target: string) => { url = target; return new Response(JSON.stringify({ id: 'c', choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }), { headers: { 'Content-Type': 'application/json' } }); }) as typeof fetch;
    await callPlanModel({ model: 'm' }, { env: { EVOLINK_API_KEY: 'k' }, fetchImplementation, beforeSubmit: async () => {}, receipt: async () => {} });
    expect(url).toBe('https://direct.evolink.ai/v1/chat/completions');
  });
});

describe('a provider failure shown to the tenant', () => {
  it('keeps the reason but drops links and token-like strings', () => {
    const shown = providerReason('Content rejected by moderation, see https://api.evolink.ai/v1/debug?key=sk-abc for request req_9f8e7d6c5b4a39281706f5e4d3c2b1a0');
    expect(shown).toContain('Content rejected by moderation');
    expect(shown).not.toMatch(/https?:|sk-abc|9f8e7d6c5b4a/);
    expect(providerReason('x'.repeat(200)).length).toBeLessThanOrEqual(80);
  });
});
