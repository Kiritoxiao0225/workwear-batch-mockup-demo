import { describe, expect, it } from 'vitest';
import { analyzeLogoColors, decideLogoColor, fromHex, judgeLogoColors, promptFixesLogoColor, recommendLogoColor, sourceMentionsColor, type Rgb } from './logo-color-sop';

type Paint = (x: number, y: number) => string | null;
function logo(width: number, height: number, paint: Paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = paint(x, y);
    if (color) data.set([...fromHex(color), 255], (y * width + x) * 4);
  }
  return analyzeLogoColors(data, width, height)!;
}
const solid = (color: string) => logo(60, 30, () => color);
const garment = (color: string): Rgb => fromHex(color);
const 理想绿 = garment('#2b4b48');

describe('SOP 5 logo colors', () => {
  it('matches the SOP examples: light on dark and the approved gold on light grey pass, red with green fails', () => {
    expect(judgeLogoColors(solid('#ffffff'), garment('#111111')).ok).toBe(true);
    expect(judgeLogoColors(solid('#a88550'), garment('#c8c8cc')).ok).toBe(true);
    expect(judgeLogoColors(solid('#1f9d2a'), garment('#d81e1e')).ok).toBe(false);
  });

  it('recolors the dark navy logo on 理想绿 to white', () => {
    const decision = decideLogoColor(solid('#031827'), 理想绿);
    expect(decision.verdict).toMatchObject({ ok: false, reason: 'contrast' });
    expect(decision).toMatchObject({ color: '#ffffff', source: 'auto', blocked: null });
    expect(decision.recommendation.contrast).toBeGreaterThan(9);
  });

  it('prefers the logo’s own color that reads, then the standard inks', () => {
    // Navy word on the left, yellow word on the right, apart from each other.
    const twoTone = logo(80, 20, x => x < 36 ? '#123a7a' : x >= 44 ? '#e0b000' : null);
    expect(recommendLogoColor(twoTone, garment('#141414')).color).toBe('#e0b000');
    expect(recommendLogoColor(twoTone, garment('#f5f5f5')).color).toBe('#123a7a');
    expect(recommendLogoColor(solid('#123a7a'), garment('#f5f5f5'))).toMatchObject({ color: '#123a7a', label: '图稿原有色' });
    expect(recommendLogoColor(solid('#d81e1e'), garment('#d81e1e')).color).toBe('#ffffff');
  });

  it('takes the two-tone garment’s other color first when it reads (SOP 1.2)', () => {
    expect(recommendLogoColor(solid('#d9d9d9'), garment('#efe6d2'), [fromHex('#7a1f2b')])).toMatchObject({ color: '#7a1f2b', label: '衣服撞色' });
    expect(recommendLogoColor(solid('#d9d9d9'), garment('#efe6d2'), [fromHex('#e0d6c0')]).color).toBe('#1a1a1a');
  });

  it('does not flatten a logo whose design is inner color changes, such as a white mark on a red seal', () => {
    const seal = logo(60, 60, (x, y) => Math.hypot(x - 30, y - 30) > 28 ? null : Math.abs(x - 30) < 12 && Math.abs(y - 30) < 12 && (x + y) % 8 < 4 ? '#ffffff' : '#d81e1e');
    expect(seal.innerEdges).toBeGreaterThan(.25);
    expect(decideLogoColor(seal, garment('#c8102e'))).toMatchObject({ color: null, blocked: 'inner-detail' });
  });

  it('leaves a designer’s editor color and a customer’s named color alone', () => {
    expect(decideLogoColor(solid('#031827'), 理想绿, { setByDesigner: true })).toMatchObject({ color: null, source: 'manual', blocked: null });
    expect(decideLogoColor(solid('#031827'), 理想绿, { fixedByCustomer: true })).toMatchObject({ color: null, blocked: 'customer' });
  });

  it('lets the garment decide only when the 颜色 item keeps the original colors or leaves them open', () => {
    const prompt = (color: string) => `【后背图稿】\n\n主体：使用图2完整Logo。\n\n文字：沿用图2已有文字，不改写。\n\n字体：沿用图2。\n\n颜色：${color}\n\n排版：保持图2原有构图。\n\n尺寸：原需求未指定图稿尺寸。\n\n输出：一张独立平面图稿。`;
    expect(promptFixesLogoColor(prompt('沿用图2原有配色。'))).toBe(false);
    // W70bcd6a10902: the requirement model spelled out the original colors; nothing here is the customer's.
    expect(promptFixesLogoColor(prompt('人物侧脸及头发使用图2的深蓝黑色，头饰保留酒红色、绿色、棕色及白色分隔区域，沿用图2原有配色。'))).toBe(false);
    expect(promptFixesLogoColor(prompt('沿用图2原有配色，包括酒红色、绿色、棕色、深蓝黑色及白色分隔区域；文字沿用深蓝黑色效果。'))).toBe(false);
    expect(promptFixesLogoColor(prompt('文字使用图3中的红色。'))).toBe(true);
    expect(promptFixesLogoColor(prompt('文字颜色参考图2。'))).toBe(true);
    expect(promptFixesLogoColor(prompt('原需求未指定颜色。'))).toBe(false);
    expect(promptFixesLogoColor(prompt('Logo改为白色。'))).toBe(true);
    expect(promptFixesLogoColor(prompt('沿用图2原有配色，新增文字为黑色。'))).toBe(true);
    expect(promptFixesLogoColor(prompt('红色文字，蓝色图形。'))).toBe(true);
    expect(promptFixesLogoColor(undefined)).toBe(true);
    // W70bcd6a10902 read by gpt-6-sol: 参考 here only keeps the colors of the artwork's own images.
    const both = (color: string) => prompt(color).replace('主体：使用图2完整Logo。', '主体：将图1衣服上的左胸图案重建为独立平面图稿；图案细节参考图2中的同款人物图形。');
    expect(promptFixesLogoColor(both('人物图形参考图1与图2的原有配色；文字颜色沿用图1。'))).toBe(false);
    expect(promptFixesLogoColor(both('人物图形参考图3的原有配色。'))).toBe(true);
    expect(promptFixesLogoColor(both('文字参考图3的深蓝色。'))).toBe(true);
  });
  it('counts only colours the customer wrote, not the garment colours', () => {
    const wps = '货号:CX8099NS-天蓝色\n左胸:图1\n右胸：用图1的乘风和英文在额外加一个·和体育 类似的\n后背:图1\n颜色:';
    expect(sourceMentionsColor(wps, ['天蓝色'])).toBe(false);
    expect(sourceMentionsColor('左胸正前胸和袖子按照下图做\n粉色金字  红色白字', ['粉色', '红色'])).toBe(true);
    expect(sourceMentionsColor('B01SD-蔚来灰 印图一 印白色', ['蔚来灰'])).toBe(true);
  });
});
