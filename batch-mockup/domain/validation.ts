import { z } from 'zod';
import type { Requirement, SourceSnapshot, Issue, ColorSpec } from './contracts';
import { problem } from './helpers';
const id = z.string().min(1), ids = z.array(id), sha = z.string().regex(/^[a-f0-9]{64}$/), finite = z.number().finite(), unit = finite.min(0).max(1), positive = finite.positive(), date = z.iso.datetime({ offset: true });
const region = z.object({ x: unit, y: unit, width: unit.positive(), height: unit.positive() }).strict().refine(r => r.x + r.width <= 1 + 1e-10 && r.y + r.height <= 1 + 1e-10, '选区越过原图边界');
const selection = z.discriminatedUnion('kind', [z.object({ kind: z.literal('whole') }).strict(), z.object({ kind: z.literal('region'), region }).strict(), z.object({ kind: z.literal('unknown'), reason: id }).strict()]);
const color = z.discriminatedUnion('kind', [z.object({ kind: z.literal('preserve'), useId: id }).strict(), z.object({ kind: z.literal('reference'), useId: id }).strict(), z.object({ kind: z.literal('solid'), rgba: z.tuple([finite.int().min(0).max(255), finite.int().min(0).max(255), finite.int().min(0).max(255), unit]), evidenceIds: ids }).strict(), z.object({ kind: z.literal('garment-contrast'), policyVersion: id }).strict(), z.object({ kind: z.literal('unknown'), issueId: id }).strict()]);
const size = z.object({ widthCm: positive.nullable(), heightCm: positive.nullable(), basis: z.enum(['explicit', 'same-sentence-unit', 'default', 'manual']), evidenceIds: ids }).strict();
const check = z.object({ id, category: z.enum(['text', 'graphic', 'font', 'color', 'layout', 'background', 'file', 'placement']), targetId: id, expected: id, referenceUseIds: ids, evidenceIds: ids }).strict();
const issue = z.object({ id, targetId: id, stage: z.enum(['interpret', 'artwork', 'mockup']), severity: z.enum(['blocking', 'advisory']), code: id, message: id, evidenceIds: ids, resolution: z.object({ actorId: id, explanation: id, at: date }).strict().nullable() }).strict();
const evidence = z.object({ id, origin: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('source-text'), sourceSnapshotId: id, start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict(),
        z.object({ kind: z.literal('user-amendment'), amendmentId: id, actorId: id, at: date }).strict(),
        z.object({ kind: z.literal('visual'), materialId: id, selection, observationId: id }).strict(),
        z.object({ kind: z.literal('default'), policy: id, version: id }).strict()
    ]), statement: id, certainty: z.enum(['explicit', 'observed', 'inferred', 'unknown']), supersedes: ids }).strict();
const use = z.object({ id, materialId: id, sourceArtifactSha256: sha.optional(), artworkId: id.nullable(), componentId: id.nullable(), role: z.enum(['content', 'font', 'color', 'layout', 'annotation', 'excluded']), selection, instruction: z.string(), evidenceIds: ids }).strict();
const component = z.discriminatedUnion('kind', [
    z.object({ id, kind: z.literal('text'), content: z.discriminatedUnion('kind', [z.object({ kind: z.literal('exact'), value: z.string().max(5000).refine(s => s.trim().length > 0, '准确文字不能为空'), evidenceIds: ids }).strict(), z.object({ kind: z.literal('preserve-source'), useId: id, readableTranscription: z.string().nullable(), evidenceIds: ids }).strict()]), font: z.object({ referenceUseIds: ids, primaryFontAssetId: id.nullable(), fallbackFontAssetIds: ids, strategy: z.enum(['preserve-source', 'available-font', 'reference-glyphs']), fallbackPolicy: z.enum(['report-substitution', 'require-match']), evidenceIds: ids }).strict(), color, layout: z.discriminatedUnion('kind', [z.object({ kind: z.literal('lines'), align: z.enum(['left', 'center', 'right']) }).strict(), z.object({ kind: z.literal('arc'), direction: z.enum(['up', 'down']), degrees: positive.max(180).nullable() }).strict()]) }).strict(),
    z.object({ id, kind: z.literal('graphic'), contentUseIds: ids, mode: z.enum(['preserve', 'edit', 'reconstruct', 'create']), description: z.string(), color }).strict()
]);
const change = z.object({ id, componentId: id, action: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('remove'), targetDescription: id }).strict(), z.object({ kind: z.literal('replace-text'), oldText: z.string().nullable(), replacementComponentId: id }).strict(), z.object({ kind: z.literal('add-component'), addedComponentId: id }).strict(), z.object({ kind: z.literal('recolor'), color }).strict(), z.object({ kind: z.literal('simplify'), removableFeatures: ids.min(1) }).strict(), z.object({ kind: z.literal('reconstruct'), targetDescription: id }).strict()
    ]), sourceUseId: id.nullable(), selection, evidenceIds: ids.min(1), preserve: z.array(z.string()) }).strict();
