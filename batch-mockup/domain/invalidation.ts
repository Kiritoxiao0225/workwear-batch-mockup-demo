import type { Requirement } from './contracts';
import { hashStable, pixelMeaning } from './helpers';
export function diffRequirements(previous: Requirement, next: Requirement) {
    const artworkIds = new Set<string>(), componentIds = new Set<string>(), applicationIds = new Set<string>(), reasons: Array<{
        targetId: string;
        reason: string;
    }> = [];
    const add = (set: Set<string>, targetId: string, reason: string) => { set.add(targetId); if (!reasons.some(r => r.targetId === targetId && r.reason === reason))
        reasons.push({ targetId, reason }); };
    const changed = (a: unknown, b: unknown) => hashStable(pixelMeaning(a)) !== hashStable(pixelMeaning(b));
    const arts = new Set([...previous.artworks, ...next.artworks].map(a => a.id));
    for (const id of arts) {
        const before = previous.artworks.find(a => a.id === id), after = next.artworks.find(a => a.id === id);
        const components = new Set([...(before?.components ?? []), ...(after?.components ?? [])].map(c => c.id));
        for (const cid of components)
            if (changed(before?.components.find(c => c.id === cid), after?.components.find(c => c.id === cid))) {
                add(componentIds, cid, '组件内容、字体、颜色或排版改变');
                add(artworkIds, id, '依赖组件改变');
            }
        const artConfig = (a: typeof before) => a ? { background: a.background, layout: a.layout, enhancement: a.enhancement, printSize: a.printSize, changes: a.changes } : null;
        if (changed(artConfig(before), artConfig(after)))
            add(artworkIds, id, '图稿合成或处理规则改变');
        for (const cid of components) {
            const changes = (a: typeof before) => a?.changes.filter(ch => ch.componentId === cid && ch.action.kind !== 'add-component') ?? [];
            if (changed(changes(before), changes(after)))
                add(componentIds, cid, '组件授权修改改变');
        }
    }
    for (const uid of new Set([...previous.materialUses, ...next.materialUses].map(u => u.id))) {
        const a = previous.materialUses.find(u => u.id === uid), b = next.materialUses.find(u => u.id === uid);
        const unpinnedSourceChange = previous.sourceContentHash !== next.sourceContentHash && [a, b].some(u => u && u.role !== 'excluded' && !u.sourceArtifactSha256);
        if (changed(a, b) || unpinnedSourceChange)
            for (const u of [a, b])
                if (u && u.role !== 'excluded' && u.artworkId) {
                    add(artworkIds, u.artworkId, unpinnedSourceChange ? '未固定素材 SHA，来源变化需保守重核' : '素材内容、角色、选区或说明改变');
                    if (u.componentId)
                        add(componentIds, u.componentId, '依赖素材改变');
                    else
                        for (const r of [previous, next])
                            for (const c of r.artworks.find(a => a.id === u.artworkId)?.components ?? [])
                                add(componentIds, c.id, '图稿级参考改变');
                }
    }
    // Evidence text can tighten a permitted edit even when all binding IDs stay the same.
    for (const eid of new Set([...previous.evidence, ...next.evidence].map(e => e.id))) {
        const a = previous.evidence.find(e => e.id === eid), b = next.evidence.find(e => e.id === eid);
        if (a && b && changed({ statement: a.statement, certainty: a.certainty }, { statement: b.statement, certainty: b.certainty })) {
            for (const r of [previous, next])
                for (const art of r.artworks) {
                    const mentions = (v: unknown): boolean => Array.isArray(v) ? v.some(mentions) : !!v && typeof v === 'object' ? Object.entries(v).some(([k, x]) => k === 'evidenceIds' && Array.isArray(x) ? x.includes(eid) : mentions(x)) : false;
                    if (mentions(art) || r.materialUses.some(u => u.artworkId === art.id && u.evidenceIds.includes(eid)))
                        add(artworkIds, art.id, '已引用证据的含义改变');
                    for (const c of art.components)
                        if (mentions(c))
                            add(componentIds, c.id, '组件依据改变');
                }
        }
    }
    for (const id of new Set([...previous.applications, ...next.applications].map(a => a.id))) {
        const a = previous.applications.find(a => a.id === id), b = next.applications.find(a => a.id === id);
        if (changed(a, b))
            add(applicationIds, id, '位置、尺寸、底图或图稿版本引用改变');
        if ([a, b].some(x => x && artworkIds.has(x.artworkId)))
            add(applicationIds, id, '引用图稿需要更新');
        const ga = previous.garments.find(g => g.id === a?.garmentId), gb = next.garments.find(g => g.id === b?.garmentId);
        if (changed(ga, gb))
            add(applicationIds, id, '衣服款色或变体改变');
    }
    return { artworkIds: [...artworkIds].sort(), componentIds: [...componentIds].sort(), applicationIds: [...applicationIds].sort(), reasons: reasons.sort((a, b) => a.targetId.localeCompare(b.targetId) || a.reason.localeCompare(b.reason)) };
}
