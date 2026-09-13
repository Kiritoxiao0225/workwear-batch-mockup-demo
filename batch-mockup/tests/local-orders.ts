import type { Requirement, SourceSnapshot, TextComponent } from '../domain/contracts';
import type { LocalOrder, StoredImage } from '../application/runtime-types';
/** Explicitly annotated offline inputs. These are not responses from an image-understanding model. */
export function annotatedOrder(id: string, title: string, text: string, sourceText: string, garment: StoredImage, graphic?: StoredImage): LocalOrder {
    const source: SourceSnapshot = { id: `${id}-source`, workspaceId: 'local-validation', source: { kind: 'local', key: id }, contentHash: 'a'.repeat(64), requirementText: sourceText,
        materials: graphic ? [{ id: `${id}-material`, sourceAttachmentId: `${id}-attachment`, label: '图1', artifactId: graphic.id, sha256: graphic.sha256, load: 'ready', error: null }] : [],
        sourceStatus: '离线验收', editable: true, capturedAt: '2026-09-13T00:00:00.000Z' };
    const e = `${id}-evidence`, art = `${id}-artwork`, words = `${id}-text`, logo = `${id}-graphic`, use = `${id}-content`;
    const component: TextComponent = { id: words, kind: 'text', content: { kind: 'exact', value: text, evidenceIds: [e] }, font: { referenceUseIds: [], primaryFontAssetId: 'douyin-sans', fallbackFontAssetIds: [], strategy: 'available-font', fallbackPolicy: 'report-substitution', evidenceIds: [e] }, color: { kind: 'solid', rgba: [255, 255, 255, 1], evidenceIds: [e] }, layout: { kind: 'lines', align: 'center' } };
    const requirement: Requirement = { id: `${id}-requirement`, workspaceId: source.workspaceId, revision: 1, schemaVersion: 'batch-mockup/1', sourceSnapshotId: source.id, sourceContentHash: source.contentHash,
        evidence: [{ id: e, origin: { kind: 'user-amendment', amendmentId: `${id}-annotation`, actorId: 'local-fixture-author', at: '2026-09-13T00:00:00.000Z' }, statement: '离线人工标注：原稿内容保留，文字逐字排版；示例底图和位置仅用于验证合成链路', certainty: 'explicit', supersedes: [] }],
        materialUses: graphic ? [{ id: use, materialId: `${id}-material`, sourceArtifactSha256: graphic.sha256, artworkId: art, componentId: logo, role: 'content', selection: { kind: 'whole' }, instruction: '保留原Logo和原英文，仅处理外部背景；白色描边为原稿内容，不新增描边', evidenceIds: [e] }] : [],
        artworks: [{ id: art, label: graphic ? '原图 + 准确文字' : '两行准确文字', components: graphic ? [{ id: logo, kind: 'graphic', contentUseIds: [use], mode: 'preserve', description: '保留原图形与原英文', color: { kind: 'preserve', useId: use } }, component] : [component],
                changes: graphic ? [{ id: `${id}-add`, componentId: logo, action: { kind: 'add-component', addedComponentId: words }, sourceUseId: use, selection: { kind: 'whole' }, evidenceIds: [e], preserve: ['TH', 'TONGHUA', '原图白色描边'] }] : [],
                background: { exterior: 'transparent', preserveRegions: [], removeRegions: [], preserveDescription: '内部原稿颜色和字形保留', evidenceIds: [e] }, layout: { kind: 'stack', componentOrder: graphic ? [logo, words] : [words], referenceUseIds: [], placements: [], gapRatio: 0.07, evidenceIds: [e] }, enhancement: 'disabled', printSize: null,
                requiredChecks: [{ id: `${id}-check-text`, category: 'text', targetId: words, expected: text, referenceUseIds: [], evidenceIds: [e] }] }],
        garments: [{ id: `${id}-garment`, label: '2208 示例底图（非订单款色绑定）', styleCode: '2208', requestedColor: '茶绿色', variantId: null, evidenceIds: [e] }],
        applications: [{ id: `${id}-application`, artworkId: art, artworkVersionId: null, garmentId: `${id}-garment`, outputVariant: '本地合成示意', placement: { face: 'front', label: '示意左胸', size: { widthCm: 9, heightCm: null, basis: 'default', evidenceIds: [e] }, center: { x: 0.63, y: 0.36 }, rotation: 0, standardId: 'local-demo-scale', baseAssetId: garment.id, baseAssetSha256: garment.sha256, bodyWidthCm: 55, bodyScaleEvidenceIds: [e] } }],
        issues: [], createdAt: '2026-09-13T00:00:00.000Z', createdBy: 'local-fixture-author' };
    return { id, title, source, requirement, garmentArtifactId: garment.id, garmentLabel: '2208 茶绿色示例底图', note: '人工标注的离线输入；未调用视觉理解或付费图片 API。上衣为测试底图与测试位置，不是订单定稿。' };
}
