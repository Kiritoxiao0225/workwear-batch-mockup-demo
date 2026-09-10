import { beforeEach, expect, it, vi } from 'vitest';
import { inspectArtworkReferenceImage } from './ark-task-review';
import { inspectArtworkSourceAssessment } from './artwork-source-assessment';

vi.mock('./ark-task-review', () => ({ inspectArtworkReferenceImage: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it('inspects the actual image with the target requirement and preserves uncertainties without guessing characters', async () => {
  const source = { version: 'artwork-source-v1', kind: 'artwork-on-object', targetDescription: '衣物表面红色胸标',
    needsReconstruction: true, evidence: ['衣料褶皱穿过胸标'], uncertainDetails: ['首字看不清'] };
  vi.mocked(inspectArtworkReferenceImage).mockResolvedValue({ content: `\x60\x60\x60json\n${JSON.stringify(source)}\n\x60\x60\x60`, model: 'test', provider: 'cliproxy' });
  expect(await inspectArtworkSourceAssessment('data:image/png;base64,cGhvdG8=', '左胸：图二')).toEqual(source);
  expect(inspectArtworkReferenceImage).toHaveBeenCalledWith('data:image/png;base64,cGhvdG8=', expect.stringContaining('左胸：图二'), expect.any(Object));
});

it('does not substitute preservation for an invalid or failed inspection', async () => {
  vi.mocked(inspectArtworkReferenceImage).mockResolvedValue({ content: '{"kind":"flat-artwork"}', model: 'test', provider: 'cliproxy' });
  await expect(inspectArtworkSourceAssessment('image', '目标')).rejects.toThrow();
  vi.mocked(inspectArtworkReferenceImage).mockRejectedValue(new Error('inspection timeout'));
  await expect(inspectArtworkSourceAssessment('image', '目标')).rejects.toThrow('inspection timeout');
});
