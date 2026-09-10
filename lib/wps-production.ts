import type { BrowserLogoTextVerification } from '@/lib/client/browser-logo-ocr';
import { sharedArtworkGroups } from './shared-artwork';
import type { ArtworkQualityMeasurement } from '@/lib/artwork-routing-standard';
import type { ArtworkMethodChoice } from '@/lib/artwork-routing-request';
import { parseGenerationPrompt } from '@/lib/artwork-generation-prompt';
import { ARTWORK_METHOD_OPTIONS, ARTWORK_METHOD_ROUTES } from '@/lib/artwork-routing-request';
import { ARTWORK_ROUTING_STANDARD } from '@/lib/artwork-routing-standard';
import { artworkAcceptanceIssues, retainArtworkQuality } from '@/lib/artwork-acceptance';
import { z } from 'zod';
import { artworkBlockingAmbiguities, artworkProcessingRoute, normalizeTaskReview } from '@/lib/task-review-analysis';
import { artworkPlanIssues } from '@/lib/artwork-reference';
import { assertArtworkDraft, type ArtworkDraft } from '@/lib/artwork-editor';
import { automaticArtworkLimits } from '@/lib/production-artwork-layout';
import { createHash } from 'node:crypto';
import { WPS_COMPOSITOR_VERSION } from '@/lib/confirmation-frame';
export { WPS_COMPOSITOR_VERSION } from '@/lib/confirmation-frame';

import type {
  GenerationUnit,
  SourceTaskRecord,
  SourceScope,
  TaskReview,
  TextMode,
} from '@/lib/batch-task-review';
import { taskPlacementSchema, garmentPlacementIssue, productionPlacementGeometry, requestedCatalogPlacement, type GarmentBinding } from '@/lib/production-garment';
import { PLACEMENT_DEFAULTS } from '@/lib/mockup';
import { PLACEMENT_KEYS, type PlacementKey } from '@/lib/types';
import { wpsSourceEvidence } from '@/lib/wps-source';
import { bindPrintSizeRequest, printSizeRequestSchema, type PrintSizeRequest } from '@/lib/print-size-request';

export const WPS_PRODUCTION_SCHEMA_VERSION = 1 as const;
export const WPS_PRODUCTION_ROUTE_VERSION = 'wps-production-route-v1';

export type ProductionRoute = 'auto' | 'hybrid' | 'model' | 'deterministic' | 'gpt-image-2' | 'blocked';
export type ProductionUnitStatus =
  | 'blocked'
  | 'pendingPlanConfirmation'
  | 'pendingArtwork'
  | 'pendingArtworkConfirmation'
  | 'artworkApproved'
  | 'failed';
export type MockupVersionStatus =
  | 'waitingArtwork'
  | 'readyToCompose'
  | 'composing'
  | 'pendingFinalConfirmation'
  | 'approved'
  | 'failed';
export type AttemptStatus =
  | 'queued'
  | 'submitted'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'unknownSubmission';

export type ProductionConfirmation = {
  actor: string;
  confirmedAt: string;
  fingerprint: string;
};

export type ProductionPlacement = {
  key: PlacementKey;
  manual?: { centerX: number; centerY: number; width: number };
  widthCm: number;
  offsetX: number;
  offsetY: number;
  rotation: number;
  templateVersion: '2208-v1' | 'catalog-v1';
  sizeMode?: 'standard' | 'widthCm' | 'heightCm';
  sizePolicy?: 'body-55-v1';
  heightCm?: number;
  requestedSize?: PrintSizeRequest;
  requestedSizeIssue?: string;
  sizeOverride?: boolean;
  catalogPosition?: 'upperBack' | 'backCenter' | 'frontCenter' | 'apronUpper' | 'apronPocket';
};

export type ArtworkValidation = {
  contentWarnings?: string[];
  contentIssues?: string[];
  quality?: ArtworkQualityMeasurement;
  qualityError?: string;
  qualityIssues?: string[];
  componentQuality?: Array<{ id: string; measurement: ArtworkQualityMeasurement }>;
  contentBounds?: { left: number; top: number; width: number; height: number };
  valid: boolean;
  mimeType: 'image/png';
  width: number;
  height: number;
  byteLength: number;
  sha256: string;
  transparentPixelRatio: number;
  visiblePixelRatio: number;
  checkedAt: string;
  ruleVersion: 'transparent-artwork-v1';
  issues: string[];
};

export type ProductionArtwork = {
  textVerification?: BrowserLogoTextVerification;
  draft?: ArtworkDraft;
  url: string;
  name: string;
  validation: ArtworkValidation;
  recipeFingerprint: string;
  createdAt: string;
};

export type ProductionAttempt = {
  id: string;
  unitId: string;
  service: Exclude<ProductionRoute, 'blocked'> | 'manual-upload';
  status: AttemptStatus;
  recipeFingerprint: string;
  providerTaskId: string | null;
  requestSummary: string;
  inputImageUrls: string[];
  prompt: string | null;
  promptHash: string | null;
  providerCreditsReserved: number | null;
  estimatedCostCny: number;
  actualCostCny: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProductionUnit = {
  sharedArtworkId?: string;
  sharedArtworkDetached?: boolean;
  sharedArtworkVersion?: number;
  sharedArtworkError?: string;
  cutoutMode?: import('@/lib/artwork-cutout').ArtworkCutoutMode;
  sourceAssessment?: import('./artwork-source-assessment').ArtworkSourceAssessment;
  generationPrompt?: string;
  id: string;
  sourceRecordId: string;
  garmentLabel: string;
  variantLabel: string;
  productCode: string | null;
  garment?: GarmentBinding | null;
  garmentMatchNote?: string;
  placement: ProductionPlacement | null;
  materialId: string | null;
  referenceMaterialIds: string[];
  sourceScope: SourceScope;
  textMode: TextMode | null;
  exactText: string;
  layoutNote: string;
  instruction: string;
  route: ProductionRoute;
  artworkMethod?: ArtworkMethodChoice;
  routeEvidence: string;
  ambiguities: string[];
  planFingerprint: string;
  recipeFingerprint: string;
  gateA: ProductionConfirmation | null;
  artwork: ProductionArtwork | null;
  previousArtwork?: ProductionArtwork;
  gateB: ProductionConfirmation | null;
  status: ProductionUnitStatus;
  attempts: ProductionAttempt[];
  error: string | null;
  returnReason: string | null;
  updatedAt: string;
};

export type ProductionRecord = {
  source: TaskReview['source'];
  summary: string;
  unitIds: string[];
};

export type MockupOutput = {
  url: string;
  name: string;
  sha256: string;
  width: number;
  height: number;
  byteLength: number;
  composeFingerprint: string;
  compositorVersion: typeof WPS_COMPOSITOR_VERSION | 'sharp-catalog-compositor-v2' | 'sharp-2208-compositor-v1';
  createdAt: string;
};

export type ProductionMockupVersion = {
  id: string;
  sourceRecordId: string;
  garmentLabel: string;
  variantLabel: string;
  productCode: string | null;
  garment?: GarmentBinding | null;
  garmentMatchNote?: string;
  unitIds: string[];
  status: MockupVersionStatus;
  composeFingerprint: string | null;
  output: MockupOutput | null;
  finalConfirmation: ProductionConfirmation | null;
  compositionError: string | null;
  updatedAt: string;
};

export type WpsProductionState = {
  sharedArtworks?: import('./shared-artwork').SharedArtwork[];
  schemaVersion: typeof WPS_PRODUCTION_SCHEMA_VERSION;
  revision: number;
  batchId: string;
  budgetLimitCny: number;
  records: ProductionRecord[];
  /** Persisted first-discovery order, independent of analysis and status. */
  sourceRecordOrder?: string[];
  units: ProductionUnit[];
  mockupVersions: ProductionMockupVersion[];
  updatedAt: string;
};

export type ProductionPlanPatch = Partial<Pick<
  ProductionUnit,
  | 'garment'
  | 'garmentMatchNote'
  | 'materialId'
  | 'garmentLabel'
  | 'variantLabel'
  | 'referenceMaterialIds'
  | 'sourceScope'
  | 'textMode'
  | 'exactText'
  | 'layoutNote'
  | 'instruction'
  | 'generationPrompt'
  | 'route'
  | 'artworkMethod'
  | 'cutoutMode'
  | 'routeEvidence'
  | 'ambiguities'
  | 'placement'
>>;

export class ProductionTransitionError extends Error {}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function requiredText(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} 必须是非空字符串，实际值：${String(value)}`);
  }
  return value.trim();
}

function validIsoDate(value: string, field: string) {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${field} 不是有效时间：${value}`);
}

