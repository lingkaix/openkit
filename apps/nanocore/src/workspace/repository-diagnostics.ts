import {
  type WorkspaceRepositoryDiagnostic,
  WorkspaceRepositoryDiagnosticSchema,
} from '@openkit/app-api-schemas';

import type { WorkspaceRepositoryResourceRecord } from './repository-store.js';
import type { RepositoryValidationResult } from './repository-validation.js';
import { validateRepositoryPath } from './repository-validation.js';

/**
 * Developer-only repository diagnostic row that may include host-local paths.
 */
export interface WorkspaceRepositoryDeveloperDiagnostic {
  /** Marks this row as a developer-only diagnostic payload. */
  readonly kind: 'developer';
  /** Workspace identifier that owns the repository resource. */
  readonly workspaceId: string;
  /** Stable repository resource identifier. */
  readonly resourceId: string;
  /** Raw host-local repository path for developer inspection. */
  readonly localPath: string;
  /** Latest validation result for the raw local path. */
  readonly validation: RepositoryValidationResult;
}

/**
 * Creates a redacted repository diagnostics row for stable App API payloads.
 *
 * @param record Stored repository resource record.
 * @returns Stable, user-safe repository diagnostics row.
 */
export function createWorkspaceRepositoryDiagnostic(
  record: WorkspaceRepositoryResourceRecord
): WorkspaceRepositoryDiagnostic {
  const validation = repositoryValidation(record);

  return WorkspaceRepositoryDiagnosticSchema.parse({
    workspaceId: record.workspaceId,
    resourceId: record.resourceId,
    type: record.type,
    displayName: safeWorkspaceRepositoryDisplayName(record, validation),
    diagnosticsStatus: validation.status,
    ready: validation.ok,
    summary: validation.summary,
    pathSummary: validation.pathSummary,
    updatedAt: record.updatedAt,
  });
}

/**
 * Creates a developer-only repository diagnostics row that keeps raw host paths.
 *
 * @param record Stored repository resource record.
 * @returns Developer-only repository diagnostics row.
 */
export function createWorkspaceRepositoryDeveloperDiagnostic(
  record: WorkspaceRepositoryResourceRecord
): WorkspaceRepositoryDeveloperDiagnostic {
  return {
    kind: 'developer',
    workspaceId: record.workspaceId,
    resourceId: record.resourceId,
    localPath: record.localPath,
    validation: repositoryValidation(record),
  };
}

/**
 * Returns a repository display name that is safe for stable App API responses.
 *
 * @param record Stored repository resource record.
 * @param validation Safe repository validation read model.
 * @returns User-safe display name for stable response payloads.
 */
export function safeWorkspaceRepositoryDisplayName(
  record: WorkspaceRepositoryResourceRecord,
  validation: RepositoryValidationResult
): string {
  if (isUnsafeRepositoryDisplayName(record.displayName, record.localPath)) {
    return validation.pathSummary;
  }

  return record.displayName;
}

/**
 * Returns the latest validation result for a repository resource record.
 *
 * @param record Stored repository resource record.
 * @returns User-safe repository validation result.
 */
function repositoryValidation(
  record: WorkspaceRepositoryResourceRecord
): RepositoryValidationResult {
  return record.validation ?? validateRepositoryPath(record.localPath);
}

/**
 * Checks whether a repository display name would expose host path details.
 *
 * @param displayName Candidate stored display name.
 * @param localPath Stored host-local repository path.
 * @returns True when the display name should be replaced in response payloads.
 */
function isUnsafeRepositoryDisplayName(displayName: string, localPath: string): boolean {
  const trimmedDisplayName = displayName.trim();
  const embeddedAbsolutePathPattern = /(?:^|[\s"'`(])(?:\/|~\/|[A-Za-z]:[\\/]|\\\\|\/\/)\S*/;

  return (
    trimmedDisplayName === localPath ||
    trimmedDisplayName.includes(localPath) ||
    embeddedAbsolutePathPattern.test(trimmedDisplayName)
  );
}
