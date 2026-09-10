import { conditionalJson } from './conditional-json';
import { saveWpsAnalysis } from './wps-analysis-save';
import { completedProductionSave } from '@/lib/server/production-cloud-state';
import { bindSharedArtwork, detachSharedArtwork, latestSharedArtwork, sharedArtworkForUnit, sharedArtworkFixed } from '@/lib/shared-artwork';
import { prepareSharedArtwork, commitSharedArtwork, existingSharedAttachment, type ArtworkAttachment } from './shared-artwork';
import { assertProductionSharedSnapshot } from '@/lib/production-artwork-snapshot';
import { readArtworkJobs } from './artwork-job-store';
import { sharedArtworkStatus } from '@/lib/shared-artwork-status';
import { artworkProcessingRoute } from '@/lib/task-review-analysis';
import { fileSha256 } from '@/lib/server/catalog-files';
import { productionUser, usesProductionCloud, persistProductionReferences } from '@/lib/server/production-storage';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { withGarmentBodyScale, withProductionPreviewGeometry } from '@/lib/server/wps-garment-sizing';
import { assertProductionArtworkSnapshot, ProductionArtworkConflictError, productionActionAssertion, productionActionSnapshot } from '@/lib/production-artwork-snapshot';
import { MOCKUP_SIZE_POLICY } from '@/lib/production-sizing';
import { bindPrintSizeRequest } from '@/lib/print-size-request';
import { taskPlacementSchema } from '@/lib/production-garment';
import { placementPreview } from '@/lib/production-preview';
import { assertArtworkDraft } from '@/lib/artwork-editor';
import { z } from 'zod';
import { prepareCatalogReviews, verifyGarmentBinding } from '@/lib/server/wps-production-garments';
import { randomUUID } from 'node:crypto';
import { retainArtworkQuality } from '@/lib/artwork-acceptance';
import { validateProductionArtworkDraft, validateProductionArtworkQuality } from '@/lib/server/production-artwork-quality';

import { NextResponse } from 'next/server';

import type { TaskReview } from '@/lib/batch-task-review';
import type { ProductionUnit } from '@/lib/wps-production';
import {
  ProductionTransitionError,
  approveProductionVersion,
  attachProductionArtwork,
  beginGptImage2Attempt,
  completeVersionComposition,
  confirmProductionArtwork,
  confirmProductionPlan,
  failVersionComposition,
  importTaskReviews,
  normalizeProductionTextPlan,
  markVersionComposing,
  returnProductionUnit,
  setProductionBudget,
  saveProductionTextVerification,
  saveProductionArtworkQuality,
  productionTextVerificationSchema,
  placeProductionArtwork,
  updateProductionPlan,
  updateProductionAttempt,
  type ProductionAttempt,
  type ProductionPlanPatch,
} from '@/lib/wps-production';
import { composeProductionMockup, validateProductionArtwork } from '@/lib/server/wps-production-assets';
import {
  assertGptImage2Configured,
  buildGptImage2Request,
  createGptImage2Task,
  downloadGptImage2Result,
  queryGptImage2Task,
  EvolinkConfigurationError,
} from '@/lib/server/evolink-gpt-image-2';
import {
  ProductionRevisionConflictError,
  mutateWpsProductionState,
  readWpsProductionState,
} from '@/lib/server/wps-production-store';
import { PLACEMENT_KEYS, type PlacementKey } from '@/lib/types';

function objectValue(value: unknown, field = 'body'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}

function textValue(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空字符串，实际值：${String(value)}`);
  return value.trim();
}

function optionalText(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return null;
  return textValue(value, field);
}

function numberValue(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} 必须是有限数字，实际值：${String(value)}`);
  return value;
}

function expectedRevision(body: Record<string, unknown>) {
  const revision = numberValue(body.expectedRevision, 'expectedRevision');
  if (!Number.isInteger(revision) || revision < 0) throw new Error(`expectedRevision 必须是非负整数，实际值：${revision}`);
  return revision;
}

