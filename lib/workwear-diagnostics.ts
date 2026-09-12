import type { PublicAnalysisProposal } from './artwork-analysis-proposal';
import type { RecoveryAction } from './artwork-reliability';
export type DiagnosticUnit = {
  id: string; garmentLabel: string; placement: string; state: string; analysisCurrent: boolean;
  artwork: { url: string | null; sha256: string; confirmed: boolean } | null;
  calibrationUrl?: string; temporaryPlacement?: boolean;
  blockers: string[]; garmentIssue: string | null; inputs: Array<{ sourceLabel: string; roles: string[] }>;
  job: { id: string; status: string; message: string; error: string | null; failedCutoutKey?: string;
    recovery: { action: RecoveryAction; label: string; mayCharge: boolean; reason: string };
    steps: Array<{ label: string; status: string; error: string | null }> } | null;
};
export type DiagnosticOrder = {
  id: string; customer: string; status: string; requirement: string; needsAnalysis: boolean;
  units: DiagnosticUnit[];
  versions: Array<{ id: string; label: string; url: string | null; current: boolean; confirmed: boolean; error: string | null; readyPositions: number; totalPositions: number }>;
  pendingProposal: PublicAnalysisProposal | null;
};
export type WorkwearDiagnostics = {
  generatedAt: string; sourceFreshness: 'stored-snapshot'; stateUpdatedAt: string;
  web: { logicVersion: string; commit: string | null };
  worker: { online: boolean; lastObservedExecutionBuild: { logicVersion: string; commit: string | null; observedAt: string } | null };
  counts: { allStoredOrders: number; activeOrders: number; displayedOrders: number; activeUnits: number };
  orders: DiagnosticOrder[]; warnings: string[];
};
