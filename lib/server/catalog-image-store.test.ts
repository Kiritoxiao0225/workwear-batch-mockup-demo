import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { imageStoreConfig, assertImageStoreKey, imageStoreRequest, signedImageStoreFile } from './catalog-image-store';
const key = `workwear-mockup/prod/objects/aa/${'a'.repeat(64)}`;
beforeEach(() => {
  vi.stubEnv('CATALOG_IMAGE_STORE_URL','https://images.example.com');
  vi.stubEnv('CATALOG_IMAGE_STORE_TOKEN','t'.repeat(64));
  vi.stubEnv('CATALOG_IMAGE_STORE_SIGNING_KEY','s'.repeat(64));
  vi.stubEnv('CATALOG_IMAGE_STORE_DELETE_TOKEN','d'.repeat(64));
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
it('only signs the scoped image for a bounded time without exposing credentials',()=>{
 const url = new URL(signedImageStoreFile(key));
 const expiry = url.searchParams.get('expires')!;
 expect(Number(expiry)-Date.now()/1000).toBeGreaterThan(898);
 expect(Number(expiry)-Date.now()/1000).toBeLessThanOrEqual(900);
 expect(url.searchParams.get('signature')).toBe(createHmac('sha256','s'.repeat(64)).update(`GET\n${key}\n${expiry}`).digest('hex'));
 expect(url.href).not.toContain('t'.repeat(64));
});
it.each(['other/objects/aa/'+ 'a'.repeat(64), key.replace('/aa/','/bb/'),key+'/../secret'])('rejects out-of-scope object %s', key=>expect(()=>assertImageStoreKey(key)).toThrow());
it('rejects non-HTTPS endpoints and credential-bearing URLs',()=>{
 vi.stubEnv('CATALOG_IMAGE_STORE_URL','http://images.example.com');expect(()=>imageStoreConfig()).toThrow('HTTPS');
 vi.stubEnv('CATALOG_IMAGE_STORE_URL','https://user:pass@images.example.com');expect(()=>imageStoreConfig()).toThrow('无效');
});
it('uses separate delete credentials, rejects redirects, and preserves 404 identity',async()=>{
 const fetcher=vi.fn().mockResolvedValue(new Response(null,{status:404}));vi.stubGlobal('fetch',fetcher);
 await expect(imageStoreRequest(key,'DELETE')).rejects.toMatchObject({code:'NoSuchKey'});
 expect(fetcher).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({redirect:'error',headers:{Authorization:`Bearer ${'d'.repeat(64)}`}}));
});
