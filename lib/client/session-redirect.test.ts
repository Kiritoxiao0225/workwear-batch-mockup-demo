import { describe, expect, it } from 'vitest';
import { expiredSessionDestination } from './session-redirect';

describe('expired session recovery', () => {
  it('preserves the exact workspace path, filters and selected section', () => {
    const path = '/products?style=%E8%A1%A3&color=blue#positions';
    const destination = new URL(expiredSessionDestination(401, path)!, 'https://mockup.example');
    expect(destination.pathname).toBe('/login');
    expect(destination.searchParams.get('next')).toBe(path);
    expect(destination.searchParams.get('reason')).toBe('session-expired');
  });
  it.each([200, 403, 429, 500, 502, 503, 504])('keeps status %i on the workspace for retry', status => {
    expect(expiredSessionDestination(status, '/artwork-studio')).toBeNull();
  });
  it.each(['/login', '/login?mode=reset', '/login?mode=setup', '/login?mode=register', '/login/'])('never loops or interrupts auth forms on %s', path => {
    expect(expiredSessionDestination(401, path)).toBeNull();
  });
  it.each(['//evil.example', '/\\evil.example', 'https://evil.example', '/ bad'])('rejects unsafe return paths: %s', path => {
    const destination = new URL(expiredSessionDestination(401, path)!, 'https://mockup.example');
    expect(destination.searchParams.get('next')).toBe('/artwork-studio');
  });
});