function nonNegativeCost(value: number | null | undefined, field: string) {
  if (value === null || value === undefined) return value;
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new Error(`${field} 必须是 0 到 1000000 之间的有限数字，实际值：${value}`);
  }
  return value;
}

function normalizedActor(actor: string) {
  return requiredText(actor, 'actor').slice(0, 100);
}

function productionRoute(unit: GenerationUnit): ProductionRoute {
  if (isTextOnlyArtwork({ ...unit, materialId: unit.logo.materialId }) && !artworkBlockingAmbiguities(currentArtworkAmbiguities({ ...unit, materialId: unit.logo.materialId })).length) return 'deterministic';
  if (artworkBlockingAmbiguities(currentArtworkAmbiguities({ ...unit, materialId: unit.logo.materialId })).length > 0 || (!unit.logo.materialId && !isReferenceTextArtwork({ ...unit, materialId: unit.logo.materialId }))) return 'blocked';
  return unit.processingRoute === 'fidelity' ? 'deterministic' : unit.processingRoute ?? 'auto';
}

function assertArtworkRecipe(unit: ProductionUnit, source: SourceTaskRecord) {
  if (isReferenceTextArtwork(unit)) {
    const issues = artworkPlanIssues(source, unit);
    if (unit.referenceMaterialIds.some(id => !source.materials.some(material => material.id === id && (material.url || material.previewUrl)))) issues.push('缺少可读取的样式参考图');
    if (issues.length) throw new ProductionTransitionError(`制作方案尚不完整：${issues.join('；')}`);
  }
  if (artworkProcessingRoute(unit) === 'blocked' || artworkBlockingAmbiguities(currentArtworkAmbiguities(unit)).length) {
    throw new ProductionTransitionError(`请先补充图案要求：${unit.ambiguities.join('；') || unit.routeEvidence}`);
  }
  if ((!unit.materialId && !isTextOnlyArtwork(unit) && !isReferenceTextArtwork(unit)) || !unit.instruction.trim()) throw new ProductionTransitionError('缺少主要素材或制作要求，不能制作图案');
}

function defaultPlacement(key: PlacementKey | null): ProductionPlacement | null {
  if (!key) return null;
  return {
    key,
    ...PLACEMENT_DEFAULTS[key],
    templateVersion: '2208-v1',
  };
}

function recipeFingerprint(unit: Pick<
  ProductionUnit,
  'materialId' | 'referenceMaterialIds' | 'sourceScope' | 'textMode' | 'exactText' | 'layoutNote' | 'instruction' | 'route' | 'artworkMethod' | 'generationPrompt' | 'sourceAssessment'
>) {
  return sha256(JSON.stringify({
    materialId: unit.materialId,
    referenceMaterialIds: [...new Set(unit.referenceMaterialIds)].sort(),
    sourceScope: unit.sourceScope,
    textMode: unit.textMode,
    exactText: unit.exactText.trim(),
    layoutNote: unit.layoutNote.trim(),
    instruction: unit.instruction.trim(),
    ...(unit.sourceAssessment ? { sourceAssessment: unit.sourceAssessment } : {}),
    ...(unit.generationPrompt ? { generationPrompt: unit.generationPrompt.trim() } : {}),
    route: unit.route,
    ...(unit.artworkMethod ? { artworkMethod: unit.artworkMethod } : {}),
    routeVersion: WPS_PRODUCTION_ROUTE_VERSION,
    output: { format: 'png', background: 'transparent' },
  }));
}

function planFingerprint(unit: Pick<ProductionUnit, 'placement' | 'routeEvidence' | 'garmentLabel' | 'variantLabel' | 'ambiguities' | 'garment'> & Parameters<typeof recipeFingerprint>[0]) {
  return sha256(JSON.stringify({
    recipeFingerprint: recipeFingerprint(unit),
    garmentLabel: unit.garmentLabel.trim(),
    variantLabel: unit.variantLabel.trim(),
    placement: unit.placement,
    garment: unit.garment,
    routeEvidence: unit.routeEvidence.trim(),
    ambiguities: [...unit.ambiguities].sort(),
  }));
}

function confirmation(actor: string, fingerprint: string, now: Date): ProductionConfirmation {
  return {
    actor: normalizedActor(actor),
    confirmedAt: now.toISOString(),
    fingerprint,
  };
}

function versionId(sourceRecordId: string, garmentLabel: string, variantLabel: string) {
  return `mockup-${sha256(`${sourceRecordId}\n${garmentLabel}\n${variantLabel}`).slice(0, 20)}`;
}

function garmentIdentity(unit: Pick<ProductionUnit, 'garmentLabel' | 'garment'>) {
  return unit.garment ? `${unit.garment.variantId}:${unit.garment.assetVersionId}` : unit.garmentLabel;
}

function versionKey(unit: Pick<ProductionUnit, 'sourceRecordId' | 'garmentLabel' | 'variantLabel' | 'garment'>) {
  return `${unit.sourceRecordId}\u0000${garmentIdentity(unit)}\u0000${unit.variantLabel}`;
}

function unitStatus(unit: ProductionUnit): ProductionUnitStatus {
  if (unit.error) return 'failed';
  if (artworkProcessingRoute(unit) === 'blocked' || artworkBlockingAmbiguities(currentArtworkAmbiguities(unit)).length > 0) return 'blocked';
  if (!unit.artwork) return 'pendingArtwork';
  if (!unit.gateB) return 'pendingArtworkConfirmation';
  if (!unit.gateA) return 'pendingPlanConfirmation';
  return 'artworkApproved';
}

function composeFingerprint(units: ProductionUnit[]) {
  if (units.length === 0 || units.some((unit) => !unit.artwork || !unit.gateB || !unit.gateA || !unit.placement)) return null;
  return sha256(JSON.stringify({
    garmentAsset: units[0].garment ?? '/products/originals/2208-tea-green-polo.png',
    compositorVersion: units[0].garment === undefined ? 'sharp-2208-compositor-v1' : WPS_COMPOSITOR_VERSION,
    units: [...units]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((unit) => ({
        unitId: unit.id,
        artworkSha256: unit.artwork?.validation.sha256,
        garment: unit.garment,
        placement: unit.placement,
      })),
  }));
}

