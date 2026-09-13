import { createHash } from 'node:crypto';
import type { Issue, Requirement } from './contracts';
export function stable(value: unknown): string {
    if (value === undefined)
        return 'null';
    if (Array.isArray(value))
        return `[${value.map(stable).join(',')}]`;
    if (value !== null && typeof value === 'object')
        return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
    return JSON.stringify(value);
}
export const hashStable = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
export function problem(targetId: string, code: string, message: string, stage: Issue['stage'] = 'artwork', severity: Issue['severity'] = 'blocking'): Issue { return { id: `issue-${hashStable({ targetId, code, message }).slice(0, 20)}`, targetId, code, message, stage, severity, evidenceIds: [], resolution: null }; }
/** Audit IDs, timestamps and revision counters do not change pixels. Array order does. */
export function pixelMeaning(value: unknown): unknown {
    if (Array.isArray(value))
        return value.map(pixelMeaning);
    if (value !== null && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).filter(([key]) => !['evidenceIds', 'createdAt', 'createdBy', 'revision', 'issues', 'requiredChecks', 'label'].includes(key)).map(([k, v]) => [k, pixelMeaning(v)]));
    return value;
}
export function componentUses(r: Requirement, artworkId: string, componentId: string) { return r.materialUses.filter(u => u.role !== 'excluded' && u.artworkId === artworkId && (u.componentId === componentId || u.componentId === null)); }
