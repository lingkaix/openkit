import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { codexAdapter } from './adapters/codex.js';
import {
  runWorkerShim,
  type WorkerProcessRunner,
  type WorkerShimEnvironment,
  type WorkerShimRunResult,
} from './cli.js';
import { openSandboxIntegration, type SandboxIntegrationClient } from './integration-client.js';

const HARNESS_POLL_PATH = '/worker-control/harness/poll';
const HARNESS_RESULT_PATH = '/worker-control/harness/result';
const HARNESS_POLL_MINIMUM_MS = 250;
const HARNESS_REQUEST_TIMEOUT_MS = 1_000;
const HARNESS_OUTAGE_BUDGET_MS = 300_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

type HarnessOperation =
  | 'session.open'
  | 'session.inspect'
  | 'turn.start'
  | 'turn.interrupt'
  | 'session.close'
  | 'harness.drain';

interface HarnessCommand {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly sequence: number;
  readonly operation: string;
  readonly body: Readonly<Record<string, unknown>>;
}

interface HarnessResult {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly sequence: number;
  readonly disposition: 'succeeded' | 'refused' | 'unknown';
  readonly body: Readonly<Record<string, unknown>>;
}

interface ActiveTurn {
  readonly abort: AbortController;
  barrierReached: boolean;
  readonly leaseId: string;
  readonly promise: Promise<WorkerShimRunResult>;
  readonly turnId: string;
}

interface HarnessSession {
  activeTurn: ActiveTurn | null;
  readonly agentSessionId: string;
  readonly bindingId: string;
  readonly compatibilityKey: string;
  readonly sessionDirectory: string;
  readonly stateRoot: string;
  readonly threadId: string;
  readonly workspaceId: string;
}

/** Options for the one concrete shared Codex Harness. */
export interface WorkerHarnessOptions {
  /** Harness-lifetime Sandbox Integration client. */
  readonly integration: SandboxIntegrationClient;
  /** Private writable root for AgentSession state and Turn outputs. */
  readonly rootDirectory?: string | undefined;
  /** Fixed Turn output root exported through the existing file-effect slots. */
  readonly turnOutputDirectory?: string | undefined;
  /** Sandbox root containing owner-materialized AEP and Context references. */
  readonly sandboxRoot?: string | undefined;
  /** Safe image environment inherited by supervised Turns. */
  readonly environment?: WorkerShimEnvironment | undefined;
  /** Optional native process runner used by focused tests. */
  readonly runner?: WorkerProcessRunner | undefined;
}

/** One shared multi-AgentSession Codex Harness over the existing supervisor. */
export class WorkerHarness {
  private draining = false;
  private readonly environment: WorkerShimEnvironment;
  private readonly integration: SandboxIntegrationClient;
  private readonly rootDirectory: string;
  private readonly runner: WorkerProcessRunner | undefined;
  private readonly sandboxRoot: string;
  private readonly sessions = new Map<string, HarnessSession>();
  private readonly turnOutputDirectory: string;

  /** Creates the fixed one-Harness implementation without a registry or runtime selector. */
  public constructor(options: WorkerHarnessOptions) {
    this.integration = options.integration;
    this.environment = options.environment ?? process.env;
    this.rootDirectory = resolve(options.rootDirectory ?? '/openkit/harness/agent-sessions');
    this.sandboxRoot = resolve(options.sandboxRoot ?? '/openkit');
    this.runner = options.runner;
    this.turnOutputDirectory = resolve(options.turnOutputDirectory ?? '/openkit/session');
  }

  /** Executes one already sequenced private Harness command. */
  public async handle(command: HarnessCommand): Promise<HarnessResult> {
    requireCommandEnvelope(command);
    try {
      const operation = requireOperation(command.operation);
      const body = command.body;
      let resultBody: Readonly<Record<string, unknown>>;
      switch (operation) {
        case 'session.open':
          resultBody = await this.openSession(body);
          break;
        case 'session.inspect':
          resultBody = await this.inspectSession(body);
          break;
        case 'turn.start':
          resultBody = await this.startTurn(body);
          break;
        case 'turn.interrupt':
          resultBody = await this.interruptTurn(body);
          break;
        case 'session.close':
          resultBody = await this.closeSession(body);
          break;
        case 'harness.drain':
          requireExactFields(body, []);
          this.draining = true;
          resultBody = {
            activeTurns: this.activeTurnCount(),
            openSessions: this.sessions.size,
            state: 'draining',
          };
          break;
      }
      return succeeded(command, resultBody);
    } catch (error) {
      return refused(command, reasonCode(error));
    }
  }

