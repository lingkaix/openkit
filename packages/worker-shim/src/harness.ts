import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  HarnessCommandBodySchemas,
  type HarnessCommandEnvelope,
  HarnessCommandEnvelopeSchema,
  type HarnessRefusalReason,
  type HarnessResultEnvelope,
  type HarnessSessionOpenBody,
  type HarnessSessionSelectorBody,
  type HarnessTurnInterruptBody,
  type HarnessTurnStartBody,
  isProtectedNativeEnvironmentName,
  type WorkerStartupFailure,
  WorkerStartupFailureSchema,
  workerSessionInputPaths,
} from '@openkit/worker-protocol';
import {
  WORKER_ADAPTERS,
  type WorkerNativeHandle,
  type WorkerResidentAdapter,
  type WorkerResidentSession,
} from './adapter-registry.js';
import { isRetryableHttpStatus } from './control-client.js';
import {
  openSandboxIntegration,
  SANDBOX_NATIVE_CAPABILITY_BASE_URL,
  SANDBOX_NATIVE_INFERENCE_BASE_URL,
  type SandboxIntegrationClient,
} from './integration-client.js';
import {
  describeWorkerStartupFailure,
  initializeSessionWorkspace,
  isNativeSettlementUnknown,
  runResidentTurn,
  type WorkerShimEnvironment,
} from './turn.js';

