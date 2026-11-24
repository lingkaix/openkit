/**
 * r7 c1 witnesses, rows 15 and 14 of the owner-edge class closure.
 *
 * Row 15: the original Login close keeps both reader-visible slots through positive success, a
 * proved never-dispatched unwind, the exact admission fence ACK or a fenced predecessor Epoch.
 * Row 14: a changed resident carries the current admission read, and materialization keeps the
 * causal capacity refusal. The owner methods run with controlled native ACKs. The #604 departure
 * fixtures stay untouched (row 16 is deferred).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addSchedulerHoldReleaseListener,
  type SchedulerCapacityChange,
  type SchedulerCapacityRefusal,
} from '../scheduler-hold-release.js';
import type { CoreDb } from '../storage/db.js';
import { TEST_WORKER_RELEASE_IDENTITY } from '../test-support/release-identity.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import {
  claimNanoHostIdleSandboxDrain,
  drainNanoHostHarnessAdmission,
  expireNanoHostHarnessQueuedOperation,
  markNanoHostHarnessOperationUnknown,
  queueNanoHostHarnessOperation,
} from './nanohost-harness.js';
import { createConfiguredWorkerLifecycleRuntime } from './turn-executor-factory.js';
import { WorkerGovernanceCapacityUnavailableError } from './worker-governance-backend.js';

const control = vi.hoisted(() => ({ budgetMs: 10_000, attemptPhase: 'closed' }));

vi.mock('./nanohost-harness.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./nanohost-harness.js')>();
  return {
    ...original,
    get NANO_HOST_HARNESS_RESULT_BUDGET_MS() {
      return control.budgetMs;
    },
    acknowledgeNanoHostHarnessResult: vi.fn(async () => {}),
    claimNanoHostIdleSandboxDrain: vi.fn(async () => {}),
    deriveNanoHostAgentSessionCompatibilityKey: vi.fn(() => 'session-key'),
    drainNanoHostHarnessAdmission: vi.fn(),
    expireNanoHostHarnessQueuedOperation: vi.fn(),
    markNanoHostHarnessOperationUnknown: vi.fn(),
    queueNanoHostHarnessOperation: vi.fn(),
  };
});
vi.mock('./execution-attempts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./execution-attempts.js')>()),
  requireSchedulerExecutionAttempt: vi.fn(() => ({ phase: control.attemptPhase, deadline: null })),
}));
vi.mock('./worker-governance-turn-executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./worker-governance-turn-executor.js')>()),
  agentSessionCompatibilityKeyFromPackage: vi.fn(() => 'session-key'),
  beginWorkerTurnJournalStep: vi.fn(async () => ({
    control: { deadlineUnixNano: null },
    execution: { ref: { owner: 'owner', executionId: 'execution' } },
    stepId: 'step',
  })),
  endWorkerTurnJournalStep: vi.fn(async () => {}),
}));
vi.mock('./execution-journal.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./execution-journal.js')>()),
  createExecutionStepJournalReader: vi.fn(() => ({
    readInvocation: async () => ({ state: 'ended' }),
  })),
}));
vi.mock('../storage/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage/db.js')>()),
  openAdmittedWorkspaceReadDb: vi.fn((dataRoot: string, workspaceId: string) => ({
    dataRoot,
    workspaceId,
    sqlite: { close: () => {} },
  })),
}));
vi.mock('./workspace-source-admission.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace-source-admission.js')>()),
  assertCurrentWorkspaceSources: vi.fn(),
}));
vi.mock('./nanohost-compatibility.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./nanohost-compatibility.js')>()),
  nanoHostHarnessCompatibilityKey: vi.fn(() => 'harness-key'),
  nanoHostSandboxCompatibilityKey: vi.fn(() => 'sandbox-key'),
}));
vi.mock('./provider-credential-binding.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./provider-credential-binding.js')>()),
  requireWorkerProviderBindings: vi.fn(() => []),
}));
vi.mock('./worker-governance-backend.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./worker-governance-backend.js')>()),
  prepareNanoHostContextPackageImports: vi.fn(async () => []),
}));

const WORKSPACE = 'ws_00000000-0000-7000-8000-000000000001';
const LOGIN_CLOSE_REFUSAL = 'The original Login close still owns Thread admission.';
const POLL = { interval: 1, timeout: 2_000 };
/** The original bound of the timeout witnesses; the other witnesses never reach theirs. */
const SHORT_BOUND_MS = 150;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