  /** Opens one pending Codex Session in an independently derived private root. */
  private async openSession(body: Readonly<Record<string, unknown>>) {
    requireExactFields(body, [
      'agentSessionId',
      'agentSessionRuntimeBindingId',
      'workspaceId',
      'threadId',
      'adapterId',
      'agentSessionCompatibilityKey',
      'effectiveSetupGeneration',
    ]);
    if (this.draining || this.sessions.size >= 8) {
      throw harnessError('busy');
    }
    const agentSessionId = requireIdentity(body.agentSessionId);
    const bindingId = requireIdentity(body.agentSessionRuntimeBindingId);
    const workspaceId = requireIdentity(body.workspaceId);
    const threadId = requireIdentity(body.threadId);
    const compatibilityKey = requireDigest(body.agentSessionCompatibilityKey);
    if (body.adapterId !== 'codex' || !isPositiveSafeInteger(body.effectiveSetupGeneration)) {
      throw harnessError('unsupported');
    }
    if (this.sessions.has(bindingId)) {
      throw harnessError('conflict');
    }
    const privateName = createHash('sha256').update(bindingId).digest('hex');
    const sessionDirectory = resolve(this.rootDirectory, privateName);
    const stateRoot = resolve(sessionDirectory, 'codex-home');
    await mkdir(sessionDirectory, { mode: 0o700, recursive: true });
    const opened = await codexAdapter.openSession({ stateRoot });
    this.sessions.set(bindingId, {
      activeTurn: null,
      agentSessionId,
      bindingId,
      compatibilityKey,
      sessionDirectory,
      stateRoot,
      threadId,
      workspaceId,
    });
    return {
      maxActiveTurns: 1,
      nativeHandleDigest: opened.nativeHandleDigest,
      nativeHandleState: opened.nativeHandleState,
      state: 'open',
    };
  }

  /** Inspects only the named Session's native proof and supervised child. */
  private async inspectSession(body: Readonly<Record<string, unknown>>) {
    requireExactFields(body, ['agentSessionId', 'agentSessionRuntimeBindingId']);
    const session = this.requireSession(body);
    const inspected = await codexAdapter.inspectSession({ stateRoot: session.stateRoot });
    return {
      childState: session.activeTurn && !session.activeTurn.barrierReached ? 'running' : 'absent',
      cleanupState: 'clean',
      ...inspected,
      state: session.activeTurn && !session.activeTurn.barrierReached ? 'active' : 'open',
    };
  }

  /** Starts one supervised Turn while returning as soon as the child is live. */
  private async startTurn(body: Readonly<Record<string, unknown>>) {
    requireExactFields(body, [
      'agentSessionId',
      'agentSessionRuntimeBindingId',
      'workspaceId',
      'threadId',
      'turnId',
      'packageSnapshotId',
      'aepRef',
      'contextPackageId',
      'contextRef',
      'leaseId',
      'deadline',
      'turnSequence',
      'workerControlToken',
      'inferenceToken',
    ]);
    const session = this.requireSession(body);
    if (this.draining || session.activeTurn || this.activeTurnCount() >= 1) {
      throw harnessError('busy');
    }
    if (
      body.workspaceId !== session.workspaceId ||
      body.threadId !== session.threadId ||
      !isNonnegativeSafeInteger(body.turnSequence)
    ) {
      throw harnessError('stale');
    }
    const turnId = requireIdentity(body.turnId);
    const leaseId = requireIdentity(body.leaseId);
    const packageSnapshotId = requireIdentity(body.packageSnapshotId);
    requireIdentity(body.contextPackageId);
    requireSandboxReference(body.contextRef, this.sandboxRoot);
    const packagePath = requireSandboxReference(body.aepRef, this.sandboxRoot);
    const controlToken = requireToken(body.workerControlToken);
    const inferenceToken = requireToken(body.inferenceToken);
    if (
      controlToken === inferenceToken ||
      Number.isNaN(Date.parse(requireIdentity(body.deadline)))
    ) {
      throw harnessError('stale');
    }
    const prior = await codexAdapter.inspectSession({ stateRoot: session.stateRoot });
    const abort = new AbortController();
    const nativeTurnDirectory = resolve(
      session.sessionDirectory,
      'turns',
      createHash('sha256').update(turnId).digest('hex')
    );
    await rm(this.turnOutputDirectory, { force: true, recursive: true });
    await mkdir(this.turnOutputDirectory, { mode: 0o700, recursive: true });
    await mkdir(nativeTurnDirectory, { mode: 0o700, recursive: true });
    let markStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    const promise = runWorkerShim({
      args: { dryRun: false, packagePath, sessionDir: this.turnOutputDirectory },
      controlToken,
      environment: {
        ...this.environment,
        OPENKIT_AGENT_SESSION_ID: session.agentSessionId,
        OPENKIT_PACKAGE_SNAPSHOT_ID: packageSnapshotId,
        OPENKIT_THREAD_ID: session.threadId,
        OPENKIT_TURN_ID: turnId,
        OPENKIT_WORKER_INFERENCE_TOKEN: inferenceToken,
        OPENKIT_WORKSPACE_ID: session.workspaceId,
      },
      integration: this.integration,
      nativeTurnDirectory,
      onNativeStart: markStarted,
      onTurnBarrier: () => {
        if (session.activeTurn?.turnId === turnId) {
          session.activeTurn.barrierReached = true;
        }
      },
      ...(this.runner ? { runner: this.runner } : {}),
      sessionStateRoot: session.stateRoot,
      signal: abort.signal,
    });
    session.activeTurn = { abort, barrierReached: false, leaseId, promise, turnId };
    void promise
      .finally(() => {
        if (session.activeTurn?.promise === promise) {
          session.activeTurn = null;
        }
      })
      .catch(() => undefined);
    await Promise.race([
      started,
      promise.then(() => {
        throw harnessError('dependency_failed');
      }),
    ]);
    return {
      nativeHandleDigest: prior.nativeHandleDigest,
      nativeHandleState: prior.nativeHandleState,
      state: 'started',
    };
  }

