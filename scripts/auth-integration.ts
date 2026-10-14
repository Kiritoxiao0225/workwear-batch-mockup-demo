/**
 * Tenant model and phone sign-in, verified against a real temporary PostgreSQL.
 * No network calls: the SMS provider runs in mock mode.
 */
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import sharp from 'sharp';
import { NextRequest } from 'next/server';

const root = await mkdtemp(path.join(tmpdir(), 'auth-test-'));
const probe = createServer();
await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
const address = probe.address();
if (!address || typeof address === 'string') throw new Error('无法选择测试数据库端口');
const port = address.port;
await new Promise<void>(resolve => probe.close(() => resolve()));

const password = randomBytes(24).toString('hex');
process.env.CATALOG_DATABASE_URL = `postgresql://auth_test:${password}@127.0.0.1:${port}/postgres`;
process.env.CATALOG_LOCAL_OBJECT_ROOT = path.join(root, 'objects');
process.env.SMS_PROVIDER = 'mock';
process.env.EMAIL_PROVIDER = 'mock';
process.env.EMAIL_PEPPER = randomBytes(32).toString('hex');
process.env.SMS_PEPPER = randomBytes(24).toString('hex');
process.env.CATALOG_APP_ORIGIN = 'http://127.0.0.1:3000';
delete process.env.CATALOG_AUTH_MODE;

const database = new EmbeddedPostgres({
  databaseDir: path.join(root, 'postgres'), user: 'auth_test', password, port,
  persistent: true, authMethod: 'scram-sha-256', postgresFlags: ['-h', '127.0.0.1'],
  onLog: () => {}, onError: message => console.error(message),
});

let checks = 0;
const check = (condition: unknown, label: string) => { assert.ok(condition, label); checks += 1; };
const phones = (() => { let n = 0; return () => `138${String(10_000_000 + (n += 1)).slice(0, 8)}`; })();

async function rejects(work: () => Promise<unknown>, status: number, label: string) {
  try { await work(); }
  catch (error) {
    const actual = (error as { status?: number }).status;
    check(actual === status, `${label}（期望 ${status}，实际 ${actual ?? error}）`);
    return;
  }
  assert.fail(`${label}：应当失败但成功了`);
}

await database.initialise();
await database.start();
// initialise() already creates postgres; CREATE DATABASE on it leaks the helper's connection on error.

