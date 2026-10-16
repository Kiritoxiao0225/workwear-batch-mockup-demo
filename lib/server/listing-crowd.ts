/** Where the SKU models and the closer are shot when the plan has no place of its own (written before 10-16). */
export const DEFAULT_PLACE = '干净的城市写字楼园区广场，绿植和玻璃幕墙在远处，白天柔和的自然光';

/**
 * The closer's people (「6色可选」): a team photographed doing something together where the set is
 * shot. Lined up in the studio as the competitors' sample 2-1 is, six colours came out as two stiff
 * rows that looked pasted together (10-16); left to share the colours out, the model wore one twice and
 * dropped another, so each place in the group is given its colour.
 */
export function crowdLine(colors: { name: string; hex?: string }[], ref: string) {
  const names = colors.map(c => c.name), hex = new Map(colors.map(c => [c.name, c.hex]));
  const n = names.length <= 2 ? 4 : names.length;
  const worn = Array.from({ length: n }, (_, k) => names[k % names.length]);
  // The main colour in the middle of the front row; the back row stands in the gaps behind it.
  const k = n <= 3 ? n : Math.ceil(n / 2), front = worn.slice(0, k), back = worn.slice(k);
  // The colour's value too: a dark navy read only by its name came out royal blue (10-16).
  const row = (xs: string[]) => xs.map(x => `「${x}」${hex.get(x) ? `（${hex.get(x)}）` : ''}`).join('');
  const centred = front.length === 3 ? [front[1], front[0], front[2]] : front;
  const places = back.length
    ? `前排从左到右${row(centred)}，后排从左到右${row(back)}（后排的人站在前排两人之间的空隙后面，露出整张脸和上半身的衣服）`
    : `从左到右${row(centred)}`;
  const colours = n === names.length ? `${names.length} 种颜色各出现一次、不重复也不缺` : `${names.join('、')}交替`;
  return `${'零一两三四五六七八'[n] ?? n}位同事一起出镜，像团建时抓拍的合影，有互动、有动作，不是排排站：有人搭着旁边同事的肩、有人和同伴笑着击掌、有人举手朝镜头打招呼、有人侧身笑着看向身边的人；人和人靠得近、肩膀前后交叠，整体是一组热闹开心的团队；每人穿一种颜色，按位置固定：${places}，${colours}，每种颜色都清楚看得到一整件衣服的正面，颜色照对应颜色的参考图、深浅不变，不要画得更亮更艳；${ref}里的男生和女生都在、长相不变，其余的人男女交替；拉链拉到胸口，内搭白色 T 恤；从头拍到大腿，所有人的脸都清楚、没有被别人挡住；整组人左右占满画面，头顶在画面上沿往下 8%～25% 之间`;
}
