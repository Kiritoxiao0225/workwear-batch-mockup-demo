import { WpsProductionClient } from '@/components/wps-production-client';

export default function WpsProductionPage() {
  return <><nav aria-label="生产台视图" style={{ padding: '12px 24px', background: '#eef4f0' }}><a href="/wps-production/overview">打开精简总览 · 预检、续做、旧单差异与只重合成</a><span style={{ marginLeft: 16 }}>当前：完整编辑台（所有原有编辑功能保留）</span></nav><WpsProductionClient /></>;
}
