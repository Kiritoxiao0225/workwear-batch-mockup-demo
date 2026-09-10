import { standardArtworkServices, type StandardArtworkServices } from './artwork-standard-pipeline';
import { artworkJobStep } from './artwork-job-runtime';

export function durableArtworkServices(): StandardArtworkServices {
  const s = standardArtworkServices;
  return { ...s,
    fidelity: (...args) => artworkJobStep('fidelity', 'processing', args, () => s.fidelity(...args), false),
    measure: bytes => artworkJobStep('measure', 'quality', bytes, () => s.measure(bytes)),
    generate: (...args) => artworkJobStep('generate', 'generation', args, () => s.generate(...args)),
    inspect: (...args) => artworkJobStep('inspect', 'inspection', args, () => s.inspect(...args)),
    inspectSource: (...args) => artworkJobStep('inspectSource', 'inspection', args, () => s.inspectSource(...args)),
    resolveReferenceColor: (...args) => artworkJobStep('referenceColor', 'inspection', args, () => s.resolveReferenceColor(...args)),
    verifyEdits: (...args) => artworkJobStep('verifyEdits', 'inspection', args, () => s.verifyEdits(...args)),
    verifyText: (...args) => artworkJobStep('verifyText', 'inspection', args, () => s.verifyText(...args)),
  };
}