function versionStatus(version: ProductionMockupVersion, units: ProductionUnit[]): MockupVersionStatus {
  if (version.finalConfirmation && version.output) return 'approved';
  if (version.output) return 'pendingFinalConfirmation';
  if (version.compositionError) return 'failed';
  if (version.status === 'composing') return 'composing';
  return units.length > 0 && units.every((unit) => unit.status === 'artworkApproved') && Boolean(composeFingerprint(units))
    ? 'readyToCompose'
    : 'waitingArtwork';
}

function reconcileVersions(
  units: ProductionUnit[],
  previousVersions: ProductionMockupVersion[],
  now: Date,
) {
  const grouped = new Map<string, ProductionUnit[]>();
  for (const unit of units) {
    const key = versionKey(unit);
    grouped.set(key, [...(grouped.get(key) ?? []), unit]);
  }
  return [...grouped.values()].map((groupUnits) => {
    const first = groupUnits[0];
    const id = versionId(first.sourceRecordId, garmentIdentity(first), first.variantLabel);
    const previous = previousVersions.find((candidate) => candidate.id === id);
    const currentComposeFingerprint = composeFingerprint(groupUnits);
    const outputStillCurrent = Boolean(
      previous?.output
      && currentComposeFingerprint
      && previous.output.composeFingerprint === currentComposeFingerprint,
    );
    const composingStillCurrent = Boolean(
      previous?.status === 'composing'
      && currentComposeFingerprint
      && previous.composeFingerprint === currentComposeFingerprint,
    );
    const next: ProductionMockupVersion = {
      id,
      sourceRecordId: first.sourceRecordId,
      garmentLabel: first.garmentLabel,
      variantLabel: first.variantLabel,
      productCode: first.productCode,
      garment: first.garment,
      unitIds: groupUnits.map((unit) => unit.id).sort(),
      status: composingStillCurrent ? 'composing' : 'waitingArtwork',
      composeFingerprint: outputStillCurrent || composingStillCurrent ? currentComposeFingerprint : null,
      output: outputStillCurrent ? previous?.output ?? null : null,
      finalConfirmation: outputStillCurrent ? previous?.finalConfirmation ?? null : null,
      compositionError: outputStillCurrent ? previous?.compositionError ?? null : null,
      updatedAt: now.toISOString(),
    };
    next.status = versionStatus(next, groupUnits);
    return next;
  });
}

function checkedReviews(reviews: TaskReview[]) {
  if (!Array.isArray(reviews) || reviews.length === 0) throw new Error('reviews 必须是非空数组');
  const recordIds = new Set<string>();
  const unitIds = new Set<string>();
  for (const [reviewIndex, review] of reviews.entries()) {
    requiredText(review?.source?.recordId, `reviews[${reviewIndex}].source.recordId`);
    if (recordIds.has(review.source.recordId)) throw new Error(`WPS 源记录 ID 重复：${review.source.recordId}`);
    recordIds.add(review.source.recordId);
    requiredText(review.source.customerId, `reviews[${reviewIndex}].source.customerId`);
    requiredText(review.source.revision, `reviews[${reviewIndex}].source.revision`);
    requiredText(review.source.requirementText, `reviews[${reviewIndex}].source.requirementText`);
    if (!Array.isArray(review.units) || review.units.length === 0) {
      throw new Error(`reviews[${reviewIndex}].units 必须是非空数组`);
    }
    if (!Array.isArray(review.source.materials)) {
      throw new Error(`reviews[${reviewIndex}].source.materials 必须是数组`);
    }
    const materialIds = new Set(review.source.materials.map((material) => material.id));
    for (const [unitIndex, unit] of review.units.entries()) {
      requiredText(unit.id, `reviews[${reviewIndex}].units[${unitIndex}].id`);
      if (unitIds.has(unit.id)) throw new Error(`定制单元 ID 重复：${unit.id}`);
      unitIds.add(unit.id);
      requiredText(unit.garmentLabel, `${unit.id}.garmentLabel`);
      requiredText(unit.variantLabel, `${unit.id}.variantLabel`);
      requiredText(unit.instruction, `${unit.id}.instruction`);
      if (unit.placement && !PLACEMENT_KEYS.includes(unit.placement)) {
        throw new Error(`${unit.id}.placement 无效：${unit.placement}`);
      }
      if (unit.logo.materialId && !materialIds.has(unit.logo.materialId)) {
        throw new Error(`${unit.id} 引用了不存在的主要素材：${unit.logo.materialId}`);
      }
      for (const materialId of unit.referenceMaterialIds) {
        if (!materialIds.has(materialId)) throw new Error(`${unit.id} 引用了不存在的参考素材：${materialId}`);
      }
    }
  }
  return reviews.map(normalizeTaskReview);
}

function fromReviewUnit(review: TaskReview, unit: GenerationUnit, previous: ProductionUnit | undefined, now: Date) {
  const route = productionRoute(unit);
  const routeEvidence = route === 'blocked'
    ? unit.ambiguities.join('；') || '主要素材尚未指定。'
    : '沿用图案处理流程：自动判断保真、混合或模型生成；可修改路线、文字与排版，生成后需人工确认。';
  const candidate: ProductionUnit = {
    id: unit.id,
    sourceRecordId: review.source.recordId,
    garmentLabel: unit.garmentLabel,
    variantLabel: unit.variantLabel,
    productCode: unit.garment === undefined ? '2208' : unit.garment?.styleCode ?? null,
    garment: previous?.garment ? previous.garment : unit.garment,
    garmentMatchNote: unit.garmentMatchNote,
    placement: unit.garment === undefined ? defaultPlacement(unit.placement) : requestedCatalogPlacement(review.source, unit),
    materialId: unit.logo.materialId,
    sharedArtworkDetached: previous?.sharedArtworkDetached,
    ...(!previous?.sharedArtworkDetached && (previous?.sharedArtworkId || unit.sharedArtworkId) ? {
      sharedArtworkId: previous?.sharedArtworkId ?? unit.sharedArtworkId,
      sharedArtworkVersion: previous?.sharedArtworkVersion ?? 0,
    } : {}),
    referenceMaterialIds: [...new Set(unit.referenceMaterialIds)],
    sourceScope: unit.sourceScope,
    textMode: unit.textMode,
    exactText: unit.exactText,
    layoutNote: unit.layoutNote,
    instruction: unit.instruction,
    ...(unit.sourceAssessment ? { sourceAssessment: unit.sourceAssessment } : {}),
    ...(unit.generationPrompt ? { generationPrompt: unit.generationPrompt } : {}),
    route,
    routeEvidence,
    ambiguities: [...unit.ambiguities],
    planFingerprint: '',
    recipeFingerprint: '',
    gateA: null,
    artwork: null,
    gateB: null,
    status: 'pendingPlanConfirmation',
    attempts: [],
    error: null,
    returnReason: null,
    updatedAt: now.toISOString(),
  };
  if (previous?.garment) {
    candidate.productCode = previous.productCode;
    candidate.placement = previous.placement;
    candidate.garmentMatchNote = previous.garmentMatchNote;
  }
  candidate.recipeFingerprint = recipeFingerprint(candidate);
  candidate.planFingerprint = planFingerprint(candidate);
  if (previous) {
    candidate.gateA = previous.planFingerprint === candidate.planFingerprint ? previous.gateA : null;
    candidate.artwork = previous.artwork?.recipeFingerprint === candidate.recipeFingerprint ? previous.artwork : null;
    candidate.gateB = candidate.artwork && previous.gateB?.fingerprint === candidate.artwork.validation.sha256
      ? previous.gateB
      : null;
    if (previous.sharedArtworkId && previous.recipeFingerprint !== candidate.recipeFingerprint) {
      candidate.sharedArtworkId = undefined;
      candidate.sharedArtworkVersion = undefined;
      candidate.sharedArtworkDetached = true;
    }
    candidate.sharedArtworkError = candidate.sharedArtworkId ? previous.sharedArtworkError : undefined;
    candidate.attempts = previous.attempts;
    candidate.error = previous.recipeFingerprint === candidate.recipeFingerprint ? previous.error : null;
    candidate.returnReason = previous.returnReason;
  }
  candidate.status = unitStatus(candidate);
  return candidate;
}

