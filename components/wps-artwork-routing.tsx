import { fontReferenceInput } from '@/lib/artwork-font-reference';
import { artworkInputSelection } from '@/lib/artwork-reference';
import { ARTWORK_METHODS, type ArtworkMethod } from '@/lib/artwork-routing-standard';
import { productionArtworkRouting, productionRecipe } from '@/lib/production-recipe';
import type { SourceTaskRecord } from '@/lib/batch-task-review';
import type { ProductionUnit } from '@/lib/wps-production';
import { artworkAcceptanceIssues } from '@/lib/artwork-acceptance';
import { ARTWORK_METHOD_OPTIONS, artworkMethodIssue, type ArtworkMethodChoice } from '@/lib/artwork-routing-request';

export function WpsArtworkMethodSelector({ unit, source, busy, change }: { unit: ProductionUnit; source: SourceTaskRecord; busy: boolean; change: (method: ArtworkMethodChoice) => void }) {
  const routing = productionArtworkRouting({ ...unit, artworkMethod: 'auto', route: 'auto' }, source);
  const selected = unit.artworkMethod ?? ({ deterministic: 'preserve', hybrid: 'compose', model: 'generate' } as const)[unit.route as 'deterministic' | 'hybrid' | 'model'] ?? 'auto';
  const recommendation = routing.decision.method ? ARTWORK_METHODS[routing.decision.method].label : null;
  const input = { fontReference: fontReferenceInput(source, unit), sourceAssessment: unit.sourceAssessment ?? routing.facts.sourceAssessment, generationPrompt: unit.generationPrompt, sourceRequirementText: source.requirementText, printPlacement: unit.placement ?? undefined, instruction: unit.instruction, layoutNote: unit.layoutNote, exactText: unit.textMode === 'replace' ? unit.exactText : '', primaryImageLabel: artworkInputSelection(source, unit).primaryImageLabel, primaryImageRole: artworkInputSelection(source, unit).primaryImageRole, sourceScope: unit.sourceScope, processingRoute: 'auto' as const, referenceImages: artworkInputSelection(source, unit).referenceMaterialIds.map(id => ({ label: `图${source.materials.findIndex(material => material.id === id) + 1}` })) };
  return <div className="wps-method-selector"><label>处理方式<select aria-label={`${unit.id} 处理方式`} disabled={busy} value={unit.route === 'gpt-image-2' ? 'gpt-image-2' : selected} onChange={event => change(event.target.value as ArtworkMethodChoice)}>
    {ARTWORK_METHOD_OPTIONS.map(method => {
      const issue = artworkMethodIssue(input, method);
      const label = method === 'auto' ? `自动推荐 · ${routing.decision.state === 'review' ? '待核对' : recommendation ?? (routing.decision.state === 'pending' ? '待检测' : '待补充资料')}` : ARTWORK_METHODS[method].label;
      return <option key={method} value={method} disabled={Boolean(issue)}>{label}{issue ? `（${issue}）` : method === routing.decision.method ? '（推荐）' : ''}</option>;
    })}
    {unit.route === 'gpt-image-2' && <option value="gpt-image-2">GPT Image 2（已有方案）</option>}
  </select></label><small>{selected === 'auto' ? '先识别素材与目标，再按客户需求选择处理方式。' : selected === 'redraw' ? '实物表面图案按原设计重建；低清图按需要保真增强。' : ARTWORK_METHODS[selected].operation}</small></div>;
}

