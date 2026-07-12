/** Environment variables allowed for host-side Git push commands. */
const SAFE_GIT_ENV_KEYS = ['HOME', 'LANG', 'LC_ALL', 'PATH', 'SystemRoot', 'WINDIR'] as const;
const GITHUB_PUSH_TARGET_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;
const UNSAFE_TARGET_BRANCH_CHARS = new Set(['~', '^', '?', '*', '[', ']', '\\']);

/** Input for constructing one host-side Git push command. */
export interface BuildGitPushCommandInput {
  /** Candidate process environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** Remote target head observed immediately before publication checks. */
  readonly expectedRemoteHead: string;
  /** Git remote name or URL summary accepted by the provider adapter. */
  readonly remoteName: string;
  /** Local source ref to publish. */
  readonly sourceRef: string;
  /** Remote branch target without `refs/heads/`. */
  readonly targetBranch: string;
}

/** Fixed Git push command vector and scrubbed environment. */
export interface GitPushCommand {
  /** Executable name. */
  readonly command: 'git';
  /** Fixed argument vector. */
  readonly args: string[];
  /** Scrubbed environment for the child process. */
  readonly env: Record<string, string>;
}

/**
 * Builds a fixed-argument Git push command without shell interpolation.
 *
 * @param input Push command input.
 * @returns Command vector and scrubbed environment.
 * @throws Error when a ref shape could express options, force, delete, or compound refspecs.
 */
export function buildGitPushCommand(input: BuildGitPushCommandInput): GitPushCommand {
  assertGitPushCommandShape(input.remoteName, input.sourceRef, input.targetBranch);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.expectedRemoteHead)) {
    throw new Error('Git push expected remote head is not safe.');
  }

  return {
    args: [
      'push',
      '--porcelain',
      '--no-verify',
      `--force-with-lease=refs/heads/${input.targetBranch}:${input.expectedRemoteHead}`,
      '--',
      input.remoteName,
      `${input.sourceRef}:refs/heads/${input.targetBranch}`,
    ],
    command: 'git',
    env: createGitPushEnvironment(input.env ?? {}, input.remoteName),
  };
}

/**
 * Validates the provider target and ref shapes shared by push preflight and command construction.
 *
 * @param remoteName Candidate GitHub HTTPS push target.
 * @param sourceRef Candidate immutable source ref.
 * @param targetBranch Candidate remote branch name.
 * @throws Error when any command field could express an unsafe Git operation.
 */
export function assertGitPushCommandShape(
  remoteName: string,
  sourceRef: string,
  targetBranch: string
): void {
  if (!isGitHubPushTarget(remoteName)) {
    throw new Error('Git push target is not a canonical GitHub HTTPS URL.');
  }
  assertSourceRef(sourceRef);
  assertTargetBranch(targetBranch);
}

/**
 * Checks whether a target is one canonical GitHub HTTPS repository URL.
 *
 * @param value Candidate Git push target.
 * @returns True when the target is accepted by the GitHub V1 adapter.
 */
export function isGitHubPushTarget(value: string): boolean {
  return GITHUB_PUSH_TARGET_PATTERN.test(value);
}

/**
 * Keeps only Git runtime variables and converts V1 GitHub credentials into command-scoped config.
 *
 * @param env Candidate process environment.
 * @param remoteName Validated Git push target.
 * @returns Scrubbed environment.
 */
export function createGitPushEnvironment(
  env: NodeJS.ProcessEnv,
  remoteName: string
): Record<string, string> {
  const scrubbed: Record<string, string> = {};

  for (const key of SAFE_GIT_ENV_KEYS) {
    const value = env[key];
    if (value) {
      scrubbed[key] = value;
    }
  }

  const githubToken = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (githubToken && isGitHubPushTarget(remoteName)) {
    scrubbed.GIT_CONFIG_COUNT = '2';
    scrubbed.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    scrubbed.GIT_CONFIG_VALUE_0 = '';
    scrubbed.GIT_CONFIG_KEY_1 = 'http.https://github.com/.extraheader';
    scrubbed.GIT_CONFIG_VALUE_1 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`;
  }

  scrubbed.GIT_TERMINAL_PROMPT = '0';
  return scrubbed;
}

/**
 * Rejects source refs that can express force, delete, options, or compound refspecs.
 *
 * @param value Candidate source ref.
 * @throws Error when the source ref is unsafe.
 */
function assertSourceRef(value: string): void {
  if (!value || value.startsWith('-') || value.startsWith('+') || hasControlOrWhitespace(value)) {
    throw new Error('Git push source ref is not safe.');
  }
  if (value.includes(':')) {
    throw new Error('Git push source ref is not safe.');
  }
}

/**
 * Rejects target branch names outside the V1 branch-push subset.
 *
 * @param value Candidate target branch.
 * @throws Error when the target branch is unsafe.
 */
function assertTargetBranch(value: string): void {
  if (
    !value ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.lock') ||
    value.includes(':') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    hasUnsafeTargetBranchChar(value)
  ) {
    throw new Error('Git push target branch is not safe.');
  }
}

/**
 * Checks for characters outside the V1 branch-push target subset.
 *
 * @param value Candidate branch name.
 * @returns True when the branch contains an unsafe character.
 */
function hasUnsafeTargetBranchChar(value: string): boolean {
  for (const char of value) {
    if (hasControlOrWhitespace(char) || UNSAFE_TARGET_BRANCH_CHARS.has(char)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks for control characters and whitespace.
 *
 * @param value Candidate string.
 * @returns True when the value contains whitespace or control characters.
 */
function hasControlOrWhitespace(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 32 || code === 127) {
      return true;
    }
  }

  return false;
}
