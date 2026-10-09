/**
 * The 落霞橙 workwear jacket the new 电商主图 pages are tried on before the server writes this
 * material itself: the points as the AI would read them, six colours and the structure parts.
 * Used by the rule tests and the local demo page only.
 */
import type { MaterialsForPlan } from '../draft';

export const DEMO_MATERIAL: MaterialsForPlan = {
  category: 'workwear',
  categoryWhy: '素材里写了企业团体定制、一件起订，主图上有印 logo 的位置示意',
  // What the AI saw on the garment for the kinds of point competitors show and the material does not.
  checks: [
    { concept: 'windproof', seen: '看不出', why: '立领、袖口收口，但面料厚度看不出来' },
    { concept: 'warm', seen: '不像', why: '单层薄款，没看到内胆、加绒或填充' },
  ],
  titles: {
    功能: ['三防面料 雨天不怕', '一件扛住日常活'],
    细节: ['细节经得起看', '做工看得见'],
    服务: ['企业定制 省心省事', '定制服务全包'],
    场景: ['穿上就是一个团队', '上班通勤都合适'],
  },
  points: [
    { type: '定位', text: '轻盈抗造工作服', note: '', concept: null, why: '主图和详情页首屏的大标题', from: ['M1', 'M2'] },
    { type: '面料', text: '三防面料', note: '防水防油防污 雨天更安心', concept: 'triple', why: '5 张图都在讲', from: ['M1', 'M5', 'M9'] },
    { type: '功能', text: '水珠易擦净', note: '泼水轻擦就干净', concept: 'stain', proof: 'wipe-clean', why: '有水珠演示图', from: ['M5'] },
    { type: '功能', text: '透气好活动', note: '', concept: 'breathable', why: '首图标签', from: ['M1', 'M6'] },
    { type: '功能', text: '抗撕裂', note: '日常干活不怕刮', concept: 'abrasion', why: '首图标签', from: ['M1'] },
    { type: '做工', text: '利落立领', note: '', concept: 'collar', part: '立领', why: '细节图第一格', from: ['M8'] },
    { type: '做工', text: '顺手拉链', note: '', concept: 'zipper', part: '门襟拉链', why: '细节图', from: ['M8'] },
    { type: '实用', text: '双侧拉链口袋', note: '手机钥匙放得稳', concept: 'pocket', part: '口袋', why: '有单独一张演示图', from: ['M7'] },
    { type: '做工', text: '贴腕袖口', note: '', concept: 'cuff', part: '袖口', why: '细节图', from: ['M8'] },
    { type: '服务定制', text: '企业团体定制', note: '', concept: 'logo', why: '首图副标题', from: ['M1'] },
    { type: '服务定制', text: '一件起订', note: '', concept: 'moq', why: '首图副标题', from: ['M1'] },
    { type: '颜色款式', text: '男女同款', note: '', concept: null, why: 'SKU 图标签', from: ['M20'] },
    { type: '人群场景', text: '物业工厂4S店都合适', note: '', concept: null, why: '详情页一屏', from: ['M12'] },
  ],
  colors: [
    { name: '落霞橙', hex: '#d98a1c', pick: 'M30' }, { name: '黑色', hex: '#1d1d1f', pick: 'M31' }, { name: '北欧蓝', hex: '#24365c', pick: 'M32' },
    { name: '石苔灰', hex: '#b8bbb4', pick: 'M33' }, { name: '未来白', hex: '#ecebe6', pick: 'M34' }, { name: '橙色', hex: '#ef5a1c', pick: 'M35' },
  ],
  parts: [{ part: '正面全身', pick: 'M30' }, { part: '立领', pick: 'M40' }, { part: '门襟拉链', pick: 'M41' }, { part: '口袋', pick: 'M42' }, { part: '面料', pick: 'M44' }],
};
