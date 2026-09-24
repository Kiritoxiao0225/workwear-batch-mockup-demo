import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CatalogUser } from '@/lib/catalog';
import { CatalogHttpError, createSession } from './catalog-auth';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { EMAIL_CODE_TTL, emailCodeHash, emailConfiguration, newEmailCode, normalizeEmail, sendEmailCode, type EmailPurpose } from './email';
import { hashAccountPassword, validatePassword } from './passwords';

const ticketHash = (value: string) => createHash('sha256').update(value).digest('hex');
const lockEmail = (client: CatalogQueryClient, email: string) => client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ['email-auth:' + email]);
const fail = (status: number, error: string) => ({ status, error });
const purposes = new Set(['register', 'reset', 'setup']);
export class EmailSendLimitError extends CatalogHttpError {
  constructor(message: string, readonly retryAfterSeconds: number) { super(429, message); }
}
function assertPurpose(purpose: EmailPurpose) {
  if (!purposes.has(purpose)) throw new CatalogHttpError(400, '邮箱验证用途无效');
}
async function emailUser(client: CatalogQueryClient, email: string) {
  return (await client.query(`SELECT u.id,u.email,u.display_name,u.role,u.password_hash,u.password_version,u.disabled,t.disabled AS tenant_disabled
    FROM user_identities i JOIN users u ON u.id=i.user_id JOIN tenants t ON t.id=u.tenant_id
    WHERE i.kind='email' AND i.identifier=$1 FOR UPDATE OF u`, [email])).rows[0];
}

export async function requestEmailCode(input: { email: string; purpose: EmailPurpose; ip?: string | null }) {
  assertPurpose(input.purpose);
  const email = normalizeEmail(input.email), purpose = input.purpose, code = newEmailCode(), id = randomUUID();
  emailConfiguration();
  const hash = emailCodeHash(email, code, purpose);
  await catalogTransaction(async client => {
    await lockEmail(client, email);
    const recent = await client.query("SELECT GREATEST(1,ceil(extract(epoch FROM created_at+interval '60 seconds'-now())))::int AS remaining FROM email_challenges WHERE email=$1 AND created_at>now()-interval '60 seconds' ORDER BY created_at DESC LIMIT 1", [email]);
    if (recent.rowCount) throw new EmailSendLimitError(`请等待 ${recent.rows[0].remaining} 秒后再获取验证码；切换注册或找回密码也需等待。`, recent.rows[0].remaining);
    // Sending never reveals whether the address is already registered.
    for (const [scope, seconds, limit] of [[`email:${email}`, 3600, 5], [`email:${email}`, 86400, 10], [`ip:${input.ip || 'unknown'}`, 3600, 20], ['global', 3600, 500]] as const) {
      const window = new Date(Math.floor(Date.now() / (seconds * 1000)) * seconds * 1000).toISOString();
      const quota = await client.query(`INSERT INTO email_quota(scope,window_seconds,window_start,used) VALUES($1,$2,$3,1)
        ON CONFLICT(scope,window_seconds,window_start) DO UPDATE SET used=email_quota.used+1 WHERE email_quota.used<$4 RETURNING used`, [scope, seconds, window, limit]);
      if (!quota.rowCount) {
        const remaining = Math.max(1, Math.ceil((Date.parse(window) + seconds * 1000 - Date.now()) / 1000));
        throw new EmailSendLimitError(`验证码发送次数已达上限，请约 ${Math.ceil(remaining / 60)} 分钟后再试。`, remaining);
      }
    }
    await client.query('UPDATE email_challenges SET superseded=true WHERE email=$1 AND consumed_at IS NULL AND NOT superseded', [email]);
    await client.query('UPDATE email_password_tickets SET consumed_at=now() WHERE email=$1 AND consumed_at IS NULL', [email]);
    await client.query("INSERT INTO email_challenges(id,email,purpose,code_hash,expires_at,request_ip) VALUES($1,$2,$3,$4,now()+$5*interval '1 second',$6)", [id, email, purpose, hash, EMAIL_CODE_TTL, input.ip ?? null]);
  });
  const result = await sendEmailCode(email, code, purpose);
  await catalogDatabase().query('UPDATE email_challenges SET send_state=$2,provider_id=$3,provider_code=$4 WHERE id=$1', [id, result.state, result.providerId ?? null, result.providerCode ?? null]);
  if (result.state === 'failed') throw new CatalogHttpError(503, '邮件发送暂时不可用，请稍后再试');
  return { cooldownSeconds: 60, expiresInSeconds: EMAIL_CODE_TTL, deliveryState: result.state, mockCode: result.mockCode };
}

