/** Design contracts. Runtime validation belongs at every adapter / command boundary. */
export type Id = string;
export type Sha256 = string;
export type IsoDate = string;
export interface Scope {
    workspaceId: Id;
}
export interface Entity extends Scope {
    id: Id;
}
export interface Versioned extends Entity {
    revision: number;
}
export interface Region {
    x: number;
    y: number;
    width: number;
    height: number;
} // 0..1 in original pixels
export type Selection = {
    kind: 'whole';
} | {
    kind: 'region';
    region: Region;
} | {
    kind: 'unknown';
    reason: string;
};
export interface SourceMaterial {
    id: Id;
    sourceAttachmentId: string;
    label: string;
    artifactId: Id | null;
    sha256: Sha256 | null;
    load: 'ready' | 'missing' | 'failed';
    error: string | null;
}
export interface SourceSnapshot extends Entity {
    source: {
        kind: 'wps';
        fileId: string;
        sheetId: string;
        recordId: string;
    } | {
        kind: 'local';
        key: string;
    };
    contentHash: Sha256;
    requirementText: string;
    materials: SourceMaterial[];
    sourceStatus: string;
    editable: boolean;
    capturedAt: IsoDate;
}
export type EvidenceOrigin = {
    kind: 'source-text';
    sourceSnapshotId: Id;
    start: number;
    end: number;
} | {
    kind: 'user-amendment';
    amendmentId: Id;
    actorId: Id;
    at: IsoDate;
} | {
    kind: 'visual';
    materialId: Id;
    selection: Selection;
    observationId: Id;
} | {
    kind: 'default';
    policy: string;
    version: string;
};
export interface Evidence {
    id: Id;
    origin: EvidenceOrigin;
    statement: string;
    certainty: 'explicit' | 'observed' | 'inferred' | 'unknown';
    supersedes: Id[];
}
export interface Issue {
    id: Id;
    targetId: Id;
    stage: 'interpret' | 'artwork' | 'mockup';
    severity: 'blocking' | 'advisory';
    code: string;
    message: string;
    evidenceIds: Id[];
    resolution: {
        actorId: Id;
        explanation: string;
        at: IsoDate;
    } | null;
}
export type MaterialRole = 'content' | 'font' | 'color' | 'layout' | 'annotation' | 'excluded';
export interface MaterialUse {
    id: Id;
    materialId: Id;
    /** Pinned bytes for precise material invalidation. Older drafts conservatively use sourceContentHash. */
    sourceArtifactSha256?: Sha256;
    artworkId: Id | null;
    componentId: Id | null;
    role: MaterialRole;
    selection: Selection;
    instruction: string;
    evidenceIds: Id[];
}
export type TextContent = {
    kind: 'exact';
    value: string;
    evidenceIds: Id[];
} | {
    kind: 'preserve-source';
    useId: Id;
    readableTranscription: string | null;
    evidenceIds: Id[];
};
export type ColorSpec = {
    kind: 'preserve';
    useId: Id;
} | {
    kind: 'solid';
    rgba: [
        number,
        number,
        number,
        number
    ];
    evidenceIds: Id[];
} | {
    kind: 'reference';
    useId: Id;
} | {
    kind: 'garment-contrast';
    policyVersion: string;
} | {
    kind: 'unknown';
    issueId: Id;
};
export interface FontSpec {
    referenceUseIds: Id[];
    primaryFontAssetId: Id | null;
    fallbackFontAssetIds: Id[];
    strategy: 'preserve-source' | 'available-font' | 'reference-glyphs';
    fallbackPolicy: 'report-substitution' | 'require-match';
    evidenceIds: Id[];
}
export interface TextComponent {
    id: Id;
    kind: 'text';
    content: TextContent;
    font: FontSpec;
    color: ColorSpec;
    layout: {
        kind: 'lines';
        align: 'left' | 'center' | 'right';
    } | {
        kind: 'arc';
        direction: 'up' | 'down';
        degrees: number | null;
    };
}
export interface GraphicComponent {
    id: Id;
    kind: 'graphic';
    contentUseIds: Id[];
    mode: 'preserve' | 'edit' | 'reconstruct' | 'create';
    description: string;
    color: ColorSpec;
}
export type ComponentSpec = TextComponent | GraphicComponent;
export type ChangeAction = {
    kind: 'remove';
    targetDescription: string;
} | {
    kind: 'replace-text';
    oldText: string | null;
    replacementComponentId: Id;
} | {
    kind: 'add-component';
    addedComponentId: Id;
} | {
    kind: 'recolor';
    color: ColorSpec;
} | {
    kind: 'simplify';
    removableFeatures: string[];
} | {
    kind: 'reconstruct';
    targetDescription: string;
};
export interface AuthorizedChange {
    id: Id;
    componentId: Id;
    action: ChangeAction;
    sourceUseId: Id | null;
    selection: Selection;
    evidenceIds: Id[];
    preserve: string[];
}
export interface BackgroundSpec {
    exterior: 'transparent' | 'preserve' | 'unknown';
    preserveRegions: {
        useId: Id;
        region: Region;
        description: string;
    }[];
    removeRegions: {
        useId: Id;
        region: Region;
        evidenceIds: Id[];
    }[];
    preserveDescription: string;
    evidenceIds: Id[];
}
export interface ArtworkLayout {
    kind: 'preserve' | 'stack' | 'row' | 'positioned';
    componentOrder: Id[];
    referenceUseIds: Id[];
    placements: {
        componentId: Id;
        bounds: Region;
        rotation: number;
    }[];
    gapRatio: number | null;
    evidenceIds: Id[];
}
export interface ArtworkSpec {
    id: Id;
    label: string;
    components: ComponentSpec[];
    changes: AuthorizedChange[];
    background: BackgroundSpec;
    layout: ArtworkLayout;
    enhancement: 'if-needed' | 'disabled';
    printSize: PrintSize | null;
    requiredChecks: CheckSpec[];
}
export interface PrintSize {
    widthCm: number | null;
    heightCm: number | null;
    basis: 'explicit' | 'same-sentence-unit' | 'default' | 'manual';
    evidenceIds: Id[];
}
export interface GarmentSpec {
    id: Id;
    label: string;
    styleCode: string;
    requestedColor: string;
    variantId: Id | null;
    evidenceIds: Id[];
}
export interface PlacementSpec {
    face: 'front' | 'back' | 'left-sleeve' | 'right-sleeve';
    label: string;
    size: PrintSize | null;
    center: {
        x: number;
        y: number;
    } | null;
    rotation: number;
    standardId: Id | null;
    baseAssetId: Id | null;
    baseAssetSha256: Sha256 | null;
    bodyWidthCm: number | null;
    bodyScaleEvidenceIds: Id[];
}
export interface ArtworkApplication {
    id: Id;
    artworkId: Id;
    artworkVersionId: Id | null;
    garmentId: Id;
    outputVariant: string;
    placement: PlacementSpec;
}
export interface Requirement extends Versioned {
    schemaVersion: 'batch-mockup/1';
    sourceSnapshotId: Id;
    sourceContentHash: Sha256;
    evidence: Evidence[];
    materialUses: MaterialUse[];
    artworks: ArtworkSpec[];
    garments: GarmentSpec[];
    applications: ArtworkApplication[];
    issues: Issue[];
    createdAt: IsoDate;
    createdBy: Id;
}
export type CheckCategory = 'text' | 'graphic' | 'font' | 'color' | 'layout' | 'background' | 'file' | 'placement';
export interface CheckSpec {
    id: Id;
    category: CheckCategory;
    targetId: Id;
    expected: string;
    referenceUseIds: Id[];
    evidenceIds: Id[];
}
export type StepKind = 'inspect-source' | 'select' | 'enhance' | 'generate' | 'edit' | 'cutout' | 'render-text' | 'compose-artwork' | 'review' | 'compose-mockup';
export type StepInput = {
    kind: 'material-use';
    useId: Id;
} | {
    kind: 'step-output';
    stepId: Id;
    output: string;
} | {
    kind: 'artifact';
    artifactId: Id;
    sha256: Sha256;
};
export interface PlannedStep {
    id: Id;
    kind: StepKind;
    componentIds: Id[];
    dependsOn: Id[];
    inputs: StepInput[];
    instruction: string;
    authorizedChangeIds: Id[];
    checkIds: Id[];
    execution: 'local' | 'provider';
    reason: string;
    condition: 'always' | 'resolution-insufficient' | 'background-remains';
}
export interface ProductionPlan extends Entity {
    requirementId: Id;
    requirementRevision: number;
    requirementHash: Sha256;
    artworkId: Id;
    artworkHash: Sha256;
    plannerVersion: string;
    steps: PlannedStep[];
    skipped: {
        kind: StepKind;
        componentIds: Id[];
        reason: string;
    }[];
    outputStepId: Id;
    checks: CheckSpec[];
}
export type StepStatus = 'pending' | 'running' | 'waiting_external' | 'completed' | 'skipped' | 'failed';
export type RunStatus = 'queued' | 'running' | 'waiting_external' | 'needs_input' | 'completed' | 'failed' | 'superseded' | 'cancelled';
export type RecoveryAction = 'query' | 'resume-download' | 'resume-step' | 'retry-attachment' | 'amend-requirement' | 'cancel-queued';
export interface Failure {
    stageId: Id;
    kind: 'input' | 'configuration' | 'provider-rejected' | 'submission-unknown' | 'download' | 'integrity' | 'persistence' | 'conflict';
    message: string;
    artifactIds: Id[];
    attemptId: Id | null;
    recovery: RecoveryAction[];
}
export interface Attempt extends Versioned {
    stepRunId: Id;
    operationKey: string;
    inputHash: Sha256;
    provider: string;
    model: string | null;
    status: 'prepared' | 'submitting' | 'accepted' | 'unknown' | 'rejected' | 'downloading' | 'completed';
    providerRequestId: string | null;
    providerTaskId: string | null;
    receiptArtifactId: Id | null;
    submittedAt: IsoDate | null;
    completedAt: IsoDate | null;
    outputArtifactIds: Id[];
}
export interface StepRun extends Versioned {
    runId: Id;
    plannedStepId: Id;
    status: StepStatus;
    inputHash: Sha256;
    executorVersion: string;
    attemptIds: Id[];
    outputArtifactIds: Id[];
    startedAt: IsoDate | null;
    completedAt: IsoDate | null;
    reusedFromStepRunId: Id | null;
    failure: Failure | null;
}
export interface ProductionRun extends Versioned {
    operationId: Id;
    planId: Id;
    planHash: Sha256;
    status: RunStatus;
    stepRunIds: Id[];
    lease: {
        owner: Id;
        fence: number;
        expiresAt: IsoDate;
    } | null;
    createdAt: IsoDate;
    createdBy: Id;
    outputArtworkVersionId: Id | null;
    failure: Failure | null;
}
export interface Artifact extends Entity {
    sha256: Sha256;
    bytes: number;
    mimeType: string;
    fileIdentity: {
        provider: 'r2' | 'oss' | 'local';
        key: string;
    };
    pixels: {
        width: number;
        height: number;
        transparentPixels: number;
        partialAlphaPixels: number;
    } | null;
    kind: 'source' | 'crop' | 'candidate' | 'mask' | 'artwork' | 'mockup' | 'receipt';
    origin: {
        sourceSnapshotId: Id | null;
        stepRunId: Id | null;
        parentArtifactIds: Id[];
    };
    createdAt: IsoDate;
}
export interface ReviewItem {
    checkId: Id;
    status: 'passed' | 'difference' | 'uncertain' | 'unavailable';
    actual: string;
    evidenceArtifactIds: Id[];
    explanation: string;
}
export interface Review extends Entity {
    requirementHash: Sha256;
    artworkVersionId: Id;
    artifactSha256: Sha256;
    items: ReviewItem[];
    reviewer: {
        kind: 'local';
        version: string;
    } | {
        kind: 'model';
        provider: string;
        model: string;
        version: string;
    };
    createdAt: IsoDate;
}
export interface ManualDecision {
    actorId: Id;
    at: IsoDate;
    artifactSha256: Sha256;
    acceptedDifferenceCheckIds: Id[];
    explanation: string;
}
export interface ArtworkVersion extends Entity {
    artworkId: Id;
    number: number;
    parentVersionId: Id | null;
    requirementHash: Sha256;
    artifactId: Id;
    layers: {
        componentId: Id;
        artifactId: Id;
        bounds: Region;
        rotation: number;
        visible: boolean;
        text: TextComponent | null;
    }[];
    reviewIds: Id[];
    complete: boolean;
    confirmed: ManualDecision | null;
    createdAt: IsoDate;
}
export interface MockupVersion extends Entity {
    garmentId: Id;
    inputs: {
        applicationId: Id;
        artworkVersionId: Id;
        artworkSha256: Sha256;
        placement: PlacementSpec;
    }[];
    artifactId: Id;
    compositorVersion: string;
    placementReviewIds: Id[];
    confirmed: ManualDecision | null;
    createdAt: IsoDate;
}
export interface CommandContext extends Scope {
    actorId: Id;
    operationId: Id;
    expectedRevision: number;
}
export type CommandResult<T> = {
    kind: 'applied' | 'existing';
    receiptId: Id;
    revision: number;
    value: T;
} | {
    kind: 'conflict';
    currentRevision: number;
    message: string;
} | {
    kind: 'blocked';
    issues: Issue[];
};