function stringArray(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`);
  return value.map((entry, index) => textValue(entry, `${field}[${index}]`));
}

function planPatch(value: unknown): ProductionPlanPatch {
  const raw = objectValue(value, 'patch');
  const patch: ProductionPlanPatch = {};
  if ('garmentLabel' in raw) patch.garmentLabel = textValue(raw.garmentLabel, 'patch.garmentLabel');
  if ('variantLabel' in raw) patch.variantLabel = textValue(raw.variantLabel, 'patch.variantLabel');
  if ('materialId' in raw) patch.materialId = raw.materialId === null ? null : textValue(raw.materialId, 'patch.materialId');
  if ('referenceMaterialIds' in raw) patch.referenceMaterialIds = stringArray(raw.referenceMaterialIds, 'patch.referenceMaterialIds');
  if ('ambiguities' in raw) patch.ambiguities = stringArray(raw.ambiguities, 'patch.ambiguities');
  if ('sourceScope' in raw) patch.sourceScope = textValue(raw.sourceScope, 'patch.sourceScope') as ProductionPlanPatch['sourceScope'];
  if ('textMode' in raw) patch.textMode = raw.textMode === null ? null : textValue(raw.textMode, 'patch.textMode') as ProductionPlanPatch['textMode'];
  if ('exactText' in raw) patch.exactText = typeof raw.exactText === 'string' ? raw.exactText : textValue(raw.exactText, 'patch.exactText');
  if ('layoutNote' in raw) patch.layoutNote = typeof raw.layoutNote === 'string' ? raw.layoutNote : textValue(raw.layoutNote, 'patch.layoutNote');
  if ('generationPrompt' in raw) patch.generationPrompt = typeof raw.generationPrompt === 'string' ? raw.generationPrompt : textValue(raw.generationPrompt, 'patch.generationPrompt');
  if ('instruction' in raw) patch.instruction = textValue(raw.instruction, 'patch.instruction');
  if ('route' in raw) patch.route = textValue(raw.route, 'patch.route') as ProductionPlanPatch['route'];
  if ('artworkMethod' in raw) patch.artworkMethod = z.enum(['auto', 'preserve', 'redraw', 'compose', 'generate']).parse(raw.artworkMethod);
  if ('cutoutMode' in raw) patch.cutoutMode = z.enum(['auto', 'standard', 'meitu']).parse(raw.cutoutMode);
  if ('routeEvidence' in raw) patch.routeEvidence = textValue(raw.routeEvidence, 'patch.routeEvidence');
  if ('placement' in raw) {
    if (raw.placement === null) patch.placement = null;
    else {
      const placement = objectValue(raw.placement, 'patch.placement');
      const key = textValue(placement.key, 'patch.placement.key') as PlacementKey;
      if (!PLACEMENT_KEYS.includes(key)) throw new Error(`patch.placement.key 无效：${key}`);
      patch.placement = {
        key,
        ...(placement.manual === undefined ? {} : { manual: taskPlacementSchema.parse(placement.manual) }),
        widthCm: numberValue(placement.widthCm, 'patch.placement.widthCm'),
        offsetX: numberValue(placement.offsetX, 'patch.placement.offsetX'),
        offsetY: numberValue(placement.offsetY, 'patch.placement.offsetY'),
        rotation: numberValue(placement.rotation, 'patch.placement.rotation'),
        templateVersion: 'catalog-v1',
        sizePolicy: placement.sizePolicy === undefined ? undefined : z.literal(MOCKUP_SIZE_POLICY).parse(placement.sizePolicy),
        sizeMode: z.enum(['standard', 'widthCm', 'heightCm']).parse(placement.sizeMode),
        heightCm: placement.heightCm === undefined ? undefined : numberValue(placement.heightCm, 'patch.placement.heightCm'),
        sizeOverride: placement.sizeOverride === undefined ? undefined : z.boolean().parse(placement.sizeOverride),
        catalogPosition: placement.catalogPosition === undefined ? undefined : z.enum(['upperBack', 'backCenter', 'frontCenter', 'apronUpper', 'apronPocket']).parse(placement.catalogPosition),
      };
    }
  }
  if (Object.keys(patch).length === 0) throw new Error('patch 至少需要一个可修改字段');
  return patch;
}

function reviewsValue(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('reviews 必须是非空数组');
  value.forEach((entry, index) => objectValue(entry, `reviews[${index}]`));
  return value as TaskReview[];
}

function serviceValue(value: unknown): ProductionAttempt['service'] {
  const service = textValue(value, 'service');
  if (!['auto', 'hybrid', 'model', 'deterministic', 'gpt-image-2', 'manual-upload'].includes(service)) throw new Error(`service 无效：${service}`);
  return service as ProductionAttempt['service'];
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof CatalogHttpError ? error.status : error instanceof ProductionRevisionConflictError || error instanceof ProductionArtworkConflictError
    ? 409
    : error instanceof EvolinkConfigurationError
      ? 503
    : error instanceof ProductionTransitionError
      ? 422
      : 400;
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request?: Request) {
  try {
    await productionUser(request);
    return conditionalJson(await withProductionPreviewGeometry(await readWpsProductionState()), request);
  } catch (error) {
    if (error instanceof CatalogHttpError) return errorResponse(error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `读取 WPS 生产状态失败：${message}` }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    await productionUser(request, true);
    body = objectValue(await request.json());
  } catch (error) {
    return errorResponse(error);
  }
  const action = typeof body.action === 'string' ? body.action : '';
  try {
    const revision = expectedRevision(body);
    const guard = productionActionAssertion(body);
    const mutate: typeof mutateWpsProductionState = (expected, mutation, assertion = guard, receipt) => mutateWpsProductionState(expected, mutation, assertion, receipt);
    const assertCurrent = (state: Awaited<ReturnType<typeof readWpsProductionState>>) => {
      if (guard) guard(state);
      else if (state.revision !== revision) throw new ProductionRevisionConflictError(revision, state.revision);
    };
    if (['linkSharedArtwork', 'detachSharedArtwork', 'branchSharedArtwork', 'applySharedArtwork', 'confirmSharedArtwork'].includes(action)) {
      const unitId = textValue(body.unitId, 'unitId');
      const current = await readWpsProductionState();
      const targetIds = body.targetUnitIds === undefined ? [] : stringArray(body.targetUnitIds, 'targetUnitIds');
      assertProductionSharedSnapshot(current, unitId, textValue(body.expectedSharedSnapshot, 'expectedSharedSnapshot'), targetIds);
      assertCurrent(current);
      const group = sharedArtworkForUnit(current, unitId);
      const affected = new Set([unitId, ...targetIds, ...(group?.unitIds ?? [])]);
      if (current.units.some(unit => affected.has(unit.id) && unit.attempts.some(attempt => ['submitted', 'processing', 'unknownSubmission'].includes(attempt.status)))) throw new ProductionTransitionError('共用图稿仍在制作，请等待当前任务结束');
      const jobs = await readArtworkJobs();
      if (jobs.jobs.some(job => affected.has(job.unitId) && ['queued', 'running', 'unknown'].includes(job.status))) throw new ProductionTransitionError('共用图稿仍在制作，请等待当前任务结束');
      if (action === 'detachSharedArtwork' || action === 'branchSharedArtwork') return NextResponse.json(await mutate(revision,
        state => detachSharedArtwork(state, unitId, action === 'branchSharedArtwork' ? randomUUID() : undefined)));
      if (action === 'confirmSharedArtwork') return NextResponse.json(await mutate(revision, state => {
        const shared = sharedArtworkForUnit(state, unitId);
        if (!shared) throw new Error('找不到共用图稿');
        let next = state;
        const status = sharedArtworkStatus(state, shared);
        if (!status.confirmable && !status.confirmed) throw new ProductionTransitionError('当前没有可确认的共用图案，请先处理待应用或待修正的位置');
        for (const application of status.applications.filter(item => item.canConfirm))
          next = confirmProductionArtwork(next, application.unit.id, textValue(body.actor, 'actor'));
        return { ...next, revision: state.revision + 1 };
      }));
      if (action === 'linkSharedArtwork') {
        if (group && group.sourceUnitId !== unitId) throw new Error('请从共用图稿入口添加应用');
        const linked = bindSharedArtwork(current, unitId, targetIds, randomUUID());
        const existingVersion = group && latestSharedArtwork(group);
        const source = existingVersion?.artwork ?? current.units.find(unit => unit.id === unitId)?.artwork;
        const prepared = source ? await prepareSharedArtwork(linked, unitId, existingSharedAttachment(source), {
          preserveExisting: true, ...(existingVersion ? { applyUnitIds: targetIds } : {}),
        }) : null;
        return NextResponse.json(await mutate(revision, state => {
          const next = bindSharedArtwork(state, unitId, targetIds, linked.units.find(unit => unit.id === unitId)!.sharedArtworkId!);
          return { ...(prepared ? commitSharedArtwork(next, prepared) : next), revision: state.revision + 1 };
        }));
      }
      if (!group || !latestSharedArtwork(group)) throw new Error('共用图稿尚未制作');
      if (sharedArtworkFixed(current, unitId)) throw new Error('此服装方案已定稿，请先退回后再更新图案');
      const prepared = await prepareSharedArtwork(current, group.sourceUnitId, existingSharedAttachment(latestSharedArtwork(group)!.artwork), { applyUnitId: unitId });
      return NextResponse.json(await mutate(revision, state => commitSharedArtwork(state, prepared!)));
    }
    if (action === 'normalizeTextPlan') return NextResponse.json(await mutate(revision, state => normalizeProductionTextPlan(state, textValue(body.unitId, 'unitId'))));
    if (action === 'importReviews') {
      const prepared = await prepareCatalogReviews(reviewsValue(body.reviews));
      const reviews = usesProductionCloud() ? await persistProductionReferences(prepared) : prepared;
      return NextResponse.json(await mutate(revision, (state) => importTaskReviews(state, reviews)));
    }
    if (action === 'upsertReviews') return NextResponse.json(await saveWpsAnalysis(reviewsValue(body.reviews), body.targetSnapshots as Record<string, string>));
    if (action === 'updatePlan') {
      const unitId = textValue(body.unitId, 'unitId');
      return NextResponse.json(await mutate(revision, async state => {
        const patch = planPatch(body.patch);
        const unit = state.units.find(unit => unit.id === unitId);
        if (patch.placement && unit?.garment) {
          await verifyGarmentBinding(unit.garment);
          patch.garment = await withGarmentBodyScale(unit.garment);
          patch.placement.sizePolicy = MOCKUP_SIZE_POLICY;
        }
        return updateProductionPlan(state, unitId, patch);
      }));
    }
    if (action === 'confirmPlan') {
      const unitId = textValue(body.unitId, 'unitId');
      const actor = textValue(body.actor, 'actor');
      return NextResponse.json(await mutate(revision, async (state) => {
        const unit = state.units.find(unit => unit.id === unitId);
        if (!unit?.garment) throw new ProductionTransitionError('请先选择真实款式和颜色；历史测试衣服不能直接确认');
        await verifyGarmentBinding(unit.garment);
        const garment = await withGarmentBodyScale(unit.garment);
        const resized = updateProductionPlan(state, unitId, { garment, placement: unit.placement ? { ...unit.placement, sizePolicy: MOCKUP_SIZE_POLICY } : null });
        return { ...confirmProductionPlan(resized, unitId, actor), revision: state.revision + 1 };
      }));
    }
    if (action === 'saveTextVerification') {
      const result = productionTextVerificationSchema.parse(body.result);
      const unitId = textValue(body.unitId, 'unitId');
      const artworkSha256 = textValue(body.artworkSha256, 'artworkSha256');
      return NextResponse.json(await mutate(revision, async state => {
        const unit = state.units.find(candidate => candidate.id === unitId);
        if (!unit?.artwork) throw new ProductionTransitionError(`找不到图案：${unitId}`);
        const validation = await validateProductionArtwork(unit.artwork.url);
        if (validation.sha256 !== artworkSha256 || validation.sha256 !== unit.artwork.validation.sha256) throw new ProductionTransitionError('Logo 文件已变化，请重新进行文字检查');
        const refreshed = { ...state, units: state.units.map(candidate => candidate.id === unitId ? { ...candidate, artwork: { ...unit.artwork!, validation: retainArtworkQuality(unit.artwork!.validation, validation) } } : candidate) };
        return saveProductionTextVerification(refreshed, unitId, artworkSha256, result);
      }));
    }
    if (action === 'savePlacements') {
      const actor = textValue(body.actor, 'actor');
      if (!Array.isArray(body.updates) || !body.updates.length || body.updates.length > 30) throw new Error('请提交本件衣服需要保存的位置');
      const updates = body.updates.map(raw => {
        const entry = objectValue(raw);
        const placement = planPatch({ placement: entry.placement }).placement;
        if (!placement?.manual) throw new Error('请在衣服上核对位置');
        return { unitId: textValue(entry.unitId, 'unitId'), placement };
      });
      if (new Set(updates.map(update => update.unitId)).size !== updates.length) throw new Error('不能重复保存同一位置');
      return NextResponse.json(await mutate(revision, async state => {
        const version = state.mockupVersions.find(version => version.unitIds.includes(updates[0].unitId));
        if (!version || updates.some(update => !version.unitIds.includes(update.unitId))) throw new Error('只能一起保存同件衣服、同一版本的位置');
        const confirmWholeVersion = body.confirmWholeVersion === true;
        if (confirmWholeVersion && updates.length !== version.unitIds.length) throw new Error('请一起核对本件衣服的全部图案与位置');
        // Reuse only identical bindings inside this attempt; a CAS retry creates
        // fresh checks. File integrity is still checked for every artwork.
        const garments = new Map<string, Promise<NonNullable<ProductionUnit['garment']>>>();
        const inspect = async ({ unitId, placement }: typeof updates[number]) => {
          const unit = state.units.find(unit => unit.id === unitId);
          if (!unit?.garment) throw new ProductionTransitionError('请先选择衣服款式和颜色');
          const binding = unit.garment;
          const key = JSON.stringify(binding);
          if (!garments.has(key)) garments.set(key, (async () => {
            await verifyGarmentBinding(binding);
            return withGarmentBodyScale(binding);
          })());
          const [garment, validation] = await Promise.all([
            garments.get(key)!,
            unit.artwork ? validateProductionArtwork(unit.artwork.url) : null,
          ]);
          if (validation && validation.sha256 !== unit.artwork!.validation.sha256) throw new ProductionTransitionError('图案文件已变化，请重新确认图案');
          placement.sizePolicy = MOCKUP_SIZE_POLICY;
          placement = bindPrintSizeRequest(state.records.find(record => record.source.recordId === unit.sourceRecordId)!.source.requirementText, placement);
          placementPreview(garment, placement, validation ?? { width: 1, height: 1 });
          return { unitId, unit, placement, garment, validation };
        };
        const checked: Awaited<ReturnType<typeof inspect>>[] = [];
        for (let offset = 0; offset < updates.length; offset += 3) {
          checked.push(...await Promise.all(updates.slice(offset, offset + 3).map(inspect)));
        }
        let next = state;
        for (const { unitId, unit, placement, garment, validation } of checked) {
          next = { ...next, units: next.units.map(candidate => candidate.id === unitId ? { ...candidate, garment } : candidate) };
          if (confirmWholeVersion) {
            if (!unit.artwork || !validation) throw new ProductionTransitionError('本件图案尚未做齐，请先保存草稿');
            next = { ...next, units: next.units.map(candidate => candidate.id === unitId ? { ...candidate, artwork: { ...unit.artwork!, validation: retainArtworkQuality(unit.artwork!.validation, validation) } } : candidate) };
            next = confirmProductionArtwork(next, unitId, actor);
          }
          next = validation && (confirmWholeVersion || (body.confirmArtworkPlacement === true && unit.gateB))
            ? placeProductionArtwork(next, unitId, placement, validation, actor)
            : updateProductionPlan(next, unitId, { garment, placement });
        }
        return { ...next, revision: state.revision + 1 };
      }));
    }
    if (action === 'placeArtwork') {
      const unitId = textValue(body.unitId, 'unitId');
      const actor = textValue(body.actor, 'actor');
      const patch = planPatch({ placement: body.placement });
      return NextResponse.json(await mutate(revision, async state => {
        const unit = state.units.find(unit => unit.id === unitId);
        if (!unit?.garment || !unit.artwork || !unit.gateB) throw new ProductionTransitionError('请先选择真实衣服并确认 Logo');
        await verifyGarmentBinding(unit.garment);
        const validation = await validateProductionArtwork(unit.artwork.url);
        if (!patch.placement) throw new ProductionTransitionError('请提交本次印花位置');
        const garment = await withGarmentBodyScale(unit.garment);
        const refreshed = { ...state, units: state.units.map(candidate => candidate.id === unitId ? { ...candidate, garment } : candidate) };
        return placeProductionArtwork(refreshed, unitId, { ...patch.placement, sizePolicy: MOCKUP_SIZE_POLICY }, validation, actor);
      }));
    }
    if (action === 'submitArtwork' || action === 'saveArtworkDraft') {
      const unitId = textValue(body.unitId, 'unitId');
      const url = textValue(body.url, 'url');
      if (body.draft !== undefined) assertArtworkDraft(body.draft);
      const receipt = usesProductionCloud() && body.operationId ? { id: z.string().uuid().parse(body.operationId), hash: fileSha256(JSON.stringify({ ...body, expectedRevision: undefined, operationId: undefined })) } : undefined;
      if (receipt && await completedProductionSave(receipt)) return NextResponse.json(await readWpsProductionState());
      const current = await readWpsProductionState();
      const snapshot = body.expectedUnitSnapshot === undefined ? null : z.string().min(1).max(100_000).parse(body.expectedUnitSnapshot);
      const shared = sharedArtworkForUnit(current, unitId);
      const sharedSnapshot = shared ? textValue(body.expectedSharedSnapshot, 'expectedSharedSnapshot') : null;
      const assertUnchangedTarget = snapshot === null && !sharedSnapshot ? undefined : (state: typeof current) => {
        if (snapshot) assertProductionArtworkSnapshot(state, unitId, snapshot);
        if (sharedSnapshot) assertProductionSharedSnapshot(state, unitId, sharedSnapshot);
      };
      if (assertUnchangedTarget) assertUnchangedTarget(current);
      else assertCurrent(current);
      const unit = current.units.find(unit => unit.id === unitId);
      if (!unit) throw new Error(`找不到定制单元：${unitId}`);
      const service = serviceValue(body.service);
      if (service !== 'manual-upload' && service !== artworkProcessingRoute(unit)) throw new ProductionTransitionError(`制作服务 ${service} 与当前路线 ${unit.route} 不一致`);
      if (action === 'saveArtworkDraft' && (!(unit.artwork || shared && latestSharedArtwork(shared)) || !body.draft || service !== 'manual-upload')) {
        throw new ProductionTransitionError('保存编辑需要已有图案及完整图层草稿');
      }
      const previousArtwork = shared && latestSharedArtwork(shared)?.artwork || unit.artwork;
      const { validation, draft } = await validateProductionArtworkDraft(url, body.draft, previousArtwork?.validation, previousArtwork?.draft);
      const attachment: ArtworkAttachment = {
        url,
        name: textValue(body.name, 'name'),
        validation,
        ...(draft ? { draft } : {}),
        automaticWidthCm: body.automaticWidthCm === undefined ? undefined : numberValue(body.automaticWidthCm, 'automaticWidthCm'),
        prompt: optionalText(body.prompt, 'prompt'),
        promptHash: optionalText(body.promptHash, 'promptHash'),
        inputImageUrls: body.inputImageUrls === undefined ? [] : z.array(z.string().min(1)).parse(body.inputImageUrls),
        service,
        requestSummary: textValue(body.requestSummary, 'requestSummary'),
        providerTaskId: optionalText(body.providerTaskId, 'providerTaskId'),
        estimatedCostCny: body.estimatedCostCny === undefined ? 0 : numberValue(body.estimatedCostCny, 'estimatedCostCny'),
        actualCostCny: body.actualCostCny === undefined || body.actualCostCny === null ? null : numberValue(body.actualCostCny, 'actualCostCny'),
      };
      const attemptId = randomUUID();
      const preparedShared = await prepareSharedArtwork(current, unitId, attachment, { attemptId });
      return NextResponse.json(await mutate(revision, state => preparedShared ? commitSharedArtwork(state, preparedShared)
        : attachProductionArtwork(state, unitId, attachment, attemptId), assertUnchangedTarget, receipt));
    }
    if (action === 'checkArtworkQuality') {
      const unitId = textValue(body.unitId, 'unitId');
      const current = await readWpsProductionState();
      assertCurrent(current);
      const unit = current.units.find(candidate => candidate.id === unitId);
      if (!unit?.artwork) throw new ProductionTransitionError(`找不到图案：${unitId}`);
      const { validation } = await validateProductionArtworkQuality(unit.artwork.url, unit.artwork.draft, undefined, unit.artwork.validation);
      return NextResponse.json(await mutate(revision, state => saveProductionArtworkQuality(state, unitId, validation)));
    }
    if (action === 'startGptImage2') {
      const unitId = textValue(body.unitId, 'unitId');
      const current = await readWpsProductionState();
      assertCurrent(current);
      const unit = current.units.find((candidate) => candidate.id === unitId);
      if (!unit) throw new Error(`找不到定制单元：${unitId}`);
      const record = current.records.find((candidate) => candidate.source.recordId === unit.sourceRecordId);
      if (!record) throw new Error(`${unitId} 引用了不存在的 WPS 记录：${unit.sourceRecordId}`);
      const providerRequest = buildGptImage2Request(record, unit);
      assertGptImage2Configured();
      const attemptId = randomUUID();
      const estimatedCostCny = numberValue(body.estimatedCostCny, 'estimatedCostCny');
      const queued = await mutate(revision, (state) => beginGptImage2Attempt(state, unitId, {
        attemptId,
        requestSummary: `GPT Image 2 · 1K · Low · transparent PNG · ${providerRequest.image_urls.length} 张输入图`,
        inputImageUrls: providerRequest.image_urls,
        prompt: providerRequest.prompt,
        promptHash: providerRequest.promptHash,
        estimatedCostCny,
      }));
      const queuedGuard = productionActionAssertion({ ...body, ...productionActionSnapshot(queued, body) });
      try {
        const task = await createGptImage2Task(providerRequest);
        const nextStatus = task.status === 'processing' ? 'processing' : task.status === 'failed' ? 'failed' : 'submitted';
        const submitted = await mutate(queued.revision, (state) => updateProductionAttempt(state, unitId, attemptId, {
          status: nextStatus,
          providerTaskId: task.id,
          providerCreditsReserved: task.creditsReserved,
          error: task.error,
        }), queuedGuard);
        return NextResponse.json({ state: submitted, attemptId, providerTaskId: task.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.startsWith('EvoLink HTTP ') ? 'failed' : 'unknownSubmission';
        const failed = await mutate(queued.revision, (state) => updateProductionAttempt(state, unitId, attemptId, {
          status,
          error: message,
        }), queuedGuard);
        return NextResponse.json({ error: message, state: failed, attemptId }, { status: status === 'unknownSubmission' ? 504 : 502 });
      }
    }
    if (action === 'pollGptImage2') {
      const unitId = textValue(body.unitId, 'unitId');
      const attemptId = textValue(body.attemptId, 'attemptId');
      const current = await readWpsProductionState();
      assertCurrent(current);
      const unit = current.units.find((candidate) => candidate.id === unitId);
      const attempt = unit?.attempts.find((candidate) => candidate.id === attemptId);
      if (!unit || !attempt) throw new Error(`找不到定制单元或尝试：${unitId}/${attemptId}`);
      if (!attempt.providerTaskId) throw new ProductionTransitionError(`尝试 ${attemptId} 没有供应商 task ID，不能自动查询或重提`);
      const task = await queryGptImage2Task(attempt.providerTaskId);
      if (task.id !== attempt.providerTaskId) throw new Error(`EvoLink 返回了不匹配的 task ID：${task.id}`);
      if (task.status === 'completed') {
        const saved = await downloadGptImage2Result(task.results[0], unitId);
        const { validation } = await validateProductionArtworkDraft(saved.url);
        const attachment: ArtworkAttachment = {
          url: saved.url,
          name: saved.name,
          validation,
          service: 'gpt-image-2',
          requestSummary: attempt.requestSummary,
          providerTaskId: attempt.providerTaskId,
          actualCostCny: attempt.actualCostCny,
        };
        const prepared = await prepareSharedArtwork(current, unitId, attachment, { attemptId });
        const completed = await mutate(revision, state => prepared ? commitSharedArtwork(state, prepared) : attachProductionArtwork(state, unitId, attachment, attemptId));
        return NextResponse.json({ state: completed, validation });
      }
      const status = task.status === 'pending' ? 'submitted' : task.status;
      const updated = await mutate(revision, (state) => updateProductionAttempt(state, unitId, attemptId, {
        status,
        providerCreditsReserved: task.creditsReserved ?? attempt.providerCreditsReserved,
        error: task.error,
      }));
      return NextResponse.json({ state: updated, progress: task.progress });
    }
    if (action === 'confirmArtwork') {
      const unitId = textValue(body.unitId, 'unitId');
      const actor = textValue(body.actor, 'actor');
      return NextResponse.json(await mutate(revision, (state) => confirmProductionArtwork(state, unitId, actor)));
    }
    if (action === 'composeVersion') {
      const versionId = textValue(body.versionId, 'versionId');
      const composing = await mutate(revision, (state) => markVersionComposing(state, versionId));
      const composingGuard = productionActionAssertion({ ...body, ...productionActionSnapshot(composing, body) });
      const version = composing.mockupVersions.find((candidate) => candidate.id === versionId);
      if (!version) throw new Error(`找不到效果图版本：${versionId}`);
      const units = version.unitIds.map((unitId) => {
        const unit = composing.units.find((candidate) => candidate.id === unitId);
        if (!unit) throw new Error(`${versionId} 引用了不存在的定制单元：${unitId}`);
        return unit;
      });
      try {
        const output = await composeProductionMockup(version, units);
        return NextResponse.json(await mutate(composing.revision, (state) => completeVersionComposition(state, versionId, output), composingGuard));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          const failed = await mutate(composing.revision, (state) => failVersionComposition(state, versionId, message), composingGuard);
          return NextResponse.json({ error: `合成失败：${message}`, state: failed }, { status: 502 });
        } catch (persistError) {
          if (persistError instanceof ProductionRevisionConflictError || persistError instanceof ProductionArtworkConflictError) throw persistError;
          throw new Error(`合成失败且失败状态无法保存：${message}；${persistError instanceof Error ? persistError.message : String(persistError)}`);
        }
      }
    }
    if (action === 'approveVersion') {
      const versionId = textValue(body.versionId, 'versionId');
      const actor = textValue(body.actor, 'actor');
      return NextResponse.json(await mutate(revision, (state) => approveProductionVersion(state, versionId, actor)));
    }
    if (action === 'returnUnit') {
      const versionId = textValue(body.versionId, 'versionId');
      const unitId = textValue(body.unitId, 'unitId');
      const reason = textValue(body.reason, 'reason');
      return NextResponse.json(await mutate(revision, (state) => returnProductionUnit(state, versionId, unitId, reason)));
    }
    if (action === 'setBudget') {
      const budgetLimitCny = numberValue(body.budgetLimitCny, 'budgetLimitCny');
      return NextResponse.json(await mutate(revision, (state) => setProductionBudget(state, budgetLimitCny)));
    }
    throw new Error(`不支持的 action：${action || '(empty)'}`);
  } catch (error) {
    return errorResponse(error);
  }
}
