import { expect, it } from 'vitest';
import { presignR2GetUrl } from './r2-presign';

const base = {
  endpoint: 'https://accountid.r2.cloudflarestorage.com',
  bucket: 'garment-mockup',
  key: 'workwear-mockup/prod/objects/aa/deadbeef',
  region: 'auto',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
  expiresIn: 900,
  now: new Date('2026-09-11T15:44:31.000Z'),
};

it('signs a virtual-hosted URL with a well-formed ISO8601 basic timestamp', () => {
  const url = new URL(presignR2GetUrl(base));
  expect(url.host).toBe('garment-mockup.accountid.r2.cloudflarestorage.com');
  expect(url.pathname).toBe('/workwear-mockup/prod/objects/aa/deadbeef');
  expect(url.searchParams.get('X-Amz-Date')).toBe('20260911T154431Z');
  expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
  expect(url.searchParams.get('X-Amz-Credential')).toBe('AKIDEXAMPLE/20260911/auto/s3/aws4_request');
  expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
  expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
});

it('is deterministic for the same inputs and changes with the secret', () => {
  const first = presignR2GetUrl(base);
  expect(presignR2GetUrl(base)).toBe(first);
  expect(presignR2GetUrl({ ...base, secretAccessKey: 'other' })).not.toBe(first);
});

it('encodes reserved and non-ASCII characters without breaking the path separators', () => {
  const url = presignR2GetUrl({ ...base, key: 'a b/中文+符号/(x).bin' });
  const pathname = new URL(url).pathname;
  // RFC 3986 要求把 ! ' ( ) * 一并编码，encodeURIComponent 默认会漏掉它们。
  expect(pathname).toBe('/a%20b/%E4%B8%AD%E6%96%87%2B%E7%AC%A6%E5%8F%B7/%28x%29.bin');
  expect(pathname.split('/').length).toBe(4);
});

it('reflects the requested expiry', () => {
  expect(new URL(presignR2GetUrl({ ...base, expiresIn: 60 })).searchParams.get('X-Amz-Expires')).toBe('60');
});
