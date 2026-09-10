import { createHash } from 'node:crypto';

/** Hash the actual representation, including derived geometry/worker status. */
export function conditionalJson(value: unknown, request?: Request) {
  const body = JSON.stringify(value);
  const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
  const headers = { ETag: etag, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-cache', Vary: 'Cookie' };
  const matches = request?.headers.get('if-none-match')?.split(',').some(candidate => candidate.trim().replace(/^W\//u, '') === etag);
  return new Response(matches ? null : body, { status: matches ? 304 : 200, headers });
}
