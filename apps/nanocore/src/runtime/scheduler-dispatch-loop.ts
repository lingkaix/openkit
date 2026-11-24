import { ActivateWorkerEnvironmentResponseSchema } from '@openkit/app-api-schemas';
import type {
  GatewayConfig,
  UserConfig,
  WorkspaceConfig,
  WorkspaceDataSourceCatalog,
  WorkspaceMcpServerCatalog,
} from '@openkit/config-schema';
import {
  allocateEntityId,
  readRetainedV1,
  responsibleUserIdForActor,
  type TurnSchema,
} from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import type { z } from 'zod';
import type { AgentManifest } from '../agents/manifest.js';
import { agentNotReadyMessage, computeReadiness, isAgentLaunchable } from '../agents/readiness.js';
import {
  type AgentSetupResolverDependencies,
  readSupportedAgentSetupFeatures,
  resolveAgentSetup,
} from '../agents/setup-resolver.js';
import { deriveArtifactReviewWorkerRequestId } from '../artifact-reviews.js';
import { currentSchedulerAdmissionWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { canDiscloseThreadToAudience, isThreadIdVisible } from '../auth/thread-visibility.js';
import { isScopeAdmitted } from '../bootstrap/readiness.js';
import { readAssistantTaskHandoffSource } from '../internal-agents/assistant-handoff-source.js';
import { type FsStore, StoreRecordNotFoundError } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import type { ProviderRegistry } from '../providers/registry.js';
import {
  type CoreSchedulerQueueEntry,
  listQueuedSchedulerAdmissionEntries,
  readQueuedSchedulerAdmissionEntriesInOrder,
  requireSchedulerAdmissionEntry,
  SchedulerAdmissionTransitionError,
} from '../scheduler-records.js';
import { assertAgentWorkNotPaused } from '../security/agent-work-pause.js';
import { admitCoreScheduler } from '../storage/control-store-admission.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { ControlStoreWorkerError } from '../storage/control-store-worker-error.js';
import {
  type CoreDb,
  listExistingWorkspaceDatabaseScopes,
  openAdmittedWorkspaceReadDb,
  openWorkspaceReadDb,
} from '../storage/db.js';
import { findExternalTriggerAdmissionForQueue } from '../storage/external-trigger-admissions.js';
import { withTurnDispatchTelemetry } from '../telemetry.js';
import { DeterministicAgentPreparationError } from './agent-preparation-error.js';
import {
  acceptSchedulerExecutionObservation,
  bindSchedulerExecutionAttemptSession,
  closeSchedulerExecutionAttemptWithoutEffects,
  createSchedulerExecutionAttempt,
  createSchedulerSelectionPrefix,
  ExecutionAttemptRefusal,
  markSchedulerExecutionAttemptClosing,
  requireSchedulerExecutionAttempt,
  type SchedulerClaimStage,
  type SchedulerExecutionAttemptRecord,
  schedulerAdmissionQualified,
  schedulerClaimBlocked,
} from './execution-attempts.js';
import type { ExecutionBackend } from './execution-backend.js';
import {
  externalTriggerTurnPublicationComplete,
  readExternalTriggerPollSource,
} from './external-trigger-source.js';
import { applyPreparedHarnessLoginSelection } from './harness-login-selection.js';
import {
  type StartTurnDependencies,
  startTurn,
  type TurnHandle,
  TurnStartValidationError,
  workspaceSourceRefsFromAgentManifest,
} from './orchestrator.js';
import { isRecurringQueueEntry } from './recurring-queue-input.js';
import { recurringTurnPublicationIssue } from './recurring-turn-publication.js';
import {
  classifyClaimReply,
  classifyUnresolvedReadback,
  createHandoffRecord,
  decideHandoff,
  HANDOFF_CLAIM_POST_BUDGET,
  type HandoffCallerResult,
  type HandoffCapacityKey,
  type HandoffClaimIdentity,
  type HandoffEffect,
  type HandoffEvent,
  type HandoffHold,
  type HandoffRecord,
  type HandoffSelection,
  type HandoffSkip,
  type HandoffSource,
} from './scheduler-dispatch-handoff.js';
import { readScheduledAdmissionText } from './scheduler-dispatch-input.js';
import type { PrepareAgentSessionForTurnInput, TurnExecutor } from './types.js';
import {
  WorkerGovernanceCapacityUnavailableError,
  WorkerInputRecoveryRequiredError,
} from './worker-governance-backend.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';

/** Current composition and the exact selected admission; no placement or native proof policy lives here. */
export interface RunSchedulerDispatchLoopInput
  extends Pick<
    AgentSetupResolverDependencies,
    'providerCredentialConfigured' | 'subscriptionAccounts'
  > {
  /** Current persistent containment setting, independent of captured Turn configuration. */
  agentWorkPaused?: () => boolean;
  agentManifests: AgentManifest[];
  coreDb: CoreDb;
  callerQueueEntryId?: string;
  createAgentSessionId?: () => string;
  createAttemptId?: () => string;
  dependencies?: StartTurnDependencies;
  maxDispatches?: number;
  now?: () => string;
  providerRegistry: ProviderRegistry;
  gatewayConfig: GatewayConfig;
  workspaceConfigs?: readonly { workspaceId: string; config: WorkspaceConfig }[];
  userConfigs?: readonly { userId: string; config: UserConfig }[];
  store: FsStore;
  turnExecutor: TurnExecutor;
  executionBackend: ExecutionBackend;
  configVersion?: number | null;
  workspaceDataSourceCatalogs?: readonly {
    workspaceId: string;
    catalog: WorkspaceDataSourceCatalog;
  }[];
  workspaceMcpServerCatalogs?: readonly {
    workspaceId: string;
    catalog: WorkspaceMcpServerCatalog;
  }[];
  onTurnCreated?: (turn: z.infer<typeof TurnSchema>, agentSessionId: string) => void;
  onDispatchAttribution?: (queueEntryId: string | null) => void;
  /** `wake` only for the run that a handoff wake starts; such a pass skips the busy set. */
  dispatchSource?: HandoffSource;
}

/** One exact acquisition and its existing executor's full closeout. */
export interface SchedulerDispatchLoopStartedTurn {
  dispatch: {
    status: 'dispatched';
    entry: CoreSchedulerQueueEntry;
    attempt: SchedulerExecutionAttemptRecord;
  };
  handle: TurnHandle;
}

/** Backend busy remains accepted queued work; another Thread's fence is not a global admission veto. */
export interface SchedulerDispatchLoopResult {
  startedTurns: SchedulerDispatchLoopStartedTurn[];
  terminalResult:
    | {
        status: 'queued';
        reason:
          | 'agent-work-paused'
          | 'no-queued-entry'
          | 'thread-busy'
          | 'backend-busy'
          | 'entry-publication-pending'
          | 'recovery-required'
          | 'max-dispatches';
      }
    | { status: 'denied'; entry: CoreSchedulerQueueEntry };
}

/** Existing process-local invocation claim joins full closeout; no receipt, result, or claim survives its attempt. */
export type SchedulerPreparationClaims = Map<string, Promise<SchedulerDispatchLoopResult>>;
const preparationClaimsByDataRoot = new Map<string, SchedulerPreparationClaims>();
const preparationExpirations = new Map<string, (reason: Error) => void>();

/** Releases an exact stalled local waiter only after durable no-effect closure. */
export function releaseExpiredSchedulerPreparation(coreDb: CoreDb, attemptId: string): void {
  preparationExpirations.get(JSON.stringify([coreDb.dataRoot, attemptId]))?.(
    new TurnStartValidationError(
      'worker_preparation_failed',
      'Worker preparation deadline expired.',
      409
    )
  );
}

/** Returns the existing single-flight preparation owner for this Core data root. */
export function getSchedulerPreparationClaims(coreDb: CoreDb): SchedulerPreparationClaims {
  let claims = preparationClaimsByDataRoot.get(coreDb.dataRoot);
  if (!claims) {
    claims = new Map();
    preparationClaimsByDataRoot.set(coreDb.dataRoot, claims);
  }
  return claims;
}

/** The selected entry of the cycle, with the facts that its post, denial and publication use. */
interface SchedulerSelectionWork {
  readonly input: RunSchedulerDispatchLoopInput;
  readonly entry: CoreSchedulerQueueEntry;
  readonly selectionPrefixDigest: string;
  readonly preparationInput: SchedulerPreparationInput;
  /** The attempt that the claim post returned. */
  attempt?: SchedulerExecutionAttemptRecord;
}

type SchedulerPreparationInput = ReturnType<typeof schedulerPreparationInput>;
type DispatchEvent = HandoffEvent<RunSchedulerDispatchLoopInput, SchedulerDispatchLoopStartedTurn>;
type DispatchEffect = HandoffEffect<
  RunSchedulerDispatchLoopInput,
  SchedulerDispatchLoopStartedTurn
>;

/**
 * The executor of the Main selection handoff of one Core data root. It runs the effects that the
 * pure transition returns and feeds each result back as one event, in queue order. It keeps no
 * copy of a record fact: only caller promises, admission handles and the work of the cycle.
 */
interface SchedulerDispatchHandoff {
  readonly dataRoot: string;
  readonly claims: SchedulerPreparationClaims;
  record: HandoffRecord<RunSchedulerDispatchLoopInput, SchedulerDispatchLoopStartedTurn>;
  readonly events: DispatchEvent[];
  draining: boolean;
  nextCaller: number;
  readonly callers: Map<string, PromiseWithResolvers<SchedulerDispatchLoopResult>>;
  /** Entry to the exact Workspace admission handle that its selection acquired. */
  readonly handles: Map<string, () => void>;
  work: SchedulerSelectionWork | null;
  /** Entry to the refusal predicate read of its last backend-busy settlement (E7). */
  readonly capacityReads: Map<string, () => HandoffCapacityKey | null>;
}

const schedulerDispatchHandoffs = new Map<string, SchedulerDispatchHandoff>();
/** The callers of one pass share one result value, as they share one pass. */
const schedulerPassResults = new WeakMap<object, SchedulerDispatchLoopResult>();
const schedulerDispatchWakes = new Map<string, () => void>();
/** The attempt ID of each published invocation promise, for an exact join and retire. */
const schedulerInvocationIds = new WeakMap<Promise<SchedulerDispatchLoopResult>, string>();

function schedulerDispatchHandoff(coreDb: CoreDb): SchedulerDispatchHandoff {
  let root = schedulerDispatchHandoffs.get(coreDb.dataRoot);
  if (!root) {
    root = {
      dataRoot: coreDb.dataRoot,
      claims: getSchedulerPreparationClaims(coreDb),
      record: createHandoffRecord(HANDOFF_CLAIM_POST_BUDGET),
      events: [],
      draining: false,
      nextCaller: 1,
      callers: new Map(),
      handles: new Map(),
      work: null,
      capacityReads: new Map(),
    };
    schedulerDispatchHandoffs.set(coreDb.dataRoot, root);
  }
  return root;
}

/**
 * Registers the one dispatch retry run that a `wake` effect starts for this Core data root. The
 * effect does not await it.
 */
export function registerSchedulerDispatchWake(coreDb: CoreDb, wake: () => void): () => void {
  schedulerDispatchWakes.set(coreDb.dataRoot, wake);
  return () => {
    if (schedulerDispatchWakes.get(coreDb.dataRoot) === wake)
      schedulerDispatchWakes.delete(coreDb.dataRoot);
  };
}

/**
 * An owner release edge of the holds table. It queues one `released` event on the root of this
 * Core data root and awaits nothing, so an owner can call it while it holds the gate that it
 * releases.
 */
export function releaseSchedulerDispatchHold(
  coreDb: CoreDb,
  hold: HandoffHold,
  key?: HandoffCapacityKey
): void {
  const root = schedulerDispatchHandoffs.get(coreDb.dataRoot);
  if (root) feedSchedulerDispatchLater(root, { kind: 'released', hold, ...(key ? { key } : {}) });
}

/**
 * The backend capacity owner edge (R3, E7) of one Core data root. For each busy entry with a
 * backend key, including a queued held settlement, it reads the refusal predicate of the owner
 * again, without effects. It releases only the entries that read clear, so the remaining entries
 * keep their marks.
 */
export function releaseSchedulerBackendCapacity(coreDb: CoreDb): void {
  const root = schedulerDispatchHandoffs.get(coreDb.dataRoot);
  if (root) {
    const marked = new Map<string, string>();
    for (const [entry, key] of Object.entries(root.record.busy))
      if (key.kind === 'backend') marked.set(entry, key.backendId);
    for (const event of root.events)
      if (
        event.kind === 'settled' &&
        event.outcome === 'backend-busy' &&
        event.capacity.held &&
        event.capacity.key.kind === 'backend'
      )
        marked.set(event.entry, event.capacity.key.backendId);
    for (const entry of root.capacityReads.keys())
      if (!marked.has(entry)) root.capacityReads.delete(entry);
    const cleared = new Map<string, string[]>();
    for (const [entry, backendId] of marked) {
      const read = root.capacityReads.get(entry);
      let key: HandoffCapacityKey | null;
      try {
        key = read ? read() : { kind: 'backend', backendId };
      } catch {
        key = { kind: 'backend', backendId };
      }
      if (key === null) cleared.set(backendId, [...(cleared.get(backendId) ?? []), entry]);
    }
    for (const [backendId, entries] of cleared)
      feedSchedulerDispatchLater(root, {
        kind: 'released',
        hold: 'backend-capacity',
        key: { kind: 'backend', backendId },
        cleared: entries,
      });
  }
}

/**
 * Feeds one event. Events run one at a time in queue order. An effect never calls the transition:
 * an event that an effect produces while the queue drains waits in the queue (E5).
 */
function feedSchedulerDispatch(root: SchedulerDispatchHandoff, event: DispatchEvent): void {
  root.events.push(event);
  if (root.draining) return;
  root.draining = true;
  try {
    while (root.events.length > 0) {
      const decision = decideHandoff(root.record, root.events.shift()!);
      root.record = decision.record;
      const starts: (() => void)[] = [];
      // Every effect of the decision runs, also after an effect throws, so a failed read, barrier
      // or handle release cannot drop the wake of an independently released sibling.
      for (const effect of decision.effects)
        try {
          runSchedulerDispatchEffect(root, effect, starts);
        } catch (error) {
          console.error(
            'scheduler_dispatch_effect_failed',
            effect.kind,
            error instanceof Error ? error.message : 'unknown'
          );
        }
      // E1: a published invocation starts only after its waiters hold its promise.
      for (const start of starts) start();
    }
  } finally {
    root.draining = false;
  }
}

/** Feeds an event from an asynchronous completion; a transition defect is logged, not lost. */
function feedSchedulerDispatchLater(root: SchedulerDispatchHandoff, event: DispatchEvent): void {
  try {
    feedSchedulerDispatch(root, event);
  } catch (error) {
    console.error(
      'scheduler_dispatch_handoff_failed',
      error instanceof Error ? error.message : 'unknown'
    );
  }
}

function runSchedulerDispatchEffect(
  root: SchedulerDispatchHandoff,
  effect: DispatchEffect,
  starts: (() => void)[]
): void {
  switch (effect.kind) {
    case 'select':
      root.events.push(selectSchedulerDispatch(root, effect));
      return;
    case 'post':
      postSchedulerClaim(root, effect);
      return;
    case 'barrier':
      postSchedulerClaimBarrier(root);
      return;
    case 'deny':
      denySchedulerAdmission(root, effect.entry);
      return;
    case 'publish':
      starts.push(publishSchedulerInvocation(root, effect.entry, effect.invocation));
      return;
    case 'release': {
      const release = root.handles.get(effect.entry);
      root.handles.delete(effect.entry);
      release?.();
      return;
    }
    case 'retire': {
      const current = root.claims.get(effect.entry);
      if (current && schedulerInvocationIds.get(current) === effect.invocation)
        root.claims.delete(effect.entry);
      return;
    }
    case 'resolve':
      resolveSchedulerDispatchCaller(root, effect.caller, effect.result);
      return;
    case 'wake': {
      const wake = schedulerDispatchWakes.get(root.dataRoot);
      if (wake) queueMicrotask(wake);
      return;
    }
  }
}

/**
 * The `resolve` effect. The result is fixed in the decision step, so a join names that exact
 * invocation; it reaches the caller one macrotask later, after the microtask closeout of a
 * settled invocation retires it.
 */
function resolveSchedulerDispatchCaller(
  root: SchedulerDispatchHandoff,
  callerId: string,
  result: HandoffCallerResult<SchedulerDispatchLoopStartedTurn>
): void {
  const target = root.callers.get(callerId);
  if (!target) return;
  root.callers.delete(callerId);
  const caller = {
    resolve: (value: SchedulerDispatchLoopResult | Promise<SchedulerDispatchLoopResult>) =>
      setImmediate(() => target.resolve(value)),
    reject: (reason: unknown) => setImmediate(() => target.reject(reason)),
  };
  if (result.kind === 'join') {
    // K1: the full-closeout promise of that exact invocation.
    const invocation = root.claims.get(result.entry);
    if (invocation && schedulerInvocationIds.get(invocation) === result.invocation)
      caller.resolve(invocation);
    else caller.reject(new Error('The joined scheduler invocation is not published.'));
    return;
  }
  const outcome = result.outcome;
  if (outcome.kind === 'refused' || outcome.kind === 'failed') {
    caller.reject(outcome.kind === 'refused' ? outcome.refusal : outcome.cause);
    return;
  }
  const shared = result.kind === 'pass' ? schedulerPassResults.get(outcome) : undefined;
  if (shared) {
    caller.resolve(shared);
    return;
  }
  const startedTurns = result.kind === 'pass' ? [...result.started] : [];
  const value: SchedulerDispatchLoopResult =
    outcome.kind === 'queued'
      ? { startedTurns, terminalResult: { status: 'queued', reason: outcome.reason } }
      : {
          startedTurns,
          terminalResult: { status: 'denied', entry: outcome.denial as CoreSchedulerQueueEntry },
        };
  if (result.kind === 'pass') schedulerPassResults.set(outcome, value);
  caller.resolve(value);
}

/** The preparation input that the claim serializes; its digest is the retained preparation claim. */
function schedulerPreparationInput(
  input: RunSchedulerDispatchLoopInput,
  entry: CoreSchedulerQueueEntry
) {
  const config = schedulerDispatchConfiguration(input, entry);
  return {
    admission: entry,
    configVersion: input.configVersion ?? null,
    manifest: input.agentManifests.find((manifest) => manifest.id === entry.requestedAgentId),
    workspaceConfig: config.workspaceConfig,
    userConfig: config.userConfig,
    workspaceDataSourceCatalog: config.workspaceDataSourceCatalog,
    workspaceMcpServerCatalog: config.workspaceMcpServerCatalog,
  };
}

function schedulerDispatchConfiguration(
  input: RunSchedulerDispatchLoopInput,
  entry: CoreSchedulerQueueEntry
) {
  const responsibleUserId =
    entry.triggerActor.kind === 'user'
      ? entry.triggerActor.id
      : entry.triggerActor.responsibleUserId;
  return {
    workspaceConfig: input.workspaceConfigs?.find(
      (candidate) => candidate.workspaceId === entry.workspaceId
    )?.config,
    userConfig: input.userConfigs?.find((candidate) => candidate.userId === responsibleUserId)
      ?.config,
    workspaceDataSourceCatalog: input.workspaceDataSourceCatalogs?.find(
      (candidate) => candidate.workspaceId === entry.workspaceId
    )?.catalog,
    workspaceMcpServerCatalog: input.workspaceMcpServerCatalogs?.find(
      (candidate) => candidate.workspaceId === entry.workspaceId
    )?.catalog,
  };
}

/** The queued admission representation that the original post of an entry serialized. */
function queuedAdmissionRepresentation(entry: CoreSchedulerQueueEntry): CoreSchedulerQueueEntry {
  return entry.status === 'queued' ? entry : { ...entry, status: 'queued' };
}

function schedulerSelectionWork(
  input: RunSchedulerDispatchLoopInput,
  entry: CoreSchedulerQueueEntry,
  selectionPrefixDigest: string
): SchedulerSelectionWork {
  return {
    input,
    entry,
    selectionPrefixDigest,
    preparationInput: schedulerPreparationInput(input, queuedAdmissionRepresentation(entry)),
  };
}

function preparationDigestOf(work: SchedulerSelectionWork): string {
  return sha256Hex(JSON.stringify(work.preparationInput));
}

/** Main's own checks of one proposal after its Workspace admission handle is held. */
function schedulerProposalCheck(
  input: RunSchedulerDispatchLoopInput,
  entry: CoreSchedulerQueueEntry
):
  | { readonly kind: 'pass' }
  | { readonly kind: 'deny' }
  | { readonly kind: 'skip'; readonly hold: HandoffHold; readonly sourceRecovery: boolean } {
  if (!currentSchedulerAdmissionWorkspaceAuthority(input.coreDb, entry, 'runtime.launch', true))
    return { kind: 'deny' };
  if (entry.backendId !== input.executionBackend.id)
    throw new Error('Queued admission does not name the configured execution backend.');
  // An incomplete cross-store publication fences only its own request/Thread. Continue
  // selecting eligible FIFO work; a receipt gap on A cannot veto independent Thread B.
  const turnInput = readScheduledAdmissionText(input.coreDb, entry);
  if (turnInput === null)
    return { kind: 'skip', hold: 'publication-pending', sourceRecovery: true };
  if (!schedulerEntryPublicationComplete(input, entry, turnInput))
    return {
      kind: 'skip',
      hold: 'publication-pending',
      sourceRecovery:
        isRecurringQueueEntry(input.coreDb, entry.queueEntryId) ||
        !!findExternalTriggerAdmissionForQueue(input.coreDb, entry.queueEntryId),
    };
  // Admission is only early refusal; the live activated policy decides before effects.
  return currentSchedulerDispatchAuthority(input, entry) ? { kind: 'pass' } : { kind: 'deny' };
}

/** Reads the retained claim row of one attempt identity in the selection snapshot. */
function readSchedulerClaimRow(
  coreDb: CoreDb,
  entryId: string,
  claim: HandoffClaimIdentity
): 'none' | 'exact' | 'other' {
  const row = coreDb.sqlite
    .prepare(`SELECT attempt.queue_entry_id AS queueEntryId,
      json_extract(claim.invocation_json, '$.carriage.schedulerPreparation') AS claim
    FROM scheduler_execution_attempts AS attempt
    LEFT JOIN control_execution_steps AS claim
      ON claim.execution_id = 'scheduler-lifecycle:' || attempt.attempt_id
      AND claim.step_id = 'claim' AND claim.state = 'completed'
    WHERE attempt.attempt_id = ?`)
    .get(claim.attemptId) as { queueEntryId: string; claim: string | null } | undefined;
  if (!row) return 'none';
  if (row.queueEntryId !== entryId || row.claim === null) return 'other';
  const retained = JSON.parse(row.claim) as {
    readonly queueEntryId?: unknown;
    readonly admissionHash?: unknown;
    readonly preparationDigest?: unknown;
  };
  return retained.queueEntryId === entryId &&
    retained.admissionHash === claim.inputHash &&
    retained.preparationDigest === claim.preparationDigest
    ? 'exact'
    : 'other';
}

/** The `select` effect: one synchronous Core read transaction that ends before any post. */
function selectSchedulerDispatch(
  root: SchedulerDispatchHandoff,
  effect: Extract<DispatchEffect, { kind: 'select' }>
): DispatchEvent {
  // An inspection snapshot that cannot open fails the inspection of every unresolved claim.
  const failure = { entry: null as string | null, inspections: Object.keys(effect.unresolved) };
  try {
    const input = effect.snapshot;
    if (!input) throw new Error('The scheduler selection has no trigger snapshot.');
    return input.coreDb.sqlite
      .transaction(() => readSchedulerDispatchSelection(root, input, effect, failure))
      .deferred();
  } catch (cause) {
    return {
      kind: 'failed',
      stage: 'select',
      entry: failure.entry,
      cause,
      inspections: failure.inspections,
    };
  }
}

function readSchedulerDispatchSelection(
  root: SchedulerDispatchHandoff,
  input: RunSchedulerDispatchLoopInput,
  effect: Extract<DispatchEffect, { kind: 'select' }>,
  failure: { entry: string | null; inspections: string[] }
): DispatchEvent {
  failure.inspections = [];
  const db = input.coreDb;
  const skipped: HandoffSkip[] = [];
  const discharged: string[] = [];
  const recovered: string[] = [];
  const selected = (selection: HandoffSelection): DispatchEvent => ({
    kind: 'selected',
    selection,
    skipped,
    discharged,
    recovered,
  });
  // The pause can take effect while a pass waits. A queued entry keeps its admission with no attempt.
  if (input.agentWorkPaused?.()) return selected({ kind: 'paused' });
  // Preparation is single-flight. Keep its invocation promise through closeout so product observers cannot mistake a terminal row for finished output and backend handoff.
  if (
    [...root.claims.keys()].some((queueEntryId) =>
      db.sqlite
        .prepare(
          "SELECT 1 FROM scheduler_execution_attempts WHERE queue_entry_id = ? AND phase = 'open' AND deadline IS NULL"
        )
        .get(queueEntryId)
    )
  )
    return selected({ kind: 'preparing' });
  // Read every unresolved claim by attempt ID before the walk: a committed original is already
  // admitted and is no longer a queued row.
  const held = new Set<string>();
  const walkClaims = new Set<string>();
  const noRow = new Set<string>();
  let barrier = false;
  for (const [entryId, claim] of Object.entries(effect.unresolved)) {
    failure.entry = entryId;
    failure.inspections = [entryId];
    const row = readSchedulerClaimRow(db, entryId, claim);
    if (row === 'none') noRow.add(entryId);
    const current = listSchedulerAdmissionEntry(db, entryId);
    const replayAfterUnknown = effect.replayEntry === entryId;
    const replay =
      replayAfterUnknown && row === 'exact' && current
        ? acquireImmediateReplay(root, input, current, claim)
        : null;
    const disposition = classifyUnresolvedReadback({
      replayAfterUnknown,
      row,
      checksPass: replay !== null,
      proofCovers: effect.barrierProof?.includes(entryId) === true,
      queued: current?.status === 'queued',
      walkCandidate: 'pending',
      sameDigest: false,
      barrierAllowed: effect.barrierAllowed,
    });
    if (disposition === 'immediate-replay' && replay) {
      root.handles.set(entryId, replay.release);
      root.work = replay.work;
      return selected({
        kind: 'claim',
        entry: entryId,
        identity: claimIdentity(claim),
        retained: true,
      });
    }
    replay?.release();
    if (disposition === 'discharge-recovery') recovered.push(entryId);
    else if (disposition === 'discharge') discharged.push(entryId);
    else if (disposition === 'barrier') barrier = true;
    else if (disposition === 'walk') walkClaims.add(entryId);
    else held.add(entryId);
  }
  failure.entry = null;
  failure.inspections = [];
  const covered = () =>
    Object.keys(effect.unresolved).filter(
      (entryId) => noRow.has(entryId) && effect.barrierProof?.includes(entryId) !== true
    );
  if (barrier) return selected({ kind: 'barrier', covered: covered() });
  // Walk one Core read snapshot in insertion order. Each Core-satisfiable admission gets Main's
  // own checks. The first admission that passes them is the proposal. Every satisfiable
  // predecessor that Main skipped goes into the selection prefix that Core verifies.
  const prefix = createSchedulerSelectionPrefix();
  for (const entry of readQueuedSchedulerAdmissionEntriesInOrder(db)) {
    if (schedulerClaimBlocked(db, entry)) continue;
    const entryId = entry.queueEntryId;
    failure.entry = entryId;
    failure.inspections = effect.unresolved[entryId] ? [entryId] : [];
    // Core applies the same backend and authority qualification to each predecessor. A skipped
    // admission goes into the prefix only if Core also counts it as satisfiable.
    const qualified = schedulerAdmissionQualified(db, entry);
    const skip = (hold: HandoffHold, sourceRecovery = false) => {
      if (qualified) prefix.add(entry);
      skipped.push(
        sourceRecovery ? { entry: entryId, hold, sourceRecovery } : { entry: entryId, hold }
      );
    };
    let release: (() => void) | undefined;
    try {
      if (effect.recovery.includes(entryId) || held.has(entryId)) {
        skip('unresolved-claim');
        continue;
      }
      if (!isScopeAdmitted(db.dataRoot, 'workspace', entry.workspaceId)) {
        // Retain the admission and all exclusion; only this process-local selection is skipped.
        skip('scope-not-admitted');
        continue;
      }
      // A live local invocation owns this admission.
      if (root.claims.has(entryId)) {
        skip('local-invocation');
        continue;
      }
      // A pass that only wakes requested skips the busy set; intake and the timer do not.
      if (effect.skipBusy && effect.busy[entryId]) {
        skip('backend-capacity');
        continue;
      }
      try {
        release = input.store.enterWorkspaceMutation(entry.workspaceId);
      } catch (error) {
        if (!(error instanceof OperationError) || error.code !== 'workspace_frozen') throw error;
        skip('frozen-workspace');
        continue;
      }
      const check = schedulerProposalCheck(input, entry);
      if (check.kind === 'skip') {
        skip(check.hold, check.sourceRecovery);
        continue;
      }
      const work = schedulerSelectionWork(input, entry, prefix.digest());
      const claim = walkClaims.has(entryId) ? effect.unresolved[entryId] : undefined;
      if (claim) {
        // An unresolved entry is never denied: its disposition stays recovery-required.
        const disposition =
          check.kind === 'deny'
            ? 'hold'
            : classifyUnresolvedReadback({
                replayAfterUnknown: false,
                row: 'none',
                checksPass: false,
                proofCovers: false,
                queued: true,
                walkCandidate: 'yes',
                sameDigest: preparationDigestOf(work) === claim.preparationDigest,
                barrierAllowed: effect.barrierAllowed,
              });
        if (disposition === 'replay') {
          root.handles.set(entryId, release!);
          release = undefined;
          root.work = work;
          return selected({
            kind: 'claim',
            entry: entryId,
            identity: claimIdentity(claim),
            retained: true,
          });
        }
        if (disposition === 'barrier') return selected({ kind: 'barrier', covered: covered() });
        skip('unresolved-claim');
        continue;
      }
      // The authority read can fail on its source owner, so the Workspace admission transfers to
      // the proposal only after the read returns.
      root.handles.set(entryId, release!);
      release = undefined;
      root.work = work;
      if (check.kind === 'deny') return selected({ kind: 'deny', entry: entryId });
      return selected({
        kind: 'claim',
        entry: entryId,
        identity: {
          attemptId: (input.createAttemptId ?? (() => allocateEntityId('attempt')))(),
          inputHash: entry.inputHash,
          preparationDigest: preparationDigestOf(work),
        },
        retained: false,
      });
    } finally {
      release?.();
    }
  }
  failure.entry = null;
  return selected({
    kind: 'none',
    queuedRemain: listQueuedSchedulerAdmissionEntries(db).length > 0,
  });
}

function claimIdentity(claim: HandoffClaimIdentity): HandoffClaimIdentity {
  return {
    attemptId: claim.attemptId,
    inputHash: claim.inputHash,
    preparationDigest: claim.preparationDigest,
  };
}

function listSchedulerAdmissionEntry(
  coreDb: CoreDb,
  queueEntryId: string
): CoreSchedulerQueueEntry | null {
  try {
    return requireSchedulerAdmissionEntry(coreDb, queueEntryId);
  } catch (error) {
    if (error instanceof SchedulerAdmissionTransitionError) return null;
    throw error;
  }
}

/**
 * The immediate replay of an exact committed row: the current pause, authority, eligibility and
 * proposal-digest checks pass, with its Workspace admission handle held.
 */
function acquireImmediateReplay(
  root: SchedulerDispatchHandoff,
  input: RunSchedulerDispatchLoopInput,
  entry: CoreSchedulerQueueEntry,
  claim: HandoffClaimIdentity
): { readonly work: SchedulerSelectionWork; readonly release: () => void } | null {
  if (!isScopeAdmitted(input.coreDb.dataRoot, 'workspace', entry.workspaceId)) return null;
  if (root.claims.has(entry.queueEntryId)) return null;
  let release: (() => void) | undefined;
  try {
    release = input.store.enterWorkspaceMutation(entry.workspaceId);
  } catch (error) {
    if (!(error instanceof OperationError) || error.code !== 'workspace_frozen') throw error;
    return null;
  }
  try {
    const work = schedulerSelectionWork(input, entry, createSchedulerSelectionPrefix().digest());
    if (
      schedulerProposalCheck(input, entry).kind !== 'pass' ||
      preparationDigestOf(work) !== claim.preparationDigest
    )
      return null;
    const handle = release;
    release = undefined;
    return { work, release: handle };
  } finally {
    release?.();
  }
}

/** The `post` effect: the claim command, whose reply class is a function of its stage and outcome. */
function postSchedulerClaim(
  root: SchedulerDispatchHandoff,
  effect: Extract<DispatchEffect, { kind: 'post' }>
): void {
  const work = root.work;
  const stage: SchedulerClaimStage = { current: 'prepare' };
  let posted: Promise<SchedulerExecutionAttemptRecord>;
  try {
    if (!work || work.entry.queueEntryId !== effect.entry)
      throw new Error('The scheduler claim has no selected admission.');
    work.input.onDispatchAttribution?.(effect.entry);
    posted = createSchedulerExecutionAttempt(
      work.input.coreDb,
      {
        entry: work.entry,
        attemptId: effect.identity.attemptId,
        preparationInput: work.preparationInput,
        selectionPrefixDigest: work.selectionPrefixDigest,
        ...(work.input.now ? { now: work.input.now } : {}),
      },
      stage
    );
  } catch (error) {
    posted = Promise.reject(error);
  }
  posted.then(
    (attempt) => {
      if (work) work.attempt = attempt;
      feedSchedulerDispatchLater(root, {
        kind: 'reply',
        // A replay can return an original that another owner has already advanced or closed.
        // Only an untouched pre-submit claim continues; a fresh scan decides the entry again.
        replyClass: classifyClaimReply({
          kind: 'attempt',
          openWithoutProgress:
            attempt.phase === 'open' &&
            attempt.deadline === null &&
            attempt.operationId === null &&
            attempt.agentSessionId === null,
        }),
      });
    },
    (error: unknown) => feedSchedulerDispatchLater(root, schedulerClaimFailureReply(error, stage))
  );
}

function schedulerClaimFailureReply(error: unknown, stage: SchedulerClaimStage): DispatchEvent {
  if (error instanceof ExecutionAttemptRefusal)
    return {
      kind: 'reply',
      replyClass: classifyClaimReply({ kind: 'refusal', reason: error.reason ?? null }),
      refusal: error,
    };
  return {
    kind: 'reply',
    replyClass: classifyClaimReply({
      kind: 'error',
      stage: stage.current,
      commit: error instanceof ControlStoreWorkerError ? error.commit : 'untyped',
    }),
    cause: error,
  };
}

/** The `barrier` effect: the null observation on the same admitted Core writer, after every earlier post. */
function postSchedulerClaimBarrier(root: SchedulerDispatchHandoff): void {
  let posted: Promise<unknown>;
  try {
    const snapshot = root.record.snapshot;
    if (!snapshot) throw new Error('The scheduler barrier has no trigger snapshot.');
    posted = acceptSchedulerExecutionObservation(snapshot.coreDb, null);
  } catch (error) {
    posted = Promise.reject(error);
  }
  posted.then(
    () => feedSchedulerDispatchLater(root, { kind: 'barrier', acknowledged: true }),
    () => feedSchedulerDispatchLater(root, { kind: 'barrier', acknowledged: false })
  );
}

/** The `deny` effect: the existing queued denial of the entry. */
function denySchedulerAdmission(root: SchedulerDispatchHandoff, entryId: string): void {
  let denied: Promise<CoreSchedulerQueueEntry>;
  try {
    const work = root.work;
    if (!work || work.entry.queueEntryId !== entryId)
      throw new Error('The scheduler denial has no selected admission.');
    denied = admitCoreScheduler(work.input.coreDb, {
      mode: 'deny',
      queueEntryId: entryId,
      denialReason: 'authority-denied',
    }).then((result) => {
      if (result.kind !== 'queue')
        throw new Error('Scheduler publication returned another family.');
      return result.entry;
    });
  } catch (error) {
    denied = Promise.reject(error);
  }
  denied.then(
    (entry) => feedSchedulerDispatchLater(root, { kind: 'denied', denial: entry }),
    (cause: unknown) =>
      feedSchedulerDispatchLater(root, {
        kind: 'failed',
        stage: 'deny',
        entry: entryId,
        cause,
        inspections: [],
      })
  );
}

/**
 * The `publish` effect (E1): installs the invocation promise in the existing preparation claim
 * set. The returned start runs the claimed continuation after the waiters hold the promise.
 */
function publishSchedulerInvocation(
  root: SchedulerDispatchHandoff,
  entryId: string,
  invocationId: string
): () => void {
  const work = root.work;
  let start!: () => void;
  const invocation = new Promise<SchedulerDispatchLoopResult>((resolve, reject) => {
    start = () => {
      try {
        if (!work?.attempt || work.attempt.attemptId !== invocationId)
          throw new Error('The scheduler invocation has no claimed attempt.');
        const attempt = work.attempt;
        resolve(
          withTurnDispatchTelemetry(work.entry.turnId, () =>
            continueSchedulerAdmission(work.input, work.entry, attempt, (result) =>
              feedSchedulerDispatchLater(root, {
                kind: 'submitted',
                invocation: invocationId,
                turn: result.startedTurns[0]!,
              })
            )
          )
        );
      } catch (error) {
        reject(error);
      }
    };
  });
  schedulerInvocationIds.set(invocation, invocationId);
  root.claims.set(entryId, invocation);
  invocation.then(
    (result) =>
      feedSchedulerDispatchLater(
        root,
        schedulerSettlement(root, work, entryId, invocationId, result)
      ),
    (cause: unknown) => {
      // A failure after the submission result reached the pass has no other observer.
      if (!Object.values(root.record.passes).some((pass) => pass.parkedOn === invocationId))
        console.error(
          'scheduler_dispatch_failed_after_admission',
          cause instanceof Error ? cause.message : 'unknown'
        );
      feedSchedulerDispatchLater(root, {
        kind: 'settled',
        entry: entryId,
        invocation: invocationId,
        outcome: 'failed',
        cause,
      });
    }
  );
  return start;
}

/** Maps the full closeout of one invocation to its settlement event. */
function schedulerSettlement(
  root: SchedulerDispatchHandoff,
  work: SchedulerSelectionWork | null,
  entryId: string,
  invocationId: string,
  result: SchedulerDispatchLoopResult
): DispatchEvent {
  const base = { kind: 'settled', entry: entryId, invocation: invocationId } as const;
  const reason = result.terminalResult.status === 'queued' ? result.terminalResult.reason : null;
  if (reason === 'max-dispatches') {
    const turn = result.startedTurns[0];
    return { ...base, outcome: 'dispatched', ...(turn ? { turn } : {}) };
  }
  if (reason === 'recovery-required') return { ...base, outcome: 'recovery-required' };
  if (reason === 'backend-busy' && work)
    // E7: the held fact of the refusing key, read in the same synchronous step that queues it.
    return { ...base, outcome: 'backend-busy', capacity: readSchedulerCapacityHold(root, work) };
  return {
    ...base,
    outcome: 'failed',
    cause: new Error('The scheduler invocation returned an unexpected result.'),
  };
}

/**
 * The refusing capacity key of a busy entry and whether its owner still holds it, read from the
 * side-effect-free refusal predicate of the backend owner. A backend without the predicate, or a
 * predicate that throws, reads as held, so only a timer or intake pass retries the entry.
 */
function readSchedulerCapacityHold(
  root: SchedulerDispatchHandoff,
  work: SchedulerSelectionWork
): {
  readonly key: HandoffCapacityKey;
  readonly held: boolean;
} {
  const backend: HandoffCapacityKey = { kind: 'backend', backendId: work.entry.backendId };
  const executionBackend = work.input.executionBackend;
  const thread = { workspaceId: work.entry.workspaceId, threadId: work.entry.threadId };
  const read = (): HandoffCapacityKey | null =>
    executionBackend.readSchedulerCapacityHold
      ? executionBackend.readSchedulerCapacityHold(thread)
      : backend;
  root.capacityReads.set(work.entry.queueEntryId, read);
  try {
    const key = read();
    return key === null ? { key: backend, held: false } : { key, held: true };
  } catch {
    return { key: backend, held: true };
  }
}

/** Dispatches eligible FIFO work through an attempt persisted before its preparation effects. */
export async function runSchedulerDispatchLoop(
  input: RunSchedulerDispatchLoopInput
): Promise<SchedulerDispatchLoopResult> {
  const root = schedulerDispatchHandoff(input.coreDb);
  const caller = `caller:${root.nextCaller++}`;
  const result = Promise.withResolvers<SchedulerDispatchLoopResult>();
  root.callers.set(caller, result);
  try {
    feedSchedulerDispatch(root, {
      kind: 'trigger',
      caller,
      entry: input.callerQueueEntryId ?? null,
      snapshot: input,
      max: input.maxDispatches ?? 1,
      source: input.dispatchSource ?? 'external',
    });
  } catch (error) {
    root.callers.delete(caller);
    throw error;
  }
  return result.promise;
}

/** Checks the existing receipt or receipt-free source tuple without inventing a second ready flag. */
function schedulerEntryPublicationComplete(
  input: RunSchedulerDispatchLoopInput,
  entry: CoreSchedulerQueueEntry,
  turnInput: string
): boolean {
  if (isRecurringQueueEntry(input.coreDb, entry.queueEntryId)) {
    return recurringTurnPublicationIssue(input.coreDb, input.store, entry) === null;
  }
  const eventAdmission = findExternalTriggerAdmissionForQueue(input.coreDb, entry.queueEntryId);
  if (eventAdmission)
    return externalTriggerTurnPublicationComplete(input.coreDb, input.store, eventAdmission);
  try {
    const turn = input.store.getTurn(entry.workspaceId, entry.threadId, entry.turnId);
    if (turn.status !== 'pending' || turn.agentId !== entry.requestedAgentId) return false;
  } catch (error) {
    if (error instanceof StoreRecordNotFoundError) return false;
    throw error;
  }
  const workspaceDb = openWorkspaceReadDb(input.coreDb.dataRoot, entry.workspaceId);
  try {
    const receipts = workspaceDb.sqlite
      .prepare(
        'SELECT response_id AS responseId, response_json AS responseJson FROM idempotency_requests WHERE request_id = ?'
      )
      .all(entry.requestId) as Array<{ responseId: string; responseJson: string | null }>;
    if (
      receipts.some(
        (receipt) =>
          receipt.responseId === entry.turnId ||
          (receipt.responseJson &&
            JSON.parse(receipt.responseJson)?.downstream?.turnId === entry.turnId)
      )
    )
      return true;
    const reviewReceipts = workspaceDb.sqlite
      .prepare(`SELECT review.decision_request_id AS decisionRequestId FROM artifact_reviews AS review
      JOIN idempotency_requests AS receipt ON receipt.request_id = review.decision_request_id
        AND receipt.command_name = 'artifact.review.decide' AND receipt.response_kind = 'artifact_review'
        AND receipt.response_id = review.review_id
      WHERE review.workspace_id = ? AND review.source_thread_id = ? AND review.follow_up_turn_id = ?
        AND review.source_agent_id = ?`)
      .all(entry.workspaceId, entry.threadId, entry.turnId, entry.requestedAgentId) as Array<{
      decisionRequestId: string;
    }>;
    if (
      reviewReceipts.some(
        (receipt) =>
          deriveArtifactReviewWorkerRequestId(receipt.decisionRequestId) === entry.requestId
      )
    )
      return true;
    if (readAssistantTaskHandoffSource(input.store, workspaceDb, { ...entry, turnInput }))
      return true;
    if (activationPublicationComplete(input, entry, turnInput)) return true;
    const checkpoint = workspaceDb.sqlite
      .prepare(
        'SELECT goal_id AS goalId, task_id AS taskId FROM worker_turn_checkpoints WHERE workspace_id = ? AND thread_id = ? AND turn_id = ? AND request_id = ?'
      )
      .get(entry.workspaceId, entry.threadId, entry.turnId, entry.requestId) as
      | { goalId: string | null; taskId: string | null }
      | undefined;
    if (checkpoint?.goalId && checkpoint.taskId) return true;
    const outcome = workspaceDb.sqlite
      .prepare(
        "SELECT schema_version AS schemaVersion FROM pending_requests WHERE workspace_id = ? AND thread_id = ? AND delivery_turn_id = ? AND delivery_cause = 'outcome' LIMIT 1"
      )
      .get(entry.workspaceId, entry.threadId, entry.turnId);
    return outcome ? readRetainedV1(outcome, () => true) : false;
  } finally {
    workspaceDb.sqlite.close();
  }
}

/** Resolves the existing administrator-home activation receipt and immutable result for its queued successor. */
function activationPublicationComplete(
  input: RunSchedulerDispatchLoopInput,
  entry: CoreSchedulerQueueEntry,
  turnInput: string
): boolean {
  for (const workspace of listExistingWorkspaceDatabaseScopes(input.coreDb.dataRoot)) {
    const db = openWorkspaceReadDb(input.coreDb.dataRoot, workspace.workspaceId);
    try {
      const receipts = db.sqlite
        .prepare(`SELECT response_id AS artifactId FROM idempotency_requests
        WHERE command_name = 'worker_environment.activate' AND request_id = ? AND response_kind = 'artifact'
        AND json_extract(scope_json, '$.actorId') = ?`)
        .all(entry.requestId, responsibleUserIdForActor(entry.triggerActor)) as Array<{
        artifactId: string;
      }>;
      for (const receipt of receipts) {
        const artifact = input.store.getArtifact(workspace.workspaceId, receipt.artifactId);
        if (
          artifact.content.format !== 'json' ||
          artifact.lastMutationRequestId !== entry.requestId
        )
          continue;
        const result = ActivateWorkerEnvironmentResponseSchema.safeParse(
          JSON.parse(artifact.content.body)
        );
        if (
          result.success &&
          result.data.requestId === entry.requestId &&
          result.data.replaceNow?.workspaceId === entry.workspaceId &&
          result.data.replaceNow.threadId === entry.threadId &&
          result.data.replaceNow.prompt === turnInput &&
          result.data.target.agentId === entry.requestedAgentId
        )
          return true;
      }
    } finally {
      db.sqlite.close();
    }
  }
  return false;
}

/** Re-evaluates live Core eligibility and activated Thread policy at the execution boundary. */
function currentSchedulerDispatchAuthority(
  input: RunSchedulerDispatchLoopInput,
  entry: CoreSchedulerQueueEntry
): boolean {
  const authority = currentSchedulerAdmissionWorkspaceAuthority(
    input.coreDb,
    entry,
    'runtime.launch',
    true
  );
  const userId = responsibleUserIdForActor(entry.triggerActor);
  if (!authority || !userId) return false;
  if (
    !isThreadIdVisible(
      input.store,
      entry.workspaceId,
      entry.threadId,
      userId,
      authority === 'administrator',
      'turn.run'
    )
  )
    return false;
  const external = findExternalTriggerAdmissionForQueue(input.coreDb, entry.queueEntryId);
  if (!external) return true;
  // The accepted source remains the visibility origin; admission never freezes its policy.
  const { entry: source } = readExternalTriggerPollSource(input.coreDb, external.sourceTurnId);
  if (source.workspaceId !== entry.workspaceId) return false;
  const sourceThread = input.store.getThread(source.workspaceId, source.threadId);
  return (
    isThreadIdVisible(input.store, source.workspaceId, source.threadId, userId) &&
    canDiscloseThreadToAudience(input.store, sourceThread, null)
  );
}

/** Keeps preparation, submission, and Turn closeout with their current executor owner. */
async function continueSchedulerAdmission(
  input: RunSchedulerDispatchLoopInput,
  entry: CoreSchedulerQueueEntry,
  attempt: SchedulerExecutionAttemptRecord,
  acknowledgeSubmission: (result: SchedulerDispatchLoopResult) => void
): Promise<SchedulerDispatchLoopResult> {
  const { workspaceConfig, userConfig, workspaceDataSourceCatalog, workspaceMcpServerCatalog } =
    schedulerDispatchConfiguration(input, entry);
  const expiration = Promise.withResolvers<never>();
  const expirationKey = JSON.stringify([input.coreDb.dataRoot, attempt.attemptId]);
  preparationExpirations.set(expirationKey, expiration.reject);
  try {
    const setup = resolveDispatchAgentSetup(
      input,
      entry.requestedAgentId,
      entry.profileRef,
      entry.modelId,
      entry.workspaceId,
      workspaceConfig,
      userConfig
    );
    const workspaceSourceRefs = workspaceSourceRefsFromAgentManifest(
      setup.manifest,
      entry.workspaceRoots
    );
    if (!input.turnExecutor.prepareAgentSessionForTurn)
      throw new Error('Configured executor has no AgentSession preparation owner.');
    // Both boundaries use the same existing classified denial for this one attempt.
    const authorityDenial = new TurnStartValidationError(
      'workspace_access_denied',
      'Workspace access denied.',
      403
    );
    // Attempt creation awaited the native owner; policy may have changed before Host work.
    assertAgentWorkNotPaused(input.agentWorkPaused?.());
    if (!currentSchedulerDispatchAuthority(input, entry)) throw authorityDenial;
    const freshAgentSessionId = (input.createAgentSessionId ?? (() => allocateEntityId('as')))();
    const turnInput = readScheduledAdmissionText(input.coreDb, entry);
    if (turnInput === null) throw new WorkerInputRecoveryRequiredError();
    const preparation: PrepareAgentSessionForTurnInput = {
      attemptId: attempt.attemptId,
      agentSetup: setup,
      freshAgentSessionId,
      requestId: entry.requestId,
      turn: input.store.getTurnById(entry.turnId),
      turnInput,
      workspaceCwd: entry.workspaceCwd,
      workspaceRoots: entry.workspaceRoots,
      ...(entry.workerStorageChoice ? { workerStorageChoice: entry.workerStorageChoice } : {}),
      ...(workspaceDataSourceCatalog ? { workspaceDataSourceCatalog } : {}),
      ...(workspaceMcpServerCatalog ? { workspaceMcpServerCatalog } : {}),
      ...(workspaceSourceRefs ? { workspaceSourceRefs } : {}),
    };
    const prepared = await Promise.race([
      input.turnExecutor.prepareAgentSessionForTurn(input.store, preparation),
      expiration.promise,
    ]);
    await bindSchedulerExecutionAttemptSession(input.coreDb, {
      attemptId: attempt.attemptId,
      agentSessionId: prepared.agentSessionId,
    });
    const committed = await Promise.race([
      input.turnExecutor.commitPreparedAgentSessionForTurn?.(input.store, {
        attemptId: attempt.attemptId,
        prepared,
        preparation,
      }),
      expiration.promise,
    ]);
    if (
      requireSchedulerExecutionAttempt(input.coreDb, attempt.attemptId).terminalCause ===
      'preparation-deadline'
    )
      throw new TurnStartValidationError(
        'worker_preparation_failed',
        'Worker preparation deadline expired.',
        409
      );
    if (prepared.replacementRequired && !input.turnExecutor.commitPreparedAgentSessionForTurn)
      throw new Error('Configured executor has no AgentSession replacement owner.');
    // Echo the same frozen grant that startTurn checks against its canonical setup and ledger.
    const effectiveSetup = prepared.harnessLoginSelection
      ? applyPreparedHarnessLoginSelection(setup, prepared.harnessLoginSelection)
      : setup;
    const current = requireSchedulerAdmissionEntry(input.coreDb, entry.queueEntryId);
    assertAgentWorkNotPaused(input.agentWorkPaused?.());
    if (!currentSchedulerDispatchAuthority(input, current)) throw authorityDenial;
    const admittedDb = openAdmittedWorkspaceReadDb(input.coreDb.dataRoot, entry.workspaceId);
    admittedDb.sqlite.close();
    const handle = await startTurn({
      assertAgentWorkAvailable: () => assertAgentWorkNotPaused(input.agentWorkPaused?.()),
      onSubmissionSettled: () => {
        const settled = requireSchedulerExecutionAttempt(input.coreDb, attempt.attemptId);
        // Preparation effects can also be accepted; only submit fixes the absolute deadline.
        if (
          settled.phase !== 'open' ||
          settled.disposition !== 'accepted' ||
          settled.deadline === null
        )
          return;
        acknowledgeSubmission({
          startedTurns: [
            {
              dispatch: { status: 'dispatched', entry: current, attempt: settled },
              handle: {
                turn: input.store.getTurnById(entry.turnId),
                agent: effectiveSetup.manifest,
                agentSetup: effectiveSetup,
                agentSetupRecordId: `ras_${entry.turnId}`,
                agentSetupDiagnostics: [],
                modelId: effectiveSetup.logicalModels.preferredLogicalModelId ?? null,
                readiness: computeReadiness(effectiveSetup.manifest),
              },
            },
          ],
          terminalResult: { status: 'queued', reason: 'max-dispatches' },
        });
      },
      attemptId: attempt.attemptId,
      agentSessionId: prepared.agentSessionId,
      agentId: entry.requestedAgentId,
      agentManifests: input.agentManifests,
      agentSetupLedger: {
        openWorkspaceDb: () =>
          openAdmittedWorkspaceReadDb(input.coreDb.dataRoot, entry.workspaceId),
        writer: getControlStoreWorkerClient(),
      },
      gatewayConfig: input.gatewayConfig,
      input: turnInput,
      modelId: entry.modelId,
      ...(entry.reasoningEffort !== undefined ? { reasoningEffort: entry.reasoningEffort } : {}),
      profileId: entry.profileRef,
      providerRegistry: input.providerRegistry,
      providerCredentialConfigured: input.providerCredentialConfigured,
      subscriptionAccounts: input.subscriptionAccounts,
      requestId: entry.requestId,
      sessionCompatibilityKey: prepared.sessionCompatibilityKey,
      ...(prepared.harnessLoginSelection
        ? { harnessLoginSelection: prepared.harnessLoginSelection }
        : {}),
      store: input.store,
      threadId: entry.threadId,
      triggerActor: entry.triggerActor,
      turnExecutor: input.turnExecutor,
      turnId: entry.turnId,
      workspaceCwd: entry.workspaceCwd,
      workerStorageChoice: committed ?? entry.workerStorageChoice ?? undefined,
      workspaceId: entry.workspaceId,
      ...(workspaceConfig ? { workspaceConfig } : {}),
      ...(userConfig ? { userConfig } : {}),
      workspaceRoots: entry.workspaceRoots,
      ...(workspaceDataSourceCatalog ? { workspaceDataSourceCatalog } : {}),
      ...(workspaceMcpServerCatalog ? { workspaceMcpServerCatalog } : {}),
      ...(workspaceSourceRefs ? { workspaceSourceRefs } : {}),
      configVersion: input.configVersion ?? null,
      ...(input.dependencies ? { dependencies: input.dependencies } : {}),
    });
    return {
      startedTurns: [
        {
          dispatch: {
            status: 'dispatched',
            entry: current,
            attempt: requireSchedulerExecutionAttempt(input.coreDb, attempt.attemptId),
          },
          handle,
        },
      ],
      terminalResult: { status: 'queued', reason: 'max-dispatches' },
    };
  } catch (error) {
    const current = requireSchedulerExecutionAttempt(input.coreDb, attempt.attemptId);
    // Recovery owns the expired attempt and its original Turn after the persisted fence.
    if (current.terminalCause === 'preparation-deadline') throw error;
    if (
      error instanceof WorkerInputRecoveryRequiredError &&
      current.phase === 'open' &&
      current.operationId === null
    )
      return {
        startedTurns: [],
        terminalResult: { status: 'queued', reason: 'recovery-required' },
      };
    if (
      error instanceof WorkerGovernanceCapacityUnavailableError &&
      current.phase === 'open' &&
      current.operationId === null &&
      input.store.getTurnById(entry.turnId).status === 'pending' &&
      !input.store
        .listThreadAgentSessions(entry.workspaceId, entry.threadId)
        .some((session) => session.id === current.agentSessionId && session.status === 'busy')
    ) {
      await closeSchedulerExecutionAttemptWithoutEffects(input.coreDb, {
        attemptId: attempt.attemptId,
        noOutstandingEffects: true,
        cause: 'backend-busy',
        requeue: true,
      });
      return { startedTurns: [], terminalResult: { status: 'queued', reason: 'backend-busy' } };
    }
    if (current.operationId === null)
      await closeSchedulerExecutionAttemptWithoutEffects(input.coreDb, {
        attemptId: attempt.attemptId,
        noOutstandingEffects: true,
        cause: 'turn-start-failed',
      });
    else
      await markSchedulerExecutionAttemptClosing(input.coreDb, {
        attemptId: attempt.attemptId,
        cause: 'preparation-or-execution-failed',
      });
    const turn = input.store.getTurnById(entry.turnId);
    if (turn.status === 'pending' || turn.status === 'running')
      await terminalizeGovernedWorkerTurn({
        store: input.store,
        turnId: turn.id,
        agentSessionId: current.agentSessionId,
        requestId: entry.requestId,
        outcome: 'failed',
        completedAt: input.now?.() ?? new Date().toISOString(),
        errorCode: 'worker_preparation_failed',
        message: error instanceof Error ? error.message : 'Worker preparation failed.',
      });
    throw error;
  } finally {
    preparationExpirations.delete(expirationKey);
  }
}
function resolveDispatchAgentSetup(
  input: RunSchedulerDispatchLoopInput,
  requestedAgentId: string,
  profileId: string | null,
  modelId: string | null,
  workspaceId: string,
  workspaceConfig: WorkspaceConfig | undefined,
  userConfig: UserConfig | undefined
) {
  const manifest = input.agentManifests.find((candidate) => candidate.id === requestedAgentId);
  if (!manifest) {
    throw new TurnStartValidationError(
      'agent_not_found',
      `Agent not found: ${requestedAgentId}.`,
      409
    );
  }
  const readiness = computeReadiness(manifest);
  if (!isAgentLaunchable(readiness)) {
    throw new TurnStartValidationError(
      'agent_not_ready',
      agentNotReadyMessage(requestedAgentId, readiness.status),
      409
    );
  }
  const resolved = resolveAgentSetup(manifest, {
    supportedRequiredFeatures: readSupportedAgentSetupFeatures(input.executionBackend),
    gatewayConfig: input.gatewayConfig,
    providerRegistry: input.providerRegistry,
    providerCredentialConfigured: input.providerCredentialConfigured,
    subscriptionAccounts: input.subscriptionAccounts,
    selectedProfileId: profileId,
    requestedLogicalModelId: modelId,
    workspaceId,
    ...(workspaceConfig ? { workspaceConfig } : {}),
    ...(userConfig ? { userConfig } : {}),
  });
  if (!resolved.setup || resolved.diagnostics.length > 0) {
    const message =
      resolved.diagnostics.map((diagnostic) => diagnostic.message).join('\n') ||
      `Agent ${requestedAgentId} setup is unavailable.`;
    // Classify only known input-bound diagnostics; new or missing dependency failures stay queued.
    if (
      resolved.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'agent_setup.invalid_default_profile' ||
          diagnostic.code === 'agent_setup.duplicate_credential_requirement' ||
          diagnostic.code === 'agent_setup.missing_credential_binding' ||
          diagnostic.code === 'agent_setup.logical_model_not_allowed' ||
          diagnostic.code === 'agent_setup.unsupported_required_feature'
      )
    ) {
      throw new DeterministicAgentPreparationError(message, 'agent_not_ready', 409);
    }
    throw new TurnStartValidationError('agent_not_ready', message, 409);
  }
  return resolved.setup;
}
