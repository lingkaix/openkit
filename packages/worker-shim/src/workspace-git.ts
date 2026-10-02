import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { GitFailureExplanation } from '@openkit/worker-protocol';

const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_TIMEOUT_MS = 20_000;
/** Git-backed writable workspace input used by the worker shim. */
export interface WorkspaceGitInput {
  /** Package-local workspace input id. */
  id: string;
  /** Host path materialized for the worker. */
  target: string;
  /** Worker access mode. */
  access: 'read-only' | 'read-write';
  /** Exact credential-free remote Git source resolved by NanoCore. */
  source: {
    /** Stable digest of the selected catalog entry. */
    catalogEntryDigest: string;
    /** Exact remote commit selected for this Turn. */
    commit: string;
    /** Closed source kind consumed by this materializer. */
    kind: 'git';
    /** Catalog sensitivity classification. */
    sensitivity: 'public' | 'internal' | 'confidential' | 'restricted';
    /** Stable catalog source id. */
    sourceId: string;
    /** Manifest-authored source reference. */
    sourceRef: string;
    /** Credential-free HTTPS Git URL. */
    url: string;
  };
}

/**
 * Materializes exact remote Git commits into absent or empty plain work slots, preserving populated targets.
 *
 * @param inputs Validated remote Git inputs selected for this Turn.
 * @param workspaceRoot Worker-visible root that contains every target.
 * @param sessionDir Worker session directory used for the scrubbed Git environment.
 * @returns Measured HEAD and tree for a new checkout, or null for absent inputs or retained slots.
 * @throws When a target escapes the workspace root or Git cannot produce the exact commit.
 */
export async function materializeWorkspaceGitInputs(
  inputs: readonly WorkspaceGitInput[],
  workspaceRoot: string,
  sessionDir: string
): Promise<{ commit: string; tree: string } | null> {
  if (inputs.length > 1) {
    throw new Error('Only one writable Git workspace input is supported per worker session.');
  }
  if (inputs.length === 0) {
    return null;
  }

  const root = resolve(workspaceRoot);

  for (const input of inputs) {
    const target = resolve(input.target);
    const targetRelative = relative(root, target);
    if (
      targetRelative === '' ||
      isAbsolute(targetRelative) ||
      targetRelative === '..' ||
      targetRelative.startsWith(`..${sep}`)
    ) {
      throw new Error('Git workspace target must stay beneath the declared workspace root.');
    }

    await prepareWorkspaceTargetParent(root, dirname(target));

    const existing = await lstatIfExists(target);
    if (existing) {
      await assertPlainDirectory(target);
      if ((await readdir(target)).length > 0) {
        await assertRetainedWorkspaceSource(input, sessionDir);
        return null;
      }
    } else {
      await mkdir(target);
    }
    await requireGitText(
      target,
      sessionDir,
      ['init', `--object-format=${input.source.commit.length === 64 ? 'sha256' : 'sha1'}`],
      {},
      'Remote Git workspace initialization failed.'
    );
    await requireGitText(
      target,
      sessionDir,
      ['remote', 'add', 'origin', input.source.url],
      {},
      'Remote Git origin configuration failed.'
    );
    await fetchDeclaredCommit(target, sessionDir, input.source.commit);
    await requireGitText(
      target,
      sessionDir,
      ['checkout', '--detach', input.source.commit],
      {},
      'Remote Git commit checkout failed.'
    );
    if (
      (await requireGitCommit(
        target,
        sessionDir,
        'HEAD',
        'Remote Git workspace HEAD is unavailable.'
      )) !== input.source.commit
    ) {
      throw new Error('Remote Git workspace HEAD does not match the declared commit.');
    }
    if (
      (
        await requireGitText(
          target,
          sessionDir,
          ['status', '--porcelain'],
          {},
          'Remote Git workspace cleanliness is unavailable.'
        )
      ).trim() !== ''
    ) {
      throw new Error('Git workspace must be clean before the worker starts.');
    }
    const commit = await requireGitCommit(
      target,
      sessionDir,
      'HEAD',
      'Remote Git workspace HEAD is unavailable.'
    );
    const tree = (
      await requireGitText(
        target,
        sessionDir,
        ['rev-parse', '--verify', 'HEAD^{tree}'],
        {},
        'Remote Git workspace tree is unavailable.'
      )
    ).trim();
    if (!GIT_OBJECT_ID_PATTERN.test(tree)) throw new Error('Remote Git workspace tree is invalid.');
    return { commit, tree };
  }

  return null;
}