export function emptyWpsProductionState(now = new Date()): WpsProductionState {
  return {
    schemaVersion: WPS_PRODUCTION_SCHEMA_VERSION,
    revision: 0,
    batchId: `batch-${now.toISOString().slice(0, 10)}`,
    budgetLimitCny: 10,
    records: [],
    units: [],
    mockupVersions: [],
    updatedAt: now.toISOString(),
  };
}

export function importTaskReviews(
  current: WpsProductionState,
  reviews: TaskReview[],
  now = new Date(),
): WpsProductionState {
  reviews = checkedReviews(reviews);
  const previousById = new Map(current.units.map((unit) => [unit.id, unit]));
  const units = reviews.flatMap((review) => review.units.map((unit) => fromReviewUnit(
    review,
    unit,
    previousById.get(unit.id),
    now,
  )));
  return {
    ...current,
    revision: current.revision + 1,
    records: reviews.map((review) => ({
      source: review.source,
      summary: review.summary,
      unitIds: review.units.map((unit) => unit.id),
    })),
    units,
    mockupVersions: reconcileVersions(units, current.mockupVersions, now),
    sharedArtworks: sharedArtworkGroups({ ...current, units }),
    updatedAt: now.toISOString(),
  };
}

export function upsertTaskReviews(
  current: WpsProductionState,
  reviews: TaskReview[],
  now = new Date(),
): WpsProductionState {
  reviews = checkedReviews(reviews);
  // Reanalysis of unchanged source material must not replace manual work, even
  // when the model renumbers units or omits one face of an existing version.
  reviews = reviews.filter(review => {
    const previous = current.records.find(record => record.source.recordId === review.source.recordId);
    return !previous || wpsSourceEvidence(previous.source) !== wpsSourceEvidence(review.source)
      || !current.units.some(unit => unit.sourceRecordId === review.source.recordId && (
        unit.artwork || unit.previousArtwork || unit.gateA || unit.gateB || unit.attempts.length
        || unit.routeEvidence === '人工修正制作要求'
      ));
  });
  const incomingRecordIds = new Set(reviews.map((review) => review.source.recordId));
  const changedSources = new Set(reviews.filter((review) => {
    const previous = current.records.find((record) => record.source.recordId === review.source.recordId);
    return previous && wpsSourceEvidence(previous.source) !== wpsSourceEvidence(review.source);
  }).map((review) => review.source.recordId));
  const previousById = new Map(current.units.filter((unit) => !changedSources.has(unit.sourceRecordId)).map((unit) => [unit.id, unit]));
  const incomingUnits = reviews.flatMap((review) => review.units.map((unit) => fromReviewUnit(
    review,
    unit,
    previousById.get(unit.id),
    now,
  )));
  const units = [
    ...current.units.filter((unit) => !incomingRecordIds.has(unit.sourceRecordId)),
    ...incomingUnits,
  ];
  const records = [
    ...current.records.filter((record) => !incomingRecordIds.has(record.source.recordId)),
    ...reviews.map((review) => ({
      source: review.source,
      summary: review.summary,
      unitIds: review.units.map((unit) => unit.id),
    })),
  ];
  return {
    ...current,
    revision: current.revision + 1,
    records,
    units,
    sharedArtworks: sharedArtworkGroups({ ...current, units }),
    mockupVersions: reconcileVersions(units, current.mockupVersions, now).map(version =>
      !incomingRecordIds.has(version.sourceRecordId) ? current.mockupVersions.find(previous => previous.id === version.id) ?? version : version),
    updatedAt: now.toISOString(),
  };
}

function checkedPlacement(value: ProductionPlacement | null) {
  if (value === null) return null;
  if (value.requestedSize !== undefined) printSizeRequestSchema.parse(value.requestedSize);
  if (value.requestedSizeIssue !== undefined) z.string().max(500).parse(value.requestedSizeIssue);
  if (value.sizeOverride !== undefined) z.boolean().parse(value.sizeOverride);
  if (value.sizePolicy !== undefined && value.sizePolicy !== 'body-55-v1') throw new Error(`placement.sizePolicy 无效：${value.sizePolicy}`);
  if (value.manual !== undefined) taskPlacementSchema.parse(value.manual);
  if (!PLACEMENT_KEYS.includes(value.key)) throw new Error(`placement.key 无效：${value.key}`);
  for (const field of ['widthCm', 'offsetX', 'offsetY', 'rotation'] as const) {
    if (!Number.isFinite(value[field])) throw new Error(`placement.${field} 必须是有限数字，实际值：${value[field]}`);
  }
  if (value.widthCm < 1 || value.widthCm > 50) throw new Error(`placement.widthCm 超出 1-50cm：${value.widthCm}`);
  if (Math.abs(value.offsetX) > 50 || Math.abs(value.offsetY) > 50) throw new Error('placement 偏移必须在 -50 到 50 之间');
  if (Math.abs(value.rotation) > 180) throw new Error(`placement.rotation 超出 -180 到 180：${value.rotation}`);
  if (value.catalogPosition !== undefined && !['upperBack', 'backCenter', 'frontCenter', 'apronUpper', 'apronPocket'].includes(value.catalogPosition)) throw new Error(`placement.catalogPosition 无效：${value.catalogPosition}`);
  if ((value.catalogPosition === 'apronUpper' || value.catalogPosition === 'apronPocket') && value.key !== 'frontCenter') throw new Error(`围裙位置 ${value.catalogPosition} 必须属于正面，实际：${value.key}`);
  if (value.templateVersion === 'catalog-v1') {
    if (!['standard', 'widthCm', 'heightCm'].includes(value.sizeMode ?? '')) throw new Error(`placement.sizeMode 无效：${value.sizeMode}`);
    if (value.sizeMode === 'heightCm' && (!Number.isFinite(value.heightCm) || value.heightCm! <= 0 || value.heightCm! > 100)) throw new Error(`placement.heightCm 无效：${value.heightCm}`);
  }
  if (!['2208-v1', 'catalog-v1'].includes(value.templateVersion)) throw new Error(`placement.templateVersion 无效：${value.templateVersion}`);
  return value;
}

function changedUnitState(
  state: WpsProductionState,
  unitId: string,
  transform: (unit: ProductionUnit) => ProductionUnit,
  now: Date,
) {
  let found = false;
  const units = state.units.map((unit) => {
    if (unit.id !== unitId) return unit;
    found = true;
    const next = transform(unit);
    next.status = unitStatus(next);
    next.updatedAt = now.toISOString();
    return next;
  });
  if (!found) throw new Error(`找不到定制单元：${unitId}`);
  return {
    ...state,
    revision: state.revision + 1,
    units,
    sharedArtworks: sharedArtworkGroups({ ...state, units }),
    mockupVersions: reconcileVersions(units, state.mockupVersions, now).map(version => {
      const previous = state.mockupVersions.find(candidate => candidate.id === version.id);
      return previous && !previous.unitIds.includes(unitId) && !version.unitIds.includes(unitId) ? previous : version;
    }),
    updatedAt: now.toISOString(),
  };
}