const HARNESS_POLL_PATH = '/worker-control/harness/poll';
const HARNESS_RESULT_PATH = '/worker-control/harness/result';
const HARNESS_POLL_MINIMUM_MS = 250;
const HARNESS_REQUEST_TIMEOUT_MS = 1_000;
const HARNESS_OUTAGE_BUDGET_MS = 300_000;
/** Open AgentSessions one Harness serves; active Turns stay at one per Harness. */
const HARNESS_MAX_OPEN_SESSIONS = 8;
/** Canonical AgentSession identity, which also names its input and reference slots. */
const AGENT_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Fixed non-retained scratch root granted by the compiled Worker policy. */
const NATIVE_SCRATCH_ROOT = '/tmp/openkit-bootstrap';
/** Image environment a resident host inherits from the Harness. */
const SAFE_RESIDENT_ENVIRONMENT_KEYS = [
  'ALL_PROXY',
  'COLORTERM',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'NODE_USE_ENV_PROXY',
  'NO_COLOR',
  'NO_PROXY',
  'PATH',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TERM',
  'USER',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;
interface ActiveTurn {
  readonly abort: AbortController;
  barrierReached: boolean;
  readonly leaseId: string;
  readonly promise: Promise<void>;
  readonly turnId: string;
}

interface HarnessSession {
  /**
   * The Turn that occupies this binding. A Turn whose native settlement is unknown keeps it,
   * so the binding and its Harness hold their capacity until wider cleanup proves safety.
   */
  activeTurn: ActiveTurn | null;
  readonly agentSessionId: string;
  readonly bindingId: string;
  cleanupState: 'clean' | 'pending' | 'unknown';
  closing: boolean;
  readonly credentialValues: readonly string[];
  /**
   * Whether the binding may take another Turn: its handle was ready at open, whether resumed or
   * created by the runtime, or one of its Turns completed. A binding whose handle was pending at
   * open and whose first Turn did not complete only closes.
   */
  established: boolean;
  /**
   * Digest the resumed conversation must prove: the carried resume digest, or null for a new
   * conversation. A resumed binding never stores or accepts a different ready reference.
   */
  readonly expectedHandleDigest: string | null;
  /**
   * Set when the resident host ended on its own, or when native settlement or native close could
   * not be proved; the binding then takes no Turn.
   */
  failed: boolean;
  /** Digest of the reference stored under this AgentSession id, once one is ready. */
  handleDigest: string | null;
  readonly resident: WorkerResidentSession;
  readonly runtimeEnvironmentNames: ReadonlySet<string>;
  readonly nativeEnvironment: Readonly<Record<string, string>> | null;
  readonly sessionDirectory: string;
  readonly threadId: string;
  turnsStarted: number;
  readonly workspaceId: string;
}

/**
 * Current resident binding of every Thread served by this shim process, keyed by Sandbox root and
 * Thread, so a second current binding for one Thread is rejected across Harness instances.
 */
const LIVE_THREAD_BINDINGS = new Map<string, string>();

/** Options for one Harness instance. */
export interface WorkerHarnessOptions {
  /** Resident adapter registry; tests inject deterministic runtimes. */
  readonly adapters?: Readonly<Record<string, WorkerResidentAdapter>> | undefined;
  /** Image environment the resident hosts inherit through the safe allowlist. */
  readonly environment?: WorkerShimEnvironment | undefined;
  /** Harness-lifetime Sandbox Integration client. */
  readonly integration: SandboxIntegrationClient;
  /** Retained native-data root inside the `/sandbox` volume. */
  readonly nativeDataRootDirectory?: string | undefined;
  /** Private writable root for disposable AgentSession control and Turn-private outputs. */
  readonly rootDirectory?: string | undefined;
  /** Sandbox root containing owner-materialized AEP and Context references. */
  readonly sandboxRoot?: string | undefined;
  /** Fixed Turn output root exported through the existing file-effect slots. */
  readonly turnOutputDirectory?: string | undefined;
}

/**
 * One Harness instance: executes the six private operations for the resident AgentSession
 * bindings of one adapter. The adapter is fixed by the first `session.open`, which names it.
 */
export class WorkerHarness {
  private adapterId: string | null = null;
  private readonly adapters: Readonly<Record<string, WorkerResidentAdapter>>;
  private draining = false;
  private readonly environment: WorkerShimEnvironment;
  /**
   * Resident hosts of refused opens whose native close failed. They may still be live, so they
   * keep their Thread reservation, count as open, and keep this Harness draining.
   */
  private unprovedResidents = 0;
  private readonly integration: SandboxIntegrationClient;
  private readonly nativeDataRootDirectory: string;
  private readonly rootDirectory: string;
  private readonly sandboxRoot: string;
  private readonly sessions = new Map<string, HarnessSession>();
  private readonly turnOutputDirectory: string;

  /** Creates one Harness with an empty AgentSession registry. */
  public constructor(options: WorkerHarnessOptions) {
    this.adapters = options.adapters ?? WORKER_ADAPTERS;
    this.environment = options.environment ?? process.env;
    this.integration = options.integration;
    this.nativeDataRootDirectory = resolve(
      options.nativeDataRootDirectory ?? '/sandbox/openkit/native'
    );
    this.rootDirectory = resolve(options.rootDirectory ?? '/openkit/harness/agent-sessions');
    this.sandboxRoot = resolve(options.sandboxRoot ?? '/openkit');
    this.turnOutputDirectory = resolve(options.turnOutputDirectory ?? '/openkit/session');
  }

  /**
   * Executes one sequenced command and returns its exact result envelope.
   *
   * @param command Parsed command envelope.
   * @returns A succeeded or refused result; a refusal carries only its reason, plus closed
   *   startup-failure metadata for a dependency-failed `turn.start`.
   */
  public async handle(command: HarnessCommandEnvelope): Promise<HarnessResultEnvelope> {
    try {
      const body = parseBody(command.operation, command.body);
      let resultBody: Readonly<Record<string, unknown>>;
      switch (command.operation) {
        case 'session.open':
          resultBody = await this.openSession(body as HarnessSessionOpenBody);
          break;
        case 'session.inspect':
          resultBody = await this.inspectSession(body as HarnessSessionSelectorBody);
          break;
        case 'turn.start':
          resultBody = await this.startTurn(body as HarnessTurnStartBody);
          break;
        case 'turn.interrupt':
          resultBody = await this.interruptTurn(body as HarnessTurnInterruptBody);
          break;
        case 'session.close':
          resultBody = await this.closeSession(body as HarnessSessionSelectorBody);
          break;
        case 'harness.drain':
          this.draining = true;
          resultBody = {
            activeTurns: this.activeTurnCount(),
            openSessions: this.sessions.size + this.unprovedResidents,
            state: 'draining',
          };
          break;
      }
      return result(command, 'succeeded', resultBody);
    } catch (error) {
      const startupFailure =
        (command.operation === 'turn.start' || command.operation === 'session.open') &&
        error &&
        typeof error === 'object' &&
        'startupFailure' in error
          ? WorkerStartupFailureSchema.safeParse(error.startupFailure).data
          : undefined;
      return result(command, 'refused', {
        reasonCode: reasonCode(error),
        ...(startupFailure ? { startupFailure } : {}),
      });
    }
  }

  /** Opens one resident binding, new or by resume, and registers its loopback credentials. */
  private async openSession(body: HarnessSessionOpenBody) {
    if (this.draining || this.sessions.size >= HARNESS_MAX_OPEN_SESSIONS) {
      throw harnessError('busy');
    }
    const adapter = this.adapters[body.adapterId];
    if (
      !adapter ||
      (this.adapterId !== null && this.adapterId !== body.adapterId) ||
      !AGENT_SESSION_ID_PATTERN.test(body.agentSessionId)
    ) {
      throw harnessError('unsupported');
    }
    const threadKey = `${this.sandboxRoot}\0${body.threadId}`;
    if (
      this.sessions.has(body.agentSessionRuntimeBindingId) ||
      [...this.sessions.values()].some(
        (session) => session.agentSessionId === body.agentSessionId
      ) ||
      LIVE_THREAD_BINDINGS.has(threadKey)
    ) {
      throw harnessError('conflict');
    }
    const runtimeEnvironment = body.runtimeEnvironment ?? {};
    const nativeEnvironment = body.nativeEnvironment ? { ...body.nativeEnvironment } : null;
    if (
      Object.keys(runtimeEnvironment).some((name) =>
        isProtectedNativeEnvironmentName(name, body.adapterId)
      ) ||
      Object.keys(nativeEnvironment ?? {}).some(
        (name) =>
          isProtectedNativeEnvironmentName(name, body.adapterId) ||
          Object.hasOwn(runtimeEnvironment, name)
      )
    ) {
      throw harnessError('unsupported');
    }
    const resumeReference = body.resume ? await this.readResumeReference(body.resume) : null;

    this.adapterId = body.adapterId;
    LIVE_THREAD_BINDINGS.set(threadKey, body.agentSessionRuntimeBindingId);
    const sessionDirectory = resolve(
      this.rootDirectory,
      createHash('sha256').update(body.agentSessionRuntimeBindingId).digest('hex')
    );
    let loopbackRegistered = false;
    let resident: WorkerResidentSession | null = null;
    try {
      try {
        this.integration.registerSessionLoopback(body.agentSessionId, {
          capabilityCredential: body.capabilityLoopbackCredential,
          inferenceCredential: body.inferenceLoopbackCredential,
        });
        loopbackRegistered = true;
      } catch {
        throw harnessError('conflict');
      }
      const controlRoot = resolve(sessionDirectory, 'native-control');
      const stateRoot = resolve(
        this.nativeDataRootDirectory,
        body.adapterId,
        'threads',
        createHash('sha256').update(body.threadId).digest('hex')
      );
      const inputPaths = workerSessionInputPaths(body.agentSessionId);
      await rm(sessionDirectory, { force: true, recursive: true });
      await mkdir(controlRoot, { mode: 0o700, recursive: true });
      await mkdir(stateRoot, { mode: 0o700, recursive: true });
      await mkdir(dirname(this.mapSandboxPath(inputPaths.packagePath)), {
        mode: 0o700,
        recursive: true,
      });
      await mkdir(this.mapSandboxPath(inputPaths.contextRoot), { mode: 0o700, recursive: true });
      try {
        await initializeSessionWorkspace(
          this.mapSandboxPath(inputPaths.packagePath),
          sessionDirectory,
          body
        );
      } catch (error) {
        throw Object.assign(harnessError('dependency_failed'), {
          startupFailure: describeWorkerStartupFailure('workspace_materialization', error),
        });
      }
      // The adapter contract owns the no-live-effect guarantee. A resident that still exists when
      // close fails keeps the Thread reserved and drains this Harness.
      resident = await adapter
        .openSession({
          agentSessionId: body.agentSessionId,
          controlRoot,
          environment: residentEnvironment(
            this.environment,
            runtimeEnvironment,
            nativeEnvironment,
            body.adapterId
          ),
          loopback: {
            capabilityBaseUrl: SANDBOX_NATIVE_CAPABILITY_BASE_URL,
            capabilityCredential: body.capabilityLoopbackCredential,
            inferenceBaseUrl: SANDBOX_NATIVE_INFERENCE_BASE_URL,
            inferenceCredential: body.inferenceLoopbackCredential,
          },
          resumeReference,
          stateRoot,
        })
        .catch(() => {
          throw harnessError('dependency_failed');
        });
      const session: HarnessSession = {
        activeTurn: null,
        agentSessionId: body.agentSessionId,
        bindingId: body.agentSessionRuntimeBindingId,
        cleanupState: 'clean',
        closing: false,
        credentialValues: [
          body.capabilityLoopbackCredential,
          body.inferenceLoopbackCredential,
          ...Object.values(runtimeEnvironment),
        ],
        established: false,
        expectedHandleDigest: body.resume?.digest ?? null,
        failed: false,
        handleDigest: null,
        resident,
        runtimeEnvironmentNames: new Set(Object.keys(runtimeEnvironment)),
        nativeEnvironment,
        sessionDirectory,
        threadId: body.threadId,
        turnsStarted: 0,
        workspaceId: body.workspaceId,
      };
      const handle = await this.proveHandle(session).catch(() => {
        throw harnessError('dependency_failed');
      });
      if (
        handle.nativeHandleState === 'unknown' ||
        (resumeReference && handle.nativeHandleState !== 'ready')
      ) {
        // A resumed conversation must prove the exact carried reference before any work.
        throw harnessError(resumeReference ? 'conflict' : 'dependency_failed');
      }
      session.established = handle.nativeHandleState === 'ready';
      this.sessions.set(session.bindingId, session);
      // The Turn runner fails an active Turn itself when the host ends; the binding only closes.
      const onExit = () => {
        if (!session.closing) session.failed = true;
      };
      void resident.exited.then(onExit, onExit);
      return {
        maxActiveTurns: 1,
        nativeHandleDigest: handle.nativeHandleDigest,
        nativeHandleState: handle.nativeHandleState,
        state: 'open',
      };
    } catch (error) {
      if (loopbackRegistered) this.integration.destroySessionLoopback(body.agentSessionId);
      let refusal = error;
      if (
        resident &&
        !(await resident.close().then(
          () => true,
          () => false
        ))
      ) {
        // The refused host may still be live: keep its Thread reserved and fence this Harness.
        this.unprovedResidents += 1;
        this.draining = true;
        refusal = harnessError('cleanup_required');
      } else {
        LIVE_THREAD_BINDINGS.delete(threadKey);
      }
      await rm(sessionDirectory, { force: true, recursive: true }).catch(() => undefined);
      throw refusal;
    }
  }

  /** Inspects one binding's native handle, host liveness, and cleanup without starting work. */
  private async inspectSession(body: HarnessSessionSelectorBody) {
    const session = this.requireSession(body);
    if (session.activeTurn?.barrierReached) {
      await session.activeTurn.promise;
    }
    const handle = await this.proveHandle(session).catch(() => ({
      nativeHandleDigest: null,
      nativeHandleState: 'unknown' as const,
    }));
    return {
      childState: session.resident.childState(),
      cleanupState: session.cleanupState,
      ...handle,
      state: session.failed
        ? 'failed'
        : session.closing
          ? 'closing'
          : session.activeTurn || session.cleanupState === 'pending'
            ? 'active'
            : 'open',
    };
  }

  /** Starts one Turn on the resident binding and answers once the runtime accepted it. */
  private async startTurn(body: HarnessTurnStartBody) {
    const session = this.requireSession(body);
    if (session.failed || session.closing || (session.turnsStarted > 0 && !session.established)) {
      // A binding whose first Turn did not complete, whose host ended, whose native settlement is
      // unknown, or that is closing takes no Turn.
      throw harnessError('conflict');
    }
    if (
      this.draining ||
      session.activeTurn ||
      session.cleanupState !== 'clean' ||
      this.activeTurnCount() >= 1
    ) {
      throw harnessError('busy');
    }
    const inputPaths = workerSessionInputPaths(session.agentSessionId);
    const packagePath = this.mapSandboxPath(inputPaths.packagePath);
    if (
      body.workspaceId !== session.workspaceId ||
      body.threadId !== session.threadId ||
      body.contextPackageId !== `ctxpkg_${body.turnId}` ||
      body.contextRef !== this.mapSandboxPath(inputPaths.contextRoot) ||
      body.aepRef !== packagePath
    ) {
      throw harnessError('stale');
    }
    session.turnsStarted += 1;
    const abort = new AbortController();
    const turnDirectory = resolve(
      session.sessionDirectory,
      'turns',
      createHash('sha256').update(body.turnId).digest('hex')
    );
    await rm(this.turnOutputDirectory, { force: true, recursive: true });
    await mkdir(this.turnOutputDirectory, { mode: 0o700, recursive: true });
    await mkdir(turnDirectory, { mode: 0o700, recursive: true });
    let markStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    let startupFailure: WorkerStartupFailure | undefined;
    const run = runResidentTurn({
      adapterId: this.adapterId as string,
      credentialValues: session.credentialValues,
      environment: this.environment,
      integration: this.integration,
      lineage: {
        agentSessionId: session.agentSessionId,
        packageSnapshotId: body.packageSnapshotId,
        threadId: session.threadId,
        turnId: body.turnId,
        workspaceId: session.workspaceId,
      },
      onStarted: markStarted,
      onStartupFailure: (failure) => {
        startupFailure = failure;
      },
      onTurnBarrier: () => {
        if (session.activeTurn?.turnId === body.turnId) {
          session.activeTurn.barrierReached = true;
          session.cleanupState = 'pending';
        }
      },
      packagePath,
      resident: session.resident,
      runtimeEnvironmentNames: session.runtimeEnvironmentNames,
      nativeEnvironment: session.nativeEnvironment,
      sessionDir: this.turnOutputDirectory,
      signal: abort.signal,
      tokens: {
        capabilityToken: body.capabilityToken,
        controlToken: body.workerControlToken,
        inferenceToken: body.inferenceToken,
      },
      turnDirectory,
    });
    const promise = run.then(
      async (turn) => {
        if (turn.status === 'completed') session.established = true;
        await this.cleanTurnInputs(session);
      },
      async (error: unknown) => {
        if (isNativeSettlementUnknown(error)) {
          // Native work may still be live. Fence before any await so disposable cleanup cannot
          // overwrite unknown state or drop the Turn.
          this.fenceSession(session);
        } else {
          await this.cleanTurnInputs(session);
        }
        throw error;
      }
    );
    const settled = promise
      .catch(() => undefined)
      .finally(() => {
        // Capacity returns only after native settlement and local input cleanup are proved.
        if (session.cleanupState === 'clean' && session.activeTurn?.turnId === body.turnId) {
          session.activeTurn = null;
        }
      });
    session.activeTurn = {
      abort,
      barrierReached: false,
      leaseId: body.leaseId,
      promise: settled,
      turnId: body.turnId,
    };
    await Promise.race([
      started,
      promise.then(
        () => {
          throw harnessError('dependency_failed');
        },
        (error: unknown) => {
          throw Object.assign(harnessError('dependency_failed'), { cause: error, startupFailure });
        }
      ),
    ]);
    return {
      nativeHandleDigest: session.handleDigest,
      nativeHandleState: session.handleDigest ? ('ready' as const) : ('pending' as const),
      state: 'started',
    };
  }

  /** Interrupts only the exact active Turn and answers after it settled. */
  private async interruptTurn(body: HarnessTurnInterruptBody) {
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
    await active.promise;
    if (session.cleanupState === 'unknown') {
      // Cancellation was not proved: the Turn keeps its slot until wider cleanup.
      throw harnessError('cleanup_required');
    }
    return { childState: session.resident.childState(), state: 'interrupted' };
  }

  /** Closes one idle binding: revokes the native binding, loopback, and disposable control. */
  private async closeSession(body: HarnessSessionSelectorBody) {
    const session = this.requireSession(body);
    if (session.activeTurn) {
      throw harnessError(session.cleanupState === 'unknown' ? 'cleanup_required' : 'busy');
    }
    session.closing = true;
    try {
      await session.resident.close();
    } catch {
      // The host may still hold the conversation: revoke its routes and fence the Harness.
      this.integration.destroySessionLoopback(session.agentSessionId);
      this.fenceSession(session);
      throw harnessError('cleanup_required');
    }
    this.integration.destroySessionLoopback(session.agentSessionId);
    await rm(this.mapSandboxPath(workerSessionInputPaths(session.agentSessionId).root), {
      force: true,
      recursive: true,
    });
    await rm(session.sessionDirectory, { force: true, recursive: true });
    LIVE_THREAD_BINDINGS.delete(`${this.sandboxRoot}\0${session.threadId}`);
    this.sessions.delete(session.bindingId);
    return { childState: session.resident.childState(), privateState: 'absent', state: 'closed' };
  }

  /**
   * Proves the adapter's handle and projects it. The first ready reference is stored under the
   * AgentSession id; the adapter decides when its conversation carries that authority. A resumed
   * binding stores only the exact carried reference. A different reference is reported as unknown
   * and never replaces the stored one.
   */
  private async proveHandle(session: HarnessSession): Promise<{
    readonly nativeHandleDigest: string | null;
    readonly nativeHandleState: 'pending' | 'ready' | 'unknown';
  }> {
    const handle: WorkerNativeHandle = await session.resident.nativeHandle();
    if (handle.state !== 'ready') {
      return {
        nativeHandleDigest: null,
        nativeHandleState:
          handle.state === 'pending' && !session.handleDigest ? 'pending' : 'unknown',
      };
    }
    const digest = createHash('sha256').update(handle.reference).digest('hex');
    if (
      session.handleDigest === null &&
      (session.expectedHandleDigest === null || digest === session.expectedHandleDigest)
    ) {
      await this.storeReference(session.agentSessionId, handle.reference);
      session.handleDigest = digest;
    }
    return session.handleDigest === digest
      ? { nativeHandleDigest: digest, nativeHandleState: 'ready' }
      : { nativeHandleDigest: null, nativeHandleState: 'unknown' };
  }

  /**
   * Reads the predecessor reference named by a resume locator and requires its digest.
   *
   * @throws A `missing` refusal when no reference is stored, `conflict` when its digest differs.
   */
  private async readResumeReference(resume: { digest: string; locator: string }) {
    if (!AGENT_SESSION_ID_PATTERN.test(resume.locator)) {
      throw harnessError('missing');
    }
    let reference: Buffer;
    try {
      reference = await readFile(this.referencePath(resume.locator));
    } catch {
      throw harnessError('missing');
    }
    if (createHash('sha256').update(reference).digest('hex') !== resume.digest) {
      throw harnessError('conflict');
    }
    return new Uint8Array(reference);
  }

  /** Stores one ready reference under its AgentSession id, atomically and privately. */
  private async storeReference(agentSessionId: string, reference: Uint8Array): Promise<void> {
    const path = this.referencePath(agentSessionId);
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    const staging = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(staging, reference, { mode: 0o600 });
    await rename(staging, path);
  }

  /** Retained reference slot of one AgentSession, outside the disposable control root. */
  private referencePath(agentSessionId: string): string {
    return join(this.nativeDataRootDirectory, 'agent-session-references', agentSessionId);
  }

  /**
   * Fences one binding whose native settlement, native close, or local input cleanup could not be proved: it takes no
   * Turn, reports unknown cleanup, and the whole Harness drains so the NanoHost owner widens the
   * fence. Disposable cleanup never overwrites this state.
   */
  private fenceSession(session: HarnessSession): void {
    session.failed = true;
    session.cleanupState = 'unknown';
    this.draining = true;
  }

  /** Removes disposable Turn input slots; unproved removal fences admission and retains occupancy. */
  private async cleanTurnInputs(session: HarnessSession): Promise<void> {
    session.cleanupState = 'pending';
    try {
      const inputRoot = this.mapSandboxPath(workerSessionInputPaths(session.agentSessionId).root);
      await Promise.all(
        ['config', 'context', 'supply'].map((slot) =>
          rm(resolve(inputRoot, slot), { force: true, recursive: true })
        )
      );
      session.cleanupState = 'clean';
    } catch {
      this.fenceSession(session);
    }
  }

  /** Reads one exact binding and rejects a sibling identity. */
  private requireSession(body: {
    agentSessionId: string;
    agentSessionRuntimeBindingId: string;
  }): HarnessSession {
    const session = this.sessions.get(body.agentSessionRuntimeBindingId);
    if (!session) {
      throw harnessError('missing');
    }
    if (session.agentSessionId !== body.agentSessionId) {
      throw harnessError('conflict');
    }
    return session;
  }

  /** Counts active Turns of this Harness. */
  private activeTurnCount(): number {
    return [...this.sessions.values()].filter((session) => session.activeTurn).length;
  }

  /** Maps a canonical `/openkit` path into the test-injectable Sandbox root. */
  private mapSandboxPath(path: string): string {
    return resolve(this.sandboxRoot, relative('/openkit', path));
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
  const harnesses = new Map<string, { readonly harness: WorkerHarness; nextSequence: number }>();
  try {
    process.stdout.write('OPENKIT_WORKER_SHIM_ENTRY_V1\n');
    await integration.ready;
    while (!options.signal?.aborted) {
      const pollStartedAt = performance.now();
      const response = await requestWithOutageBudget(
        integration,
        HARNESS_POLL_PATH,
        JSON.stringify({ schemaVersion: 2 }),
        options.signal
      );
      if (response.status === 204) {
        // A timer may fire early against the monotonic clock, so wait until the minimum elapsed.
        for (;;) {
          const remaining = HARNESS_POLL_MINIMUM_MS - (performance.now() - pollStartedAt);
          if (remaining <= 0) break;
          await delay(Math.ceil(remaining), undefined, { signal: options.signal });
        }
        continue;
      }
      if (response.status !== 200) {
        throw new Error(`Harness poll failed with HTTP ${response.status}.`);
      }
      const command = HarnessCommandEnvelopeSchema.parse(JSON.parse(await response.text()));
      let owner = harnesses.get(command.harnessInstanceId);
      if (!owner) {
        owner = {
          harness: new WorkerHarness({ environment: options.environment, integration }),
          nextSequence: 0,
        };
        harnesses.set(command.harnessInstanceId, owner);
      }
      if (owner.nextSequence !== command.sequence) {
        throw new Error('Harness command selected a stale or future sequence.');
      }
      const settled = await owner.harness.handle(command);
      const resultResponse = await requestWithOutageBudget(
        integration,
        HARNESS_RESULT_PATH,
        JSON.stringify(settled),
        options.signal
      );
      if (resultResponse.status !== 204 || (await resultResponse.text()) !== '') {
        throw new Error('Harness result was not accepted with an empty 204.');
      }
      owner.nextSequence += 1;
    }
  } finally {
    await integration.close();
  }
}

/**
 * Sends one immutable private request and retries exactly that request, on a transport failure or
 * a retryable HTTP status, under the bounded monotonic outage budget. Any other status returns to
 * the caller, which treats it as terminal; a result is resent byte for byte, never re-executed.
 */
async function requestWithOutageBudget(
  integration: SandboxIntegrationClient,
  path: string,
  body: string,
  signal: AbortSignal | undefined
) {
  const outageStartedAt = performance.now();
  for (;;) {
    const timeout = AbortSignal.timeout(HARNESS_REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let failure: unknown;
    try {
      const response = await integration.harnessControlFetch(path, {
        body,
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: requestSignal,
      });
      if (!isRetryableHttpStatus(response.status)) {
        return response;
      }
      failure = new Error(`Harness request failed with retryable HTTP ${response.status}.`);
    } catch (error) {
      signal?.throwIfAborted();
      failure = error;
    }
    if (performance.now() - outageStartedAt >= HARNESS_OUTAGE_BUDGET_MS) {
      throw failure;
    }
    await delay(HARNESS_POLL_MINIMUM_MS, undefined, { signal });
  }
}

/**
 * Validates one operation body against its closed schema before any effect.
 *
 * @throws An `unsupported` refusal for a missing, extra, unknown, or malformed field.
 */
function parseBody(operation: HarnessCommandEnvelope['operation'], body: unknown): unknown {
  const parsed = HarnessCommandBodySchemas[operation].safeParse(body);
  if (!parsed.success) {
    throw harnessError('unsupported');
  }
  return parsed.data;
}

/**
 * Builds the environment of one resident host: the image allowlist, the fixed scratch root, the
 * Node trust and header settings the image provides, loopback excluded from any proxy, and the
 * session-static runtime environment. No route token or loopback credential is placed in it.
 */
function residentEnvironment(
  environment: WorkerShimEnvironment,
  runtimeEnvironment: Readonly<Record<string, string>>,
  nativeEnvironment: Readonly<Record<string, string>> | null,
  adapterId: string
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of SAFE_RESIDENT_ENVIRONMENT_KEYS) {
    if (nativeEnvironment !== null && !isProtectedNativeEnvironmentName(key, adapterId)) continue;
    const value = environment[key];
    if (typeof value === 'string' && value.length > 0) selected[key] = value;
  }
  selected.TEMP = NATIVE_SCRATCH_ROOT;
  selected.TMP = NATIVE_SCRATCH_ROOT;
  selected.TMPDIR = NATIVE_SCRATCH_ROOT;
  if (selected.SSL_CERT_FILE) selected.NODE_EXTRA_CA_CERTS = selected.SSL_CERT_FILE;
  const bundledNodeRoot = dirname(dirname(process.execPath));
  if (existsSync(join(bundledNodeRoot, 'include', 'node', 'node.h'))) {
    selected.NPM_CONFIG_NODEDIR = bundledNodeRoot;
    selected.npm_config_nodedir = bundledNodeRoot;
  }
  for (const key of ['NO_PROXY', 'no_proxy'] as const) {
    const entries = (selected[key] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!entries.includes('127.0.0.1')) entries.push('127.0.0.1');
    selected[key] = entries.join(',');
  }
  return { ...nativeEnvironment, ...selected, ...runtimeEnvironment };
}

/** Builds one exact result envelope. */
function result(
  command: HarnessCommandEnvelope,
  disposition: 'succeeded' | 'refused',
  body: Readonly<Record<string, unknown>>
): HarnessResultEnvelope {
  return {
    body,
    disposition,
    harnessInstanceId: command.harnessInstanceId,
    operationId: command.operationId,
    schemaVersion: 2,
    sequence: command.sequence,
  } as HarnessResultEnvelope;
}

/** Creates a private typed refusal error. */
function harnessError(code: HarnessRefusalReason): Error {
  return Object.assign(new Error(`Harness operation refused: ${code}`), {
    harnessReasonCode: code,
  });
}

/** Projects only the fixed refusal vocabulary; any other failure is a dependency failure. */
function reasonCode(error: unknown): HarnessRefusalReason {
  if (error && typeof error === 'object' && 'harnessReasonCode' in error) {
    return error.harnessReasonCode as HarnessRefusalReason;
  }
  return 'dependency_failed';
}
