/**
 * 电商主图: how a selling point is shown on an image (画法). Taken from what the best-selling
 * competitors draw: water beading on the fabric for waterproofing, steam through the fabric over a
 * hot cup for breathability, warm light around the garment's own fabric for warmth. A close-up of a garment
 * part needs a picture of that part; a demonstration with a person needs a person on the image.
 */
export type ProofKind = '效果演示' | '原理示意' | '部位特写' | '场景' | '图标文字';
export type Proof = { id: string; kind: ProofKind; name: string; recipe: string; person: boolean; part?: boolean };

export const PROOFS: Proof[] = [
  { id: 'water-beads', kind: '效果演示', name: '水珠演示', recipe: '面料表面挂满饱满透亮的圆水珠，一股水泼上来聚成水珠滚落，面料不湿', person: false },
  { id: 'water-arm', kind: '效果演示', name: '淋水演示', recipe: '模特抬起手臂，水从肩上淋下，在袖子和肩部聚成水珠滚落', person: true },
  { id: 'wipe-clean', kind: '效果演示', name: '一擦就净', recipe: '面料上挂着水珠和污渍，一只手拿毛巾轻轻擦过，擦过的地方干净没有痕迹', person: false },
  { id: 'juice-pour', kind: '效果演示', name: '泼饮料', recipe: '一杯果汁泼在面料上，液体聚成圆珠滑落，不留污渍', person: false },
  { id: 'steam-cup', kind: '效果演示', name: '热杯透汽', recipe: '一块面料盖在一杯热水上，白色蒸汽从面料表面透出来', person: false },
  { id: 'wind-arrows', kind: '原理示意', name: '挡风示意', recipe: '面料截面放大示意：外面一排冷色风的箭头被面料挡住，里面是暖色区域', person: false },
  // Not a cross-section (10-15): one drawn with a padded middle layer gave thin shells cotton wadding they do not have.
  { id: 'heat-layers', kind: '原理示意', name: '锁温示意', recipe: '这件衣服真实面料的表面特写，厚薄和实物一致；面料外侧几道柔和的暖色光晕和向内的弧形箭头表示热量被留住；不画分层截面、棉絮、羽绒、蓬松夹层等素材里没有的结构', person: false },
  { id: 'lining-open', kind: '部位特写', name: '掀开看内里', recipe: '衣襟掀开一角，露出里面的保暖内里，旁边一个升温小图标', person: false },
  { id: 'scissors', kind: '效果演示', name: '剪刀测试', recipe: '剪刀尖用力抵在面料上，面料完好没有破口', person: false },
  { id: 'stretch-arm', kind: '效果演示', name: '抬手不紧绷', recipe: '模特大幅度抬手伸展，衣服不紧绷、下摆不上提', person: true },
  { id: 'stretch-fabric', kind: '效果演示', name: '双手拉伸', recipe: '两只手把面料向两侧拉开，面料有弹性地回弹', person: false },
  { id: 'feather', kind: '效果演示', name: '轻轻拎起', recipe: '一只手两根手指轻松拎起整件衣服', person: false },
  { id: 'pocket-phone', kind: '效果演示', name: '手机放进口袋', recipe: '模特把手机放进侧边拉链口袋，旁边一个圆角放大框显示口袋', person: true },
  { id: 'pocket-open', kind: '部位特写', name: '口袋打开', recipe: '侧边口袋拉链拉开，里面放着手机和钥匙', person: false },
  { id: 'detach', kind: '效果演示', name: '内胆分开摆', recipe: '外套和内胆分开平铺并排，示意可以拆开穿', person: false },
  { id: 'logo-positions', kind: '原理示意', name: '印制位置图', recipe: '衣服正面和背面的简洁线稿并排，用圆圈标出胸口、袖口、后背三个可以印 logo 的位置', person: false },
  { id: 'logo-closeup', kind: '部位特写', name: '刺绣特写', recipe: '胸口刺绣工艺的微距特写，线迹清晰立体，绣的是"LOGO"四个字母', person: false },
  { id: 'icon-text', kind: '图标文字', name: '图标加一句话', recipe: '一个简洁的线描图标配一句短文字', person: false },
  { id: 'swatches', kind: '图标文字', name: '色块排列', recipe: '一排圆形色块，每个色块下写颜色名', person: false },
  { id: 'team-scene', kind: '场景', name: '团队合影', recipe: '几位同事穿同款站在一起，干净明亮的工作场景', person: true },
  { id: 'part', kind: '部位特写', name: '部位特写', recipe: '{part}的近距离特写，缝线和结构清楚', person: false, part: true },
];

export const proofById = (id: string) => PROOFS.find(p => p.id === id);
/** The recipe with the garment part filled in. */
export const recipeOf = (proof: Proof, part = '') => proof.recipe.replace('{part}', part || '这个部位');