export function updateProductionPlan(
  state: WpsProductionState,
  unitId: string,
  patch: ProductionPlanPatch,
  now = new Date(),
) {
  const previous = state.units.find(unit => unit.id === unitId);
  const updated = changedUnitState(state, unitId, (unit) => {
    if (patch.cutoutMode !== undefined && !['auto', 'standard', 'meitu'].includes(patch.cutoutMode)) throw new Error('不支持的抠图方式');
    if (patch.artworkMethod !== undefined) {
      if (!ARTWORK_METHOD_OPTIONS.includes(patch.artworkMethod)) throw new Error('不支持的图案处理方式');
      patch = { ...patch, route: ARTWORK_METHOD_ROUTES[patch.artworkMethod] };
    }
    if (patch.route !== undefined && !['auto', 'hybrid', 'model', 'deterministic', 'gpt-image-2', 'blocked'].includes(patch.route)) {
      throw new Error(`route 无效：${patch.route}`);
    }
    if (patch.sourceScope !== undefined && !['subject', 'subjectWithFrame', 'wholeImage', 'custom'].includes(patch.sourceScope)) {
      throw new Error(`sourceScope 无效：${patch.sourceScope}`);
    }
    if (patch.textMode !== undefined && patch.textMode !== null && !['keep', 'replace', 'none'].includes(patch.textMode)) {
      throw new Error(`textMode 无效：${patch.textMode}`);
    }
    const next: ProductionUnit = {
      ...unit,
      ...patch,
      productCode: patch.garment === undefined ? unit.productCode : patch.garment?.styleCode ?? null,
      placement: patch.placement === undefined ? unit.placement : checkedPlacement(patch.placement?.templateVersion === 'catalog-v1'
        ? bindPrintSizeRequest(state.records.find(record => record.source.recordId === unit.sourceRecordId)!.source.requirementText, patch.placement)
        : patch.placement),
      referenceMaterialIds: patch.referenceMaterialIds === undefined
        ? unit.referenceMaterialIds
        : [...new Set(patch.referenceMaterialIds.map((value) => requiredText(value, 'referenceMaterialIds[]')))],
      ambiguities: patch.ambiguities === undefined
        ? unit.ambiguities
        : patch.ambiguities.map((value) => requiredText(value, 'ambiguities[]')),
      exactText: patch.exactText === undefined ? unit.exactText : patch.exactText.trim(),
      layoutNote: patch.layoutNote === undefined ? unit.layoutNote : patch.layoutNote.trim(),
      instruction: patch.instruction === undefined ? unit.instruction : requiredText(patch.instruction, 'instruction'),
      generationPrompt: patch.generationPrompt === undefined ? unit.generationPrompt : parseGenerationPrompt(patch.generationPrompt),
      garmentLabel: patch.garmentLabel === undefined ? unit.garmentLabel : requiredText(patch.garmentLabel, 'garmentLabel'),
      variantLabel: patch.variantLabel === undefined ? unit.variantLabel : requiredText(patch.variantLabel, 'variantLabel'),
      routeEvidence: patch.routeEvidence === undefined ? unit.routeEvidence : requiredText(patch.routeEvidence, 'routeEvidence'),
      gateA: unit.gateA,
      gateB: unit.gateB,
      artwork: unit.artwork,
      error: null,
      returnReason: null,
    };
    // Visual evidence belongs to the selected target, not to a later material/brief.
    if (['materialId', 'sourceScope', 'instruction', 'layoutNote'].some(key =>
      key in patch && JSON.stringify(next[key as keyof ProductionUnit]) !== JSON.stringify(unit[key as keyof ProductionUnit]))) next.sourceAssessment = undefined;
    // Legacy metadata edits cannot silently reuse a prompt authored for different inputs.
    if (!('generationPrompt' in patch) && ['materialId', 'referenceMaterialIds', 'sourceScope', 'textMode', 'exactText', 'instruction', 'layoutNote'].some(key =>
      key in patch && JSON.stringify(next[key as keyof ProductionUnit]) !== JSON.stringify(unit[key as keyof ProductionUnit]))) next.generationPrompt = undefined;
    // Validate content edits before changing fingerprints, artwork or gates.
    // Position-only updates remain available while an old recipe needs repair.
    if (['generationPrompt', 'materialId', 'referenceMaterialIds', 'sourceScope', 'instruction', 'layoutNote', 'textMode', 'exactText'].some(key => key in patch)) {
      const source = state.records.find(record => record.source.recordId === unit.sourceRecordId)!.source;
      const issues = artworkPlanIssues(source, next);
      if (issues.length) throw new ProductionTransitionError(`制作方案尚不完整：${issues.join('；')}`);
      next.ambiguities = next.ambiguities.filter(issue => !issue.startsWith('方案核对：'));
      if (next.route === 'blocked' && !artworkBlockingAmbiguities(next.ambiguities).length) next.route = 'auto';
    }
    next.recipeFingerprint = recipeFingerprint(next);
    next.planFingerprint = planFingerprint(next);
    if (next.planFingerprint !== unit.planFingerprint) next.gateA = null;
    if (next.recipeFingerprint !== unit.recipeFingerprint) {
      next.sharedArtworkDetached = Boolean(unit.sharedArtworkId || unit.sharedArtworkDetached);
      next.sharedArtworkId = undefined;
      next.sharedArtworkVersion = undefined;
      next.sharedArtworkError = undefined;
      next.previousArtwork = unit.artwork ?? unit.previousArtwork;
      next.artwork = null;
      next.gateB = null;
    }
    return next;
  }, now);
  const instruction = updated.units.find(unit => unit.id === unitId)!.instruction;
  if (previous && instruction !== previous.instruction) {
    updated.records = updated.records.map(record => record.source.recordId === previous.sourceRecordId
      ? { ...record, summary: record.summary.replace(previous.instruction, instruction) }
      : record);
  }
  return updated;
}

export function confirmProductionPlan(
  state: WpsProductionState,
  unitId: string,
  actor: string,
  now = new Date(),
) {
  return changedUnitState(state, unitId, (unit) => {
    const issues = [
      ...currentArtworkAmbiguities(unit),
      ...(isReferenceTextArtwork(unit) ? artworkPlanIssues(state.records.find(record => record.source.recordId === unit.sourceRecordId)!.source, unit) : []),
      ...(unit.garment !== undefined ? [garmentPlacementIssue(unit.garment, unit.placement)].filter((issue): issue is string => Boolean(issue)) : []),
      ...(artworkProcessingRoute(unit) === 'blocked' ? ['制作路线仍处于阻塞状态'] : []),
      ...(!unit.materialId && !isTextOnlyArtwork(unit) && !isReferenceTextArtwork(unit) ? ['主要素材未确认'] : []),
      ...(!unit.placement ? ['位置未确认'] : []),
      ...(!unit.instruction.trim() ? ['制作要求为空'] : []),
    ];
    if (issues.length > 0) throw new ProductionTransitionError(`门 A 不能确认：${issues.join('；')}`);
    if (unit.garment && unit.placement && unit.artwork) productionPlacementGeometry(unit.garment, unit.placement, (unit.artwork.validation.contentBounds?.width ?? unit.artwork.validation.width) / (unit.artwork.validation.contentBounds?.height ?? unit.artwork.validation.height));
    return {
      ...unit,
      gateA: confirmation(actor, unit.planFingerprint, now),
      error: null,
      returnReason: null,
    };
  }, now);
}