/** Creates a source-less slot without following links or replacing retained bytes. */
export async function initializeEmptyWorkspaceSlot(root: string, target: string): Promise<void> {
  const targetRelative = relative(resolve(root), resolve(target));
  if (
    !targetRelative ||
    isAbsolute(targetRelative) ||
    targetRelative === '..' ||
    targetRelative.startsWith(`..${sep}`)
  )
    throw new Error('Empty workspace target escapes its root.');
  await prepareWorkspaceTargetParent(resolve(root), dirname(resolve(target)));
  if (!(await lstatIfExists(target))) await mkdir(target);
  await assertPlainDirectory(target);
}

/** Creates only missing target-parent directories after the complete lexical chain is safe. */
async function prepareWorkspaceTargetParent(root: string, targetParent: string): Promise<void> {
  const chain = await inspectWorkspaceDirectoryChain(root, targetParent);
  for (const path of chain) {
    const status = await lstatIfExists(path);
    if (!status) {
      await mkdir(path);
    }
    await assertPlainDirectory(path);
  }
}

/** Returns the lexical trusted-ancestor chain after rejecting existing links and non-directories. */
async function inspectWorkspaceDirectoryChain(
  root: string,
  targetParent: string
): Promise<string[]> {
  let trustedRoot = root;
  while (!(await lstatIfExists(trustedRoot))) {
    const parent = dirname(trustedRoot);
    if (parent === trustedRoot) {
      throw new Error('Git workspace root has no existing directory ancestor.');
    }
    trustedRoot = parent;
  }

  const targetRelative = relative(trustedRoot, targetParent);
  if (
    isAbsolute(targetRelative) ||
    targetRelative === '..' ||
    targetRelative.startsWith(`..${sep}`)
  ) {
    throw new Error('Git workspace target parent escapes the declared workspace root.');
  }

  const chain = [trustedRoot];
  let current = trustedRoot;
  for (const segment of targetRelative.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    chain.push(current);
  }
  for (const path of chain) {
    const status = await lstatIfExists(path);
    if (status) {
      assertPlainDirectoryStatus(path, status);
    }
  }
  return chain;
}

/** Requires one path to remain an existing ordinary directory. */
async function assertPlainDirectory(path: string): Promise<void> {
  const status = await lstatIfExists(path);
  if (!status) {
    throw new Error('Git workspace directory disappeared during materialization.');
  }
  assertPlainDirectoryStatus(path, status);
}

/** Rejects one inspected directory status when it could redirect or block containment. */
function assertPlainDirectoryStatus(path: string, status: Awaited<ReturnType<typeof lstat>>): void {
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(
      `Git workspace path must stay beneath the declared workspace root without symbolic-link ancestors: ${path}`
    );
  }
}

/** Returns link-preserving filesystem status without treating an absent path as failure. */
async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** Verifies that a retained worktree still belongs to the requested exact source and baseline. */
async function assertRetainedWorkspaceSource(
  input: WorkspaceGitInput,
  sessionDir: string
): Promise<void> {
  // HEAD may have moved through legitimate worker commits; only its availability and source identity are readiness facts here.
  await requireGitCommit(
    input.target,
    sessionDir,
    'HEAD',
    'Retained Git workspace baseline is unavailable.'
  );
  const origin = (
    await requireGitText(
      input.target,
      sessionDir,
      ['config', '--local', '--no-includes', '--get', 'remote.origin.url'],
      {},
      'Retained Git workspace source is unavailable.'
    )
  ).trim();
  if (origin !== input.source.url) {
    throw new Error('Retained Git workspace source conflicts with the requested origin.');
  }
}

