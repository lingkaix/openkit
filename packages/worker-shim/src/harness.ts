import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isEntityId, isRecord } from '@openkit/protocol';
import {
  HARNESS_DEFAULT_MAX_ACTIVE_TURNS,
  HarnessCommandBodySchemas,
  type HarnessCommandEnvelope,
  HarnessCommandEnvelopeReaderSchema,
  HarnessExhaustedBoundSchema,
  type HarnessRefusalReason,
  type HarnessResultEnvelope,
  HarnessResultEnvelopeSchema,
  type HarnessSessionOpenBody,
  HarnessSessionOpenBodySchema,
  type HarnessSessionSelectorBody,
  type HarnessTurnInterruptBody,
  type HarnessTurnStartBody,
  HarnessTurnStartBodySchema,
  type HarnessTurnSteerBody,
  HarnessTurnSteerBodySchema,
  isHarnessResultBodyValid,
  isProtectedNativeEnvironmentName,
  type WorkerStartupFailure,
  WorkerStartupFailureSchema,
  workerSessionInputPaths,
  workerThreadRuntimeRoot,
  workerTurnCapturePaths,
} from '@openkit/worker-protocol';
import {
  WORKER_ADAPTERS,
  type WorkerAdapterResult,
  type WorkerHostManagedLoginAccess,
  type WorkerNativeHandle,
  type WorkerResidentAdapter,
  type WorkerResidentSession,
  type WorkerResidentTurn,
  type WorkerStopDeclaration,
} from './adapter-registry.js';
import { isRetryableHttpStatus } from './control-client.js';
import { credentialHelperDeclarations } from './credential-helper-binding.js';
import {
  openSandboxIntegration,
  SANDBOX_NATIVE_CAPABILITY_BASE_URL,
  SANDBOX_NATIVE_INFERENCE_BASE_URL,
  type SandboxIntegrationClient,
} from './integration-client.js';
import { LIFECYCLE_DEFAULTS, LifecycleDeadline } from './lifecycle-deadline.js';
import { readWorkerReleaseIdentity, type WorkerBuildIdentity } from './release-identity.js';
import {
  describeWorkerStartupFailure,
  initializeSessionWorkspace,
  isNativeSettlementUnknown,
  readWorkerSessionHostManagedLogin,
  runResidentTurn,
  type WorkerShimEnvironment,
} from './turn.js';
import type {
  WorkerShimAbsence,
  WorkerShimDesiredSet,
  WorkerShimDisposition,
  WorkerShimInterrupt,
  WorkerShimInterruptReceipt,
  WorkerShimInventory,
  WorkerShimKeyedWork,
  WorkerShimObservation,
  WorkerShimOperationKey,
  WorkerShimReceipt,
  WorkerShimSession,
  WorkerShimStart,
  WorkerShimTurn,
  WorkerShimTurnInput,
} from './worker-shim-port.js';

