import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CatalogUser } from '@/lib/catalog';
import { CatalogHttpError, createSession } from './catalog-auth';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import {
  CODE_TTL_SECONDS, MAX_CODE_ATTEMPTS, PHONE_PATTERN, SEND_LIMITS,
  hashVerificationCode, isSmsServiceOutage, newVerificationCode, sendVerificationCode,
} from './sms';

type Client = { query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }> };

export const FREE_STYLE_QUOTA = 5;
export const FREE_STORAGE_BYTES = 2_147_483_648; // 2 GiB

const maskedName = (phone: string) => `${phone.slice(0, 3)}****${phone.slice(7)}`;
// RFC 2606 reserves `.invalid`, so a placeholder can never be delivered to by accident.
const placeholderEmail = (phone: string) => `${phone}@phone.invalid`;

function newWorkspace() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(8);
  return `t-${[...bytes].map(byte => alphabet[byte % alphabet.length]).join('')}`;
}

/**
 * Reserve one send across every rate-limit window before calling the provider.
 * Runs inside the caller's transaction: if any window is exhausted the whole reservation
 * rolls back, so a rejected request never consumes the other dimensions.
 */
async function reserveSendQuota(client: Client, phone: string, ip: string | null) {
  for (const { window, limit, scope } of SEND_LIMITS) {
    const key = scope === 'phone' ? `phone:${phone}` : scope === 'ip' ? `ip:${ip ?? 'unknown'}` : 'global';
    // The window start is computed here so the statement has no ambiguous parameter types.
    const windowStart = new Date(Math.floor(Date.now() / 1000 / window) * window * 1000).toISOString();
    const reserved = await client.query(
      `INSERT INTO sms_quota(scope,window_seconds,window_start,used)
       VALUES ($1,$2,$3,1)
       ON CONFLICT (scope,window_seconds,window_start)
       DO UPDATE SET used = sms_quota.used + 1 WHERE sms_quota.used < $4
       RETURNING used`, [key, window, windowStart, limit]);
    if (!reserved.rowCount) {
      throw new CatalogHttpError(429, window <= 60 ? '发送过于频繁，请稍后再试' : '今日验证码发送次数已达上限');
    }
  }
}

/** Server-side verification of the human-check ticket. Never trust the client's word for it. */
async function assertCaptcha(token: string | undefined) {
  const provider = process.env.CAPTCHA_PROVIDER?.trim();
  if (!provider) return; // Not configured yet (local development).
  if (!token || token.length > 2048) throw new CatalogHttpError(400, '请先完成人机校验');
  // Aliyun Captcha 2.0 verification is wired in alongside the production credentials;
  // failing closed here keeps an unconfigured deployment from accepting any ticket.
  throw new CatalogHttpError(503, '人机校验尚未接入，无法发送验证码');
}

export async function requestPhoneCode(input: { phone: string; purpose?: 'login' | 'bind'; ip?: string | null; captchaToken?: string }) {
  const phone = input.phone.trim();
  const purpose = input.purpose ?? 'login';
  if (!PHONE_PATTERN.test(phone)) throw new CatalogHttpError(400, '请输入有效的手机号');
  await assertCaptcha(input.captchaToken);

  const code = newVerificationCode();
  const challengeId = randomUUID();

  await catalogTransaction(async client => {
    await reserveSendQuota(client as Client, phone, input.ip ?? null);
    // A newly issued code invalidates the previous one, so "latest challenge" is unambiguous.
    await client.query('UPDATE sms_challenges SET superseded=true WHERE phone=$1 AND purpose=$2 AND consumed_at IS NULL AND NOT superseded', [phone, purpose]);
    await client.query(
      `INSERT INTO sms_challenges(id,phone,purpose,code_hash,expires_at,request_ip)
       VALUES ($1,$2,$3,$4,now()+$5*interval '1 second',$6)`,
      [challengeId, phone, purpose, hashVerificationCode(code, phone, purpose), CODE_TTL_SECONDS, input.ip ?? null]);
  });

  const result = await sendVerificationCode(phone, code);
  await catalogDatabase().query('UPDATE sms_challenges SET send_state=$2, provider_biz_id=$3, provider_code=$4 WHERE id=$1',
    [challengeId, result.state, result.providerBizId ?? null, result.providerCode ?? null]);

  if (result.state === 'failed') {
    if (isSmsServiceOutage(result.providerCode)) {
      console.error('[sms] 服务不可用，需要立即处理：', result.providerCode, result.message);
      throw new CatalogHttpError(500, '验证码服务暂时不可用，请稍后再试');
    }
    throw new CatalogHttpError(400, result.message || '验证码发送失败');
  }
  // `mockCode` only exists under the mock provider and is dropped by the HTTP route.
  return { cooldownSeconds: 60, expiresInSeconds: CODE_TTL_SECONDS, mockCode: result.mockCode };
}

