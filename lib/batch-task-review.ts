import type { GarmentBinding, GarmentRequest } from '@/lib/production-garment';
import { PLACEMENT_DEFAULTS, PLACEMENT_LABELS } from '@/lib/mockup';
import { productByCode } from '@/lib/products';
import {
  artworkDraftExactText,
  type ArtworkDraft,
} from '@/lib/artwork-editor';
import type { MockupTask, PlacementKey } from '@/lib/types';

export type TaskMaterial = {
  originalUrl?: string | null;
  originalPreviewUrl?: string | null;
  id: string;
  name: string;
  description: string;
  previewUrl: string | null;
  url: string | null;
};

export type SourceTaskRecord = {
  recordId: string;
  customerId: string;
  revision: string;
  requirementText: string;
  productStyleText: string;
  materials: TaskMaterial[];
  wpsSource?: {
    fileId: string;
    sheetId: number;
    sheetName: string;
    statusFieldName: string | null;
    status: string;
    statusOptions: string[];
    statusWritable?: boolean;
    statusNote?: string;
  };
};

export type TextMode = 'keep' | 'replace' | 'none';
export type SourceScope = 'subject' | 'subjectWithFrame' | 'wholeImage' | 'custom';
export type ArtworkProcessingRouteMode = 'auto' | 'fidelity' | 'hybrid' | 'model';
export type ReviewFilter = 'all' | 'confirmed' | 'pending';

export type LogoSelection = {
  materialId: string | null;
  url: string | null;
  name: string;
};

export type GenerationUnit = {
  generationPrompt?: string;
  garmentRequest?: GarmentRequest;
  garment?: GarmentBinding | null;
  garmentMatchNote?: string;
  id: string;
  garmentLabel: string;
  variantLabel: string;
  productCode: string | null;
  placement: PlacementKey | null;
  logo: LogoSelection;
  referenceMaterialIds: string[];
  sourceScope: SourceScope;
  processingRoute?: ArtworkProcessingRouteMode;
  textMode: TextMode | null;
  exactText: string;
  layoutNote: string;
  instruction: string;
  ambiguities: string[];
  artworkDraft: ArtworkDraft | null;
  needsRegeneration: boolean;
  confirmed: boolean;
};

export type TaskReview = {
  source: SourceTaskRecord;
  summary: string;
  units: GenerationUnit[];
};

export type TaskReviewDisplayGroup = {
  review: TaskReview;
  units: GenerationUnit[];
};

export function taskReviewDisplayGroups(
  reviews: TaskReview[],
  filter: ReviewFilter,
): TaskReviewDisplayGroup[] {
  return reviews.flatMap((review) => {
    const units = review.units.filter((unit) => filter === 'all'
      || (filter === 'confirmed' ? unit.confirmed : !unit.confirmed));
    return units.length > 0 ? [{ review, units }] : [];
  });
}

export function selectedMaterial(
  review: TaskReview,
  materialId: string | null,
) {
  if (!materialId) return null;
  return review.source.materials.find((material) => material.id === materialId) ?? null;
}

export function artworkRecipeFingerprint(unit: GenerationUnit) {
  return JSON.stringify({
    materialId: unit.logo.materialId,
    referenceMaterialIds: unit.referenceMaterialIds,
    sourceScope: unit.sourceScope,
    processingRoute: unit.processingRoute ?? 'auto',
    textMode: unit.textMode,
    exactText: unit.exactText.trim(),
    layoutNote: unit.layoutNote.trim(),
    instruction: unit.instruction.trim(),
    ...(unit.generationPrompt ? { generationPrompt: unit.generationPrompt.trim() } : {}),
  });
}

export function preparedArtworkUnit(
  current: GenerationUnit,
  requestFingerprint: string,
  input: { draft: ArtworkDraft; url: string; name: string },
) {
  if (artworkRecipeFingerprint(current) !== requestFingerprint) {
    throw new Error('生成期间制作要求或素材已变化，这次结果没有覆盖当前图案，请重新生成');
  }
  return {
    ...current,
    artworkDraft: input.draft,
    logo: { ...current.logo, url: input.url, name: input.name },
    needsRegeneration: false,
    confirmed: false,
  };
}

export function editedArtworkUnit(
  current: GenerationUnit,
  input: { draft: ArtworkDraft; url: string; name: string },
) {
  return {
    ...current,
    artworkDraft: input.draft,
    logo: { ...current.logo, url: input.url, name: input.name },
    needsRegeneration: false,
    confirmed: false,
  };
}

