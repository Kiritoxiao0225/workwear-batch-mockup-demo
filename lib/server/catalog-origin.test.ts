import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSameOrigin } from '@/lib/server/catalog-auth';
afterEach(() => vi.unstubAllEnvs());
describe('catalog development origin', () => {
  it('allows the active local development port while retaining same-origin validation', () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('CATALOG_APP_ORIGIN', 'http://127.0.0.1:3177');
    expect(() => assertSameOrigin(new Request('http://localhost:3001/api/catalog/session', { headers: { origin: 'http://localhost:3001' } }))).not.toThrow();
    expect(() => assertSameOrigin(new Request('http://localhost:3001/api/catalog/session', { headers: { origin: 'http://localhost:9999' } }))).toThrow('请求来源');
    expect(() => assertSameOrigin(new Request('http://localhost:3001/api/catalog/session', { headers: { origin: 'https://foreign.example' } }))).toThrow('请求来源');
  });
  it('retains the configured origin in production', () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('CATALOG_APP_ORIGIN', 'https://mockup.example');
    expect(() => assertSameOrigin(new Request('http://localhost:3001/api/catalog/session', { headers: { origin: 'http://localhost:3001' } }))).toThrow('请求来源');
  });
});
