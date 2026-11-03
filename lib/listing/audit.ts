/**
 * 电商主图「整理对账」: after the AI has sorted the material, the program checks its answer against
 * itself — the product's name against the category, the points against the structure images, each
 * point against the images it says it came from — and lists what does not add up, each with the
 * fix where there is one. It only tells; it never blocks (10-13: problems surfaced late, or blocked
 * a step they did not belong to).
 */
import type { Draft, PartSource } from './draft';

export type AuditFix =
  | { kind: 'category'; to: string; label: string }
  | { kind: 'part'; part: string; pick: string; label: string }
  | { kind: 'photo'; part: string; label: string };
export type AuditItem = { text: string; fix?: AuditFix };

/** Words in a product's name that say what garment it is. */
const SAYS_JACKET = /冲锋衣|硬壳|软壳|三合一|冲锋/;
const SAYS_OTHER = /羽绒服|棉服|棉衣|T恤|卫衣|POLO|polo|衬衫|马甲|夹克衫/;

export function auditDraft(d: Draft, m: { category: string; sorted: { images: (PartSource & { kind: string })[]; points: { text: string; part?: string; from: string[] }[] } }, name: string): AuditItem[] {
  const items: AuditItem[] = [];
  if (SAYS_JACKET.test(name) && !SAYS_OTHER.test(name) && d.category !== 'workwear')
    items.push({ text: `商品名写的是冲锋衣，AI 判成了「其他衣服」，没有服务图、也不用冲锋衣的卖点库`, fix: { kind: 'category', to: 'workwear', label: '改成冲锋衣' } });
  const other = name.match(SAYS_OTHER)?.[0];
  if (other && d.category === 'workwear') items.push({ text: `商品名写的是${other}，AI 判成了冲锋衣`, fix: { kind: 'category', to: 'generic', label: '改成其他衣服' } });

  // A point about a part with a photo of it goes into the structure images by itself (draft fillParts, 11-03); one with
  // no photo is drawn another way that needs none. Neither is the user's to sort out.

  // A point whose every source was sorted as unrelated may not be in the material at all.
  const kind = new Map(m.sorted.images.map(i => [i.id, i.kind]));
  for (const p of d.points.filter(x => x.on && x.source === '素材' && x.from.length))
    if (p.from.every(id => kind.get(id) === '无关')) items.push({ text: `卖点「${p.text}」的出处（${p.from.join('、')}）都被当成了无关图，确认一下素材里真有这条` });
  return items;
}
