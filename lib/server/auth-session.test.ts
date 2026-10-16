import { expect, it } from 'vitest';
import { requestIp } from './auth-session';

const from = (forwarded?: string) => new Request('https://mockup.example/api/auth/login', { headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } });

it('uses the hop Zeabur appended, not one the client made up', () => {
  // A client sending its own header arrives as "<made up>, <real>".
  expect(requestIp(from('203.0.113.7, 198.51.100.24'))).toBe('198.51.100.24');
  expect(requestIp(from('1.1.1.1, 2.2.2.2, 198.51.100.24'))).toBe('198.51.100.24');
});

it('takes a single hop as is', () => {
  expect(requestIp(from('198.51.100.24'))).toBe('198.51.100.24');
  expect(requestIp(from('2001:db8::1'))).toBe('2001:db8::1');
});

it('has no address when the header is missing, empty or not an address', () => {
  expect(requestIp(from())).toBeNull();
  expect(requestIp(from(''))).toBeNull();
  expect(requestIp(from('198.51.100.24, <script>'))).toBeNull();
});
