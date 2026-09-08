import { productByCode } from '@/lib/products';
import { garmentBindingSchema } from '@/lib/production-garment';
import { placementPreviewSchema } from '@/lib/catalog-placement-suggestions';
import { PLACEMENT_KEYS, type DemoState, type LogoPlacement } from '@/lib/types';

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} 必须是非空字符串，实际值：${String(value)}`);
  }
}

function assertIsoDate(value: unknown, field: string, nullable = false) {
  if (nullable && value === null) return;
  assertString(value, field);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} 不是有效时间：${value}`);
  }
}

function assertFiniteNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} 必须是有限数字，实际值：${String(value)}`);
  }
}

function assertPlacement(value: unknown, field: string): asserts value is LogoPlacement {
  if (!value || typeof value !== 'object') {
    throw new Error(`${field} 必须是对象`);
  }
  const placement = value as Record<string, unknown>;
  if (placement.catalogPosition !== undefined && placement.catalogPosition !== 'upperBack' && placement.catalogPosition !== 'backCenter') throw new Error(`${field} 包含未知后背位置`);
  assertString(placement.logoUrl, `${field}.logoUrl`);
  assertString(placement.logoName, `${field}.logoName`);
  const { widthCm, offsetX, offsetY, rotation } = placement;
  assertFiniteNumber(widthCm, `${field}.widthCm`);
  assertFiniteNumber(offsetX, `${field}.offsetX`);
  assertFiniteNumber(offsetY, `${field}.offsetY`);
  assertFiniteNumber(rotation, `${field}.rotation`);
  if (widthCm < 0.5 || widthCm > 100) {
    throw new Error(`${field}.widthCm 超出 0.5-100cm：${widthCm}`);
  }
  if (Math.abs(offsetX) > 50 || Math.abs(offsetY) > 50) {
    throw new Error(`${field} 的位置偏移超出 -50 到 50`);
  }
  if (Math.abs(rotation) > 180) {
    throw new Error(`${field}.rotation 超出 -180 到 180：${rotation}`);
  }
}

export function assertDemoState(value: unknown): asserts value is DemoState {
  if (!value || typeof value !== 'object') throw new Error('Demo 状态必须是对象');
  const state = value as Record<string, unknown>;
  if (state.version !== 1) throw new Error(`Demo 状态版本必须是 1，实际值：${String(state.version)}`);
  if (!Array.isArray(state.tasks)) throw new Error('Demo 状态 tasks 必须是数组');
  assertIsoDate(state.updatedAt, 'updatedAt');
  const ids = new Set<string>();
  state.tasks.forEach((rawTask, index) => {
    if (!rawTask || typeof rawTask !== 'object') throw new Error(`tasks[${index}] 必须是对象`);
    const task = rawTask as Record<string, unknown>;
    assertString(task.id, `tasks[${index}].id`);
    if (ids.has(task.id)) throw new Error(`任务 ID 重复：${task.id}`);
    ids.add(task.id);
    assertString(task.productCode, `tasks[${index}].productCode`);
    if (task.garment !== undefined) {
      const garment = garmentBindingSchema.parse(task.garment);
      if (task.placementDefaults !== undefined && placementPreviewSchema.parse(task.placementDefaults).assetVersionId !== garment.assetVersionId) throw new Error('默认位置与底图版本不一致');
      if (garment.styleCode !== task.productCode) throw new Error('任务款号与素材库底图不一致');
    } else if (!productByCode(task.productCode)) throw new Error(`任务引用了不存在的商品：${task.productCode}`);
    assertIsoDate(task.createdAt, `tasks[${index}].createdAt`);
    assertIsoDate(task.updatedAt, `tasks[${index}].updatedAt`);
    assertIsoDate(task.exportedAt, `tasks[${index}].exportedAt`, true);
    if (!task.placements || typeof task.placements !== 'object' || Array.isArray(task.placements)) {
      throw new Error(`tasks[${index}].placements 必须是对象`);
    }
    for (const [key, placement] of Object.entries(task.placements)) {
      if (!PLACEMENT_KEYS.includes(key as (typeof PLACEMENT_KEYS)[number])) {
        throw new Error(`tasks[${index}] 包含未知位置：${key}`);
      }
      assertPlacement(placement, `tasks[${index}].placements.${key}`);
    }
  });
}
