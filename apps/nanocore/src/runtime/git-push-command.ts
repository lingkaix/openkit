/** Environment variables allowed for host-side Git push commands. */
const SAFE_GIT_ENV_KEYS = ['HOME', 'LANG', 'LC_ALL', 'PATH', 'SystemRoot', 'WINDIR'] as const;
const GITHUB_CREDENTIAL_ENV_KEYS = ['GITHUB_TOKEN', 'GH_TOKEN'] as const;
const UNSAFE_TARGET_BRANCH_CHARS = new Set(['~', '^', '?', '*', '[', ']', '\\']);

/** Input for constructing one host-side Git push command. */
export interface BuildGitPushCommandInput {
  /** Candidate process environment. */
  readonly env?: NodeJS.ProcessEnv;
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
  assertRemoteName(input.remoteName);
  assertSourceRef(input.sourceRef);
  assertTargetBranch(input.targetBranch);

  return {
    args: [
      'push',
      '--porcelain',
      '--',
      input.remoteName,
      `${input.sourceRef}:refs/heads/${input.targetBranch}`,
    ],
    command: 'git',
    env: scrubGitPushEnv(input.env ?? {}),
  };
}

/**
 * Keeps only Git runtime variables and V1 GitHub credentials for the child process.
 *
 * @param env Candidate process environment.
 * @returns Scrubbed environment.
 */
function scrubGitPushEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const scrubbed: Record<string, string> = {};

  for (const key of SAFE_GIT_ENV_KEYS) {
    const value = env[key];
    if (value) {
      scrubbed[key] = value;
    }
  }
  for (const key of GITHUB_CREDENTIAL_ENV_KEYS) {
    const value = env[key];
    if (value) {
      scrubbed[key] = value;
    }
  }

  scrubbed.GIT_TERMINAL_PROMPT = '0';
  return scrubbed;
}

/**
 * Rejects remote names that can be parsed as command options or refspecs.
 *
 * @param value Candidate remote name.
 * @throws Error when the remote name is unsafe.
 */
function assertRemoteName(value: string): void {
  if (!value || value.startsWith('-') || hasControlOrWhitespace(value) || value.includes(':')) {
    throw new Error('Git push remote name is not safe.');
  }
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
