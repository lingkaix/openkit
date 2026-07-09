import { statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Resource kind validated by the repository path validation service.
 */
export type RepositoryValidationResourceKind = 'git_repository';

/**
 * Stable validation status for a repository path.
 */
export type RepositoryValidationStatus =
  | 'ready'
  | 'missing'
  | 'not_directory'
  | 'not_git'
  | 'inaccessible';

/**
 * User-safe repository path validation result.
 */
export interface RepositoryValidationResult {
  /** True when the path is an existing local git repository directory. */
  readonly ok: boolean;
  /** Kind of resource being validated. */
  readonly resourceKind: RepositoryValidationResourceKind;
  /** Stable machine-readable validation status. */
  readonly status: RepositoryValidationStatus;
  /** Short user-facing status summary without raw local paths. */
  readonly summary: string;
  /** Sanitized basename-level path label without raw absolute paths. */
  readonly pathSummary: string;
}

/**
 * Validates whether a local path is an existing git repository directory.
 *
 * A directory is considered a git repository when it contains either a `.git`
 * directory or a `.git` file, matching normal and worktree layouts. The returned
 * diagnostics avoid raw absolute paths and redact common secret-like substrings.
 *
 * @param repositoryPath Local repository candidate path.
 * @returns Stable validation result with user-safe diagnostics.
 */
export function validateRepositoryPath(repositoryPath: string): RepositoryValidationResult {
  const pathSummary = summarizePath(repositoryPath);

  try {
    const stat = statSync(repositoryPath);

    if (!stat.isDirectory()) {
      return createResult(
        'not_directory',
        false,
        `${pathSummary} exists, but it is not a directory.`,
        pathSummary
      );
    }

    if (!hasGitMarker(repositoryPath)) {
      return createResult(
        'not_git',
        false,
        `${pathSummary} is not a git repository directory.`,
        pathSummary
      );
    }

    return createResult('ready', true, `${pathSummary} is ready as a git repository.`, pathSummary);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return createResult('missing', false, `${pathSummary} does not exist.`, pathSummary);
    }

    return createResult(
      'inaccessible',
      false,
      `${pathSummary} could not be inspected.`,
      pathSummary
    );
  }
}

/**
 * Creates a repository validation result.
 *
 * @param status Stable validation status.
 * @param ok Whether validation succeeded.
 * @param summary User-facing summary.
 * @param pathSummary Sanitized path label.
 * @returns Validation result object.
 */
function createResult(
  status: RepositoryValidationStatus,
  ok: boolean,
  summary: string,
  pathSummary: string
): RepositoryValidationResult {
  return {
    ok,
    pathSummary,
    resourceKind: 'git_repository',
    status,
    summary: redactSecretLikeText(summary),
  };
}

/**
 * Checks whether a repository candidate contains a git marker.
 *
 * @param repositoryPath Local repository candidate path.
 * @returns True when `.git` exists as a file or directory.
 */
function hasGitMarker(repositoryPath: string): boolean {
  try {
    const gitMarker = statSync(join(repositoryPath, '.git'));
    return gitMarker.isDirectory() || gitMarker.isFile();
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false;
    }

    throw error;
  }
}

/**
 * Builds a user-safe path label from a local path.
 *
 * @param repositoryPath Local repository candidate path.
 * @returns Sanitized basename-level path summary.
 */
function summarizePath(repositoryPath: string): string {
  const name = redactSecretLikeText(basename(repositoryPath) || 'selected path');
  return `local directory "${name}"`;
}

/**
 * Redacts common secret-like substrings from user-facing diagnostics.
 *
 * @param text Text that may include a secret-like token.
 * @returns Text with secret-like substrings replaced.
 */
function redactSecretLikeText(text: string): string {
  return text
    .replace(
      /\b(?:sk|pk|pat|ghp|gho|github_pat|token|secret|key|password)[a-z0-9._-]{4,}\b/gi,
      '[redacted]'
    )
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
}

/**
 * Checks whether an unknown error has a specific Node error code.
 *
 * @param error Error value to inspect.
 * @param code Expected Node error code.
 * @returns True when the error has the expected code.
 */
function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