/**
 * Runs a required Git command and returns exact stdout bytes.
 *
 * @param cwd Git workspace root.
 * @param sessionDir Worker session directory used for the scrubbed Git environment.
 * @param argv Git argument vector.
 * @param environment Explicit command-local Git environment overrides.
 * @param failureMessage Product-safe failure message.
 * @param stdin Optional exact stdin bytes.
 * @returns Exact stdout bytes.
 */
async function requireGitBytes(
  cwd: string,
  sessionDir: string,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  failureMessage: string,
  stdin?: Buffer
): Promise<Buffer> {
  const output = await gitBytes(cwd, sessionDir, argv, environment, stdin);
  if (!output) {
    throw new Error(failureMessage);
  }
  return output;
}

/**
 * Runs a required Git command and returns exact UTF-8 stdout text.
 *
 * @param cwd Git workspace root.
 * @param sessionDir Worker session directory used for the scrubbed Git environment.
 * @param argv Git argument vector.
 * @param environment Explicit command-local Git environment overrides.
 * @param failureMessage Product-safe failure message.
 * @param stdin Optional exact stdin bytes.
 * @returns Exact stdout text.
 */
async function requireGitText(
  cwd: string,
  sessionDir: string,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  failureMessage: string,
  stdin?: Buffer
): Promise<string> {
  return (
    await requireGitBytes(cwd, sessionDir, argv, environment, failureMessage, stdin)
  ).toString('utf8');
}

/** Private stderr retained only to classify a failed fetch. It never enters a product error. */
const GIT_STDERR_LIMIT = 4096;

/** How a failed Git subprocess ended. Successful commands leave this null. */
type GitFailureKind = 'exit' | 'signal' | 'spawn' | 'timeout';

/** Outcome of one bounded Git subprocess. */
interface GitInvocation {
  readonly failure: GitFailureKind | null;
  readonly ok: boolean;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
  readonly stdout: Buffer;
}

/**
 * Fetches one exact commit into an empty slot.
 *
 * A depth-1 raw object id is the fast path, and both that fetch and the advertised-ref fallback use HTTP/1.1. Any completed nonzero fetch tries advertised branch tips and tags once. A timeout, signal, or spawn failure does not. Checkout continues only when the object type is exactly `commit`. A completed check that reports the object is absent is a distinct refusal. The terminal fetch failure is a certificate failure, a transport failure, or an ordinary fetch failure. Every other object-check failure stays an ordinary fetch failure.
 *
 * @param cwd Empty Git workspace root.
 * @param sessionDir Worker session directory used for the scrubbed Git environment.
 * @param commit Exact declared commit.
 */
async function fetchDeclaredCommit(cwd: string, sessionDir: string, commit: string): Promise<void> {
  const fetchConfig = ['http.version=HTTP/1.1'];
  const direct = await gitInvocation(
    cwd,
    sessionDir,
    ['fetch', '--no-tags', '--depth=1', 'origin', commit],
    {},
    undefined,
    fetchConfig
  );
  if (direct.ok) {
    return;
  }
  if (direct.failure !== 'exit') {
    throwTerminalFetchFailure(direct);
  }
  const advertised = await gitInvocation(
    cwd,
    sessionDir,
    ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*'],
    {},
    undefined,
    fetchConfig
  );
  if (!advertised.ok) {
    throwTerminalFetchFailure(advertised);
  }
  const object = await gitInvocation(cwd, sessionDir, ['cat-file', '-t', commit]);
  if (object.ok) {
    if (object.stdout.toString('utf8').trim() !== 'commit') {
      throw new Error('Remote Git commit fetch failed.');
    }
    return;
  }
  if (
    object.failure === 'exit' &&
    object.stderr.toLowerCase().includes('could not get object info')
  ) {
    throw new Error('Remote Git commit is not available from the configured remote.');
  }
  throw new Error('Remote Git commit fetch failed.');
}

/** Private stderr phrases that identify a certificate failure without leaving the process. */
const FETCH_TLS_MARKERS = [
  'ssl certificate',
  'certificate problem',
  'self-signed',
  'unable to get local issuer',
  'tls certificate',
  'certificate signer not trusted',
  'server certificate verification failed',
  'certificate verification failed',
] as const;