const HARNESS_POLL_PATH = '/worker-control/harness/poll';
const HARNESS_RESULT_PATH = '/worker-control/harness/result';
const HARNESS_OUTAGE_BUDGET_MS = 300_000;
/** Minimum resident binding capacity; authored active capacity can require more resident bindings. */
const HARNESS_MAX_OPEN_SESSIONS = 8;
/** Fixed non-retained scratch root granted by the compiled Worker policy. */
const NATIVE_SCRATCH_ROOT = '/tmp/openkit-bootstrap';
/** Image environment a resident host inherits from the Harness. */
const SAFE_RESIDENT_ENVIRONMENT_KEYS = [
  'ALL_PROXY',
  'COLORTERM',
  'CURL_CA_BUNDLE',
  'DENO_CERT',
  'GIT_SSL_CAINFO',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
  'NO_COLOR',
  'NO_PROXY',
  'PATH',
  'REQUESTS_CA_BUNDLE',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TERM',
  'USER',
  'grpc_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;
interface ActiveTurn {
  /** Current upstream authority, retained only while this exact Turn occupies the resident. */
  readonly workerControlToken: string;
  readonly packageSnapshotId: string;
  readonly turnSequence: number;
  nativeTurn?: WorkerResidentTurn;
  readonly abort: AbortController;
  barrierReached: boolean;
  readonly leaseId: string;
  readonly promise: Promise<void>;
  readonly turnId: string;
  readonly shimTurn?: ShimTurnAdmission;
}

/** Exact input owner and the last pre-contact check for a Shim Turn. */
interface ShimTurnAdmission {
  readonly target: WorkerShimTurn;
  readonly beforeNativeInput: (input: string) => void;
  readonly onInputAccepted: () => void;
  readonly finished: () => void;
  contacted: boolean;
  nativeSettled: boolean;
  interrupt?: { signalled: boolean; cancelled: () => void };
}

interface HarnessSession {
  /**
   * The Turn that occupies this binding. A Turn whose native settlement is unknown keeps it,
   * so the binding and its Harness hold their capacity until wider cleanup proves safety.
   */
  activeTurn: ActiveTurn | null;
  readonly agentSessionId: string;
  readonly bindingId: string;
  readonly hostManagedLogin: boolean;
  cleanupState: 'clean' | 'pending' | 'unknown';
  closing: boolean;
  readonly credentialValues: string[];
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
  /** A Shim binding shares this close with startup rollback and desired stop. */
  readonly closeResident: () => Promise<void>;
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

/** Checks the existing access-only callback contract without retaining or publishing private response bytes. */
function readNativeLoginAccess(value: unknown): WorkerHostManagedLoginAccess {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 5 ||
    typeof value.accessToken !== 'string' ||
    !value.accessToken ||
    value.accessToken.includes('\0') ||
    Buffer.byteLength(value.accessToken) > 65_536 ||
    typeof value.accountId !== 'string' ||
    !value.accountId ||
    value.accountId.length > 256 ||
    value.accountId.includes('\0') ||
    value.accountId.includes('\r') ||
    value.accountId.includes('\n') ||
    (value.planType !== null &&
      (typeof value.planType !== 'string' || !value.planType || value.planType.length > 64)) ||
    typeof value.receiptId !== 'string' ||
    !value.receiptId ||
    value.receiptId.length > 512 ||
    typeof value.materialGeneration !== 'number' ||
    !Number.isSafeInteger(value.materialGeneration) ||
    value.materialGeneration < 1
  )
    throw new Error('Native Login returned an invalid access reply.');
  return {
    accessToken: value.accessToken,
    accountId: value.accountId,
    planType: value.planType,
    receiptId: value.receiptId,
    materialGeneration: value.materialGeneration,
  };
}

/** Options for one Harness instance. */
export interface WorkerHarnessOptions {
  /** Resident adapter registry; tests inject deterministic runtimes. */
  readonly adapters?: Readonly<Record<string, WorkerResidentAdapter>> | undefined;
  /** Image environment the resident hosts inherit through the safe allowlist. */
  readonly environment?: WorkerShimEnvironment | undefined;
  /** Harness-lifetime Sandbox Integration client. */
  readonly integration: SandboxIntegrationClient;
  /** Test projection of the retained `/openkit/threads` root. */
  readonly threadRootDirectory?: string | undefined;
  /** Private writable root for disposable AgentSession control and Turn-private outputs. */
  readonly rootDirectory?: string | undefined;
  /** Sandbox root containing owner-materialized AEP and Context references. */
  readonly sandboxRoot?: string | undefined;
}

/** Owns the resident lifecycle and native effects for one adapter's bindings. */
class ResidentRuntime {
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
  private readonly threadRootDirectory: string;
  private maxActiveTurns = HARNESS_DEFAULT_MAX_ACTIVE_TURNS;
  private readonly rootDirectory: string;
  private readonly sandboxRoot: string;
  private readonly sessions = new Map<string, HarnessSession>();

  /** Starts with an empty AgentSession registry. */
  public constructor(options: WorkerHarnessOptions) {
    this.adapters = options.adapters ?? WORKER_ADAPTERS;
    this.environment = options.environment ?? process.env;
    this.integration = options.integration;
    this.threadRootDirectory = resolve(options.threadRootDirectory ?? '/openkit/threads');
    this.rootDirectory = resolve(options.rootDirectory ?? '/openkit/harness/agent-sessions');
    this.sandboxRoot = resolve(options.sandboxRoot ?? '/openkit');
  }

  /** Stops new admissions and reports the remaining resident bindings. */
  public drain() {
    this.draining = true;
    return {
      activeTurns: this.activeTurnCount(),
      openSessions: this.sessions.size + this.unprovedResidents,
      state: 'draining',
    };
  }

  /** Opens one resident binding, new or by resume, and registers its loopback credentials. */
  public async openSession(
    body: HarnessSessionOpenBody,
    admission?: {
      readonly isCurrent: () => boolean;
      readonly handoffChild: (child: WorkerResidentSession) => () => Promise<void>;
    }
  ) {
    if (
      this.adapterId !== null &&
      body.maxActiveTurns !== undefined &&
      body.maxActiveTurns !== this.maxActiveTurns
    )
      throw harnessError('conflict');
    if (this.draining) throw harnessError('busy', 'harness.draining');
    if (
      this.sessions.size + this.unprovedResidents >=
      Math.max(HARNESS_MAX_OPEN_SESSIONS, this.maxActiveTurns)
    )
      throw harnessError('busy', 'harness.openSessions');
    const adapter = this.adapters[body.adapterId];
    if (
      !adapter ||
      (this.adapterId !== null && this.adapterId !== body.adapterId) ||
      !isEntityId('as', body.agentSessionId)
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
    const resumeReference = body.resume
      ? await this.readResumeReference(body.resume, body.threadId, body.adapterId)
      : null;
    if (admission && !admission.isCurrent()) throw harnessError('stale');

    if (this.adapterId === null) this.maxActiveTurns = body.maxActiveTurns ?? this.maxActiveTurns;
    this.adapterId = body.adapterId;
    LIVE_THREAD_BINDINGS.set(threadKey, body.agentSessionRuntimeBindingId);
    const sessionDirectory = resolve(
      this.rootDirectory,
      createHash('sha256').update(body.agentSessionRuntimeBindingId).digest('hex')
    );
    let loopbackRegistered = false;
    let closeResident: (() => Promise<void>) | undefined;
    try {
      try {
        this.integration.registerSessionLoopback(body.agentSessionId, {
          capabilityCredential: body.capabilityLoopbackCredential,
          inferenceCredential: body.inferenceLoopbackCredential,
          ...(adapter.inferenceRuntimeHintMapping
            ? { inferenceRuntimeHintMapping: adapter.inferenceRuntimeHintMapping }
            : {}),
        });
        loopbackRegistered = true;
      } catch {
        throw harnessError('conflict');
      }
      const controlRoot = resolve(sessionDirectory, 'native-control');
      const stateRoot = join(this.runtimeRoot(body.threadId, body.adapterId), 'native');
      const inputPaths = workerSessionInputPaths(body.agentSessionId);
      await rm(sessionDirectory, { force: true, recursive: true });
      await mkdir(controlRoot, { mode: 0o700, recursive: true });
      await mkdir(stateRoot, { mode: 0o700, recursive: true });
      await mkdir(dirname(this.mapSandboxPath(inputPaths.packagePath)), {
        mode: 0o700,
        recursive: true,
      });
      await mkdir(this.mapSandboxPath(inputPaths.contextRoot), { mode: 0o700, recursive: true });
      let workspaceGitBaseline: { commit: string; tree: string } | null;
      try {
        workspaceGitBaseline = await initializeSessionWorkspace(
          this.mapSandboxPath(inputPaths.packagePath),
          sessionDirectory,
          body
        );
      } catch (error) {
        throw Object.assign(harnessError('dependency_failed'), {
          startupFailure: describeWorkerStartupFailure('workspace_materialization', error),
        });
      }
      const hostManagedLogin = await readWorkerSessionHostManagedLogin(
        this.mapSandboxPath(inputPaths.packagePath),
        body
      );
      const credentialAgentPath = await this.integration.openCredentialAgentSocket(
        body.agentSessionId
      );
      const initialPackage: unknown = JSON.parse(
        await readFile(this.mapSandboxPath(inputPaths.packagePath), 'utf8')
      );
      const helperBootstrap =
        credentialHelperDeclarations(
          isRecord(initialPackage) && isRecord(initialPackage.credentials)
            ? initialPackage.credentials.declarations
            : undefined
        ).length > 0;
      if (admission && !admission.isCurrent()) throw harnessError('stale');
      // The adapter contract owns the no-live-effect guarantee. A resident that still exists when
      // close fails keeps the Thread reserved and drains this Harness.
      const resident = await adapter
        .openSession({
          agentSessionId: body.agentSessionId,
          controlRoot,
          environment: {
            ...residentEnvironment(
              this.environment,
              runtimeEnvironment,
              nativeEnvironment,
              body.adapterId
            ),
            ...(helperBootstrap
              ? {
                  OPENKIT_CREDENTIAL_HELPER_URL: new URL(
                    '/worker-control/credential-helper',
                    SANDBOX_NATIVE_CAPABILITY_BASE_URL
                  ).href,
                  OPENKIT_CREDENTIAL_HELPER_TOKEN: body.capabilityLoopbackCredential,
                }
              : {}),
            SSH_AUTH_SOCK: credentialAgentPath,
          },
          loopback: {
            capabilityBaseUrl: SANDBOX_NATIVE_CAPABILITY_BASE_URL,
            capabilityCredential: body.capabilityLoopbackCredential,
            inferenceBaseUrl: SANDBOX_NATIVE_INFERENCE_BASE_URL,
            inferenceCredential: body.inferenceLoopbackCredential,
          },
          ...(hostManagedLogin
            ? {
                hostManagedLogin: {
                  acquire: async (reason, signal) =>
                    readNativeLoginAccess(
                      await this.loginExchange(
                        body.agentSessionRuntimeBindingId,
                        'acquire',
                        { reason },
                        signal
                      )
                    ),
                  complete: async (receipt, signal) => {
                    await this.loginExchange(
                      body.agentSessionRuntimeBindingId,
                      'complete',
                      { ...receipt },
                      signal
                    );
                  },
                  observe: async (value) => {
                    await this.loginExchange(body.agentSessionRuntimeBindingId, 'observe', {
                      ...value,
                    });
                  },
                },
              }
            : {}),
          resumeReference,
          stateRoot,
        })
        .catch((error: unknown) => {
          const refusal = harnessError('dependency_failed');
          if (
            resumeReference &&
            isRecord(error) &&
            (error.retainedSessionWork === 'suspended' || error.retainedSessionWork === 'queued')
          )
            Object.assign(refusal, { retainedSessionWork: error.retainedSessionWork });
          throw refusal;
        });
      closeResident = admission?.handoffChild(resident) ?? (() => resident.close());
      if (admission && !admission.isCurrent()) throw harnessError('stale');
      const session: HarnessSession = {
        activeTurn: null,
        agentSessionId: body.agentSessionId,
        bindingId: body.agentSessionRuntimeBindingId,
        hostManagedLogin,
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
        closeResident,
        runtimeEnvironmentNames: new Set(Object.keys(runtimeEnvironment)),
        nativeEnvironment,
        sessionDirectory,
        threadId: body.threadId,
        turnsStarted: 0,
        workspaceId: body.workspaceId,
      };
      const handle = await this.proveHandle(session, admission?.isCurrent).catch(() => {
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
        ...(workspaceGitBaseline ? { workspaceGitBaseline } : {}),
        maxActiveTurns: this.maxActiveTurns,
        nativeHandleDigest: handle.nativeHandleDigest,
        nativeHandleState: handle.nativeHandleState,
        state: 'open',
      };
    } catch (error) {
      if (loopbackRegistered) this.integration.destroySessionLoopback(body.agentSessionId);
      let refusal = error;
      if (
        closeResident &&
        !(await closeResident().then(
          () => true,
          () => false
        ))
      ) {
        // The refused host may still be live: keep its control material and Thread reservation.
        this.unprovedResidents += 1;
        this.draining = true;
        refusal = harnessError('cleanup_required');
      } else {
        await rm(sessionDirectory, { force: true, recursive: true }).catch(() => undefined);
        LIVE_THREAD_BINDINGS.delete(threadKey);
      }
      throw refusal;
    }
  }

  /** Inspects one binding's native handle, host liveness, and cleanup without starting work. */
  public async inspectSession(body: HarnessSessionSelectorBody) {
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
  public async startTurn(body: HarnessTurnStartBody, admission?: ShimTurnAdmission) {
    const session = this.requireSession(body);
    if (session.failed || session.closing || (session.turnsStarted > 0 && !session.established)) {
      // A binding whose first Turn did not complete, whose host ended, whose native settlement is
      // unknown, or that is closing takes no Turn.
      throw harnessError('conflict');
    }
    if (this.draining) throw harnessError('busy', 'harness.draining');
    if (session.activeTurn || session.cleanupState !== 'clean')
      throw harnessError('busy', 'agentSession.activeTurn');
    if (this.activeTurnCount() >= this.maxActiveTurns)
      throw harnessError('busy', 'harness.activeTurns');
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
    const capturePaths = workerTurnCapturePaths(session.threadId, this.adapterId!, body.turnId);
    const captureDirectory = resolve(
      this.threadRootDirectory,
      relative('/openkit/threads', capturePaths.root)
    );
    let markStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    let startupFailure: WorkerStartupFailure | undefined;
    // Reserve activeTurn in this synchronous entry before preparation can yield to another start.
    const run = (async () => {
      const created = await mkdir(dirname(captureDirectory), { mode: 0o700, recursive: true });
      await mkdir(captureDirectory, { mode: 0o700 });
      // Preserve the new capture name and only its newly created ancestor suffix before exposing source.
      let directory = dirname(captureDirectory);
      const last = created ? dirname(created) : directory;
      for (;;) {
        const handle = await open(directory, 'r');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (directory === last) break;
        directory = dirname(directory);
      }
      await mkdir(turnDirectory, { mode: 0o700, recursive: true });
      return runResidentTurn({
        adapterId: this.adapterId as string,
        credentialValues: session.credentialValues,
        registerCredentialValues: (values) => {
          if (
            session.closing ||
            session.failed ||
            this.sessions.get(session.bindingId) !== session ||
            session.activeTurn?.turnId !== body.turnId ||
            session.activeTurn.barrierReached
          )
            throw harnessError('stale');
          const complete = [...new Set([...session.credentialValues, ...values])];
          // Same 128-value native comparison ceiling, plus the two existing session loopbacks.
          if (
            complete.length > 130 ||
            complete.some(
              (value) => typeof value !== 'string' || Buffer.byteLength(value) > 65_536
            ) ||
            complete.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) >
              128 * 65_536 + 86
          )
            throw harnessError('dependency_failed');
          session.credentialValues.splice(0, session.credentialValues.length, ...complete);
        },
        hostManagedLogin: session.hostManagedLogin,
        environment: this.environment,
        integration: this.integration,
        lineage: {
          agentSessionId: session.agentSessionId,
          packageSnapshotId: body.packageSnapshotId,
          threadId: session.threadId,
          turnId: body.turnId,
          workspaceId: session.workspaceId,
        },
        onStarted: (nativeTurn) => {
          if (session.activeTurn?.turnId === body.turnId)
            session.activeTurn.nativeTurn = nativeTurn;
          markStarted();
        },
        onStartupFailure: (failure) => {
          startupFailure = failure;
        },
        onTurnBarrier: () => {
          if (session.activeTurn?.turnId === body.turnId) {
            session.activeTurn.barrierReached = true;
            session.cleanupState = 'pending';
          }
        },
        ...(admission && {
          beforeNativeInput: (input: string) => {
            admission.beforeNativeInput(input);
            admission.contacted = true;
          },
          onInputAccepted: admission.onInputAccepted,
          onNativeInterrupt: () => {
            if (admission.interrupt) admission.interrupt.signalled = true;
          },
          onNativeSettlement: (result: WorkerAdapterResult | undefined) => {
            admission.nativeSettled = true;
            if (
              admission.interrupt?.signalled &&
              result?.status === 'interrupted' &&
              result.interruptRequested === true
            ) {
              admission.interrupt.cancelled();
            }
          },
        }),
        packagePath,
        resident: session.resident,
        runtimeEnvironmentNames: session.runtimeEnvironmentNames,
        nativeEnvironment: session.nativeEnvironment,
        sessionDir: captureDirectory,
        signal: abort.signal,
        tokens: {
          capabilityToken: body.capabilityToken,
          controlToken: body.workerControlToken,
          inferenceToken: body.inferenceToken,
        },
        turnDirectory,
      });
    })();
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
        // Adapter-owned stops settle or reject the Turn without reporting unexpected host loss.
        if (session.resident.childState() === 'absent') session.failed = true;
        // Capacity returns only after native settlement and local input cleanup are proved.
        if (session.cleanupState === 'clean' && session.activeTurn?.turnId === body.turnId) {
          session.activeTurn = null;
        }
        admission?.finished();
      });
    session.activeTurn = {
      workerControlToken: body.workerControlToken,
      packageSnapshotId: body.packageSnapshotId,
      turnSequence: body.turnSequence,
      abort,
      barrierReached: false,
      leaseId: body.leaseId,
      promise: settled,
      turnId: body.turnId,
      ...(admission ? { shimTurn: admission } : {}),
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

  /** Admits typed user text once through the exact active native work, without a queue or fallback. */
  public async steerTurn(
    body: HarnessTurnSteerBody,
    target?: WorkerShimTurn
  ): Promise<{
    disposition: 'succeeded' | 'refused' | 'unknown';
    body: Readonly<Record<string, unknown>>;
  }> {
    const session = this.requireSession(body);
    const active = session.activeTurn;
    if (
      !active ||
      active.barrierReached ||
      active.abort.signal.aborted ||
      session.failed ||
      session.closing ||
      (target && (!active.shimTurn || !sameShimTurn(active.shimTurn.target, target))) ||
      body.turnId !== active.turnId ||
      body.leaseId !== active.leaseId ||
      body.packageSnapshotId !== active.packageSnapshotId ||
      body.turnSequence !== active.turnSequence ||
      body.workspaceId !== session.workspaceId ||
      body.threadId !== session.threadId
    )
      throw harnessError('stale');
    if (createHash('sha256').update(body.input).digest('hex') !== body.inputDigest)
      throw harnessError('conflict');
    if (!active.nativeTurn?.steer) throw harnessError('unsupported');
    try {
      const outcome = await active.nativeTurn.steer(
        { inputItemId: body.inputItemId, inputDigest: body.inputDigest, input: body.input },
        new LifecycleDeadline(LIFECYCLE_DEFAULTS.nativeRequestMs)
      );
      if (outcome.disposition === 'refused')
        return { disposition: 'refused', body: { reasonCode: outcome.reasonCode } };
      if (
        outcome.disposition === 'accepted' &&
        outcome.inputItemId === body.inputItemId &&
        outcome.inputDigest === body.inputDigest
      )
        return {
          disposition: 'succeeded',
          body: {
            state: 'accepted',
            turnId: body.turnId,
            inputItemId: body.inputItemId,
            inputDigest: body.inputDigest,
          },
        };
    } catch {
      /* A native invocation may have happened; no failure after contact proves refusal. */
    }
    this.fenceSession(session);
    return { disposition: 'unknown', body: { reasonCode: 'outcome_unknown' } };
  }

  /** Interrupts only the exact active Turn and answers after it settled. */
  public async interruptTurn(body: HarnessTurnInterruptBody) {
    const session = this.requireSession(body);
    const active = session.activeTurn;
    if (active && (body.turnId !== active.turnId || body.leaseId !== active.leaseId))
      throw harnessError('conflict');
    if (!active || active.barrierReached) throw harnessError('stale');
    active.abort.abort(new Error('Harness turn.interrupt'));
    await active.promise;
    if (session.cleanupState === 'unknown') {
      // Cancellation was not proved: the Turn keeps its slot until wider cleanup.
      throw harnessError('cleanup_required');
    }
    return { childState: session.resident.childState(), state: 'interrupted' };
  }

  /** Aborts the original entered native attempt. Preparation uses its own pre-contact fence. */
  public interruptShimTurn(
    body: HarnessSessionSelectorBody,
    target: WorkerShimTurn,
    cancelled: () => void
  ): void {
    const active = this.requireSession(body).activeTurn;
    const turn = active?.shimTurn;
    if (
      !active ||
      !turn?.contacted ||
      turn.nativeSettled ||
      !sameShimTurn(turn.target, target) ||
      active.abort.signal.aborted
    )
      return;
    turn.interrupt = { signalled: false, cancelled };
    active.abort.abort(new Error('Worker Turn interrupt.'));
  }

  /** Closes one idle binding: revokes the native binding, loopback, and disposable control. */
  public async closeSession(body: HarnessSessionSelectorBody) {
    const session = this.requireSession(body);
    if (session.activeTurn) {
      if (session.cleanupState === 'unknown') throw harnessError('cleanup_required');
      throw harnessError('busy', 'agentSession.activeTurn');
    }
    session.closing = true;
    try {
      await session.closeResident();
    } catch {
      // The host may still hold the conversation: revoke its routes and fence the Harness.
      this.integration.destroySessionLoopback(session.agentSessionId);
      this.fenceSession(session);
      throw harnessError('cleanup_required');
    }
    this.integration.destroySessionLoopback(session.agentSessionId);
    session.credentialValues.length = 0;
    await rm(this.mapSandboxPath(workerSessionInputPaths(session.agentSessionId).root), {
      force: true,
      recursive: true,
    });
    await rm(session.sessionDirectory, { force: true, recursive: true });
    LIVE_THREAD_BINDINGS.delete(`${this.sandboxRoot}\0${session.threadId}`);
    this.sessions.delete(session.bindingId);
    return { childState: session.resident.childState(), privateState: 'absent', state: 'closed' };
  }

  /** Stops entered Turn work before attempting the existing resident close. */
  public async stopWorker(body: HarnessSessionSelectorBody) {
    const active = this.requireSession(body).activeTurn;
    if (active) {
      active.abort.abort(new Error('Worker stop.'));
      await active.promise;
    }
    return this.closeSession(body);
  }

  /**
   * Proves the adapter's handle and projects it. The first ready reference is stored under the
   * AgentSession id; the adapter decides when its conversation carries that authority. A resumed
   * binding stores only the exact carried reference. A different reference is reported as unknown
   * and never replaces the stored one.
   */
  private async proveHandle(
    session: HarnessSession,
    isCurrent?: () => boolean
  ): Promise<{
    readonly nativeHandleDigest: string | null;
    readonly nativeHandleState: 'pending' | 'ready' | 'unknown';
  }> {
    const handle: WorkerNativeHandle = await session.resident.nativeHandle();
    if (isCurrent && !isCurrent()) throw harnessError('stale');
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
      await this.storeReference(session, handle.reference);
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
  private async readResumeReference(
    resume: { digest: string; locator: string },
    threadId: string,
    adapterId: string
  ) {
    if (!isEntityId('as', resume.locator)) {
      throw harnessError('missing');
    }
    let reference: Buffer;
    try {
      reference = await readFile(this.referencePath(resume.locator, threadId, adapterId));
    } catch {
      throw harnessError('missing');
    }
    if (createHash('sha256').update(reference).digest('hex') !== resume.digest) {
      throw harnessError('conflict');
    }
    return new Uint8Array(reference);
  }

  /** Stores one ready reference under its AgentSession id, atomically and privately. */
  private async storeReference(session: HarnessSession, reference: Uint8Array): Promise<void> {
    const path = this.referencePath(session.agentSessionId, session.threadId, this.adapterId!);
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    const staging = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(staging, reference, { mode: 0o600 });
    await rename(staging, path);
  }

  /** Retained reference slot of one AgentSession, outside the disposable control root. */
  private referencePath(agentSessionId: string, threadId: string, adapterId: string): string {
    return join(this.runtimeRoot(threadId, adapterId), 'agent-session-references', agentSessionId);
  }

  /** Projects the canonical Thread/runtime root into the injected filesystem in tests. */
  private runtimeRoot(threadId: string, adapterId: string): string {
    return resolve(
      this.threadRootDirectory,
      relative('/openkit/threads', workerThreadRuntimeRoot(threadId, adapterId))
    );
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

  /** Exchanges private Login facts only under the same currently active Turn's upstream authority. */
  private async loginExchange(
    bindingId: string,
    kind: 'acquire' | 'complete' | 'observe',
    fields: Readonly<Record<string, unknown>>,
    requestSignal?: AbortSignal
  ): Promise<unknown> {
    const session = this.sessions.get(bindingId);
    const active = session?.activeTurn;
    const current = () =>
      Boolean(
        session &&
          active &&
          session.hostManagedLogin &&
          !session.failed &&
          !session.closing &&
          session.activeTurn === active &&
          !active.barrierReached &&
          !active.abort.signal.aborted &&
          !requestSignal?.aborted
      );
    if (!session || !active || !current())
      throw new Error('Native Login requires the current active Turn.');
    const signal = requestSignal
      ? AbortSignal.any([active.abort.signal, requestSignal])
      : active.abort.signal;
    try {
      const response = await this.integration.workerControlFetch('/worker-control/harness/login', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${active.workerControlToken}`,
          'Content-Type': 'application/json',
        },
        signal,
        body: JSON.stringify({
          ...fields,
          kind,
          agentSessionId: session.agentSessionId,
          agentSessionRuntimeBindingId: session.bindingId,
          workspaceId: session.workspaceId,
          threadId: session.threadId,
          turnId: active.turnId,
          leaseId: active.leaseId,
          packageSnapshotId: active.packageSnapshotId,
          turnSequence: active.turnSequence,
        }),
      });
      if (!response.ok || !current()) throw new Error('Native Login exchange failed.');
      if (kind !== 'acquire') return;
      const value: unknown = JSON.parse(await response.text());
      if (!current()) throw new Error('Native Login exchange lost its Turn.');
      return value;
    } catch {
      throw new Error('Native Login exchange failed.');
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

/** Projects the sequenced Harness operations over the resident runtime. */
export class WorkerHarness {
  private readonly runtime: ResidentRuntime;

  /** Creates a Harness with one adapter-scoped resident runtime. */
  public constructor(options: WorkerHarnessOptions) {
    this.runtime = new ResidentRuntime(options);
  }

  /**
   * Executes one sequenced command and returns its exact result envelope.
   *
   * @param command Parsed command envelope.
   * @returns A succeeded or refused result with a closed reason and, where applicable, the
   *   observed exhausted bound or operation-specific startup-failure diagnostic.
   */
  public async handle(command: HarnessCommandEnvelope): Promise<HarnessResultEnvelope> {
    try {
      const body = parseBody(command.operation, command.body);
      let resultBody: Readonly<Record<string, unknown>>;
      switch (command.operation) {
        case 'session.open':
          resultBody = await this.runtime.openSession(body as HarnessSessionOpenBody);
          break;
        case 'session.inspect':
          resultBody = await this.runtime.inspectSession(body as HarnessSessionSelectorBody);
          break;
        case 'turn.start':
          resultBody = await this.runtime.startTurn(body as HarnessTurnStartBody);
          break;
        case 'turn.steer': {
          const outcome = await this.runtime.steerTurn(body as HarnessTurnSteerBody);
          return result(command, outcome.disposition, outcome.body);
        }
        case 'turn.interrupt':
          resultBody = await this.runtime.interruptTurn(body as HarnessTurnInterruptBody);
          break;
        case 'session.close':
          resultBody = await this.runtime.closeSession(body as HarnessSessionSelectorBody);
          break;
        case 'harness.drain':
          resultBody = this.runtime.drain();
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
        ...(command.operation === 'session.open' &&
        isRecord(error) &&
        (error.retainedSessionWork === 'suspended' || error.retainedSessionWork === 'queued')
          ? { retainedSessionWork: error.retainedSessionWork }
          : {}),
        ...(error &&
        typeof error === 'object' &&
        'exhaustedBound' in error &&
        HarnessExhaustedBoundSchema.safeParse(error.exhaustedBound).success
          ? { exhaustedBound: error.exhaustedBound }
          : {}),
        ...(startupFailure ? { startupFailure } : {}),
      });
    }
  }
}

/** Retains the original start while child observations and local cleanup advance independently. */
interface WorkerLifetime {
  readonly start: WorkerShimStart;
  readonly stopScope: WorkerStopDeclaration;
  readonly runtime: ResidentRuntime;
  readonly selector: HarnessSessionSelectorBody;
  readonly result: Promise<WorkerShimDisposition>;
  state?: WorkerShimObservation['state'];
  child?: WorkerResidentSession;
  closeChild?: () => Promise<void>;
  opened: boolean;
  stopped: boolean;
}

/** Checks the original authorized placement and retained reference before sharing its result. */
function sameWorkerStart(original: WorkerShimStart, next: WorkerShimStart): boolean {
  return (
    original.workerId === next.workerId &&
    original.adapterId === next.adapterId &&
    original.agentSessionId === next.agentSessionId &&
    original.workSlotRef === next.workSlotRef &&
    original.resume?.locator === next.resume?.locator &&
    original.resume?.digest === next.resume?.digest
  );
}

/** Exact owner material resolved for a proposed input or steer key. */
interface ShimWorkMaterial {
  input(operationId: string): { work: WorkerShimTurnInput; body: HarnessTurnStartBody } | undefined;
  steer(operationId: string): { work: WorkerShimKeyedWork; body: HarnessTurnSteerBody } | undefined;
}

/** Retains a one-shot decision independently of report acknowledgement. */
interface ShimOperation {
  readonly kind: WorkerShimReceipt['kind'];
  readonly work: WorkerShimKeyedWork | WorkerShimTurnInput;
  readonly result: Promise<WorkerShimDisposition>;
  disposition?: WorkerShimDisposition;
  acknowledged: boolean;
}

/** Keeps the original desired interruption distinct from later conflicts and settlement. */
interface ShimInterrupt {
  readonly request: WorkerShimInterrupt;
  disposition: WorkerShimInterruptReceipt['disposition'];
}

/** Checks the exact active Worker, Turn and attempt. */
function sameShimTurn(original: WorkerShimTurn, next: WorkerShimTurn): boolean {
  return (
    original.workerId === next.workerId &&
    original.turnId === next.turnId &&
    original.attemptId === next.attemptId
  );
}

/** Matches the exact Core acknowledgement key. */
function sameOperationKey(original: WorkerShimOperationKey, next: WorkerShimOperationKey): boolean {
  return (
    original.operationId === next.operationId &&
    original.workerId === next.workerId &&
    original.payloadDigest === next.payloadDigest
  );
}

/** Protects the original input and authorization when sharing a prior decision. */
function sameShimWork(
  original: WorkerShimKeyedWork | WorkerShimTurnInput,
  next: WorkerShimKeyedWork | WorkerShimTurnInput
): boolean {
  return (
    sameOperationKey(original, next) &&
    sameShimTurn(original, next) &&
    original.inputRef === next.inputRef &&
    ('routeGrant' in original
      ? 'routeGrant' in next && original.routeGrant === next.routeGrant
      : !('routeGrant' in next))
  );
}

/** Supervises the Workers of one incarnation using owner-resolved start material. */
export class WorkerShim {
  private readonly workers = new Map<string, WorkerLifetime | null>();
  private readonly occupiedSlots = new Set<string>();
  private readonly operations = new Map<string, ShimOperation>();
  private readonly interrupts: ShimInterrupt[] = [];
  private generation = -1;
  private revision = -1;

  /** Binds one shim instance to its incarnation and the embedding owner's admitted placement. */
  public constructor(
    private readonly options: WorkerHarnessOptions,
    private readonly incarnationId: string,
    private readonly readStart: (workerId: string) =>
      | {
          readonly worker: WorkerShimStart;
          readonly body: HarnessSessionOpenBody;
        }
      | undefined,
    private readonly workMaterial?: ShimWorkMaterial
  ) {}

  /** Reserves the Worker and its local work slot before asynchronous setup can enter. */
  public async start(worker: WorkerShimStart): Promise<WorkerShimDisposition> {
    const previous = this.workers.get(worker.workerId);
    if (previous === null || previous?.stopped || previous?.state === 'exited') return 'refused';
    if (previous) return sameWorkerStart(previous.start, worker) ? previous.result : 'refused';

    const admitted = this.readStart(worker.workerId);
    if (!admitted || !sameWorkerStart(admitted.worker, worker)) return 'refused';
    if (this.occupiedSlots.has(worker.workSlotRef)) return 'refused';
    const adapter = (this.options.adapters ?? WORKER_ADAPTERS)[worker.adapterId];
    if (!adapter) return 'refused';
    const parsed = HarnessSessionOpenBodySchema.safeParse(admitted.body);
    if (!parsed.success) return 'refused';
    const body = parsed.data;
    if (
      !sameWorkerStart(worker, {
        workerId: worker.workerId,
        workSlotRef: worker.workSlotRef,
        adapterId: body.adapterId,
        agentSessionId: body.agentSessionId,
        resume: body.resume,
      })
    )
      return 'refused';
    const entry: WorkerLifetime = {
      start: { ...worker, resume: body.resume },
      stopScope: adapter.stop ?? { kind: 'best-effort' },
      runtime: new ResidentRuntime(this.options),
      selector: {
        agentSessionId: body.agentSessionId,
        agentSessionRuntimeBindingId: body.agentSessionRuntimeBindingId,
      },
      opened: false,
      stopped: false,
      result: Promise.resolve().then(() => this.open(entry, body)),
    };
    this.workers.set(worker.workerId, entry);
    this.occupiedSlots.add(worker.workSlotRef);
    return entry.result;
  }

  /** Closes ingress once and leaves any entered open with its original cleanup owner. */
  public async stop(workerId: string): Promise<'stopping' | 'exited' | 'unknown'> {
    const entry = this.workers.get(workerId);
    if (!entry) {
      this.workers.set(workerId, null);
      return 'unknown';
    }
    if (!entry.stopped) {
      entry.stopped = true;
      if (entry.state !== 'exited') entry.state = 'stopping';
      // Handle inspection may need the child to close before the open can finish.
      if (!entry.opened) void entry.closeChild?.().catch(() => undefined);
      void entry.result.then(async () => {
        if (!entry.opened) return;
        try {
          await entry.runtime.stopWorker(entry.selector);
        } catch {
          // The original slot remains held if local close fails.
        }
        if (entry.child?.childState() === 'absent') entry.state = 'exited';
      });
    }
    return entry.state === 'exited' ? 'exited' : 'stopping';
  }

  /** Best-effort adapters have no qualified whole-tree proof to await locally. */
  public async waitUntilAbsent(
    _workerId: string,
    _deadline: LifecycleDeadline
  ): Promise<WorkerShimAbsence> {
    return { state: 'held' };
  }

  /** Applies the original input once and retains uncertain native delivery. */
  public keyedTurnInput(work: WorkerShimTurnInput): Promise<WorkerShimDisposition> {
    return this.applyOperation(
      'input',
      work,
      (id) => this.workMaterial?.input(id),
      async (original, body) => {
        const entry = this.workers.get(original.workerId);
        if (!entry || entry.stopped || this.hasInterrupt(original)) return 'refused';
        if (!entry.opened) await entry.result;
        const parsed = HarnessTurnStartBodySchema.safeParse(body);
        if (
          !parsed.success ||
          entry.stopped ||
          entry.state !== 'running' ||
          parsed.data.turnId !== original.turnId ||
          parsed.data.agentSessionId !== entry.selector.agentSessionId ||
          parsed.data.agentSessionRuntimeBindingId !== entry.selector.agentSessionRuntimeBindingId
        )
          return 'refused';

        let disposition: WorkerShimDisposition | undefined;
        let accept!: () => void;
        const ack = new Promise<'accepted'>((resolve) => {
          accept = () => resolve('accepted');
        });
        const admission: ShimTurnAdmission = {
          target: original,
          contacted: false,
          nativeSettled: false,
          beforeNativeInput: (input) => {
            if (entry.stopped || entry.state !== 'running' || this.hasInterrupt(original))
              throw harnessError('stale');
            if (createHash('sha256').update(input).digest('hex') !== original.payloadDigest)
              throw harnessError('conflict');
          },
          onInputAccepted: () => {
            if (!admission.contacted || disposition) return;
            disposition = 'accepted';
            accept();
          },
          finished: () => {
            // Once the original Turn joins, close its fenced Worker.
            if (admission.contacted && disposition !== 'accepted')
              void this.stop(original.workerId);
          },
        };
        const handoff = entry.runtime
          .startTurn(parsed.data, admission)
          .then<WorkerShimDisposition, WorkerShimDisposition>(
            () => {
              if (disposition === 'accepted') return disposition;
              // Keep the entered Turn's settlement owner and fence fresh effects before the receipt.
              if (entry.state === 'running') entry.state = 'stopping';
              disposition = 'unknown';
              return disposition;
            },
            () => {
              if (!admission.contacted) {
                disposition = 'refused';
                return disposition;
              }
              void this.stop(original.workerId);
              disposition ??= 'unknown';
              return disposition;
            }
          );
        return Promise.race([ack, handoff]);
      }
    );
  }

  /** Sends steer only through the exact active Turn's qualified native compare-and-admit hook. */
  public keyedSteer(work: WorkerShimKeyedWork): Promise<WorkerShimDisposition> {
    return this.applyOperation(
      'steer',
      work,
      (id) => this.workMaterial?.steer(id),
      async (original, body) => {
        const entry = this.workers.get(original.workerId);
        if (!entry || entry.stopped || entry.state !== 'running' || this.hasInterrupt(original))
          return 'refused';
        const parsed = HarnessTurnSteerBodySchema.safeParse(body);
        if (
          !parsed.success ||
          parsed.data.turnId !== original.turnId ||
          parsed.data.inputItemId !== original.inputRef ||
          parsed.data.inputDigest !== original.payloadDigest ||
          parsed.data.agentSessionId !== entry.selector.agentSessionId ||
          parsed.data.agentSessionRuntimeBindingId !== entry.selector.agentSessionRuntimeBindingId
        )
          return 'refused';
        try {
          const { disposition } = await entry.runtime.steerTurn(parsed.data, original);
          return disposition === 'succeeded' ? 'accepted' : disposition;
        } catch {
          // The resident steer owner already turns any uncertain native contact into unknown.
          return 'refused';
        }
      }
    );
  }

  /** Checks owner scope before reserving the operation for asynchronous setup or native contact. */
  private applyOperation<T extends WorkerShimKeyedWork, B>(
    kind: WorkerShimReceipt['kind'],
    work: T,
    read: (id: string) => { work: T; body: B } | undefined,
    apply: (work: T, body: B) => Promise<WorkerShimDisposition>
  ): Promise<WorkerShimDisposition> {
    const previous = this.operations.get(work.operationId);
    if (previous)
      return previous.kind === kind && sameShimWork(previous.work, work)
        ? previous.result
        : Promise.resolve('refused');
    const admitted = read(work.operationId);
    if (!admitted || !sameShimWork(admitted.work, work)) return Promise.resolve('refused');
    const original = { ...work };
    const entry: ShimOperation = {
      kind,
      work: original,
      acknowledged: false,
      result: Promise.resolve()
        .then(() => apply(original, admitted.body))
        .then((disposition) => {
          entry.disposition = disposition;
          return disposition;
        }),
    };
    this.operations.set(original.operationId, entry);
    return entry.result;
  }

  /** Closes native admission for a Turn with recorded desired interruption. */
  private hasInterrupt(target: WorkerShimTurn): boolean {
    return this.interrupts.some(({ request }) => sameShimTurn(request, target));
  }

  /** Records the first request and preserves conflicts without delivering them. */
  private applyInterrupt(request: WorkerShimInterrupt): void {
    const prior = this.interrupts.filter((entry) => sameShimTurn(entry.request, request));
    if (
      prior.some(
        (entry) =>
          entry.request.requestId === request.requestId && entry.request.cause === request.cause
      )
    )
      return;
    const original: ShimInterrupt = {
      request: { ...request },
      disposition: prior.length ? 'refused' : 'unknown',
    };
    this.interrupts.push(original);
    if (prior.length) return;
    const entry = this.workers.get(request.workerId);
    if (!entry?.opened || entry.stopped || entry.state === 'exited') return;
    entry.runtime.interruptShimTurn(entry.selector, original.request, () => {
      original.disposition = 'cancelled';
    });
  }

  /** Exchanges complete local observations before applying a current desired Worker set. */
  public async poll(
    session: WorkerShimSession,
    exchange: (inventory: WorkerShimInventory) => Promise<WorkerShimDesiredSet>
  ): Promise<'applied' | 'stale'> {
    const { connectionGeneration: generation, sandboxIncarnationId } = session;
    if (sandboxIncarnationId !== this.incarnationId || generation < this.generation) return 'stale';
    if (generation > this.generation) {
      this.generation = generation;
      this.revision = -1;
    }
    const workers: WorkerShimObservation[] = [];
    for (const [workerId, entry] of this.workers) {
      if (entry?.state) workers.push({ workerId, state: entry.state, stop: entry.stopScope });
    }
    const receipts: WorkerShimReceipt[] = [];
    for (const { kind, work, acknowledged, disposition } of this.operations.values()) {
      if (!acknowledged && disposition) {
        const { operationId, workerId, payloadDigest } = work;
        receipts.push({ kind, key: { operationId, workerId, payloadDigest }, disposition });
      }
    }
    const interrupts = this.interrupts.map(({ request, disposition }) => ({
      ...request,
      disposition,
    }));
    const desired = await exchange({ session, workers, receipts, interrupts });
    if (
      generation !== this.generation ||
      desired.session.connectionGeneration !== generation ||
      desired.session.sandboxIncarnationId !== this.incarnationId ||
      desired.revision <= this.revision
    )
      return 'stale';
    this.revision = desired.revision;
    for (const key of desired.acknowledgedOperations) {
      const original = this.operations.get(key.operationId);
      if (original?.disposition && sameOperationKey(original.work, key)) {
        original.acknowledged = true;
      }
    }
    const effects: Promise<unknown>[] = [];
    for (const worker of desired.workers) {
      if (worker.state === 'stop') effects.push(this.stop(worker.workerId));
    }
    for (const interrupt of desired.interrupts) this.applyInterrupt(interrupt);
    for (const worker of desired.workers) {
      if (worker.state === 'run') effects.push(this.start(worker.worker));
    }
    for (const input of desired.inputs) effects.push(this.keyedTurnInput(input));
    for (const steer of desired.steers) effects.push(this.keyedSteer(steer));
    await Promise.all(effects);
    return 'applied';
  }

  /** Reuses admitted setup and retains the slot whenever a child may have started. */
  private async open(
    entry: WorkerLifetime,
    body: HarnessSessionOpenBody
  ): Promise<WorkerShimDisposition> {
    const isCurrent = () => !entry.stopped && entry.state !== 'exited';
    try {
      if (!isCurrent()) throw harnessError('stale');
      await entry.runtime.openSession(body, {
        isCurrent,
        handoffChild: (child) => {
          entry.child = child;
          let closing: Promise<void> | undefined;
          entry.closeChild = () => (closing ??= Promise.resolve().then(() => child.close()));
          const exited = () => {
            entry.state = 'exited';
          };
          void child.exited.then(exited, exited);
          return entry.closeChild;
        },
      });
      entry.opened = true;
      if (!isCurrent()) return 'unknown';
      entry.state = 'running';
      return 'accepted';
    } catch (error) {
      if (!entry.child) {
        this.occupiedSlots.delete(entry.start.workSlotRef);
        return 'refused';
      }
      if (entry.child.childState() === 'absent') entry.state = 'exited';
      else if (entry.state !== 'exited') entry.state = 'stopping';
      return reasonCode(error) === 'cleanup_required' || entry.stopped ? 'unknown' : 'refused';
    }
  }
}

/** Opens the static Integration client and runs the private pull/result loop. */
export async function runWorkerHarness(
  options: {
    readonly environment?: WorkerShimEnvironment | undefined;
    readonly signal?: AbortSignal | undefined;
    /** Explicit immutable identity for an embedding owner; the binary always reads its image file. */
    readonly releaseIdentity?: WorkerBuildIdentity | null | undefined;
  } = {}
): Promise<void> {
  const releaseIdentity = Object.hasOwn(options, 'releaseIdentity')
    ? options.releaseIdentity
    : await readWorkerReleaseIdentity();
  const integration = await openSandboxIntegration(
    options.signal ? { signal: options.signal } : undefined
  );
  const harnesses = new Map<string, { readonly harness: WorkerHarness; nextSequence: number }>();
  try {
    process.stdout.write('OPENKIT_WORKER_SHIM_ENTRY_V1\n');
    await integration.ready;
    while (!options.signal?.aborted) {
      const pollDeadline = new LifecycleDeadline(LIFECYCLE_DEFAULTS.harnessPollMinimumMs);
      const response = await requestWithOutageBudget(
        integration,
        HARNESS_POLL_PATH,
        // This is one serial loop: a poll cannot overlap command execution or result acknowledgement.
        JSON.stringify({
          schemaVersion: 2,
          releaseIdentity,
          harnesses: [...harnesses].map(([harnessInstanceId, owner]) => ({
            harnessInstanceId,
            nextSequence: owner.nextSequence,
          })),
        }),
        options.signal
      );
      if (response.status === 204) {
        // A timer may fire early against the monotonic clock, so wait until the minimum elapsed.
        for (;;) {
          const remaining = pollDeadline.remainingMs();
          if (remaining <= 0) break;
          await delay(Math.ceil(remaining), undefined, { signal: options.signal });
        }
        continue;
      }
      if (response.status !== 200) {
        throw new Error(`Harness poll failed with HTTP ${response.status}.`);
      }
      const command = HarnessCommandEnvelopeReaderSchema.parse(JSON.parse(await response.text()));
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
      const settled = HarnessResultEnvelopeSchema.parse(await owner.harness.handle(command));
      if (!isHarnessResultBodyValid(command.operation, settled))
        throw new Error('Harness emitted an invalid operation result.');
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
  const deadline = new LifecycleDeadline(HARNESS_OUTAGE_BUDGET_MS);
  let failure: unknown = new Error('Harness request outage budget expired.');
  for (;;) {
    signal?.throwIfAborted();
    const remaining = deadline.remainingMs();
    if (remaining <= 0) throw failure;
    const timeout = new AbortController();
    // A committed command may still be awaiting headers. Keep its carriage alive, but never
    // renew the enclosing allowance across headers, body collection or immutable retries.
    const timer = setTimeout(
      () => timeout.abort(new Error('Harness request outage budget expired.')),
      remaining
    );
    const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const response = await integration.harnessControlFetch(path, {
        body,
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: requestSignal,
      });
      // Collection may resolve despite an abort. Do not inspect an abandoned body.
      requestSignal.throwIfAborted();
      const text = await response.text();
      requestSignal.throwIfAborted();
      if (!isRetryableHttpStatus(response.status)) {
        return { ok: response.ok, status: response.status, text: async () => text };
      }
      failure = new Error(`Harness request failed with retryable HTTP ${response.status}.`);
    } catch (error) {
      signal?.throwIfAborted();
      failure = error;
    } finally {
      clearTimeout(timer);
    }
    const retryRemaining = deadline.remainingMs(LIFECYCLE_DEFAULTS.harnessPollMinimumMs);
    if (retryRemaining <= 0) {
      throw failure;
    }
    await delay(retryRemaining, undefined, { signal });
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
  // Preserve supervisor-supplied Node trust; derive it only when that binding is absent.
  if (!selected.NODE_EXTRA_CA_CERTS && selected.SSL_CERT_FILE)
    selected.NODE_EXTRA_CA_CERTS = selected.SSL_CERT_FILE;
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
  disposition: HarnessResultEnvelope['disposition'],
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
function harnessError(
  code: HarnessRefusalReason,
  exhaustedBound?: import('zod').infer<typeof HarnessExhaustedBoundSchema>
): Error {
  return Object.assign(new Error(`Harness operation refused: ${code}`), {
    harnessReasonCode: code,
    ...(exhaustedBound ? { exhaustedBound } : {}),
  });
}

/** Projects only the fixed refusal vocabulary; any other failure is a dependency failure. */
function reasonCode(error: unknown): HarnessRefusalReason {
  if (error && typeof error === 'object' && 'harnessReasonCode' in error) {
    return error.harnessReasonCode as HarnessRefusalReason;
  }
  return 'dependency_failed';
}
