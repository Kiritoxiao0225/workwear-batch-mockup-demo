import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_LAYOUTS, cellZones } from '../listing/templates';
import { accentOf, enOf, SPECS, specFor, specPrompt, type Fill } from './listing-specs';

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
  it('print the customer\'s LOGO on the chest only, never in a corner (10-21)', () => {
    const prompt = (logo?: number) => specPrompt({ master: 'M3', task: '收口', taskLabel: '收口', n: 5, total: 5, spec: SPECS.M3.收口!, fill, garment: ['立领'], logo: logo ? '印客户 LOGO' : null,
      refs: { garment: [{ name: '黑色' }, { name: '象牙白' }], cast: 3, logo, sample: logo ? 5 : 4 } });
    expect(prompt(4)).toContain('参考图4：客户的 LOGO，只用来印在衣服胸口，画面别处都不放。');
    expect(prompt(4)).not.toContain('左上角放客户的 LOGO');
    expect(prompt()).not.toContain('客户的 LOGO');
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

describe('the 75-set review (10-19)', () => {
  const prompt = (master: string, task: '首图' | '功能' | '细节' | '收口', garment: { name: string }[]) => {
    const spec = SPECS[master][task]!;
    return specPrompt({ master, task, taskLabel: task, n: 5, total: 5, spec, fill: { ...fill, cells: fill.cells.slice(0, spec.cells) }, garment: ['立领'], logo: null,
      refs: { garment, cast: spec.people ? garment.length + 1 : undefined, sample: garment.length + (spec.people ? 2 : 1) } });
  };
  it('无模特\'s rack stands on the floor with both posts in the picture, nothing overlapping', () => {
    const p = prompt('M5', '收口', [{ name: '黑色' }, { name: '象牙白' }]);
    expect(p).toContain('落地衣架');
    expect(p).toContain('两根立柱和底座都完整在画面里');
    expect(p).toContain('从左到右依次是黑色、象牙白、黑色、象牙白');
    expect(p).not.toMatch(/叠压|横穿画面/);
  });
  it('several colours keep each their own structure, and the garment\'s own marks stay', () => {
    for (const master of ['M1', 'M2', 'M3', 'M4', 'M5']) {
      const p = prompt(master, '收口', [{ name: '黑色' }, { name: '象牙白' }]);
      expect(p, master).not.toContain('款式都一样');
      expect(p, master).toContain('不同颜色之间的结构差异');
      expect(p, master).toContain('衣服本身带的袖标、织标、印字和图案照参考图原样保留');
      expect(p, master).not.toContain('任何真实品牌 logo');
      expect(p, master).not.toContain('衣服上不印任何字');
    }
  });
  it('双人棚拍\'s cover asks for easy faces, not a stare into the lens', () => {
    const p = prompt('M4', '首图', [{ name: '黑色' }]);
    expect(p).toMatch(/两人脸部清楚；两人站姿放松，表情自然亲和、嘴角微微带笑，眼神柔和平静地看镜头[^。]*不要瞪着镜头/);
  });
});

describe('the words fit their boxes (10-19)', () => {
  it('a long fact word is set smaller than the sample\'s size, a short one keeps it', () => {
    const spec = SPECS.M5.功能!;
    const prompt = (word: string) => specPrompt({ master: 'M5', task: '功能', taskLabel: '功能', n: 3, total: 5, spec, fill: { ...fill, facts: [{ label: '面料科技', word }] }, garment: ['立领'], logo: null,
      refs: { garment: [{ name: '黑色' }], sample: 2 } });
    expect(prompt('高防水')).toContain('大号粗体字「高防水」，一行写完、不换行，字高约占画面 7%');
    const long = /大号粗体字「德国SUPER-TEX」，一行写完、不换行，字高约占画面 ([\d.]+)%/.exec(prompt('德国SUPER-TEX'));
    expect(Number(long?.[1])).toBeLessThan(7);
  });
  it('a fact word that would shrink a lot takes two lines at 7 %, and the next fact moves down for it', () => {
    const spec = SPECS.M5.功能!;
    const prompt = (facts: Fill['facts']) => specPrompt({ master: 'M5', task: '功能', taskLabel: '功能', n: 3, total: 5, spec, fill: { ...fill, facts }, garment: ['立领'], logo: null,
      refs: { garment: [{ name: '黑色' }], sample: 2 } });
    const tops = (p: string) => [...p.matchAll(/左4% 上(\d+)% 宽44% 高(\d+)%：/g)].map(m => ({ top: Number(m[1]), height: Number(m[2]) }));
    const short = prompt([{ label: '面料科技', word: '德国SUPER-TEX' }, { label: '面料特点', word: '高防水透气膜' }]);
    const long = prompt([{ label: '面料科技', word: '石墨烯远红外蓄热纤维' }, { label: '面料特点', word: '高防水透气膜' }]);
    expect(long).toContain('大号粗体字「石墨烯远红外蓄热纤维」，太长就分两行写，在词与词之间断开、不把一个词拆到两行，每行字高约占画面 7%');
    expect(tops(long)[1].top).toBeGreaterThan(tops(short)[1].top);
    // Both facts end above the icons.
    for (const p of [short, long]) for (const z of tops(p)) expect(z.top + z.height).toBeLessThanOrEqual(76);
    // Two long words: the second has no room for two lines and stays on one, smaller.
    const both = prompt([{ label: '面料科技', word: '石墨烯远红外蓄热纤维' }, { label: '面料特点', word: '双经双纬T400D面料' }]);
    expect(both).toMatch(/大号粗体字「双经双纬T400D面料」，一行写完、不换行/);
    for (const z of tops(both)) expect(z.top + z.height).toBeLessThanOrEqual(76);
  });
});

describe('无模特 cover (10-23)', () => {
  const zones = (f: Partial<Fill>) => SPECS.M5.首图!.zones({ ...fill, ...f }).join('\n');
  it('closes a zip under a flap whole on the invisible mannequin, and opens a bare zip a little as before', () => {
    expect(zones({ covered: true })).toMatch(/门襟整条合上、拉到领口，拉链藏在门襟下面看不见/);
    expect(zones({})).toMatch(/拉链拉开一点/);
  });
  it('says the title colours outright: dark then the garment\'s colour, a light garment\'s darkened to grey, never the sample\'s', () => {
    expect(accentOf('#DDDED8')).toMatch(/^中灰色 #[0-9A-F]{6}（衣服主色加深）$/); expect(accentOf('#A51C28')).toBe('衣服主色 #A51C28'); expect(accentOf(undefined)).toBe('中灰色 #808080');
    const white = [{ name: '白+黑', hex: '#DDDED8' }];
    expect(zones({ title: '锁温', colors: white })).toMatch(/一行两色：「锁」深色，「温」用中灰色 #[0-9A-F]{6}（衣服主色加深）；整行字号一样，颜色只按这里写的，不照示例图/);
    expect(zones({ title: '防水透气', colors: [{ name: '安哥拉红', hex: '#A51C28' }] })).toMatch(/「防水」深色，「透气」用衣服主色 #A51C28/);
    expect(zones({ title: '锁温 保暖', colors: [{ name: '安哥拉红', hex: '#A51C28' }] })).toMatch(/第一行「锁温」用衣服主色 #A51C28/);
  });
});
