import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiResponseError, assertApiResponse, fetchApi, imageFailureReason, readApiJson, readApiPayload } from './api-response';

afterEach(() => vi.unstubAllGlobals());
describe('workbench error responses', () => {
  it.each([
    [500, '无法确定衣身宽度，请在素材库核对左右腋点后更新位置标准'],
    [409, '原表需求已更新，请同步后重试'],
    [422, '这版图案尚未确认，不能导出'],
    [502, '抠图服务拒绝处理：图片尺寸超出范围'],
  ])('retains any server reason for HTTP %i', async (status, error) => {
    await expect(readApiJson(Response.json({ error }, { status }))).rejects.toMatchObject({ message: error, status });
  });
  it('keeps authorization and saved-state metadata', async () => {
    const body = { error: 'WPS 需要重新授权', authorizeUrl: '/api/wps/oauth/start', state: { revision: 2 } };
    await expect(readApiJson(Response.json(body, { status: 401 }))).rejects.toMatchObject({ authorizeUrl: body.authorizeUrl, body });
  });
  it.each(['<html>Gateway Timeout</html>', '', '{broken'])('handles non-JSON failures without replacing them with parser errors', async body => {
    await expect(readApiJson(new Response(body, { status: 504 }), '读取预览失败')).rejects.toThrow('读取预览失败：服务器响应超时（HTTP 504）');
  });
  it.each([{ error: {} }, { error: ' ' }, null])('uses status when no usable reason was returned: %j', async body => {
    await expect(readApiJson(Response.json(body, { status: 503 }))).rejects.toThrow('HTTP 503');
  });
  it('does not consume a successful image body', async () => {
    const response = new Response('image', { headers: { 'Content-Type': 'image/png' } });
    await assertApiResponse(response);
    expect(await response.text()).toBe('image');
  });
  it('keeps failure receipts available to domain-specific recovery', async () => {
    const body = { error: '抠图未完成', candidate: { url: '/candidate' } };
    expect(await readApiPayload(Response.json(body, { status: 502 }))).toEqual(body);
  });
  it('rejects an unreadable success response', async () => {
    await expect(readApiJson(new Response('<html>login</html>'))).rejects.toBeInstanceOf(ApiResponseError);
  });
  it('preserves network details without retrying a save', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchApi('/save', { method: 'POST' })).rejects.toThrow('未收到服务器响应：Failed to fetch');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('preserves cancellation identity so obsolete requests stay silent', async () => {
    const abort = new AbortController(); abort.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort.signal.reason));
    await expect(fetchApi('/read', { signal: abort.signal })).rejects.toBe(abort.signal.reason);
  });
  it('reads the concrete reason hidden by a failed image element', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: '图片文件已失效，请重新上传' }, { status: 410 })));
    expect(await imageFailureReason('/api/production-files/example')).toBe('图片文件已失效，请重新上传');
  });
  it('does not probe signed external image URLs or invent an HTTP failure', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect(await imageFailureReason('https://images.example/image.png?signature=example')).toContain('浏览器未提供具体原因');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('distinguishes a broken response download from invalid JSON', async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')); } });
    await expect(readApiJson(new Response(body))).rejects.toThrow('读取服务器响应中断（HTTP 200）；terminated');
  });
});
