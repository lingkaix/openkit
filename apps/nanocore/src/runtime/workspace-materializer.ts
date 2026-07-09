import { createHash } from 'node:crypto';
import {
  type StagedWorkspaceReview,
  StagedWorkspaceReviewSchema,
  type WorkspaceChangedPath,
  type WorkspaceChangeSet,
  WorkspaceChangeSetSchema,
  type WorkspaceInputSnapshot,
  WorkspaceInputSnapshotSchema,
  type WorkspaceMaterializationRecord,
  WorkspaceMaterializationRecordSchema,
  type WorkspaceSynchronizationBackendKind,
} from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';

/** Options for building workspace input snapshots from one package. */
export interface BuildWorkspaceInputSnapshotsInput {
  /** Backend kind selected for the worker session. */
  backendKind: WorkspaceSynchronizationBackendKind;
  /** Backend capabilities that influenced workspace materialization. */
  backendCapabilities: readonly string[];
  /** ISO timestamp used for deterministic records. */
  createdAt: string;
  /** Agent Environment Package that declares worker-visible workspace inputs. */
  environmentPackage: AgentEnvironmentPackage;
}

/** Product-safe backend materialization summary used to create durable records. */
export interface BuildWorkspaceMaterializationRecordsMaterialization {
  /** Backend kind selected for materialization. */
  backendKind: WorkspaceSynchronizationBackendKind;
  /** Package snapshot id materialized by the backend. */
  packageSnapshotId: string;
  /** Product-safe workspace input summaries returned by the backend. */
  workspaceInputs: readonly {
    /** Workspace input id. */
    id: string;
    /** Worker-visible target path or redacted target summary. */
    target: string;
  }[];
  /** Required backend capabilities checked before launch. */
  requiredCapabilities: readonly string[];
  /** Optional backend health summary. */
  backendStatus?: { readonly health: string; readonly version: string | null } | undefined;
  /** Optional sandbox summary. */
  sandbox?: { readonly name: string; readonly state: string } | undefined;
}

/** Options for building materialization records from backend output. */
export interface BuildWorkspaceMaterializationRecordsInput {
  /** ISO timestamp used for deterministic records. */
  createdAt: string;
  /** Input snapshots created before backend materialization. */
  inputSnapshots: readonly WorkspaceInputSnapshot[];
  /** Product-safe backend materialization summary. */
  materialization: BuildWorkspaceMaterializationRecordsMaterialization;
}

/** Options for parsing one worker-produced workspace change manifest. */
export interface ParseWorkspaceChangeSetManifestOptions {
  /** Optional relative path prefixes that the change set must stay within. */
  allowedPathPrefixes?: readonly string[] | undefined;
}

/** Options for staging one workspace change set for review. */
export interface StageWorkspaceChangeSetOptions {
  /** ISO timestamp used for created and updated fields. */
  createdAt: string;
  /** Stable staged workspace review id. */
  reviewId: string;
  /** Product-safe reference to the staged diff. */
  stagingRef: string;
}

const BINARY_ARTIFACT_ONLY_THRESHOLD_BYTES = 1024 * 1024;

/**
 * Builds product-safe workspace input snapshot records from an Agent Environment Package.
 *
 * @param input Package, backend, and timestamp context.
 * @returns Workspace input snapshots owned by NanoCore.
 */
export function buildWorkspaceInputSnapshots(
  input: BuildWorkspaceInputSnapshotsInput
): WorkspaceInputSnapshot[] {
  return input.environmentPackage.workspace.inputs.map((workspaceInput) => {
    const sourceId =
      typeof workspaceInput.source.sourceId === 'string' ? workspaceInput.source.sourceId : null;

    return WorkspaceInputSnapshotSchema.parse({
      id: `wis_${input.environmentPackage.snapshotId}_${workspaceInput.id}`,
      workspaceId: input.environmentPackage.scope.workspaceId,
      resourceId: workspaceInput.id,
      ...(sourceId ? { sourceId } : {}),
      resourceKind: workspaceInput.kind === 'repository' ? 'git_repository' : 'git_repository',
      strategy: workspaceInput.kind === 'snapshot' ? 'filesystem' : 'git',
      pathScope: [workspaceInput.id],
      writableRoots: workspaceInput.access === 'read-write' ? [workspaceInput.id] : [],
      ignoredPaths: [],
      generatedFiles: input.environmentPackage.workspace.generatedFiles.map((file) => ({
        id: file.id,
        target: toRelativeWorkspacePath(file.target),
      })),
      base: {
        commit:
          typeof workspaceInput.source.commit === 'string' ? workspaceInput.source.commit : null,
        contentDigest:
          typeof workspaceInput.materialization?.contentDigest === 'string'
            ? workspaceInput.materialization.contentDigest
            : null,
      },
      backend: {
        capabilitySummary: [...input.backendCapabilities],
        kind: input.backendKind,
        label: `${input.backendKind} worker backend`,
      },
      createdAt: input.createdAt,
    });
  });
}

