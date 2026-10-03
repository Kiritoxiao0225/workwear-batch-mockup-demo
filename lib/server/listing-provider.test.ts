import { describe, expect, it } from 'vitest';
import { generateListingImage } from './listing-provider';

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
      env: { EVOLINK_API_KEY: 'k' }, fetchImplementation, pollMs: 1,
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
      env: { EVOLINK_API_KEY: 'k' }, fetchImplementation, pollMs: 1, beforeSubmit: async () => {}, receipt: async () => {} });
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
      env: { EVOLINK_API_KEY: 'k' }, fetchImplementation, pollMs: 1, beforeSubmit: async () => {}, receipt: async () => {},
    })).rejects.toMatchObject({ notCharged: true });
  });
});
