import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { CatalogHttpError } from './catalog-auth';

export const EMAIL_CODE_TTL = 300;
export function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/u.test(email))
    throw new CatalogHttpError(400, '请输入有效的邮箱地址');
  return email;
}
export const newEmailCode = () => String(randomInt(1_000_000)).padStart(6, '0');
export type EmailPurpose = 'register' | 'reset' | 'setup';
export function emailCodeHash(email: string, code: string, purpose: EmailPurpose) {
  const pepper = process.env.EMAIL_PEPPER?.trim();
  if (!pepper || pepper.length < 32) throw new Error('EMAIL_PEPPER 未配置完整');
  return createHmac('sha256', pepper).update(`${email}|${purpose}|${code}`).digest('hex');
}
export function emailConfiguration() {
  const provider = process.env.EMAIL_PROVIDER?.trim() || 'mock';
  if (provider === 'mock') {
    if (process.env.NODE_ENV === 'production') throw new Error('生产环境禁止模拟邮件');
    return { provider } as const;
  }
  if (provider !== 'aliyun') throw new Error('邮件提供方配置无效');
  const id = process.env.ALIYUN_EMAIL_ACCESS_KEY_ID?.trim();
  const secret = process.env.ALIYUN_EMAIL_ACCESS_KEY_SECRET?.trim();
  const sender = process.env.EMAIL_FROM?.trim();
  if (!id || !secret || !sender) throw new Error('阿里云邮件服务配置不完整');
  return { provider, id, secret, sender: normalizeEmail(sender) } as const;
}
export type EmailSendResult = { state: 'accepted' | 'failed' | 'unknown'; providerId?: string; providerCode?: string; mockCode?: string };
const encode = (value: string) => encodeURIComponent(value).replace(/\*/gu, '%2A').replace(/%7E/gu, '~');
export async function sendEmailCode(email: string, code: string, purpose: EmailPurpose): Promise<EmailSendResult> {
  const config = emailConfiguration();
  if (config.provider === 'mock') return { state: 'accepted', providerId: 'mock', mockCode: code };
  const params: Record<string, string> = {
    AccessKeyId: config.id, Action: 'SingleSendMail', Version: '2015-11-23', Format: 'JSON',
    RegionId: 'cn-hangzhou', SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0', SignatureNonce: randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'), AccountName: config.sender,
    AddressType: '1', ReplyToAddress: 'false', ToAddress: normalizeEmail(email), FromAlias: 'MockFits',
    Subject: `MockFits ${purpose === 'register' ? '注册' : purpose === 'reset' ? '重置密码' : '设置密码'}验证码`,
    TextBody: `你正在${purpose === 'register' ? '注册 MockFits 账号' : purpose === 'reset' ? '重置 MockFits 账号密码' : '为 MockFits 账号设置密码'}。验证码是 ${code}，5 分钟内有效。请勿向他人透露。如非本人操作，请忽略本邮件。`,
  };
  const canonical = Object.keys(params).sort().map(key => `${encode(key)}=${encode(params[key])}`).join('&');
  const signature = createHmac('sha1', `${config.secret}&`).update(`POST&${encode('/')}&${encode(canonical)}`).digest('base64');
  try {
    const response = await fetch('https://dm.aliyuncs.com/', { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `Signature=${encode(signature)}&${canonical}`,
      signal: AbortSignal.timeout(15000) });
    const result = await response.json() as { EnvId?: string; RequestId?: string; Code?: string };
    if (response.ok && result.EnvId && !result.Code) return { state: 'accepted', providerId: result.EnvId };
    return { state: response.status >= 400 && response.status < 500 ? 'failed' : 'unknown', providerCode: result.Code?.slice(0, 120) };
  } catch { return { state: 'unknown' }; } // Never retry a send with an uncertain receipt.
}
