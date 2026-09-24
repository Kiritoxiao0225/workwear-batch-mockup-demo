import { scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { hashPassword, verifyPassword } from '@better-auth/utils/password';
import { CatalogHttpError } from './catalog-auth';

const legacyScrypt = promisify(scrypt);
const PREFIX = '$better-auth$';
export function validatePassword(password: string) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 256)
    throw new CatalogHttpError(400, '密码长度必须在 8 到 256 字符之间');
}
export async function hashAccountPassword(password: string) {
  validatePassword(password);
  return PREFIX + await hashPassword(password);
}
export async function verifyAccountPassword(password: string, encoded: string) {
  if (encoded.startsWith(PREFIX)) return verifyPassword(encoded.slice(PREFIX.length), password);
  // Existing scrypt hashes use r=8 and no normalization; keep those passwords working.
  if (!/^[0-9a-f]{32}:[0-9a-f]{128}$/u.test(encoded)) return false;
  const [salt, hash] = encoded.split(':');
  const candidate = await legacyScrypt(password, salt, 64) as Buffer;
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}
