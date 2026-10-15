import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CatalogHttpError } from './catalog-auth';
import { catalogError } from './catalog-http';

afterEach(() => vi.restoreAllMocks());

it('hides an unplanned error behind a reference and logs the detail', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = catalogError(new Error('数据库连接超时：10.0.0.5:5432'));
  expect(response.status).toBe(500);
  const { error } = await response.json();
  expect(error).toMatch(/^服务暂时出错，请稍后重试（编号 [0-9a-f]{8}）$/);
  expect(error).not.toContain('10.0.0.5');
  expect(log).toHaveBeenCalledWith('[api]', error.match(/[0-9a-f]{8}/)[0], expect.any(Error));
});

it('keeps the message the code meant for the user, 5xx included', async () => {
  const response = catalogError(new CatalogHttpError(503, '短信登录暂不可用，请使用邮箱登录'));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: '短信登录暂不可用，请使用邮箱登录' });
});

it('reports invalid input as a 400 with the field', async () => {
  const parsed = z.object({ phone: z.string().min(11) }).safeParse({ phone: '1' });
  const response = catalogError(parsed.error);
  expect(response.status).toBe(400);
  expect((await response.json()).error).toMatch(/^phone: /);
});

it('treats a thrown non-Error the same as an unplanned error', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = catalogError('postgres://app:secret@db');
  expect(response.status).toBe(500);
  expect((await response.json()).error).not.toContain('secret');
});
