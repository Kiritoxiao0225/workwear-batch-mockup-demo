import type { ProductionUnit } from '@/lib/wps-production';
import { currentArtworkWarnings } from '@/lib/artwork-current-warnings';

const headings = { difference: '发现不一致', uncertain: '存在疑点', unavailable: '自动核对未完成', pending: '待人工核对' };
export function WpsArtworkWarnings({ unit, fixed = false, preview }: {
  unit: ProductionUnit; fixed?: boolean; preview?: (url: string, title: string) => void;
}) {
  const warnings = currentArtworkWarnings(unit, fixed);
  if (!warnings.length) return null;
  return <section className="wps-current-artwork-warnings" aria-label={`${unit.garmentLabel}当前图稿核对提醒`}>
    <strong>{unit.garmentLabel} · 当前图稿核对</strong>
    {warnings.map((warning, index) => <p key={index} data-review-kind={warning.kind} role={warning.kind === 'difference' ? 'alert' : 'status'}>
      <b>{headings[warning.kind]} · {warning.label}：</b>{warning.message}
    </p>)}
    {preview && unit.artwork && <button type="button" onClick={() => preview(unit.artwork!.url, `${unit.garmentLabel} · 当前图稿`)}>放大核对当前图稿</button>}
    <small>这些提醒不妨碍编辑保存或人工确认。接受差异时请在逐项核对中留下说明。</small>
  </section>;
}
