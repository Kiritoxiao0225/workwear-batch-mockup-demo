import { describe, expect, it } from 'vitest';
import { enOf } from '../server/listing-specs';
import { bestSell, coverPicks, coverScene, MASTER_INFO, PLACE_IDS, PLACES, SELLS, sellTitle, type Sell } from './scene';

describe('cover pools (10-17: fifty sets had one pose, one showroom and 「防水」)', () => {
  it('every place has a look for each point it can act out, and 暗黑科技 a low-key one where it may shoot', () => {
    for (const id of PLACE_IDS) for (const sell of PLACES[id].fits as readonly Sell[]) {
      expect(PLACES[id].looks.some(l => (l.sells as readonly Sell[]).includes(sell)), `${id} ${sell}`).toBe(true);
      if (!MASTER_INFO.M2.deny[id]) expect(PLACES[id].looks.some(l => 'dark' in l && l.dark && (l.sells as readonly Sell[]).includes(sell)), `M2 ${id} ${sell}`).toBe(true);
    }
  });
  it('each cover word is two characters (the vertical and calligraphy titles hold two) and prints its English word', () => {
    for (const s of Object.values(SELLS)) for (const t of s.titles) {
      expect([...t]).toHaveLength(2);
      expect(enOf(t), t).not.toBe('');
    }
  });
  it('one plan keeps its picks; the next plan gets others', () => {
    expect(coverPicks(7, '4S店', '防水')).toEqual(coverPicks(7, '4S店', '防水'));
    const lines = new Set(Array.from({ length: 12 }, (_, seed) => coverScene('4S店', '防水', coverPicks(seed, '4S店', '防水')).line));
    expect(lines.size).toBeGreaterThan(4);
    expect(new Set(Array.from({ length: 12 }, (_, seed) => sellTitle('防水', seed).title)).size).toBe(SELLS.防水.titles.length);
  });
  it('the cover point is taken in turn among the ticked points the place can act out, the AI\'s pick among them', () => {
    const ticked = ['防泼水面料', '轻量透气', '防风立领', '耐磨'];
    const picks = new Set(Array.from({ length: 9 }, (_, seed) => bestSell('写字楼', ticked, seed)));
    expect(picks).toEqual(new Set(['轻量透气', '防风']));
    expect(new Set(Array.from({ length: 9 }, (_, seed) => bestSell('写字楼', ticked, seed, '防水')))).toEqual(new Set(['防水', '轻量透气', '防风']));
    expect(bestSell('写字楼', ['耐磨'], 3)).toBe('耐磨');
  });
});
