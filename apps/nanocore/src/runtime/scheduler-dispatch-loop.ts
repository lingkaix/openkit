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
  bindSchedulerExecutionAttemptSession,
  closeSchedulerExecutionAttemptWithoutEffects,
  createSchedulerExecutionAttempt,
  createSchedulerSelectionPrefix,
  ExecutionAttemptRefusal,
  markSchedulerExecutionAttemptClosing,
  requireSchedulerExecutionAttempt,
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

/**
 * The original identity of each claim whose reply was ambiguous and whose replay did not decide
 * it, per Core data root. The next post for that entry replays this identity.
 */
const unresolvedClaimsByDataRoot = new Map<
  string,
  Map<string, { readonly attemptId: string; readonly inputHash: string }>
>();

function getUnresolvedSchedulerClaims(coreDb: CoreDb) {
  let claims = unresolvedClaimsByDataRoot.get(coreDb.dataRoot);
  if (!claims) {
    claims = new Map();
    unresolvedClaimsByDataRoot.set(coreDb.dataRoot, claims);
  }
  return claims;
}

/** Each pass makes at most this many Core claim attempts, counting refusals and rescans. */
const SCHEDULER_PASS_CLAIM_ATTEMPTS = 20;

/** The outstanding Main selection-to-claim handoff of each Core data root. */
const selectionHandoffs = new Map<string, Promise<void>>();

/**
 * Reserves the per-root selection-to-claim handoff synchronously, behind any outstanding one.
 * The holder selects, posts its claim and publishes its invocation before it releases.
 */
function reserveSelectionHandoff(dataRoot: string): {
  readonly ready: Promise<void>;
  readonly release: () => void;
} {
  const previous = selectionHandoffs.get(dataRoot);
  const own = Promise.withResolvers<void>();
  selectionHandoffs.set(dataRoot, own.promise);
  let released = false;
  return {
    ready: previous ?? Promise.resolve(),
    release: () => {
      if (released) return;
      released = true;
      own.resolve();
      if (selectionHandoffs.get(dataRoot) === own.promise) selectionHandoffs.delete(dataRoot);
    },
  };
}

/** The Main facts that one pass observed. They apply to this pass only. */
interface SchedulerPassObservations {
  sourceRecoveryRequired: boolean;
  publicationPending: boolean;
  /** Admissions whose claimed dispatch returned recovery-required in this pass. */
  readonly recoveryQueueEntryIds: Set<string>;
}

type SchedulerSelection =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'deny';
      readonly entry: CoreSchedulerQueueEntry;
      readonly release: () => void;
    }
  | {
      readonly kind: 'claim';
      readonly entry: CoreSchedulerQueueEntry;
      readonly release: () => void;
      readonly selectionPrefixDigest: string;
    };

/**
 * Walks one Core read snapshot in insertion order. Each Core-satisfiable admission gets Main's
 * own checks. The first admission that passes them is the proposal. Every satisfiable
 * predecessor that Main skipped goes into the selection prefix that Core verifies.
 */
function selectSchedulerAdmission(
  input: RunSchedulerDispatchLoopInput,
  claims: SchedulerPreparationClaims,
  observed: SchedulerPassObservations
): SchedulerSelection {
  const prefix = createSchedulerSelectionPrefix();
  for (const entry of readQueuedSchedulerAdmissionEntriesInOrder(input.coreDb)) {
    if (schedulerClaimBlocked(input.coreDb, entry)) continue;
    // Core applies the same backend and authority qualification to each predecessor. A skipped
    // admission goes into the prefix only if Core also counts it as satisfiable.
    const qualified = schedulerAdmissionQualified(input.coreDb, entry);
    const skip = () => {
      if (qualified) prefix.add(entry);
    };
    let release: (() => void) | undefined;
    try {
      if (observed.recoveryQueueEntryIds.has(entry.queueEntryId)) {
        skip();
        continue;
      }
      if (!isScopeAdmitted(input.coreDb.dataRoot, 'workspace', entry.workspaceId)) {
        // Retain the admission and all exclusion; only this process-local selection is skipped.
        observed.sourceRecoveryRequired = true;
        observed.publicationPending = true;
        skip();
        continue;
      }
      // A live local invocation owns this admission.
      if (claims.has(entry.queueEntryId)) {
        skip();
        continue;
      }
      try {
        release = input.store.enterWorkspaceMutation(entry.workspaceId);
      } catch (error) {
        if (!(error instanceof OperationError) || error.code !== 'workspace_frozen') throw error;
        observed.publicationPending = true;
        skip();
        continue;
      }
      if (
        !currentSchedulerAdmissionWorkspaceAuthority(input.coreDb, entry, 'runtime.launch', true)
      ) {
        const denied = release;
        release = undefined;
        return { kind: 'deny', entry, release: denied };
      }
      if (entry.backendId !== input.executionBackend.id)
        throw new Error('Queued admission does not name the configured execution backend.');
      // An incomplete cross-store publication fences only its own request/Thread. Continue
      // selecting eligible FIFO work; a receipt gap on A cannot veto independent Thread B.
      const turnInput = readScheduledAdmissionText(input.coreDb, entry);
      if (turnInput === null) {
        observed.sourceRecoveryRequired = true;
        observed.publicationPending = true;
        skip();
        continue;
      }
      if (!schedulerEntryPublicationComplete(input, entry, turnInput)) {
        if (
          isRecurringQueueEntry(input.coreDb, entry.queueEntryId) ||
          findExternalTriggerAdmissionForQueue(input.coreDb, entry.queueEntryId)
        )
          observed.sourceRecoveryRequired = true;
        observed.publicationPending = true;
        skip();
        continue;
      }
      // Admission is only early refusal; the live activated policy decides before effects. The
      // authority read can fail on its source owner, so the Workspace admission transfers to the
      // proposal only after the read returns.
      const authorized = currentSchedulerDispatchAuthority(input, entry);
      const proposal = release;
      release = undefined;
      if (!authorized) return { kind: 'deny', entry, release: proposal };
      return {
        kind: 'claim',
        entry,
        release: proposal,
        selectionPrefixDigest: prefix.digest(),
      };
    } finally {
      release?.();
    }
  }
  return { kind: 'none' };
}

