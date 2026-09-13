import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { localConfig } from '../adapters/local-config';
import { storePng, sha256, crop } from '../adapters/images';
import { saveOrder, readOrder, compareAndSaveRequirement } from '../adapters/postgres';
import { annotatedOrder } from '../tests/local-orders';
export async function seedLocalOrders(caseRoot?: string) {
    const original = await readFile(path.join(localConfig().projectRoot, 'public/products/originals/2208-tea-green-polo.png'));
    // Visually inspected fixture: original is front + back side by side; front occupies the left half.
    const garment = await storePng(await crop(original, { x: 0, y: 0, width: .5, height: 1 }), '2208 茶绿色正面 · 人工选定的本地示例底图', 'source');
    async function saveFixture(order: Parameters<typeof saveOrder>[0]) {
        const existing = await readOrder(order.id);
        if (!existing)
            return saveOrder(order);
        if (existing.requirement.createdBy === 'local-fixture-author' && existing.requirement.applications[0]?.placement.standardId === 'local-demo-scale' && existing.requirement.applications[0].placement.baseAssetSha256 !== garment.sha256) {
            const next = structuredClone(existing.requirement);
            next.revision++;
            for (const application of next.applications) {
                application.placement.baseAssetId = garment.id;
                application.placement.baseAssetSha256 = garment.sha256;
            }
            await compareAndSaveRequirement(order.id, existing.requirement.revision, next);
        }
    }
    const text = annotatedOrder('text-lines', '两行文字 · 戚墅堰全民健身中心', '戚墅堰全民健身中心\n教 练', '左胸：戚墅堰全民健身中心\n教 练', garment);
    text.source.contentHash = sha256(text.source.requirementText);
    text.requirement.sourceContentHash = text.source.contentHash;
    await saveFixture(text);
    if (caseRoot) {
        const graphic = await storePng(await readFile(path.join(caseRoot, 'design-cases/D02/reference-1.jpg')), 'TH 原始参考图（公开审阅案例）', 'source');
        const hybrid = annotatedOrder('graphic-add-text', '图形加字 · 通华驾校', '通华驾校', '左胸：图1+通华驾校', garment, graphic);
        hybrid.source.contentHash = sha256(hybrid.source.requirementText + graphic.sha256);
        hybrid.requirement.sourceContentHash = hybrid.source.contentHash;
        await saveFixture(hybrid);
    }
}