/** Private stderr phrases that identify a transport failure without leaving the process. */
const FETCH_TRANSPORT_MARKERS = [
  'http/2',
  'http2 framing',
  'framing layer',
  'could not resolve host',
  'failed to connect',
  'connection refused',
  'connection reset',
  'connection timed out',
  'early eof',
  'proxy connect',
  'connect tunnel failed',
  'could not resolve proxy',
  'recv failure',
] as const;

/**
 * Refuses the terminal fetch with a closed product message.
 *
 * Timeout, signal, and spawn are transport failures. A completed failure is a certificate failure or a transport failure only when its private stderr matches a fixed phrase. Every other completed failure stays ordinary.
 *
 * @param invocation Failed fetch invocation.
 */
function throwTerminalFetchFailure(invocation: GitInvocation): never {
  const stderr = invocation.stderr.toLowerCase();
  // Match Git's refusal phrase, never an arbitrary status-looking URL or identifier.
  const refusalPattern = invocation.stderrTruncated
    ? /the requested url returned error: (401|403)(?=\s)/
    : /the requested url returned error: (401|403)(?=\s|$)/;
  const status = refusalPattern.exec(stderr)?.[1];
  const httpStatus = invocation.failure === 'exit' && status ? (Number(status) as 401 | 403) : null;
  const code: GitFailureExplanation['code'] =
    invocation.failure !== 'exit'
      ? 'git_fetch_transport_failed'
      : httpStatus !== null
        ? 'git_fetch_http_refused'
        : FETCH_TLS_MARKERS.some((marker) => stderr.includes(marker))
          ? 'git_fetch_tls_failed'
          : FETCH_TRANSPORT_MARKERS.some((marker) => stderr.includes(marker))
            ? 'git_fetch_transport_failed'
            : 'git_fetch_failed';
  const messages: Record<GitFailureExplanation['code'], string> = {
    git_fetch_failed: 'Remote Git commit fetch failed.',
    git_fetch_tls_failed: 'Remote Git commit fetch TLS failed.',
    git_fetch_transport_failed: 'Remote Git commit fetch transport failed.',
    git_fetch_http_refused: 'Remote Git commit fetch HTTP refused.',
  };
  const explanation: GitFailureExplanation = {
    code,
    stage: 'workspace_materialization',
    operation: 'git.fetch',
    dependency: 'git_remote',
    producer: 'worker-shim',
    observedAt: new Date().toISOString(),
    basis: 'direct_observation',
    subprocess: invocation.failure ?? 'exit',
    httpStatus,
    enforcement: 'unavailable',
    evidence: { availability: 'partial', outputTruncated: invocation.stderrTruncated },
  };
  throw Object.assign(new Error(messages[code]), { explanation });
}

/**
 * Runs one bounded Git subprocess with a scrubbed environment.
 *
 * @param cwd Git workspace root.
 * @param sessionDir Worker session directory used to disable ambient config.
 * @param argv Git argument vector.
 * @param environment Explicit command-local Git environment overrides.
 * @param stdin Optional exact stdin bytes.
 * @returns Exact stdout bytes, or null when Git fails or times out.
 */
async function gitBytes(
  cwd: string,
  sessionDir: string,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = {},
  stdin?: Buffer
): Promise<Buffer | null> {
  const result = await gitInvocation(cwd, sessionDir, argv, environment, stdin);
  return result.ok ? result.stdout : null;
}

/**
 * Runs one bounded Git subprocess and retains a private stderr prefix.
 *
 * @param cwd Git workspace root.
 * @param sessionDir Worker session directory used to disable ambient config.
 * @param argv Git argument vector.
 * @param environment Explicit command-local Git environment overrides.
 * @param stdin Optional exact stdin bytes.
 * @param config Git config assignments inserted before the subcommand.
 * @returns Success, exact stdout, a bounded stderr prefix, and the failure kind.
 */
