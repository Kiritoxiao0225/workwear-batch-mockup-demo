import { usesProductionCloud } from './production-storage';
import { printSizeRequestSchema } from '@/lib/print-size-request';
import { readCloudProductionState, commitCloudProductionState, completedProductionSave } from './production-cloud-state';
import { assertArtworkDraft } from '@/lib/artwork-editor';
import { taskPlacementSchema, garmentBindingSchema } from '@/lib/production-garment';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  emptyWpsProductionState,
  productionTextVerificationSchema,
  WPS_COMPOSITOR_VERSION,
  WPS_PRODUCTION_SCHEMA_VERSION,
  type WpsProductionState,
} from '@/lib/wps-production';
import { PLACEMENT_KEYS } from '@/lib/types';

const STATE_FILE = path.join(process.cwd(), 'data', 'wps-production-state.json');
let writeQueue = Promise.resolve();

export class ProductionRevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`生产状态已被其他操作更新：期望 revision ${expected}，实际为 ${actual}`);
  }
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串${nullable ? '或 null' : ''}`);
}

function finiteNumber(value: unknown, field: string, minimum = -Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${field} 必须是大于等于 ${minimum} 的有限数字，实际值：${String(value)}`);
  }
}

function isoDate(value: unknown, field: string) {
  stringValue(value, field);
  if (Number.isNaN(Date.parse(value as string))) throw new Error(`${field} 不是有效时间：${String(value)}`);
}

function stringArray(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  value.forEach((entry, index) => stringValue(entry, `${field}[${index}]`));
}