const codeMatches = (candidate: string, expected: string) => {
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Consume the latest active challenge. The consume is a single conditional UPDATE, so two
 * concurrent requests with the same correct code can only succeed once.
 */
async function consumeChallenge(phone: string, purpose: 'login' | 'bind', code: string, ip: string | null) {
  const found = await catalogDatabase().query(
    `SELECT id, code_hash, attempts FROM sms_challenges
      WHERE phone=$1 AND purpose=$2 AND consumed_at IS NULL AND NOT superseded AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`, [phone, purpose]);
  if (!found.rowCount) throw new CatalogHttpError(400, '验证码已过期，请重新获取');
  const challenge = found.rows[0] as { id: string; code_hash: string; attempts: number };

  // Attempts are recorded outside the business transaction so a later rollback cannot erase them.
  const ok = codeMatches(hashVerificationCode(code, phone, purpose), challenge.code_hash);
  await catalogDatabase().query('INSERT INTO sms_attempts(id,challenge_id,ok,request_ip) VALUES($1,$2,$3,$4)', [randomUUID(), challenge.id, ok, ip]);
  await catalogDatabase().query('UPDATE sms_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.id]);

  if (challenge.attempts + 1 > MAX_CODE_ATTEMPTS) {
    await catalogDatabase().query('UPDATE sms_challenges SET superseded=true WHERE id=$1', [challenge.id]);
    throw new CatalogHttpError(429, '验证次数过多，请重新获取验证码');
  }
  if (!ok) throw new CatalogHttpError(400, '验证码不正确');

  const consumed = await catalogDatabase().query('UPDATE sms_challenges SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL RETURNING id', [challenge.id]);
  if (!consumed.rowCount) throw new CatalogHttpError(400, '验证码已被使用，请重新获取');
}

/**
 * Sign in by phone; the first successful verification creates the account.
 * Tenant, credit account and identity are created in one transaction so a half-built
 * account can never exist.
 */
export async function signInWithPhone(input: { phone: string; code: string; ip?: string | null }): Promise<{ token: string; user: CatalogUser }> {
  const phone = input.phone.trim();
  if (!PHONE_PATTERN.test(phone)) throw new CatalogHttpError(400, '请输入有效的手机号');
  if (!/^\d{6}$/u.test(input.code.trim())) throw new CatalogHttpError(400, '验证码为 6 位数字');
  await consumeChallenge(phone, 'login', input.code.trim(), input.ip ?? null);

  return catalogTransaction(async rawClient => {
    const client = rawClient as Client;
    const existing = await client.query(
      `SELECT u.id,u.email,u.display_name,u.role FROM user_identities i
        JOIN users u ON u.id = i.user_id
        LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE i.kind='phone' AND i.identifier=$1 AND NOT u.disabled AND COALESCE(t.disabled,false)=false`, [phone]);

    if (existing.rowCount) {
      const row = existing.rows[0] as Record<string, string>;
      return {
        token: await createSession(client, row.id),
        user: { id: row.id, email: row.email, displayName: row.display_name, role: row.role as CatalogUser['role'] },
      };
    }

    const tenantId = randomUUID();
    const userId = randomUUID();
    const name = maskedName(phone);
    await client.query(
      `INSERT INTO tenants(id,name,plan,billing_mode,style_quota,storage_quota_bytes,workspace)
       VALUES ($1,$2,'free','charge',$3,$4,$5)`,
      [tenantId, name, FREE_STYLE_QUOTA, FREE_STORAGE_BYTES, newWorkspace()]);
    // Quota accounting must exist from the first request; a tenant without this row cannot
    // reserve capacity and every upload would fail.
    await client.query('INSERT INTO tenant_usage(tenant_id) VALUES($1)', [tenantId]);
    // Zero balance: browsing and uploading work, anything that costs money does not.
    await client.query('INSERT INTO credit_accounts(tenant_id) VALUES($1)', [tenantId]);
    // New accounts start at zero credits: browsing and uploading work, paid actions do not.
    await client.query('INSERT INTO users(id,email,display_name,password_hash,role,tenant_id,tenant_role) VALUES($1,$2,$3,NULL,$4,$5,$6)',
      [userId, placeholderEmail(phone), name, 'editor', tenantId, 'owner']);
    await client.query('INSERT INTO user_identities(id,user_id,kind,identifier,verified_at) VALUES($1,$2,$3,$4,now())',
      [randomUUID(), userId, 'phone', phone]);

    return {
      token: await createSession(client, userId),
      user: { id: userId, email: placeholderEmail(phone), displayName: name, role: 'editor' },
    };
  });
}