async function gitInvocation(
  cwd: string,
  sessionDir: string,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = {},
  stdin?: Buffer,
  config: readonly string[] = []
): Promise<GitInvocation> {
  return new Promise((resolveOutput) => {
    const child = spawn(
      'git',
      [
        '--no-pager',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        ...config.flatMap((entry) => ['-c', entry]),
        ...argv,
      ],
      {
        cwd,
        env: gitEnvironment(sessionDir, environment),
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      }
    );
    const chunks: Buffer[] = [];
    let stderr = '';
    let stderrTruncated = false;
    let settled = false;
    let failure: GitFailureKind | null = null;
    const finish = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolveOutput({
        failure: ok ? null : failure,
        ok,
        stderr,
        stderrTruncated,
        stdout: Buffer.concat(chunks),
      });
    };
    const abort = () => {
      if (settled) {
        return;
      }
      failure = 'timeout';
      child.kill('SIGKILL');
    };
    const timeout = setTimeout(abort, gitTimeoutMs());

    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length + chunk.toString('utf8').length > GIT_STDERR_LIMIT) {
        stderrTruncated = true;
      }
      if (stderr.length < GIT_STDERR_LIMIT) {
        stderr += chunk.toString('utf8');
        if (stderr.length > GIT_STDERR_LIMIT) {
          stderr = stderr.slice(0, GIT_STDERR_LIMIT);
        }
      }
    });
    child.stdin?.on('error', () => {
      if (settled || failure === 'timeout') {
        return;
      }
      failure = 'spawn';
      child.kill('SIGKILL');
    });
    child.on('error', () => {
      failure = 'spawn';
      finish(false);
    });
    child.on('close', (exitCode, signal) => {
      if (failure === 'timeout' || failure === 'spawn') {
        finish(false);
        return;
      }
      if (exitCode === 0 && !signal) {
        finish(true);
        return;
      }
      failure = signal ? 'signal' : 'exit';
      finish(false);
    });
    child.stdin?.end(stdin);
  });
}

/**
 * Returns the Git subprocess budget.
 *
 * Tests may shorten it with `OPENKIT_WORKER_GIT_TIMEOUT_MS`. Production ignores that variable.
 *
 * @returns Timeout in milliseconds.
 */
function gitTimeoutMs(): number {
  if (process.env.NODE_ENV !== 'test') {
    return GIT_TIMEOUT_MS;
  }
  const override = Number(process.env.OPENKIT_WORKER_GIT_TIMEOUT_MS);
  if (Number.isSafeInteger(override) && override > 0) {
    return override;
  }
  return GIT_TIMEOUT_MS;
}

/**
 * Builds the allowlisted Git subprocess environment and explicit safety controls. A nonempty `SSL_CERT_FILE` is copied to both `GIT_SSL_CAINFO` and `CURL_CA_BUNDLE`. Ambient CA paths do not win.
 *
 * @param sessionDir Worker session directory reserved for snapshot state.
 * @param overrides Command-local Git environment overrides.
 * @returns Scrubbed subprocess environment.
 */
function gitEnvironment(sessionDir: string, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...overrides,
    GIT_ASKPASS: '',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    HOME: sessionDir,
    LC_ALL: 'C',
    PAGER: 'cat',
    SSH_ASKPASS: '',
    XDG_CONFIG_HOME: sessionDir,
  };
  if (process.env.SSL_CERT_FILE) {
    environment.CURL_CA_BUNDLE = process.env.SSL_CERT_FILE;
    environment.GIT_SSL_CAINFO = process.env.SSL_CERT_FILE;
  }

  for (const key of [
    'ALL_PROXY',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TMPDIR',
    'TMP',
    'TEMP',
  ]) {
    if (process.env[key] !== undefined) {
      environment[key] = process.env[key];
    }
  }

  return environment;
}

/**
 * Resolves and validates one Git commit reference.
 *
 * @param cwd Git workspace root.
 * @param sessionDir Worker session directory used for the scrubbed Git environment.
 * @param ref Git commit reference.
 * @param failureMessage Product-safe failure message.
 * @returns Full commit object id.
 */
async function requireGitCommit(
  cwd: string,
  sessionDir: string,
  ref: string,
  failureMessage: string
): Promise<string> {
  const commit = (
    await requireGitText(
      cwd,
      sessionDir,
      ['rev-parse', '--verify', `${ref}^{commit}`],
      {},
      failureMessage
    )
  ).trim();
  if (!GIT_OBJECT_ID_PATTERN.test(commit)) {
    throw new Error(failureMessage);
  }
  return commit;
}