export function unitReviewIssues(review: TaskReview, unit: GenerationUnit) {
  const issues: string[] = [];
  if (!unit.productCode || !productByCode(unit.productCode)) issues.push('请确认并选择衣服款式');
  if (!unit.placement) issues.push('请确认制作位置');
  if (!unit.logo.materialId || !selectedMaterial(review, unit.logo.materialId)) {
    issues.push('请确认主要图形来自哪张素材图');
  }
  if (!unit.logo.url) issues.push('请生成或上传可确认的完整制作图案');
  if (unit.needsRegeneration) issues.push('制作要求或主要素材已修改，请按新要求重新生成完整制作图案');
  if (!unit.textMode) issues.push('请确认文字是保留、替换还是不使用');
  if (unit.textMode === 'replace' && unit.exactText.trim().length === 0) {
    issues.push('请填写需要出图的准确文字');
  }
  if (unit.artworkDraft?.mode === 'structured'
    && unit.textMode === 'replace'
    && artworkDraftExactText(unit.artworkDraft) !== unit.exactText.trim()) {
    issues.push('结构化图案中的文字与当前准确文字不一致');
  }
  if (unit.instruction.trim().length === 0) issues.push('请确认该生成单元的完整制作要求');
  return issues;
}

export function unitCreationIssues(review: TaskReview, unit: GenerationUnit) {
  const issues = unitReviewIssues(review, unit);
  if (!unit.confirmed) issues.push('该生成单元还没有人工确认');
  return issues;
}

export function reviewCreationIssues(review: TaskReview) {
  return review.units.flatMap((unit) => unitCreationIssues(review, unit)
    .map((issue) => `${unit.garmentLabel}·${unit.variantLabel}·${unit.placement ? PLACEMENT_LABELS[unit.placement] : '未定位'}：${issue}`));
}

export function canConfirmUnit(review: TaskReview, unit: GenerationUnit) {
  return unitReviewIssues(review, unit).length === 0;
}

export function canCreateBatchTasks(reviews: TaskReview[]) {
  return reviews.length > 0
    && reviews.every((review) => review.units.length > 0 && reviewCreationIssues(review).length === 0);
}

type TaskGroup = {
  sourceRecordId: string;
  garmentLabel: string;
  variantLabel: string;
  productCode: string;
  units: GenerationUnit[];
};

function confirmedTaskGroups(reviews: TaskReview[]) {
  const groups = new Map<string, TaskGroup>();
  for (const review of reviews) {
    for (const unit of review.units) {
      const issues = unitCreationIssues(review, unit);
      if (issues.length > 0) {
        throw new Error(`${review.source.recordId}/${unit.id} 不能创建批量任务：${issues.join('；')}`);
      }
      const productCode = unit.productCode as string;
      const key = [review.source.recordId, unit.garmentLabel, unit.variantLabel, productCode].join('::');
      const group = groups.get(key) ?? {
        sourceRecordId: review.source.recordId,
        garmentLabel: unit.garmentLabel,
        variantLabel: unit.variantLabel,
        productCode,
        units: [],
      };
      if (group.units.some((existing) => existing.placement === unit.placement)) {
        throw new Error(`${review.source.recordId} 的 ${unit.garmentLabel}/${unit.variantLabel} 重复设置 ${unit.placement}`);
      }
      group.units.push(unit);
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}

export function createMockupTasksFromReviews(
  reviews: TaskReview[],
  now = new Date(),
  idFactory = () => crypto.randomUUID(),
): MockupTask[] {
  const timestamp = now.toISOString();
  return confirmedTaskGroups(reviews).map((group) => ({
    id: idFactory(),
    productCode: group.productCode,
    placements: Object.fromEntries(group.units.map((unit) => {
      const placement = unit.placement as PlacementKey;
      return [placement, {
        logoUrl: unit.logo.url as string,
        logoName: unit.logo.name,
        ...PLACEMENT_DEFAULTS[placement],
      }];
    })),
    createdAt: timestamp,
    updatedAt: timestamp,
    exportedAt: null,
  }));
}

export function createConfirmedMockupTasksFromReviews(
  reviews: TaskReview[],
  now = new Date(),
  idFactory = () => crypto.randomUUID(),
) {
  const confirmedReviews = reviews
    .map((review) => ({
      ...review,
      units: review.units.filter((unit) => unit.confirmed),
    }))
    .filter((review) => review.units.length > 0);
  if (confirmedReviews.length === 0) {
    throw new Error('还没有人工确认且可生成的制作图案任务');
  }
  return createMockupTasksFromReviews(confirmedReviews, now, idFactory);
}
