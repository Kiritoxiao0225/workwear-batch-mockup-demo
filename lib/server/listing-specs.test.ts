import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_LAYOUTS, cellZones } from '../listing/templates';
import { enOf, SPECS, specFor, specPrompt, type Fill } from './listing-specs';

const fill: Fill = { title: '三合一 冲锋衣', sub: '面料结构紧密', tags: ['团体定制'], facts: [{ label: '面料科技', word: '德国SUPER-TEX' }],
  cells: ['严密防风', '持久保暖', '深度呼吸', '防风防水'].map(text => ({ text, note: '说明', recipe: '面料特写', en: enOf(text) })),
  color: '黑色', colors: [{ name: '黑色', hex: '#202024' }, { name: '象牙白', hex: '#EDEAE2' }], all: [{ name: '黑色', hex: '#202024' }, { name: '象牙白', hex: '#EDEAE2' }],
  light: false, who: '参考图2里的男生', badge: '免费印绣' };

describe('the masters\' specs', () => {
  it('cover every master\'s cover, feature, close-up and closer, with the sample\'s number of cards and its image', () => {
    for (const layout of BUILT_IN_LAYOUTS) for (const task of ['首图', '功能', '细节', '收口'] as const) {
      const spec = SPECS[layout.id]?.[task];
      expect(spec, `${layout.id} ${task}`).toBeTruthy();
      expect(spec!.cells, `${layout.id} ${task}`).toBe(cellZones(layout.templates[task].square).length);
      expect(existsSync(path.join(process.cwd(), 'public', spec!.sample)), spec!.sample).toBe(true);
    }
  });
  it('leave an image with another number of cards to the general prompt', () => {
    expect(specFor('M3', '功能', 4)).toBeTruthy();
    expect(specFor('M3', '功能', 6)).toBeNull();
    expect(specFor('learned-layout', '功能', 4)).toBeNull();
  });
  it('write the words in, the sample last among the references, and nothing open left', () => {
    for (const layout of BUILT_IN_LAYOUTS) for (const task of ['首图', '功能', '细节', '收口'] as const) {
      const spec = SPECS[layout.id][task]!, f = { ...fill, cells: fill.cells.slice(0, spec.cells) };
      const prompt = specPrompt({ master: layout.id, task, taskLabel: task, n: 1, total: 5, spec, fill: f, garment: ['立领'], logo: null,
        refs: { garment: [{ name: '黑色' }], cast: spec.people ? 2 : undefined, sample: spec.people ? 3 : 2 } });
      expect(prompt, `${layout.id} ${task}`).toMatch(new RegExp(`参考图${spec.people ? 3 : 2}：${spec.own ? '这套母版的示例图' : '一张同类商品卖得很好的主图'}`));
      expect(prompt, `${layout.id} ${task}`).not.toMatch(/undefined|「」(?!以外)/);
      // 车展工牌's big demonstration and 暗黑科技's whole-image one carry the title, not words of their own, as on their samples.
      for (const c of f.cells.slice(['M1', 'M2'].includes(layout.id) && task === '功能' ? 1 : 0)) expect(prompt, `${layout.id} ${task}`).toContain(c.text);
    }
  });
  it('put 免费印绣 in 暗黑科技\'s black block when the shop offers it, else the cover\'s tag', () => {
    const line = (badge: string) => SPECS.M2.首图!.zones({ ...fill, title: '防水', sub: '冲锋衣定制', tags: ['持久保暖'], badge }).find(z => typeof z === 'string' && z.includes('纯黑色块'));
    expect(line('免费印绣')).toContain('「免费印绣」');
    expect(line('')).toContain('「持久保暖」');
  });
  it('learn from the competitors\' washed images, except 无模特\'s cover, which keeps ours', () => {
    for (const layout of BUILT_IN_LAYOUTS) for (const task of ['首图', '功能', '细节', '收口'] as const) {
      const spec = SPECS[layout.id][task]!;
      expect(spec.sample.startsWith(spec.own ? '/listing-images/masters/' : '/listing-images/rivals/'), `${layout.id} ${task}`).toBe(true);
    }
    expect(SPECS.M5.首图!.own).toBe(true);
  });
  it('put the customer\'s LOGO in the closer\'s corner only when it is sent', () => {
    const prompt = (logo?: number) => specPrompt({ master: 'M3', task: '收口', taskLabel: '收口', n: 5, total: 5, spec: SPECS.M3.收口!, fill, garment: ['立领'], logo: logo ? '印客户 LOGO' : null,
      refs: { garment: [{ name: '黑色' }, { name: '象牙白' }], cast: 3, logo, sample: logo ? 5 : 4 } });
    expect(prompt(4)).toContain('左上角放客户的 LOGO（照参考图4）');
    expect(prompt()).not.toContain('左上角放客户的 LOGO');
  });
  it('print the small icon words of 门店上岗\'s feature image from the fixed list only', () => {
    const zones = SPECS.M3.功能!.zones({ ...fill, cells: [...fill.cells.slice(0, 3), { text: '版型利落', note: '', recipe: '面料特写', en: '' }] }).join('\n');
    expect(zones).toContain('「高密防风」「挡风锁温」「户外不冷」');
    expect(zones.match(/一排三个/g)).toHaveLength(3);
  });
  it('print an English word only for what it knows', () => {
    expect([enOf('防风防水'), enOf('深度呼吸，远离闷燥'), enOf('德国SUPER-TEX')]).toEqual(['WATERPROOF', 'BREATHABLE', '']);
  });
});