/**
 * Builds durable product materialization records from backend materialization output.
 *
 * @param input Backend materialization summary and its input snapshots.
 * @returns Workspace materialization records owned by NanoCore.
 */
export function buildWorkspaceMaterializationRecords(
  input: BuildWorkspaceMaterializationRecordsInput
): WorkspaceMaterializationRecord[] {
  const targetsByInputId = new Map(
    input.materialization.workspaceInputs.map((workspaceInput) => [
      workspaceInput.id,
      workspaceInput.target,
    ])
  );
  const policyDigest = digestPolicy({
    backendKind: input.materialization.backendKind,
    packageSnapshotId: input.materialization.packageSnapshotId,
    requiredCapabilities: input.materialization.requiredCapabilities,
  });

  return input.inputSnapshots.map((snapshot) =>
    WorkspaceMaterializationRecordSchema.parse({
      backendKind: input.materialization.backendKind,
      base: snapshot.base,
      createdAt: input.createdAt,
      id: `wmr_${input.materialization.packageSnapshotId}_${snapshot.resourceId}`,
      inputSnapshotId: snapshot.id,
      ...(snapshot.sourceId ? { sourceId: snapshot.sourceId } : {}),
      materializedRootRef:
        targetsByInputId.get(snapshot.resourceId) ??
        `workspace://${snapshot.workspaceId}/${snapshot.resourceId}`,
      policyDigest,
      readinessEvidence: materializationReadinessEvidence(input.materialization),
      strategy: snapshot.strategy,
      workerSessionId:
        input.materialization.sandbox?.name ?? input.materialization.packageSnapshotId,
      workspaceId: snapshot.workspaceId,
    })
  );
}

/**
 * Parses and validates a worker-produced workspace change-set manifest.
 *
 * @param manifestText Serialized JSON manifest.
 * @param options Optional path-scope validation.
 * @returns Parsed workspace change set.
 * @throws Error when the manifest is invalid or escapes the declared scope.
 */
export function parseWorkspaceChangeSetManifest(
  manifestText: string,
  options: ParseWorkspaceChangeSetManifestOptions = {}
): WorkspaceChangeSet {
  const parsed = WorkspaceChangeSetSchema.parse(JSON.parse(manifestText) as unknown);
  const changeSet = withBinaryReviewPresentations(parsed);
  const allowedPathPrefixes = options.allowedPathPrefixes?.map(normalizeAllowedPrefix) ?? [];

  if (allowedPathPrefixes.length > 0) {
    for (const changedPath of changeSet.changedPaths) {
      if (!isPathAllowed(changedPath.path, allowedPathPrefixes)) {
        throw new Error(`unsafe workspace change path: ${changedPath.path}`);
      }
      if (changedPath.oldPath && !isPathAllowed(changedPath.oldPath, allowedPathPrefixes)) {
        throw new Error(`unsafe workspace change path: ${changedPath.oldPath}`);
      }
    }
  }

  return changeSet;
}

/**
 * Builds a pending staged review record from a parsed workspace change set.
 *
 * @param changeSet Parsed workspace change set.
 * @param options Review id, timestamp, and staging reference.
 * @returns Product-safe staged workspace review.
 */
export function stageWorkspaceChangeSet(
  changeSet: WorkspaceChangeSet,
  options: StageWorkspaceChangeSetOptions
): StagedWorkspaceReview {
  return StagedWorkspaceReviewSchema.parse({
    id: options.reviewId,
    changeSetId: changeSet.id,
    workspaceId: changeSet.workspaceId,
    status: 'pending',
    staging: {
      branch: changeSet.strategy === 'git' ? `openkit/review/${options.reviewId}` : null,
      ref: options.stagingRef,
      strategy: changeSet.strategy === 'git' ? 'git_worktree' : 'filesystem_staging',
    },
    diffSummary: {
      additions: 0,
      deletions: 0,
      filesChanged: changeSet.changedPaths.length,
    },
    riskSummary: reviewRiskSummary(changeSet),
    validation: [
      ...changeSet.evidenceRefs.map((evidence) => ({
        command: evidence.kind,
        ref: evidence.ref,
        status: 'passed' as const,
      })),
      ...binaryReviewDiagnostics(changeSet),
    ],
    actionCenterRowId: `workspace-review:${options.reviewId}`,
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
  });
}