/** The one pending fresh scan of each Core data root. It waits behind the outstanding handoff. */
const pendingScans = new Map<
  string,
  {
    readonly input: Omit<RunSchedulerDispatchLoopInput, 'callerQueueEntryId'>;
    readonly result: Promise<SchedulerDispatchLoopResult>;
  }
>();

/** Dispatches eligible FIFO work through an attempt persisted before its preparation effects. */
export async function runSchedulerDispatchLoop(
  input: RunSchedulerDispatchLoopInput
): Promise<SchedulerDispatchLoopResult> {
  if (input.agentWorkPaused?.())
    return { startedTurns: [], terminalResult: { status: 'queued', reason: 'agent-work-paused' } };
  const claims = getSchedulerPreparationClaims(input.coreDb);
  const own = () => (input.callerQueueEntryId ? claims.get(input.callerQueueEntryId) : undefined);
  const joined = own();
  if (joined) return joined;
  const root = input.coreDb.dataRoot;
  if (!selectionHandoffs.has(root)) return runSchedulerDispatchPass(input, claims);
  // A trigger during an outstanding handoff joins the one pending fresh scan, or starts it. The
  // scan leaves the pending slot when it acquires the handoff, so a later trigger is retained.
  let pending = pendingScans.get(root);
  const { callerQueueEntryId: _caller, ...fresh } = input;
  if (pending) {
    const scan = pending.input as Record<string, unknown>;
    const maxDispatches = Math.max(pending.input.maxDispatches ?? 1, input.maxDispatches ?? 1);
    // The pending scan waits for the handoff and has read only its root and the pause flag.
    // It runs with the newest configuration snapshot of its triggers and the largest budget.
    if ((input.configVersion ?? -1) > (pending.input.configVersion ?? -1)) {
      for (const key of Object.keys(scan)) delete scan[key];
      Object.assign(scan, fresh);
    }
    scan.maxDispatches = maxDispatches;
  } else {
    const leave = () => {
      if (pendingScans.get(root)?.input === fresh) pendingScans.delete(root);
    };
    const result = runSchedulerDispatchPass(fresh, claims, leave);
    void result.then(leave, leave);
    pending = { input: fresh, result };
    pendingScans.set(root, pending);
  }
  const result = await pending.result;
  // The exact same-entry result: the caller joins its own invocation and holds no handoff.
  const mine = result.startedTurns.some(
    (turn) => turn.dispatch.entry.queueEntryId === input.callerQueueEntryId
  )
    ? undefined
    : own();
  return mine ? await mine : result;
}

