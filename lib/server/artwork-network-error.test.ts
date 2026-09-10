import { expect, it, vi } from 'vitest';
import { artworkInspectionFailure, artworkNetworkFailure, withArtworkNetworkContext } from './artwork-network-error';

it('explains inspection failures and persisted network reasons without leaking upstream responses', () => {
  expect(artworkInspectionFailure(new TypeError('fetch failed'))).toContain('网络请求失败');
  expect(artworkInspectionFailure(new Error('内容核对未完成：连接被中途断开。'))).toContain('连接被中途断开');
  expect(artworkInspectionFailure(new Error('任务分析模型处理超时（120 秒）：图案修改逐项核对'))).toContain('120 秒');
  expect(artworkInspectionFailure(new SyntaxError('bad JSON: token=secret'))).toContain('无法解析');
  expect(artworkInspectionFailure(new Error('HTTP 429 https://private.test?token=secret'))).toBe('内容核对服务请求过多（HTTP 429）。');
  expect(artworkInspectionFailure(new Error('unexpected private upstream response'))).not.toContain('private');
});

it('explains nested and aggregate transport causes without exposing credentials or URLs', () => {
  const cause = Object.assign(new Error('https://signed.example/?token=private'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  const error = new TypeError('fetch failed', { cause: new AggregateError([cause]) });
  expect(artworkNetworkFailure(error, '检查原图清晰度')).toEqual({ stage: '检查原图清晰度', codes: ['UND_ERR_CONNECT_TIMEOUT'], message: '检查原图清晰度未完成：连接服务超时。' });
  expect(JSON.stringify(artworkNetworkFailure(error))).not.toContain('private');
});

it('preserves the specific service stage and original cause without retrying a request', async () => {
  const original = new TypeError('fetch failed', { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) });
  const work = vi.fn().mockRejectedValue(original);
  const error = await withArtworkNetworkContext('MediaKit 上传图片', work).catch(error => error);
  expect(work).toHaveBeenCalledOnce();
  expect(error).toHaveProperty('cause', original);
  expect(artworkNetworkFailure(error, '图案处理')?.message).toBe('MediaKit 上传图片未完成：连接被中途断开。');
});

it('keeps an unknown connection failure explicit and leaves business errors unchanged', async () => {
  expect(artworkNetworkFailure(new TypeError('fetch failed'))?.message).toContain('未取得更具体');
  expect(artworkNetworkFailure(new DOMException('operation timed out', 'TimeoutError'))?.message).toContain('响应超时');
  const error = new Error('图片缺少主体');
  expect(artworkNetworkFailure(error)).toBeNull();
  await expect(withArtworkNetworkContext('去除背景', async () => { throw error; })).rejects.toBe(error);
});