/**
 * Converts a worker target path into a relative generated-file path.
 *
 * @param path Worker-visible path.
 * @returns Product-safe relative path.
 */
function toRelativeWorkspacePath(path: string): string {
  return path.replace(/^\/+/, '') || 'generated-file';
}

/**
 * Normalizes one allowlist prefix for path comparisons.
 *
 * @param prefix User or system supplied path prefix.
 * @returns Relative prefix without trailing slash.
 */
function normalizeAllowedPrefix(prefix: string): string {
  return prefix.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Checks whether a changed path belongs to one allowed prefix.
 *
 * @param path Changed relative path.
 * @param allowedPathPrefixes Normalized allowlist.
 * @returns True when allowed.
 */
function isPathAllowed(path: string, allowedPathPrefixes: readonly string[]): boolean {
  return allowedPathPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Adds product-visible artifact-only presentation to binary changed paths.
 *
 * @param changeSet Parsed workspace change set.
 * @returns Change set enriched with binary review presentation.
 */
function withBinaryReviewPresentations(changeSet: WorkspaceChangeSet): WorkspaceChangeSet {
  return WorkspaceChangeSetSchema.parse({
    ...changeSet,
    changedPaths: changeSet.changedPaths.map(withBinaryReviewPresentation),
  });
}

/**
 * Adds binary review presentation to one path when the text diff is not enough.
 *
 * @param changedPath Worker-declared changed path.
 * @returns Changed path with optional binary review presentation.
 */
function withBinaryReviewPresentation(changedPath: WorkspaceChangedPath): WorkspaceChangedPath {
  if (!changedPath.binary) {
    return changedPath;
  }

  const reason =
    (changedPath.size ?? 0) > BINARY_ARTIFACT_ONLY_THRESHOLD_BYTES
      ? 'binary-payload-too-large'
      : 'binary-path';

  return {
    ...changedPath,
    binaryReview: {
      bytes: changedPath.size ?? null,
      digest: changedPath.digest ?? null,
      mediaType: changedPath.mediaType ?? 'application/octet-stream',
      mode: 'artifact-only',
      reason,
      summary: `Binary change ${changedPath.path} is available as an artifact-only review item.`,
    },
  };
}

/**
 * Builds review diagnostics for binary artifact-only changed paths.
 *
 * @param changeSet Parsed workspace change set.
 * @returns Validation rows for product-safe review presentation.
 */
function binaryReviewDiagnostics(changeSet: WorkspaceChangeSet): Array<{
  command: string;
  ref: string;
  status: 'skipped';
}> {
  return changeSet.changedPaths
    .filter((path) => path.binaryReview)
    .map((path) => ({
      command: 'workspace.binary_artifact_only',
      ref: `workspace-path:${path.path}`,
      status: 'skipped',
    }));
}

/**
 * Builds a stable digest for product-visible materialization policy inputs.
 *
 * @param value Policy input value.
 * @returns SHA-256 digest string.
 */
function digestPolicy(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/**
 * Converts backend materialization readiness into product-safe evidence references.
 *
 * @param materialization Backend materialization summary.
 * @returns Product-safe readiness evidence references.
 */
function materializationReadinessEvidence(
  materialization: BuildWorkspaceMaterializationRecordsMaterialization
): WorkspaceMaterializationRecord['readinessEvidence'] {
  const evidence: WorkspaceMaterializationRecord['readinessEvidence'] = [];

  if (materialization.backendStatus) {
    evidence.push({
      kind: `backend.${materialization.backendStatus.health}`,
      ref: materialization.backendStatus.version
        ? `version:${materialization.backendStatus.version}`
        : materialization.backendKind,
    });
  }

  if (materialization.sandbox) {
    evidence.push({
      kind: `sandbox.${materialization.sandbox.state}`,
      ref: materialization.sandbox.name,
    });
  }

  return evidence;
}

/**
 * Builds a concise risk summary for a staged workspace review.
 *
 * @param changeSet Parsed change set.
 * @returns Human-readable risk summary.
 */
function reviewRiskSummary(changeSet: WorkspaceChangeSet): string {
  const changedPathLabel = changeSet.changedPaths.length === 1 ? 'changed path' : 'changed paths';
  const binaryCount = changeSet.changedPaths.filter((entry) => entry.binaryReview).length;

  if (binaryCount > 0) {
    const binaryPathLabel =
      binaryCount === 1 ? 'artifact-only binary path' : 'artifact-only binary paths';

    return `${changeSet.changedPaths.length} ${changedPathLabel} staged for review, including ${binaryCount} ${binaryPathLabel}.`;
  }

  return `${changeSet.changedPaths.length} ${changedPathLabel} staged for human review.`;
}
