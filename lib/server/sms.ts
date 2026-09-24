import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';

export const PHONE_PATTERN = /^1[3-9]\d{9}$/u;
export const CODE_TTL_SECONDS = 5 * 60;
export const MAX_CODE_ATTEMPTS = 5;

/**
 * Application limits are at least as strict as Aliyun's own defaults
 * (1/minute, 5/hour, 10/day per signature and number), so callers hit our message
 * rather than the provider's error code.
 */
export const SEND_LIMITS = [
  { window: 60, limit: 1, scope: 'phone' },
  { window: 3600, limit: 5, scope: 'phone' },
  { window: 86400, limit: 10, scope: 'phone' },
  { window: 3600, limit: 20, scope: 'ip' },
  { window: 3600, limit: 500, scope: 'global' },
] as const;

export type SmsSendResult = {
  state: 'accepted' | 'failed' | 'unknown';
  providerBizId?: string;
  providerCode?: string;
  message?: string;
  /** Only set by the mock provider, which is rejected in production. Never sent to a client. */
  mockCode?: string;
};

export const newVerificationCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function hashVerificationCode(code: string, phone: string, purpose: string) {
  const pepper = process.env.SMS_PEPPER?.trim();
  if (!pepper || pepper.length < 16) throw new Error('SMS_PEPPER 未配置或过短（至少 16 字符）');
  return createHash('sha256').update(`${code}|${phone}|${purpose}|${pepper}`).digest('hex');
}

function smsProvider() {
  const provider = process.env.SMS_PROVIDER?.trim() || 'mock';
  if (provider === 'mock' && process.env.NODE_ENV === 'production') {
    throw new Error('生产环境禁止 SMS_PROVIDER=mock');
  }
  if (!['mock', 'aliyun'].includes(provider)) throw new Error(`未知的短信提供方：${provider}`);
  return provider as 'mock' | 'aliyun';
}

// Aliyun RPC signature (HMAC-SHA1). Called over plain fetch like every other provider in
// this repo, so no SDK dependency is introduced.
const rpcEncode = (value: string) =>
  encodeURIComponent(value).replace(/\+/gu, '%20').replace(/\*/gu, '%2A').replace(/%7E/gu, '~');

function signedSmsUrl(params: Record<string, string>, accessKeySecret: string) {
  const canonical = Object.keys(params).sort()
    .map(key => `${rpcEncode(key)}=${rpcEncode(params[key])}`).join('&');
  const stringToSign = `POST&${rpcEncode('/')}&${rpcEncode(canonical)}`;
  const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
  return `Signature=${rpcEncode(signature)}&${canonical}`;
}

/**
 * `Code === 'OK'` means the request was accepted, not that the message was delivered.
 * The API offers no send idempotency, so a timeout is reported as `unknown` and must be
 * reconciled by reading the receipt rather than retried blindly.
 */
async function sendThroughAliyun(phone: string, code: string): Promise<SmsSendResult> {
  const accessKeyId = process.env.ALIYUN_SMS_ACCESS_KEY_ID?.trim();
  const accessKeySecret = process.env.ALIYUN_SMS_ACCESS_KEY_SECRET?.trim();
  const signName = process.env.SMS_SIGN_NAME?.trim();
  const templateCode = process.env.SMS_TEMPLATE_CODE?.trim();
  if (!accessKeyId || !accessKeySecret || !signName || !templateCode) {
    throw new Error('阿里云短信未配置完整：需要 ALIYUN_SMS_ACCESS_KEY_ID / _SECRET / SMS_SIGN_NAME / SMS_TEMPLATE_CODE');
  }
  const body = signedSmsUrl({
    AccessKeyId: accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: process.env.ALIYUN_SMS_REGION?.trim() || 'cn-hangzhou',
    SignName: signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
    Version: '2017-05-25',
  }, accessKeySecret);

  let raw: string;
  try {
    const response = await fetch('https://dysmsapi.aliyuncs.com/', {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body, signal: AbortSignal.timeout(15000),
    });
    raw = await response.text();
    if (raw.includes(accessKeySecret)) throw new Error('响应含敏感配置，未保存');
  } catch (error) {
    // No definite receipt: the message may or may not have been sent and charged.
    return { state: 'unknown', message: error instanceof Error ? error.message : String(error) };
  }

  let parsed: { Code?: string; BizId?: string; Message?: string };
  try { parsed = JSON.parse(raw) as typeof parsed; }
  catch { return { state: 'unknown', message: '阿里云返回了无法解析的内容' }; }

  const providerCode = parsed.Code ?? 'unknown';
  if (providerCode === 'OK') return { state: 'accepted', providerBizId: parsed.BizId, providerCode };
  // Client-side rejections are definite; anything else may still have been charged.
  const definite = ['isv.MOBILE_NUMBER_ILLEGAL', 'isv.BUSINESS_LIMIT_CONTROL', 'isv.SMS_SIGNATURE_ILLEGAL', 'isv.SMS_TEMPLATE_ILLEGAL'];
  return { state: definite.includes(providerCode) ? 'failed' : 'unknown', providerCode, message: parsed.Message };
}

export async function sendVerificationCode(phone: string, code: string): Promise<SmsSendResult> {
  if (!PHONE_PATTERN.test(phone)) throw new Error('手机号格式无效');
  if (smsProvider() === 'mock') {
    console.log(`[sms:mock] ${phone} 验证码 ${code}（${CODE_TTL_SECONDS / 60} 分钟内有效）`);
    return { state: 'accepted', providerBizId: 'mock', mockCode: code };
  }
  return sendThroughAliyun(phone, code);
}

/** Aliyun error codes that mean the account cannot send at all — an operations incident. */
export const isSmsServiceOutage = (providerCode?: string) =>
  providerCode === 'isv.OUT_OF_SERVICE' || providerCode === 'isv.AMOUNT_NOT_ENOUGH';
