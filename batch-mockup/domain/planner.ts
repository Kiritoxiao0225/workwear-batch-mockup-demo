import type { Requirement, ProductionPlan, PlannedStep, StepInput, CheckSpec, ComponentSpec } from './contracts';
import { hashStable, pixelMeaning } from './helpers';
import { requirementSchema, semanticIssues } from './validation';
export function planArtwork(input: Requirement, artworkId: string): ProductionPlan {
    const r: Requirement = requirementSchema.parse(input), a = r.artworks.find(a => a.id === artworkId);
    if (!a)
        throw new Error(`图稿不存在：${artworkId}`);
    const uses = r.materialUses.filter(u => u.artworkId === a.id && u.role !== 'excluded');
    const scope = new Set([r.id, a.id, ...a.components.map(c => c.id), ...uses.flatMap(u => [u.id, u.materialId]), ...a.changes.map(c => c.id), ...a.requiredChecks.map(c => c.id)]);
    const blockers = [...r.issues, ...semanticIssues(r)].filter(i => i.severity === 'blocking' && !i.resolution && i.stage !== 'mockup' && scope.has(i.targetId));
    if (blockers.length)
        throw new Error(blockers.map(i => `${i.code}: ${i.message}`).join('；'));
    const checks: CheckSpec[] = structuredClone(a.requiredChecks), steps: PlannedStep[] = [], skipped: ProductionPlan['skipped'] = [];
    function check(category: CheckSpec['category'], targetId: string, expected: string, referenceUseIds: string[] = [], evidenceIds: string[] = []) { const value = { category, targetId, expected, referenceUseIds, evidenceIds }; const id = `check-${hashStable(value).slice(0, 20)}`; if (!checks.some(c => c.category === category && c.targetId === targetId && c.expected === expected && hashStable(c.referenceUseIds) === hashStable(referenceUseIds)))
        checks.push({ id, ...value }); }
    for (const c of a.components) {
        check(c.kind === 'text' ? 'text' : 'graphic', c.id, c.kind === 'text' ? (c.content.kind === 'exact' ? c.content.value : '保留原始字形；可读转录仅供核对，不用于重画') : c.description || '原始图形内容完整保留');
        if (c.kind === 'text')
            check('font', c.id, `字体策略 ${c.font.strategy}；主字体 ${c.font.primaryFontAssetId ?? '无'}；后备 ${c.font.fallbackFontAssetIds.join(',') || '无'}；${c.font.fallbackPolicy}`, c.font.referenceUseIds, c.font.evidenceIds);
    }
    for (const u of uses) {
        check(u.role === 'font' || u.role === 'color' || u.role === 'layout' ? u.role : 'graphic', u.componentId ?? a.id, `${u.role}参考：${u.instruction || '按已绑定素材核对'}；选区 ${JSON.stringify(u.selection)}`, [u.id], u.evidenceIds);
    }
    check('background', a.id, `外底 ${a.background.exterior}；保留 ${a.background.preserveDescription}；保护区域 ${JSON.stringify(a.background.preserveRegions)}；仅删除指定内部区域 ${JSON.stringify(a.background.removeRegions)}`);
    check('layout', a.id, `组件顺序 ${a.layout.componentOrder.join(' → ')}；布局 ${a.layout.kind}`, a.layout.referenceUseIds, a.layout.evidenceIds);
    check('file', a.id, 'PNG 可解码、文件 SHA 与记录一致；透明背景必须检查真实 Alpha');
    function add(kind: PlannedStep['kind'], componentIds: string[], inputs: StepInput[], reason: string, execution: PlannedStep['execution'] = 'local', condition: PlannedStep['condition'] = 'always', extraDeps: string[] = []) {
        const dependsOn = [...new Set([...extraDeps, ...inputs.flatMap(i => i.kind === 'step-output' ? [i.stepId] : [])])];
        const id = `step-${hashStable({ artwork: artworkId, kind, componentIds, inputs, reason }).slice(0, 24)}`;
        const changes = a!.changes.filter(c => componentIds.includes(c.componentId));
        steps.push({ id, kind, componentIds, inputs, dependsOn, instruction: reason, reason, execution, condition, authorizedChangeIds: changes.map(c => c.id), checkIds: checks.filter(c => componentIds.includes(c.targetId) || c.targetId === a!.id).map(c => c.id) });
        return id;
    }
    const output = (stepId: string): StepInput => ({ kind: 'step-output', stepId, output: 'images' });
    const inspect = uses.length ? add('inspect-source', [], uses.map(u => ({ kind: 'material-use', useId: u.id })), '核对每张素材用途、原始内容和参考角色；说明图不得成为内容') : null;
    const finals: string[] = [];
    for (const c of a.components) {
        const cUses = uses.filter(u => u.componentId === c.id || u.componentId === null), contentIds = c.kind === 'graphic' ? c.contentUseIds : c.content.kind === 'preserve-source' ? [c.content.useId] : [];
        const sourceSteps = contentIds.map(useId => add('select', [c.id], [{ kind: 'material-use', useId }], `先按明确选区提取内容 ${useId}`, 'local', 'always', inspect ? [inspect] : []));
        let content: StepInput[] = sourceSteps.map(output);
        if (a.enhancement === 'if-needed' && content.length) {
            const enhance = add('enhance', [c.id], content, '仅在真实有效像素不足时高清放大一次；不得改变原有文字与图形', 'provider', 'resolution-insufficient');
            content = [output(enhance)];
        }
        else
            skipped.push({ kind: 'enhance', componentIds: [c.id], reason: content.length ? '已明确禁用增强' : '本地文字直接按目标清晰度排版，无需放大位图' });
        const references: StepInput[] = cUses.filter(u => !contentIds.includes(u.id) && u.role !== 'annotation').map(u => ({ kind: 'material-use', useId: u.id }));
        const annotation: StepInput[] = cUses.filter(u => u.role === 'annotation').map(u => ({ kind: 'material-use', useId: u.id }));
        const mutating = a.changes.filter(ch => ch.componentId === c.id && ch.action.kind !== 'add-component');
        let result: string;
        if (c.kind === 'text' && c.content.kind === 'exact') {
            const local = c.font.strategy === 'available-font' && (!c.font.referenceUseIds.length || c.font.fallbackPolicy === 'report-substitution') && c.color.kind === 'solid';
            result = add(local ? 'render-text' : 'generate', [c.id], references, local ? '准确文字逐字排版，保留空格、换行；实际使用字体须记录' : '按准确文字及指定字体、颜色参考制作；参考图不得复制为内容', local ? 'local' : 'provider', 'always', inspect ? [inspect] : []);
            if (local && c.font.referenceUseIds.length)
                check('font', c.id, '使用指定可用字体作为后备；字体参考匹配仍待核对，禁止宣称完全一致', c.font.referenceUseIds);
        }
        else if (c.kind === 'graphic' && c.mode !== 'preserve' || mutating.length) {
            const mode = c.kind === 'graphic' ? c.mode : 'edit';
            result = add(mode === 'create' || mode === 'reconstruct' ? 'generate' : 'edit', [c.id], [...content, ...references, ...annotation], `执行明确授权变化 ${mutating.map(ch => JSON.stringify(ch)).join('；')}；${c.kind === 'graphic' ? c.description : '保留原字形'}；其余内容完整保留`, 'provider');
        }
        else {
            if (content.length !== 1)
                throw new Error(`组件 ${c.id} 的内容来源未形成唯一输出`);
            result = sourceSteps.at(-1)!;
            if (content[0].kind === 'step-output')
                result = content[0].stepId;
        }
        const needsCutout = !(c.kind === 'text' && c.content.kind === 'exact' && steps.find(s => s.id === result)?.kind === 'render-text');
        if (needsCutout && a.background.exterior === 'transparent')
            result = add('cutout', [c.id], [output(result)], `只去外部底色；${a.background.preserveDescription}；保护和内部删除区域必须按绑定原图处理`, a.background.preserveRegions.length || a.background.removeRegions.length ? 'provider' : 'local', 'background-remains');
        else
            skipped.push({ kind: 'cutout', componentIds: [c.id], reason: needsCutout ? '要求保留背景' : '文字直接输出真实透明 PNG' });
        finals.push(result);
    }
    const compose = add('compose-artwork', a.components.map(c => c.id), [...finals.map(output), ...a.layout.referenceUseIds.map(useId => ({ kind: 'material-use' as const, useId }))], '将所有指定内容组件按布局合成独立图稿；不能把颜色、字体或排版参考作为图层');
    add('review', a.components.map(c => c.id), [output(compose), ...uses.filter(u => u.role !== 'annotation').map(u => ({ kind: 'material-use' as const, useId: u.id }))], '对最终图稿逐项核对文字、原图、字体参考、颜色、布局、背景及文件；未核对项保持不确定');
    const artworkHash = hashStable({ artwork: pixelMeaning(a), uses: pixelMeaning(uses), unboundBytes: uses.some(u => !u.sourceArtifactSha256) ? r.sourceContentHash : null });
    return { id: `plan-${hashStable({ artworkHash, revision: r.revision }).slice(0, 24)}`, workspaceId: r.workspaceId, requirementId: r.id, requirementRevision: r.revision, requirementHash: hashStable(r), artworkId, artworkHash, plannerVersion: 'codex-m1-v1', steps, skipped, outputStepId: compose, checks };
}
export function componentUsesIds(c: ComponentSpec): string[] { return c.kind === 'graphic' ? c.contentUseIds : [...c.font.referenceUseIds, ...(c.content.kind === 'preserve-source' ? [c.content.useId] : []), ...(c.color.kind === 'reference' || c.color.kind === 'preserve' ? [c.color.useId] : [])]; }