export function beginGptImage2Attempt(
  state: WpsProductionState,
  unitId: string,
  input: {
    attemptId: string;
    requestSummary: string;
    inputImageUrls: string[];
    prompt: string;
    promptHash: string;
    estimatedCostCny: number;
  },
  now = new Date(),
) {
  const estimatedCostCny = nonNegativeCost(input.estimatedCostCny, 'estimatedCostCny') ?? 0;
  if (estimatedCostCny <= 0) throw new Error(`GPT Image 2 提交前必须填写大于 0 的预计人民币费用，实际值：${estimatedCostCny}`);
  if (productionEstimatedCost(state) + estimatedCostCny > state.budgetLimitCny) {
    throw new ProductionTransitionError(
      `本次 GPT Image 2 提交将使预计费用超过批次上限：${productionEstimatedCost(state) + estimatedCostCny} > ${state.budgetLimitCny}`,
    );
  }
  return changedUnitState(state, unitId, (unit) => {
    assertArtworkRecipe(unit, state.records.find(record => record.source.recordId === unit.sourceRecordId)!.source);
    if (unit.route !== 'gpt-image-2') throw new ProductionTransitionError(`当前路线是 ${unit.route}，不能提交 GPT Image 2`);
    const active = unit.attempts.find((attempt) => attempt.recipeFingerprint === unit.recipeFingerprint
      && ['queued', 'submitted', 'processing', 'unknownSubmission'].includes(attempt.status));
    if (active) throw new ProductionTransitionError(`当前配方已有未结束尝试 ${active.id}（${active.status}），不能重复付费提交`);
    const attempt: ProductionAttempt = {
      id: requiredText(input.attemptId, 'attemptId'),
      unitId,
      service: 'gpt-image-2',
      status: 'queued',
      recipeFingerprint: unit.recipeFingerprint,
      providerTaskId: null,
      requestSummary: requiredText(input.requestSummary, 'requestSummary'),
      inputImageUrls: input.inputImageUrls.map((url) => requiredText(url, 'inputImageUrls[]')),
      prompt: requiredText(input.prompt, 'prompt'),
      promptHash: requiredText(input.promptHash, 'promptHash'),
      providerCreditsReserved: null,
      estimatedCostCny,
      actualCostCny: null,
      error: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    return {
      ...unit,
      attempts: [...unit.attempts, attempt],
      error: null,
      returnReason: null,
    };
  }, now);
}

export function updateProductionAttempt(
  state: WpsProductionState,
  unitId: string,
  attemptId: string,
  patch: Partial<Pick<ProductionAttempt, 'status' | 'providerTaskId' | 'providerCreditsReserved' | 'actualCostCny' | 'error'>>,
  now = new Date(),
) {
  return changedUnitState(state, unitId, (unit) => {
    const attempt = unit.attempts.find((candidate) => candidate.id === attemptId);
    if (!attempt) throw new Error(`找不到制作尝试：${attemptId}`);
    if (attempt.recipeFingerprint !== unit.recipeFingerprint) {
      throw new ProductionTransitionError(`制作尝试 ${attemptId} 属于旧配方，不能更新当前单元`);
    }
    if (patch.status !== undefined && !['queued', 'submitted', 'processing', 'completed', 'failed', 'unknownSubmission'].includes(patch.status)) {
      throw new Error(`attempt.status 无效：${patch.status}`);
    }
    nonNegativeCost(patch.providerCreditsReserved, 'providerCreditsReserved');
    nonNegativeCost(patch.actualCostCny, 'actualCostCny');
    const nextAttempt: ProductionAttempt = {
      ...attempt,
      ...patch,
      providerTaskId: patch.providerTaskId === undefined ? attempt.providerTaskId : patch.providerTaskId?.trim() || null,
      error: patch.error === undefined ? attempt.error : patch.error?.trim() || null,
      updatedAt: now.toISOString(),
    };
    return {
      ...unit,
      attempts: unit.attempts.map((candidate) => candidate.id === attemptId ? nextAttempt : candidate),
      error: nextAttempt.status === 'failed' ? nextAttempt.error || '制作尝试失败' : null,
    };
  }, now);
}

/** Legacy text plans can be normalized without turning a shared source into an individual edit. */
export function normalizeProductionTextPlan(state: WpsProductionState, unitId: string) {
  const source = state.units.find(unit => unit.id === unitId);
  if (!source) throw new Error('找不到文字图案');
  const targets = source.sharedArtworkId ? state.units.filter(unit => unit.sharedArtworkId === source.sharedArtworkId) : [source];
  let next = state;
  for (const unit of targets) {
    if (!isTextOnlyArtwork(unit)) throw new Error('此图稿不是纯文字要求');
    next = updateProductionPlan(next, unit.id, { textMode: 'replace', exactText: unit.exactText, generationPrompt: '', route: 'deterministic' });
  }
  const units = next.units.map(unit => {
    const previous = targets.find(target => target.id === unit.id);
    return previous ? { ...unit, sharedArtworkId: previous.sharedArtworkId, sharedArtworkDetached: previous.sharedArtworkDetached,
      sharedArtworkVersion: previous.sharedArtworkVersion } : unit;
  });
  return { ...next, units, sharedArtworks: sharedArtworkGroups({ ...state, units }), revision: state.revision + 1 };
}

export function attachProductionArtwork(
  state: WpsProductionState,
  unitId: string,
  input: {
    url: string;
    name: string;
    validation: ArtworkValidation;
    draft?: ArtworkDraft;
    automaticWidthCm?: number;
    prompt?: string | null;
    promptHash?: string | null;
    inputImageUrls?: string[];
    service: ProductionAttempt['service'];
    requestSummary: string;
    providerTaskId?: string | null;
    estimatedCostCny?: number;
    actualCostCny?: number | null;
  },
  attemptId: string,
  now = new Date(),
) {
  const existingUnit = state.units.find((unit) => unit.id === unitId);
  if (!existingUnit) throw new Error(`找不到定制单元：${unitId}`);
  if (input.service === 'manual-upload' && input.draft && existingUnit.artwork?.validation.sha256 === input.validation.sha256 && existingUnit.artwork.recipeFingerprint === existingUnit.recipeFingerprint) {
    return changedUnitState(state, unitId, unit => ({ ...unit, artwork: { ...unit.artwork!, draft: input.draft, name: input.name,
      validation: retainArtworkQuality(unit.artwork!.validation, input.validation) } }), now);
  }
  const existingAttempt = existingUnit.attempts.find((attempt) => attempt.id === attemptId);
  const estimatedCostCny = nonNegativeCost(input.estimatedCostCny, 'estimatedCostCny') ?? 0;
  const actualCostCny = nonNegativeCost(input.actualCostCny, 'actualCostCny') ?? null;
  if (!existingAttempt && productionEstimatedCost(state) + estimatedCostCny > state.budgetLimitCny) {
    throw new ProductionTransitionError(
      `本次提交将使预计费用超过批次上限：${productionEstimatedCost(state) + estimatedCostCny} > ${state.budgetLimitCny}`,
    );
  }
  return changedUnitState(state, unitId, (unit) => {
    assertArtworkRecipe(unit, state.records.find(record => record.source.recordId === unit.sourceRecordId)!.source);
    requiredText(input.url, 'artwork.url');
    requiredText(input.name, 'artwork.name');
    validIsoDate(input.validation.checkedAt, 'artwork.validation.checkedAt');
    if (input.draft !== undefined) assertArtworkDraft(input.draft);
    if (input.service !== 'manual-upload' && input.service !== artworkProcessingRoute(unit)) {
      throw new ProductionTransitionError(`制作服务 ${input.service} 与当前路线 ${unit.route} 不一致`);
    }
    const attempt: ProductionAttempt = {
      ...(existingAttempt ?? {
        id: requiredText(attemptId, 'attemptId'),
        unitId,
        service: input.service,
        recipeFingerprint: unit.recipeFingerprint,
        providerTaskId: null,
        inputImageUrls: input.inputImageUrls ?? [],
        prompt: input.prompt ?? null,
        promptHash: input.promptHash ?? null,
        providerCreditsReserved: null,
        createdAt: now.toISOString(),
      }),
      status: input.validation.valid ? 'completed' : 'failed',
      providerTaskId: input.providerTaskId?.trim() || existingAttempt?.providerTaskId || null,
      requestSummary: requiredText(input.requestSummary, 'requestSummary'),
      estimatedCostCny: existingAttempt?.estimatedCostCny ?? estimatedCostCny,
      actualCostCny,
      error: input.validation.valid ? null : input.validation.issues.join('；') || '透明素材自动检查失败',
      updatedAt: now.toISOString(),
    };
    let placement = unit.placement;
    if (input.automaticWidthCm !== undefined) {
      if (!placement || (placement.sizeMode && placement.sizeMode !== 'standard')) throw new ProductionTransitionError('自动排版不得覆盖已指定的印花尺寸');
      const width = input.automaticWidthCm;
      const content = input.validation.contentBounds ?? input.validation;
      const height = width * content.height / content.width;
      const limit = automaticArtworkLimits(placement);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > limit.width || height > limit.height) throw new ProductionTransitionError(`自动排版尺寸 ${width} × ${height} cm 超出允许范围 ${limit.width} × ${limit.height} cm`);
      placement = { ...placement, sizeMode: 'widthCm', sizePolicy: 'body-55-v1', widthCm: width };
    }
    const previousContent = unit.artwork?.validation.contentBounds ?? unit.artwork?.validation;
    const nextContent = input.validation.contentBounds ?? input.validation;
    // A new visible aspect ratio changes the footprint at the same print size.
    const artworkShapeChanged = input.validation.valid && previousContent !== undefined
      && previousContent.width * nextContent.height !== previousContent.height * nextContent.width;
    return {
      ...unit,
      placement,
      planFingerprint: planFingerprint({ ...unit, placement }),
      gateA: placement === unit.placement && !artworkShapeChanged ? unit.gateA : null,
      artwork: input.validation.valid ? {
        url: input.url,
        name: input.name,
        ...(input.draft ? { draft: input.draft } : {}),
        validation: input.validation,
        recipeFingerprint: unit.recipeFingerprint,
        createdAt: now.toISOString(),
      } : null,
      gateB: null,
      previousArtwork: undefined,
      attempts: existingAttempt
        ? unit.attempts.map((candidate) => candidate.id === attemptId ? attempt : candidate)
        : [...unit.attempts, attempt],
      error: attempt.error,
      returnReason: null,
    };
  }, now);
}