const artwork = z.object({ id, label: z.string(), components: z.array(component).min(1), changes: z.array(change), background: z.object({ exterior: z.enum(['transparent', 'preserve', 'unknown']), preserveRegions: z.array(z.object({ useId: id, region, description: id }).strict()), removeRegions: z.array(z.object({ useId: id, region, evidenceIds: ids.min(1) }).strict()), preserveDescription: z.string(), evidenceIds: ids }).strict(), layout: z.object({ kind: z.enum(['preserve', 'stack', 'row', 'positioned']), componentOrder: ids.min(1), referenceUseIds: ids, placements: z.array(z.object({ componentId: id, bounds: region, rotation: finite.min(-360).max(360) }).strict()), gapRatio: unit.nullable(), evidenceIds: ids }).strict(), enhancement: z.enum(['if-needed', 'disabled']), printSize: size.nullable(), requiredChecks: z.array(check) }).strict();
export const requirementSchema = z.object({ schemaVersion: z.literal('batch-mockup/1'), id, workspaceId: id, revision: z.number().int().positive(), sourceSnapshotId: id, sourceContentHash: sha, evidence: z.array(evidence), materialUses: z.array(use), artworks: z.array(artwork).min(1), garments: z.array(z.object({ id, label: z.string(), styleCode: z.string(), requestedColor: z.string(), variantId: id.nullable(), evidenceIds: ids }).strict()), applications: z.array(z.object({ id, artworkId: id, artworkVersionId: id.nullable(), garmentId: id, outputVariant: z.string(), placement: z.object({ face: z.enum(['front', 'back', 'left-sleeve', 'right-sleeve']), label: z.string(), size: size.nullable(), center: z.object({ x: unit, y: unit }).strict().nullable(), rotation: finite.min(-360).max(360), standardId: id.nullable(), baseAssetId: id.nullable(), baseAssetSha256: sha.nullable(), bodyWidthCm: positive.nullable(), bodyScaleEvidenceIds: ids }).strict() }).strict()), issues: z.array(issue), createdAt: date, createdBy: id }).strict();
export function semanticIssues(r: Requirement, source?: SourceSnapshot): Issue[] {
    const out: Issue[] = [], add = (target: string, code: string, message: string, stage: Issue['stage'] = 'artwork') => out.push(problem(target, code, message, stage));
    const arts = new Map(r.artworks.map(a => [a.id, a])), comps = new Map(r.artworks.flatMap(a => a.components.map(c => [c.id, { art: a.id, c }] as const))), uses = new Map(r.materialUses.map(u => [u.id, u])), ev = new Map(r.evidence.map(e => [e.id, e])), used = new Set<string>();
    const all = [r.id, ...r.evidence.map(x => x.id), ...r.materialUses.map(x => x.id), ...r.artworks.flatMap(a => [a.id, ...a.components.map(c => c.id), ...a.changes.map(c => c.id), ...a.requiredChecks.map(c => c.id)]), ...r.garments.map(x => x.id), ...r.applications.map(x => x.id), ...r.issues.map(x => x.id)];
    const seen = new Set<string>();
    for (const value of all) {
        if (seen.has(value))
            add(r.id, 'duplicate-id', `标识重复：${value}`, 'interpret');
        seen.add(value);
    }
    if (source && (r.sourceSnapshotId !== source.id || r.workspaceId !== source.workspaceId || r.sourceContentHash !== source.contentHash))
        add(r.id, 'source-mismatch', '需求与原始来源版本或工作区不一致', 'interpret');
    const checkEvidence = (refs: string[], target: string, stage: Issue['stage'] = 'artwork') => { for (const ref of refs)
        if (!ev.has(ref))
            add(target, 'dangling-evidence', `证据不存在：${ref}`, stage); };
    // Every nested evidence list is checked, including sizes, changes and background masks.
    function walk(v: unknown, target: string, stage: Issue['stage'] = 'artwork') { if (Array.isArray(v)) {
        v.forEach(x => walk(x, target, stage));
        return;
    } if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        const t = typeof o.id === 'string' ? o.id : target;
        for (const [k, x] of Object.entries(o)) {
            if (k === 'evidenceIds' || k === 'bodyScaleEvidenceIds')
                checkEvidence(x as string[], t, stage);
            else if (k !== 'evidence')
                walk(x, t, k === 'applications' || k === 'garments' ? 'mockup' : stage);
        }
    } }
    walk(r, r.id);
    for (const e of r.evidence) {
        checkEvidence(e.supersedes, r.id, 'interpret');
        if (e.supersedes.includes(e.id))
            add(r.id, 'evidence-cycle', '证据不能替代自身', 'interpret');
        const origin = e.origin;
        if (origin.kind === 'source-text' && (origin.sourceSnapshotId !== r.sourceSnapshotId || origin.end <= origin.start || source && origin.end > source.requirementText.length))
            add(r.id, 'evidence-span', '原文证据范围无效', 'interpret');
        if (origin.kind === 'visual' && source && !source.materials.some(m => m.id === origin.materialId))
            add(r.id, 'visual-source-missing', '视觉证据素材不存在', 'interpret');
    }
    const visiting = new Set<string>(), visited = new Set<string>();
    function visitEvidence(id: string) { if (visiting.has(id)) {
        add(r.id, 'evidence-cycle', '证据替代关系形成循环', 'interpret');
        return;
    } if (visited.has(id))
        return; visiting.add(id); ev.get(id)?.supersedes.forEach(visitEvidence); visiting.delete(id); visited.add(id); }
    r.evidence.forEach(e => visitEvidence(e.id));
    function ref(useId: string, art: string, component: string | null, role?: string) { const u = uses.get(useId); if (!u) {
        add(component ?? art, 'dangling-use', `缺少素材用途：${useId}`);
        return;
    } used.add(useId); if (u.artworkId !== art || (u.componentId !== null && u.componentId !== component) || role && u.role !== role || u.role === 'annotation' || u.role === 'excluded')
        add(component ?? art, 'reference-scope', `素材 ${useId} 的用途或所属范围不匹配`); }
    function checkColor(c: ColorSpec, art: string, component: string | null) { if (c.kind === 'reference')
        ref(c.useId, art, component, 'color'); if (c.kind === 'preserve')
        ref(c.useId, art, component, 'content'); if (c.kind === 'unknown') {
        if (!r.issues.some(i => i.id === c.issueId))
            add(component ?? art, 'missing-color-issue', '未定颜色缺少问题记录');
        add(component ?? art, 'unknown-color', '颜色尚未明确');
    } if (c.kind === 'garment-contrast')
        add(component ?? art, 'unresolved-contrast', '需要先将衣服对比色解析为明确颜色，避免共享图稿颜色串用'); }
    for (const u of r.materialUses) {
        const target = u.componentId ?? u.artworkId ?? r.id;
        if (u.role === 'excluded') {
            if (u.artworkId || u.componentId)
                add(target, 'excluded-bound', '排除素材不能绑定图稿');
            continue;
        }
        if (!u.artworkId || !arts.has(u.artworkId) || u.componentId && comps.get(u.componentId)?.art !== u.artworkId)
            add(r.id, 'use-owner', '素材用途所属图稿或组件不存在', 'interpret');
        if (u.selection.kind === 'unknown')
            add(target, 'unknown-selection', `素材选区未明确：${u.selection.reason}`);
        if (source) {
            const m = source.materials.find(m => m.id === u.materialId);
            if (!m || m.load !== 'ready' || !m.artifactId || !m.sha256)
                add(target, 'material-unavailable', `素材不可用：${u.materialId}`);
            else if (u.sourceArtifactSha256 && u.sourceArtifactSha256 !== m.sha256)
                add(target, 'material-sha-mismatch', `素材内容已改变：${u.materialId}`);
        }
        if (u.role === 'annotation')
            used.add(u.id);
    }
    if (source)
        for (const m of source.materials) {
            if (!r.materialUses.some(u => u.materialId === m.id))
                add(r.id, 'unbound-material', `素材 ${m.label} 必须说明用途或明确排除`, 'interpret');
        }
    for (const a of r.artworks) {
        const ids = new Set(a.components.map(c => c.id));
        if (a.layout.componentOrder.length !== ids.size || new Set(a.layout.componentOrder).size !== ids.size || a.layout.componentOrder.some(id => !ids.has(id)))
            add(a.id, 'layout-order', '排版必须且只能包含每个组件一次');
        for (const p of a.layout.placements)
            if (!ids.has(p.componentId))
                add(a.id, 'layout-target', '排版指向不存在的组件');
        if (a.layout.kind === 'positioned' && (a.layout.placements.length !== ids.size || new Set(a.layout.placements.map(p => p.componentId)).size !== ids.size))
            add(a.id, 'layout-placement', '每个组件必须有唯一明确位置');
        if (a.layout.kind === 'preserve' && ids.size > 1 && a.layout.referenceUseIds.length === 0)
            add(a.id, 'layout-unknown', '多个组件原排版需要明确参考');
        a.layout.referenceUseIds.forEach(u => ref(u, a.id, null, 'layout'));
        if (a.background.exterior === 'unknown')
            add(a.id, 'unknown-background', '外部背景处理方式未明确');
        for (const p of [...a.background.preserveRegions, ...a.background.removeRegions]) {
            const u = uses.get(p.useId);
            ref(p.useId, a.id, u?.componentId ?? null, 'content');
        }
        for (const c of a.components) {
            checkColor(c.color, a.id, c.id);
            if (c.kind === 'text') {
                if (!c.content.evidenceIds.length)
                    add(c.id, 'text-evidence', '准确文字或原字形缺少依据');
                if (c.content.kind === 'preserve-source') {
                    ref(c.content.useId, a.id, c.id, 'content');
                    if (c.font.strategy !== 'preserve-source')
                        add(c.id, 'font-preserve', '保留原字形不能同时替换字体');
                }
                if (c.content.kind === 'exact' && c.font.strategy === 'preserve-source')
                    add(c.id, 'font-source', '准确排字缺少原字形来源');
                c.font.referenceUseIds.forEach(u => ref(u, a.id, c.id, 'font'));
                if (c.font.strategy === 'available-font' && !c.font.primaryFontAssetId && !c.font.fallbackFontAssetIds.length)
                    add(c.id, 'font-missing', '排字字体及后备字体均未指定');
                if (c.font.strategy === 'reference-glyphs' && !c.font.referenceUseIds.length)
                    add(c.id, 'font-reference-missing', '字体参考方案缺少参考图');
                if (c.layout.kind === 'arc' && c.layout.degrees === null)
                    add(c.id, 'arc-unknown', '弧度尚未明确');
            }
            else {
                c.contentUseIds.forEach(u => ref(u, a.id, c.id, 'content'));
                if (c.mode !== 'create' && !c.contentUseIds.length)
                    add(c.id, 'graphic-source', '图形制作缺少原始内容素材');
                if (c.mode === 'preserve' && c.contentUseIds.length > 1)
                    add(c.id, 'multi-image-layout', '多个独立素材应分别建组件，或明确编辑组合方案');
                if (c.mode === 'create' && !c.description.trim())
                    add(c.id, 'graphic-description', '新建图形缺少描述');
                if (['edit', 'reconstruct'].includes(c.mode) && !a.changes.some(ch => ch.componentId === c.id && ch.action.kind !== 'add-component'))
                    add(c.id, 'unauthorized-edit', '改图或重建必须说明允许变化的内容');
            }
        }
        for (const change of a.changes) {
            if (!change.evidenceIds.some(id => { const evidence = ev.get(id); return evidence?.certainty === "explicit" && ["source-text", "user-amendment"].includes(evidence.origin.kind); })) add(change.componentId, "change-authorization", "修改缺少原文或用户补充的明确授权，不能将视觉推测当作删改指令");
            if (!ids.has(change.componentId))
                add(a.id, 'change-target', '修改指向不存在的组件');
            if (change.sourceUseId)
                ref(change.sourceUseId, a.id, change.componentId, 'content');
            if (change.selection.kind === 'unknown')
                add(change.componentId, 'change-selection', '修改范围尚未明确');
            const action = change.action;
            if (action.kind === 'add-component' && !ids.has(action.addedComponentId) || action.kind === 'replace-text' && !ids.has(action.replacementComponentId))
                add(a.id, 'change-target', '新增或替换组件不存在');
            if (action.kind === 'recolor')
                checkColor(action.color, a.id, change.componentId);
            if (action.kind !== 'add-component' && comps.get(change.componentId)?.c.kind === 'graphic' && (comps.get(change.componentId)?.c as {
                mode?: string;
            }).mode === 'preserve')
                add(change.componentId, 'change-mode', '已要求修改的图形不能仍使用保留原图方案');
        }
        for (const check of a.requiredChecks) {
            if (check.targetId !== a.id && !ids.has(check.targetId))
                add(a.id, 'check-target', '核对项指向其他图稿');
            check.referenceUseIds.forEach(u => ref(u, a.id, ids.has(check.targetId) ? check.targetId : null));
        }
    }
    for (const u of r.materialUses)
        if (u.role !== 'excluded' && !used.has(u.id))
            add(u.componentId ?? u.artworkId ?? r.id, 'unused-reference', `素材用途 ${u.id} 未进入制作方案`);
    for (const application of r.applications) {
        if (!arts.has(application.artworkId) || !r.garments.some(g => g.id === application.garmentId))
            add(application.id, 'application-target', '效果图引用的图稿或衣服不存在', 'mockup');
        const p = application.placement;
        if (!p.baseAssetId || !p.baseAssetSha256 || !p.center || !p.size || !p.bodyWidthCm)
            add(application.id, 'placement-unresolved', '效果图底图、尺寸或位置尚未明确', 'mockup');
    }
    const targets = new Set([...all, ...r.materialUses.map(u => u.materialId), ...(source?.materials.map(m => m.id) ?? [])]);
    for (const i of r.issues)
        if (!targets.has(i.targetId))
            add(r.id, 'issue-target', '问题记录指向不存在的对象', 'interpret');
    return out;
}
export function validateRequirement(input: unknown, source: SourceSnapshot): {
    requirement: Requirement | null;
    issues: Issue[];
} { const parsed = requirementSchema.safeParse(input); if (!parsed.success)
    return { requirement: null, issues: parsed.error.issues.map(i => problem('requirement', 'invalid-shape', `${i.path.join('.')}: ${i.message}`, 'interpret')) }; const requirement: Requirement = parsed.data; return { requirement, issues: semanticIssues(requirement, source) }; }
