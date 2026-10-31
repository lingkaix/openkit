import type { ArtifactVersion, ArtifactVersionRecord } from '@openkit/protocol';

/** Closed S16 failures owned by the Artifact authority boundary. */
export type ArtifactAuthorityErrorCode =
  | 'invalid_request'
  | 'source_digest_mismatch'
  | 'recovery_required'
  | 'stale'
  | 'conflict'
  | 'thread_busy';

/** Structured failure raised by Artifact creation and introduction. */
export class ArtifactAuthorityError extends Error {
  /** Stable S16 error code. */
  public readonly code: ArtifactAuthorityErrorCode;
  /** Exact HTTP status assigned by S16. */
  public readonly status: 400 | 409;

  /**
   * Creates one Artifact authority failure.
   *
   * @param code Stable S16 error code.
   * @param message Product-safe diagnostic.
   */
  public constructor(code: ArtifactAuthorityErrorCode, message: string) {
    super(message);
    this.name = 'ArtifactAuthorityError';
    this.code = code;
    this.status = ['invalid_request', 'source_digest_mismatch'].includes(code) ? 400 : 409;
  }
}

/** Derives public metadata from the single retained snapshot and its producing facts. */
export function projectArtifactVersion(record: ArtifactVersionRecord): ArtifactVersion {
  const { artifact, version } = record;
  return {
    artifactId: artifact.id,
    workspaceId: artifact.workspaceId,
    artifactVersion: artifact.version,
    title: artifact.title,
    summary: artifact.summary,
    contentDigest: artifact.contentDigest,
    ...version,
    parentVersion: artifact.version === 1 ? null : artifact.version - 1,
    requestId: artifact.lastMutationRequestId,
    recordedAt: artifact.updatedAt,
  };
}