/** Runs one pass: at most the claim-attempt budget, each attempt under the per-root handoff. */
async function runSchedulerDispatchPass(
  input: RunSchedulerDispatchLoopInput,
  claims: SchedulerPreparationClaims,
  onHandoffAcquired?: () => void
): Promise<SchedulerDispatchLoopResult> {
  const startedTurns: SchedulerDispatchLoopStartedTurn[] = [];
  const observed: SchedulerPassObservations = {
    sourceRecoveryRequired: false,
    publicationPending: false,
    recoveryQueueEntryIds: new Set(),
  };
  let dispatched = 0;
  for (let claimAttempts = 0; dispatched < (input.maxDispatches ?? 1); claimAttempts++) {
    // At the cap the pass yields to the next wake or timer.
    if (claimAttempts >= SCHEDULER_PASS_CLAIM_ATTEMPTS)
      return { startedTurns, terminalResult: { status: 'queued', reason: 'thread-busy' } };
    if (input.agentWorkPaused?.())
      return { startedTurns, terminalResult: { status: 'queued', reason: 'agent-work-paused' } };
    const handoff = reserveSelectionHandoff(input.coreDb.dataRoot);
    try {
      await handoff.ready;
      onHandoffAcquired?.();
      // A trigger that waited for the handoff joins its own admission's invocation. The join
      // awaits execution and closeout, so the handoff is released first.
      const own =
        dispatched === 0 && input.callerQueueEntryId
          ? claims.get(input.callerQueueEntryId)
          : undefined;
      if (own) {
        handoff.release();
        return await own;
      }
      // The pause can take effect while this pass waits for the handoff. Recheck it before the
      // selection and the post, so a queued entry keeps its admission with no attempt.
      if (input.agentWorkPaused?.())
        return { startedTurns, terminalResult: { status: 'queued', reason: 'agent-work-paused' } };
      // Preparation is single-flight. Keep its invocation promise through closeout so product observers cannot mistake a terminal row for finished output and backend handoff.
      if (
        [...claims.keys()].some((queueEntryId) =>
          input.coreDb.sqlite
            .prepare(
              "SELECT 1 FROM scheduler_execution_attempts WHERE queue_entry_id = ? AND phase = 'open' AND deadline IS NULL"
            )
            .get(queueEntryId)
        )
      )
        return { startedTurns, terminalResult: { status: 'queued', reason: 'thread-busy' } };
      // One Core read snapshot for the whole walk; it ends before any post.
      const selection = input.coreDb.sqlite
        .transaction(() => selectSchedulerAdmission(input, claims, observed))
        .deferred();
      if (selection.kind === 'none')
        return {
          startedTurns,
          terminalResult: {
            status: 'queued',
            reason: observed.sourceRecoveryRequired
              ? 'recovery-required'
              : observed.publicationPending
                ? 'entry-publication-pending'
                : listQueuedSchedulerAdmissionEntries(input.coreDb).length
                  ? 'thread-busy'
                  : 'no-queued-entry',
          },
        };
      if (selection.kind === 'deny') {
        try {
          const denied = await admitCoreScheduler(input.coreDb, {
            mode: 'deny',
            queueEntryId: selection.entry.queueEntryId,
            denialReason: 'authority-denied',
          });
          if (denied.kind !== 'queue')
            throw new Error('Scheduler publication returned another family.');
          return { startedTurns, terminalResult: { status: 'denied', entry: denied.entry } };
        } finally {
          selection.release();
        }
      }
      const { entry } = selection;
      let acknowledgeSubmission!: (result: SchedulerDispatchLoopResult) => void;
      let submissionResult: SchedulerDispatchLoopResult | undefined;
      const submitted = new Promise<SchedulerDispatchLoopResult>((resolve) => {
        acknowledgeSubmission = (result) => {
          submissionResult = result;
          resolve(result);
        };
      });
      const claimDecided = Promise.withResolvers<void>();
      const promise = withTurnDispatchTelemetry(entry.turnId, () =>
        dispatchSchedulerAdmission(
          input,
          entry,
          acknowledgeSubmission,
          selection.selectionPrefixDigest,
          claimDecided.resolve
        )
      );
      // Publish the winner's invocation before the handoff is released.
      claims.set(entry.queueEntryId, promise);
      const forget = () => {
        selection.release();
        if (claims.get(entry.queueEntryId) === promise) claims.delete(entry.queueEntryId);
      };
      void promise.then(forget, forget);
      // Core decided the claim: commit, definite refusal or owner failure. Release the handoff
      // before awaiting preparation or closeout.
      await Promise.race([claimDecided.promise, promise.then(noop, noop)]);
      handoff.release();
      const result = await Promise.race([promise, submitted]);
      if (result === submissionResult)
        void promise.catch((error: unknown) =>
          console.error(
            'scheduler_dispatch_failed_after_admission',
            error instanceof Error ? error.message : 'unknown'
          )
        );
      startedTurns.push(...result.startedTurns);
      // Core refused the claim and committed nothing: the placement is held, or the FIFO
      // selection changed. The next fresh scan decides again.
      if (
        result.terminalResult.status === 'queued' &&
        result.terminalResult.reason === 'thread-busy'
      )
        continue;
      if (
        result.terminalResult.status === 'queued' &&
        result.terminalResult.reason === 'recovery-required'
      ) {
        observed.sourceRecoveryRequired = true;
        observed.publicationPending = true;
        observed.recoveryQueueEntryIds.add(entry.queueEntryId);
        continue;
      }
      if (
        result.terminalResult.status !== 'queued' ||
        result.terminalResult.reason !== 'max-dispatches'
      )
        return { startedTurns, terminalResult: result.terminalResult };
      dispatched++;
    } finally {
      handoff.release();
    }
  }
  return { startedTurns, terminalResult: { status: 'queued', reason: 'max-dispatches' } };
}