  /** Interrupts only the exact active Turn through the shared supervisor. */
  private async interruptTurn(body: Readonly<Record<string, unknown>>) {
    requireExactFields(body, [
      'agentSessionId',
      'agentSessionRuntimeBindingId',
      'turnId',
      'leaseId',
    ]);
    const session = this.requireSession(body);
    const active = session.activeTurn;
    if (
      !active ||
      active.barrierReached ||
      body.turnId !== active.turnId ||
      body.leaseId !== active.leaseId
    ) {
      throw harnessError('stale');
    }
    active.abort.abort(new Error('Harness turn.interrupt'));
    await active.promise.catch(() => undefined);
    return { childState: 'absent', state: 'interrupted' };
  }

  /** Closes one idle Session without disturbing a sibling binding. */
  private async closeSession(body: Readonly<Record<string, unknown>>) {
    requireExactFields(body, ['agentSessionId', 'agentSessionRuntimeBindingId']);
    const session = this.requireSession(body);
    if (session.activeTurn) {
      throw harnessError('busy');
    }
    const closed = await codexAdapter.closeSession({
      sessionDirectory: session.sessionDirectory,
      stateRoot: session.stateRoot,
    });
    this.sessions.delete(session.bindingId);
    return { childState: 'absent', ...closed, state: 'closed' };
  }

  /** Reads one exact Session binding and rejects sibling or stale identity. */
  private requireSession(body: Readonly<Record<string, unknown>>): HarnessSession {
    const agentSessionId = requireIdentity(body.agentSessionId);
    const bindingId = requireIdentity(body.agentSessionRuntimeBindingId);
    const session = this.sessions.get(bindingId);
    if (!session) {
      throw harnessError('missing');
    }
    if (session.agentSessionId !== agentSessionId) {
      throw harnessError('conflict');
    }
    return session;
  }

  /** Counts active Turns without introducing a second capacity owner. */
  private activeTurnCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.activeTurn) {
        count += 1;
      }
    }
    return count;
  }
}

