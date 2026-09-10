import { beforeEach, expect, it, vi } from 'vitest';
import { artworkStepHash } from './artwork-job-runtime';
import { standardArtworkServices } from './artwork-standard-pipeline';
import { durableArtworkServices } from './artwork-job-services';

const checkpoints = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./artwork-job-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('./artwork-job-runtime')>();
  return { ...actual, artworkJobStep: async (name: string, _stage: string, args: unknown, task: () => Promise<unknown>) => {
    const key = `${name}:${actual.artworkStepHash(args)}`;
    if (!checkpoints.has(key)) checkpoints.set(key, await task());
    return checkpoints.get(key);
  } };
});
beforeEach(() => { checkpoints.clear(); vi.restoreAllMocks(); });

it('replaces legacy source evidence once while leaving existing successful generation checkpoints reusable', async () => {
  const args = ['data:image/png;base64,c291cmNl', '取右侧竖版'] as const;
  const old = { version: 'artwork-source-v1' as const, kind: 'flat-artwork' as const, targetDescription: '右侧竖版',
    needsReconstruction: false, evidence: ['截图中有多版'], uncertainDetails: [] };
  checkpoints.set(`inspectSource:${artworkStepHash(args)}`, old);
  const resolved = { ...old, selection: { scope: 'region' as const, bounds: { left: 600, top: 200, right: 900, bottom: 700 } } };
  const inspect = vi.spyOn(standardArtworkServices, 'inspectSource').mockResolvedValue(resolved);
  const generationArgs = ['已付费的原提示词', ['original-image'], { background: 'auto' as const }] as const;
  const original = { bytes: Buffer.from('saved-image'), model: 'saved-provider' };
  checkpoints.set(`generate:${artworkStepHash(generationArgs)}`, original);
  const generate = vi.spyOn(standardArtworkServices, 'generate');
  const services = durableArtworkServices();
  expect(await services.inspectSource(...args)).toEqual(resolved);
  expect(await services.inspectSource(...args)).toEqual(resolved);
  expect(inspect).toHaveBeenCalledOnce();
  expect(checkpoints.get(`inspectSource:${artworkStepHash(args)}`)).toEqual(old);
  expect(await services.generate(generationArgs[0], [...generationArgs[1]], generationArgs[2])).toEqual(original);
  expect(generate).not.toHaveBeenCalled();
});
