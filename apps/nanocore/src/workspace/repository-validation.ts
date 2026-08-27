import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
 * Optional data-root context for repository path inspection.
 */
export interface InspectRepositoryPathOptions {
  /** Absolute NanoCore DATA_ROOT used for containment exclusion. */
  readonly dataRoot?: string;
}

/**
 * Internal DATA_ROOT boundary decision for one repository candidate.
 */
export type RepositoryPathBoundary = 'clear' | 'contained' | 'unresolved';

/**
 * Shared repository inspection for user-safe diagnostics and internal consumers.
 */
export interface RepositoryPathInspection {
  /** User-safe validation diagnostics with no raw host path. */
  readonly validation: RepositoryValidationResult;
  /** Canonical repository path for internal consumers when the candidate is ready and clear. */
  readonly canonicalPath: string | null;
  /** Explicit DATA_ROOT boundary decision for internal consumers. */
  readonly boundary: RepositoryPathBoundary;
}

/**
 * Validates whether a local path is an existing git repository directory.
 *
 * A directory is considered a git repository when it contains either a `.git`
 * directory or a `.git` file, matching normal and worktree layouts. The returned
 * diagnostics avoid raw absolute paths and redact common secret-like substrings.
 * When `dataRoot` is provided, lexical DATA_ROOT equality and path-segment
 * descendants are rejected before filesystem validation. A filesystem-ready
 * candidate is then compared once against DATA_ROOT realpath; a realpath
 * failure is unresolved and non-ready.
 *
 * @param repositoryPath Local repository candidate path.
 * @param options Optional DATA_ROOT containment context.
 * @returns Stable validation result with user-safe diagnostics.
 */
export function validateRepositoryPath(
  repositoryPath: string,
  options: InspectRepositoryPathOptions = {}
): RepositoryValidationResult {
  return inspectRepositoryPath(repositoryPath, options).validation;
}

/**
 * Inspects one repository candidate for user-safe validation and one canonical path.
 *
 * Missing, non-directory, not-git, and inaccessible results stay on the existing
 * status owner for clear external candidates. Lexical DATA_ROOT containment is
 * decided before filesystem validation. For a filesystem-ready candidate, one
 * candidate realpath and one DATA_ROOT realpath decide contained versus
 * unresolved. The canonical path is never copied onto `RepositoryValidationResult`.
 *
 * @param repositoryPath Local repository candidate path.
 * @param options Optional DATA_ROOT containment context.
 * @returns User-safe validation, canonical path, and boundary decision.
 */
export function inspectRepositoryPath(
  repositoryPath: string,
  options: InspectRepositoryPathOptions = {}
): RepositoryPathInspection {
  const pathSummary = summarizePath(repositoryPath);
  const dataRoot = options.dataRoot;

  if (
    dataRoot !== undefined &&
    isPathSegmentContained(resolve(repositoryPath), resolve(dataRoot))
  ) {
    return excludedInspection('contained', pathSummary);
  }

  const validation = inspectFilesystem(repositoryPath, pathSummary);
  if (!validation.ok) {
    return {
      boundary: 'clear',
      canonicalPath: null,
      validation,
    };
  }

  if (dataRoot === undefined) {
    try {
      return {
        boundary: 'clear',
        canonicalPath: realpathSync(repositoryPath),
        validation,
      };
    } catch {
      return {
        boundary: 'clear',
        canonicalPath: null,
        validation: createResult(
          'inaccessible',
          false,
          `${pathSummary} could not be inspected.`,
          pathSummary
        ),
      };
    }
  }

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(repositoryPath);
  } catch {
    return excludedInspection('unresolved', pathSummary);
  }

  let dataRootRealPath: string;
  try {
    dataRootRealPath = realpathSync(dataRoot);
  } catch {
    return excludedInspection('unresolved', pathSummary);
  }

  if (isPathSegmentContained(canonicalPath, dataRootRealPath)) {
    return excludedInspection('contained', pathSummary);
  }

  return {
    boundary: 'clear',
    canonicalPath,
    validation,
  };
}

/**
 * Builds a redacted non-ready inspection for a DATA_ROOT boundary exclusion.
 *
 * @param boundary Contained or unresolved boundary.
 * @param pathSummary Sanitized path label.
 * @returns Inspection with no canonical path.
 */
function excludedInspection(
  boundary: Exclude<RepositoryPathBoundary, 'clear'>,
  pathSummary: string
): RepositoryPathInspection {
  return {
    boundary,
    canonicalPath: null,
    validation: createResult(
      'inaccessible',
      false,
      `${pathSummary} is not a usable workspace repository location.`,
      pathSummary
    ),
  };
}

/**
 * Validates the candidate as an existing git repository directory.
 *
 * @param repositoryPath Local repository candidate path.
 * @param pathSummary Sanitized path label.
 * @returns Filesystem validation result.
 */
function inspectFilesystem(
  repositoryPath: string,
  pathSummary: string
): RepositoryValidationResult {
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
 * Reports path-segment containment using `path.relative`, not string prefix.
 *
 * @param candidate Normalized or real candidate path.
 * @param root Normalized or real root path.
 * @returns True when candidate equals root or is a descendant of root.
 */
function isPathSegmentContained(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
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
