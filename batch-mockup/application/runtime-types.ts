import type { ProductionPlan, Requirement, SourceSnapshot } from '../domain/contracts';
export interface LocalOrder {
    id: string;
    title: string;
    source: SourceSnapshot;
    requirement: Requirement;
    garmentArtifactId: string;
    garmentLabel: string;
    note: string;
}
export interface StoredImage {
    id: string;
    sha256: string;
    bytes: number;
    width: number;
    height: number;
    name: string;
    kind: 'source' | 'candidate' | 'artwork' | 'mockup';
}
export interface OutputImage {
    artifactId: string;
    componentId: string | null;
}
export interface StepOutput {
    images: OutputImage[];
    note: string;
    text?: string;
    checks?: Array<{
        category: string;
        expected: string;
        status: 'passed' | 'uncertain';
        actual: string;
    }>;
}
export interface StoredStep {
    id: string;
    runId: string;
    kind: string;
    status: 'running' | 'completed' | 'failed';
    inputHash: string;
    output: StepOutput | null;
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
    executions: number;
}
export interface StoredRun {
    id: string;
    orderId: string;
    artworkId: string;
    operationId: string;
    plan: ProductionPlan;
    requirement: Requirement;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'unknown';
    fence: number;
    workerId: string | null;
    leaseUntil: string | null;
    createdAt: string;
    updatedAt: string;
    error: string | null;
    artworkArtifactId: string | null;
    mockupArtifactId: string | null;
    failAt: string | null;
    faultConsumed: boolean;
}
export interface LocalState {
    mode: 'offline';
    orders: LocalOrder[];
    runs: Array<StoredRun & {
        steps: StoredStep[];
    }>;
    images: StoredImage[];
}