function noop(): void {}

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
async function dispatchSchedulerAdmission(
  input: RunSchedulerDispatchLoopInput,
  entry: CoreSchedulerQueueEntry,
  acknowledgeSubmission: (result: SchedulerDispatchLoopResult) => void,
  selectionPrefixDigest: string,
  claimDecided: () => void
): Promise<SchedulerDispatchLoopResult> {
  input.onDispatchAttribution?.(entry.queueEntryId);
  const responsibleUserId =
    entry.triggerActor.kind === 'user'
      ? entry.triggerActor.id
      : entry.triggerActor.responsibleUserId;
  const workspaceConfig = input.workspaceConfigs?.find(
    (candidate) => candidate.workspaceId === entry.workspaceId
  )?.config;
  const userConfig = input.userConfigs?.find(
    (candidate) => candidate.userId === responsibleUserId
  )?.config;
  const workspaceDataSourceCatalog = input.workspaceDataSourceCatalogs?.find(
    (candidate) => candidate.workspaceId === entry.workspaceId
  )?.catalog;
  const workspaceMcpServerCatalog = input.workspaceMcpServerCatalogs?.find(
    (candidate) => candidate.workspaceId === entry.workspaceId
  )?.catalog;
  const unresolved = getUnresolvedSchedulerClaims(input.coreDb);
  const original = unresolved.get(entry.queueEntryId);
  // An unresolved original claim of this entry is the only identity that this process posts.
  const attemptId =
    original?.inputHash === entry.inputHash
      ? original.attemptId
      : (input.createAttemptId ?? (() => allocateEntityId('attempt')))();
  const post = () =>
    createSchedulerExecutionAttempt(input.coreDb, {
      entry,
      attemptId,
      preparationInput: {
        admission: entry,
        configVersion: input.configVersion ?? null,
        manifest: input.agentManifests.find((manifest) => manifest.id === entry.requestedAgentId),
        workspaceConfig,
        userConfig,
        workspaceDataSourceCatalog,
        workspaceMcpServerCatalog,
      },
      selectionPrefixDigest,
      ...(input.now ? { now: input.now } : {}),
    });
  const ambiguous = (error: unknown) =>
    error instanceof ControlStoreWorkerError && error.commit === 'unknown';
  let attempt: SchedulerExecutionAttemptRecord;
  try {
    try {
      attempt = await post();
    } catch (error) {
      if (!ambiguous(error)) throw error;
      // Typed recovery for an ambiguous claim reply. Replay the exact original claim through
      // the Core writer: under its write lock Core returns the original attempt if the claim
      // committed, or decides this same identity now. No other identity is posted for the entry.
      unresolved.set(entry.queueEntryId, { attemptId, inputHash: entry.inputHash });
      try {
        attempt = await post();
      } catch (inspection) {
        if (ambiguous(inspection))
          return {
            startedTurns: [],
            terminalResult: { status: 'queued', reason: 'recovery-required' },
          };
        throw inspection;
      }
    }
    unresolved.delete(entry.queueEntryId);
  } catch (error) {
    unresolved.delete(entry.queueEntryId);
    // A held placement or a changed FIFO selection committed nothing; a fresh scan decides again.
    // Every other refusal keeps its own answer.
    if (
      error instanceof ExecutionAttemptRefusal &&
      (error.reason === 'placement-held' || error.reason === 'selection-changed')
    )
      return { startedTurns: [], terminalResult: { status: 'queued', reason: 'thread-busy' } };
    throw error;
  } finally {
    claimDecided();
  }
  // A replay can return an original that another owner has already advanced or closed. Only an
  // untouched pre-submit claim continues here; a fresh scan decides the entry again.
  if (
    attempt.phase !== 'open' ||
    attempt.deadline !== null ||
    attempt.operationId !== null ||
    attempt.agentSessionId !== null
  )
    return { startedTurns: [], terminalResult: { status: 'queued', reason: 'thread-busy' } };
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