type Pending = { operationId: string | null; sequence: number | null } | null;

interface FakeSession {
  readonly harnessInstanceId: string;
  readonly harnessBindingRef: string;
  readonly agentSessionRuntimeBindingId: string;
  readonly attemptId: string;
  readonly environmentPackage: {
    readonly snapshotId: string;
    readonly scope: Record<string, unknown>;
  };
  pendingHarnessOperation: Pending;
  readonly initialHarnessLogin: null;
  readonly refreshHarnessLogin: null;
  readonly turnStopSettlement: null;
  readonly retainedStagingPaths: string[];
  readonly sharedHarness: {
    readonly harnessInstanceId: string;
    readonly sandbox: Record<string, string>;
    readonly bindings: Map<string, unknown>;
  };
  nativeSessionReusable: boolean;
  cleanupOwnershipRequired?: boolean;
}

interface Inspection {
  readonly agentSessionId: string;
  readonly agentSessionRuntimeBindingId: string;
  readonly harnessBindingRef: string;
  readonly harnessInstanceId: string;
}

/** The private owner methods under test; their bodies are the production code. */
interface Backend {
  readonly sessions: Map<string, FakeSession>;
  readonly agentSessionCloseOwners: Map<string, { pending: Pending }>;
  queueAndWaitForHarnessOperation(
    session: FakeSession,
    operation: 'session.close',
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  closeDurableAgentSession(inspection: Inspection): Promise<void>;
  acceptHarnessCommand(command: Record<string, unknown>): Promise<unknown>;
  acceptHarnessResult(result: Record<string, unknown>): Promise<void>;
  failHarnessDelivery(command: Record<string, unknown>, failure?: unknown): void;
  invalidatePhysicallyAbsentSandbox(eviction: Record<string, unknown>): Promise<void>;
  evictIncompatibleIdleSandbox(
    environmentPackage: unknown,
    forceRetirement?: boolean,
    replacementSelection?: Record<string, unknown>
  ): Promise<unknown>;
  materialize(environmentPackage: unknown, context?: Record<string, unknown>): Promise<unknown>;
  schedulerCapacityRefusal(
    error: unknown,
    thread: { readonly workspaceId: string; readonly threadId: string }
  ): SchedulerCapacityRefusal | null;
}

let coreDb: CoreDb;
let dataRoot: string;
let backend: Backend;
let releases: SchedulerCapacityChange[];
let removeListener: () => void;

beforeEach(() => {
  control.budgetMs = 10_000;
  control.attemptPhase = 'closed';
  dataRoot = mkdtempSync(join(tmpdir(), 'openkit-login-close-owner-'));
  coreDb = createTestCoreDb(dataRoot);
  backend = createConfiguredWorkerLifecycleRuntime({
    releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
    coreDb,
    env: {},
  }).turnExecutor.executionBackend as unknown as Backend;
  releases = [];
  removeListener = addSchedulerHoldReleaseListener(dataRoot, {
    hold: () => {},
    capacity: (change) => releases.push(change),
  });
  vi.mocked(queueNanoHostHarnessOperation).mockReset();
  vi.mocked(drainNanoHostHarnessAdmission).mockReset();
  vi.mocked(expireNanoHostHarnessQueuedOperation).mockReset();
  vi.mocked(markNanoHostHarnessOperationUnknown).mockReset();
  vi.mocked(claimNanoHostIdleSandboxDrain).mockClear();
});

afterEach(async () => {
  removeListener();
  vi.restoreAllMocks();
  await disposeTestStore(dataRoot, coreDb);
});

function fakeSession(name: string, threadId: string): FakeSession {
  return {
    harnessInstanceId: `hi_${name}`,
    harnessBindingRef: `hb_${name}`,
    agentSessionRuntimeBindingId: `asrb_${name}`,
    attemptId: `attempt_${name}`,
    environmentPackage: {
      snapshotId: `pkg_${name}`,
      scope: {
        workspaceId: WORKSPACE,
        threadId,
        agentSessionId: `as_${name}`,
        turnId: `tu_${name}`,
      },
    },
    pendingHarnessOperation: null,
    initialHarnessLogin: null,
    refreshHarnessLogin: null,
    turnStopSettlement: null,
    retainedStagingPaths: [],
    sharedHarness: {
      harnessInstanceId: `hi_${name}`,
      sandbox: {
        sandboxRuntimeId: `sr_${name}`,
        originPhysicalEpoch: 'e'.repeat(64),
        runtimeTargetId: 'rt_local',
      },
      bindings: new Map(),
    },
    nativeSessionReusable: true,
  };
}

function inspectionOf(session: FakeSession): Inspection {
  return {
    agentSessionId: session.environmentPackage.scope.agentSessionId as string,
    agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
    harnessBindingRef: session.harnessBindingRef,
    harnessInstanceId: session.harnessInstanceId,
  };
}

function closeCommand(session: FakeSession): Record<string, unknown> {
  return {
    harnessInstanceId: session.harnessInstanceId,
    operation: 'session.close',
    operationId: `op_${session.harnessInstanceId}`,
    sequence: 1,
    body: {
      agentSessionId: session.environmentPackage.scope.agentSessionId,
      agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
    },
  };
}

function closeResult(
  session: FakeSession,
  disposition: 'succeeded' | 'refused',
  body: Record<string, unknown>
): Record<string, unknown> {
  return {
    harnessInstanceId: session.harnessInstanceId,
    schemaVersion: 2,
    operationId: `op_${session.harnessInstanceId}`,
    sequence: 1,
    disposition,
    body,
  };
}

/** Installs the controlled readers of one Login close; the slot owners stay production code. */
function controlLoginClose(sessions: readonly FakeSession[]): void {
  const target = backend as unknown as Record<string, (...args: never[]) => unknown>;
  vi.spyOn(target, 'captureHarnessLoginDeparture' as never).mockImplementation(((
    session: FakeSession
  ) => ({
    workspaceId: WORKSPACE,
    threadId: session.environmentPackage.scope.threadId,
    agentSessionId: session.environmentPackage.scope.agentSessionId,
    agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
    harnessBindingRef: session.harnessBindingRef,
    originPhysicalEpoch: 'e'.repeat(64),
    runtimeTargetId: 'rt_local',
    expectedReferenceId: 'vault_login_reference',
  })) as never);
  vi.spyOn(target, 'readIdleCloseAuthority' as never).mockReturnValue({
    receipt: 'idle-close',
  } as never);
  vi.spyOn(target, 'prepareHarnessOperation' as never).mockImplementation(((input: {
    readonly body: Record<string, unknown>;
    readonly harnessInstanceId: string;
  }) => {
    const session = sessions.find((item) => item.harnessInstanceId === input.harnessInstanceId)!;
    const command = closeCommand(session);
    return { command, wireBody: command.body };
  }) as never);
  vi.spyOn(target, 'restoreDurableAgentSession' as never).mockImplementation(((
    inspection: Inspection
  ) => {
    const session = sessions.find(
      (item) => item.agentSessionRuntimeBindingId === inspection.agentSessionRuntimeBindingId
    )!;
    if (!backend.sessions.has(session.environmentPackage.snapshotId))
      backend.sessions.set(session.environmentPackage.snapshotId, session);
    return backend.sessions.get(session.environmentPackage.snapshotId);
  }) as never);
  vi.spyOn(target, 'collectWorkspaceSnapshot' as never).mockResolvedValue(undefined as never);
  vi.spyOn(target, 'readNanoHost' as never).mockReturnValue([] as never);
}

/** The E7 re-check of the Thread admission refusal: true while a Login close owns the Thread. */
function loginCloseOwns(session: FakeSession): boolean {
  const refusal = backend.schedulerCapacityRefusal(
    new WorkerGovernanceCapacityUnavailableError(LOGIN_CLOSE_REFUSAL),
    {
      workspaceId: WORKSPACE,
      threadId: session.environmentPackage.scope.threadId as string,
    }
  );
  return refusal!.stillRefused!();
}

function slots(session: FakeSession) {
  return {
    session: backend.sessions.get(session.environmentPackage.snapshotId)?.pendingHarnessOperation
      ? 'held'
      : 'clear',
    closeOwner: backend.agentSessionCloseOwners.get(session.agentSessionRuntimeBindingId)?.pending
      ? 'held'
      : 'clear',
  };
}

function loginRelease(session: FakeSession): SchedulerCapacityChange {
  return {
    kind: 'login-close',
    workspaceId: WORKSPACE,
    threadId: session.environmentPackage.scope.threadId as string,
  };
}

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  return await Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

describe('Row 15: the original Login close keeps both slots until its proof', () => {
  it('keeps both slots after a timeout while the queue can still win, refuses a second close, and retires them at the exact fence ACK', async () => {
    control.budgetMs = SHORT_BOUND_MS;
    const a = fakeSession('a', 'th_a');
    controlLoginClose([a]);
    const queued = deferred<number>();
    const fence = deferred<void>();
    vi.mocked(queueNanoHostHarnessOperation).mockReturnValue(queued.promise);
    vi.mocked(drainNanoHostHarnessAdmission).mockReturnValue(fence.promise);

    const closing = backend.closeDurableAgentSession(inspectionOf(a));
    void closing.catch(() => {});
    await vi.waitFor(() => expect(queueNanoHostHarnessOperation).toHaveBeenCalledTimes(1), POLL);
    // The bound expires while the queue publication is still unanswered.
    await vi.waitFor(() => expect(drainNanoHostHarnessAdmission).toHaveBeenCalledTimes(1), POLL);
    expect(expireNanoHostHarnessQueuedOperation).not.toHaveBeenCalled();
    expect(slots(a)).toEqual({ session: 'held', closeOwner: 'held' });
    expect(loginCloseOwns(a)).toBe(true);

    // The queue wins after the bound. Both finally blocks run; neither is a proof.
    queued.resolve(1);
    await expect(closing).rejects.toThrow('NanoHost Login close requires inspection.');
    expect(slots(a)).toEqual({ session: 'held', closeOwner: 'held' });
    expect(loginCloseOwns(a)).toBe(true);
    expect(releases).toEqual([]);

    // A second close on the same Thread starts no second departure.
    await expect(backend.closeDurableAgentSession(inspectionOf(a))).rejects.toThrow(
      'NanoHost AgentSession close already has a live producer.'
    );
    expect(queueNanoHostHarnessOperation).toHaveBeenCalledTimes(1);
    expect(drainNanoHostHarnessAdmission).toHaveBeenCalledTimes(1);
    expect(loginCloseOwns(a)).toBe(true);

    // The exact fence ACK retires both slots and the deferred unwind, then reads the owner.
    fence.resolve();
    await vi.waitFor(() => expect(releases).toEqual([loginRelease(a)]), POLL);
    expect(slots(a)).toEqual({ session: 'clear', closeOwner: 'clear' });
    expect(backend.sessions.has(a.environmentPackage.snapshotId)).toBe(false);
    expect(backend.agentSessionCloseOwners.has(a.agentSessionRuntimeBindingId)).toBe(false);
    expect(loginCloseOwns(a)).toBe(false);
  });

  it('rejects a dispatched waiter at its bound, keeps the owner through a failed fence and late results, and releases at the fenced Epoch', async () => {
    control.budgetMs = SHORT_BOUND_MS;
    const a = fakeSession('a', 'th_a');
    controlLoginClose([a]);
    const fence = deferred<void>();
    vi.mocked(queueNanoHostHarnessOperation).mockResolvedValue(1);
    vi.mocked(markNanoHostHarnessOperationUnknown).mockResolvedValue(undefined);
    vi.mocked(drainNanoHostHarnessAdmission).mockReturnValue(fence.promise);

    const closing = backend.closeDurableAgentSession(inspectionOf(a));
    void closing.catch(() => {});
    await vi.waitFor(() => expect(queueNanoHostHarnessOperation).toHaveBeenCalledTimes(1), POLL);
    // The first dispatch wins: Core committed it and the callback bound its operation ID.
    await backend.acceptHarnessCommand(closeCommand(a)).catch(() => undefined);
    expect(
      backend.sessions.get(a.environmentPackage.snapshotId)?.pendingHarnessOperation
    ).toMatchObject({ operationId: `op_${a.harnessInstanceId}`, sequence: 1 });

    // The waiter rejects at its original bound although the fence is still unresolved.
    expect(await settledWithin(closing, 1_000)).toBe(true);
    await expect(closing).rejects.toThrow('NanoHost Login close requires inspection.');
    expect(markNanoHostHarnessOperationUnknown).toHaveBeenCalledTimes(1);
    expect(drainNanoHostHarnessAdmission).toHaveBeenCalledTimes(1);
    expect(slots(a)).toEqual({ session: 'held', closeOwner: 'held' });

    // The fence fails. The cached rejected fence keeps both slots.
    fence.reject(new Error('fence reply lost'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slots(a)).toEqual({ session: 'held', closeOwner: 'held' });
    expect(loginCloseOwns(a)).toBe(true);

    // A late refusal and a late success cannot erase the owner or start another departure.
    await backend.acceptHarnessResult(
      closeResult(a, 'refused', { reasonCode: 'dependency_failed' })
    );
    await expect(
      backend.acceptHarnessResult(
        closeResult(a, 'succeeded', { state: 'closed', privateState: 'absent' })
      )
    ).rejects.toThrow();
    expect(slots(a)).toEqual({ session: 'held', closeOwner: 'held' });
    expect(drainNanoHostHarnessAdmission).toHaveBeenCalledTimes(1);
    expect(releases).toEqual([]);
    await expect(backend.closeDurableAgentSession(inspectionOf(a))).rejects.toThrow(
      'NanoHost AgentSession close already has a live producer.'
    );

    // The fenced predecessor Epoch is the named later exit.
    await backend.invalidatePhysicallyAbsentSandbox({
      sandboxRuntimeId: a.sharedHarness.sandbox.sandboxRuntimeId,
      bindings: [{ agentSessionRuntimeBindingId: a.agentSessionRuntimeBindingId }],
    });
    expect(releases).toEqual([loginRelease(a)]);
    expect(slots(a)).toEqual({ session: 'clear', closeOwner: 'clear' });
    expect(backend.agentSessionCloseOwners.has(a.agentSessionRuntimeBindingId)).toBe(false);
    expect(loginCloseOwns(a)).toBe(false);
  });

  it('retires on positive success and keeps an unrelated Thread parked', async () => {
    const a = fakeSession('a', 'th_a');
    const b = fakeSession('b', 'th_b');
    controlLoginClose([a, b]);
    vi.spyOn(
      backend as unknown as Record<string, () => Promise<void>>,
      'completeHarnessLoginDeparture' as never
    ).mockResolvedValue(undefined as never);
    vi.mocked(queueNanoHostHarnessOperation).mockResolvedValue(1);

    const closingA = backend.closeDurableAgentSession(inspectionOf(a));
    const closingB = backend.closeDurableAgentSession(inspectionOf(b));
    void closingB.catch(() => {});
    await vi.waitFor(() => expect(queueNanoHostHarnessOperation).toHaveBeenCalledTimes(2), POLL);
    await backend.acceptHarnessCommand(closeCommand(a)).catch(() => undefined);
    await backend.acceptHarnessCommand(closeCommand(b)).catch(() => undefined);
    expect(loginCloseOwns(a)).toBe(true);
    expect(loginCloseOwns(b)).toBe(true);

    await backend.acceptHarnessResult(
      closeResult(a, 'succeeded', { state: 'closed', privateState: 'absent' })
    );
    await closingA;
    expect(releases).toEqual([loginRelease(a)]);
    expect(slots(a)).toEqual({ session: 'clear', closeOwner: 'clear' });
    expect(loginCloseOwns(a)).toBe(false);
    // The unrelated Thread keeps its own predicate and its waiter stays parked.
    expect(loginCloseOwns(b)).toBe(true);
    expect(slots(b)).toEqual({ session: 'held', closeOwner: 'held' });

    await backend.acceptHarnessResult(
      closeResult(b, 'succeeded', { state: 'closed', privateState: 'absent' })
    );
    await closingB;
    expect(releases).toEqual([loginRelease(a), loginRelease(b)]);
    expect(loginCloseOwns(b)).toBe(false);
  });

  it('treats the queued-expiry ACK as proof that the close was never dispatched', async () => {
    control.budgetMs = SHORT_BOUND_MS;
    const a = fakeSession('a', 'th_a');
    controlLoginClose([a]);
    vi.mocked(queueNanoHostHarnessOperation).mockResolvedValue(1);
    vi.mocked(expireNanoHostHarnessQueuedOperation).mockResolvedValue(undefined);
    vi.mocked(drainNanoHostHarnessAdmission).mockResolvedValue(undefined);

    await expect(backend.closeDurableAgentSession(inspectionOf(a))).rejects.toThrow(
      'NanoHost Harness session.close result outage budget expired: never-dispatched.'
    );
    expect(expireNanoHostHarnessQueuedOperation).toHaveBeenCalledTimes(1);
    expect(drainNanoHostHarnessAdmission).not.toHaveBeenCalled();
    expect(releases).toEqual([loginRelease(a)]);
    expect(slots(a)).toEqual({ session: 'clear', closeOwner: 'clear' });
    expect(loginCloseOwns(a)).toBe(false);
  });

  it('keeps the ordinary live close slot past its finally until the exact fence ACK', async () => {
    control.budgetMs = SHORT_BOUND_MS;
    control.attemptPhase = 'open';
    const a = fakeSession('a', 'th_a');
    controlLoginClose([a]);
    backend.sessions.set(a.environmentPackage.snapshotId, a);
    const fence = deferred<void>();
    vi.mocked(queueNanoHostHarnessOperation).mockResolvedValue(1);
    vi.mocked(drainNanoHostHarnessAdmission).mockReturnValue(fence.promise);

    const closing = backend.queueAndWaitForHarnessOperation(a, 'session.close', {
      agentSessionId: a.environmentPackage.scope.agentSessionId,
      agentSessionRuntimeBindingId: a.agentSessionRuntimeBindingId,
    });
    void closing.catch(() => {});
    await vi.waitFor(() => expect(queueNanoHostHarnessOperation).toHaveBeenCalledTimes(1), POLL);
    await backend.acceptHarnessCommand(closeCommand(a)).catch(() => undefined);
    backend.failHarnessDelivery(closeCommand(a), new Error('delivery lost'));
    expect(drainNanoHostHarnessAdmission).toHaveBeenCalledTimes(1);

    // The waiter rejects at its bound; the ordinary finally runs while the fence is unresolved.
    expect(await settledWithin(closing, 1_000)).toBe(true);
    await expect(closing).rejects.toThrow('NanoHost Login close requires inspection.');
    expect(slots(a).session).toBe('held');
    expect(loginCloseOwns(a)).toBe(true);
    expect(releases).toEqual([]);

    fence.resolve();
    await vi.waitFor(() => expect(releases).toEqual([loginRelease(a)]), POLL);
    expect(slots(a).session).toBe('clear');
    expect(loginCloseOwns(a)).toBe(false);
  });

  it('keeps a session-only close with a failed fence until the fenced Epoch retires it', async () => {
    control.budgetMs = SHORT_BOUND_MS;
    control.attemptPhase = 'open';
    const a = fakeSession('a', 'th_a');
    controlLoginClose([a]);
    backend.sessions.set(a.environmentPackage.snapshotId, a);
    vi.mocked(queueNanoHostHarnessOperation).mockResolvedValue(1);
    vi.mocked(drainNanoHostHarnessAdmission).mockRejectedValue(new Error('fence reply lost'));

    const closing = backend.queueAndWaitForHarnessOperation(a, 'session.close', {
      agentSessionId: a.environmentPackage.scope.agentSessionId,
      agentSessionRuntimeBindingId: a.agentSessionRuntimeBindingId,
    });
    void closing.catch(() => {});
    await vi.waitFor(() => expect(queueNanoHostHarnessOperation).toHaveBeenCalledTimes(1), POLL);
    await backend.acceptHarnessCommand(closeCommand(a)).catch(() => undefined);
    backend.failHarnessDelivery(closeCommand(a), new Error('delivery lost'));
    await expect(closing).rejects.toThrow('NanoHost Login close requires inspection.');
    // The cached rejected fence keeps the only slot; no close owner exists on this path.
    expect(slots(a)).toEqual({ session: 'held', closeOwner: 'clear' });
    expect(loginCloseOwns(a)).toBe(true);
    expect(releases).toEqual([]);

    await backend.invalidatePhysicallyAbsentSandbox({
      sandboxRuntimeId: a.sharedHarness.sandbox.sandboxRuntimeId,
      bindings: [],
    });
    expect(releases).toEqual([loginRelease(a)]);
    expect(loginCloseOwns(a)).toBe(false);
  });

  it('rejects the waiter when a cleanup refusal drain fails, so the exact fence can retire the slots', async () => {
    const a = fakeSession('a', 'th_a');
    controlLoginClose([a]);
    vi.mocked(queueNanoHostHarnessOperation).mockResolvedValue(1);
    vi.mocked(drainNanoHostHarnessAdmission)
      .mockRejectedValueOnce(new Error('cleanup drain reply lost'))
      .mockResolvedValue(undefined);

    const closing = backend.closeDurableAgentSession(inspectionOf(a));
    void closing.catch(() => {});
    await vi.waitFor(() => expect(queueNanoHostHarnessOperation).toHaveBeenCalledTimes(1), POLL);
    await backend.acceptHarnessCommand(closeCommand(a)).catch(() => undefined);
    await expect(
      backend.acceptHarnessResult(closeResult(a, 'refused', { reasonCode: 'cleanup_required' }))
    ).rejects.toThrow('cleanup drain reply lost');

    expect(await settledWithin(closing, 2_000)).toBe(true);
    await expect(closing).rejects.toThrow('NanoHost Login close requires inspection.');
    await vi.waitFor(() => expect(releases).toEqual([loginRelease(a)]), POLL);
    expect(slots(a)).toEqual({ session: 'clear', closeOwner: 'clear' });
    expect(loginCloseOwns(a)).toBe(false);
  });
});

describe('Row 14: a changed resident carries the current admission read', () => {
  const environmentPackage = {
    snapshotId: 'pkg_incoming',
    scope: {
      workspaceId: WORKSPACE,
      threadId: 'th_incoming',
      agentSessionId: 'as_incoming',
      turnId: 'tu_incoming',
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    },
    runtime: { image: { kind: 'reference' } },
    control: { adapter: { targetRuntime: 'codex' } },
    agent: { runtimeVersion: '1.0.0' },
    credentials: { declarations: [] },
  };
  const resident = (name: string) => ({
    sandboxRuntimeId: `sr_${name}`,
    sandboxBindingRef: `sb_${name}`,
    sandboxCompatibilityKey: `key_${name}`,
    originPhysicalEpoch: 'e'.repeat(64),
    physicalAbsent: false,
    target: { targetId: 'rt_local', physicalEpoch: 'e'.repeat(64) },
    bindings: [{ agentSessionRuntimeBindingId: `asrb_${name}` }],
  });

  /** Runs the eviction to its changed-resident refusal and returns the carried refusal. */
  async function changedResidentRefusal(
    current: { value: unknown },
    storage: { value: unknown },
    replacementSelection?: Record<string, unknown>
  ): Promise<SchedulerCapacityRefusal> {
    const target = backend as unknown as Record<string, (...args: never[]) => unknown>;
    const old = resident('a');
    let inspections = 0;
    vi.spyOn(target, 'inspectIncompatibleIdleSandbox' as never).mockImplementation((() => {
      inspections += 1;
      if (inspections === 1) return old;
      if (current.value instanceof Error) throw current.value;
      return current.value;
    }) as never);
    vi.spyOn(target, 'handoffDurableAgentSessionProof' as never).mockResolvedValue(
      undefined as never
    );
    vi.spyOn(target, 'validateWorkerStorageSelection' as never).mockReturnValue({
      storageRef: 'storage_selected',
      revision: 3,
      currentSandboxBindingRef: old.sandboxBindingRef,
    } as never);
    vi.spyOn(target, 'readNanoHost' as never).mockImplementation((() => storage.value) as never);
    // The resident changes under the suspended proof handoff.
    current.value = null;
    const error = await backend
      .evictIncompatibleIdleSandbox(environmentPackage, false, replacementSelection)
      .then(
        () => {
          throw new Error('The changed resident was not refused.');
        },
        (refusal: unknown) => refusal
      );
    // The old-effect guard stops the stale drain post before any refusal shape is read.
    expect(claimNanoHostIdleSandboxDrain).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(WorkerGovernanceCapacityUnavailableError);
    return (error as WorkerGovernanceCapacityUnavailableError).schedulerCapacity!;
  }

  it('stops the stale drain and reads the current capacity for requeue', async () => {
    const current = { value: null as unknown };
    const refusal = await changedResidentRefusal(current, { value: undefined });
    expect(refusal.key).toEqual({ kind: 'backend', backendId: expect.any(String) });
    // Proved empty: one fresh claim may follow.
    current.value = null;
    expect(refusal.stillRefused!()).toBe(false);
    // An eligible replacement resident: one fresh claim may follow.
    current.value = resident('b');
    expect(refusal.stillRefused!()).toBe(false);
    // An occupied replacement or an unreadable target stays held.
    current.value = 'capacity-saturated';
    expect(refusal.stillRefused!()).toBe(true);
    current.value = new Error('target unreadable');
    expect(refusal.stillRefused!()).toBe(true);
  });

  it('reads the selected-storage attachment fact of the same refusal', async () => {
    const current = { value: null as unknown };
    const storage = { value: undefined as unknown };
    const refusal = await changedResidentRefusal(current, storage, {
      storageRef: 'storage_selected',
      expectedRevision: 3,
    });
    // The old resident's attachment is unresolved: no claim.
    current.value = null;
    storage.value = { state: 'attached', currentSandboxBindingRef: 'sb_a' };
    expect(refusal.stillRefused!()).toBe(true);
    storage.value = { state: 'unknown', currentSandboxBindingRef: null };
    expect(refusal.stillRefused!()).toBe(true);
    // The exact attachment ACK made it selectable.
    storage.value = { state: 'idle', currentSandboxBindingRef: null };
    expect(refusal.stillRefused!()).toBe(false);
    // Attached to the replacement resident that this admission replaces.
    current.value = resident('b');
    storage.value = { state: 'attached', currentSandboxBindingRef: 'sb_b' };
    expect(refusal.stillRefused!()).toBe(false);
    // A stale selection keeps its existing disposition: it is no capacity fact.
    current.value = null;
    storage.value = undefined;
    expect(refusal.stillRefused!()).toBe(false);
    storage.value = { state: 'purged', currentSandboxBindingRef: null };
    expect(refusal.stillRefused!()).toBe(false);
  });

  it('keeps the causal capacity refusal through materialization', async () => {
    control.attemptPhase = 'open';
    const target = backend as unknown as Record<string, (...args: never[]) => unknown>;
    vi.spyOn(target, 'planSession' as never).mockReturnValue({
      packageSnapshotId: environmentPackage.snapshotId,
      runtimeTargetId: 'rt_local',
    } as never);
    vi.spyOn(target, 'requireAttemptId' as never).mockReturnValue('attempt_incoming' as never);
    vi.spyOn(target, 'workerStorageAudienceAuthorizer' as never).mockReturnValue(
      (() => true) as never
    );
    vi.spyOn(target, 'requireCurrentBackendPhysicalEpoch' as never).mockReturnValue(
      'e'.repeat(64) as never
    );
    vi.spyOn(target, 'inspectIncompatibleIdleSandbox' as never).mockReturnValue(null as never);
    const causal: SchedulerCapacityRefusal = {
      key: { kind: 'backend', backendId: 'nanohost' },
      stillRefused: () => false,
    };
    const evict = vi.spyOn(target, 'evictIncompatibleIdleSandbox' as never);
    evict.mockRejectedValueOnce(
      new WorkerGovernanceCapacityUnavailableError(
        'NanoHost one-Sandbox capacity is occupied or unproved.',
        causal
      ) as never
    );
    const refused = await backend.materialize(environmentPackage).then(
      () => null,
      (error: unknown) => error
    );
    expect(refused).toMatchObject({
      name: 'WorkerGovernanceCapacityUnavailableError',
      message: 'Incompatible resident cleanup requires exact deletion or Epoch fence proof.',
    });
    expect((refused as WorkerGovernanceCapacityUnavailableError).schedulerCapacity).toBe(causal);

    // A cause without a structured refusal still reads as held.
    evict.mockRejectedValueOnce(new Error('resident cleanup reply lost') as never);
    const held = await backend.materialize(environmentPackage).then(
      () => null,
      (error: unknown) => error
    );
    expect((held as WorkerGovernanceCapacityUnavailableError).schedulerCapacity).toEqual({
      key: { kind: 'backend', backendId: expect.any(String) },
      stillRefused: null,
    });
  });
});