export function saveProductionTextVerification(state: WpsProductionState, unitId: string, artworkSha256: string, result: BrowserLogoTextVerification, now = new Date()) {
  const checked = productionTextVerificationSchema.parse(result);
  return changedUnitState(state, unitId, unit => {
    if (!unit.artwork || unit.artwork.validation.sha256 !== artworkSha256) throw new ProductionTransitionError('图案已变化，旧文字检查不能写入');
    return { ...unit, artwork: { ...unit.artwork, textVerification: checked } };
  }, now);
}

export const productionTextVerificationSchema = z.object({
  expectedText: z.string().min(1), recognizedText: z.string(), normalizedExpectedText: z.string().min(1), normalizedRecognizedText: z.string(),
  minimumScore: z.number().min(0).max(1), exactText: z.boolean(), passed: z.boolean(),
  reason: z.enum(['passed', 'noText', 'textMismatch', 'lowConfidence']), detectedLines: z.number().int().min(0),
  durationMs: z.number().min(0), contrastBackground: z.enum(['white', 'black']),
}).strict();

export function placeProductionArtwork(state: WpsProductionState, unitId: string, placement: ProductionPlacement, validation: ArtworkValidation, actor: string, now = new Date()) {
  const unit = state.units.find(candidate => candidate.id === unitId);
  if (!unit?.garment || !unit.artwork || !unit.gateB) throw new ProductionTransitionError('请先选择衣服并确认 Logo');
  if (!placement.manual) throw new ProductionTransitionError('请在衣服画布上核对本次位置');
  if (!validation.valid || validation.sha256 !== unit.artwork.validation.sha256 || unit.gateB.fingerprint !== validation.sha256) throw new ProductionTransitionError('Logo 文件已变化或透明检查未通过，请重新确认');
  const refreshed = { ...state, units: state.units.map(candidate => candidate.id === unitId ? { ...candidate, artwork: { ...unit.artwork!, validation: retainArtworkQuality(unit.artwork!.validation, validation) } } : candidate) };
  const positioned = updateProductionPlan(refreshed, unitId, { placement }, now);
  const confirmed = confirmProductionPlan(positioned, unitId, actor, now);
  return { ...confirmed, revision: state.revision + 1 };
}

export function confirmProductionArtwork(
  state: WpsProductionState,
  unitId: string,
  actor: string,
  now = new Date(),
) {
  return changedUnitState(state, unitId, (unit) => {
    assertArtworkRecipe(unit, state.records.find(record => record.source.recordId === unit.sourceRecordId)!.source);
    if (!unit.artwork || unit.artwork.recipeFingerprint !== unit.recipeFingerprint) {
      throw new ProductionTransitionError('当前配方还没有可确认的完整素材图');
    }
    if (!unit.artwork.validation.valid) throw new ProductionTransitionError('透明素材自动检查未通过');
    const qualityIssues = artworkAcceptanceIssues(unit.artwork.validation);
    if (qualityIssues.length) throw new ProductionTransitionError(`图案文件或制作检查未通过：${qualityIssues.join('；')}`);
    return {
      ...unit,
      gateB: confirmation(actor, unit.artwork.validation.sha256, now),
      error: null,
      returnReason: null,
    };
  }, now);
}

export function saveProductionArtworkQuality(state: WpsProductionState, unitId: string, validation: ArtworkValidation, now = new Date()) {
  return changedUnitState(state, unitId, unit => {
    if (!unit.artwork || unit.artwork.validation.sha256 !== validation.sha256) throw new ProductionTransitionError('图案已变化，本次评分不能用于新文件');
    return { ...unit, artwork: { ...unit.artwork, validation }, gateB: artworkAcceptanceIssues(validation).length ? null : unit.gateB };
  }, now);
}