/** Opens the static Integration client and runs the private pull/result loop. */
export async function runWorkerHarness(
  options: {
    readonly environment?: WorkerShimEnvironment | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {}
): Promise<void> {
  const integration = await openSandboxIntegration(
    options.signal ? { signal: options.signal } : undefined
  );
  const harness = new WorkerHarness({
    environment: options.environment,
    integration,
  });
  let nextExpectedSequence = 0;
  try {
    process.stdout.write('OPENKIT_WORKER_SHIM_ENTRY_V1\n');
    await integration.ready;
    while (!options.signal?.aborted) {
      const pollStartedAt = Date.now();
      const response = await requestWithOutageBudget(
        integration,
        HARNESS_POLL_PATH,
        JSON.stringify({ nextExpectedSequence, schemaVersion: 1 }),
        options.signal
      );
      if (response.status === 204) {
        const remaining = HARNESS_POLL_MINIMUM_MS - (Date.now() - pollStartedAt);
        if (remaining > 0) {
          await delay(remaining, undefined, { signal: options.signal });
        }
        continue;
      }
      if (response.status !== 200) {
        throw new Error(`Harness poll failed with HTTP ${response.status}.`);
      }
      const command = parseHarnessCommand(await response.text(), nextExpectedSequence);
      const result = await harness.handle(command);
      const resultResponse = await requestWithOutageBudget(
        integration,
        HARNESS_RESULT_PATH,
        JSON.stringify(result),
        options.signal
      );
      if (resultResponse.status !== 204 || (await resultResponse.text()) !== '') {
        throw new Error('Harness result was not accepted with an empty 204.');
      }
      nextExpectedSequence += 1;
    }
  } finally {
    await integration.close();
  }
}

/** Retries only one immutable private request under the existing outage budget. */
async function requestWithOutageBudget(
  integration: SandboxIntegrationClient,
  path: string,
  body: string,
  signal: AbortSignal | undefined
) {
  const outageStartedAt = Date.now();
  for (;;) {
    const timeout = AbortSignal.timeout(HARNESS_REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await integration.harnessControlFetch(path, {
        body,
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: requestSignal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (Date.now() - outageStartedAt >= HARNESS_OUTAGE_BUDGET_MS) {
        throw error;
      }
      await delay(HARNESS_POLL_MINIMUM_MS, undefined, { signal });
    }
  }
}

/** Parses one exact current-sequence command from NanoCore. */
function parseHarnessCommand(text: string, nextExpectedSequence: number): HarnessCommand {
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value)) {
    throw new Error('Harness command must be an object.');
  }
  requireExactFields(value, ['schemaVersion', 'operationId', 'sequence', 'operation', 'body']);
  if (
    value.schemaVersion !== 1 ||
    value.sequence !== nextExpectedSequence ||
    !HEX_64_PATTERN.test(String(value.operationId)) ||
    typeof value.operation !== 'string' ||
    !isRecord(value.body)
  ) {
    throw new Error('Harness command envelope is invalid.');
  }
  return value as unknown as HarnessCommand;
}

/** Requires the already parsed envelope identity used by every result. */
function requireCommandEnvelope(command: HarnessCommand): void {
  if (
    command.schemaVersion !== 1 ||
    !HEX_64_PATTERN.test(command.operationId) ||
    !isNonnegativeSafeInteger(command.sequence) ||
    !isRecord(command.body)
  ) {
    throw new Error('Harness command envelope is invalid.');
  }
}

/** Requires one of the six accepted private operation names. */
function requireOperation(value: string): HarnessOperation {
  if (
    ![
      'session.open',
      'session.inspect',
      'turn.start',
      'turn.interrupt',
      'session.close',
      'harness.drain',
    ].includes(value)
  ) {
    throw harnessError('unsupported');
  }
  return value as HarnessOperation;
}

/** Requires a closed object field set before any Harness effect. */
function requireExactFields(body: Readonly<Record<string, unknown>>, expected: readonly string[]) {
  const actual = Object.keys(body).sort();
  const closed = [...expected].sort();
  if (actual.length !== closed.length || actual.some((name, index) => name !== closed[index])) {
    throw harnessError('unsupported');
  }
}

/** Requires one bounded non-control protocol identity. */
function requireIdentity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw harnessError('stale');
  }
  return value;
}

/** Requires one lowercase SHA-256 digest. */
function requireDigest(value: unknown): string {
  const digest = requireIdentity(value);
  if (!HEX_64_PATTERN.test(digest)) {
    throw harnessError('stale');
  }
  return digest;
}

/** Requires one exact dispatch-time route token. */
function requireToken(value: unknown): string {
  const token = requireIdentity(value);
  if (!TOKEN_PATTERN.test(token)) {
    throw harnessError('stale');
  }
  return token;
}

/** Requires one absolute owner-materialized reference beneath the fixed sandbox root. */
function requireSandboxReference(value: unknown, sandboxRoot: string): string {
  const path = requireIdentity(value);
  if (!isAbsolute(path)) {
    throw harnessError('stale');
  }
  const resolved = resolve(path);
  const rel = relative(sandboxRoot, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw harnessError('stale');
  }
  return resolved;
}

/** Builds one successful exact result envelope. */
function succeeded(
  command: HarnessCommand,
  body: Readonly<Record<string, unknown>>
): HarnessResult {
  return {
    body,
    disposition: 'succeeded',
    operationId: command.operationId,
    schemaVersion: 1,
    sequence: command.sequence,
  };
}

/** Builds one typed refusal without exposing adapter diagnostics. */
function refused(command: HarnessCommand, code: string): HarnessResult {
  return {
    body: { reasonCode: code },
    disposition: 'refused',
    operationId: command.operationId,
    schemaVersion: 1,
    sequence: command.sequence,
  };
}

/** Creates a private typed refusal error. */
function harnessError(code: string): Error {
  return Object.assign(new Error(`Harness operation refused: ${code}`), {
    harnessReasonCode: code,
  });
}

/** Projects only the fixed refusal vocabulary. */
function reasonCode(error: unknown): string {
  if (error && typeof error === 'object' && 'harnessReasonCode' in error) {
    return String(error.harnessReasonCode);
  }
  return 'dependency_failed';
}

/** Checks one JSON object boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Checks a nonnegative safe integer. */
function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Checks a positive safe integer. */
function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
