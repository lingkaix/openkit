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
