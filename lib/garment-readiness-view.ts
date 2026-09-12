export type GarmentReadinessView = { unitId: string; label: string; garmentIssue: string; calibrationUrl: string };

export function normalizeGarmentChecks(value: unknown): GarmentReadinessView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const checks = Array.isArray(row.garmentChecks) && row.garmentChecks.length ? row.garmentChecks : [row];
    return checks.flatMap((check): GarmentReadinessView[] => {
      if (!check || typeof check !== 'object') return [];
      const item = check as Record<string, unknown>;
      const issue = typeof item.garmentIssue === 'string' ? item.garmentIssue : '';
      return issue ? [{ unitId: String(item.unitId ?? row.unitId ?? ''), label: typeof item.label === 'string' ? item.label : '', garmentIssue: issue, calibrationUrl: typeof item.calibrationUrl === 'string' && item.calibrationUrl ? item.calibrationUrl : '/products' }] : [];
    });
  });
}