/** Verification issues a short-lived, single-use proof. It does not create an account/session. */
export async function verifyEmailCode(input: { email: string; code: string; purpose: EmailPurpose }) {
  assertPurpose(input.purpose);
  const email = normalizeEmail(input.email), code = input.code.trim(), purpose = input.purpose;
  if (!/^\d{6}$/u.test(code)) throw new CatalogHttpError(400, '验证码为 6 位数字');
  const hash = emailCodeHash(email, code, purpose);
  const result = await catalogTransaction(async client => {
    await lockEmail(client, email);
    const found = await client.query(`SELECT id,code_hash,attempts FROM email_challenges
      WHERE email=$1 AND purpose=$2 AND NOT superseded AND consumed_at IS NULL AND expires_at>now() AND send_state IN ('accepted','unknown')
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [email, purpose]);
    if (!found.rowCount) return fail(400, '验证码已失效或不适用于当前操作，请重新获取');
    const challenge = found.rows[0];
    if (challenge.attempts >= 5) return fail(429, '验证次数过多，请重新获取验证码');
    const a = Buffer.from(hash, 'hex'), b = Buffer.from(challenge.code_hash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await client.query('UPDATE email_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.id]);
      return fail(400, '验证码不正确');
    }
    await client.query('UPDATE email_challenges SET consumed_at=now() WHERE id=$1', [challenge.id]);
    const user = await emailUser(client, email);
    if (user?.disabled || user?.tenant_disabled) return fail(403, '账号已停用，请联系管理员');
    // These account hints are shown only after ownership of the mailbox is established.
    if (purpose !== 'register' && !user) return fail(404, '此邮箱尚未注册，请先用邮箱注册');
    if (purpose === 'setup' && user?.password_hash) return fail(409, '此账号已设置密码，请返回登录，或找回密码');
    // Ownership was verified above. Continue on the existing identity instead of
    // consuming its proof and forcing another email. Password changes still require
    // explicit submission, a purpose-bound ticket and the current password version.
    const nextPurpose: EmailPurpose = purpose === 'register' && user ? (user.password_hash ? 'reset' : 'setup') : purpose;
    const verificationToken = randomBytes(32).toString('hex');
    await client.query(`INSERT INTO email_password_tickets(token_hash,challenge_id,email,purpose,user_id,password_version,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,now()+interval '5 minutes')`, [ticketHash(verificationToken), challenge.id, email, nextPurpose, user?.id ?? null, user?.password_version ?? null]);
    return { verificationToken, expiresInSeconds: 300, purpose: nextPurpose };
  });
  if ('error' in result) throw new CatalogHttpError(result.status, result.error);
  return result;
}

export async function completeEmailPassword(input: { email: string; purpose: EmailPurpose; verificationToken: string; password: string }) {
  assertPurpose(input.purpose);
  const email = normalizeEmail(input.email), purpose = input.purpose;
  validatePassword(input.password);
  if (!/^[a-f0-9]{64}$/u.test(input.verificationToken)) throw new CatalogHttpError(400, '邮箱验证已失效，请重新验证');
  const proofHash = ticketHash(input.verificationToken);
  // Reject arbitrary tokens before doing expensive password hashing; recheck under the lock.
  const proof = await catalogDatabase().query(`SELECT token_hash FROM email_password_tickets WHERE token_hash=$1 AND email=$2 AND purpose=$3 AND consumed_at IS NULL AND expires_at>now()`, [proofHash, email, purpose]);
  if (!proof.rowCount) throw new CatalogHttpError(400, '邮箱验证已失效，请重新验证');
  const passwordHash = await hashAccountPassword(input.password);
  return catalogTransaction(async client => {
    await lockEmail(client, email);
    const found = await client.query(`SELECT * FROM email_password_tickets WHERE token_hash=$1 AND email=$2 AND purpose=$3 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`, [proofHash, email, purpose]);
    if (!found.rowCount) throw new CatalogHttpError(400, '邮箱验证已失效，请重新验证');
    const ticket = found.rows[0], existing = await emailUser(client, email);
    if (existing?.disabled || existing?.tenant_disabled) throw new CatalogHttpError(403, '账号已停用，请联系管理员');
    if (purpose === 'register') {
      if (existing) throw new CatalogHttpError(409, '此邮箱已有账号，请返回登录');
      const userId = randomUUID(), tenantId = randomUUID(), name = email.split('@')[0].slice(0, 60);
      await client.query(`INSERT INTO tenants(id,name,plan,billing_mode,style_quota,storage_quota_bytes,workspace)
        VALUES($1,$2,'free','charge',5,536870912,$3)`, [tenantId, name, 't-' + tenantId]);
      await client.query('INSERT INTO tenant_usage(tenant_id) VALUES($1)', [tenantId]);
      await client.query('INSERT INTO credit_accounts(tenant_id) VALUES($1)', [tenantId]);
      await client.query("INSERT INTO users(id,email,display_name,password_hash,role,tenant_id,tenant_role,password_version) VALUES($1,$2,$3,$4,'editor',$5,'owner',1)", [userId, email, name, passwordHash, tenantId]);
      await client.query("INSERT INTO user_identities(id,user_id,kind,identifier,verified_at) VALUES($1,$2,'email',$3,now())", [randomUUID(), userId, email]);
      await client.query('UPDATE email_password_tickets SET consumed_at=now() WHERE token_hash=$1', [proofHash]);
      const user: CatalogUser = { id: userId, email, displayName: name, role: 'editor' };
      return { kind: 'registered' as const, user, token: await createSession(client, userId) };
    }
    if (!existing || existing.id !== ticket.user_id || existing.password_version !== ticket.password_version)
      throw new CatalogHttpError(400, '账号状态已变化，请重新验证邮箱');
    if (purpose === 'setup' && existing.password_hash) throw new CatalogHttpError(409, '此账号已设置密码，请使用找回密码');
    await client.query('UPDATE users SET password_hash=$2,password_version=password_version+1,failed_logins=0,locked_until=NULL WHERE id=$1', [existing.id, passwordHash]);
    await client.query("UPDATE user_identities SET verified_at=COALESCE(verified_at,now()) WHERE user_id=$1 AND kind='email' AND identifier=$2", [existing.id, email]);
    await client.query('DELETE FROM sessions WHERE user_id=$1', [existing.id]);
    await client.query('UPDATE email_password_tickets SET consumed_at=now() WHERE email=$1 AND consumed_at IS NULL', [email]);
    await client.query('UPDATE email_challenges SET superseded=true WHERE email=$1 AND consumed_at IS NULL', [email]);
    return { kind: 'password-set' as const };
  });
}
