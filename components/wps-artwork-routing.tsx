import { artworkInputSelection } from '@/lib/artwork-reference';
import { ARTWORK_METHODS, ARTWORK_ROUTING_STANDARD, artworkClarityLabel, type ArtworkMethod } from '@/lib/artwork-routing-standard';
import { productionArtworkRouting, productionRecipe } from '@/lib/production-recipe';
import type { SourceTaskRecord } from '@/lib/batch-task-review';
import type { ProductionUnit } from '@/lib/wps-production';
import { artworkAcceptanceIssues } from '@/lib/artwork-acceptance';
import { ARTWORK_METHOD_OPTIONS, artworkMethodIssue, type ArtworkMethodChoice } from '@/lib/artwork-routing-request';

export function WpsArtworkMethodSelector({ unit, source, busy, change }: { unit: ProductionUnit; source: SourceTaskRecord; busy: boolean; change: (method: ArtworkMethodChoice) => void }) {
  const routing = productionArtworkRouting({ ...unit, artworkMethod: 'auto', route: 'auto' }, source);
  const selected = unit.artworkMethod ?? ({ deterministic: 'preserve', hybrid: 'compose', model: 'generate' } as const)[unit.route as 'deterministic' | 'hybrid' | 'model'] ?? 'auto';
  const recommendation = routing.decision.method ? ARTWORK_METHODS[routing.decision.method].label : null;
  const input = { generationPrompt: unit.generationPrompt, sourceRequirementText: source.requirementText, printPlacement: unit.placement ?? undefined, instruction: unit.instruction, layoutNote: unit.layoutNote, exactText: unit.textMode === 'replace' ? unit.exactText : '', primaryImageLabel: artworkInputSelection(source, unit).primaryImageLabel, primaryImageRole: artworkInputSelection(source, unit).primaryImageRole, sourceScope: unit.sourceScope, processingRoute: 'auto' as const, referenceImages: artworkInputSelection(source, unit).referenceMaterialIds.map(id => ({ label: `图${source.materials.findIndex(material => material.id === id) + 1}` })) };
  return <div className="wps-method-selector"><label>处理方式<select aria-label={`${unit.id} 处理方式`} disabled={busy} value={unit.route === 'gpt-image-2' ? 'gpt-image-2' : selected} onChange={event => change(event.target.value as ArtworkMethodChoice)}>
    {ARTWORK_METHOD_OPTIONS.map(method => {
      const issue = artworkMethodIssue(input, method);
      const label = method === 'auto' ? `自动推荐 · ${routing.decision.state === 'review' ? '待核对' : recommendation ?? (routing.decision.state === 'pending' ? '待检测' : '待补充资料')}` : ARTWORK_METHODS[method].label;
      return <option key={method} value={method} disabled={Boolean(issue)}>{label}{issue ? `（${issue}）` : method === routing.decision.method ? '（推荐）' : ''}</option>;
    })}
    {unit.route === 'gpt-image-2' && <option value="gpt-image-2">GPT Image 2（已有方案）</option>}
  </select></label><small>{selected === 'auto' ? '按客户需求分类；整理提示词不会切换处理方式。' : selected === 'redraw' ? '先核对纯色图案与保真修复结果，再执行重绘。' : ARTWORK_METHODS[selected].operation}</small></div>;
}

