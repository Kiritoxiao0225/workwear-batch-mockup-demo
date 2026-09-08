import type { SourceTaskRecord, TaskMaterial } from '@/lib/batch-task-review';

function sourceMaterial(id: string, name: string, sourceUrl: string): TaskMaterial {
  return { id, name, description: name, previewUrl: sourceUrl, url: sourceUrl };
}

// Original evidence only. AI summaries, inferred roles, prompts and candidates
// must be regenerated and must never be persisted in this source snapshot.
const SOURCE_TASK_SNAPSHOT: SourceTaskRecord[] = [
  {
    recordId: 'snapshot-01', customerId: '张海健csj', revision: '第1次',
    requirementText: '货号:B01SD-活力黑- 左胸:1+poppy手机数码（logo做绿色的吧） 后背: 字体: 颜色: 工艺: 尺寸:',
    productStyleText: 'B01SD-活力黑',
    materials: [sourceMaterial('snapshot-01-m1', '图1', '/task-review-originals/row1-1.png')],
  },
  {
    recordId: 'snapshot-02', customerId: '王毛毛201012', revision: '第1次',
    requirementText: '货号:719SF-黑色 B01SD-月牙白-L 左胸: 冲锋衣:图一 POLO衫:研+图5+2026【参考图四】 后背: 冲锋衣:宜宾学院研究生会志愿者【做扇形】下面加图二+奉献、友爱、互助、进步',
    productStyleText: '719SF-黑色；B01SD-月牙白-L',
    materials: [
      sourceMaterial('snapshot-02-m1', '图1', '/task-review-originals/row2-1.png'),
      sourceMaterial('snapshot-02-m2', '图2', '/task-review-originals/row2-2.png'),
      sourceMaterial('snapshot-02-m3', '图3', '/task-review-originals/row2-3.png'),
      sourceMaterial('snapshot-02-m4', '图4', '/task-review-originals/row2-4.png'),
      sourceMaterial('snapshot-02-m5', '图5', '/task-review-originals/row2-5.png'),
    ],
  },
  {
    recordId: 'snapshot-03', customerId: '李达映700905', revision: '第2次',
    requirementText: '301SRX-黑色 正面 图一 后背 图一前三排 按照图二做',
    productStyleText: '301SRX-黑色',
    materials: [
      sourceMaterial('snapshot-03-m1', '图1', '/task-review-originals/row3-1.png'),
      sourceMaterial('snapshot-03-m2', '图2', '/task-review-originals/row3-2.png'),
    ],
  },
  {
    recordId: 'snapshot-04', customerId: '月城雪兔哥哥', revision: '第1次',
    requirementText: '后背:图一图二各出一版',
    productStyleText: '原表截图未完整显示，需从 WPS 实时记录确认',
    materials: [
      sourceMaterial('snapshot-04-m1', '图1', '/task-review-originals/row4-1.png'),
      sourceMaterial('snapshot-04-m2', '图2', '/task-review-originals/row4-2.png'),
    ],
  },
  {
    recordId: 'snapshot-05', customerId: 'tb930638896', revision: '第1次',
    requirementText: '货号:9600SRX-大红 左胸:图一',
    productStyleText: '9600SRX-大红',
    materials: [sourceMaterial('snapshot-05-m1', '图1', '/task-review-originals/row5-1.png')],
  },
];

export function sourceTaskSnapshot(): SourceTaskRecord[] {
  return structuredClone(SOURCE_TASK_SNAPSHOT);
}
