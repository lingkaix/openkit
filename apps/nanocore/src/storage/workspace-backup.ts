import type {
  WorkspaceBackupCoverage,
  WorkspaceBackupManifest,
  WorkspaceBackupVerificationInput,
} from './workspace-backup-bundle.js';

/** Closed refusal codes shared by the offline Workspace commands. */
export type WorkspaceRecoveryErrorCode =
  | 'not-implemented'
  | 'invalid-arguments'
  | 'root-locked'
  | 'source-unavailable'
  | 'source-not-stopped'
  | 'parent-backup-invalid'
  | 'deployment-mismatch'
  | 'workspace-unavailable'
  | 'release-mismatch'
  | 'unsupported-format'
  | 'unsafe-path'
  | 'invalid-bundle'
  | 'invalid-database'
  | 'incomplete-closure'
  | 'capacity-exceeded'
  | 'candidate-conflict'
  | 'request-conflict'
  | 'workspace-moved-out'
  | 'safety-unproved'
  | 'mapping-refused'
  | 'identity-collision'
  | 'recovery-required';

/** Operator-safe refusal; messages must not include secrets or packaged content. */
export class WorkspaceRecoveryError extends Error {
  /** Creates a refusal with a stable code and an English operator message. */
  constructor(
    readonly code: WorkspaceRecoveryErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'WorkspaceRecoveryError';
  }
}

/** The backup-directory branch requires verification by the implementation, not the caller. */
export type WorkspaceBackupSource =
  | { readonly kind: 'stopped-data-root'; readonly dataRoot: string }
  | { readonly kind: 'data-root-backup'; readonly backupRoot: string };

/** Retains the parent backup's actual guarantee, including crash-consistent hot capture. */
export type WorkspaceBackupSourceReport =
  | { readonly kind: 'stopped-data-root' }
  | {
      readonly kind: 'data-root-backup';
      readonly dataRootBackupId: string;
      readonly consistency: 'clean' | 'crash-consistent';
    };

/** Path-free capture facts; physical consistency never proves external effect completion. */
export interface WorkspaceBackupReport {
  readonly backupId: string;
  readonly workspaceId: string;
  readonly sourceDeploymentId: string;
  readonly knowledgeBaseIds: readonly string[];
  readonly capturedRevision: number;
  readonly manifestDigest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly coverage: WorkspaceBackupCoverage;
  /** Present on capture; a standalone bundle need not retain its parent-directory provenance. */
  readonly source?: WorkspaceBackupSourceReport;
  readonly interruptedTurnIds: readonly string[];
  readonly unknownEffectTurnIds: readonly string[];
}

/** Trusted release/capacity policy plus a new or exactly owned output and stable wsbak identity. */
export interface WorkspaceBackupCreateInput extends WorkspaceBackupVerificationInput {
  readonly source: WorkspaceBackupSource;
  readonly workspaceId: string;
  readonly expectedSourceDeploymentId: string;
  readonly backupId: string;
  readonly purpose: 'backup' | 'move';
}

/** MOVE preparation deliberately carries no transferable seal or moved-out authority. */
export type WorkspaceBackupCreateResult = Readonly<{
  bundleRoot: string;
  manifest: WorkspaceBackupManifest;
  report: WorkspaceBackupReport & { readonly source: WorkspaceBackupSourceReport };
}> &
  (
    | { readonly purpose: 'backup'; readonly disposition: 'sealed' }
    | { readonly purpose: 'move'; readonly disposition: 'prepared' }
  );

/** A request-owned, absent destination on the target filesystem; no registration is changed. */
export interface WorkspaceBackupStageInput extends WorkspaceBackupVerificationInput {
  readonly candidateRoot: string;
  readonly expectedWorkspaceId: string;
  readonly expectedSourceDeploymentId: string;
  readonly purpose: 'backup' | 'move';
}

/** Full graph verification of a private candidate, not target admission or safety approval. */
export interface WorkspaceBackupStageResult {
  readonly disposition: 'staged';
  readonly candidateRoot: string;
  readonly manifest: WorkspaceBackupManifest;
  readonly report: WorkspaceBackupReport;
}

/**
 * Captures one Workspace under the existing exclusive source-root lock.
 * All affected writers must be stopped; a verified backup directory stays read-only.
 * Opens existing authority only, takes SQLite backup-API snapshots, and verifies full closure.
 * Backup seals only after sync; MOVE preparation remains unsealed for the offline seal owner.
 * @param _input Source selector, exact identities, output, and trusted verification policy.
 * @returns Verified capture facts without runtime authority or external-effect completion claims.
 * @throws WorkspaceRecoveryError; this seam currently always refuses with not-implemented.
 */
export async function createWorkspaceBackup(
  _input: WorkspaceBackupCreateInput
): Promise<WorkspaceBackupCreateResult> {
  throw new WorkspaceRecoveryError('not-implemented', 'createWorkspaceBackup is not implemented.');
}

/**
 * Verifies sealed input and copies it into a caller-owned private candidate.
 * The offline decision owner holds the target root lock and candidate/capacity ownership.
 * Existing-only database opens must close before return; no boot, migration, or recovery runs.
 * The existing bundle verifier supplies private bytes; its callback-scoped reader cannot escape.
 * @param _input Sealed input, expected identities, candidate, and trusted verification policy.
 * @returns Complete staged bytes; registration, current safety and rebinding remain separate.
 * @throws WorkspaceRecoveryError; this seam currently always refuses with not-implemented.
 */
export async function stageWorkspaceBackup(
  _input: WorkspaceBackupStageInput
): Promise<WorkspaceBackupStageResult> {
  throw new WorkspaceRecoveryError('not-implemented', 'stageWorkspaceBackup is not implemented.');
}