export function WpsArtworkRouting({ unit, source }: { unit: ProductionUnit; source: SourceTaskRecord }) {
  const { decision, report } = productionArtworkRouting(unit, source);
  const method = decision.method ? ARTWORK_METHODS[decision.method] : null;
  const actual = productionRecipe(unit, source).actualLabel;
  const validation = unit.artwork?.validation;
  const acceptanceIssues = validation ? artworkAcceptanceIssues(validation) : [];
  const oldReport = report && report.version !== 'artwork-routing-v4';
  const redrawFailed = report?.redraw?.status === 'failed' || (report?.graphicMethod !== 'redraw' && report?.reviewReasons.some(reason => reason.startsWith('高清重绘未完成')));
  const referenceColor = unit.artwork?.draft?.preprocessing.referenceColor;
  return <section className="wps-artwork-routing" aria-label="图案处理方案与判断标准">
    <header><span>当前处理方案</span><span className={`wps-routing-status ${redrawFailed ? 'review' : decision.state}`}>{redrawFailed ? 'B 重绘未完成' : decision.state === 'ready' ? '条件已明确' : decision.state === 'pending' ? '待检测' : '待核对'}</span></header>
    {redrawFailed && <p className="error-banner" role="status">重绘处理失败，当前显示的是 A 保真候选，尚未完成“重绘＋净化”。{report?.redraw?.error}</p>}
    <strong>{method ? `${method.code} · ${method.label}` : '待补充资料'}</strong>
    <p className="wps-routing-reason">{decision.reason}</p>
    {method && <div className="wps-routing-criteria"><b>本方案的判断标准</b><ul>{method.criteria.map(criterion => <li key={criterion}>{criterion}</li>)}</ul></div>}
    <div className="wps-routing-execution"><b>当前实际处理</b><p>{actual ?? (unit.artwork ? '手动上传或未记录处理服务' : '尚未制作')}</p>
      {referenceColor && <div><b>本次制作采用的参考色</b><p><span aria-hidden="true" style={{ display: 'inline-block', width: 20, height: 20, verticalAlign: 'middle', marginRight: 8, backgroundColor: referenceColor.hex, border: '1px solid #aaa' }} />{referenceColor.hex} · 来源：{referenceColor.label}</p><p>{referenceColor.description}</p><small>按参考照片的像素近似取色。可在图案编辑器中调整颜色；编辑后的颜色以当前图案为准。</small></div>}
      {unit.artwork?.draft?.preprocessing.edgeRefinement && <><p>{unit.artwork.draft.preprocessing.edgeRefinement}</p><p className="wps-routing-note">仅完整、连续的单色圆形外框自动净边；非圆形、断边或镂空图案保持原样。</p></>}
      {report && <dl className="wps-routing-scores">
        <div><dt>原主体像素</dt><dd>{report.source.subjectWidth} × {report.source.subjectHeight}px</dd></div>
        <div><dt>处理后主体</dt><dd>{report.graphic.subjectWidth} × {report.graphic.subjectHeight}px</dd></div>
        <div><dt>尺寸参考</dt><dd>{report.graphic.targetBasis ?? '按当前使用尺寸核对'}</dd></div>
        <div><dt>增强处理</dt><dd>{report.repair ? '已保真增强一次' : report.operations.some(item => item.includes('保真增强')) ? '见实际处理记录' : '未执行'}</dd></div>
      </dl>}
      {validation && <p>{acceptanceIssues.length ? `文件或制作步骤待完成：${acceptanceIssues.join('；')}` : '图片已保存，可继续编辑、上衣和人工确认；请核对文字、图形与颜色。'}</p>}
      {oldReport && <p className="wps-routing-note">历史评分只保留在原处理记录中，不再决定增强、重绘或放行。</p>}
    </div>
    <details className="wps-routing-all"><summary>本图的逐项判断依据</summary><dl>{decision.checks.map(check => <div key={check.label} className={check.state}><dt>{check.label}</dt><dd>{check.value}</dd></div>)}</dl></details>
    <details className="wps-routing-all"><summary>查看四种方案与统一标准</summary>
      <p>先识别目标及其原始像素，按实际尺寸和已确认的模糊、压缩损伤决定是否增强。每张图片最多自动保真增强一次，低清不触发自动重绘。</p>
      {(Object.entries(ARTWORK_METHODS) as Array<[ArtworkMethod, typeof ARTWORK_METHODS[ArtworkMethod]]>).map(([id, rule]) => <div key={id}><b>{rule.code} · {rule.label}</b><ul>{rule.criteria.map(criterion => <li key={criterion}>{criterion}</li>)}</ul><p>{rule.operation}</p></div>)}
      <p>不使用数字评分。不确定或明确的内容差异均提示人工核查；完整可用的图片继续保存、编辑和上衣。文件缺失、损坏或空白才属于制作未完成。</p>
      <p>规则版本：{decision.version}。实拍重建保留图案自身的白色与渐变，不套用纯色 Logo 净化。</p>
      {report && <p>本次执行：{report.operations.join(' → ')}。记录：{report.runId}</p>}
    </details>
  </section>;
}
