import { createHmac, createHash } from 'crypto';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmacSHA256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function hmacSHA256Hex(key: Buffer | string, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

export interface VolcengineRequestOptions {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function signVolcengineRequest(opts: VolcengineRequestOptions): Record<string, string> {
  const now = new Date();
  const dateStr = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:\-]/g, '');
  const shortDate = dateStr.slice(0, 8);

  const sortedQuery = Object.keys(opts.query)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(opts.query[k])}`)
    .join('&');

  const bodyHash = sha256Hex(opts.body);

  const signedHeadersMap: Record<string, string> = {
    'x-content-sha256': bodyHash,
    'x-date': dateStr,
  };

  const signedHeaderKeys = Object.keys(signedHeadersMap).sort().join(';');
  const canonicalHeaders = Object.keys(signedHeadersMap)
    .sort()
    .map(k => `${k}:${signedHeadersMap[k]}`)
    .join('\n') + '\n';

  const canonicalRequest = [
    opts.method.toUpperCase(),
    opts.path,
    sortedQuery,
    canonicalHeaders,
    signedHeaderKeys,
    bodyHash,
  ].join('\n');

  const credentialScope = `${shortDate}/${opts.region}/${opts.service}/request`;
  const stringToSign = [
    'HMAC-SHA256',
    dateStr,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = hmacSHA256(
    hmacSHA256(
      hmacSHA256(
        hmacSHA256(opts.secretAccessKey, shortDate),
        opts.region
      ),
      opts.service
    ),
    'request'
  );

  const signature = hmacSHA256Hex(signingKey, stringToSign);

  const authorization = `HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderKeys}, Signature=${signature}`;

  return {
    'X-Date': dateStr,
    'X-Content-Sha256': bodyHash,
    Authorization: authorization,
  };
}