/** Explicit maintenance scope: match frozen file identities and never clear a new-flow result. */
export function clearLegacyArtworkResults(state: WpsProductionState, targets: Array<{ unitId: string; sha256: string }>, now = new Date()) {
  if (!targets.length || new Set(targets.map(target => target.unitId)).size !== targets.length) throw new ProductionTransitionError('旧结果清理范围为空或包含重复单元');
  for (const target of targets) {
    const unit = state.units.find(unit => unit.id === target.unitId);
    if (!unit?.artwork || unit.artwork.validation.sha256 !== target.sha256) throw new ProductionTransitionError(`图案已变化，停止清理：${target.unitId}`);
    const preprocessing = unit.artwork.draft?.preprocessing;
    if (preprocessing?.routingReport || preprocessing?.promptVersion === 'artwork-standard-prompts-v1'
      || unit.artwork.validation.quality?.protocol === ARTWORK_ROUTING_STANDARD.scoreProtocol) throw new ProductionTransitionError(`不能清理新流程结果：${target.unitId}`);
    if (unit.attempts.some(attempt => ['queued', 'submitted', 'processing', 'unknownSubmission'].includes(attempt.status))) throw new ProductionTransitionError(`仍有未完成调用，停止清理：${target.unitId}`);
  }
  const ids = new Set(targets.map(target => target.unitId));
  const updatedAt = now.toISOString();
  const units = state.units.map(unit => {
    if (!ids.has(unit.id)) return unit;
    const next = { ...unit, artwork: null, gateA: null, gateB: null, attempts: [], error: null, returnReason: null, updatedAt };
    return { ...next, status: unitStatus(next) };
  });
  const mockupVersions = state.mockupVersions.map(version => version.unitIds.some(id => ids.has(id))
    ? { ...version, output: null, finalConfirmation: null, composeFingerprint: null, compositionError: null, status: 'waitingArtwork' as const, updatedAt }
    : version);
  return { ...state, revision: state.revision + 1, units, mockupVersions, updatedAt };
}

function changedVersionState(
  state: WpsProductionState,
  versionIdValue: string,
  transform: (version: ProductionMockupVersion, units: ProductionUnit[]) => ProductionMockupVersion,
  now: Date,
) {
  let found = false;
  const versions = state.mockupVersions.map((version) => {
    if (version.id !== versionIdValue) return version;
    found = true;
    const units = version.unitIds.map((unitId) => {
      const unit = state.units.find((candidate) => candidate.id === unitId);
      if (!unit) throw new Error(`${version.id} 引用了不存在的定制单元：${unitId}`);
      return unit;
    });
    const next = transform(version, units);
    next.status = versionStatus(next, units);
    next.updatedAt = now.toISOString();
    return next;
  });
  if (!found) throw new Error(`找不到效果图版本：${versionIdValue}`);
  return {
    ...state,
    revision: state.revision + 1,
    mockupVersions: versions,
    updatedAt: now.toISOString(),
  };
}

export function markVersionComposing(
  state: WpsProductionState,
  versionIdValue: string,
  now = new Date(),
) {
  return changedVersionState(state, versionIdValue, (version, units) => {
    const fingerprint = composeFingerprint(units);
    if (!fingerprint || units.some((unit) => unit.status !== 'artworkApproved')) {
      throw new ProductionTransitionError('当前版本仍有位置未通过门 A 或素材未通过门 B，不能合成');
    }
    return {
      ...version,
      status: 'composing',
      composeFingerprint: fingerprint,
      output: null,
      finalConfirmation: null,
      compositionError: null,
    };
  }, now);
}

export function completeVersionComposition(
  state: WpsProductionState,
  versionIdValue: string,
  output: MockupOutput,
  now = new Date(),
) {
  return changedVersionState(state, versionIdValue, (version, units) => {
    const currentFingerprint = composeFingerprint(units);
    if (!currentFingerprint || output.composeFingerprint !== currentFingerprint) {
      throw new ProductionTransitionError('合成期间素材或位置已经变化，旧结果不能覆盖当前版本');
    }
    return {
      ...version,
      composeFingerprint: currentFingerprint,
      output,
      finalConfirmation: null,
      compositionError: null,
    };
  }, now);
}

export function failVersionComposition(
  state: WpsProductionState,
  versionIdValue: string,
  error: string,
  now = new Date(),
) {
  return changedVersionState(state, versionIdValue, (version) => ({
    ...version,
    output: null,
    finalConfirmation: null,
    compositionError: requiredText(error, 'compositionError'),
  }), now);
}

export function approveProductionVersion(
  state: WpsProductionState,
  versionIdValue: string,
  actor: string,
  now = new Date(),
) {
  return changedVersionState(state, versionIdValue, (version) => {
    if (!version.output || !version.composeFingerprint) {
      throw new ProductionTransitionError('当前版本还没有可确认的完整效果图');
    }
    if (version.output.compositorVersion !== WPS_COMPOSITOR_VERSION) {
      throw new ProductionTransitionError('请先更新为带框客户图，再确认客户成品');
    }
    if (version.output.composeFingerprint !== version.composeFingerprint) {
      throw new ProductionTransitionError('效果图与当前 compose fingerprint 不一致');
    }
    return {
      ...version,
      finalConfirmation: confirmation(actor, version.output.sha256, now),
      compositionError: null,
    };
  }, now);
}

export function returnProductionUnit(
  state: WpsProductionState,
  versionIdValue: string,
  unitId: string,
  reason: string,
  now = new Date(),
) {
  const version = state.mockupVersions.find((candidate) => candidate.id === versionIdValue);
  if (!version) throw new Error(`找不到效果图版本：${versionIdValue}`);
  if (!version.unitIds.includes(unitId)) {
    throw new ProductionTransitionError(`${unitId} 不属于效果图版本 ${versionIdValue}`);
  }
  return changedUnitState(state, unitId, (unit) => ({
    ...unit,
    gateB: null,
    error: null,
    returnReason: requiredText(reason, 'reason'),
  }), now);
}

export function setProductionBudget(
  state: WpsProductionState,
  budgetLimitCny: number,
  now = new Date(),
) {
  if (!Number.isFinite(budgetLimitCny) || budgetLimitCny < 0 || budgetLimitCny > 1_000_000) {
    throw new Error(`budgetLimitCny 必须在 0 到 1000000 之间，实际值：${budgetLimitCny}`);
  }
  return {
    ...state,
    revision: state.revision + 1,
    budgetLimitCny,
    updatedAt: now.toISOString(),
  };
}

export function productionActualCost(state: WpsProductionState) {
  return state.units.reduce((total, unit) => total + unit.attempts.reduce(
    (unitTotal, attempt) => unitTotal + (attempt.actualCostCny ?? 0),
    0,
  ), 0);
}

export function productionEstimatedCost(state: WpsProductionState) {
  return state.units.reduce((total, unit) => total + unit.attempts.reduce(
    (unitTotal, attempt) => unitTotal + attempt.estimatedCostCny,
    0,
  ), 0);
}

export function selectProductionGarment(state: WpsProductionState, unitId: string, garment: GarmentBinding, now = new Date()) {
  const target = state.units.find(unit => unit.id === unitId);
  if (!target) throw new Error(`找不到定制单元：${unitId}`);
  const group = state.mockupVersions.find(version => version.unitIds.includes(unitId));
  const affected = new Set(group?.unitIds ?? [unitId]);
  let next = state;
  for (const unit of state.units.filter(unit => affected.has(unit.id))) {
    next = updateProductionPlan(next, unit.id, { garment, garmentMatchNote: garment.evidence,
      placement: unit.placement ? { ...unit.placement, templateVersion: 'catalog-v1', sizePolicy: 'body-55-v1', sizeMode: unit.placement.templateVersion === 'catalog-v1' ? unit.placement.sizeMode : 'standard' } : null,
    }, now);
  }
  return { ...next, revision: state.revision + 1 };
}
import { currentArtworkAmbiguities, isReferenceTextArtwork, isTextOnlyArtwork } from '@/lib/artwork-reference';
