import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../../app/api/catalog/products/[id]/recognize-placement/route';
import { catalogUser, CatalogHttpError } from './catalog-auth';
import { catalogDetail } from './catalog-repository';
import { recognizeCatalogApron } from './catalog-apron-recognition';
import { catalogFixture } from '@/lib/testing/production-garment-fixture';
vi.mock('./catalog-auth', () => ({ catalogUser: vi.fn(), CatalogHttpError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock('./catalog-repository', () => ({ catalogDetail: vi.fn() }));
vi.mock('./catalog-apron-recognition', () => ({ recognizeCatalogApron: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
function request(assetVersionId = catalogFixture().assetVersionId) { return new NextRequest('http://localhost:3000/api/catalog/products/one/recognize-placement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetVersionId }) }); }
const context = { params: Promise.resolve({ id: catalogFixture().id }) };
describe('apron recognition endpoint', () => {
  it('requires write authentication before any model call', async () => {
    vi.mocked(catalogUser).mockRejectedValue(new CatalogHttpError(401, '请先登录工作台'));
    expect((await POST(request(), context)).status).toBe(401);
    expect(catalogUser).toHaveBeenCalledWith(expect.anything(), true);
    expect(recognizeCatalogApron).not.toHaveBeenCalled();
  });
  it('rejects malformed or historic asset versions before calling a model', async () => {
    expect((await POST(request('bad-id'), context)).status).toBe(400);
    vi.mocked(catalogDetail).mockResolvedValue({ ...catalogFixture(), isCurrent: false });
    expect((await POST(request(), context)).status).toBe(409);
    expect(recognizeCatalogApron).not.toHaveBeenCalled();
  });
});