try {
  const { catalogDatabase, closeCatalogDatabase, migrateCatalog } = await import('../lib/server/catalog-database');
  const { createCatalogUser, loginCatalog, catalogUser, INTERNAL_TENANT_ID } = await import('../lib/server/catalog-auth');
  const { tenantScope, internalScope, tenantByWorkspace, workspaceFor, DEFAULT_WORKSPACE } = await import('../lib/server/tenant-scope');
  const { requestPhoneCode, signInWithPhone, FREE_STYLE_QUOTA, FREE_STORAGE_BYTES } = await import('../lib/server/phone-auth');
  const { backupCatalog } = await import('../lib/server/catalog-backup');
  const { POST: sendCodeRoute } = await import('../app/api/auth/sms/send/route');
  const { POST: phoneLoginRoute } = await import('../app/api/auth/sms/login/route');
  const { GET: sessionRoute } = await import('../app/api/auth/session/route');
  const { POST: logoutRoute } = await import('../app/api/auth/logout/route');
  const { importCatalogAsset } = await import('../lib/server/catalog-import');
  const { listCatalogStyles, catalogStyle, catalogDetail, allCatalogStyles } = await import('../lib/server/catalog-repository');
  const { tenantUsage, reserveQuota, releaseQuota, settleQuota, sweepExpiredReservations } = await import('../lib/server/quota');
  const { assertFileAccess, canAccessFile } = await import('../lib/server/file-authorization');
  const { currentPrices, ceilingMicroCents, microToCents, holdCredits, settleHold, releaseHold,
    adjudicateHold, grantCredits, creditBalance, openHolds } = await import('../lib/server/credits');
  const { GET: catalogFileRoute } = await import('../app/api/catalog/files/[id]/route');
  const { GET: accountRoute } = await import('../app/api/account/route');
  const { GET: adminTenantsRoute } = await import('../app/api/admin/tenants/route');
  const { POST: adminGrantRoute } = await import('../app/api/admin/grant/route');
  const { catalogTransaction } = await import('../lib/server/catalog-database');

  const applied = await migrateCatalog();
  check(applied.includes('017_tenants_identities.sql'), '017 迁移已执行');
  check(applied.includes('018_sms_challenges.sql'), '018 迁移已执行');

  const db = catalogDatabase();
  const withSession = (token: string) =>
    new NextRequest('http://127.0.0.1:3000/api/catalog/session', { headers: { cookie: `catalog_session=${token}` } });

  // Email ownership is separate from registration/password mutation.
  const { requestEmailCode, verifyEmailCode, completeEmailPassword } = await import('../lib/server/email-auth');
  const { createSession } = await import('../lib/server/catalog-auth');
  const email = 'signup@example.com';
  const emailCode = await requestEmailCode({ email: ' SIGNUP@EXAMPLE.COM ', purpose: 'register', ip: '203.0.113.50' });
  check(Boolean(emailCode.mockCode), '邮箱模拟发送成功');
  check(!(await db.query('SELECT id FROM users WHERE email=$1', [email])).rowCount, '发送验证码不创建账号');
  await rejects(() => requestEmailCode({ email, purpose: 'reset', ip: '203.0.113.50' }), 429, '跨用途同邮箱 60 秒发送限制');
  const { POST: emailCooldownRoute } = await import('../app/api/auth/email/send/route');
  const emailLimited = await emailCooldownRoute(new NextRequest('http://127.0.0.1:3000/api/auth/email/send', {method:'POST',headers:{origin:'http://127.0.0.1:3000','content-type':'application/json'},body:JSON.stringify({email,purpose:'reset'})}));
  const emailLimitedBody = await emailLimited.json();
  check(emailLimited.status===429 && emailLimitedBody.retryAfterSeconds>0 && emailLimitedBody.retryAfterSeconds<=60 && emailLimited.headers.get('Retry-After')===String(emailLimitedBody.retryAfterSeconds), '切换用途发送受限时返回实际剩余秒数及 Retry-After');
  await rejects(() => verifyEmailCode({ email, purpose: 'reset', code: emailCode.mockCode! }), 400, '注册验证码不能用于重置密码');
  const emailRace = await Promise.allSettled([verifyEmailCode({ email, purpose: 'register', code: emailCode.mockCode! }), verifyEmailCode({ email, purpose: 'register', code: emailCode.mockCode! })]);
  check(emailRace.filter(r => r.status === 'fulfilled').length === 1, '邮箱验证码并发只消费一次');
  const verified = emailRace.find(r => r.status === 'fulfilled');
  if (!verified || verified.status !== 'fulfilled') throw new Error('邮箱验证失败');
  check(!(await db.query('SELECT id FROM users WHERE email=$1', [email])).rowCount, '邮箱验证成功仍不创建账号');
  check(!(await db.query('SELECT token_hash FROM email_password_tickets WHERE token_hash=$1', [verified.value.verificationToken])).rowCount, '设密凭据只存哈希');
  await rejects(() => completeEmailPassword({ email:'other@example.com', purpose:'register', verificationToken:verified.value.verificationToken, password:'Password2026' }), 400, '设密凭据绑定邮箱');
  await rejects(() => completeEmailPassword({ email, purpose:'reset', verificationToken:verified.value.verificationToken, password:'Password2026' }), 400, '设密凭据绑定用途');
  await rejects(() => completeEmailPassword({ email, purpose:'register', verificationToken:verified.value.verificationToken, password:'short' }), 400, '弱长度密码不能完成注册');
  const completions = await Promise.allSettled([1,2].map(() => completeEmailPassword({ email, purpose:'register', verificationToken:verified.value.verificationToken, password:'Password2026' })));
  check(completions.filter(r => r.status === 'fulfilled').length === 1, '注册提交并发只创建一个账号');
  const completed = completions.find(r => r.status === 'fulfilled');
  if (!completed || completed.status !== 'fulfilled' || completed.value.kind !== 'registered') throw new Error('邮箱注册失败');
  const emailSigned = completed.value;
  const emailScope = await tenantScope(withSession(emailSigned.token));
  check(emailScope.tenant.workspace.startsWith('t-') && emailScope.tenant.billingMode === 'charge', '邮箱账号创建独立收费工作区');
  await rejects(() => internalScope(withSession(emailSigned.token)), 403, '邮箱新用户不能访问内部 WPS');
  check((await loginCatalog(email, 'Password2026')).user.id === emailSigned.user.id, '新账号可用密码登录且保留同一身份');
  check((await db.query('SELECT password_hash FROM users WHERE id=$1', [emailSigned.user.id])).rows[0].password_hash.startsWith('$better-auth$'), '密码使用 Better Auth 官方哈希模块');
  const cool = async (address: string) => { await db.query("UPDATE email_challenges SET created_at=now()-interval '61 seconds' WHERE email=$1", [address]); };
  await cool(email);
  const duplicate = await requestEmailCode({email, purpose:'register', ip:'203.0.113.50'});
  const duplicateProof = await verifyEmailCode({email, purpose:'register', code:duplicate.mockCode!});
  check(duplicateProof.purpose==='reset', '已验证邮箱的重复注册直接进入重置密码');
  await rejects(() => verifyEmailCode({email,purpose:'register',code:duplicate.mockCode!}),400,'转入重置后注册验证码不可重放');
  await rejects(() => completeEmailPassword({email,purpose:'register',verificationToken:duplicateProof.verificationToken,password:'Password2026'}),400,'转入重置的凭据不可用于创建账号');
  check((await loginCatalog(email,'Password2026')).user.id===emailSigned.user.id, '验证通过但尚未提交新密码时不改动账号');
  await completeEmailPassword({email,purpose:'reset',verificationToken:duplicateProof.verificationToken,password:'Password2026'});
  check((await db.query('SELECT id,tenant_id FROM users WHERE email=$1',[email])).rows.every(u=>u.id===emailSigned.user.id&&u.tenant_id===emailScope.tenant.id), '重复注册转入重置后保留原账号和工作区');
  await cool(email);
  const reset = await requestEmailCode({email, purpose:'reset', ip:'203.0.113.50'});
  const resetProof = await verifyEmailCode({email, purpose:'reset', code:reset.mockCode!});
  const resetRace = await Promise.allSettled([1,2].map(() => completeEmailPassword({email, purpose:'reset', verificationToken:resetProof.verificationToken, password:'Changed2026'})));
  check(resetRace.filter(r=>r.status==='fulfilled').length===1, '密码重置凭据并发只使用一次');
  await rejects(() => catalogUser(withSession(emailSigned.token)), 401, '重置密码撤销旧登录会话');
  await rejects(() => loginCatalog(email, 'Password2026'), 401, '旧密码失效');
  const resetLogin = await loginCatalog(email, 'Changed2026');
  check(resetLogin.user.id === emailSigned.user.id, '重置密码保留用户身份');
  check((await tenantScope(withSession(resetLogin.token))).tenant.id === emailScope.tenant.id, '重置密码保留原工作区');
  const oldId = await createCatalogUser('legacy-otp@example.com', '旧邮箱账号', 'Temporary2026', 'admin');
  await db.query('UPDATE users SET password_hash=NULL WHERE id=$1', [oldId]);
  const oldToken = await catalogTransaction(client => createSession(client,oldId));
  const setup = await requestEmailCode({email:'legacy-otp@example.com',purpose:'setup',ip:'203.0.113.51'});
  const setupProof = await verifyEmailCode({email:'legacy-otp@example.com',purpose:'setup',code:setup.mockCode!});
  await completeEmailPassword({email:'legacy-otp@example.com',purpose:'setup',verificationToken:setupProof.verificationToken,password:'Owner2026'});
  const ownerLogin = await loginCatalog('legacy-otp@example.com','Owner2026');
  check(ownerLogin.user.id===oldId && ownerLogin.user.role==='admin', '旧账号首次设密保留 ID 与管理员权限');
  check((await tenantScope(withSession(ownerLogin.token))).tenant.workspace==='main', '旧内部账号设密后仍在 WPS main');
  await rejects(() => catalogUser(withSession(oldToken)), 401, '首次设密撤销旧验证码会话');
  await cool('legacy-otp@example.com');
  const setupAgain = await requestEmailCode({email:'legacy-otp@example.com',purpose:'setup',ip:'203.0.113.51'});
  await rejects(() => verifyEmailCode({email:'legacy-otp@example.com',purpose:'setup',code:setupAgain.mockCode!}),409,'已有密码不能再次走首次设置入口');
  const registrationLegacyEmail='legacy-register@example.com';
  const registrationLegacyId=await createCatalogUser(registrationLegacyEmail,'旧验证码账号误点注册','Temporary2026','admin');
  await db.query('UPDATE users SET password_hash=NULL WHERE id=$1',[registrationLegacyId]);
  const legacyRegister=await requestEmailCode({email:registrationLegacyEmail,purpose:'register',ip:'203.0.113.57'});
  const legacyRegisterProof=await verifyEmailCode({email:registrationLegacyEmail,purpose:'register',code:legacyRegister.mockCode!});
  check(legacyRegisterProof.purpose==='setup','无密码旧账号注册验证后直接进入首次设密');
  await completeEmailPassword({email:registrationLegacyEmail,purpose:'setup',verificationToken:legacyRegisterProof.verificationToken,password:'LegacyOwner2026'});
  const legacyRegisterLogin=await loginCatalog(registrationLegacyEmail,'LegacyOwner2026');
  check(legacyRegisterLogin.user.id===registrationLegacyId&&legacyRegisterLogin.user.role==='admin','首次设密转换保留旧账号和权限');
  check((await tenantScope(withSession(legacyRegisterLogin.token))).tenant.workspace==='main','首次设密转换保留原工作区');
  const legacyId = await createCatalogUser('legacy-password@example.com','旧密码','Legacy2026');
  const salt = randomBytes(16).toString('hex');
  await db.query('UPDATE users SET password_hash=$2 WHERE id=$1',[legacyId,`${salt}:${scryptSync('Legacy2026',salt,64).toString('hex')}`]);
  check((await loginCatalog('legacy-password@example.com','Legacy2026')).user.id===legacyId,'旧版 scrypt 密码不需要重置即可登录');
  const guessEmail = 'guess@example.com';
  const guessed = await requestEmailCode({ email: guessEmail, purpose:'register', ip: '203.0.113.52' });
  const incorrect = guessed.mockCode === '000000' ? '111111' : '000000';
  for (let attempt=0; attempt<5; attempt++) await rejects(() => verifyEmailCode({ email: guessEmail, purpose:'register', code: incorrect }), 400, '邮箱错误次数持久化');
  await rejects(() => verifyEmailCode({ email: guessEmail, purpose:'register', code: guessed.mockCode! }), 429, '邮箱猜测超限后正确码也拒绝');
  const expiresEmail = 'expires@example.com';
  const expired = await requestEmailCode({ email: expiresEmail, purpose:'register', ip: '203.0.113.53' });
  await db.query("UPDATE email_challenges SET expires_at=now()-interval '1 second' WHERE email=$1", [expiresEmail]);
  await rejects(() => verifyEmailCode({ email: expiresEmail, purpose:'register', code: expired.mockCode! }), 400, '邮箱验证码过期拒绝');
  const proofEmail = 'proof-expiry@example.com';
  const proofCode = await requestEmailCode({email:proofEmail,purpose:'register',ip:'203.0.113.54'});
  const expiresProof = await verifyEmailCode({email:proofEmail,purpose:'register',code:proofCode.mockCode!});
  await db.query("UPDATE email_password_tickets SET expires_at=now()-interval '1 second' WHERE email=$1",[proofEmail]);
  await rejects(()=>completeEmailPassword({email:proofEmail,purpose:'register',verificationToken:expiresProof.verificationToken,password:'Password2026'}),400,'设密凭据过期后不能创建账号');
  const replacedEmail='resend@example.com';
  const previous=await requestEmailCode({email:replacedEmail,purpose:'register',ip:'203.0.113.55'});
  const previousProof=await verifyEmailCode({email:replacedEmail,purpose:'register',code:previous.mockCode!});
  await cool(replacedEmail);await requestEmailCode({email:replacedEmail,purpose:'register',ip:'203.0.113.55'});
  await rejects(()=>completeEmailPassword({email:replacedEmail,purpose:'register',verificationToken:previousProof.verificationToken,password:'Password2026'}),400,'重发验证码使前一设密凭据失效');
  const missing=await requestEmailCode({email:'missing@example.com',purpose:'reset',ip:'203.0.113.56'});
  await rejects(()=>verifyEmailCode({email:'missing@example.com',purpose:'reset',code:missing.mockCode!}),404,'未注册邮箱找回密码不会隐式创建账号');
  const { POST: emailSendRoute } = await import('../app/api/auth/email/send/route');
  const { POST: oldEmailLoginRoute } = await import('../app/api/auth/email/login/route');
  const { POST: completeRoute } = await import('../app/api/auth/email/complete/route');
  const req = (body:unknown,origin='http://127.0.0.1:3000')=>new NextRequest('http://127.0.0.1:3000/api/auth/email/send',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const emailResponse = await emailSendRoute(req({email:'route@example.com',purpose:'register'}));
  const emailResponseBody = await emailResponse.json();
  check(emailResponse.status === 200 && !('mockCode' in emailResponseBody), '邮箱 HTTP 响应不泄露验证码');
  check((await emailSendRoute(req({email:'no-purpose@example.com'}))).status===400,'旧版无用途发送请求不能绕过新流程');
  check((await oldEmailLoginRoute()).status===410,'旧验证码登录路由已停用');
  check((await completeRoute(req({email,purpose:'reset',verificationToken:'a'.repeat(64),password:'Wrong2026',confirmPassword:'Different2026'}))).status===400,'HTTP 校验两次密码一致');
  check((await completeRoute(req({},'https://evil.example'))).status===403,'密码设置拒绝跨站请求');
  const {limitPasswordLogin}=await import('../lib/server/password-login-limit');
  for(let i=0;i<60;i++)await limitPasswordLogin('203.0.113.250');
  await rejects(()=>limitPasswordLogin('203.0.113.250'),429,'未知账号的密码尝试也有 IP 限速');

  // ---- 内部租户：承载现有 WPS 交付，必须免计费且工作区仍是 main ----
  const internal = await tenantByWorkspace('main');
  check(internal?.id === INTERNAL_TENANT_ID, '内部租户 workspace=main');
  check(internal?.plan === 'internal' && internal.billingMode === 'exempt', '内部租户免计费');
  check(Number.isSafeInteger(internal!.storageQuotaBytes), '配额数值可安全经过 JSON 往返（备份恢复依赖这一点）');
  check(workspaceFor(null) === DEFAULT_WORKSPACE && DEFAULT_WORKSPACE === 'main', '无租户上下文时工作区默认 main');

  // ---- 邮箱账号：凭据走 user_identities，且默认归内部租户 ----
  const adminId = await createCatalogUser('ops@example.com', '运维', 'Aa123456789', 'admin');
  const identity = await db.query("SELECT user_id FROM user_identities WHERE kind='email' AND identifier=$1", ['ops@example.com']);
  check(identity.rows[0]?.user_id === adminId, '建号同时写入邮箱身份');
  const adminLogin = await loginCatalog('ops@example.com', 'Aa123456789');
  check(adminLogin.user.id === adminId, '邮箱登录走 identities');
  const adminScope = await tenantScope(withSession(adminLogin.token));
  check(adminScope.tenant.id === INTERNAL_TENANT_ID, '现有账号归内部租户');
  await internalScope(withSession(adminLogin.token));
  check(true, 'internalScope 放行内部账号');

  // ---- 手机号首次登录即建号 ----
  const phone = phones();
  const sent = await requestPhoneCode({ phone, ip: '203.0.113.9' });
  check(typeof sent.mockCode === 'string' && sent.mockCode.length === 6, 'mock 模式下发 6 位验证码');
  const signedIn = await signInWithPhone({ phone, code: sent.mockCode!, ip: '203.0.113.9' });
  check(signedIn.user.email === `${phone}@phone.invalid`, '手机号账号使用不可投递的占位邮箱');
  check(signedIn.user.displayName === `${phone.slice(0, 3)}****${phone.slice(7)}`, '显示名打码');

  const created = await tenantScope(withSession(signedIn.token));
  check(created.tenant.id !== INTERNAL_TENANT_ID, '新账号是独立租户');
  check(/^t-[a-z0-9]{8}$/u.test(created.tenant.workspace), '新租户分配独立工作区');
  check(created.tenant.workspace !== 'main', '新租户绝不落在交付工作区');
  check(created.tenant.plan === 'free' && created.tenant.billingMode === 'charge', '新租户为免费计费档');
  check(created.tenant.styleQuota === FREE_STYLE_QUOTA, `免费款式配额 ${FREE_STYLE_QUOTA}`);
  check(created.tenant.storageQuotaBytes === FREE_STORAGE_BYTES, '免费存储配额 2 GiB');
  const freshUsage = await db.query('SELECT 1 FROM tenant_usage WHERE tenant_id=$1', [created.tenant.id]);
  check(freshUsage.rowCount === 1, '建号事务同时创建用量记录，否则首次上传必失败');
  const noPassword = await db.query('SELECT password_hash FROM users WHERE id=$1', [signedIn.user.id]);
  check(noPassword.rows[0].password_hash === null, '验证码账号没有密码');
  await rejects(() => internalScope(withSession(signedIn.token)), 403, '外部租户被 internalScope 拒绝');

  // ---- 同一手机号再次登录：复用账号，不重复建租户 ----
  const before = await db.query('SELECT count(*)::int AS n FROM tenants');
  await db.query('DELETE FROM sms_quota WHERE scope=$1', [`phone:${phone}`]); // 模拟发送窗口过期
  const resent = await requestPhoneCode({ phone, ip: '203.0.113.9' });
  const reSignedIn = await signInWithPhone({ phone, code: resent.mockCode! });
  const after = await db.query('SELECT count(*)::int AS n FROM tenants');
  check(reSignedIn.user.id === signedIn.user.id, '同一手机号复用同一账号');
  check(after.rows[0].n === before.rows[0].n, '重复登录不新建租户');

  // ---- 限流：同号 60 秒内只能发一条 ----
  const limited = phones();
  await requestPhoneCode({ phone: limited, ip: '203.0.113.10' });
  await rejects(() => requestPhoneCode({ phone: limited, ip: '203.0.113.10' }), 429, '同号 60 秒内第二次发送被拒');

  // ---- 旧验证码在新码签发后立即失效 ----
  const rotating = phones();
  const first = await requestPhoneCode({ phone: rotating, ip: '203.0.113.11' });
  await db.query('DELETE FROM sms_quota WHERE scope=$1', [`phone:${rotating}`]);
  const second = await requestPhoneCode({ phone: rotating, ip: '203.0.113.11' });
  check(first.mockCode !== second.mockCode, '两次下发的验证码不同');
  await rejects(() => signInWithPhone({ phone: rotating, code: first.mockCode! }), 400, '旧验证码已被新码作废');
  const rotated = await signInWithPhone({ phone: rotating, code: second.mockCode! });
  check(Boolean(rotated.token), '最新验证码可用');

  // ---- 错误验证码：记录尝试、次数用尽后作废 ----
  const guessing = phones();
  const guessTarget = await requestPhoneCode({ phone: guessing, ip: '203.0.113.12' });
  const wrong = guessTarget.mockCode === '000000' ? '111111' : '000000';
  await rejects(() => signInWithPhone({ phone: guessing, code: wrong }), 400, '错误验证码被拒');
  const attempts = await db.query(
    'SELECT count(*)::int AS n FROM sms_attempts a JOIN sms_challenges c ON c.id=a.challenge_id WHERE c.phone=$1 AND NOT a.ok', [guessing]);
  check(attempts.rows[0].n === 1, '失败尝试被独立持久化');
  // 前 5 次返回 400；第 6 次触发上限，返回 429 并作废该验证码。
  for (let i = 0; i < 4; i += 1) await rejects(() => signInWithPhone({ phone: guessing, code: wrong }), 400, `第 ${i + 2} 次错误仍返回 400`);
  await rejects(() => signInWithPhone({ phone: guessing, code: wrong }), 429, '第 6 次错误触发次数上限');
  await rejects(() => signInWithPhone({ phone: guessing, code: guessTarget.mockCode! }), 400, '作废后正确验证码也不可用，必须重新获取');
  const dead = await db.query('SELECT superseded FROM sms_challenges WHERE phone=$1 ORDER BY created_at DESC LIMIT 1', [guessing]);
  check(dead.rows[0].superseded === true, '超出尝试次数的验证码被标记作废');

  // ---- 并发使用同一个正确验证码：只能成功一次 ----
  const racing = phones();
  const raceCode = await requestPhoneCode({ phone: racing, ip: '203.0.113.13' });
  const results = await Promise.allSettled([
    signInWithPhone({ phone: racing, code: raceCode.mockCode! }),
    signInWithPhone({ phone: racing, code: raceCode.mockCode! }),
  ]);
  check(results.filter(r => r.status === 'fulfilled').length === 1, '同一验证码并发登录只成功一次');
  const users = await db.query("SELECT count(*)::int AS n FROM user_identities WHERE kind='phone' AND identifier=$1", [racing]);
  check(users.rows[0].n === 1, '并发登录没有建出两个账号');

  // ---- 停用租户：会话立即失效 ----
  const suspended = phones();
  const suspendedCode = await requestPhoneCode({ phone: suspended, ip: '203.0.113.14' });
  const suspendedSession = await signInWithPhone({ phone: suspended, code: suspendedCode.mockCode! });
  await catalogUser(withSession(suspendedSession.token));
  check(true, '停用前会话有效');
  await db.query('UPDATE tenants SET disabled=true WHERE id=(SELECT tenant_id FROM users WHERE id=$1)', [suspendedSession.user.id]);
  await rejects(() => catalogUser(withSession(suspendedSession.token)), 401, '租户停用后会话失效');
  await rejects(() => tenantScope(withSession(suspendedSession.token)), 401, '租户停用后 tenantScope 拒绝');

  // ---- HTTP 路由层：浏览器实际走的那条路 ----
  const origin = 'http://127.0.0.1:3000';
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new NextRequest(`${origin}${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  const routePhone = phones();
  const sendResponse = await sendCodeRoute(post('/api/auth/sms/send', { phone: routePhone }));
  const sendBody = await sendResponse.json() as Record<string, unknown>;
  check(sendResponse.status === 200, '发送验证码接口返回 200');
  check(!('mockCode' in sendBody) && !JSON.stringify(sendBody).includes('code'), '接口响应不泄漏验证码');

  await db.query('DELETE FROM sms_quota WHERE scope=$1', [`phone:${routePhone}`]);
  const routeCode = (await requestPhoneCode({ phone: routePhone })).mockCode!;
  const loginResponse = await phoneLoginRoute(post('/api/auth/sms/login', { phone: routePhone, code: routeCode }));
  check(loginResponse.status === 200, '手机号登录接口返回 200');
  const setCookie = loginResponse.headers.getSetCookie().join('\n');
  check(/catalog_session=[0-9a-f]{64}/u.test(setCookie), '登录下发会话 Cookie');
  check(/Path=\/(;|$)/mu.test(setCookie), 'Cookie 作用域为站点根路径，页面守卫才读得到');
  check(setCookie.includes('HttpOnly'), 'Cookie 为 HttpOnly');
  check(/Path=\/api;\s*Max-Age=0/u.test(setCookie), '同时清除旧的 /api 作用域 Cookie，避免同名双值');

  const routeToken = /catalog_session=([0-9a-f]{64})/u.exec(setCookie)![1];
  const sessionResponse = await sessionRoute(
    new NextRequest(`${origin}/api/auth/session`, { headers: { cookie: `catalog_session=${routeToken}` } }));
  const sessionBody = await sessionResponse.json() as { user: { id: string }; tenant: { internal: boolean; styleQuota: number } };
  check(sessionResponse.status === 200, '会话接口返回当前账号');
  check(sessionBody.tenant.internal === false, '新账号不是内部租户');
  check(sessionBody.tenant.styleQuota === FREE_STYLE_QUOTA, '会话接口返回配额');

  const crossOrigin = await phoneLoginRoute(
    new NextRequest(`${origin}/api/auth/sms/login`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' }));
  check(crossOrigin.status === 403, '跨站来源的登录请求被拒绝');

  const loggedOut = await logoutRoute(
    new NextRequest(`${origin}/api/auth/logout`, { method: 'POST', headers: { origin, cookie: `catalog_session=${routeToken}` } }));
  check(loggedOut.status === 200, '退出登录返回 200');
  await rejects(() => catalogUser(withSession(routeToken)), 401, '退出后会话立即失效');

  // ---- 备份必须带上身份表，否则恢复后没人能登录 ----
  const backup = await backupCatalog();
  const backedUpTenants = backup.payload.tables.tenants as { id: string; workspace: string }[];
  const backedUpIdentities = backup.payload.tables.user_identities as { kind: string; identifier: string }[];
  check(Array.isArray(backedUpTenants) && backedUpTenants.some(t => t.workspace === 'main'), '备份包含 tenants 且含内部租户');
  check(backedUpIdentities.some(i => i.kind === 'email' && i.identifier === 'ops@example.com'), '备份包含邮箱身份');
  check(backedUpIdentities.some(i => i.kind === 'phone' && i.identifier === phone), '备份包含手机号身份');
  check(!('sms_challenges' in backup.payload.tables), '验证码等短期状态不进备份');
  check('tenant_file_refs' in backup.payload.tables, '备份包含文件授权，否则恢复后文件无人拥有');
  check('tenant_usage' in backup.payload.tables, '备份包含用量，否则恢复后配额计数归零');

  // ---- 跨租户隔离：第 3 步的核心验收 ----
  const pngFor = (r: number, g: number, b: number) => sharp({ create: { width: 64, height: 32, channels: 3, background: { r, g, b } } }).png().toBuffer();

  const tenantA = created.tenant.id;                       // 手机号注册出来的外部租户
  const otherPhone = phones();
  await db.query('DELETE FROM sms_quota WHERE scope=$1', [`phone:${otherPhone}`]);
  const otherCode = await requestPhoneCode({ phone: otherPhone });
  const otherSession = await signInWithPhone({ phone: otherPhone, code: otherCode.mockCode! });
  const tenantB = (await tenantScope(withSession(otherSession.token))).tenant.id;
  check(tenantA !== tenantB, '两个外部租户彼此独立');

  // 两个租户各传一款，且【故意用同一个款号】验证唯一约束已按租户隔离
  const a = await importCatalogAsset({ tenantId: tenantA, namespace: 'iso', styleCode: 'SAME-CODE', colorName: '藏青',
    bytes: await pngFor(20, 40, 90), filename: 'a.png', layout: 'front_only', sources: [], provenance: { source: 'test' } });
  const b = await importCatalogAsset({ tenantId: tenantB, namespace: 'iso', styleCode: 'SAME-CODE', colorName: '黑',
    bytes: await pngFor(10, 10, 10), filename: 'b.png', layout: 'front_only', sources: [], provenance: { source: 'test' } });
  check(a.variantId !== b.variantId, '同款号在两个租户下各自建款，唯一约束已按租户隔离');

  const listA = await listCatalogStyles({}, tenantA);
  const listB = await listCatalogStyles({}, tenantB);
  check(listA.items.length === 1 && listB.items.length === 1, '各自只看到自己的款');
  check(listA.items[0].id !== listB.items[0].id, '列表返回的款式互不相同');

  const styleAId = listA.items[0].id;
  await rejects(() => catalogStyle(styleAId, tenantB), 404, 'B 用 A 的款式 ID 读取 → 404');
  await rejects(() => catalogDetail(a.variantId, a.assetVersionId, tenantB), 404, 'B 用 A 的颜色款 ID 读取 → 404');
  check((await allCatalogStyles(tenantB)).every(style => style.id !== styleAId), 'allCatalogStyles 不跨租户');

  // 内部租户（WPS 交付）同样看不到外部租户的数据
  const internalStyles = await allCatalogStyles(INTERNAL_TENANT_ID);
  check(internalStyles.every(style => style.id !== styleAId), '内部租户看不到外部租户的款式');

  // 文件授权：上传即登记引用，且只登记给上传方
  const refs = await db.query(
    `SELECT DISTINCT r.tenant_id FROM tenant_file_refs r
      JOIN garment_asset_versions av ON av.file_id=r.file_id WHERE av.id=$1`, [a.assetVersionId]);
  check(refs.rowCount === 1 && refs.rows[0].tenant_id === tenantA, '上传的文件只登记给上传方租户');

  // ---- 配额：原子预约、按实际结算、超限拒绝、过期回收 ----
  const usageA = await tenantUsage(tenantA);
  check(usageA.styleCount === 1, '上传一款后款数计为 1');
  check(usageA.bytesUsed > 0, '上传后占用字节被记账');
  check(usageA.bytesReserved === 0 && usageA.styleReserved === 0, '结算后预约额度已归零');

  // 同一租户重复传同一张图：文件去重，不重复计容量
  const bytesBefore = (await tenantUsage(tenantA)).bytesUsed;
  await importCatalogAsset({ tenantId: tenantA, namespace: 'iso', styleCode: 'SAME-CODE', colorName: '藏青',
    bytes: await pngFor(20, 40, 90), filename: 'a.png', layout: 'front_only', sources: [], provenance: { source: 'test' } });
  check((await tenantUsage(tenantA)).bytesUsed === bytesBefore, '重复上传同一文件不重复计容量');

  // 款数配额：免费版 5 款，传满后第 6 款被拒
  for (let n = 2; n <= FREE_STYLE_QUOTA; n += 1) {
    await importCatalogAsset({ tenantId: tenantA, namespace: 'iso', styleCode: `Q-${n}`, colorName: '白',
      bytes: await pngFor(n * 7, 90, 120), filename: `q${n}.png`, layout: 'front_only', sources: [], provenance: { source: 'test' } });
  }
  check((await tenantUsage(tenantA)).styleCount === FREE_STYLE_QUOTA, `已用满 ${FREE_STYLE_QUOTA} 款配额`);
  const overflowBytes = await pngFor(3, 3, 3);
  await rejects(() => importCatalogAsset({ tenantId: tenantA, namespace: 'iso', styleCode: 'Q-OVER', colorName: '白',
    bytes: overflowBytes, filename: 'over.png', layout: 'front_only', sources: [], provenance: { source: 'test' } }),
    413, '超出款数配额的上传被拒绝');
  check((await tenantUsage(tenantA)).styleReserved === 0, '被拒绝的上传不残留预约额度');

  // 并发预约不能突破上限（先查后写会漏）
  const concurrentTenant = tenantB;
  const quotaB = await tenantUsage(concurrentTenant);
  const room = quotaB.styleQuota - quotaB.styleCount;
  const races = await Promise.allSettled(Array.from({ length: room + 3 }, (_, n) =>
    catalogTransaction(client => reserveQuota(client, { id: `race-${n}`, tenantId: concurrentTenant, styles: 1 }))));
  check(races.filter(r => r.status === 'fulfilled').length === room, `并发预约恰好成功 ${room} 次，未突破上限`);

  // 过期回收：没完成的上传不能永久占着额度
  await db.query("UPDATE quota_reservations SET expires_at = now() - interval '1 hour' WHERE state='reserved' AND tenant_id=$1", [concurrentTenant]);
  const swept = await sweepExpiredReservations();
  check(swept >= room, `过期预约被回收（${swept} 条）`);
  check((await tenantUsage(concurrentTenant)).styleReserved === 0, '回收后冻结额度归零');

  // 幂等：重复结算/释放只报告状态，不重复搬数字
  const idempotent = 'idem-1';
  await catalogTransaction(client => reserveQuota(client, { id: idempotent, tenantId: concurrentTenant, bytes: 1024 }));
  await settleQuota(idempotent, concurrentTenant, { bytes: 1024 });
  const usedOnce = (await tenantUsage(concurrentTenant)).bytesUsed;
  const settledAgain = await settleQuota(idempotent, concurrentTenant, { bytes: 1024 });
  check(settledAgain.state === 'committed', '重复结算返回已处理状态');
  check((await tenantUsage(concurrentTenant)).bytesUsed === usedOnce, '重复结算不重复计账');
  await rejects(() => releaseQuota(idempotent, tenantA), 403, '用错租户释放预约被拒绝');

  // ---- 第 4 步：文件授权 ----
  const fileOfA = await db.query('SELECT file_id, thumbnail_file_id FROM garment_asset_versions WHERE id=$1', [a.assetVersionId]);
  const fileId = fileOfA.rows[0].file_id as string;
  const thumbId = fileOfA.rows[0].thumbnail_file_id as string;

  check(await canAccessFile(fileId, tenantA), 'A 能访问自己上传的文件');
  check(await canAccessFile(thumbId, tenantA), '缩略图同样登记了引用');
  await rejects(() => assertFileAccess(fileId, tenantB), 404, 'B 拿 A 的文件 ID 访问 → 404（而非 403，避免确认存在性）');
  await rejects(() => assertFileAccess(fileId, INTERNAL_TENANT_ID), 404, '内部租户也拿不到外部租户的文件');

  // HTTP 层：拿到别人的文件 UUID 也读不出来
  const fileRequest = (id: string, token: string) =>
    new NextRequest(`${origin}/api/catalog/files/${id}`, { headers: { cookie: `catalog_session=${token}` } });
  const ownerRead = await catalogFileRoute(fileRequest(fileId, signedIn.token), { params: Promise.resolve({ id: fileId }) });
  check(ownerRead.status === 200 || ownerRead.status === 302, '文件所有者可读取');
  const strangerRead = await catalogFileRoute(fileRequest(fileId, otherSession.token), { params: Promise.resolve({ id: fileId }) });
  check(strangerRead.status === 404, '非所有者通过 HTTP 读取同一文件 → 404');

  // 旧入口已退役

  // ---- 第 5 步：积分 ----
  const prices = await currentPrices();
  check(prices.prices.length === 11, '单价表含十一个计费动作（抠图拆成美图与火山，背面参考、电商主图策划、出图与学版式单独计价）');
  check(prices.prices.find(p => p.action === 'listing_layout')?.userMicroCents === 99_990, '电商主图学一个新版式 100 积分');
  check(prices.prices.find(p => p.action === 'listing_image')?.userMicroCents === 44_000 && prices.prices.find(p => p.action === 'listing_image_multi')?.userMicroCents === 72_000, '电商主图单张 44 积分、多色图 72 积分（成本 × 2）');
  check(prices.prices.find(p => p.action === 'listing_plan')?.userMicroCents === 180_000, '电商主图读商品与策划按成本 ¥0.90 × 2 = 180 积分');
  const gen = prices.prices.find(p => p.action === 'generate')!;
  check(gen.userMicroCents === Math.ceil(gen.costMicroCents * gen.multiplierMilli / 1000), '售价 = 成本 × 倍率，整数运算');

  // 冻结上限：三条路线互斥，不是串行
  const generateCeiling = ceilingMicroCents(prices, { route: 'generate' });
  const enhanceCeiling = ceilingMicroCents(prices, { route: 'enhance' });
  const cutoutOnly = prices.prices.find(p => p.action === 'cutout')!.userMicroCents;
  check(generateCeiling === gen.userMicroCents + cutoutOnly, '生图上限 = 生图 + 最多一次抠图');
  check(enhanceCeiling < generateCeiling, '放大路线比生图便宜，说明没有把三条路线叠加');

  // 新账号余额为 0：任何付费动作直接拒绝
  const payer = created.tenant.id;
  check((await creditBalance(payer)).balanceCents === 0, '新账号初始余额为 0');
  const ceilingCents = microToCents(generateCeiling);
  await rejects(() => catalogTransaction(client => holdCredits(client, {
    id: 'h-nofunds', tenantId: payer, kind: 'production', jobRef: 'job-1',
    billingMode: 'charge', amountCents: ceilingCents, snapshot: prices,
  })), 402, '余额为 0 时冻结被拒（免费内测防刷的主闸门）');

  await grantCredits(payer, 1000, '内测额度', adminId);
  check((await creditBalance(payer)).balanceCents === 1000, '管理员发放后余额到账');

  // 正常路径：按上限冻结 → 按实际动作结算 → 差额退回
  await catalogTransaction(client => holdCredits(client, {
    id: 'h-ok', tenantId: payer, kind: 'production', jobRef: 'job-ok',
    billingMode: 'charge', amountCents: ceilingCents, snapshot: prices }));
  const afterHold = await creditBalance(payer);
  check(afterHold.heldCents === ceilingCents && afterHold.balanceCents === 1000 - ceilingCents, '冻结从余额移到冻结额');
  // 实际只跑了生图，没有抠图
  const settled = await settleHold('h-ok', payer, [{ action: 'generate', billable: true, certain: true, attemptId: 'att-1' }]);
  check(settled.state === 'settled', '全部确定时直接结算');
  const afterSettle = await creditBalance(payer);
  check(afterSettle.heldCents === 0, '结算后冻结归零');
  check(afterSettle.balanceCents === 1000 - microToCents(gen.userMicroCents), '只扣实际发生的生图，抠图部分退回');

  // 确定失败：全额退回
  await catalogTransaction(client => holdCredits(client, {
    id: 'h-fail', tenantId: payer, kind: 'production', jobRef: 'job-fail',
    billingMode: 'charge', amountCents: ceilingCents, snapshot: prices }));
  const beforeRelease = (await creditBalance(payer)).balanceCents;
  await releaseHold('h-fail', payer, '供应商 4xx，确定未产生费用');
  check((await creditBalance(payer)).balanceCents === beforeRelease + ceilingCents, '确定失败全额退回');

  // 结果未知：既不自动退也不自动扣
  await catalogTransaction(client => holdCredits(client, {
    id: 'h-unknown', tenantId: payer, kind: 'production', jobRef: 'job-unknown',
    billingMode: 'charge', amountCents: ceilingCents, snapshot: prices }));
  const disputed = await settleHold('h-unknown', payer, [
    { action: 'generate', billable: true, certain: true, attemptId: 'att-2' },
    { action: 'cutout', billable: true, certain: false, attemptId: 'att-3' },
  ]);
  check(disputed.state === 'disputed', '存在未知调用时转入待裁定');
  check((await creditBalance(payer)).heldCents === ceilingCents, '待裁定期间冻结保持不动');
  const pending = await openHolds(0);
  check(pending.some(h => h.id === 'h-unknown' && h.state === 'disputed'), '待裁定进入管理员队列');

  // 人工裁定：可以从 disputed 转终态（v3 的死胡同）
  const ruled = await adjudicateHold('h-unknown', payer, 'refund', adminId);
  check(ruled.state === 'settled' && ruled.settledCents === microToCents(gen.userMicroCents), '裁定退回未知部分，已确认部分照收');
  check((await creditBalance(payer)).heldCents === 0, '裁定后冻结释放');

  // 幂等与越权
  check((await settleHold('h-ok', payer, [])).alreadyResolved === true, '重复结算只报告状态');
  await rejects(() => settleHold('h-ok', tenantB, []), 403, '用错租户结算被拒绝');
  await rejects(() => catalogTransaction(client => holdCredits(client, {
    id: 'h-ok', tenantId: payer, kind: 'production', jobRef: '别的任务',
    billingMode: 'charge', amountCents: ceilingCents, snapshot: prices })), 409, '同编号对应不同请求被拒绝');

  // 舍入：两个各 0.4 分的动作合计不得超过冻结的 1 分
  const half = { takenAt: prices.takenAt, unit: 'micro_cents' as const, rounding: 'ceil_at_settlement' as const,
    prices: prices.prices.map(p => ({ ...p, userMicroCents: 400 })) };
  await catalogTransaction(client => holdCredits(client, {
    id: 'h-round', tenantId: payer, kind: 'production', jobRef: 'job-round',
    billingMode: 'charge', amountCents: 1, snapshot: half }));
  const rounded = await settleHold('h-round', payer, [
    { action: 'generate', billable: true, certain: true, attemptId: 'att-4' },
    { action: 'cutout', billable: true, certain: true, attemptId: 'att-5' },
  ]);
  check(rounded.confirmedCents === 1, '两个 0.4 分动作合计取整为 1 分，未超出冻结额');

  // 内部租户免计费：WPS 交付不受影响
  const internalBefore = await creditBalance(INTERNAL_TENANT_ID);
  await catalogTransaction(client => holdCredits(client, {
    id: 'h-internal', tenantId: INTERNAL_TENANT_ID, kind: 'analysis', jobRef: 'wps-case',
    billingMode: 'exempt', amountCents: 9999, snapshot: prices }));
  const internalAfter = await creditBalance(INTERNAL_TENANT_ID);
  check(internalAfter.balanceCents === internalBefore.balanceCents && internalAfter.heldCents === internalBefore.heldCents,
    '免计费租户余额为 0 也能冻结，且不动账户（WPS 自动链路不会停摆）');
  await settleHold('h-internal', INTERNAL_TENANT_ID, [{ action: 'analyze', billable: true, certain: true, attemptId: 'att-6' }]);
  check((await creditBalance(INTERNAL_TENANT_ID)).balanceCents === internalBefore.balanceCents, '免计费租户结算也不动账户');

  // 用量事件：为将来接 Lago 预留
  const events = await db.query('SELECT metric_code, idempotency_key FROM usage_events WHERE tenant_id=$1', [payer]);
  check(events.rowCount! > 0, '结算时写入用量事件');
  check(events.rows.every(r => r.idempotency_key), '每条事件都有幂等键（Lago 的 transaction_id）');

  // ---- 第 6 步：账户与管理后台接口 ----
  const accountResponse = await accountRoute(
    new NextRequest(`${origin}/api/account`, { headers: { cookie: `catalog_session=${signedIn.token}` } }));
  const accountBody = await accountResponse.json() as { balance: { balanceCents: number }; quota: { styleQuota: number }; ledger: unknown[] };
  check(accountResponse.status === 200, '账户接口返回 200');
  check(accountBody.quota.styleQuota === FREE_STYLE_QUOTA, '账户接口返回配额');
  check(Array.isArray(accountBody.ledger) && accountBody.ledger.length > 0, '账户接口返回消耗流水');
  check(!JSON.stringify(accountBody).includes('costEstimate'), '账户接口不向用户暴露成本');

  // 管理后台：只有平台管理员能进
  const adminRequest = (token: string) =>
    new NextRequest(`${origin}/api/admin/tenants`, { headers: { cookie: `catalog_session=${token}` } });
  check((await adminTenantsRoute(adminRequest(signedIn.token))).status === 403, '普通租户访问管理后台 → 403');
  const adminList = await adminTenantsRoute(adminRequest(adminLogin.token));
  check(adminList.status === 200, '管理员可读租户列表');
  const adminBody = await adminList.json() as { tenants: { id: string; workspace: string }[] };
  check(adminBody.tenants.some(t => t.workspace === 'main'), '列表含内部租户');
  check(adminBody.tenants.length >= 3, '列表含全部租户');

  // 发放接口同样限管理员
  const grantRequest = (token: string, body: unknown) =>
    new NextRequest(`${origin}/api/admin/grant`, { method: 'POST', headers: { origin, cookie: `catalog_session=${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  check((await adminGrantRoute(grantRequest(signedIn.token, { tenantId: payer, amountCents: 100, reason: '越权尝试' }))).status === 403,
    '普通租户调用发放接口 → 403');
  const balanceBeforeGrant = (await creditBalance(payer)).balanceCents;
  const granted = await adminGrantRoute(grantRequest(adminLogin.token, { tenantId: payer, amountCents: 500, reason: '追加内测额度' }));
  check(granted.status === 200, '管理员发放成功');
  check((await creditBalance(payer)).balanceCents === balanceBeforeGrant + 500, '发放后余额增加');
  const grantLedger = await db.query("SELECT operator_id, reason FROM credit_ledger WHERE tenant_id=$1 AND kind='grant' ORDER BY created_at DESC LIMIT 1", [payer]);
  check(grantLedger.rows[0].operator_id === adminId, '流水记录了操作人');
  check(grantLedger.rows[0].reason === '追加内测额度', '流水记录了原因');

  // ---- 交付保护：任何新租户都不得占用 main ----
  const workspaces = await db.query("SELECT count(*)::int AS n FROM tenants WHERE workspace='main'");
  check(workspaces.rows[0].n === 1, '全库只有一个 main 工作区');

  await closeCatalogDatabase();
  console.log(`✓ 租户与登录集成测试通过：${checks} 项`);
} finally {
  await database.stop();
  await rm(root, { recursive: true, force: true });
}
