import { standardArtworkServices, type StandardArtworkServices } from './artwork-standard-pipeline';
import { artworkJobStep, resumeArtworkGenerationPrompt, resumeArtworkGenerationInput } from './artwork-job-runtime';
import { ARTWORK_EDIT_INSPECTION_VERSION, ARTWORK_TEXT_INSPECTION_VERSION } from '@/lib/artwork-model-edits';

export function durableArtworkServices(): StandardArtworkServices {
  const s = standardArtworkServices;
  return { ...s,
    resumeGenerationInput: resumeArtworkGenerationInput,
    resumeGenerationPrompt: resumeArtworkGenerationPrompt,
    fidelity: (...args) => artworkJobStep('fidelity', 'processing', args, () => s.fidelity(...args), false),
    measure: bytes => artworkJobStep('measurePixels-v1', 'processing', bytes, () => s.measure(bytes)),
    generate: (...args) => artworkJobStep('generate', 'generation', args, () => s.generate(...args)),
    inspect: (...args) => artworkJobStep('inspect', 'inspection', args, () => s.inspect(...args)),
    // Old successful inspections lack a target region. Re-inspect only this
    // step; generation and other paid checkpoints keep their existing keys.
    inspectSource: (...args) => artworkJobStep('inspectSource', 'inspection', { version: 'artwork-source-content-v2', args }, () => s.inspectSource(...args)),
    resolveReferenceColor: (...args) => artworkJobStep('referenceColor', 'inspection', args, () => s.resolveReferenceColor(...args)),
    verifyEdits: (...args) => artworkJobStep('verifyEdits', 'inspection', { version: ARTWORK_EDIT_INSPECTION_VERSION, args }, () => s.verifyEdits(...args)),
    verifyText: (...args) => artworkJobStep('verifyText', 'inspection', { version: ARTWORK_TEXT_INSPECTION_VERSION, args }, () => s.verifyText(...args)),
  };
}