export function assertWpsProductionState(value: unknown): asserts value is WpsProductionState {
  const state = objectValue(value, 'state');
  if (state.schemaVersion !== WPS_PRODUCTION_SCHEMA_VERSION) {
    throw new Error(`state.schemaVersion 无效：${String(state.schemaVersion)}`);
  }
  finiteNumber(state.revision, 'state.revision', 0);
  stringValue(state.batchId, 'state.batchId');
  finiteNumber(state.budgetLimitCny, 'state.budgetLimitCny', 0);
  isoDate(state.updatedAt, 'state.updatedAt');
  if (!Array.isArray(state.records) || !Array.isArray(state.units) || !Array.isArray(state.mockupVersions)) {
    throw new Error('state.records、state.units、state.mockupVersions 必须是数组');
  }

  const recordIds = new Set<string>();
  const unitIds = new Set<string>();
  state.records.forEach((rawRecord, index) => {
    const record = objectValue(rawRecord, `state.records[${index}]`);
    const source = objectValue(record.source, `state.records[${index}].source`);
    stringValue(source.recordId, `state.records[${index}].source.recordId`);
    stringValue(source.customerId, `state.records[${index}].source.customerId`);
    stringValue(source.revision, `state.records[${index}].source.revision`);
    stringValue(source.requirementText, `state.records[${index}].source.requirementText`);
    if (!Array.isArray(source.materials)) throw new Error(`state.records[${index}].source.materials 必须是数组`);
    stringValue(record.summary, `state.records[${index}].summary`);
    stringArray(record.unitIds, `state.records[${index}].unitIds`);
    if (recordIds.has(source.recordId as string)) throw new Error(`生产状态包含重复 WPS 记录：${source.recordId}`);
    recordIds.add(source.recordId as string);
  });

  state.units.forEach((rawUnit, index) => {
    const unit = objectValue(rawUnit, `state.units[${index}]`);
    for (const field of ['id', 'sourceRecordId', 'garmentLabel', 'variantLabel', 'planFingerprint', 'recipeFingerprint', 'routeEvidence', 'instruction', 'updatedAt'] as const) {
      stringValue(unit[field], `state.units[${index}].${field}`);
    }
    stringValue(unit.productCode, `state.units[${index}].productCode`, true);
    if (unit.artworkMethod !== undefined && !['auto', 'preserve', 'redraw', 'compose', 'generate'].includes(String(unit.artworkMethod))) throw new Error('无效图案处理方式');
    if (unit.cutoutMode !== undefined && !['auto', 'standard', 'meitu'].includes(String(unit.cutoutMode))) throw new Error('无效抠图方式');
    if (unit.garment != null) {
      const garment = garmentBindingSchema.parse(unit.garment);
      if (unit.productCode !== garment.styleCode) throw new Error(`衣服款号与绑定不一致：${unit.productCode} / ${garment.styleCode}`);
    }
    if (!['auto', 'hybrid', 'model', 'deterministic', 'gpt-image-2', 'blocked'].includes(unit.route as string)) throw new Error(`state.units[${index}].route 无效`);
    if (!['blocked', 'pendingPlanConfirmation', 'pendingArtwork', 'pendingArtworkConfirmation', 'artworkApproved', 'failed'].includes(unit.status as string)) {
      throw new Error(`state.units[${index}].status 无效`);
    }
    stringArray(unit.referenceMaterialIds, `state.units[${index}].referenceMaterialIds`);
    stringArray(unit.ambiguities, `state.units[${index}].ambiguities`);
    if (!Array.isArray(unit.attempts)) throw new Error(`state.units[${index}].attempts 必须是数组`);
    stringValue(unit.error, `state.units[${index}].error`, true);
    stringValue(unit.returnReason, `state.units[${index}].returnReason`, true);
    isoDate(unit.updatedAt, `state.units[${index}].updatedAt`);
    if (unit.placement !== null) {
      const placement = objectValue(unit.placement, `state.units[${index}].placement`);
      if (placement.requestedSize !== undefined) printSizeRequestSchema.parse(placement.requestedSize);
      if (placement.sizeOverride !== undefined && typeof placement.sizeOverride !== 'boolean') throw new Error('placement.sizeOverride 必须为布尔值');
      if (placement.requestedSizeIssue !== undefined) stringValue(placement.requestedSizeIssue, 'placement.requestedSizeIssue');
      if (placement.manual !== undefined) taskPlacementSchema.parse(placement.manual);
      if (!PLACEMENT_KEYS.includes(placement.key as never)) throw new Error(`state.units[${index}].placement.key 无效`);
      for (const field of ['widthCm', 'offsetX', 'offsetY', 'rotation'] as const) finiteNumber(placement[field], `state.units[${index}].placement.${field}`);
      if (placement.templateVersion === 'catalog-v1') {
        if (placement.sizePolicy !== undefined && placement.sizePolicy !== 'body-55-v1') throw new Error(`无效尺寸规则：${placement.sizePolicy}`);
        if (!['standard', 'widthCm', 'heightCm'].includes(placement.sizeMode as string)) throw new Error(`无效尺寸模式：${placement.sizeMode}`);
        if (placement.sizeMode === 'heightCm') finiteNumber(placement.heightCm, 'placement.heightCm', 0.01);
      }
      if (!['2208-v1', 'catalog-v1'].includes(placement.templateVersion as string)) throw new Error(`state.units[${index}].placement.templateVersion 无效`);
    }
    for (const value of [unit.artwork, unit.previousArtwork].filter(value => value != null)) {
      const artwork = objectValue(value, `state.units[${index}].artwork`);
      if (artwork.draft !== undefined) assertArtworkDraft(artwork.draft);
      if (artwork.textVerification !== undefined) productionTextVerificationSchema.parse(artwork.textVerification);
      stringValue(artwork.url, `state.units[${index}].artwork.url`);
      stringValue(artwork.name, `state.units[${index}].artwork.name`);
      stringValue(artwork.recipeFingerprint, `state.units[${index}].artwork.recipeFingerprint`);
      isoDate(artwork.createdAt, `state.units[${index}].artwork.createdAt`);
      const validation = objectValue(artwork.validation, `state.units[${index}].artwork.validation`);
      if (validation.contentBounds !== undefined) {
        const bounds = objectValue(validation.contentBounds, 'artwork.validation.contentBounds');
        for (const field of ['left', 'top', 'width', 'height'] as const) finiteNumber(bounds[field], `artwork.validation.contentBounds.${field}`, field === 'left' || field === 'top' ? 0 : 1);
        if (Number(bounds.left) + Number(bounds.width) > Number(validation.width) || Number(bounds.top) + Number(bounds.height) > Number(validation.height)) throw new Error(`图案有效范围超出图片：${JSON.stringify(bounds)}`);
      }
      if (typeof validation.valid !== 'boolean') throw new Error(`state.units[${index}].artwork.validation.valid 必须是布尔值`);
      stringValue(validation.sha256, `state.units[${index}].artwork.validation.sha256`);
      if (!Array.isArray(validation.issues)) throw new Error(`state.units[${index}].artwork.validation.issues 必须是数组`);
    }
    if (unitIds.has(unit.id as string)) throw new Error(`生产状态包含重复定制单元：${unit.id}`);
    if (!recordIds.has(unit.sourceRecordId as string)) throw new Error(`定制单元 ${unit.id} 引用了不存在的 WPS 记录`);
    unitIds.add(unit.id as string);
  });

  const versionIds = new Set<string>();
  state.mockupVersions.forEach((rawVersion, index) => {
    const version = objectValue(rawVersion, `state.mockupVersions[${index}]`);
    for (const field of ['id', 'sourceRecordId', 'garmentLabel', 'variantLabel', 'updatedAt'] as const) stringValue(version[field], `state.mockupVersions[${index}].${field}`);
    stringValue(version.productCode, `state.mockupVersions[${index}].productCode`, true);
    if (version.garment != null) garmentBindingSchema.parse(version.garment);
    if (!['waitingArtwork', 'readyToCompose', 'composing', 'pendingFinalConfirmation', 'approved', 'failed'].includes(version.status as string)) {
      throw new Error(`state.mockupVersions[${index}].status 无效`);
    }
    stringArray(version.unitIds, `state.mockupVersions[${index}].unitIds`);
    (version.unitIds as string[]).forEach((unitId) => {
      if (!unitIds.has(unitId)) throw new Error(`效果图版本 ${version.id} 引用了不存在的定制单元：${unitId}`);
    });
    if (version.output !== null) {
      const output = objectValue(version.output, `state.mockupVersions[${index}].output`);
      for (const field of ['url', 'name', 'sha256', 'composeFingerprint', 'createdAt'] as const) stringValue(output[field], `state.mockupVersions[${index}].output.${field}`);
      if (![WPS_COMPOSITOR_VERSION, 'sharp-catalog-compositor-v2', 'sharp-2208-compositor-v1'].includes(output.compositorVersion as string)) throw new Error(`state.mockupVersions[${index}].output.compositorVersion 无效`);
    }
    if (versionIds.has(version.id as string)) throw new Error(`生产状态包含重复效果图版本：${version.id}`);
    versionIds.add(version.id as string);
  });
}