export function WpsArtworkRouting({ unit, source }: { unit: ProductionUnit; source: SourceTaskRecord }) {
  const { decision, historicalClarity, report } = productionArtworkRouting(unit, source);
  const method = decision.method ? ARTWORK_METHODS[decision.method] : null;
  const actual = productionRecipe(unit, source).actualLabel;
  const validation = unit.artwork?.validation;
  const acceptanceIssues = validation ? artworkAcceptanceIssues(validation) : [];
  const oldReport = report && report.graphic.protocol !== ARTWORK_ROUTING_STANDARD.scoreProtocol;
  const redrawFailed = report?.redraw?.status === 'failed' || (report?.graphicMethod !== 'redraw' && report?.reviewReasons.some(reason => reason.startsWith('高清重绘未完成')));
  const referenceColor = unit.artwork?.draft?.preprocessing.referenceColor;
  return <section className="wps-artwork-routing" aria-label="图案处理方案与判断标准">
    <header><span>当前处理方案</span><span className={`wps-routing-status ${redrawFailed ? 'review' : decision.state}`}>{redrawFailed ? 'B 重绘未完成' : decision.state === 'ready' ? '条件已明确' : decision.state === 'pending' ? '待检测' : '待核对'}</span></header>
    {redrawFailed && <p className="error-banner" role="status">重绘处理失败，当前显示的是 A 保真候选，尚未完成“重绘＋净化”。{report?.redraw?.error}</p>}
    <strong>{method ? `${method.code} · ${method.label}` : '待补充资料'}</strong>
    <p className="wps-routing-reason">{decision.reason}</p>
    {historicalClarity !== null && <p className="wps-routing-note">原图旧记录：blur 原值 {historicalClarity.toFixed(2)}，不能当作清晰度。当前图案需重新检测画质。</p>}
    {method && <div className="wps-routing-criteria"><b>本方案的判断标准</b><ul>{method.criteria.map(criterion => <li key={criterion}>{criterion}</li>)}</ul></div>}
    <div className="wps-routing-execution"><b>当前实际处理</b><p>{actual ?? (unit.artwork ? '手动上传或未记录处理服务' : '尚未制作')}</p>
      {referenceColor && <div><b>本次制作采用的参考色</b><p><span aria-hidden="true" style={{ display: 'inline-block', width: 20, height: 20, verticalAlign: 'middle', marginRight: 8, backgroundColor: referenceColor.hex, border: '1px solid #aaa' }} />{referenceColor.hex} · 来源：{referenceColor.label}</p><p>{referenceColor.description}</p><small>按参考照片的像素近似取色。可在图案编辑器中调整颜色；编辑后的颜色以当前图案为准。</small></div>}
      {unit.artwork?.draft?.preprocessing.edgeRefinement && <><p>{unit.artwork.draft.preprocessing.edgeRefinement}</p><p className="wps-routing-note">仅完整、连续的单色圆形外框自动净边；非圆形、断边或镂空图案保持原样。</p></>}
      {(report || validation) && <dl className="wps-routing-scores">
        <div><dt>原图</dt><dd>{report ? artworkClarityLabel(report.source) : '未按新标准检测'}</dd></div>
        <div><dt>保真修复后</dt><dd>{report?.repair ? artworkClarityLabel(report.repair) : report ? '未执行修复' : '未记录'}</dd></div>
        {report && <div><dt>处理后主体</dt><dd>{artworkClarityLabel(report.graphic)}</dd></div>}
        <div><dt>最终 PNG</dt><dd>{validation?.quality ? artworkClarityLabel(validation.quality) : validation?.qualityError ? '检测未完成' : '未检测'}</dd></div>
        {validation?.quality?.rawBlur !== undefined && <div><dt>接口原始模糊度</dt><dd>{validation.quality.rawBlur.toFixed(2)} / 100（越低越清晰）</dd></div>}
        {validation?.quality && <><div><dt>有效图案</dt><dd>{validation.quality.subjectWidth} × {validation.quality.subjectHeight}px</dd></div><div><dt>目标放大</dt><dd>{validation.quality.requiredScale.toFixed(2)} 倍 / ≤1.25</dd></div><div><dt>综合画质</dt><dd>{validation.quality.vqscore.toFixed(2)} 分（另项）</dd></div></>}
      </dl>}
      {validation && <p className={acceptanceIssues.length ? 'wps-routing-note' : ''}>{acceptanceIssues.length ? `验收待完成：${acceptanceIssues.join('；')}` : '自动画质检查通过；仍需人工核对图形、文字和颜色。'}</p>}
      {oldReport ? <p className="wps-routing-note">以上为历史处理记录，旧评分方向及其失败结论已停用。当前验收以重新检测结果为准。</p> : report?.reviewReasons.map(reason => <p className="wps-routing-note" key={reason}>{reason}</p>)}
    </div>
    <details className="wps-routing-all"><summary>本图的逐项判断依据</summary><dl>{decision.checks.map(check => <div key={check.label} className={check.state}><dt>{check.label}</dt><dd>{check.value}</dd></div>)}</dl></details>
    <details className="wps-routing-all"><summary>查看四种方案与统一标准</summary>
      <p>制作按钮按以下标准实际执行。每次最多保真修复一次、高清重绘一次；未达标保留候选，转人工核对。</p>
      <p>先核对资料，再按需求判断：D 整图生成 → C 图文组合 → A 原图保真；A 修复仍不达标且满足适用条件时，转 B 高清重绘。</p>
      {(Object.entries(ARTWORK_METHODS) as Array<[ArtworkMethod, typeof ARTWORK_METHODS[ArtworkMethod]]>).map(([id, rule]) => <div key={id}><b>{rule.code} · {rule.label}</b><ul>{rule.criteria.map(criterion => <li key={criterion}>{criterion}</li>)}</ul><p>{rule.operation}</p></div>)}
      <p>评分口径：有效图案长边统一为 {ARTWORK_ROUTING_STANDARD.targetLongEdge}px，保持比例、铺白底。标准版接口 blur 是模糊度，越低越清晰；页面清晰度按 100 − blur 换算，并保留原始值。综合画质另列，不代替模糊检测。</p>
      <p>统一验收：清晰度 ≥ {ARTWORK_ROUTING_STANDARD.clarityMinimum}；透明检查通过；人工核对文字、图形、颜色和排版。缺少任何证据，都不能标为全部达标。80 分是本项目的验收目标。</p>
      <p>规则版本：{decision.version}。照片、渐变和含白色前景的图案不套用纯色 Logo 净化。</p>
      {report && <p>本次执行：{report.operations.join(' → ')}。记录：{report.runId}</p>}
    </details>
  </section>;
}
