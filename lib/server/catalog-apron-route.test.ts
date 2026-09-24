import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../../app/api/catalog/products/[id]/recognize-placement/route';
import { CatalogHttpError } from './catalog-auth';
import { tenantScope } from './tenant-scope';
import { catalogDetail } from './catalog-repository';
import { recognizeCatalogApron } from './catalog-apron-recognition';
import { catalogFixture } from '@/lib/testing/production-garment-fixture';
vi.mock('./catalog-auth', () => ({ CatalogHttpError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock('./tenant-scope', () => ({ tenantScope: vi.fn() }));
const scopeFixture = { user: { id: 'operator', email: 'operator@example.test', displayName: '操作员', role: 'editor' as const }, tenant: { id: '00000000-0000-0000-0000-000000000001', name: '内部', plan: 'internal', billingMode: 'exempt', styleQuota: 1, storageQuotaBytes: 1, workspace: 'main' } } as const;
vi.mock('./catalog-repository', () => ({ catalogDetail: vi.fn() }));
vi.mock('./catalog-apron-recognition', () => ({ recognizeCatalogApron: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
function request(assetVersionId = catalogFixture().assetVersionId) { return new NextRequest('http://localhost:3000/api/catalog/products/one/recognize-placement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetVersionId }) }); }
const context = { params: Promise.resolve({ id: catalogFixture().id }) };
describe('apron recognition endpoint', () => {
  it('requires write authentication before any model call', async () => {
    vi.mocked(tenantScope).mockRejectedValue(new CatalogHttpError(401, '请先登录工作台'));
    expect((await POST(request(), context)).status).toBe(401);
    expect(tenantScope).toHaveBeenCalledWith(expect.anything(), true);
    expect(recognizeCatalogApron).not.toHaveBeenCalled();
  });
  it('rejects malformed or historic asset versions before calling a model', async () => {
    vi.mocked(tenantScope).mockResolvedValue(scopeFixture);
    expect((await POST(request('bad-id'), context)).status).toBe(400);
    vi.mocked(catalogDetail).mockResolvedValue({ ...catalogFixture(), isCurrent: false });
    expect((await POST(request(), context)).status).toBe(409);
    expect(recognizeCatalogApron).not.toHaveBeenCalled();
  });
});
