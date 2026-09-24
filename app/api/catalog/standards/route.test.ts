import { beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { tenantScope } from '@/lib/server/tenant-scope';
import { savePlacementStandard, savePlacementStandardBatch } from '@/lib/server/catalog-repository';
vi.mock('@/lib/server/catalog-auth', () => ({ CatalogHttpError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock('@/lib/server/tenant-scope', () => ({ tenantScope: vi.fn() }));
vi.mock('@/lib/server/catalog-repository', () => ({ savePlacementStandard: vi.fn(), savePlacementStandardBatch: vi.fn() }));
const actor = { id: 'actor', email: 'fixture@example.test', displayName: 'fixture', role: 'editor' as const };
const request = (body: unknown) => new NextRequest('http://localhost/api/catalog/standards', { method: 'POST', body: JSON.stringify(body) });
const tenant = { id: '00000000-0000-0000-0000-000000000001', name: '内部', plan: 'internal', billingMode: 'exempt', styleQuota: 1, storageQuotaBytes: 1, workspace: 'main' } as const;
beforeEach(() => { vi.resetAllMocks(); vi.mocked(tenantScope).mockResolvedValue({ user: actor, tenant }); });
it('requires editor authentication before either save contract', async () => {
  vi.mocked(tenantScope).mockRejectedValue(new CatalogHttpError(403, '只有查看权限'));
  expect((await POST(request({ views: [] }))).status).toBe(403);
  expect(tenantScope).toHaveBeenCalledWith(expect.anything(), true);
  expect(savePlacementStandardBatch).not.toHaveBeenCalled();
  expect(savePlacementStandard).not.toHaveBeenCalled();
});
it('returns the one atomic batch receipt while retaining the legacy single-face contract', async () => {
  const receipt = { variantId: 'color', standards: [{ standardId: randomUUID(), revision: 1 }, { standardId: randomUUID(), revision: 1 }] };
  vi.mocked(savePlacementStandardBatch).mockResolvedValue(receipt);
  const body = { views: [{ viewId: 'front' }, { viewId: 'back' }] };
  expect(await (await POST(request(body))).json()).toEqual(receipt);
  expect(savePlacementStandardBatch).toHaveBeenCalledWith(body, actor, '00000000-0000-0000-0000-000000000001');
  expect(savePlacementStandard).not.toHaveBeenCalled();
  vi.mocked(savePlacementStandard).mockResolvedValue({ variantId: 'color', standardId: randomUUID(), revision: 2 });
  expect((await POST(request({ viewId: 'front' }))).status).toBe(200);
  expect(savePlacementStandard).toHaveBeenCalledWith({ viewId: 'front' }, actor, '00000000-0000-0000-0000-000000000001');
});
it('preserves the face-specific conflict instead of returning success', async () => {
  vi.mocked(savePlacementStandardBatch).mockRejectedValue(new CatalogHttpError(409, '背面已被更新；本次未保存任何面'));
  const response = await POST(request({ views: [] }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: '背面已被更新；本次未保存任何面' });
});
