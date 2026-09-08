import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { meituCutoutClient, submitMeituCutout, MeituSubmissionNotStartedError } from './meitu-cutout';

beforeEach(() => {
  vi.stubEnv('MEITU_OPENAPI_ACCESS_KEY', 'test-access');
  vi.stubEnv('MEITU_OPENAPI_SECRET_KEY', 'test-secret');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('uses the real CLI transport contract with no home-directory reads or writes', async () => {
  const prototype = Object.getPrototypeOf(meituCutoutClient());
  const transport = vi.spyOn(prototype, 'rawRequest').mockResolvedValue({ code: 0, data: { task_id: 'task-1' } });
  const read = vi.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('fresh serverless instance'), { code: 'ENOENT' }));
  const mkdir = vi.spyOn(fs, 'mkdir').mockRejectedValue(Object.assign(new Error('home is not writable'), { code: 'EROFS' }));
  const result = await submitMeituCutout('https://test.stariidata.com/input.png', 'request-1');
  expect(result.data?.task_id).toBe('task-1');
  expect(transport).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  expect(mkdir).not.toHaveBeenCalled();
  const [, , payload, options] = transport.mock.calls[0];
  expect(payload).toMatchObject({ request_id: 'request-1', trace_id: 'request-1' });
  const headers = (options as { headers: Record<string, string> }).headers;
  expect(headers['X-Request-ID']).toBe('request-1');
  const identity = JSON.parse(Buffer.from(headers['x-mtcc-client'], 'base64').toString());
  expect(identity.gnum).toMatch(/^[a-f0-9-]{36}$/u);
});

it('distinguishes SDK preparation failure from an uncertain network submission', async () => {
  const prototype = Object.getPrototypeOf(meituCutoutClient());
  const transport = vi.spyOn(prototype, 'rawRequest').mockRejectedValue(new Error('network timeout'));
  const prepare = vi.spyOn(prototype, 'mcpPassthroughState').mockRejectedValueOnce(new Error('SDK context failed'));
  await expect(submitMeituCutout('https://test.stariidata.com/input.png', 'request-1')).rejects.toBeInstanceOf(MeituSubmissionNotStartedError);
  expect(transport).not.toHaveBeenCalled();
  prepare.mockRestore();
  await expect(submitMeituCutout('https://test.stariidata.com/input.png', 'request-2')).rejects.toThrow('network timeout');
  expect(transport).toHaveBeenCalledOnce();
});
