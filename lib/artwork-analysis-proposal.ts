import type { ProductionPlanPatch } from './wps-production';
export type ArtworkAnalysisProposal = { id: string; recordId: string; createdAt: string; logicVersion: string; sourceEvidence: string;
  status: 'pending' | 'applied'; appliedAt?: string;
  changes: Array<{ unitId: string; label: string; snapshot: string; patch: ProductionPlanPatch;
    differences: Array<{ field: string; before: unknown; after: unknown }> }>;
  unmatched: string[]; warnings: string[];
};

/** Client views do not need private source snapshots or execution payloads. */
export type PublicAnalysisProposal = Omit<ArtworkAnalysisProposal, 'changes'> & {
  changes: Array<Omit<ArtworkAnalysisProposal['changes'][number], 'snapshot' | 'patch'>>;
};
export function publicAnalysisProposal(proposal: ArtworkAnalysisProposal): PublicAnalysisProposal {
  return { ...proposal, changes: proposal.changes.map(change => ({ unitId: change.unitId, label: change.label, differences: change.differences })) };
}
