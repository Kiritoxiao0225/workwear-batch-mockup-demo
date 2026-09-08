import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/wps-production/export/route';
import { readWpsProductionState } from '@/lib/server/wps-production-store';
import { listWpsSourceTaskRecords } from '@/lib/server/wps-dbsheet';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { garmentFixture } from '@/lib/testing/production-garment-fixture';
import { emptyWpsProductionState, importTaskReviews, type MockupOutput } from '@/lib/wps-production';
import { CONFIRMATION_FRAME, WPS_COMPOSITOR_VERSION } from '@/lib/confirmation-frame';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
vi.mock('@/lib/server/wps-production-store', () => ({ readWpsProductionState: vi.fn() }));
vi.mock('@/lib/server/wps-dbsheet', () => ({ listWpsSourceTaskRecords: vi.fn() }));

function approvedState() {
  const review = taskReviewFixture()[2];
  review.units.forEach(unit => { unit.garment = garmentFixture(); });
  const state = importTaskReviews(emptyWpsProductionState(), [review]);
  const output: MockupOutput = {
    url: '/uploads/mockups/framed-export.png', name: 'framed-export.png', sha256: 'a'.repeat(64),
    width: CONFIRMATION_FRAME.width, height: CONFIRMATION_FRAME.height, byteLength: 200,
    composeFingerprint: 'b'.repeat(64), compositorVersion: WPS_COMPOSITOR_VERSION, createdAt: state.updatedAt,
  };
  Object.assign(state.mockupVersions[0], { status: 'approved', output, finalConfirmation: { confirmedAt: state.updatedAt, actor: '测试员' } });
  vi.mocked(readWpsProductionState).mockResolvedValue(state);
  vi.mocked(listWpsSourceTaskRecords).mockResolvedValue({ records: [review.source] } as Awaited<ReturnType<typeof listWpsSourceTaskRecords>>);
  return state;
}

describe('customer frame export', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('archives the exact saved framed output and maps its hash, without regenerating the image', async () => {
    const state = approvedState();
    const savedPng = Buffer.from('saved framed PNG pixels');
    vi.mocked(readFile).mockResolvedValue(savedPng);
    const response = await GET();
    expect(response.status).toBe(200);
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    expect(await zip.file('成品/framed-export.png')!.async('nodebuffer')).toEqual(savedPng);
    const mapping = JSON.parse(await zip.file('mapping.json')!.async('string'));
    expect(mapping.mappings[0].outputSha256).toBe(state.mockupVersions[0].output!.sha256);
  });
  it('rejects legacy unframed output and unconfirmed previews', async () => {
    const state = approvedState();
    state.mockupVersions[0].output!.compositorVersion = 'sharp-catalog-compositor-v2';
    const old = await GET();
    expect(old.status).toBe(422);
    expect((await old.json()).error).toContain('带框客户图');
    state.mockupVersions[0].status = 'pendingFinalConfirmation';
    const preview = await GET();
    expect(preview.status).toBe(422);
    expect((await preview.json()).error).toContain('没有通过成品确认');
  });
  it('bounds concurrent downloads while preserving every saved output and mapping', async () => {
    const state = approvedState();
    const original = state.mockupVersions[0];
    state.mockupVersions = Array.from({ length: 7 }, (_, index) => ({
      ...original, id: `${original.id}-${index}`,
      output: { ...original.output!, name: `saved-${index}.png`, url: `/uploads/mockups/saved-${index}.png` },
    }));
    let active = 0, peak = 0;
    const releases: (() => void)[] = [];
    vi.mocked(readFile).mockImplementation(file => new Promise(resolve => {
      active++; peak = Math.max(peak, active);
      releases.push(() => { active--; resolve(Buffer.from(String(file).split('/').at(-1)!)); });
    }));
    const responsePending = GET();
    for (const expected of [3, 6, 7]) {
      await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(expected));
      releases.splice(0).reverse().forEach(release => release());
    }
    const response = await responsePending;
    expect(response.status).toBe(200);
    expect(peak).toBe(3);
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    for (let index = 0; index < 7; index++) {
      expect(await zip.file(`成品/saved-${index}.png`)!.async('string')).toBe(`saved-${index}.png`);
    }
    const mapping = JSON.parse(await zip.file('mapping.json')!.async('string'));
    expect(mapping.mappings.map((entry: { outputFile: string }) => entry.outputFile))
      .toEqual(state.mockupVersions.map(version => `成品/${version.output!.name}`));
  });
  it('fails the archive when any saved image cannot be read', async () => {
    approvedState();
    vi.mocked(readFile).mockRejectedValue(new Error('saved file checksum mismatch'));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect((await response.json()).error).toContain('checksum mismatch');
  });
});
