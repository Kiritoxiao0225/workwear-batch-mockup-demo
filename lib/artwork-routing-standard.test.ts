import { describe, expect, it } from 'vitest';
import { ARTWORK_ROUTING_STANDARD, decideArtworkMethod, type ArtworkRoutingFacts } from '@/lib/artwork-routing-standard';

const measurement = (score: number) => ({ score, protocol: ARTWORK_ROUTING_STANDARD.scoreProtocol });
const facts = (patch: Partial<ArtworkRoutingFacts> = {}): ArtworkRoutingFacts => ({
  intent: 'preserve', intentReason: '保留原图', sourcePresent: true, blockers: [],
  sourceClarity: measurement(85), requiredScale: 1,
  repair: { attempts: 0, clarity: null, requiredScale: null },
  redrawEligibility: 'unknown', editSpecification: 'complete', strictPreservation: false, ...patch,
});

describe('artwork routing standard', () => {
  it.each([[0, 1, 'clean'], [100, 1.01, 'repair-once'], [80, 1.25, 'repair-once']])('routes by native pixels, independently of score (%s, %s)', (score, scale, action) => {
    expect(decideArtworkMethod(facts({ sourceClarity: measurement(Number(score)), requiredScale: Number(scale) }))).toMatchObject({ method: 'preserve', state: 'ready', action });
  });
  it.each([null, measurement(NaN), measurement(101), { score: 100, protocol: 'legacy-source-native' }])('does not require or recheck historical scores', sourceClarity => {
    expect(decideArtworkMethod(facts({ sourceClarity })).action).toBe('clean');
  });
  it('never repeats a completed enhancement or redraws for low resolution', () => {
    expect(decideArtworkMethod(facts({ repair: { attempts: 1, clarity: null, requiredScale: 4 }, redrawEligibility: 'verified-flat-readable' }))).toMatchObject({ method: 'preserve', state: 'ready', action: 'clean' });
  });
  it('retains a successful repair and does not automatically spend on redraw', () => {
    expect(decideArtworkMethod(facts({ repair: { attempts: 1, clarity: measurement(80), requiredScale: 1.25 } }))).toMatchObject({ method: 'preserve', action: 'clean' });
  });
  it('handles partial and whole composition by intent, with missing details blocking execution', () => {
    expect(decideArtworkMethod(facts({ intent: 'compose', sourceClarity: measurement(10) }))).toMatchObject({ method: 'compose', action: 'compose' });
    expect(decideArtworkMethod(facts({ intent: 'generate' }))).toMatchObject({ method: 'generate', action: 'generate' });
    expect(decideArtworkMethod(facts({ intent: 'compose', editSpecification: 'incomplete' }))).toMatchObject({ method: 'compose', action: 'review' });
  });
  it('lets missing evidence take priority even over an explicit whole-design intent', () => {
    expect(decideArtworkMethod(facts({ intent: 'generate', sourcePresent: false }))).toMatchObject({ method: null, action: 'review' });
    expect(decideArtworkMethod(facts({ blockers: ['原文字无法确认'] }))).toMatchObject({ method: null, action: 'review' });
  });
});
