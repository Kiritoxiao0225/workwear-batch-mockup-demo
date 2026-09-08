import { beforeEach, describe, expect, it, vi } from 'vitest';
import { after, NextResponse } from 'next/server';
import { GET, POST } from '../../app/api/wps-production/route';
import { GET as read, POST as save } from './wps-production-actions';
import { finishProductionSave } from './production-post-save';

vi.mock('next/server', async importOriginal => ({ ...await importOriginal<typeof import('next/server')>(), after: vi.fn() }));
vi.mock('./wps-production-actions', () => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('./production-post-save', () => ({ finishProductionSave: vi.fn() }));
vi.mock('./production-storage', () => ({ usesProductionCloud: () => true }));

beforeEach(() => vi.resetAllMocks());
describe('request-scoped replacement after response', () => {
  it('returns the committed save before rendering or deleting, and passes the affected units', async () => {
    vi.mocked(save).mockResolvedValue(NextResponse.json({ error: '' }));
    const body = { action: 'saveArtworkDraft', unitId: 'one' };
    const response = await POST(new Request('http://localhost/api/wps-production', { method: 'POST', body: JSON.stringify(body) }));
    expect(response.status).toBe(200);
    expect(finishProductionSave).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledOnce();
    const callback = vi.mocked(after).mock.calls[0][0] as () => Promise<void>;
    await callback();
    expect(finishProductionSave).toHaveBeenCalledWith(body);
  });
  it('does not schedule a replacement when saving fails', async () => {
    vi.mocked(save).mockResolvedValue(NextResponse.json({ error: 'conflict' }, { status: 409 }));
    expect((await POST(new Request('http://localhost/api/wps-production', { method: 'POST', body: '{}' }))).status).toBe(409);
    expect(after).not.toHaveBeenCalled();
  });
  it('retries pending deletion after an authenticated read, without delaying it', async () => {
    vi.mocked(read).mockResolvedValue(NextResponse.json({ error: '' }));
    expect((await GET()).status).toBe(200);
    expect(finishProductionSave).not.toHaveBeenCalled();
    await (vi.mocked(after).mock.calls[0][0] as () => Promise<void>)();
    expect(finishProductionSave).toHaveBeenCalledWith();
    vi.mocked(after).mockClear();
    vi.mocked(read).mockResolvedValue(NextResponse.json({ error: 'login' }, { status: 401 }));
    await GET();
    expect(after).not.toHaveBeenCalled();
  });
});