async function readStateFile() {
  try {
    const source = await readFile(STATE_FILE, 'utf8');
    const parsed: unknown = JSON.parse(source);
    assertWpsProductionState(parsed);
    return parsed;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const state = emptyWpsProductionState();
    await mkdir(path.dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return state;
  }
}

async function writeStateFile(state: WpsProductionState) {
  assertWpsProductionState(state);
  const temporaryFile = `${STATE_FILE}.${randomUUID()}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporaryFile, STATE_FILE);
}

export async function readWpsProductionState() {
  await writeQueue;
  if (usesProductionCloud()) { const state = await readCloudProductionState(); assertWpsProductionState(state); return state; }
  return readStateFile();
}

export async function mutateWpsProductionState(
  expectedRevision: number,
  mutation: (state: WpsProductionState) => WpsProductionState | Promise<WpsProductionState>,
  assertUnchangedTarget?: (state: WpsProductionState) => void,
  receipt?: { id: string; hash: string },
) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error(`expectedRevision 必须是非负整数，实际值：${expectedRevision}`);
  }
  if (usesProductionCloud()) {
    for (let retry = 0; retry < 5; retry++) {
      if (receipt && await completedProductionSave(receipt)) return readCloudProductionState();
      const current = await readCloudProductionState();
      assertWpsProductionState(current);
      if (assertUnchangedTarget) assertUnchangedTarget(current);
      else if (current.revision !== expectedRevision) throw new ProductionRevisionConflictError(expectedRevision, current.revision);
      const next = await mutation(current);
      assertWpsProductionState(next);
      if (next.revision !== current.revision + 1) throw new Error('状态变更必须增加一个 revision');
      if (await commitCloudProductionState(current, next, receipt)) return next;
      if (!assertUnchangedTarget) throw new ProductionRevisionConflictError(expectedRevision, (await readCloudProductionState()).revision);
    }
    throw new Error('其他任务正在更新，请重试保存');
  }
  let resolveResult: (state: WpsProductionState) => void;
  let rejectResult: (error: unknown) => void;
  const result = new Promise<WpsProductionState>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  writeQueue = writeQueue.then(async () => {
    try {
      const current = await readStateFile();
      // Scoped artwork saves recheck their frozen task inside the same atomic write queue.
      if (assertUnchangedTarget) assertUnchangedTarget(current);
      else if (current.revision !== expectedRevision) throw new ProductionRevisionConflictError(expectedRevision, current.revision);
      const next = await mutation(current);
      if (next.revision !== current.revision + 1) {
        throw new Error(`状态变更必须将 revision 从 ${current.revision} 增加到 ${current.revision + 1}，实际为 ${next.revision}`);
      }
      await writeStateFile(next);
      resolveResult(next);
    } catch (error) {
      rejectResult(error);
    }
  });
  await result;
  return result;
}
