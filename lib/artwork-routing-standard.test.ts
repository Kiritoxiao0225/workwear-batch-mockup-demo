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
  it.each([
    [80, 1.25, 'clean'], [79.99, 1, 'repair-once'], [80, 1.251, 'repair-once'],
  ])('uses the exact clarity and scale boundaries (%s, %s)', (score, scale, action) => {
    expect(decideArtworkMethod(facts({ sourceClarity: measurement(score), requiredScale: scale }))).toMatchObject({ method: 'preserve', state: 'ready', action });
  });
  it.each([null, measurement(NaN), measurement(101), { score: 100, protocol: 'legacy-source-native' }])('does not trust missing, invalid or incompatible quality scores', sourceClarity => {
    expect(decideArtworkMethod(facts({ sourceClarity })).action).toBe('inspect');
  });
  it('does not turn one enhancement call without a post-score into a failed repair', () => {
    expect(decideArtworkMethod(facts({ repair: { attempts: 1, clarity: null, requiredScale: null } }))).toMatchObject({ method: 'preserve', state: 'pending', action: 'inspect' });
  });
  it('redraws only after a measured failed repair and explicit flat-logo eligibility', () => {
    const repaired = facts({ repair: { attempts: 1, clarity: measurement(79), requiredScale: 1 }, redrawEligibility: 'verified-flat-readable' });
    expect(decideArtworkMethod(repaired)).toMatchObject({ method: 'redraw', state: 'ready', action: 'redraw' });
    expect(decideArtworkMethod({ ...repaired, redrawEligibility: 'unknown' }).action).toBe('review');
    expect(decideArtworkMethod({ ...repaired, redrawEligibility: 'ineligible' }).action).toBe('review');
    expect(decideArtworkMethod({ ...repaired, strictPreservation: true })).toMatchObject({ method: 'preserve', action: 'review' });
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
