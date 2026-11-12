import type { WorkspaceReconciliationRecord } from '@openkit/app-api-schemas';
import {
  type ControlAccessTokenLifecycle,
  type ControlAccessTokenLifecycleResult,
  ControlAccessTokenLifecycleResultSchema,
} from '../auth/access-token-lifecycle-codecs.js';
import {
  type ControlBootstrapConsume,
  type ControlBootstrapConsumeResult,
  ControlBootstrapConsumeResultSchema,
} from '../auth/bootstrap-consume-codecs.js';
import {
  type ControlBootstrapEnsure,
  type ControlBootstrapEnsureResult,
  ControlBootstrapEnsureResultSchema,
} from '../auth/bootstrap-ensure-codecs.js';
import {
  type ControlLocalIdentity,
  ControlLocalIdentityResultSchema,
} from '../auth/local-identity-codecs.js';
import { assertScopeAdmitted } from '../bootstrap/readiness.js';
import {
  type ControlDiscordChannelInput,
  ControlDiscordChannelInputSchema,
  type ControlDiscordChannelResult,
  ControlDiscordChannelResultSchema,
} from '../channels/discord-codecs.js';
import { BootConfigError } from '../config/mode.js';
import type { AttentionDelivery } from '../notifications/attention.js';
import {
  type AttentionEnqueueCommand,
  AttentionEnqueueCommandSchema,
  AttentionEnqueueResultSchema,
  type AttentionReconciliation,
  AttentionReconciliationResultSchema,
  AttentionReconciliationSchema,
} from '../notifications/attention-codecs.js';
import { AttentionError } from '../notifications/attention-error.js';
import type { ControlGoalCommandResult, ControlGoalInput } from '../runtime/goal-codecs.js';
import { GoalCommandError } from '../runtime/goal-error.js';
import { WorkspaceCollectionError } from '../runtime/workspace-collect-wire.js';
import {
  PreservedWorkspaceCaptureRefusal,
  WorkspaceCaptureRecoveryRequired,
} from '../runtime/workspace-snapshot-chain.js';
import {
  type ControlAttentionAttemptClaim,
  ControlAttentionAttemptClaimResultSchema,
  ControlAttentionAttemptClaimSchema,
} from './attention-attempt-claim-codecs.js';
import {
  type ControlAttentionAttemptCompletion,
  type ControlAttentionAttemptCompletionResult,
  ControlAttentionAttemptCompletionResultSchema,
  ControlAttentionAttemptCompletionSchema,
} from './attention-attempt-completion-codecs.js';
import type {
  ControlAutomationScanner,
  ControlAutomationScannerResult,
} from './automation-scanner-codecs.js';
import type { ControlCatalogCommandReceiptInput } from './catalog-command-receipt-codecs.js';
import { ControlStoreWorkerError } from './control-store-worker-error.js';
import type { ControlPrivateWorkspaceInput } from './private-workspace-codecs.js';
import type {
  ControlResolvedAgentSetupInput,
  ControlResolvedAgentSetupRecord,
  ControlResolvedAgentSetupResult,
} from './resolved-agent-setup-codecs.js';
import {
  type RuntimePolicyPublicationInput,
  RuntimePolicyPublicationInputSchema,
  type RuntimePolicyPublicationResult,
  RuntimePolicyPublicationResultSchema,
} from './runtime-policy-publication.js';
import type { ControlScopedNotebookSqlInput } from './scoped-notebook-sql-codecs.js';
import {
  type ControlStandaloneAuditInput,
  ControlStandaloneAuditInputSchema,
} from './standalone-audit-codecs.js';
import type {
  ControlWorkspaceBackendHandoff,
  ControlWorkspaceBackendHandoffResult,
} from './workspace-backend-handoff-codecs.js';
import type { ControlWorkspaceBaseline } from './workspace-baseline-codecs.js';
import type {
  ControlWorkspaceCapture,
  ControlWorkspaceCaptureResult,
} from './workspace-capture-codecs.js';
import {
  ControlWorkspaceCommandReceiptInputSchema,
  type WorkspaceCommandReceipt,
} from './workspace-command-receipt-codecs.js';
import { WorkspaceOwnerMembershipRemovedError } from './workspace-owner-records.js';
import {
  type ControlRecoverySourceReactivationInput,
  ControlRecoverySourceReactivationInputSchema,
} from './workspace-reactivation-codecs.js';
import type { ControlWorkspaceRecoveryDecision } from './workspace-recovery-decision-codecs.js';
import type { ControlWorkspaceStageReview } from './workspace-stage-review-codecs.js';
import type { ControlWorkspaceTakeover } from './workspace-takeover-codecs.js';

export { ControlStoreWorkerError } from './control-store-worker-error.js';

import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { isMainThread, Worker } from 'node:worker_threads';
import type { ApplyKnowledgeSchemaResponse } from '@openkit/app-api-schemas';
import { sha256Hex } from '@openkit/protocol/digest';
import {
  createPrivateTreeSync,
  ensureCanonicalDirectory,
  removePrivateTreeSync,
  STORAGE_LIMITS,
  writePrivateTextFileExclusive,
} from '@openkit/storage';
import type {
  RecordResolvedAgentSetupInput,
  ResolvedAgentSetupRecord,
} from '../agents/setup-ledger.js';
import {
  guardExistingResolvedAgentSetup,
  redactResolvedAgentSetup,
} from '../agents/setup-ledger-records.js';
import { StoredResolvedAgentSetupV1Schema } from '../agents/setup-retained-v1.js';
import {
  ArtifactReviewError,
  type ControlReviewCommandInput,
  type ControlReviewCommandResult,
} from '../artifact-review-codecs.js';
import {
  AdminRecoveryError,
  type ControlAdminRecoveryInput,
} from '../auth/admin-recovery-codecs.js';
import {
  BetterAuthNativeError,
  type ControlBetterAuthInput,
  type ControlBetterAuthResult,
  isBetterAuthRefusal,
} from '../auth/better-auth-codecs.js';
import {
  type ControlNanoHostTransportInput,
  type ControlNanoHostTransportResult,
  isNanoHostTransportAdminRefusal,
} from '../auth/nanohost-transport-codecs.js';
import { KernelCommandError } from '../generative-kernel/errors.js';
import {
  type ControlAppInput,
  ControlAppInputSchema,
  type ControlAppResult,
  type ControlAppWire,
} from '../generative-kernel/native-command-codecs.js';
import type { ControlGenerativePresentation } from '../generative-ui/native-publication-codecs.js';
import type {
  ControlMaintenanceAdmissionInput,
  ControlMaintenanceAdmissionResult,
} from '../knowledge/knowledge-agent-maintenance.js';
import { NotebookError } from '../knowledge/notebook.js';
import { StoreRecordNotFoundError } from '../lib/store-errors.js';
import {
  IdempotencyKeyConflictError,
  OperationError,
  restoreControlCapabilityFailure,
} from '../operation-error.js';
import type { ControlExecutionJournalInput } from '../runtime/execution-journal.js';
import type { IdempotentCommandReceipt } from '../runtime/idempotent-command.js';
import { PendingRequestCommandError } from '../runtime/pending-request-error.js';
import type { ControlPendingCommandResult } from '../runtime/pending-requests.js';
import type {
  ProjectWorkerBackendCleanupInput,
  WorkerBackendCleanupProjectionResult,
} from '../runtime/worker-backend-cleanup-projection.js';
import type { ControlWorkerRejectedEvidence } from '../runtime/worker-control-rejected-evidence-codecs.js';
import { WorkerImageSettlementConflict } from '../runtime/worker-image-settlements-records.js';
import {
  type WorkerStorageBinding,
  WorkerStorageBindingError,
} from '../runtime/worker-storage-binding-records.js';
import {
  type ControlMaterialCommandInput,
  type ControlMaterialCommandResult,
  prepareControlMaterialTransfer,
} from '../workspace-materials.js';
import type {
  WorkspaceFrozenAdmission,
  WorkspaceMutationAdmission,
} from '../workspace-mutation-admission.js';
import type {
  ControlAccessTokenVerification,
  ControlAccessTokenVerificationResult,
} from './access-token-verification-codecs.js';
import { lightAppDbPath } from './app-db.js';
import {
  FileAdmissionError,
  FileStorageAdmission,
  type FileStorageReservation,
} from './artifacts/file-admission.js';
import { CONTROL_STORE_BUDGET, type ControlCheckpoint } from './control-store.js';
import type { ControlAdmission, ControlAdmissionResult } from './control-store-admission-codecs.js';
import {
  type ControlCapabilityCommandInput,
  type ControlCapabilityCommandResult,
  type ControlCapabilityWireInput,
  type ControlMcpItemCall,
  type ControlWorkspaceCapabilityCommandResult,
  controlCapabilityText,
  prepareControlCapabilityTransfer,
} from './control-store-capability.js';
import { commandInputHash, frameControlScalarText } from './control-store-input.js';
import type { ControlPendingTransition } from './control-store-pending.js';
import type { ControlProductTransition } from './control-store-product-records.js';
import {
  CONTROL_PRODUCT_LIMITS,
  type ControlProductEntry,
  closeWorkspaceProductReadHandles,
  drainMainScopeReadHandles,
  reserveMainScopeReadAcquisition,
} from './control-store-product-records.js';
import {
  type ControlEventAppend,
  type ControlEventAppendResult,
  ControlEventAppendSchema,
  type ControlItemAppend,
  type ControlPublicationInput,
  type ControlTerminalResult,
  type ControlTerminalTransition,
  nativeUserDatabasePath,
} from './control-store-products.js';
import type {
  ControlRecoveryCaptureInput,
  ControlRecoveryCleanupInput,
  ControlRecoveryMoveOutInput,
  ControlRecoverySafetyInput,
  ControlRecoverySafetyResult,
} from './control-store-recovery.js';
import {
  CONTROL_WORKER_LIMITS,
  CONTROL_WORKER_VERSION,
  type ControlBootAuditInput,
  ControlPhysicalForecastDecisionSchema,
  ControlPhysicalForecastSchema,
  type ControlPolicyBridgeMessage,
  ControlPolicyBridgeMessageSchema,
  type ControlPolicyGrant,
  type ControlProductCohort,
  type ControlProvenanceInput,
  type ControlSchemaApplicationFacts,
  ControlSchemaApplicationFactsSchema,
  type ControlSchemaApplicationInput,
  ControlSchemaApplicationInputSchema,
  ControlSchemaApplicationRefusalSchema,
  type ControlSqlResult,
  type ControlSqlStatement,
  type ControlWorkerCommand,
  type ControlWorkerReply,
  type ControlWorkerRequest,
  controlMaterialTransferSize,
  controlWorkerInputBytes,
  controlWorkObservationTransferSize,
  isControlProductCohort,
  isControlWorkerReply,
  isControlWorkerRequest,
} from './control-store-worker-protocol.js';
import type { ControlCoreJournalInput } from './core-journal-codecs.js';
import { type CoreDb, openUserReadDb, type UserDb, type WorkspaceDb } from './db.js';
import type { ControlEvaluationCandidate } from './evaluation-candidate-codecs.js';
import type {
  ControlExecutionAttemptCommand,
  ControlExecutionAttemptResult,
} from './execution-attempt-codecs.js';
import { ensureUserLayout, resolveDataRootPath, userDbPath } from './fs-layout.js';
import type {
  ControlHarnessLifecycleInput,
  ControlHarnessLifecycleResult,
} from './harness-lifecycle-codecs.js';
import { hasPendingUserMigrations } from './migrate.js';
import type { ControlRemoteMcpAudit } from './remote-mcp-audit-codecs.js';
import type {
  ControlRuntimeTargetInput,
  ControlRuntimeTargetResult,
} from './runtime-target-codecs.js';
import {
  type ControlSchedulerAdmission,
  type ControlSchedulerAdmissionResult,
  SchedulerAdmissionTransitionError,
} from './scheduler-admission-codecs.js';
import type { ControlServerAdminTokenDefault } from './server-admin-token-default-codecs.js';
import {
  type ControlThreadReadMembership,
  THREAD_READ_RECEIPT_INVALID,
} from './thread-read-membership-codecs.js';
import {
  type ControlVaultInput,
  ControlVaultInputSchema,
  type ControlVaultMainInputMap,
  type ControlVaultResultMap,
  isControlVaultRefusal,
  VaultGrantNarrowingError,
} from './vault-native-codecs.js';
import type {
  ControlWorkObservationCommandInput,
  ControlWorkObservationResult,
} from './work-observations.js';
import type {
  ControlBackendSessionInput,
  ControlBackendSessionResult,
} from './worker-backend-session-codecs.js';
import type { ControlWorkerFinalStatusCommand } from './worker-control-final-status-codecs.js';
import type { ControlWorkerHeartbeatCommand } from './worker-control-heartbeat-codecs.js';
import type { ControlWorkerRecordCommand } from './worker-control-record-codecs.js';
import type { ControlWorkerImageInput } from './worker-image-codecs.js';
import type { ControlWorkerStorageInput } from './worker-storage-binding-codecs.js';
import type { ControlWorkspaceApplyPlan } from './workspace-apply-plan-codecs.js';
import {
  type ControlWorkspaceDeletionInput,
  ControlWorkspaceDeletionInputSchema,
  type ControlWorkspaceDeletionResult,
} from './workspace-deletion-codecs.js';
import { nativeProductScope } from './workspace-file-records.js';
import type { WorkspaceRecoveryCliReport } from './workspace-recovery-cli.js';
import {
  type ControlRecoveryTargetPreparationInput,
  ControlRecoveryTargetPreparationInputSchema,
  type ControlRecoveryTargetRegistrationInput,
  ControlRecoveryTargetRegistrationInputSchema,
} from './workspace-recovery-target-codecs.js';
import type {
  ControlWorkspaceReviewDecision,
  ControlWorkspaceReviewFinish,
} from './workspace-review-codecs.js';
import type { ControlCoreSharing, ControlCoreSharingResult } from './workspace-sharing-codecs.js';

/** Exact trusted progress create; it retains the original native FULL acknowledgement. */
export interface ControlProgressPublication {
  readonly input: ControlItemAppend;
  readonly opening: Omit<OpenCommand, 'operation'>;
}

/** Definite refusal of new work by this host lifetime; no command was admitted. */
export class ControlStoreWorkerShutdownError extends ControlStoreWorkerError {
  /** Keeps shutdown distinct from a failed transport with unknown accepted outcomes. */
  constructor() {
    super('unavailable', 'not-committed');
    this.name = 'ControlStoreWorkerShutdownError';
  }
}

type Success = Extract<ControlWorkerReply, { status: 'ok' }>;
type OpenCommand = Extract<ControlWorkerCommand, { operation: 'open' }>;
/** Immutable native binding selected by the current Core recovery admission, not caller pathname text. */
export interface ControlRecoveryNativeBinding {
  readonly command: Omit<OpenCommand, 'operation'>;
  readonly path: string;
  readonly identity: string;
  readonly sourceDataRoot: string;
}
/** Transient per-call proof; never serialized, cached on an Opening or inherited by ordinary publishers. */
export interface ControlRecoveryNativeCall {
  readonly freeze: WorkspaceFrozenAdmission;
  readonly binding: ControlRecoveryNativeBinding;
}

const workspaceDeletionCall = Symbol('workspace-deletion-call');
/** Reuses the caller's exact lifecycle freeze at Core admission and actual posting, never on the wire. */
interface ControlWorkspaceDeletionCall {
  readonly kind: 'workspace-deletion';
  readonly [workspaceDeletionCall]: true;
  readonly freeze: WorkspaceFrozenAdmission;
  readonly input: ControlWorkspaceDeletionInput;
  readonly command: Omit<OpenCommand, 'operation'>;
  readonly path: string;
  readonly identity: string;
}
const recoveryTargetRegistrationCall = Symbol('recovery-target-registration-call');
/** The current live freeze, or the original stopped root-lock lifetime, bound to one exact Core selection. */
interface ControlRecoveryTargetRegistrationCall {
  readonly kind: 'recovery-target-registration';
  readonly [recoveryTargetRegistrationCall]: true;
  readonly freeze: WorkspaceFrozenAdmission | undefined;
  readonly input: ControlRecoveryTargetRegistrationInput;
  readonly command: Omit<OpenCommand, 'operation'>;
  readonly path: string;
  readonly identity: string;
}
/** Preparation uses the same Core/freeze binding with its distinct finite stage input. */
interface ControlRecoveryTargetPreparationCall
  extends Omit<ControlRecoveryTargetRegistrationCall, 'kind' | 'input'> {
  readonly kind: 'recovery-target-preparation';
  readonly input: ControlRecoveryTargetPreparationInput;
  readonly assertCurrent: (() => void) | undefined;
}
const coreRetirementCall = Symbol('core-retirement-call');
/** Binds process-local quarantine and drained admission to the exact native retirement publication. */
interface ControlCoreRetirementCall {
  readonly kind: 'core-sharing-retirement';
  readonly [coreRetirementCall]: true;
  readonly input: Extract<ControlCoreSharing, { command: 'workspace.retire-quarantined' }>;
  readonly command: Omit<OpenCommand, 'operation'>;
  readonly path: string;
  readonly identity: string;
  readonly assertCurrent: () => void;
}
const sourceReactivationCall = Symbol('source-reactivation-call');
/** The stopped root-lock lifetime binds one original stage to its exact physical native owner. */
interface ControlRecoverySourceReactivationCall {
  readonly kind: 'recovery-source-reactivation';
  readonly [sourceReactivationCall]: true;
  readonly input: ControlRecoverySourceReactivationInput;
  readonly command: Omit<OpenCommand, 'operation'>;
  readonly path: string;
  readonly identity: string;
}
type ControlFrozenNativeCall =
  | ControlCoreRetirementCall
  | ControlRecoverySourceReactivationCall
  | ControlRecoveryTargetRegistrationCall
  | ControlRecoveryTargetPreparationCall
  | ControlRecoveryNativeCall
  | ControlWorkspaceDeletionCall;

export { nativeUserDatabasePath };

/** Native requests own release; the filesystem owner retains all physical admission semantics. */
type NativeCapacityReservation = Pick<FileStorageReservation, 'release'>;
/** Queued backing belongs to one database; host attribution preserves it after channel loss. */
interface DatabaseBacking {
  inputBytes: number;
  materialBytes: number;
}

/** One bounded native host; a failed host never restarts in this coordinator lifetime. */
interface WriterHost {
  worker: Worker | undefined;
  failed: boolean;
  /** Includes posted binary bytes whose channel failed until actual worker exit. */
  readonly backing: Map<string | undefined, DatabaseBacking>;
  pending: number;
  /** Disk forecasts survive failed transport until the worker actually exits. */
  readonly capacity: Set<NativeCapacityReservation>;
  /** Resolves from the real exit event, never transport failure or a delayed terminate Promise. */
  readonly exited: ReturnType<typeof Promise.withResolvers<void>>;
  terminated: boolean;
}

interface PolicyCall {
  id: number;
  readonly core: Opening;
  readonly borrower: Opening;
  phase: 'new' | 'borrow' | 'granted' | 'return' | 'done' | 'refused';
  returnPosted?: boolean;
  returnAcknowledged?: boolean;
  resource?: PolicyReadResource;
  grant?: ControlPolicyGrant;
  readonly borrowed: ReturnType<typeof Promise.withResolvers<ControlPolicyGrant>>;
  readonly returned: ReturnType<typeof Promise.withResolvers<void>>;
}

/** A borrowed resource remains owned after its transport Promise is rejected. */
interface PolicyReadResource {
  readonly core: Opening;
  readonly borrower: Opening;
  /** Only actual borrower termination permits this cleanup continuation. */
  readonly returnAfterExit: () => Promise<void>;
  /** Requires the original native outer-commit/abort acknowledgement, not a savepoint. */
  readonly returnAfterTermination: () => Promise<void>;
  active: boolean;
  remainingBytes: number;
  workspaceBytes: number;
  readonly settled: ReturnType<typeof Promise.withResolvers<void>>;
  call?: PolicyCall;
}

/** A process-wide physical reservation, including a fresh scope awaiting native initialization. */
interface Opening {
  readonly command: Omit<OpenCommand, 'operation'>;
  readonly host: WriterHost;
  readonly path: string;
  identity: string | undefined;
  openingRequestId: number | undefined;
  /** True only after the original native ACK and physical identity validation. */
  acknowledged: boolean;
  readonly promise: Promise<void>;
  readonly policyReads: Set<PolicyReadResource>;
  /** The exact close owner excludes later OPEN/read acquisition, including after a failed attempt. */
  retirement?:
    | { operation: 'close'; promise: Promise<void>; settled?: true }
    | { operation: 'seal'; promise: Promise<string | null>; settled?: true };
}

/** The existing posting hold and its FIFO release boundary, without another request queue. */
interface PostingHold {
  released: Promise<void>;
  drain: (() => void) | undefined;
}

/** One immutable transport frame shared by its existing pending request slots. */
interface PendingCohort {
  readonly frame: ControlProductCohort;
  readonly inputBytes: number;
  remaining: number;
}

/** One exact call's closeout count, retained by its original accepted producer. */
interface CapabilityCloseoutCredit {
  readonly database: string;
  readonly callId: string;
  active: boolean;
  borrowing: boolean;
}

/** Books the serial open/Item clone before the producer installs any Turn ordering edge. */
interface ProgressCopyCredit {
  readonly database: string;
  readonly itemId: string;
  readonly turnId: string;
  readonly category: ControlItemAppend['category'];
  readonly openingHash: string;
  active: boolean;
  remainingBytes: number;
  borrowing: boolean;
  openUsed: boolean;
  itemUsed: boolean;
}

/** One finite in-flight message, not persisted work or an execution attempt. */
interface Pending {
  readonly counted: boolean;
  readonly host: WriterHost;
  readonly command: ControlWorkerCommand;
  readonly request: ControlWorkerRequest;
  readonly recovery?: ControlFrozenNativeCall;
  /** Unposted capture waiters share this same finite admission map and byte budget. */
  posted: boolean;
  /** The original admitted scope ACK gates posting after finite request admission. */
  ready: boolean;
  /** Binary input and echoed range content remain admitted until reply or known disposal. */
  readonly materialBytes: number;
  readonly inputBytes: number;
  readonly capacity: NativeCapacityReservation[];
  /** A forecast is resolved once within this request's existing slot. */
  physicalForecasted?: boolean;
  /** Original owner capture; neither the supplier nor facts are sent back in a forecast decision. */
  readonly schemaApplicationFacts?: {
    readonly captured: ControlSchemaApplicationFacts;
    readonly capture: () => ControlSchemaApplicationFacts;
  };
  readonly closeout?: CapabilityCloseoutCredit | undefined;
  readonly policyCall?: PolicyCall;
  readonly progressCopy?: { readonly credit: ProgressCopyCredit; readonly bytes: number };
  cohort?: PendingCohort;
  readonly resolve: (reply: Success) => void;
  readonly reject: (
    error: ControlStoreWorkerError | PendingRequestCommandError | OperationError
  ) => void;
}

/** Exact live product publication; this is not retained state or permission to retry. */
interface ControlPublicationIdentity {
  readonly dataRoot: string;
  readonly workspaceId: string;
  readonly turnId: string;
}

/** Recognizes current decision Items and bounded terminal control projections. */
function isControlCapacityItem(item: ControlItemAppend['item']): boolean {
  return (
    item.type === 'approval-decision' ||
    item.type === 'user-input-response' ||
    (item.type === 'tool-call' && item.status !== 'in_progress') ||
    (item.type === 'status' && item.status !== 'in_progress')
  );
}

/** Only existing decision and terminal intents may consume the protected physical margin. */
function isControlCapacityCommand(command: ControlWorkerCommand): boolean {
  switch (command.operation) {
    case 'open':
      // Existing scopes must reopen for recovery and control closeout below the ordinary watermark.
      return !command.create;
    case 'terminal':
    case 'project-cleanup':
    case 'recovery-cleanup':
    case 'recovery-capture':
    case 'recovery-move-out':
    case 'recovery-history':
    case 'recovery-seal':
    case 'recovery-safety':
      return true;
    case 'recovery-target-registration':
    case 'recovery-target-preparation':
    case 'recovery-source-reactivation':
      return true;
    case 'workspace-deletion':
      return command.input.stage === 'complete';
    case 'item':
      return isControlCapacityItem(command.input.item);
    case 'event': {
      const data = command.input.event.data;
      return (
        data.type === 'turn-completed' ||
        data.type === 'approval-resolved' ||
        (data.type === 'turn-updated' &&
          data.turn.status !== 'pending' &&
          data.turn.status !== 'running') ||
        ((data.type === 'item-created' || data.type === 'item-completed') &&
          isControlCapacityItem(data.item))
      );
    }
    case 'provenance':
      return true;
    case 'publication':
      return command.input.category === 'already-decided-publication';
    case 'pending':
      return (
        command.input.admission === undefined &&
        [
          'deny',
          'answer',
          'withdraw',
          'invalidate',
          'grant-command',
          'claim',
          'claim-command',
          'refuse-command',
          'finish',
          'settle-unfinished',
          'delivery-prove',
          'delivery-release',
          'delivery-unknown',
          'freeze',
          'closeout',
          'associate-invalidation',
        ].includes(command.input.input.action)
      );
    case 'capability':
      return [
        'permission',
        'user-permission',
        'usage-finish',
        'finish',
        'raw-settle',
        'raw-invalidate',
      ].includes(command.input.kind);
    case 'workspace-review-finish':
    case 'workspace-review-decision':
      return true;
    case 'review':
      return ['judgement', 'select', 'decide', 'decision-receipt'].includes(command.input.mode);
    case 'goal':
      return (
        'kind' in command.input ||
        ['goal.card.cancel', 'goal.plan.approve', 'goal.cancel', 'goal.completion.accept'].includes(
          command.input.command.operation
        )
      );
    case 'journal':
      return command.input.kind === 'settle';
    default:
      return false;
  }
}

let singleton: ControlStoreWorkerClient | undefined;

/**
 * Returns the process-local writer coordinator, without opening a database.
 *
 * A failed native host is never restarted by this getter. Explicit shutdown must finish before a later call can start a new host; no request is replayed. A released product scope must transfer its complete producer and shared receipt closure before using this host. A legacy main writable handle is not a table-level access-control boundary.
 *
 * @returns Shared coordinator for admitted database scopes, never a synchronous SQL facade.
 */
export function getControlStoreWorkerClient(
  admission?: WorkspaceMutationAdmission
): ControlStoreWorkerClient {
  if (!isMainThread) throw new ControlStoreWorkerError('unavailable', 'not-committed');
  if (singleton === undefined || singleton.isClosed) singleton = new ControlStoreWorkerClient();
  if (admission) singleton.setWorkspaceMutationAdmission(admission);
  return singleton;
}

/** Stops the existing process-local host without creating one; callers must finish shutdown before removing its database roots. */
export async function shutdownControlStoreWorkerClient(): Promise<void> {
  if (singleton) await singleton.shutdown();
  else closeWorkspaceProductReadHandles();
}

/** Owns the worker lifetime, finite pre-post admission and asynchronous acknowledgements. */
class ControlStoreWorkerClient {
  private readonly hosts: WriterHost[] = Array.from(
    { length: CONTROL_WORKER_LIMITS.workspaceWorkers + 1 },
    () => ({
      worker: undefined,
      failed: false,
      backing: new Map(),
      pending: 0,
      capacity: new Set(),
      exited: Promise.withResolvers<void>(),
      terminated: false,
    })
  );
  private readonly operations = new Map<Promise<unknown>, ControlPublicationIdentity | undefined>();
  private readonly turnTails = new Map<
    string,
    { tail: Promise<unknown>; pending: number; durablePending: number }
  >();
  /** Settlement notifications only for existing accepted progress producers; no extra input queue. */
  private readonly progressSettlements = new Map<Promise<void>, string>();
  /** Unallocated clone bookings, already charged against the same per-database input bound. */
  private readonly progressCopyBytes = new Map<string, number>();
  private readonly operationContext = new AsyncLocalStorage<{
    active: boolean;
    publication: ControlPublicationIdentity | undefined;
    progressCopy: ProgressCopyCredit | undefined;
    reservation: string | undefined;
    closeout: CapabilityCloseoutCredit | undefined;
  }>();
  private readonly pending = new Map<number, Pending>();
  private readonly outstanding = new Map<string, number>();
  private readonly openings = new Map<string, Opening>();
  private nextId = 0;
  private readonly backing = new Map<string | undefined, DatabaseBacking>();
  private stopping = false;
  private closed = false;
  private shutdownPromise: Promise<void> | undefined;
  private backupHold: PostingHold | undefined;
  private readonly databaseHolds = new Map<string, PostingHold>();
  /** The application's one gate survives cold scope close/open for this native client lifetime. */
  private workspaceMutationAdmission: WorkspaceMutationAdmission | undefined;
  private readonly fileAdmissions = new Map<string, FileStorageAdmission>();
  private readonly walCapacity = new Map<
    string,
    { reservation: FileStorageReservation; users: number }
  >();

  /** Keeps short native read resources and their funded returns after RPC settlement. */
  private retainPolicyRead(
    core: Opening,
    borrower: Opening,
    cleanupBytes: { core: number; workspace: number },
    returnNative: () => Promise<void>
  ): PolicyReadResource {
    const database = core.command.database;
    if (core.host.failed || borrower.host.failed)
      throw new ControlStoreWorkerError('unavailable', 'not-committed');
    // policyOpening binds both actual handles/root before posting. Native issuer and
    // deciding SQL head own the repeated physical checks; do not cache their authority here.
    if (
      !core.acknowledged ||
      !borrower.acknowledged ||
      core.retirement ||
      borrower.retirement ||
      core.openingRequestId === undefined ||
      borrower.openingRequestId === undefined
    )
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    if (
      !Number.isSafeInteger(cleanupBytes.core) ||
      cleanupBytes.core <= 0 ||
      !Number.isSafeInteger(cleanupBytes.workspace) ||
      cleanupBytes.workspace <= 0 ||
      this.reservedInputBytes(borrower.command.database) + cleanupBytes.workspace >
        CONTROL_WORKER_LIMITS.pendingBytes ||
      this.reservedInputBytes(database) + cleanupBytes.core > CONTROL_WORKER_LIMITS.pendingBytes ||
      (this.outstanding.get(database) ?? 0) >= CONTROL_WORKER_LIMITS.pendingTransitions
    )
      throw new ControlStoreWorkerError('busy', 'not-committed');
    let returning: Promise<void> | undefined;
    let exiting: Promise<void> | undefined;
    const close = (exited: boolean) =>
      (returning ??= (async () => {
        if (exited) await borrower.host.exited.promise;
        try {
          if (core.host.failed) {
            if (!exited) throw new ControlStoreWorkerError('unavailable', 'unknown');
            await core.host.exited.promise;
          } else await returnNative();
        } catch (error) {
          this.fail(core.host);
          await Promise.all([core.host.exited.promise, borrower.host.exited.promise]);
          this.releasePolicyRead(resource);
          if (!exited) throw error;
        }
        // Wire close is cached independently of exit-owned lifetime release.
        // Normal success retains bookings until the original slot consumes its ACK.
      })());
    const resource: PolicyReadResource = {
      core,
      borrower,
      active: true,
      remainingBytes: cleanupBytes.core,
      workspaceBytes: cleanupBytes.workspace,
      settled: Promise.withResolvers<void>(),
      returnAfterTermination: () =>
        borrower.host.failed ? resource.returnAfterExit() : close(false),
      returnAfterExit: () =>
        (exiting ??= (async () => {
          await borrower.host.exited.promise;
          try {
            await close(true); // Reuse even a completed normal wire close; never repost.
          } finally {
            this.releasePolicyRead(resource);
          }
        })()),
    };
    core.policyReads.add(resource);
    this.adjustBacking(database, cleanupBytes.core, 0, core.host);
    this.adjustBacking(borrower.command.database, cleanupBytes.workspace, 0, borrower.host);
    this.outstanding.set(database, (this.outstanding.get(database) ?? 0) + 1);
    core.host.worker?.ref();
    borrower.host.worker?.ref();
    return resource;
  }

  /** Retirement already excludes new pins. Unposted slots prove zero native handles. */
  private async drainPolicyPreparations(opening: Opening | undefined): Promise<void> {
    if (!opening) return;
    for (const read of opening.policyReads) {
      const pending = read.call && this.pending.get(read.call.id);
      if (pending && !pending.posted)
        this.complete(
          pending.request.id,
          undefined,
          new ControlStoreWorkerError('precondition', 'not-committed')
        );
    }
    await Promise.all([...opening.policyReads].map((read) => read.settled.promise));
  }

  /** UNKNOWN or lost transport cannot release a reader on the strength of a rejected Promise. */
  private async abandonPolicyRead(resource: PolicyReadResource): Promise<void> {
    this.fail(resource.borrower.host);
    await resource.borrower.host.exited.promise;
    await resource.returnAfterExit();
  }

  /** Called only after acknowledged return or joined native termination, never timeout. */
  private releasePolicyRead(resource: PolicyReadResource): void {
    if (!resource.active) return;
    resource.active = false;
    resource.core.policyReads.delete(resource);
    if (!resource.core.host.failed)
      this.adjustBacking(
        resource.core.command.database,
        -resource.remainingBytes,
        0,
        resource.core.host
      );
    if (!resource.borrower.host.failed)
      this.adjustBacking(
        resource.borrower.command.database,
        -resource.workspaceBytes,
        0,
        resource.borrower.host
      );
    resource.remainingBytes = 0;
    resource.workspaceBytes = 0;
    resource.settled.resolve();
    this.releaseOutstanding(resource.core.command.database);
    for (const host of [resource.core.host, resource.borrower.host])
      if (!host.pending && !this.hasPolicyReads(host)) host.worker?.unref();
  }

  private hasPolicyReads(host: WriterHost): boolean {
    return [...this.openings.values()].some((opening) =>
      [...opening.policyReads].some(
        (resource) =>
          resource.active && (resource.core.host === host || resource.borrower.host === host)
      )
    );
  }

  /** Charges each database independently, with exact host ownership until ACK or actual exit. */
  private adjustBacking(
    database: string | undefined,
    inputBytes: number,
    materialBytes: number,
    host?: WriterHost
  ): void {
    for (const entries of host ? [this.backing, host.backing] : [this.backing]) {
      const current = entries.get(database) ?? { inputBytes: 0, materialBytes: 0 };
      current.inputBytes += inputBytes;
      current.materialBytes += materialBytes;
      if (current.inputBytes === 0 && current.materialBytes === 0) entries.delete(database);
      else entries.set(database, current);
    }
  }

  /** Binds the existing live file policy before native admission, including cold scope opens. */
  setFileStorageAdmission(dataRoot: string, admission: FileStorageAdmission): void {
    this.fileAdmissions.set(resolve(dataRoot), admission);
  }

  /** Holds actual filesystem capacity for native staging and its conservative bounded WAL growth. */
  private reserveCapacity(
    command: ControlWorkerCommand,
    opening: Opening | undefined,
    inputBytes: number,
    materialBytes: number,
    creditedCloseout: boolean
  ): readonly NativeCapacityReservation[] {
    if (['shutdown', 'close', 'checkpoint', 'reclaim'].includes(command.operation)) return [];
    const path = command.operation === 'open' ? command.path : opening?.path;
    const database = 'database' in command ? command.database : undefined;
    if (!path || database === undefined) return [];
    const root =
      command.operation === 'open'
        ? (command.dataRoot ?? dirname(path))
        : (opening?.command.dataRoot ?? dirname(path));
    let admission = this.fileAdmissions.get(resolve(root));
    if (!admission) {
      admission = new FileStorageAdmission(root, () => 1_000_000_000n);
      this.fileAdmissions.set(resolve(root), admission);
    }
    const entries: ControlProductEntry[] = [];
    switch (command.operation) {
      case 'products':
      case 'transition':
        entries.push(...command.transition.entries);
        break;
      case 'publication':
      case 'terminal':
        entries.push(...command.input.entries);
        break;
      case 'pending':
        entries.push(
          ...command.input.entries,
          ...(command.input.terminal?.entries ?? []),
          ...(command.input.admission?.entries ?? [])
        );
        break;
      case 'goal':
        if ('kind' in command.input) break;
        entries.push(...(command.input.pendingAdmission?.entries ?? []));
        if (command.input.pendingItem) entries.push(command.input.pendingItem.entry);
        break;
      case 'review':
        if (command.input.mode === 'submit') entries.push(...command.input.transition.entries);
        break;
    }
    const stagingBytes = entries.reduce((sum, entry) => sum + BigInt(entry.content.byteLength), 0n);
    const priority = creditedCloseout || isControlCapacityCommand(command) ? 'control' : 'ordinary';
    const reservations: NativeCapacityReservation[] = [];
    try {
      let wal = this.walCapacity.get(database);
      if (!wal) {
        wal = {
          reservation: admission.forPath(path).reserve(
            {
              stagingBytes: 0n,
              extractionBytes: 0n,
              derivativeBytes: 0n,
              publicationBytes: BigInt(CONTROL_STORE_BUDGET.maxWalBytes),
            },
            priority
          ),
          users: 0,
        };
        this.walCapacity.set(database, wal);
      } else {
        // Every affected filesystem still needs capacity; ordinary borrowers also keep the margin.
        admission
          .forPath(path)
          .reserve(
            {
              stagingBytes: 0n,
              extractionBytes: 0n,
              derivativeBytes: 0n,
              publicationBytes: 0n,
            },
            priority
          )
          .release();
      }
      const shared = wal;
      shared.users += 1;
      let released = false;
      reservations.push({
        release: () => {
          if (released) return;
          released = true;
          if (--shared.users === 0) {
            shared.reservation.release();
            this.walCapacity.delete(database);
          }
        },
      });
      const contentRoot =
        command.operation === 'observation' || command.operation === 'provenance'
          ? join(dirname(dirname(path)), 'evidence', 'backend')
          : command.operation === 'open'
            ? command.contentMount?.root
            : opening?.command.contentMount?.root;
      // Content may be a separate mount. Same-device forecasts still join the same pool.
      const observationGrowth =
        command.operation === 'observation' && 'chunk' in command.input
          ? BigInt(command.input.chunk.totalBytes) +
            BigInt(
              Buffer.byteLength(
                JSON.stringify({
                  byteOffset: command.input.chunk.byteOffset,
                  bytes: command.input.chunk.byteLength,
                  sha256: '0'.repeat(64),
                })
              )
            )
          : 0n;
      reservations.push(
        admission.forPath(contentRoot ?? path).reserve(
          {
            stagingBytes: stagingBytes + BigInt(inputBytes) + BigInt(materialBytes),
            extractionBytes: 0n,
            derivativeBytes: 0n,
            publicationBytes:
              observationGrowth +
              (command.operation === 'provenance'
                ? command.input.files.reduce((total, file) => total + BigInt(file.byteLength), 0n)
                : 0n),
          },
          priority
        )
      );
      if (command.operation === 'provenance')
        reservations.push(
          admission.forPath(join(dirname(dirname(path)), 'evidence', 'bundles')).reserve(
            {
              stagingBytes: BigInt(command.input.normalizedBytes),
              extractionBytes: 0n,
              derivativeBytes: 0n,
              publicationBytes: 0n,
            },
            priority
          )
        );
      return reservations;
    } catch (error) {
      for (const reservation of reservations) reservation.release();
      throw error;
    }
  }

  /** Starts the native host on first command; retaining a shutdown owner alone needs no thread. */
  private startWorker(host: WriterHost): Worker {
    if (host.worker) return host.worker;
    if (import.meta.url.endsWith('.ts') && process.env.VITEST === 'true') {
      // Vitest global setup compiles this same entry once in its owned private directory; missing setup fails closed.
      host.worker = new Worker(
        pathToFileURL(
          join(tmpdir(), 'nanocore-worker', 'dist', 'storage', 'control-store-worker.mjs')
        )
      );
    } else if (import.meta.url.endsWith('.ts')) {
      const require = createRequire(import.meta.url);
      const loader = pathToFileURL(require.resolve('tsx/esm/api')).href;
      const entry = new URL('./control-store-worker.ts', import.meta.url).href;
      host.worker = new Worker(
        // This thread is already isolated. A second tsImport namespace adds synchronous CommonJS loader round trips for the complete owner graph.
        `import(${JSON.stringify(loader)}).then(({register}) => { register(); return import(${JSON.stringify(entry)}); });`,
        { eval: true }
      );
    } else {
      host.worker = new Worker(new URL('./control-store-worker.bundle.mjs', import.meta.url));
    }
    host.worker.on('message', (value: unknown) => this.receive(value, host));
    host.worker.on('messageerror', () => this.fail(host));
    host.worker.on('error', () => this.fail(host));
    host.worker.on('exit', () => {
      // Even during producer drain, exit cannot leave a host eligible for later causal work.
      this.fail(host);
      // A failed channel alone cannot prove the worker released its queued bytes. Exit can.
      for (const [database, bytes] of host.backing)
        this.adjustBacking(database, -bytes.inputBytes, -bytes.materialBytes);
      host.backing.clear();
      for (const reservation of host.capacity) reservation.release();
      host.capacity.clear();
      host.terminated = true;
      host.exited.resolve();
    });
    host.worker.unref();
    return host.worker;
  }

  /** True only after explicit shutdown has terminated the owned worker. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Retains an accepted producer, including asynchronous preparation, until its own closeout settles.
   * @param publication Optional exact initial product identity, never retry authority.
   * @param reservation Existing publication count, or the exact invocation credit borrowed through terminal Item acknowledgement.
   * @param closeout Exact capability call whose serial closeout retains one count credit.
   * @returns The original producer result after its own closeout.
   */
  async runOperation<T>(
    operation: () => Promise<T>,
    publication?: ControlPublicationIdentity,
    reservation?:
      | string
      | { readonly database: string; readonly closeout: CapabilityCloseoutCredit },
    closeout?: { readonly database: string; readonly callId: string },
    progressCopy?: ProgressCopyCredit
  ): Promise<T> {
    this.assertAccepting();
    const reservedDatabase = typeof reservation === 'string' ? reservation : reservation?.database;
    if (reservedDatabase !== undefined) this.assertScopeProducerAdmission(reservedDatabase);
    if (
      closeout &&
      (this.outstanding.get(closeout.database) ?? 0) >= CONTROL_WORKER_LIMITS.pendingTransitions
    )
      throw new ControlStoreWorkerError('busy', 'not-committed');
    const credit = closeout && { ...closeout, active: true, borrowing: false };
    if (credit)
      this.outstanding.set(credit.database, (this.outstanding.get(credit.database) ?? 0) + 1);
    const context = {
      active: true,
      publication,
      progressCopy,
      reservation: reservedDatabase,
      closeout: credit ?? (typeof reservation === 'object' ? reservation.closeout : undefined),
    };
    // Register before invoking the producer: its synchronous Core commit may expose this identity.
    const promise = this.operationContext.run(context, () => Promise.resolve().then(operation));
    this.operations.set(promise, publication);
    try {
      return await promise;
    } finally {
      context.active = false;
      this.operations.delete(promise);
      if (credit) {
        credit.active = false;
        // An unawaited descendant still owns its actual native backing until its reply or disposal.
        if (!credit.borrowing) this.releaseOutstanding(credit.database);
      }
    }
  }

  /** Counts the same Turn's accepted preparation and direct native observation slots once. */
  private pendingTurnPublications(key: string): number {
    const [physical, turn] = JSON.parse(key) as [string, string];
    let count = this.turnTails.get(key)?.pending ?? 0;
    for (const entry of this.pending.values())
      if (
        entry.counted &&
        (entry.command.operation === 'observation' ||
          entry.command.operation === 'provenance' ||
          entry.command.operation === 'scheduler-admission' ||
          entry.command.operation === 'generative-presentation' ||
          entry.command.operation === 'worker-control-evidence') &&
        this.openings.get(entry.command.database)?.path === physical &&
        entry.command.input.turnId === turn
      )
        count += 1;
    return count;
  }

  /** Owns JSON input before same-Turn head capture through ACK; only an exact terminal Item borrows its invocation credit. */
  async runTurnPublication<I, T>(
    database: string,
    turns: readonly string[],
    input: I,
    prepare: (owned: I) => Promise<T>,
    closeoutCallId?: string,
    progressPublication?: ControlProgressPublication
  ): Promise<T> {
    this.assertAccepting();
    this.assertScopeProducerAdmission(database);
    const context = this.operationContext.getStore();
    const credit = context?.closeout;
    const closeout =
      !progressPublication &&
      context?.active &&
      credit?.active &&
      !credit.borrowing &&
      credit.database === database &&
      credit.callId === closeoutCallId
        ? credit
        : undefined;
    // Leave the existing closeout/open/admission counts for one cold MCP producer,
    // and one Turn slot plus a bounded body/envelope share for durable publication.
    const progress = progressPublication !== undefined;
    const countLimit = CONTROL_WORKER_LIMITS.pendingTransitions - (progress ? 3 : 0);
    const turnLimit = CONTROL_WORKER_LIMITS.pendingTurnTransitions - (progress ? 1 : 0);
    const byteLimit = progress
      ? CONTROL_WORKER_LIMITS.pendingBytes -
        CONTROL_PRODUCT_LIMITS.immutableBodyBytes -
        CONTROL_PRODUCT_LIMITS.payloadBytes
      : CONTROL_WORKER_LIMITS.pendingBytes;
    const json = JSON.stringify(input);
    const bytes = Buffer.byteLength(json) + 64;
    // These are the two real serial native frames. Reserve their larger copy now, so
    // a later durable offer cannot make accepted progress fail after installing its tail.
    const copyBytes = progressPublication
      ? Math.max(
          controlWorkerInputBytes({
            operation: 'item',
            database,
            input: progressPublication.input,
            version: CONTROL_WORKER_VERSION,
            id: Number.MAX_SAFE_INTEGER,
          }),
          controlWorkerInputBytes({
            ...progressPublication.opening,
            operation: 'open',
            version: CONTROL_WORKER_VERSION,
            id: Number.MAX_SAFE_INTEGER,
          })
        ) + 64
      : 0;
    const progressCopy: ProgressCopyCredit | undefined = progressPublication && {
      database,
      itemId: progressPublication.input.item.id,
      turnId: progressPublication.input.item.turnId,
      category: progressPublication.input.category,
      openingHash: commandInputHash(progressPublication.opening),
      active: true,
      remainingBytes: copyBytes,
      borrowing: false,
      openUsed: false,
      itemUsed: false,
    };
    if (
      !closeout &&
      ((this.outstanding.get(database) ?? 0) >= countLimit ||
        bytes + copyBytes > byteLimit - this.reservedInputBytes(database))
    )
      throw new ControlStoreWorkerError('busy', 'not-committed');
    const physical = realpathSync(database.slice(database.indexOf(':') + 1));
    const keys = [...new Set(turns)].map((turn) => JSON.stringify([physical, turn]));
    // Check the complete selector set before reserving any member or installing its tail.
    if (
      !closeout &&
      keys.some(
        (key) =>
          this.pendingTurnPublications(key) >= turnLimit ||
          (progress && (this.turnTails.get(key)?.durablePending ?? 0) > 0)
      )
    )
      throw new ControlStoreWorkerError('busy', 'not-committed');
    const predecessors = keys.map((key) => this.turnTails.get(key)?.tail);
    let settleProgress: (() => void) | undefined;
    const progressSettled = progress
      ? new Promise<void>((resolve) => {
          settleProgress = resolve;
        })
      : undefined;
    if (progressSettled) this.progressSettlements.set(progressSettled, database);
    if (progressCopy) this.adjustProgressCopyBytes(database, copyBytes);
    this.adjustBacking(database, bytes, 0);
    if (closeout) closeout.borrowing = true;
    else this.outstanding.set(database, (this.outstanding.get(database) ?? 0) + 1);
    const result = this.runOperation(
      async () => {
        try {
          await Promise.all(predecessors);
        } catch {
          throw new ControlStoreWorkerError('precondition', 'not-committed');
        }
        // The outer owned JSON and inner native clone are both charged. A large durable
        // producer waits for already accepted progress ACKs before making that second copy.
        if (!progress && this.progressSettlements.size > 0)
          await this.waitForProgressBacking(database, bytes);
        return prepare(JSON.parse(json) as I);
      },
      undefined,
      closeout ? { database, closeout } : database,
      undefined,
      progressCopy
    );
    for (const key of keys)
      this.turnTails.set(key, {
        tail: result,
        pending: (this.turnTails.get(key)?.pending ?? 0) + 1,
        // Progress may not queue behind a durable body that can need its ACK byte capacity.
        durablePending: (this.turnTails.get(key)?.durablePending ?? 0) + (progress ? 0 : 1),
      });
    try {
      return await result;
    } finally {
      this.adjustBacking(database, -bytes, 0);
      if (progressCopy) {
        progressCopy.active = false;
        this.adjustProgressCopyBytes(database, -progressCopy.remainingBytes);
        progressCopy.remainingBytes = 0;
      }
      if (closeout) {
        closeout.borrowing = false;
        if (!closeout.active) this.releaseOutstanding(database);
      } else this.releaseOutstanding(database);
      for (const key of keys) {
        const entry = this.turnTails.get(key)!;
        if (!progress) entry.durablePending--;
        if (--entry.pending === 0) this.turnTails.delete(key);
      }
      if (progressSettled) {
        this.progressSettlements.delete(progressSettled);
        settleProgress!();
      }
    }
  }

  /** Frees no bytes early and posts no retry: the existing admitted producer awaits finite progress ACKs. */
  private async waitForProgressBacking(database: string, bytes: number): Promise<void> {
    while (
      this.reservedInputBytes(database) + bytes + CONTROL_PRODUCT_LIMITS.payloadBytes >
      CONTROL_WORKER_LIMITS.pendingBytes
    ) {
      const progress = [...this.progressSettlements]
        .filter(([, scope]) => scope === database)
        .map(([settled]) => settled);
      if (progress.length === 0) return;
      await Promise.all(progress);
      this.assertAccepting();
    }
  }

  /** Future progress clones compete with actual input against the original hard bound. */
  private reservedInputBytes(database: string | undefined): number {
    return (
      (this.backing.get(database)?.inputBytes ?? 0) +
      (database === undefined ? 0 : (this.progressCopyBytes.get(database) ?? 0))
    );
  }

  /** Transfers one original booking to/from actual request backing without another input queue. */
  private adjustProgressCopyBytes(database: string, bytes: number): void {
    const remaining = (this.progressCopyBytes.get(database) ?? 0) + bytes;
    if (remaining === 0) this.progressCopyBytes.delete(database);
    else this.progressCopyBytes.set(database, remaining);
  }

  /** Releases one admitted producer or independently counted native request. */
  private releaseOutstanding(database: string): void {
    const remaining = (this.outstanding.get(database) ?? 1) - 1;
    if (remaining === 0) this.outstanding.delete(database);
    else this.outstanding.set(database, remaining);
  }

  /** Observes only an exact live original admission; absence never authorizes publication or replay. */
  async waitForPublication(publication: ControlPublicationIdentity): Promise<void> {
    if (
      this.operationContext.getStore()?.active &&
      isDeepStrictEqual(this.operationContext.getStore()?.publication, publication)
    )
      throw new Error('A publication cannot join itself.');
    const matches = [...this.operations].filter(([, identity]) =>
      isDeepStrictEqual(identity, publication)
    );
    if (matches.length > 1) throw new Error('Publication identity is ambiguous.');
    // The caller must inspect canonical history even when the original acknowledgement was lost.
    if (matches[0]) await matches[0][0].catch(() => undefined);
  }

  /** Only still-active accepted producers may continue submitting work during shutdown drain. */
  private assertAccepting(): void {
    if (this.closed || (this.stopping && !this.operationContext.getStore()?.active))
      throw new ControlStoreWorkerShutdownError();
  }

  /** Refuses a new producer before its reservation, tail or active context can enter a retiring scope. */
  private assertScopeProducerAdmission(database: string): void {
    if (this.openings.get(database)?.retirement)
      throw new ControlStoreWorkerError('busy', 'not-committed');
  }

  /** Reserves physical identity before posting; unrelated openings never wait for another native ACK. */
  private reserveOpening(command: Omit<OpenCommand, 'operation'>): {
    path: string;
    identity: string | undefined;
    host: WriterHost;
  } {
    let path: string;
    let identity: string | undefined;
    try {
      const incoming = statSync(command.path, { throwIfNoEntry: false });
      const leaf = lstatSync(command.path, { throwIfNoEntry: false });
      if (!incoming && leaf?.isSymbolicLink())
        throw new Error('A dangling link cannot reserve a new database.');
      path = incoming
        ? realpathSync(command.path)
        : join(realpathSync(dirname(command.path)), basename(command.path));
      identity = incoming ? `${incoming.dev}:${incoming.ino}` : undefined;
      // Incoming identity is read first: an alias of a newly initialized file implies
      // that its earlier reserved path can now supply that inode, even before ACK.
      for (const opening of this.openings.values()) {
        if (opening.identity === undefined) {
          const current = statSync(opening.path, { throwIfNoEntry: false });
          if (current) opening.identity = `${current.dev}:${current.ino}`;
        }
        if (opening.path === path || (identity !== undefined && opening.identity === identity))
          throw new Error('Duplicate physical database.');
      }
    } catch {
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    }
    const candidates =
      command.productOwner?.kind === 'server' || command.initialize === 'core'
        ? this.hosts.slice(0, 1)
        : this.hosts.slice(1);
    const counts = new Map(candidates.map((host) => [host, 0]));
    for (const opening of this.openings.values())
      if (counts.has(opening.host)) counts.set(opening.host, counts.get(opening.host)! + 1);
    const host = candidates
      .filter((candidate) => !candidate.failed)
      .reduce<WriterHost | undefined>(
        (least, candidate) =>
          least === undefined || counts.get(candidate)! < counts.get(least)! ? candidate : least,
        undefined
      );
    if (!host) throw new ControlStoreWorkerError('unavailable', 'not-committed');
    return { path, identity, host };
  }

  /** Checks the exact freeze and physical owner again at each trusted lifecycle submission. */
  private assertFrozenCall(
    command: ControlWorkerCommand,
    recovery: ControlFrozenNativeCall | undefined,
    opening?: Opening
  ): void {
    if (recovery === undefined) {
      const owner =
        command.operation === 'open'
          ? (command.productOwner ?? command.physicalScope)
          : (opening?.command.productOwner ??
            opening?.command.physicalScope ??
            ('database' in command
              ? (this.openings.get(command.database)?.command.productOwner ??
                this.openings.get(command.database)?.command.physicalScope)
              : undefined));
      if (
        (owner?.kind === 'workspace' || owner?.kind === 'app') &&
        this.workspaceMutationAdmission?.isClosed(owner.workspaceId, 'capture')
      )
        throw new OperationError('workspace_frozen', 'Workspace is temporarily frozen.', 409, {
          details: {
            workspaceId: owner.workspaceId,
            operation: 'capture',
            retryable: true,
            blockers: [
              {
                kind: 'publication',
                reason: 'frozen',
                reference: { workspaceId: owner.workspaceId },
                actions: [],
              },
            ],
          },
        });
      return;
    }
    if ('kind' in recovery && recovery.kind === 'core-sharing-retirement') {
      try {
        const physical =
          opening ?? ('database' in command ? this.openings.get(command.database) : undefined);
        const current = statSync(recovery.path);
        if (
          recovery[coreRetirementCall] !== true ||
          recovery.command.productOwner?.kind !== 'server' ||
          recovery.command.initialize !== 'core' ||
          recovery.command.create !== false ||
          recovery.command.database !== `core:${resolve(recovery.command.path)}` ||
          realpathSync(recovery.command.path) !== recovery.path ||
          `${current.dev}:${current.ino}` !== recovery.identity ||
          !physical ||
          physical.path !== recovery.path ||
          physical.identity !== recovery.identity ||
          !isDeepStrictEqual(physical.command, recovery.command) ||
          command.operation !== 'core-sharing' ||
          command.database !== recovery.command.database ||
          !isDeepStrictEqual(command.input, recovery.input)
        )
          throw new Error('Retirement lifecycle binding is not current.');
      } catch {
        throw new ControlStoreWorkerError('precondition', 'not-committed');
      }
      recovery.assertCurrent();
      return;
    }
    if ('kind' in recovery && recovery.kind === 'recovery-source-reactivation') {
      try {
        const physical =
          opening ?? ('database' in command ? this.openings.get(command.database) : undefined);
        const current = statSync(recovery.path);
        const workspace = recovery.input.stage === 'workspace';
        const owner = recovery.command.productOwner;
        if (
          recovery[sourceReactivationCall] !== true ||
          (workspace
            ? owner?.kind !== 'workspace' || owner.workspaceId !== recovery.input.workspaceId
            : owner?.kind !== 'server') ||
          recovery.command.initialize !== (workspace ? 'workspace' : 'core') ||
          recovery.command.create !== false ||
          recovery.command.database !==
            `${workspace ? 'workspace' : 'core'}:${resolve(recovery.command.path)}` ||
          realpathSync(recovery.command.path) !== recovery.path ||
          `${current.dev}:${current.ino}` !== recovery.identity ||
          !physical ||
          physical.path !== recovery.path ||
          physical.identity !== recovery.identity ||
          !isDeepStrictEqual(physical.command, recovery.command) ||
          command.operation !== recovery.kind ||
          command.database !== recovery.command.database ||
          !isDeepStrictEqual(command.input, recovery.input)
        )
          throw new Error('Stopped reactivation lifecycle binding is not current.');
        return;
      } catch {
        throw new ControlStoreWorkerError('precondition', 'not-committed');
      }
    }
    if (
      'kind' in recovery &&
      (recovery.kind === 'recovery-target-registration' ||
        recovery.kind === 'recovery-target-preparation')
    ) {
      try {
        const physical =
          opening ?? ('database' in command ? this.openings.get(command.database) : undefined);
        const current = statSync(recovery.path);
        if (
          recovery[recoveryTargetRegistrationCall] !== true ||
          (recovery.input.authority.mode !== 'stopped'
            ? !recovery.freeze ||
              !this.workspaceMutationAdmission?.ownsFreeze(
                recovery.input.workspaceId,
                recovery.freeze
              )
            : recovery.freeze !== undefined) ||
          recovery.command.productOwner?.kind !== 'server' ||
          recovery.command.initialize !== 'core' ||
          recovery.command.create !== false ||
          recovery.command.database !== `core:${resolve(recovery.command.path)}` ||
          realpathSync(recovery.command.path) !== recovery.path ||
          `${current.dev}:${current.ino}` !== recovery.identity ||
          !physical ||
          physical.path !== recovery.path ||
          physical.identity !== recovery.identity ||
          !isDeepStrictEqual(physical.command, recovery.command) ||
          command.operation !== recovery.kind ||
          command.database !== recovery.command.database ||
          !isDeepStrictEqual(command.input, recovery.input)
        )
          throw new Error('Target registration lifecycle binding is not current.');
      } catch {
        throw new ControlStoreWorkerError('precondition', 'not-committed');
      }
      if (recovery.input.authority.mode === 'source') {
        if (recovery.kind !== 'recovery-target-preparation' || !recovery.assertCurrent)
          throw new ControlStoreWorkerError('precondition', 'not-committed');
        recovery.assertCurrent();
      }
      return;
    }
    if ('kind' in recovery && recovery.kind === 'workspace-deletion') {
      try {
        const physical =
          opening ?? ('database' in command ? this.openings.get(command.database) : undefined);
        const current = statSync(recovery.path);
        if (
          recovery[workspaceDeletionCall] !== true ||
          !this.workspaceMutationAdmission?.ownsFreeze(
            recovery.input.workspaceId,
            recovery.freeze
          ) ||
          recovery.command.productOwner?.kind !== 'server' ||
          recovery.command.initialize !== 'core' ||
          recovery.command.create !== false ||
          recovery.command.database !== `core:${resolve(recovery.command.path)}` ||
          realpathSync(recovery.command.path) !== recovery.path ||
          `${current.dev}:${current.ino}` !== recovery.identity ||
          !physical ||
          physical.path !== recovery.path ||
          physical.identity !== recovery.identity ||
          !isDeepStrictEqual(physical.command, recovery.command) ||
          command.operation !== 'workspace-deletion' ||
          command.database !== recovery.command.database ||
          !isDeepStrictEqual(command.input, recovery.input)
        )
          throw new Error('Deletion lifecycle binding is not current.');
        return;
      } catch {
        throw new ControlStoreWorkerError('precondition', 'not-committed');
      }
    }
    try {
      const { binding, freeze } = recovery;
      const owner = binding.command.productOwner;
      const physical =
        opening ?? ('database' in command ? this.openings.get(command.database) : undefined);
      let admitted = physical?.command;
      if (command.operation === 'open') {
        // Request framing is assigned after admission; it is not part of the physical open binding.
        const {
          operation: _operation,
          version: _version,
          id: _id,
          ...input
        } = command as Extract<ControlWorkerRequest, { operation: 'open' }>;
        admitted = input;
      }
      const current = statSync(binding.path);
      if (command.operation === 'close' && physical?.command.physicalScope) {
        const app = physical.command.physicalScope;
        const original = this.openings.get(binding.command.database);
        if (
          owner?.kind !== 'workspace' ||
          app.workspaceId !== owner.workspaceId ||
          !this.workspaceMutationAdmission?.isRecoveryBinding(owner.workspaceId, freeze, binding) ||
          binding.command.create !== false ||
          binding.command.initialize !== 'workspace' ||
          !original ||
          !isDeepStrictEqual(original.command, binding.command) ||
          original.path !== binding.path ||
          original.identity !== binding.identity ||
          realpathSync(binding.command.path) !== binding.path ||
          `${current.dev}:${current.ino}` !== binding.identity ||
          realpathSync(physical.command.dataRoot!) !== realpathSync(binding.command.dataRoot!) ||
          realpathSync(physical.command.path) !== physical.path ||
          command.database !== physical.command.database
        )
          throw new Error('Dependent App close binding is not current.');
        const child = statSync(physical.path);
        if (`${child.dev}:${child.ino}` !== physical.identity)
          throw new Error('Dependent App identity changed.');
        return;
      }
      if (
        owner?.kind !== 'workspace' ||
        !this.workspaceMutationAdmission?.isRecoveryBinding(owner.workspaceId, freeze, binding) ||
        !('database' in command) ||
        command.database !== binding.command.database ||
        binding.command.create !== false ||
        binding.command.initialize !== 'workspace' ||
        realpathSync(binding.command.path) !== binding.path ||
        `${current.dev}:${current.ino}` !== binding.identity ||
        (physical !== undefined &&
          (physical.path !== binding.path || physical.identity !== binding.identity)) ||
        !isDeepStrictEqual(binding.command, admitted) ||
        (command.operation === 'recovery-safety' &&
          resolve(command.input.sourceDataRoot) !== binding.sourceDataRoot)
      )
        throw new Error('Recovery binding is not current.');
    } catch {
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    }
  }

  /** Uses the already reserved canonical paths to exclude a late child during its parent's close. */
  private assertParentOpenAdmission(command: Omit<OpenCommand, 'operation'>, path: string): void {
    if (!command.physicalScope) return;
    const workspaceRoot = dirname(dirname(dirname(path)));
    for (const parent of this.openings.values()) {
      if (
        parent.retirement &&
        parent.command.productOwner?.kind === 'workspace' &&
        parent.command.productOwner.workspaceId === command.physicalScope.workspaceId &&
        dirname(dirname(parent.path)) === workspaceRoot
      )
        throw new ControlStoreWorkerError('busy', 'not-committed');
    }
  }

  /**
   * Opens an admitted physical scope and optionally applies its existing native journal.
   *
   * @param command Trusted path/fresh-scope admission; app recovery is not bypassed.
   * Repeated access to the exact admitted binding shares its existing opening acknowledgement; it never reopens a scope or retries a failed command. Changed bindings and physical aliases still fail closed in the existing owner.
   *
   * @returns After connection policy and requested initialization have completed in the worker.
   */
  async open(
    command: Omit<OpenCommand, 'operation'>,
    recovery?: ControlRecoveryNativeCall
  ): Promise<void> {
    await this.openFrozen(command, recovery);
  }

  /** Internal open shared by ordinary admission and the existing recovery lifecycle. */
  private async openFrozen(
    command: Omit<OpenCommand, 'operation'>,
    recovery?: ControlFrozenNativeCall
  ): Promise<void> {
    this.assertAccepting();
    if (
      !isControlWorkerRequest({
        ...command,
        operation: 'open',
        version: CONTROL_WORKER_VERSION,
        id: 0,
      })
    )
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    this.assertFrozenCall({ ...command, operation: 'open' }, recovery);
    const existing = this.openings.get(command.database);
    if (existing) {
      if (existing.host.failed) throw new ControlStoreWorkerError('unavailable', 'not-committed');
      if (existing.retirement) {
        // Only preparation admitted before retirement may finish through its original scope drain.
        // New reserved operations and Turn publications are refused before acquiring this context.
        const context = this.operationContext.getStore();
        if (!context?.active || context.reservation !== command.database)
          throw new ControlStoreWorkerError('busy', 'not-committed');
      }
      this.assertParentOpenAdmission(command, existing.path);
      if (
        !isDeepStrictEqual(existing.command, command) &&
        !(
          // Acknowledged first-User creation may join later existing-User callers on the exact binding.
          (command.physicalScope || command.initialize === 'user') &&
          existing.acknowledged &&
          existing.command.create &&
          !command.create &&
          isDeepStrictEqual({ ...existing.command, create: false }, command)
        )
      )
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      await existing.promise;
      this.assertFrozenCall({ ...command, operation: 'open' }, recovery);
      return;
    }
    const binding = structuredClone(command);
    const physical = this.reserveOpening(binding);
    this.assertParentOpenAdmission(binding, physical.path);
    const opening: Opening = {
      command: binding,
      ...physical,
      acknowledged: false,
      openingRequestId: undefined,
      policyReads: new Set(),
      promise: this.request(
        { ...binding, operation: 'open' },
        undefined,
        physical.host,
        false,
        recovery
      ).then((reply) => {
        try {
          const current = statSync(physical.path);
          const identity = `${current.dev}:${current.ino}`;
          if (opening.identity !== undefined && opening.identity !== identity)
            throw new Error('Physical database changed.');
          opening.identity = identity;
          opening.openingRequestId = reply.id;
          opening.acknowledged = true;
        } catch {
          this.fail(physical.host);
          throw new ControlStoreWorkerError('unavailable', 'unknown');
        }
      }),
    };
    this.openings.set(command.database, opening);
    try {
      await opening.promise;
    } catch (error) {
      // Unknown channel results retain their physical reservation until explicit shutdown.
      if (!physical.host.failed && this.openings.get(command.database) === opening)
        this.openings.delete(command.database);
      throw error;
    }
  }

  /**
   * Submits a whole conditional transition and its original receipt, never a callback.
   *
   * @param database Already-admitted worker database key.
   * @param statements Bounded Core-owned SQL; immutable content is synchronized before submission.
   * @returns Materialized results only after durable outer COMMIT.
   */
  async write(
    database: string,
    statements: readonly ControlSqlStatement[],
    recovery?: ControlRecoveryNativeCall
  ): Promise<readonly ControlSqlResult[]> {
    return this.writeFrozen(database, statements, recovery);
  }

  /** Internal write shared by the existing recovery composition. */
  private async writeFrozen(
    database: string,
    statements: readonly ControlSqlStatement[],
    recovery?: ControlFrozenNativeCall
  ): Promise<readonly ControlSqlResult[]> {
    const reply = await this.request(
      { operation: 'write', database, statements },
      undefined,
      undefined,
      false,
      recovery
    );
    return (reply as Extract<Success, { operation: 'write' }>).results;
  }

  /** Advances one original captured history unit and acknowledges only its native covering commit. */
  async recoveryHistory(
    database: string,
    workspaceId: string,
    recovery?: ControlRecoveryNativeCall
  ): Promise<boolean> {
    const reply = await this.request(
      { operation: 'recovery-history', database, workspaceId },
      undefined,
      undefined,
      false,
      recovery
    );
    return (reply as Extract<Success, { operation: 'recovery-history' }>).done;
  }

  /** Copies proved current safety into an admitted private candidate, acknowledged only after FULL COMMIT. */
  async recoverySafety(
    database: string,
    input: ControlRecoverySafetyInput,
    recovery?: ControlRecoveryNativeCall
  ): Promise<ControlRecoverySafetyResult> {
    const reply = await this.request(
      { operation: 'recovery-safety', database, input },
      undefined,
      undefined,
      false,
      recovery
    );
    return (reply as Extract<Success, { operation: 'recovery-safety' }>).result;
  }

  /** Commits the exact source MOVE tuple and original Audit before acknowledging its covering FULL commit. */
  async recoveryMoveOut(
    database: string,
    input: ControlRecoveryMoveOutInput,
    recovery?: ControlRecoveryNativeCall
  ): Promise<void> {
    await this.request(
      { operation: 'recovery-move-out', database, input },
      undefined,
      undefined,
      false,
      recovery
    );
  }

  /** Ends exactly one capture through its original SQL owner; acknowledgement follows covering FULL COMMIT. */
  async recoveryCapture(
    database: string,
    input: ControlRecoveryCaptureInput,
    recovery?: ControlRecoveryNativeCall
  ): Promise<void> {
    await this.request(
      { operation: 'recovery-capture', database, input },
      undefined,
      undefined,
      false,
      recovery
    );
  }

  /** Cleans an admitted private recovery candidate through the existing native transaction and FULL ACK. */
  async recoveryCleanup(
    database: string,
    input: ControlRecoveryCleanupInput,
    recovery?: ControlRecoveryNativeCall
  ): Promise<void> {
    await this.request(
      { operation: 'recovery-cleanup', database, input },
      undefined,
      undefined,
      false,
      recovery
    );
  }

  /**
   * Submits the native admission/product tuple, original receipt and required local Audit to the owning worker.
   *
   * Immutable entries must already be published through Storage; the worker verifies and synchronizes their actual bytes before SQL. This preparation API has no public caller binding. Receipt replay returns the original response, not a newly proposed resource identity.
   */
  async transition(
    database: string,
    transition: ControlAdmission
  ): Promise<ControlAdmissionResult> {
    const reply = await this.request({ operation: 'transition', database, transition });
    return (reply as Extract<Success, { operation: 'transition' }>).result;
  }

  /** Submits a whole non-command product/lifecycle transition; success follows outer FULL COMMIT, never a queued-write acknowledgement. */
  async products(database: string, transition: ControlProductTransition): Promise<void> {
    await this.request({ operation: 'products', database, transition });
  }

  /** Publishes an addressed Item only after its native head checks, exact bytes and covering FULL commit. */
  async appendItem(
    database: string,
    input: ControlItemAppend,
    mcpCall?: ControlMcpItemCall
  ): Promise<ControlItemAppend['item']> {
    try {
      const reply = await this.request({
        operation: 'item',
        database,
        input,
        ...(mcpCall && { mcpCall }),
      });
      return (reply as Extract<Success, { operation: 'item' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.commit === 'not-committed' &&
        error.domain?.operation === 'item'
      )
        throw new Error(error.domain.message);
      throw error;
    }
  }

  /** Publishes one event intent after native sequence allocation and its covering FULL commit. */
  async appendEvent(
    database: string,
    input: ControlEventAppend
  ): Promise<ControlEventAppendResult> {
    try {
      const reply = await this.request({
        operation: 'event',
        database,
        input: ControlEventAppendSchema.parse(input),
      });
      return (reply as Extract<Success, { operation: 'event' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.commit === 'not-committed' &&
        error.domain?.operation === 'event'
      )
        throw new Error(error.domain.message);
      throw error;
    }
  }

  /**
   * Admits one finite eligible Item/event prefix atomically into existing native request slots.
   *
   * Each member retains its own deciding CAS, savepoint and FULL acknowledgement. The ordered
   * results preserve an earlier committed member when a later member or its suffix refuses.
   * This is private writer framing; callers still own progress eligibility and source retention.
   */
  async productsCohort(
    database: string,
    transitions: readonly ControlProductTransition[],
    options: { readonly immediate?: boolean } = {}
  ): Promise<readonly PromiseSettledResult<void>[]> {
    this.assertAccepting();
    if (transitions.length === 0 || transitions.length > CONTROL_WORKER_LIMITS.batchTransitions)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const requests = transitions.map(
      (transition, index) =>
        ({
          version: CONTROL_WORKER_VERSION,
          operation: 'products' as const,
          database,
          transition,
          id: this.nextId + index,
        }) as const
    );
    const frame: ControlProductCohort = {
      version: CONTROL_WORKER_VERSION,
      operation: 'products',
      requests,
      immediate: options.immediate ?? false,
    };
    if (!isControlProductCohort(frame))
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const bytes = requests.reduce(
      (total, request) => total + controlWorkerInputBytes(request) + 64,
      0
    );
    if (
      (this.outstanding.get(database) ?? 0) + requests.length >
        CONTROL_WORKER_LIMITS.pendingTransitions ||
      this.reservedInputBytes(database) + bytes > CONTROL_WORKER_LIMITS.pendingBytes
    )
      throw new ControlStoreWorkerError('busy', 'not-committed');
    // No await or post occurs between the complete admission check and reservation of all slots.
    const results = requests.map((request) =>
      this.request(
        { operation: 'products', database, transition: request.transition },
        undefined,
        undefined,
        true
      ).then(() => undefined)
    );
    const entries = requests.map((request) => this.pending.get(request.id));
    if (entries.some((entry) => !entry)) {
      for (const request of requests)
        this.complete(
          request.id,
          undefined,
          new ControlStoreWorkerError('invalid-request', 'not-committed')
        );
    } else {
      const admitted = entries as Pending[];
      const cohort: PendingCohort = {
        frame: {
          ...frame,
          requests: admitted.map((entry) => entry.request) as ControlProductCohort['requests'],
        },
        inputBytes: admitted.reduce((total, entry) => total + entry.inputBytes, 0),
        remaining: admitted.length,
      };
      for (const entry of admitted) entry.cohort = cohort;
      this.post(admitted[0]!);
    }
    return Promise.allSettled(results);
  }

  /** Publishes only the named sealed-Turn entry category after native preparation and FULL acknowledgement. */
  async publication(database: string, input: ControlPublicationInput): Promise<void> {
    await this.request({ operation: 'publication', database, input });
  }

  /** Commits the complete Workspace cleanup projection on its admitted scoped handle; physical release authority remains with its existing producer. */
  async projectCleanup(
    database: string,
    input: ProjectWorkerBackendCleanupInput
  ): Promise<WorkerBackendCleanupProjectionResult> {
    const reply = await this.request({ operation: 'project-cleanup', database, input });
    return (reply as Extract<Success, { operation: 'project-cleanup' }>).result;
  }

  /** Returns the exact native User-owned union only after its covering FULL commit. */
  async threadReadMembership(
    database: string,
    input: ControlThreadReadMembership
  ): Promise<string[]> {
    const json = JSON.stringify(input.itemIds);
    const wire = {
      userId: input.userId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      byteLength: Buffer.byteLength(json),
    };
    try {
      const reply = await this.request(
        { operation: 'thread-read-membership', database, input: wire },
        [json]
      );
      return (reply as Extract<Success, { operation: 'thread-read-membership' }>).itemIds;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'thread-read-membership'
      )
        throw new Error(THREAD_READ_RECEIPT_INVALID, { cause: error });
      throw error;
    }
  }

  /** Publishes or inspects only the actual canonical Core owner's disposable loaded-Policy readiness. */
  async runtimePolicyPublication(
    db: CoreDb,
    value: RuntimePolicyPublicationInput
  ): Promise<RuntimePolicyPublicationResult> {
    if (!db.sqlite.open) throw new ControlStoreWorkerError('precondition', 'not-committed');
    const input = RuntimePolicyPublicationInputSchema.parse(value);
    const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
    const database = `core:${scope.path}`;
    await this.open({
      database,
      path: scope.path,
      create: false,
      initialize: 'core',
      dataRoot: db.dataRoot,
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    if (!db.sqlite.open) throw new ControlStoreWorkerError('precondition', 'not-committed');
    const reply = await this.request({ operation: 'runtime-policy-publication', database, input });
    return RuntimePolicyPublicationResultSchema.parse(
      (reply as Extract<Success, { operation: 'runtime-policy-publication' }>).result
    );
  }

  /** The sole new ingress. The ordinary admission callback remains PREPOST. */
  async activateHarnessLoginWithPolicyBorrow(
    coreDb: CoreDb,
    workspaceDb: WorkspaceDb,
    record: ControlVaultMainInputMap['thread-login-activate'],
    beforeSubmit?: () => void | Promise<void>
  ): Promise<null> {
    const { now, ...facts } = record;
    const input = ControlVaultInputSchema.parse({
      kind: 'thread-login-activate',
      record: { ...facts, now: now() },
    });
    const core = await this.policyOpening(coreDb);
    const borrower = await this.policyOpening(workspaceDb);
    const [coreRoot, workspaceRoot] = await Promise.all([
      realpath(coreDb.dataRoot),
      realpath(workspaceDb.dataRoot),
    ]);
    if (coreRoot !== workspaceRoot)
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    const admission = beforeSubmit?.();
    if (admission) await admission;
    if (!coreDb.sqlite.open || !workspaceDb.sqlite.open)
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    const call: PolicyCall = {
      id: -1,
      core,
      borrower,
      phase: 'new',
      borrowed: Promise.withResolvers<ControlPolicyGrant>(),
      returned: Promise.withResolvers<void>(),
    };
    void call.borrowed.promise.catch(() => undefined);
    void call.returned.promise.catch(() => undefined);
    const reply = await this.request(
      { operation: 'vault', database: borrower.command.database, input, policyRead: true },
      undefined,
      undefined,
      false,
      undefined,
      [],
      undefined,
      call
    );
    if (reply.operation !== 'vault' || reply.result.kind !== 'thread-login-activate')
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    return reply.result.value;
  }

  private async policyOpening(db: CoreDb | WorkspaceDb): Promise<Opening> {
    if (!db.sqlite.open) throw new ControlStoreWorkerError('precondition', 'not-committed');
    const scope = nativeProductScope(
      db.dataRoot,
      db.scope === 'core' ? { kind: 'server' } : { kind: 'workspace', workspaceId: db.workspaceId }
    );
    const database = `${db.scope === 'core' ? 'core' : 'workspace'}:${scope.path}`;
    await this.open({
      database,
      path: scope.path,
      create: false,
      initialize: db.scope === 'core' ? 'core' : 'workspace',
      dataRoot: db.dataRoot,
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    const opening = this.openings.get(database);
    if (!opening?.acknowledged || opening.openingRequestId === undefined)
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    return opening;
  }

  /** Opens the exact existing evidence database and publishes one original Vault stage after FULL acknowledgement. */
  async vault<K extends ControlVaultInput['kind']>(
    db: CoreDb | WorkspaceDb,
    kind: K,
    record: ControlVaultMainInputMap[K],
    beforeSubmit?: () => Promise<void> | void
  ): Promise<ControlVaultResultMap[K]> {
    if (!db.sqlite.open) throw new ControlStoreWorkerError('precondition', 'not-committed');
    const { now, ...facts } = record as typeof record & { readonly now?: () => string };
    // Original public record helpers ignore additional row fields on replay; the private wire stays closed.
    const recordSchema = ControlVaultInputSchema.options.find(
      (option) => option.shape.kind.value === kind
    )!.shape.record;
    const input = ControlVaultInputSchema.parse({
      kind,
      record: ('strip' in recordSchema ? recordSchema.strip() : recordSchema).parse({
        ...facts,
        ...(now === undefined ? {} : { now: now() }),
      }),
    });
    const scope = nativeProductScope(
      db.dataRoot,
      db.scope === 'core' ? { kind: 'server' } : { kind: 'workspace', workspaceId: db.workspaceId }
    );
    const database = `${db.scope === 'core' ? 'core' : 'workspace'}:${scope.path}`;
    await this.open({
      database,
      path: scope.path,
      create: false,
      initialize: db.scope === 'core' ? 'core' : 'workspace',
      dataRoot: db.dataRoot,
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    if (!db.sqlite.open) throw new ControlStoreWorkerError('precondition', 'not-committed');
    const admission = beforeSubmit?.();
    if (admission) await admission;
    if (!db.sqlite.open) throw new ControlStoreWorkerError('precondition', 'not-committed');
    try {
      const reply = await this.request({ operation: 'vault', database, input });
      const result = (reply as Extract<Success, { operation: 'vault' }>).result;
      if (result.kind !== kind) throw new ControlStoreWorkerError('invalid-request', 'unknown');
      return result.value as ControlVaultResultMap[K];
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.commit === 'not-committed' &&
        error.domain?.operation === 'vault' &&
        isControlVaultRefusal(error.domain.code, error.domain.message, error.domain.status)
      ) {
        if (
          !error.domain.code.startsWith('vault_record_') &&
          error.domain.code !== 'vault_grant_narrowing'
        )
          throw new OperationError(error.domain.code, error.domain.message, error.domain.status, {
            cause: error,
          });
        if (error.domain.code === 'vault_grant_narrowing')
          throw new VaultGrantNarrowingError(error.domain.status as 400 | 409);
        if (error.domain.code === 'vault_record_format')
          throw new TypeError(error.domain.message, { cause: error });
        throw new Error(error.domain.message, { cause: error });
      }
      throw error;
    }
  }

  /** Commits one complete original credential or separate Audit stage before its result is published. */
  async nanoHostTransport(
    database: string,
    input: ControlNanoHostTransportInput
  ): Promise<ControlNanoHostTransportResult> {
    try {
      const reply = await this.request({ operation: 'nanohost-transport', database, input });
      return (reply as Extract<Success, { operation: 'nanohost-transport' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.commit === 'not-committed' &&
        error.domain?.operation === 'nanohost-transport' &&
        isNanoHostTransportAdminRefusal(
          error.domain.code,
          error.domain.message,
          error.domain.status
        )
      )
        throw new OperationError(error.domain.code, error.domain.message, error.domain.status, {
          cause: error,
        });
      throw error;
    }
  }

  /** Commits one closed configured SDK stage before returning its original complete record. */
  async betterAuth(
    database: string,
    input: ControlBetterAuthInput
  ): Promise<ControlBetterAuthResult> {
    try {
      const reply = await this.request({ operation: 'better-auth', database, input });
      return (reply as Extract<Success, { operation: 'better-auth' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'better-auth' &&
        isBetterAuthRefusal(error.domain.code, error.domain.message, error.domain.status)
      )
        throw new BetterAuthNativeError(error.domain.code);
      throw error;
    }
  }

  /** Commits only the stopped-operator's original hash-only Token and Audit tuple. */
  async adminRecovery(database: string, input: ControlAdminRecoveryInput): Promise<string> {
    try {
      const reply = await this.request({ operation: 'admin-recovery', database, input });
      return (reply as Extract<Success, { operation: 'admin-recovery' }>).auditEventId;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'admin-recovery')
        throw new AdminRecoveryError(error.domain.code, error.domain.message);
      throw error;
    }
  }

  /** Reserves the existing physical forecast before copying a rollback candidate. */
  reserveAppRollback(database: string, bytes: number): FileStorageReservation {
    this.assertAccepting();
    const opening = this.openings.get(database);
    if (
      !opening?.command.physicalScope ||
      !opening.command.dataRoot ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    )
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    this.assertFrozenCall({ operation: 'close', database }, undefined, opening);
    const root = resolve(opening.command.dataRoot);
    let admission = this.fileAdmissions.get(root);
    if (!admission) {
      admission = new FileStorageAdmission(root, () => 1_000_000_000n);
      this.fileAdmissions.set(root, admission);
    }
    return admission.forPath(opening.path).reserve({
      stagingBytes: BigInt(bytes),
      extractionBytes: 0n,
      derivativeBytes: 0n,
      publicationBytes: 0n,
    });
  }

  /** Publishes one exact App tuple through the existing binary/FIFO/FULL accounts. */
  async appKernel(
    database: string,
    input: ControlAppInput,
    preparedCapacity?: FileStorageReservation
  ): Promise<ControlAppResult> {
    const owned = ControlAppInputSchema.parse(input);
    const json = JSON.stringify(owned);
    const wire: ControlAppWire = {
      workspaceId: owned.workspaceId,
      appId: owned.appId,
      kind: owned.change.kind,
      byteLength: Buffer.byteLength(json),
      ...(owned.execution ? { turnId: owned.execution.turnId } : {}),
    };
    const opening = this.openings.get(database);
    try {
      const result = await this.request(
        { operation: 'app-kernel', database, input: wire, content: new ArrayBuffer(0) },
        [json],
        undefined,
        false,
        undefined,
        preparedCapacity ? [preparedCapacity] : []
      );
      const reply = result as Extract<Success, { operation: 'app-kernel' }>;
      if (owned.change.kind === 'rollback') {
        try {
          if (!opening || !reply.identity) throw new Error('App replacement identity is missing.');
          const current = statSync(opening.path);
          const identity = `${current.dev}:${current.ino}`;
          if (identity !== reply.identity) throw new Error('App replacement identity changed.');
          opening.identity = identity;
        } catch {
          if (opening) this.fail(opening.host);
          throw new ControlStoreWorkerError('unavailable', 'unknown');
        }
      }
      return reply.result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'app-kernel') {
        if (error.domain.code === 'EEXIST')
          throw Object.assign(new Error(error.domain.message), { code: 'EEXIST' });
        throw new KernelCommandError(
          error.domain.code as ConstructorParameters<typeof KernelCommandError>[0],
          error.domain.message,
          {
            status: error.domain.status,
            ...(error.domain.appDetails?.path !== undefined
              ? { path: error.domain.appDetails.path }
              : {}),
            ...(error.domain.appDetails?.limit !== undefined
              ? { limit: error.domain.appDetails.limit }
              : {}),
            ...(error.domain.appDetails?.maximum !== undefined
              ? { maximum: error.domain.appDetails.maximum }
              : {}),
            ...(error.domain.appDetails?.expectedRevision !== undefined
              ? { expectedRevision: error.domain.appDetails.expectedRevision }
              : {}),
            ...(error.domain.appDetails?.currentRevision !== undefined
              ? { currentRevision: error.domain.appDetails.currentRevision }
              : {}),
          }
        );
      }
      throw error;
    } finally {
      if (preparedCapacity && !opening?.host.capacity.has(preparedCapacity))
        preparedCapacity.release();
    }
  }

  /** Retains the exact authenticated rejection row before returning its original public refusal. */
  async workerControlEvidence(
    database: string,
    input: ControlWorkerRejectedEvidence
  ): Promise<void> {
    await this.request({ operation: 'worker-control-evidence', database, input });
  }

  /** Publishes the exact existing presentation tuple under the native byte, Turn and FIFO accounts. */
  async generativePresentation(
    database: string,
    input: ControlGenerativePresentation
  ): Promise<string> {
    // The domain JSON may contain a 2-MiB data model; it uses the existing binary account, never a larger envelope.
    const json = JSON.stringify(input);
    const wire = {
      workspaceId: input.presentation.workspaceId,
      turnId: input.presentation.turnId,
      byteLength: Buffer.byteLength(json),
    };
    try {
      const reply = await this.request(
        { operation: 'generative-presentation', database, input: wire },
        [json]
      );
      return (reply as Extract<Success, { operation: 'generative-presentation' }>).presentationId;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'generative-presentation'
      ) {
        if (error.domain.code === 'idempotency_key_conflict')
          throw new IdempotencyKeyConflictError();
        throw new KernelCommandError('recovery_required', error.domain.message, {
          status: error.domain.status,
        });
      }
      throw error;
    }
  }

  /** Prepares exact WorkBody bytes in the native owner before its covering SQL acknowledgement. */
  async observation(
    database: string,
    input: ControlWorkObservationCommandInput,
    bodies?: readonly Uint8Array[]
  ): Promise<ControlWorkObservationResult> {
    const reply = await this.request({ operation: 'observation', database, input }, bodies);
    return (reply as Extract<Success, { operation: 'observation' }>).result;
  }

  /** Prepares exact admitted provenance files in the existing native FIFO and acknowledges the whole durable family. */
  async provenance(
    database: string,
    input: ControlProvenanceInput
  ): Promise<Extract<Success, { operation: 'provenance' }>['result']> {
    try {
      const reply = await this.request({ operation: 'provenance', database, input });
      return (reply as Extract<Success, { operation: 'provenance' }>).result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'provenance')
        throw new OperationError(error.domain.code, error.domain.message, error.domain.status);
      throw error;
    }
  }

  /** Commits the Pending owner and its complete local publication before returning IDs. */
  async pendingCommand(
    database: string,
    input: ControlPendingTransition
  ): Promise<ControlPendingCommandResult> {
    try {
      const reply = await this.request({ operation: 'pending', database, input });
      return (reply as Extract<Success, { operation: 'pending' }>).result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'pending') {
        if (error.domain.code === 'idempotency_key_conflict')
          throw new IdempotencyKeyConflictError();
        throw new PendingRequestCommandError(
          error.domain.code,
          error.domain.message,
          error.domain.status
        );
      }
      throw error;
    }
  }

  /** Mutates the existing Workspace journal and returns only after the outer FULL commit. */
  async journal(database: string, input: ControlExecutionJournalInput): Promise<string> {
    const reply = await this.request({ operation: 'journal', database, input });
    return (reply as Extract<Success, { operation: 'journal' }>).resultJson;
  }

  /** Opens or reuses the exact retained Workspace scope through its existing native owner. */
  async workspaceCapability(
    db: Pick<WorkspaceDb, 'dataRoot' | 'workspaceId'>,
    input: ControlCapabilityCommandInput,
    options: { readonly immediate?: boolean } = {}
  ): Promise<ControlWorkspaceCapabilityCommandResult> {
    const scope = nativeProductScope(db.dataRoot, {
      kind: 'workspace',
      workspaceId: db.workspaceId,
    });
    const database = `workspace:${scope.path}`;
    const admitted = this.openings.get(database);
    let result: ControlCapabilityCommandResult;
    if (!admitted) {
      // Reserve before awaiting the original opening ACK, as for the existing Workspace path.
      result = (
        await Promise.all([
          this.open({
            database,
            path: scope.path,
            dataRoot: db.dataRoot,
            create: false,
            initialize: 'workspace',
            productOwner: scope.owner,
            contentMount: scope.contentMount,
          }),
          this.capability(database, input, options),
        ])
      )[1];
    } else {
      if (
        admitted.command.path !== scope.path ||
        admitted.command.dataRoot !== db.dataRoot ||
        !isDeepStrictEqual(admitted.command.productOwner, scope.owner)
      )
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      result = await this.capability(database, input, options);
    }
    // The peer already validated the closed reply; only the opened owner distinction is new.
    if (
      result !== null &&
      typeof result === 'object' &&
      'context' in result &&
      (!('workspaceId' in result.context) || result.context.workspaceId !== db.workspaceId)
    )
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    return result as ControlWorkspaceCapabilityCommandResult;
  }

  /** Joins one original Discord stage before permitting its caller to continue. */
  async discordChannel(
    db: CoreDb,
    value: ControlDiscordChannelInput
  ): Promise<Exclude<ControlDiscordChannelResult, { stage: 'refused' }>> {
    const input = ControlDiscordChannelInputSchema.parse(value);
    const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
    if (db.scope !== 'core' || db.sqlite.name !== scope.path)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const database = `core:${scope.path}`;
    const admitted = this.openings.get(database);
    if (
      admitted &&
      (admitted.command.path !== scope.path ||
        admitted.command.dataRoot !== db.dataRoot ||
        !isDeepStrictEqual(admitted.command.productOwner, scope.owner))
    )
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const command = { operation: 'discord-channel' as const, database, input };
    const reply = admitted
      ? await this.request(command)
      : (
          await Promise.all([
            this.open({
              database,
              path: scope.path,
              dataRoot: db.dataRoot,
              create: false,
              initialize: 'core',
              productOwner: scope.owner,
              contentMount: scope.contentMount,
            }),
            this.request(command),
          ])
        )[1];
    if (reply.operation !== 'discord-channel')
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    const result = ControlDiscordChannelResultSchema.safeParse(reply.result);
    if (!result.success) throw new ControlStoreWorkerError('invalid-request', 'unknown');
    if (result.data.stage === 'refused')
      throw new OperationError(result.data.code, result.data.message, result.data.status);
    if (result.data.stage !== input.stage)
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    return result.data;
  }

  /** Returns the original deduplicated enqueue snapshot only after its Core FULL acknowledgement. */
  async attentionEnqueue(db: CoreDb, value: AttentionEnqueueCommand): Promise<AttentionDelivery> {
    const admittedInput = AttentionEnqueueCommandSchema.parse(value);
    const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
    if (db.scope !== 'core' || db.sqlite.name !== scope.path)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const database = `core:${scope.path}`;
    const admitted = this.openings.get(database);
    if (
      admitted &&
      (admitted.command.path !== scope.path ||
        admitted.command.dataRoot !== db.dataRoot ||
        !isDeepStrictEqual(admitted.command.productOwner, scope.owner))
    )
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    // JSON preserves every admitted JS identity for the unchanged SQLite boundary,
    // including escaped scalar values. Existing binary capacity is checked before allocation.
    const json = JSON.stringify(admittedInput);
    const command = {
      operation: 'attention-enqueue' as const,
      database,
      input: frameControlScalarText(json),
      content: new ArrayBuffer(0),
    };
    const reply = admitted
      ? await this.request(command, [json])
      : (
          await Promise.all([
            this.open({
              database,
              path: scope.path,
              dataRoot: db.dataRoot,
              create: false,
              initialize: 'core',
              productOwner: scope.owner,
              contentMount: scope.contentMount,
            }),
            this.request(command, [json]),
          ])
        )[1];
    if (reply.operation !== 'attention-enqueue')
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    const result = AttentionEnqueueResultSchema.safeParse(reply.result);
    if (!result.success) throw new ControlStoreWorkerError('invalid-request', 'unknown');
    if (result.data.status === 'refused') throw new AttentionError(result.data.code);
    return result.data.delivery;
  }

  /** Joins the complete original startup reconciliation under the native Core FULL boundary. */
  async attentionReconcileIncompleteAttempts(
    db: CoreDb,
    value: AttentionReconciliation
  ): Promise<number> {
    const input = AttentionReconciliationSchema.parse(value);
    const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
    if (db.scope !== 'core' || db.sqlite.name !== scope.path)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const database = `core:${scope.path}`;
    const admitted = this.openings.get(database);
    let reply: Success;
    if (!admitted) {
      reply = (
        await Promise.all([
          this.open({
            database,
            path: scope.path,
            dataRoot: db.dataRoot,
            create: false,
            initialize: 'core',
            productOwner: scope.owner,
            contentMount: scope.contentMount,
          }),
          this.request({ operation: 'attention-reconcile-incomplete-attempts', database, input }),
        ])
      )[1];
    } else {
      if (
        admitted.command.path !== scope.path ||
        admitted.command.dataRoot !== db.dataRoot ||
        !isDeepStrictEqual(admitted.command.productOwner, scope.owner)
      )
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      reply = await this.request({
        operation: 'attention-reconcile-incomplete-attempts',
        database,
        input,
      });
    }
    if (reply.operation !== 'attention-reconcile-incomplete-attempts')
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    const result = AttentionReconciliationResultSchema.safeParse(reply.result);
    if (!result.success) throw new ControlStoreWorkerError('invalid-request', 'unknown');
    if (result.data.status === 'refused') throw new AttentionError(result.data.code);
    return result.data.changes;
  }

  /** Returns only the original transaction's durable claim snapshot, never a later re-read. */
  async attentionAttemptClaim(
    db: CoreDb,
    value: ControlAttentionAttemptClaim
  ): Promise<AttentionDelivery> {
    const input = ControlAttentionAttemptClaimSchema.parse(value);
    const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
    if (db.scope !== 'core' || db.sqlite.name !== scope.path)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const database = `core:${scope.path}`;
    const admitted = this.openings.get(database);
    let reply: Success;
    if (!admitted) {
      reply = (
        await Promise.all([
          this.open({
            database,
            path: scope.path,
            dataRoot: db.dataRoot,
            create: false,
            initialize: 'core',
            productOwner: scope.owner,
            contentMount: scope.contentMount,
          }),
          this.request({ operation: 'attention-attempt-claim', database, input }),
        ])
      )[1];
    } else {
      if (
        admitted.command.path !== scope.path ||
        admitted.command.dataRoot !== db.dataRoot ||
        !isDeepStrictEqual(admitted.command.productOwner, scope.owner)
      )
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      reply = await this.request({ operation: 'attention-attempt-claim', database, input });
    }
    if (reply.operation !== 'attention-attempt-claim')
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    const result = ControlAttentionAttemptClaimResultSchema.safeParse(reply.result);
    if (!result.success) throw new ControlStoreWorkerError('invalid-request', 'unknown');
    if (result.data.status === 'refused') throw new AttentionError(result.data.code);
    const delivery = result.data.delivery;
    if (
      delivery.id !== input.deliveryId ||
      delivery.recipientUserId !== input.recipientUserId ||
      delivery.channel !== input.channel ||
      delivery.attempt.startedAt !== input.startedAt
    )
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    return delivery;
  }

  /** Commits only the original attempt completion; Main's following projection stays separate. */
  async attentionAttemptCompletion(
    db: CoreDb,
    value: ControlAttentionAttemptCompletion
  ): Promise<ControlAttentionAttemptCompletionResult> {
    const input = ControlAttentionAttemptCompletionSchema.parse(value);
    const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
    if (db.scope !== 'core' || db.sqlite.name !== scope.path)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const database = `core:${scope.path}`;
    const admitted = this.openings.get(database);
    let reply: Success;
    if (!admitted) {
      reply = (
        await Promise.all([
          this.open({
            database,
            path: scope.path,
            dataRoot: db.dataRoot,
            create: false,
            initialize: 'core',
            productOwner: scope.owner,
            contentMount: scope.contentMount,
          }),
          this.request({ operation: 'attention-attempt-completion', database, input }),
        ])
      )[1];
    } else {
      if (
        admitted.command.path !== scope.path ||
        admitted.command.dataRoot !== db.dataRoot ||
        !isDeepStrictEqual(admitted.command.productOwner, scope.owner)
      )
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      reply = await this.request({ operation: 'attention-attempt-completion', database, input });
    }
    if (reply.operation !== 'attention-attempt-completion')
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    const result = ControlAttentionAttemptCompletionResultSchema.safeParse(reply.result);
    if (!result.success) throw new ControlStoreWorkerError('invalid-request', 'unknown');
    return result.data;
  }

  /** Initializes or reuses the canonical local User under captured fresh authority and FULL commit. */
  async localIdentity(db: CoreDb, input: ControlLocalIdentity): Promise<string> {
    const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
    if (db.scope !== 'core' || db.sqlite.name !== scope.path)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const database = `core:${scope.path}`;
    const admitted = this.openings.get(database);
    let reply: Success;
    if (!admitted) {
      reply = (
        await Promise.all([
          this.open({
            database,
            path: scope.path,
            dataRoot: db.dataRoot,
            create: false,
            initialize: 'core',
            productOwner: scope.owner,
            contentMount: scope.contentMount,
          }),
          this.request({ operation: 'local-identity', database, input }),
        ])
      )[1];
    } else {
      if (
        admitted.command.path !== scope.path ||
        admitted.command.dataRoot !== db.dataRoot ||
        !isDeepStrictEqual(admitted.command.productOwner, scope.owner)
      )
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      reply = await this.request({ operation: 'local-identity', database, input });
    }
    if (reply.operation !== 'local-identity')
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    const result = ControlLocalIdentityResultSchema.safeParse(reply.result);
    if (!result.success) throw new ControlStoreWorkerError('invalid-request', 'unknown');
    return result.data;
  }

  /** Consumes exactly the original first-owner tuple through the admitted Core FULL writer. */
  async bootstrapConsume(
    db: CoreDb,
    input: ControlBootstrapConsume
  ): Promise<ControlBootstrapConsumeResult> {
    const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
    if (db.scope !== 'core' || db.sqlite.name !== scope.path)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const database = `core:${scope.path}`;
    const admitted = this.openings.get(database);
    let reply: Success;
    if (!admitted) {
      reply = (
        await Promise.all([
          this.open({
            database,
            path: scope.path,
            dataRoot: db.dataRoot,
            create: false,
            initialize: 'core',
            productOwner: scope.owner,
            contentMount: scope.contentMount,
          }),
          this.request({ operation: 'bootstrap-consume', database, input }),
        ])
      )[1];
    } else {
      if (
        admitted.command.path !== scope.path ||
        admitted.command.dataRoot !== db.dataRoot ||
        !isDeepStrictEqual(admitted.command.productOwner, scope.owner)
      )
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      reply = await this.request({ operation: 'bootstrap-consume', database, input });
    }
    if (reply.operation !== 'bootstrap-consume')
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    const result = ControlBootstrapConsumeResultSchema.safeParse(reply.result);
    if (!result.success) throw new ControlStoreWorkerError('invalid-request', 'unknown');
    return result.data;
  }

  /** Ensures only the original startup Bootstrap setting through the admitted Core FULL writer. */
  async bootstrapEnsure(
    db: CoreDb,
    input: ControlBootstrapEnsure
  ): Promise<ControlBootstrapEnsureResult> {
    const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
    if (db.scope !== 'core' || db.sqlite.name !== scope.path)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const database = `core:${scope.path}`;
    const admitted = this.openings.get(database);
    let reply: Success;
    if (!admitted) {
      reply = (
        await Promise.all([
          this.open({
            database,
            path: scope.path,
            dataRoot: db.dataRoot,
            create: false,
            initialize: 'core',
            productOwner: scope.owner,
            contentMount: scope.contentMount,
          }),
          this.request({ operation: 'bootstrap-ensure', database, input }),
        ])
      )[1];
    } else {
      if (
        admitted.command.path !== scope.path ||
        admitted.command.dataRoot !== db.dataRoot ||
        !isDeepStrictEqual(admitted.command.productOwner, scope.owner)
      )
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      reply = await this.request({ operation: 'bootstrap-ensure', database, input });
    }
    if (reply.operation !== 'bootstrap-ensure')
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    const result = ControlBootstrapEnsureResultSchema.safeParse(reply.result);
    if (!result.success) throw new ControlStoreWorkerError('invalid-request', 'unknown');
    return result.data;
  }

  /** Performs canonical issue/revoke/rotation through the existing admitted Core FULL writer. */
  async accessTokenLifecycle(
    db: CoreDb,
    input: ControlAccessTokenLifecycle
  ): Promise<ControlAccessTokenLifecycleResult> {
    const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
    if (db.scope !== 'core' || db.sqlite.name !== scope.path)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const database = `core:${scope.path}`;
    const admitted = this.openings.get(database);
    let reply: Success;
    if (!admitted) {
      reply = (
        await Promise.all([
          this.open({
            database,
            path: scope.path,
            dataRoot: db.dataRoot,
            create: false,
            initialize: 'core',
            productOwner: scope.owner,
            contentMount: scope.contentMount,
          }),
          this.request({ operation: 'access-token-lifecycle', database, input }),
        ])
      )[1];
    } else {
      if (
        admitted.command.path !== scope.path ||
        admitted.command.dataRoot !== db.dataRoot ||
        !isDeepStrictEqual(admitted.command.productOwner, scope.owner)
      )
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      reply = await this.request({ operation: 'access-token-lifecycle', database, input });
    }
    if (reply.operation !== 'access-token-lifecycle')
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    const result = ControlAccessTokenLifecycleResultSchema.safeParse(reply.result);
    if (!result.success || (result.data.kind !== input.kind && result.data.kind !== 'denied'))
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    const value = result.data;
    if (
      (value.kind === 'issue' &&
        input.kind === 'issue' &&
        value.record.tokenId !== input.token.tokenId) ||
      (value.kind === 'revoke' &&
        input.kind === 'revoke' &&
        value.record &&
        value.record.tokenId !== input.tokenId) ||
      (value.kind === 'rotate' &&
        input.kind === 'rotate' &&
        value.value &&
        (value.value.tokenId !== input.successor.tokenId ||
          value.value.record.tokenId !== input.successor.tokenId ||
          value.value.rotatedRecord.tokenId !== input.tokenId))
    )
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    return value;
  }

  /** Sets only this admitted owner's personal default through the existing Core FULL writer. */
  async serverAdminTokenDefault(
    db: CoreDb,
    input: ControlServerAdminTokenDefault
  ): Promise<boolean> {
    const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
    if (db.scope !== 'core' || db.sqlite.name !== scope.path)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const database = `core:${scope.path}`;
    const admitted = this.openings.get(database);
    let reply: Success;
    if (!admitted) {
      reply = (
        await Promise.all([
          this.open({
            database,
            path: scope.path,
            dataRoot: db.dataRoot,
            create: false,
            initialize: 'core',
            productOwner: scope.owner,
            contentMount: scope.contentMount,
          }),
          this.request({ operation: 'server-admin-token-default', database, input }),
        ])
      )[1];
    } else {
      if (
        admitted.command.path !== scope.path ||
        admitted.command.dataRoot !== db.dataRoot ||
        !isDeepStrictEqual(admitted.command.productOwner, scope.owner)
      )
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      reply = await this.request({ operation: 'server-admin-token-default', database, input });
    }
    if (reply.operation !== 'server-admin-token-default' || typeof reply.result !== 'boolean')
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    return reply.result;
  }

  /** Reuses the exact physical owner for a closed originally standalone Core or Workspace Audit. */
  async standaloneAudit(
    db: CoreDb | WorkspaceDb,
    input: ControlStandaloneAuditInput
  ): Promise<void> {
    const scope = nativeProductScope(
      db.dataRoot,
      db.scope === 'core' ? { kind: 'server' } : { kind: 'workspace', workspaceId: db.workspaceId }
    );
    if (
      (db.scope === 'core'
        ? input.workspaceId !== undefined
        : input.workspaceId !== db.workspaceId) ||
      db.sqlite.name !== scope.path
    )
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const parsed = ControlStandaloneAuditInputSchema.safeParse(input);
    if (!parsed.success) throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    // The original shared-disable resource can exceed the structured envelope.
    // Validate its closed stage first, then use the existing bounded scalar carrier.
    const json = JSON.stringify(parsed.data);
    const database = `${db.scope}:${scope.path}`;
    const command = {
      operation: 'standalone-audit' as const,
      database,
      input: frameControlScalarText(json),
      content: new ArrayBuffer(0),
    };
    const admitted = this.openings.get(database);
    let reply: Success;
    if (!admitted) {
      reply = (
        await Promise.all([
          this.open({
            database,
            path: scope.path,
            dataRoot: db.dataRoot,
            create: false,
            initialize: db.scope,
            productOwner: scope.owner,
            contentMount: scope.contentMount,
          }),
          this.request(command, [json]),
        ])
      )[1];
    } else {
      if (
        admitted.command.path !== scope.path ||
        admitted.command.dataRoot !== db.dataRoot ||
        !isDeepStrictEqual(admitted.command.productOwner, scope.owner)
      )
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      reply = await this.request(command, [json]);
    }
    if (reply.operation !== 'standalone-audit' || reply.result !== null)
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
  }

  /**
   * Persists the original redacted setup tuple through its physical Workspace owner.
   * @param workspaceDb Actual caller-owned Workspace connection and root identity.
   * @param input Existing resolved setup and retained attribution.
   * @returns The dependent validated record after the covering FULL acknowledgement.
   */
  async recordResolvedAgentSetup(
    workspaceDb: WorkspaceDb,
    input: RecordResolvedAgentSetupInput
  ): Promise<ResolvedAgentSetupRecord> {
    // Retain the original early refusal order; the native guard repeats this decisively.
    guardExistingResolvedAgentSetup(workspaceDb, input.recordId);
    const setup = StoredResolvedAgentSetupV1Schema.parse(redactResolvedAgentSetup(input.setup));
    const scope = nativeProductScope(workspaceDb.dataRoot, {
      kind: 'workspace',
      workspaceId: workspaceDb.workspaceId,
    });
    const database = `workspace:${scope.path}`;
    return this.runOperation(async () => {
      await this.open({
        database,
        path: scope.path,
        dataRoot: workspaceDb.dataRoot,
        create: false,
        initialize: 'workspace',
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      });
      try {
        return await this.resolvedAgentSetup(database, workspaceDb.workspaceId, {
          recordId: input.recordId,
          workspaceId: input.workspaceId,
          turnId: input.turnId ?? null,
          requestId: input.requestId ?? null,
          setup,
          createdAt: input.createdAt,
        });
      } catch (error) {
        if (
          error instanceof ControlStoreWorkerError &&
          error.commit === 'not-committed' &&
          error.domain?.operation === 'resolved-agent-setup' &&
          error.domain.code === 'unsupported_retained_format'
        )
          throw new TypeError('Unsupported retained record format.', { cause: error });
        throw error;
      }
    });
  }

  /** Prepares the complete redacted row outside the wire and keeps its existing physical forecasts through ACK or cleanup. */
  private async resolvedAgentSetup(
    database: string,
    scopeWorkspaceId: string,
    record: ControlResolvedAgentSetupRecord
  ): Promise<ControlResolvedAgentSetupResult> {
    this.assertAccepting();
    const opening = this.openings.get(database);
    if (
      !opening?.command.dataRoot ||
      opening.command.productOwner?.kind !== 'workspace' ||
      opening.command.productOwner.workspaceId !== scopeWorkspaceId
    )
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    this.assertFrozenCall({ operation: 'close', database }, undefined, opening);
    const text = JSON.stringify(record);
    const byteLength = Buffer.byteLength(text);
    if (byteLength > STORAGE_LIMITS.contentBytes)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const staging = join(dirname(dirname(opening.path)), 'runtime', 'staging');
    ensureCanonicalDirectory(staging);
    const root = resolve(opening.command.dataRoot);
    let admission = this.fileAdmissions.get(root);
    if (!admission) {
      admission = new FileStorageAdmission(root, () => 1_000_000_000n);
      this.fileAdmissions.set(root, admission);
    }
    const stagedCapacity = admission.forPath(staging).reserve({
      stagingBytes: BigInt(byteLength),
      extractionBytes: 0n,
      derivativeBytes: 0n,
      publicationBytes: 0n,
    });
    let rowCapacity: FileStorageReservation | undefined;
    let privateRoot: string | undefined;
    let posted = false;
    let failed = false;
    let failure: unknown;
    let result: ControlResolvedAgentSetupResult | undefined;
    try {
      // Existing per-database WAL forecast remains shared. This is this row's actual additional worst-case growth, not another max-WAL credit.
      rowCapacity = admission.forPath(opening.path).reserve({
        stagingBytes: 0n,
        extractionBytes: 0n,
        derivativeBytes: 0n,
        publicationBytes: BigInt(byteLength) * 4n,
      });
      privateRoot = createPrivateTreeSync(staging, 'resolved-setup-');
      const path = join(privateRoot, 'setup.json');
      stagedCapacity.assertAvailable();
      await writePrivateTextFileExclusive(path, text);
      stagedCapacity.recordWritten(byteLength);
      const metadata = lstatSync(path, { bigint: true });
      const input: ControlResolvedAgentSetupInput = {
        scopeWorkspaceId,
        file: {
          name: `${basename(privateRoot)}/setup.json`,
          byteLength,
          digest: `sha256:${sha256Hex(text)}`,
          identity: `${metadata.dev}:${metadata.ino}`,
        },
      };
      const pending = this.request(
        { operation: 'resolved-agent-setup', database, input },
        undefined,
        undefined,
        undefined,
        undefined,
        [rowCapacity]
      );
      // If admission fails before the request takes capacity, release it here; failed/unknown hosts retain accepted capacity until actual exit.
      posted = opening.host.capacity.has(rowCapacity);
      const reply = await pending;
      if (reply.operation !== 'resolved-agent-setup')
        throw new ControlStoreWorkerError('invalid-request', 'unknown');
      result = reply.result;
    } catch (error) {
      failed = true;
      failure = error;
    }
    if (rowCapacity && !posted) rowCapacity.release();
    try {
      if (privateRoot) removePrivateTreeSync(privateRoot);
      stagedCapacity.release();
    } catch (cleanupError) {
      // Preserve native commit/domain evidence. A failed removal keeps its forecast and cannot authorize launch.
      if (failed && failure instanceof Error) {
        failure.cause =
          failure.cause === undefined
            ? cleanupError
            : new AggregateError([failure.cause, cleanupError], 'Resolved setup cleanup failed.');
      } else if (failed) {
        failure = new AggregateError(
          [failure, cleanupError],
          'Resolved setup failed and cleanup is unproved.'
        );
      } else {
        failed = true;
        const error = new ControlStoreWorkerError('unavailable', 'unknown');
        error.cause = cleanupError;
        failure = error;
      }
    }
    if (failed) throw failure;
    if (!result) throw new ControlStoreWorkerError('invalid-request', 'unknown');
    return result;
  }

  /**
   * Native ownership precedes cold reads; acknowledged current reads need no healthy writer.
   * Existing-only callers return synchronously for a missing scope and never create it.
   */
  openInitializedUserReadDb(dataRoot: string, userId: string): Promise<UserDb>;
  openInitializedUserReadDb(
    dataRoot: string,
    userId: string,
    options: { readonly existingOnly: true }
  ): Promise<UserDb> | undefined;
  openInitializedUserReadDb(
    dataRoot: string,
    userId: string,
    options: { readonly existingOnly?: true } = {}
  ): Promise<UserDb> | undefined {
    try {
      if (options.existingOnly) assertScopeAdmitted(dataRoot, 'user', userId);
      else ensureUserLayout(dataRoot, userId);
      const path = userDbPath(dataRoot, userId);
      const database = `user:${path}`;
      const opening = this.openings.get(database);
      // Select a missing scope without yielding, so its original no-file read cannot
      // race the first native initialization. A pending original OPEN still owns readiness.
      const existing = opening || statSync(path, { throwIfNoEntry: false });
      if (options.existingOnly && !existing) return undefined;
      return (async () => {
        const releaseAcquisition = reserveMainScopeReadAcquisition(path);
        try {
          if (opening?.retirement) throw new ControlStoreWorkerError('busy', 'not-committed');
          if (opening) {
            if (
              !isDeepStrictEqual(opening.command, {
                database,
                path,
                create: opening.command.create,
                initialize: 'user',
              })
            )
              throw new ControlStoreWorkerError('invalid-request', 'not-committed');
            // Never infer first-create readiness from the file or repair an unknown original opening.
            if (!opening.acknowledged) await opening.promise;
            try {
              const current = statSync(path);
              if (
                realpathSync(path) !== opening.path ||
                `${current.dev}:${current.ino}` !== opening.identity
              )
                throw new Error('User database binding changed.');
            } catch {
              throw new ControlStoreWorkerError('precondition', 'not-committed');
            }
          }
          if (opening && statSync(path, { throwIfNoEntry: false })) {
            const reader = openUserReadDb(dataRoot, userId);
            try {
              if (!hasPendingUserMigrations(reader.sqlite)) return reader;
            } catch (error) {
              reader.sqlite.close();
              throw error;
            }
            reader.sqlite.close();
            throw new ControlStoreWorkerError('precondition', 'not-committed');
          }
          // Cold readonly WAL connections create sidecars without owning their final cleanup.
          // Admit the existing native owner first, including when the file is already current.
          try {
            await this.open({
              database,
              path,
              create: !options.existingOnly && !existing,
              initialize: 'user',
            });
          } catch (error) {
            // Cold ownership must preserve the User read API's unsupported-history refusal.
            if (
              error instanceof ControlStoreWorkerError &&
              error.code === 'migration_unsupported_user'
            ) {
              const refusal = new BootConfigError(
                error.code,
                'Unsupported user native Drizzle ledger identity.'
              );
              refusal.cause = error;
              throw refusal;
            }
            throw error;
          }
          const reader = openUserReadDb(dataRoot, userId);
          try {
            if (hasPendingUserMigrations(reader.sqlite))
              throw new ControlStoreWorkerError('precondition', 'not-committed');
            return reader;
          } catch (error) {
            reader.sqlite.close();
            throw error;
          }
        } finally {
          releaseAcquisition();
        }
      })();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Retains each closed public command's original receipt and separate maintenance FULL stages. */
  async recordWorkspaceCommandReceipt(
    dataRoot: string,
    receipt: WorkspaceCommandReceipt
  ): Promise<void> {
    const input = ControlWorkspaceCommandReceiptInputSchema.parse(
      receipt.command === 'workspace.create'
        ? { action: 'create-receipt', userId: receipt.scope.userId, receipt }
        : 'coreId' in receipt.scope
          ? { action: 'server-mcp-receipt', coreId: 'server', receipt }
          : {
              action:
                receipt.command === 'administration.configuration.apply'
                  ? 'configuration-receipt'
                  : receipt.command === 'workspace_sync.review.decide'
                    ? 'sync-review-receipt'
                    : receipt.command === 'catalog.shared-mcp-set-disabled'
                      ? 'shared-mcp-receipt'
                      : receipt.command === 'workspace.update'
                        ? 'update-receipt'
                        : receipt.command.startsWith('catalog.light-app-')
                          ? 'light-app-receipt'
                          : receipt.command.startsWith('catalog.skill-')
                            ? 'skill-receipt'
                            : receipt.command.startsWith('artifact.')
                              ? 'artifact-receipt'
                              : 'environment-receipt',
              workspaceId: receipt.scope.workspaceId,
              receipt,
            }
    );
    let database: string;
    if (input.action === 'create-receipt') {
      // First use originally created the User database here, after Workspace and membership effects.
      ensureUserLayout(dataRoot, input.userId);
      const path = userDbPath(dataRoot, input.userId);
      database = `user:${path}`;
      const create =
        this.openings.get(database)?.command.create ?? !statSync(path, { throwIfNoEntry: false });
      await this.open({ database, path, create, initialize: 'user' });
    } else if (input.action === 'server-mcp-receipt') {
      const scope = nativeProductScope(dataRoot, { kind: 'server' });
      database = `core:${scope.path}`;
      await this.open({
        database,
        path: scope.path,
        dataRoot,
        create: false,
        initialize: 'core',
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      });
    } else if (
      input.action === 'configuration-receipt' ||
      input.action === 'sync-review-receipt' ||
      input.action === 'shared-mcp-receipt' ||
      input.action === 'update-receipt' ||
      input.action === 'environment-receipt' ||
      input.action === 'skill-receipt' ||
      input.action === 'artifact-receipt' ||
      input.action === 'light-app-receipt'
    ) {
      const scope = nativeProductScope(dataRoot, {
        kind: 'workspace',
        workspaceId: input.workspaceId,
      });
      database = `workspace:${scope.path}`;
      await this.open({
        database,
        path: scope.path,
        dataRoot,
        create: false,
        initialize: 'workspace',
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      });
    } else throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    // Opaque Artifact identities can exceed the structured envelope after JSON escaping.
    // Reuse the admitted scalar carrier; the native owner decodes the same closed input.
    const recordJson = JSON.stringify(input);
    const record = await this.request(
      {
        operation: 'workspace-command-receipt',
        database,
        input: frameControlScalarText(recordJson),
        content: new ArrayBuffer(0),
      },
      [recordJson]
    );
    if (record.operation !== 'workspace-command-receipt' || record.result !== null)
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    const referenceTime = new Date().toISOString();
    const maintenanceInput = ControlWorkspaceCommandReceiptInputSchema.parse(
      input.action === 'create-receipt'
        ? { action: 'create-maintenance', userId: input.userId, referenceTime }
        : input.action === 'server-mcp-receipt'
          ? { action: 'server-mcp-maintenance', coreId: 'server', referenceTime }
          : {
              action:
                input.action === 'configuration-receipt'
                  ? 'configuration-maintenance'
                  : input.action === 'sync-review-receipt'
                    ? 'sync-review-maintenance'
                    : input.action === 'shared-mcp-receipt'
                      ? 'shared-mcp-maintenance'
                      : input.action === 'update-receipt'
                        ? 'update-maintenance'
                        : input.action === 'light-app-receipt'
                          ? 'light-app-maintenance'
                          : input.action === 'skill-receipt'
                            ? 'skill-maintenance'
                            : input.action === 'artifact-receipt'
                              ? 'artifact-maintenance'
                              : 'environment-maintenance',
              workspaceId: input.workspaceId,
              referenceTime,
            }
    );
    const maintenanceJson = JSON.stringify(maintenanceInput);
    const maintenance = await this.request(
      {
        operation: 'workspace-command-receipt',
        database,
        input: frameControlScalarText(maintenanceJson),
        content: new ArrayBuffer(0),
      },
      [maintenanceJson]
    );
    if (maintenance.operation !== 'workspace-command-receipt' || maintenance.result !== null)
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
  }

  /** Preserves the three Candidate commands' separate record and later expiry-maintenance FULL acknowledgements. */
  async recordCatalogCommandReceipt(
    db: WorkspaceDb,
    receipt: Extract<ControlCatalogCommandReceiptInput, { stage: 'record' }>['receipt']
  ): Promise<void> {
    const scope = nativeProductScope(db.dataRoot, {
      kind: 'workspace',
      workspaceId: db.workspaceId,
    });
    if (receipt.scope.workspaceId !== db.workspaceId || db.sqlite.name !== scope.path)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const database = `workspace:${scope.path}`;
    await this.open({
      database,
      path: scope.path,
      dataRoot: db.dataRoot,
      create: false,
      initialize: 'workspace',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    const record = await this.request({
      operation: 'catalog-command-receipt',
      database,
      input: { stage: 'record', workspaceId: db.workspaceId, receipt },
    });
    if (record.operation !== 'catalog-command-receipt' || record.result !== null)
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    // Sample the original maintenance clock only after the record is durably acknowledged.
    const maintenance = await this.request({
      operation: 'catalog-command-receipt',
      database,
      input: {
        stage: 'maintenance',
        workspaceId: db.workspaceId,
        referenceTime: new Date().toISOString(),
      },
    });
    if (maintenance.operation !== 'catalog-command-receipt' || maintenance.result !== null)
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
  }

  /** Posts one closed Notebook stage to its already opened physical owner; no callback crosses the wire. */
  async scopedNotebookSql(database: string, input: ControlScopedNotebookSqlInput): Promise<void> {
    try {
      const reply = await this.request({ operation: 'scoped-notebook-sql', database, input });
      if (reply.operation !== 'scoped-notebook-sql' || reply.result !== null)
        throw new ControlStoreWorkerError('invalid-request', 'unknown');
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'scoped-notebook-sql'
      )
        throw new IdempotencyKeyConflictError();
      throw error;
    }
  }

  /** Reuses the canonical User physical owner and covering FULL acknowledgement. */
  async userCapability(
    db: UserDb,
    input: Extract<
      ControlCapabilityCommandInput,
      { kind: 'user-permission' | 'user-participant-audit' | 'user-audit' }
    >
  ): Promise<null> {
    const path = nativeUserDatabasePath(db);
    if (input.userId !== db.userId)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const database = `user:${path}`;
    await this.open({ database, path, create: false, initialize: 'user' });
    const result = await this.capability(database, input);
    if (result !== null) throw new ControlStoreWorkerError('invalid-request', 'unknown');
    return null;
  }

  /** Joins the exact lifecycle tuple to the existing Core writer after migrations, before close. */
  async coreBootAudit(db: CoreDb, input: ControlBootAuditInput): Promise<void> {
    const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
    const database = `core:${scope.path}`;
    const admitted = this.openings.get(database);
    if (!admitted) {
      await Promise.all([
        this.open({
          database,
          path: scope.path,
          dataRoot: db.dataRoot,
          create: false,
          initialize: 'core',
          productOwner: scope.owner,
          contentMount: scope.contentMount,
        }),
        this.request({ operation: 'boot-audit', database, input }),
      ]);
      return;
    }
    if (
      admitted.command.path !== scope.path ||
      admitted.command.dataRoot !== db.dataRoot ||
      !isDeepStrictEqual(admitted.command.productOwner, scope.owner)
    )
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    await this.request({ operation: 'boot-audit', database, input });
  }

  /** Uses the existing Core physical owner for the closed Server ledger cases. */
  async coreCapability(
    db: CoreDb,
    input: ControlCapabilityCommandInput
  ): Promise<ControlCapabilityCommandResult> {
    const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
    const database = `core:${scope.path}`;
    const admitted = this.openings.get(database);
    if (!admitted)
      return (
        await Promise.all([
          this.open({
            database,
            path: scope.path,
            dataRoot: db.dataRoot,
            create: false,
            initialize: 'core',
            productOwner: scope.owner,
            contentMount: scope.contentMount,
          }),
          this.capability(database, input),
        ])
      )[1];
    if (
      admitted.command.path !== scope.path ||
      admitted.command.dataRoot !== db.dataRoot ||
      !isDeepStrictEqual(admitted.command.productOwner, scope.owner)
    )
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    return this.capability(database, input);
  }

  /** Submits prepared family facts through the bounded writer and awaits durable acknowledgement. */
  async capability(
    database: string,
    input: ControlCapabilityCommandInput,
    options: { readonly immediate?: boolean } = {}
  ): Promise<ControlCapabilityCommandResult> {
    try {
      const text = controlCapabilityText(input);
      if (
        text !== undefined &&
        (Buffer.byteLength(text) > CONTROL_WORKER_LIMITS.materialPendingBytes ||
          (!this.closeoutCredit(database, input) &&
            Buffer.byteLength(text) >
              CONTROL_WORKER_LIMITS.materialPendingBytes -
                (this.backing.get(database)?.materialBytes ?? 0)))
      )
        throw new ControlStoreWorkerError('busy', 'not-committed');
      const transfer = prepareControlCapabilityTransfer(input);
      const reply = await this.request(
        {
          operation: 'capability',
          database,
          input: transfer.input,
          immediate: options.immediate ?? false,
        },
        transfer.parts
      );
      return (reply as Extract<Success, { operation: 'capability' }>).result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'capability') {
        if (error.domain.kind === 'ledger') throw new Error(error.domain.message);
        if (error.domain.kind === 'pending')
          throw new PendingRequestCommandError(
            error.domain.code,
            error.domain.message,
            error.domain.status
          );
        if (error.domain.kind)
          throw restoreControlCapabilityFailure({
            kind: error.domain.kind,
            code: error.domain.code,
            message: error.domain.message,
            status: error.domain.status,
          });
        if (error.domain.code === 'unsupported_retained_format')
          throw new TypeError('Unsupported retained record format.');
        if (error.domain.code === 'idempotency_key_conflict')
          throw new IdempotencyKeyConflictError();
        throw new GoalCommandError(error.domain.code, error.domain.message, error.domain.status);
      }
      throw error;
    }
  }

  /** Only the exact call's schema preparation or serial closeout borrows its original credit. */
  private closeoutCredit(
    database: string,
    input: ControlCapabilityCommandInput | ControlCapabilityWireInput
  ): CapabilityCloseoutCredit | undefined {
    if (
      input.kind !== 'finish' &&
      input.kind !== 'mcp-schema' &&
      !(input.kind === 'usage-finish' && input.finish)
    )
      return undefined;
    const context = this.operationContext.getStore();
    const credit = context?.closeout;
    const callId = input.kind === 'usage-finish' ? input.call.id : input.callId;
    return context?.active &&
      credit?.active &&
      !credit.borrowing &&
      credit.database === database &&
      credit.callId === callId
      ? credit
      : undefined;
  }

  /** Executes the complete native Goal body; trusted domain refusals keep their public meaning, while SQL failures remain redacted. */
  async goal(database: string, input: ControlGoalInput): Promise<ControlGoalCommandResult> {
    try {
      const reply = await this.request({ operation: 'goal', database, input });
      return (reply as Extract<Success, { operation: 'goal' }>).result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'goal') {
        if (error.domain.code === 'unsupported_retained_format')
          throw new TypeError('Unsupported retained record format.');
        if (error.domain.code === 'idempotency_key_conflict')
          throw new IdempotencyKeyConflictError();
        throw new GoalCommandError(error.domain.code, error.domain.message, error.domain.status);
      }
      throw error;
    }
  }

  /** Opens the original Workspace writer and submits one complete schema application for FULL acknowledgement. */
  async applyWorkspaceSchema(input: {
    readonly workspaceDb: WorkspaceDb;
    readonly request: ControlSchemaApplicationInput['request'];
    readonly requestActor: ControlSchemaApplicationInput['requestActor'];
    readonly producer: ControlSchemaApplicationInput['producer'];
    readonly receipt: IdempotentCommandReceipt;
    readonly candidateHead: ControlSchemaApplicationInput['candidateHead'];
    readonly captureFacts: () => ControlSchemaApplicationFacts;
  }): Promise<ApplyKnowledgeSchemaResponse> {
    const { workspaceDb: db } = input;
    const scope = nativeProductScope(db.dataRoot, {
      kind: 'workspace',
      workspaceId: db.workspaceId,
    });
    if (
      db.scope !== 'workspace' ||
      !db.sqlite.open ||
      db.sqlite.inTransaction ||
      resolve(db.sqlite.name) !== resolve(scope.path) ||
      input.request.workspaceId !== db.workspaceId ||
      input.candidateHead.workspaceId !== db.workspaceId
    )
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    const database = `workspace:${scope.path}`;
    await this.open({
      database,
      path: scope.path,
      dataRoot: db.dataRoot,
      create: false,
      initialize: 'workspace',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    // Only a proved, uncommitted administrative readset conflict permits one recomputation.
    // The original reviewed input, candidate, timestamp and receipt remain exact on both attempts.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!db.sqlite.open || db.sqlite.inTransaction)
        throw new ControlStoreWorkerError('precondition', 'not-committed');
      // Capture after opening. Posting recaptures synchronously with no await before postMessage.
      // A hold may retain this exact bounded frame, but changed facts refuse before posting.
      let captured: ControlSchemaApplicationFacts;
      try {
        captured = ControlSchemaApplicationFactsSchema.parse(input.captureFacts());
      } catch {
        throw new ControlStoreWorkerError('precondition', 'not-committed');
      }
      const owned = ControlSchemaApplicationInputSchema.parse({
        request: input.request,
        requestActor: input.requestActor,
        producer: input.producer,
        receipt: input.receipt,
        candidateHead: input.candidateHead,
        facts: captured,
      });
      const json = JSON.stringify(owned);
      try {
        const reply = await this.request(
          {
            operation: 'schema-application',
            database,
            input: { workspaceId: db.workspaceId, ...frameControlScalarText(json) },
            content: new ArrayBuffer(0),
          },
          [json],
          undefined,
          false,
          undefined,
          [],
          { captured, capture: input.captureFacts }
        );
        return (reply as Extract<Success, { operation: 'schema-application' }>).result;
      } catch (error) {
        if (
          error instanceof ControlStoreWorkerError &&
          error.domain?.operation === 'schema-application'
        ) {
          const refusal = ControlSchemaApplicationRefusalSchema.parse(error.domain);
          if (refusal.code === 'schema_readset_changed' && error.commit === 'not-committed')
            continue;
          if (refusal.code === 'idempotency_key_conflict') throw new IdempotencyKeyConflictError();
          throw new OperationError(refusal.code, refusal.message, refusal.status, {
            ...(refusal.details ? { details: refusal.details } : {}),
          });
        }
        throw error;
      }
    }
    throw new ControlStoreWorkerError('busy', 'not-committed');
  }

  /** Admits one scoped Knowledge unit; model work starts only after its native acknowledgement. */
  async maintenance(
    database: string,
    input: ControlMaintenanceAdmissionInput
  ): Promise<ControlMaintenanceAdmissionResult> {
    try {
      const reply = await this.request({ operation: 'maintenance', database, input });
      return (reply as Extract<Success, { operation: 'maintenance' }>).result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'maintenance') {
        if (error.domain.code === 'idempotency_key_conflict')
          throw new IdempotencyKeyConflictError();
        if (error.domain.code === 'invalid_request' || error.domain.code === 'recovery_required')
          throw new NotebookError(error.domain.code);
      }
      throw error;
    }
  }

  /** Executes one complete Material-family body; only its outer FULL commit acknowledges the result. */
  async material(
    database: string,
    input: ControlMaterialCommandInput
  ): Promise<ControlMaterialCommandResult> {
    try {
      const transfer = prepareControlMaterialTransfer(input);
      const reply = await this.request(
        { operation: 'material', database, input: transfer.input },
        transfer.parts
      );
      return (reply as Extract<Success, { operation: 'material' }>).result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'material') {
        if (error.domain.code === 'idempotency_key_conflict')
          throw new IdempotencyKeyConflictError();
        throw new OperationError(error.domain.code, error.domain.message, error.domain.status);
      }
      throw error;
    }
  }

  /** Commits both terminal streams and the attempt close inside one existing native savepoint. */
  async workerControlFinalStatus(database: string, command: ControlWorkerFinalStatusCommand) {
    const { payload, ...metadata } = command;
    const json = JSON.stringify(payload);
    const reply = await this.request(
      {
        operation: 'worker-control-final-status',
        database,
        input: { ...metadata, byteLength: Buffer.byteLength(json) },
      },
      [json]
    );
    return (reply as Extract<Success, { operation: 'worker-control-final-status' }>).result;
  }

  /** Commits heartbeat fingerprint and attempt liveness inside one existing native savepoint. */
  async workerControlHeartbeat(database: string, command: ControlWorkerHeartbeatCommand) {
    const { payload, ...metadata } = command;
    const json = JSON.stringify(payload);
    const reply = await this.request(
      {
        operation: 'worker-control-heartbeat',
        database,
        input: { ...metadata, byteLength: Buffer.byteLength(json) },
      },
      [json]
    );
    return (reply as Extract<Success, { operation: 'worker-control-heartbeat' }>).result;
  }

  /** Commits one original nonterminal control stage inside one existing native savepoint. */
  async workerControlRecord(database: string, command: ControlWorkerRecordCommand) {
    const { payload, ...metadata } = command;
    const json = JSON.stringify(payload);
    const reply = await this.request(
      {
        operation: 'worker-control-record',
        database,
        input: { ...metadata, byteLength: Buffer.byteLength(json) },
      },
      [json]
    );
    return (reply as Extract<Success, { operation: 'worker-control-record' }>).result;
  }

  /** Returns only after the exact Core journal tuple is covered by FULL. */
  async coreJournal(database: string, input: ControlCoreJournalInput): Promise<string | null> {
    try {
      const reply = await this.request({ operation: 'core-journal', database, input });
      return (reply as Extract<Success, { operation: 'core-journal' }>).result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'core-journal') {
        const failure = new Error(error.domain.message);
        if (error.domain.reasonCode && input.kind === 'idle-intent')
          Object.assign(failure, {
            reasonCode: error.domain.reasonCode,
            executionRef: {
              owner: { kind: 'server' },
              executionId: `idle-cleanup:${JSON.parse(input.intentJson).carriage.requestId}`,
            },
          });
        throw failure;
      }
      throw error;
    }
  }

  /** Commits one exact image receipt/journal or confirmed-defaults stage on the physical Core owner. */
  async workerImage(database: string, input: ControlWorkerImageInput): Promise<void> {
    try {
      await this.request({ operation: 'worker-image', database, input });
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'worker-image') {
        if (error.domain.code === 'unsupported_retained_format')
          throw new TypeError('Unsupported retained record format.');
        throw new WorkerImageSettlementConflict();
      }
      throw error;
    }
  }

  /** Returns current redacted token authority only after its last-use FULL acknowledgement. */
  async accessTokenVerification(
    database: string,
    input: ControlAccessTokenVerification
  ): Promise<ControlAccessTokenVerificationResult> {
    const reply = await this.request({ operation: 'access-token-verification', database, input });
    return (reply as Extract<Success, { operation: 'access-token-verification' }>).result;
  }

  /** Commits the exact separate remote request Audit after the covering FULL fsync. */
  async remoteMcpAudit(database: string, input: ControlRemoteMcpAudit): Promise<void> {
    await this.request({ operation: 'remote-mcp-audit', database, input });
  }

  /** Commits the current RuntimeTarget fact before its caller claims durable completion. */
  async runtimeTarget(
    database: string,
    input: ControlRuntimeTargetInput
  ): Promise<ControlRuntimeTargetResult> {
    try {
      const reply = await this.request({ operation: 'runtime-target', database, input });
      return (reply as Extract<Success, { operation: 'runtime-target' }>).result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'runtime-target')
        throw new Error(error.domain.message);
      throw error;
    }
  }

  /** Awaits the FULL acknowledgement for the original six-family StageReview. */
  async workspaceStageReview(database: string, input: ControlWorkspaceStageReview): Promise<void> {
    try {
      await this.request({ operation: 'workspace-stage-review', database, input });
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'workspace-stage-review'
      )
        throw new Error(error.domain.message);
      throw error;
    }
  }

  /** Preserves original operator mutation and receipt stages; only known domain failures are reconstructed. */
  async workspaceRecoveryDecision(
    database: string,
    input: ControlWorkspaceRecoveryDecision
  ): Promise<WorkspaceReconciliationRecord | null> {
    try {
      const reply = await this.request({
        operation: 'workspace-recovery-decision',
        database,
        input,
      });
      return (reply as Extract<Success, { operation: 'workspace-recovery-decision' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.commit === 'not-committed' &&
        error.domain?.operation === 'workspace-recovery-decision'
      ) {
        const id = input.reconciliationRecordId;
        switch (error.domain.code) {
          case 'record_invalid':
            throw new OperationError(
              'workspace_recovery_decision_failed',
              'The record could not be processed.',
              404
            );
          case 'missing':
            throw new StoreRecordNotFoundError(`Workspace reconciliation record not found: ${id}`);
          case 'terminal':
            throw new OperationError(
              'workspace_recovery_decision_failed',
              `Workspace reconciliation record is already terminal: ${id}`,
              404
            );
          case 'capture_source':
            throw new OperationError(
              'workspace_recovery_decision_failed',
              'Unaccepted capture source supports only abandon with evidence retained.',
              409
            );
          case 'no_manifest':
            throw new OperationError(
              'workspace_recovery_decision_failed',
              `Workspace recovery collection has no durable output manifest: ${id}`,
              404
            );
        }
      }
      throw error;
    }
  }

  /** Preserves each original handle commit and returns only current cleanup disposition. */
  async workspaceTakeover(database: string, input: ControlWorkspaceTakeover): Promise<boolean> {
    try {
      const reply = await this.request({ operation: 'workspace-takeover', database, input });
      return (reply as Extract<Success, { operation: 'workspace-takeover' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.commit === 'not-committed' &&
        error.domain?.operation === 'workspace-takeover'
      )
        throw new Error(error.domain.message);
      throw error;
    }
  }

  /** Acknowledges only the exact original capture/recovery tuple; unknown replies remain unknown. */
  async workspaceCapture(
    database: string,
    input: ControlWorkspaceCapture
  ): Promise<ControlWorkspaceCaptureResult> {
    try {
      const reply = await this.request({ operation: 'workspace-capture', database, input });
      return (reply as Extract<Success, { operation: 'workspace-capture' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.commit === 'not-committed' &&
        error.domain?.operation === 'workspace-capture'
      ) {
        if (error.domain.code === 'collection_refused')
          throw new WorkspaceCollectionError({
            outcome: 'recovery_required',
            cause: error.domain.cause,
          });
        if (error.domain.code === 'unsupported_retained_format')
          throw new TypeError(error.domain.message);
        if (error.domain.code === 'recovery_required')
          throw new WorkspaceCaptureRecoveryRequired(error.domain.message);
        if (error.domain.code === 'preserved_refused')
          throw new PreservedWorkspaceCaptureRefusal(error.domain.message);
        throw new Error(error.domain.message);
      }
      throw error;
    }
  }

  /** Publishes one original private-Workspace stage and preserves its closed domain failures. */
  async privateWorkspace(
    database: string,
    input: ControlPrivateWorkspaceInput
  ): Promise<string | null> {
    try {
      const reply = await this.request({ operation: 'private-workspace', database, input });
      if (reply.operation !== 'private-workspace')
        throw new Error('Invalid private Workspace acknowledgement.');
      return reply.result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'private-workspace'
      ) {
        if (error.domain.code === 'membership_removed')
          throw new WorkspaceOwnerMembershipRemovedError();
        throw new Error(error.domain.message);
      }
      throw error;
    }
  }

  /** Publishes one original baseline stage and preserves its closed recovery distinctions. */
  async workspaceBaseline(database: string, input: ControlWorkspaceBaseline): Promise<void> {
    try {
      await this.request({ operation: 'workspace-baseline', database, input });
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'workspace-baseline'
      ) {
        if (error.domain.code === 'collection_refused')
          throw new WorkspaceCollectionError({
            outcome: 'recovery_required',
            cause: error.domain.cause,
          });
        if (error.domain.code === 'unsupported_retained_format')
          throw new TypeError(error.domain.message);
        throw new Error(error.domain.message);
      }
      throw error;
    }
  }

  /** Publishes the whole original Workspace handoff under its existing physical owner and FULL acknowledgement. */
  async workspaceBackendHandoff(
    database: string,
    input: ControlWorkspaceBackendHandoff
  ): Promise<ControlWorkspaceBackendHandoffResult> {
    try {
      const reply = await this.request({ operation: 'workspace-backend-handoff', database, input });
      return (reply as Extract<Success, { operation: 'workspace-backend-handoff' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'workspace-backend-handoff'
      )
        throw new Error(error.domain.message);
      throw error;
    }
  }

  /** Commits the exact existing nonaccepted Review and original Audit before acknowledgement. */
  async workspaceReviewDecision(
    database: string,
    input: ControlWorkspaceReviewDecision,
    changeSetId: string
  ): Promise<import('@openkit/app-api-schemas').WorkspaceSyncReviewItem> {
    try {
      const reply = await this.request({ operation: 'workspace-review-decision', database, input });
      return (reply as Extract<Success, { operation: 'workspace-review-decision' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'workspace-review-decision'
      ) {
        switch (error.domain.code) {
          case 'review_absent':
            throw new StoreRecordNotFoundError(
              `Workspace synchronization review not found: ${input.workspaceId}/${input.reviewId}`
            );
          case 'change_set_absent':
            throw new StoreRecordNotFoundError(
              `Workspace change set not found: ${input.workspaceId}/${changeSetId}`
            );
          case 'resolved':
            throw new OperationError(
              'workspace_sync_review_failed',
              `Workspace synchronization review is already resolved: ${input.reviewId}`,
              404
            );
          case 'unsupported_retained_format':
            throw new TypeError('Unsupported retained record format.');
        }
      }
      throw error;
    }
  }

  /** Commits the exact existing accepted Result/ApplyAudit/Evidence/accepted-base/terminalReview/ReviewAudit tuple before acknowledgement. */
  async workspaceReviewFinish(
    database: string,
    input: ControlWorkspaceReviewFinish,
    changeSetId: string
  ): Promise<void> {
    try {
      await this.request({ operation: 'workspace-review-finish', database, input });
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'workspace-review-finish'
      ) {
        switch (error.domain.code) {
          case 'review_absent':
            throw new StoreRecordNotFoundError(
              `Workspace synchronization review not found: ${input.result.status === 'applied' ? input.reviewId : `${input.workspaceId}/${input.reviewId}`}`
            );
          case 'change_set_absent':
            throw new StoreRecordNotFoundError(
              `Workspace change set not found: ${input.workspaceId}/${changeSetId}`
            );
          case 'resolved':
            throw new OperationError(
              'workspace_sync_review_failed',
              `Workspace synchronization review is already resolved: ${input.reviewId}`,
              404
            );
          case 'base_changed':
            throw new OperationError(
              'workspace_sync_review_failed',
              'Workspace snapshot accepted base changed during apply.',
              404
            );
          case 'unsupported_retained_format':
            throw new TypeError('Unsupported retained record format.');
        }
      }
      throw error;
    }
  }

  /** Keeps original cadence decoding errors closed and all unknown accepted outcomes unknown. */
  async automationScanner(
    database: string,
    input: ControlAutomationScanner
  ): Promise<ControlAutomationScannerResult> {
    try {
      const reply = await this.request({ operation: 'automation-scanner', database, input });
      return (reply as Extract<Success, { operation: 'automation-scanner' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.commit === 'not-committed' &&
        error.domain?.operation === 'automation-scanner' &&
        error.domain.code === 'unsupported_retained_format'
      )
        throw new TypeError('Unsupported retained record format.');
      throw error;
    }
  }

  /** Publishes one immutable preflight Plan only after the existing covering FULL commit. */
  async workspaceApplyPlan(
    database: string,
    input: ControlWorkspaceApplyPlan
  ): Promise<ControlWorkspaceApplyPlan> {
    try {
      const reply = await this.request({ operation: 'workspace-apply-plan', database, input });
      return (reply as Extract<Success, { operation: 'workspace-apply-plan' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'workspace-apply-plan'
      ) {
        if (error.domain.code === 'unsupported_retained_format')
          throw new TypeError('Unsupported retained record format.');
        throw new OperationError(
          error.domain.code,
          `Workspace apply plan replay conflict: ${input.id}`,
          error.domain.status
        );
      }
      throw error;
    }
  }

  /** Commits one original backend-session tuple before its dependent effect or release. */
  async backendSession(
    database: string,
    input: ControlBackendSessionInput
  ): Promise<ControlBackendSessionResult> {
    try {
      const reply = await this.request({ operation: 'backend-session', database, input });
      return (reply as Extract<Success, { operation: 'backend-session' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'backend-session'
      ) {
        const Constructor =
          error.domain.errorName === 'TypeError'
            ? TypeError
            : error.domain.errorName === 'SyntaxError'
              ? SyntaxError
              : Error;
        throw new Constructor(error.domain.message);
      }
      throw error;
    }
  }

  /** Commits one exact execution-attempt transition before its dependent effect or release. */
  async executionAttempt(
    database: string,
    input: ControlExecutionAttemptCommand
  ): Promise<ControlExecutionAttemptResult> {
    try {
      const reply =
        input.kind === 'create'
          ? await (() => {
              const { preparationJson, ...metadata } = input;
              return this.request(
                {
                  operation: 'execution-attempt',
                  database,
                  input: { ...metadata, byteLength: Buffer.byteLength(preparationJson) },
                },
                [preparationJson]
              );
            })()
          : await this.request({ operation: 'execution-attempt', database, input });
      return (reply as Extract<Success, { operation: 'execution-attempt' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'execution-attempt'
      )
        throw new Error(error.domain.message);
      throw error;
    }
  }

  /** Commits one complete Harness lifecycle tuple before returning its original domain result. */
  async harnessLifecycle(
    database: string,
    input: ControlHarnessLifecycleInput
  ): Promise<ControlHarnessLifecycleResult> {
    try {
      const reply = await this.request({ operation: 'harness-lifecycle', database, input });
      return (reply as Extract<Success, { operation: 'harness-lifecycle' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'harness-lifecycle'
      ) {
        const refusal = new Error(error.domain.message);
        if (error.domain.exhaustedBound)
          Object.assign(refusal, {
            reasonCode: 'busy',
            exhaustedBound: error.domain.exhaustedBound,
          });
        throw refusal;
      }
      throw error;
    }
  }

  /** Commits the existing complete Core binding transition before returning its exact retained result. */
  async workerStorageBinding(
    database: string,
    input: ControlWorkerStorageInput
  ): Promise<WorkerStorageBinding> {
    try {
      const reply = await this.request({ operation: 'worker-storage-binding', database, input });
      return (reply as Extract<Success, { operation: 'worker-storage-binding' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'worker-storage-binding'
      )
        throw new WorkerStorageBindingError(
          error.domain.code as WorkerStorageBindingError['code'],
          error.domain.message
        );
      throw error;
    }
  }

  /** Publishes the complete scheduler/source tuple, returning only after covering FULL commit. */
  async schedulerAdmission(
    database: string,
    input: ControlSchedulerAdmission
  ): Promise<ControlSchedulerAdmissionResult> {
    try {
      const json = JSON.stringify(input);
      const reply = await this.request(
        {
          operation: 'scheduler-admission',
          database,
          input: {
            byteLength: Buffer.byteLength(json),
            turnId: input.mode === 'create' ? input.entry.turnId : null,
          },
        },
        [json]
      );
      return (reply as Extract<Success, { operation: 'scheduler-admission' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'scheduler-admission'
      ) {
        if (error.domain.kind === 'decoder') throw new SyntaxError(error.domain.message);
        if (error.domain.kind === 'transition')
          throw new SchedulerAdmissionTransitionError(error.domain.message, error.domain.code);
        throw new OperationError(error.domain.code, error.domain.message, error.domain.status);
      }
      throw error;
    }
  }

  /** Acknowledges one original stopped-reactivation stage only after its own covering FULL commit. */
  async recoverySourceReactivation(
    database: string,
    value: ControlRecoverySourceReactivationInput
  ): Promise<void> {
    const input = ControlRecoverySourceReactivationInputSchema.parse(value);
    this.assertAccepting();
    const opening = this.openings.get(database);
    if (!opening || opening.identity === undefined)
      throw new ControlStoreWorkerError('not-open', 'not-committed');
    const call: ControlRecoverySourceReactivationCall = {
      kind: 'recovery-source-reactivation',
      [sourceReactivationCall]: true,
      input,
      command: opening.command,
      path: opening.path,
      identity: opening.identity,
    };
    await this.request(
      { operation: 'recovery-source-reactivation', database, input },
      undefined,
      undefined,
      false,
      call
    );
  }

  /** Publishes one original prepare/proof/abandon stage under its current Core lifecycle binding. */
  async recoveryTargetPreparation(
    database: string,
    value: ControlRecoveryTargetPreparationInput,
    freeze?: WorkspaceFrozenAdmission,
    assertCurrent?: () => void
  ): Promise<void> {
    const input = ControlRecoveryTargetPreparationInputSchema.parse(value);
    this.assertAccepting();
    const opening = this.openings.get(database);
    if (!opening || opening.identity === undefined)
      throw new ControlStoreWorkerError('not-open', 'not-committed');
    const call: ControlRecoveryTargetPreparationCall = {
      kind: 'recovery-target-preparation',
      [recoveryTargetRegistrationCall]: true,
      assertCurrent,
      freeze,
      input,
      command: opening.command,
      path: opening.path,
      identity: opening.identity,
    };
    await this.request(
      { operation: 'recovery-target-preparation', database, input },
      undefined,
      undefined,
      false,
      call
    );
  }

  /** Commits the original complete target registration and admission result after physical placement. */
  async recoveryTargetRegistration(
    database: string,
    value: ControlRecoveryTargetRegistrationInput,
    freeze?: WorkspaceFrozenAdmission
  ): Promise<WorkspaceRecoveryCliReport> {
    const input = ControlRecoveryTargetRegistrationInputSchema.parse(value);
    if ((input.authority.mode === 'live') !== (freeze !== undefined))
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    const opening = this.openings.get(database);
    if (!opening || opening.identity === undefined)
      throw new ControlStoreWorkerError('not-open', 'not-committed');
    const call: ControlRecoveryTargetRegistrationCall = {
      kind: 'recovery-target-registration',
      [recoveryTargetRegistrationCall]: true,
      freeze,
      input,
      command: opening.command,
      path: opening.path,
      identity: opening.identity,
    };
    const reply = await this.request(
      { operation: 'recovery-target-registration', database, input },
      undefined,
      undefined,
      false,
      call
    );
    return (reply as Extract<Success, { operation: 'recovery-target-registration' }>).result;
  }

  /** Publishes one whole original Core deletion stage under its existing lifecycle freeze. */
  async workspaceDeletion(
    database: string,
    value: ControlWorkspaceDeletionInput,
    freeze: WorkspaceFrozenAdmission
  ): Promise<ControlWorkspaceDeletionResult> {
    if (freeze === undefined) throw new ControlStoreWorkerError('precondition', 'not-committed');
    const input = ControlWorkspaceDeletionInputSchema.parse(value);
    const opening = this.openings.get(database);
    if (!opening || opening.identity === undefined)
      throw new ControlStoreWorkerError('not-open', 'not-committed');
    const call: ControlWorkspaceDeletionCall = {
      kind: 'workspace-deletion',
      [workspaceDeletionCall]: true,
      freeze,
      input,
      command: opening.command,
      path: opening.path,
      identity: opening.identity,
    };
    const reply = await this.request(
      { operation: 'workspace-deletion', database, input },
      undefined,
      undefined,
      false,
      call
    );
    const result = (reply as Extract<Success, { operation: 'workspace-deletion' }>).result;
    if (result.stage !== input.stage)
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    return result;
  }

  /** Commits the exact Core sharing mutation, Audit and original receipt in one covering FULL acknowledgement. */
  async coreSharing(
    database: string,
    input: ControlCoreSharing,
    assertCurrent?: () => void
  ): Promise<ControlCoreSharingResult> {
    try {
      let call: ControlCoreRetirementCall | undefined;
      if (input.command === 'workspace.retire-quarantined') {
        const opening = this.openings.get(database);
        if (!opening || opening.identity === undefined || !assertCurrent)
          throw new ControlStoreWorkerError('precondition', 'not-committed');
        call = {
          kind: 'core-sharing-retirement',
          [coreRetirementCall]: true,
          input,
          command: opening.command,
          path: opening.path,
          identity: opening.identity,
          assertCurrent,
        };
      }
      const reply = await this.request(
        { operation: 'core-sharing', database, input },
        undefined,
        undefined,
        false,
        call
      );
      return (reply as Extract<Success, { operation: 'core-sharing' }>).result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'core-sharing') {
        if (error.domain.code === 'idempotency_key_conflict')
          throw new IdempotencyKeyConflictError();
        throw new OperationError(
          error.domain.code,
          error.domain.message,
          error.domain.status,
          'details' in error.domain ? { details: error.domain.details } : undefined
        );
      }
      throw error;
    }
  }

  /** Commits candidate membership/history with its original receipt; FULL acknowledgement returns the complete record. */
  async evaluationCandidate(
    database: string,
    input: ControlEvaluationCandidate
  ): Promise<import('@openkit/app-api-schemas').CandidateSetRecord> {
    try {
      const reply = await this.request({ operation: 'evaluation-candidate', database, input });
      return (reply as Extract<Success, { operation: 'evaluation-candidate' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.domain?.operation === 'evaluation-candidate'
      ) {
        if (error.domain.code === 'idempotency_key_conflict')
          throw new IdempotencyKeyConflictError();
        throw new OperationError(error.domain.code, error.domain.message, error.domain.status);
      }
      throw error;
    }
  }

  /** Commits the complete scoped Review or Artifact submission tuple and its original receipt. */
  async review(
    database: string,
    input: ControlReviewCommandInput
  ): Promise<ControlReviewCommandResult> {
    try {
      const reply = await this.request({ operation: 'review', database, input });
      return (reply as Extract<Success, { operation: 'review' }>).result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'review') {
        if (error.domain.code === 'idempotency_key_conflict')
          throw new IdempotencyKeyConflictError();
        throw new ArtifactReviewError(
          error.domain.code as ConstructorParameters<typeof ArtifactReviewError>[0],
          error.domain.message
        );
      }
      throw error;
    }
  }

  /** Commits the complete local terminal tuple; only outer FULL COMMIT produces this acknowledgement, never physical release. */
  async terminal(
    database: string,
    input: ControlTerminalTransition
  ): Promise<ControlTerminalResult> {
    const reply = await this.request({ operation: 'terminal', database, input });
    return (reply as Extract<Success, { operation: 'terminal' }>).result;
  }

  /** Attempts native checkpoint progress after prior submitted work. */
  async checkpoint(database: string): Promise<ControlCheckpoint> {
    const reply = await this.request({ operation: 'checkpoint', database });
    return (reply as Extract<Success, { operation: 'checkpoint' }>).pressure;
  }

  /** Requests bounded native reclamation; false preserves the existing blocked result. */
  async reclaim(database: string): Promise<boolean> {
    const reply = await this.request({ operation: 'reclaim', database });
    return (reply as Extract<Success, { operation: 'reclaim' }>).complete;
  }

  /** Joins accepted same-scope preparation before a lifecycle owner closes the native writer. */
  private async drainScopePublications(opening: Opening | undefined): Promise<void> {
    // The lifecycle caller excludes new producers; accepted ones may still be waiting to post.
    const path = opening && realpathSync(opening.path);
    const accepted = [...this.turnTails].filter(([key]) => JSON.parse(key)[0] === path);
    const settled = await Promise.allSettled(accepted.map(([, entry]) => entry.tail));
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  /** Closes one exact generation after its accepted preparation, children and readers finish. */
  async close(database: string, recovery?: ControlRecoveryNativeCall): Promise<void> {
    this.assertFrozenCall({ operation: 'close', database }, recovery);
    const opening = this.openings.get(database);
    if (opening?.retirement && !opening.retirement.settled) {
      if (opening.retirement.operation !== 'close')
        throw new ControlStoreWorkerError('busy', 'not-committed');
      return opening.retirement.promise;
    }
    const pending = (async () => {
      try {
        // The existing drain/request path already joins accepted OPEN and publication dependencies.
        if (opening?.command.productOwner?.kind === 'workspace') {
          const workspaceId = opening.command.productOwner.workspaceId;
          const children = [...this.openings.values()].filter(
            (entry) =>
              entry.command.physicalScope?.workspaceId === workspaceId &&
              entry.command.dataRoot !== undefined &&
              opening.command.dataRoot !== undefined &&
              realpathSync(entry.command.dataRoot) === realpathSync(opening.command.dataRoot)
          );
          for (const child of children) {
            await child.promise;
            const current = this.openings.get(child.command.database);
            if (current !== undefined && current !== child)
              throw new ControlStoreWorkerError('precondition', 'not-committed');
            if (current === child) await this.close(child.command.database, recovery);
          }
        }
        await this.drainScopePublications(opening);
        if (opening) {
          closeWorkspaceProductReadHandles(opening.path);
          await drainMainScopeReadHandles([opening.path]);
          // Accepted ACK continuations can create an idle metadata reader before releasing their own.
          closeWorkspaceProductReadHandles(opening.path);
        }
        await this.drainPolicyPreparations(opening);
        await this.request({ operation: 'close', database }, undefined, undefined, false, recovery);
        if (this.openings.get(database) === opening) this.openings.delete(database);
      } catch (error) {
        if (opening?.command.initialize === 'core') {
          this.fail(opening.host);
          await opening.host.worker?.terminate();
        }
        throw error;
      } finally {
        if (opening) closeWorkspaceProductReadHandles(opening.path);
      }
    })();
    if (opening) opening.retirement = { operation: 'close', promise: pending };
    try {
      await pending;
    } catch (error) {
      // Keep late acquisitions excluded. Only an explicit later retirement may inspect the original failure again.
      if (opening?.retirement?.promise === pending) opening.retirement.settled = true;
      throw error;
    }
  }

  /** Closes the admitted private candidate before sealing; null proves close but never a usable seal. */
  async sealRecovery(
    database: string,
    recovery?: ControlRecoveryNativeCall
  ): Promise<string | null> {
    this.assertFrozenCall({ operation: 'recovery-seal', database }, recovery);
    const opening = this.openings.get(database);
    if (opening?.retirement && !opening.retirement.settled) {
      if (opening.retirement.operation !== 'seal')
        throw new ControlStoreWorkerError('busy', 'not-committed');
      return opening.retirement.promise;
    }
    const pending = (async () => {
      try {
        await this.drainScopePublications(opening);
        if (opening) {
          closeWorkspaceProductReadHandles(opening.path);
          await drainMainScopeReadHandles([opening.path]);
          // Accepted ACK continuations can create an idle metadata reader before releasing their own.
          closeWorkspaceProductReadHandles(opening.path);
        }
        await this.drainPolicyPreparations(opening);
        const reply = await this.request(
          { operation: 'recovery-seal', database },
          undefined,
          undefined,
          false,
          recovery
        );
        if (this.openings.get(database) === opening) this.openings.delete(database);
        return (reply as Extract<Success, { operation: 'recovery-seal' }>).digest;
      } finally {
        if (opening) closeWorkspaceProductReadHandles(opening.path);
      }
    })();
    if (opening) opening.retirement = { operation: 'seal', promise: pending };
    try {
      return await pending;
    } catch (error) {
      if (opening?.retirement?.promise === pending) opening.retirement.settled = true;
      throw error;
    }
  }

  /**
   * Holds native posting for synchronous Main SQL or data-root capture after posted acknowledgements settle.
   *
   * New requests keep the same finite admission slots and byte budget while waiting. The caller must resume in finally; this hold neither closes scopes nor replays commands. A failed channel refuses capture because its outstanding commits are unknown.
   *
   * Database holds run FIFO and leave siblings live. Global capture waits for earlier database holds;
   * later database holds wait for its release. The synchronous body must not await native work.
   *
   * @param database Exact database key, or all databases for the existing backup capture.
   * @returns An idempotent release, which the caller must invoke in finally.
   */
  /** Binds the application's same gate without creating a native host, connection or hold. */
  setWorkspaceMutationAdmission(admission: WorkspaceMutationAdmission): void {
    if (this.workspaceMutationAdmission && this.workspaceMutationAdmission !== admission)
      throw new Error('Native client already has a different Workspace mutation owner.');
    this.workspaceMutationAdmission = admission;
  }

  /** Installs the existing target hold without joining a competing target or global hold. Only posted ACKs may settle. */
  tryPauseForWorkspaceCapture(
    database: string,
    admission?: WorkspaceMutationAdmission
  ): Promise<() => void> | null {
    const parent = this.openings.get(database)?.command;
    const owner = parent?.productOwner;
    const keys = [
      database,
      ...[...this.openings.entries()]
        .filter(
          ([, entry]) =>
            owner?.kind === 'workspace' &&
            entry.command.physicalScope?.workspaceId === owner.workspaceId &&
            entry.command.dataRoot !== undefined &&
            parent?.dataRoot !== undefined &&
            realpathSync(entry.command.dataRoot) === realpathSync(parent.dataRoot)
        )
        .map(([key]) => key),
    ];
    if (this.backupHold || keys.some((key) => this.databaseHolds.has(key))) return null;
    if (admission) this.setWorkspaceMutationAdmission(admission);
    const acquired: Array<() => void> = [];
    return Promise.allSettled(
      keys.map(async (key) => {
        const release = await this.pauseForDataRootBackup(key);
        acquired.push(release);
        return release;
      })
    ).then((results) => {
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') {
        for (const release of acquired) release();
        throw failed.reason;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const release of acquired) release();
      };
    });
  }

  async pauseForDataRootBackup(database?: string): Promise<() => void> {
    this.assertAccepting();
    const failed = () =>
      database === undefined
        ? this.hosts.some((host) => host.failed)
        : this.openings.get(database)?.host.failed === true;
    if (failed()) throw new ControlStoreWorkerError('unavailable', 'not-committed');
    if (database === undefined && this.backupHold)
      throw new ControlStoreWorkerError('busy', 'not-committed');
    const previous = database === undefined ? undefined : this.databaseHolds.get(database);
    const dependencies =
      database === undefined
        ? [...this.databaseHolds.values()].map((hold) => hold.released)
        : [previous?.released, this.backupHold?.released];
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hold = previous ?? { released, drain: undefined };
    hold.released = released;
    if (database === undefined) this.backupHold = hold;
    else this.databaseHolds.set(database, hold);
    const resume = () => {
      if (database === undefined) this.backupHold = undefined;
      else if (hold.released === released) this.databaseHolds.delete(database);
      release();
      for (const entry of this.pending.values()) if (!entry.posted) this.post(entry);
    };
    try {
      await Promise.all(dependencies);
      await new Promise<void>((resolve) => {
        hold.drain = resolve;
        this.completeBackupDrain();
      });
      this.assertAccepting();
      if (failed()) throw new ControlStoreWorkerError('unavailable', 'not-committed');
    } catch (error) {
      resume();
      throw error;
    }
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      resume();
    };
  }

  /**
   * Stops admission, drains accepted work and closes the actual owned thread.
   *
   * A failed transport is terminated without retrying its pending work. A subsequent explicit host lifetime does not resolve those unknown command outcomes.
   *
   * @returns After graceful shutdown or termination; never leaves a second live host.
   */
  shutdown(): Promise<void> {
    // Read-only inspection can occur after this writer lifetime has already stopped.
    if (this.closed) closeWorkspaceProductReadHandles();
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.stopping = true;
    this.shutdownPromise = (async () => {
      try {
        const failures: unknown[] = [];
        while (this.operations.size) {
          const outcomes = await Promise.allSettled(this.operations.keys());
          for (const outcome of outcomes)
            if (outcome.status === 'rejected') failures.push(outcome.reason);
        }
        // Accepted ACK continuations have finished; release readers before final writer close.
        closeWorkspaceProductReadHandles();
        await drainMainScopeReadHandles([...this.openings.values()].map((opening) => opening.path));
        closeWorkspaceProductReadHandles();
        const shutdowns = await Promise.allSettled(
          this.hosts
            .filter((host) => host.worker && !host.failed)
            .map((host) => this.request({ operation: 'shutdown' }, undefined, host))
        );
        for (const outcome of shutdowns)
          if (outcome.status === 'rejected') failures.push(outcome.reason);
        if (failures.length)
          throw new AggregateError(
            failures,
            'Accepted control-store operations failed during shutdown.'
          );
      } finally {
        try {
          await Promise.all(this.hosts.map((host) => host.worker?.terminate()));
        } finally {
          closeWorkspaceProductReadHandles();
        }
        for (const host of this.hosts) {
          this.fail(host);
          for (const reservation of host.capacity) reservation.release();
          host.capacity.clear();
        }
        this.backing.clear();
        this.closed = true;
      }
    })();
    return this.shutdownPromise;
  }

  /** Bounds all scoped messages BEFORE cloning/posting, including native-thread stalls. */
  private request(
    command: ControlWorkerCommand,
    materialParts?: readonly (string | Uint8Array)[],
    target?: WriterHost,
    deferPost = false,
    recovery?: ControlFrozenNativeCall,
    preparedCapacity: readonly NativeCapacityReservation[] = [],
    schemaApplicationFacts?: Pending['schemaApplicationFacts'],
    policyCall?: PolicyCall
  ): Promise<Success> {
    if (command.operation !== 'shutdown') {
      try {
        this.assertAccepting();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const database = 'database' in command ? command.database : undefined;
    const context = this.operationContext.getStore();
    const progressCopy =
      context?.active && context.reservation === database ? context.progressCopy : undefined;
    const fundsProgress =
      progressCopy?.active &&
      !progressCopy.borrowing &&
      ((command.operation === 'open' &&
        !progressCopy.openUsed &&
        commandInputHash({ ...command, operation: undefined }) === progressCopy.openingHash) ||
        (command.operation === 'item' &&
          !progressCopy.itemUsed &&
          command.input.item.type === 'status' &&
          command.input.item.id === progressCopy.itemId &&
          command.input.item.turnId === progressCopy.turnId &&
          command.input.category === progressCopy.category))
        ? progressCopy
        : undefined;
    if (progressCopy && !fundsProgress)
      return Promise.reject(new ControlStoreWorkerError('precondition', 'not-committed'));
    const closeout =
      command.operation === 'capability'
        ? this.closeoutCredit(command.database, command.input)
        : undefined;
    const borrowed =
      closeout !== undefined ||
      (database !== undefined && context?.active && context.reservation === database);
    // The exact Item's preparation owns this serial borrow until its covering native ACK.
    const creditedPublication =
      !progressCopy &&
      context?.active &&
      context.reservation === database &&
      context.closeout?.borrowing &&
      context.closeout.database === database &&
      (command.operation === 'products' ||
        command.operation === 'publication' ||
        command.operation === 'item');
    const opening = database === undefined ? undefined : this.openings.get(database);
    try {
      this.assertFrozenCall(command, recovery, opening);
    } catch (error) {
      return Promise.reject(error);
    }
    const host = target ?? opening?.host;
    // An ACK may be validated before older scope reactions run. They keep their prefix.
    const ready =
      command.operation !== 'open' &&
      opening &&
      (!opening.acknowledged ||
        [...this.pending.values()].some(
          (entry) =>
            !entry.ready && 'database' in entry.command && entry.command.database === database
        ))
        ? opening.promise
        : undefined;
    if (!host || host.failed)
      return Promise.reject(
        new ControlStoreWorkerError(host ? 'unavailable' : 'not-open', 'not-committed')
      );
    if (
      (database !== undefined &&
        (this.outstanding.get(database) ?? 0) - (borrowed ? 1 : 0) >=
          CONTROL_WORKER_LIMITS.pendingTransitions) ||
      ((command.operation === 'observation' ||
        command.operation === 'provenance' ||
        command.operation === 'scheduler-admission' ||
        command.operation === 'generative-presentation' ||
        command.operation === 'worker-control-evidence') &&
        opening &&
        (command.operation !== 'scheduler-admission' || command.input.turnId !== null) &&
        !borrowed &&
        this.pendingTurnPublications(JSON.stringify([opening.path, command.input.turnId])) >=
          CONTROL_WORKER_LIMITS.pendingTurnTransitions)
    ) {
      return Promise.reject(new ControlStoreWorkerError('busy', 'not-committed'));
    }
    if (!Number.isSafeInteger(this.nextId)) {
      return Promise.reject(new ControlStoreWorkerError('unavailable', 'not-committed'));
    }
    let inputBytes: number;
    try {
      inputBytes =
        controlWorkerInputBytes({ ...command, version: CONTROL_WORKER_VERSION, id: this.nextId }) +
        64;
    } catch {
      return Promise.reject(new ControlStoreWorkerError('invalid-request', 'not-committed'));
    }
    // A funded clone substitutes equal already-booked bytes. It cannot acquire a new
    // aggregate refusal, including when an original exact MCP closeout uses its exemption.
    // One fixed shutdown message per owned host still drains accepted work at saturation.
    if (
      command.operation !== 'shutdown' &&
      !closeout &&
      !creditedPublication &&
      (fundsProgress
        ? inputBytes > fundsProgress.remainingBytes
        : this.reservedInputBytes(database) + inputBytes > CONTROL_WORKER_LIMITS.pendingBytes)
    )
      return Promise.reject(new ControlStoreWorkerError('busy', 'not-committed'));
    let materialBytes = 0;
    let posted = command;
    if (
      command.operation === 'material' ||
      command.operation === 'capability' ||
      command.operation === 'observation' ||
      command.operation === 'scheduler-admission' ||
      command.operation === 'generative-presentation' ||
      command.operation === 'app-kernel' ||
      command.operation === 'schema-application' ||
      command.operation === 'attention-enqueue' ||
      command.operation === 'workspace-command-receipt' ||
      command.operation === 'standalone-audit' ||
      command.operation === 'thread-read-membership' ||
      command.operation === 'worker-control-final-status' ||
      command.operation === 'worker-control-heartbeat' ||
      command.operation === 'worker-control-record' ||
      (command.operation === 'execution-attempt' && command.input.kind === 'create')
    ) {
      const size =
        command.operation === 'execution-attempt'
          ? {
              byteLength: command.input.kind === 'create' ? command.input.byteLength : 0,
              replyByteLength: 0,
            }
          : command.operation === 'material'
            ? controlMaterialTransferSize(command.input)
            : command.operation === 'scheduler-admission' ||
                command.operation === 'generative-presentation' ||
                command.operation === 'app-kernel' ||
                command.operation === 'schema-application' ||
                command.operation === 'attention-enqueue' ||
                command.operation === 'workspace-command-receipt' ||
                command.operation === 'standalone-audit' ||
                command.operation === 'thread-read-membership' ||
                command.operation === 'worker-control-final-status' ||
                command.operation === 'worker-control-heartbeat' ||
                command.operation === 'worker-control-record'
              ? { byteLength: command.input.byteLength, replyByteLength: 0 }
              : command.operation === 'observation'
                ? {
                    byteLength: controlWorkObservationTransferSize(command.input),
                    replyByteLength: 0,
                  }
                : {
                    byteLength: controlCapabilityText(command.input)?.byteLength ?? 0,
                    replyByteLength: 0,
                  };
      if (!size || size.byteLength === undefined)
        return Promise.reject(new ControlStoreWorkerError('invalid-request', 'not-committed'));
      materialBytes = size.byteLength + size.replyByteLength;
      if (
        !Number.isSafeInteger(materialBytes) ||
        materialBytes > CONTROL_WORKER_LIMITS.materialPendingBytes ||
        (!closeout &&
          materialBytes >
            CONTROL_WORKER_LIMITS.materialPendingBytes -
              (this.backing.get(database)?.materialBytes ?? 0))
      )
        return Promise.reject(new ControlStoreWorkerError('busy', 'not-committed'));
      if (materialParts?.length) {
        // Admission precedes allocation and transfer. No escaped JSON or second payload buffer is made.
        const content = new ArrayBuffer(size.byteLength);
        let offset = 0;
        for (const text of materialParts) {
          if (text instanceof Uint8Array) {
            if (text.byteLength > size.byteLength - offset)
              return Promise.reject(
                new ControlStoreWorkerError('invalid-request', 'not-committed')
              );
            new Uint8Array(content, offset, text.byteLength).set(text);
            offset += text.byteLength;
            continue;
          }
          const encoded = new TextEncoder().encodeInto(text, new Uint8Array(content, offset));
          if (encoded.read !== text.length)
            return Promise.reject(new ControlStoreWorkerError('invalid-request', 'not-committed'));
          offset += encoded.written;
        }
        if (offset !== size.byteLength)
          return Promise.reject(new ControlStoreWorkerError('invalid-request', 'not-committed'));
        posted = { ...command, content };
      }
    } else if (materialParts !== undefined)
      return Promise.reject(new ControlStoreWorkerError('invalid-request', 'not-committed'));
    const request: ControlWorkerRequest = {
      ...posted,
      version: CONTROL_WORKER_VERSION,
      id: this.nextId,
    };
    if (!isControlWorkerRequest(request)) {
      return Promise.reject(new ControlStoreWorkerError('invalid-request', 'not-committed'));
    }
    // Posting normally transfers ownership immediately. A capture hold must take the same
    // immutable input now, so its caller cannot change a bounded envelope before resume.
    let admittedRequest = request;
    if (
      this.backupHold ||
      (database !== undefined && this.databaseHolds.has(database)) ||
      deferPost ||
      ready !== undefined
    ) {
      try {
        admittedRequest = structuredClone(request, {
          transfer: 'content' in request && request.content ? [request.content] : [],
        });
      } catch {
        return Promise.reject(new ControlStoreWorkerError('invalid-request', 'not-committed'));
      }
    }
    let capacity: readonly NativeCapacityReservation[];
    try {
      capacity = [
        ...preparedCapacity,
        ...this.reserveCapacity(
          command,
          opening,
          inputBytes,
          materialBytes,
          closeout !== undefined || !!creditedPublication
        ),
      ];
    } catch (error) {
      return Promise.reject(
        error instanceof FileAdmissionError
          ? new ControlStoreWorkerError('no-space', 'not-committed')
          : error
      );
    }
    let worker: Worker;
    try {
      worker = this.startWorker(host);
    } catch {
      for (const reservation of capacity) reservation.release();
      this.fail(host);
      return Promise.reject(new ControlStoreWorkerError('unavailable', 'not-committed'));
    }
    const id = this.nextId++;
    const result = new Promise<Success>((resolve, reject) => {
      if (fundsProgress) {
        fundsProgress.borrowing = true;
        fundsProgress.remainingBytes -= inputBytes;
        this.adjustProgressCopyBytes(fundsProgress.database, -inputBytes);
        if (command.operation === 'open') fundsProgress.openUsed = true;
        else fundsProgress.itemUsed = true;
      }
      this.adjustBacking(database, inputBytes, materialBytes, host);
      host.pending += 1;
      for (const reservation of capacity) host.capacity.add(reservation);
      if (closeout) closeout.borrowing = true;
      const entry: Pending = {
        counted: !borrowed,
        host,
        command: admittedRequest,
        request: admittedRequest,
        ...(recovery ? { recovery } : {}),
        posted: false,
        ready: ready === undefined,
        materialBytes,
        inputBytes,
        capacity: [...capacity],
        closeout,
        ...(fundsProgress ? { progressCopy: { credit: fundsProgress, bytes: inputBytes } } : {}),
        ...(schemaApplicationFacts ? { schemaApplicationFacts } : {}),
        ...(policyCall ? { policyCall } : {}),
        resolve,
        reject,
      };
      if (policyCall) policyCall.id = id;
      this.pending.set(id, entry);
      if (database !== undefined && !borrowed)
        this.outstanding.set(database, (this.outstanding.get(database) ?? 0) + 1);
      if (policyCall) {
        try {
          this.retainPolicyCall(policyCall);
        } catch (error) {
          this.complete(id, undefined, error as ControlStoreWorkerError);
          return; // Never posted: no native preparation or reader could exist.
        }
      }
      worker.ref();
      if (ready !== undefined) {
        void ready.then(
          () => {
            if (this.pending.get(id) !== entry) return;
            entry.ready = true;
            if (!deferPost || entry.cohort) this.post(entry);
          },
          (error: unknown) => {
            this.complete(
              id,
              undefined,
              new ControlStoreWorkerError(
                error instanceof ControlStoreWorkerError ? error.code : 'unavailable',
                'not-committed'
              )
            );
          }
        );
      } else if (!deferPost) this.post(entry);
    });
    // Drain ordinary request settlement without promoting its caller-owned error to shutdown.
    // Opening-dependent requests retain their original shutdown failure reporting.
    const operation =
      ready === undefined
        ? result.then(
            () => undefined,
            () => undefined
          )
        : result;
    this.operations.set(operation, undefined);
    const release = () => this.operations.delete(operation);
    void operation.then(release, release);
    return result;
  }

  /** Posts an admitted message once, after its scope ACK and any data-root capture hold. */
  private post(entry: Pending): void {
    if (entry.posted) return;
    const opening =
      'database' in entry.command ? this.openings.get(entry.command.database) : undefined;
    try {
      this.assertFrozenCall(entry.command, entry.recovery, opening);
    } catch (error) {
      const members = entry.cohort?.frame.requests.map(
        (request) => this.pending.get(request.id)!
      ) ?? [entry];
      for (const member of members)
        this.complete(
          member.request.id,
          undefined,
          error as ControlStoreWorkerError | OperationError
        );
      return;
    }
    if (
      entry.posted ||
      !entry.ready ||
      this.backupHold ||
      ('database' in entry.command && this.databaseHolds.has(entry.command.database))
    )
      return;
    const members = entry.cohort?.frame.requests.map(
      (request) => this.pending.get(request.id)!
    ) ?? [entry];
    if (members.some((member) => !member.ready)) return;
    try {
      for (const member of members)
        this.assertFrozenCall(
          member.command,
          member.recovery,
          'database' in member.command ? this.openings.get(member.command.database) : undefined
        );
    } catch (error) {
      for (const member of members)
        this.complete(
          member.request.id,
          undefined,
          error as ControlStoreWorkerError | OperationError
        );
      return;
    }
    // There is no asynchronous gap from this same-owner recapture to native posting.
    // Refusal preserves the original frame and byte account rather than resizing held work.
    for (const member of members) {
      if (!this.schemaApplicationFactsCurrent(member)) {
        for (const refused of members)
          this.complete(
            refused.request.id,
            undefined,
            new ControlStoreWorkerError('precondition', 'not-committed')
          );
        return;
      }
    }
    for (const member of members) member.posted = true;
    try {
      const request = entry.request;
      const transferList =
        'content' in request && request.content !== undefined ? [request.content] : [];
      entry.host.worker!.postMessage(entry.cohort?.frame ?? request, transferList);
    } catch {
      // A clone/post failure enqueues none of this one frame, including every cohort member.
      for (const member of members) {
        member.posted = false;
        this.complete(
          member.request.id,
          undefined,
          new ControlStoreWorkerError('invalid-request', 'not-committed')
        );
      }
    }
  }

  /** A held capture can start only after every previously posted message has settled. */
  private completeBackupDrain(): void {
    for (const [database, hold] of [[undefined, this.backupHold], ...this.databaseHolds] as const) {
      if (
        !hold?.drain ||
        [...this.pending.values()].some(
          (entry) =>
            entry.posted &&
            (database === undefined ||
              ('database' in entry.command && entry.command.database === database))
        )
      )
        continue;
      const complete = hold.drain;
      hold.drain = undefined;
      complete();
    }
  }

  /** Completes correlation once and releases the pre-post admission slot. */
  private complete(
    id: number,
    reply?: Success,
    error?: ControlStoreWorkerError | PendingRequestCommandError | OperationError,
    releaseMaterialBytes = true
  ): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    if (releaseMaterialBytes) {
      const releasedInputBytes = entry.cohort
        ? --entry.cohort.remaining === 0
          ? entry.cohort.inputBytes
          : 0
        : entry.inputBytes;
      this.adjustBacking(
        'database' in entry.command ? entry.command.database : undefined,
        -releasedInputBytes,
        -entry.materialBytes,
        entry.host
      );
      for (const reservation of entry.capacity) {
        reservation.release();
        entry.host.capacity.delete(reservation);
      }
    }
    if (entry.progressCopy) {
      const { credit, bytes } = entry.progressCopy;
      credit.borrowing = false;
      if (releaseMaterialBytes && credit.active) {
        credit.remainingBytes += bytes;
        this.adjustProgressCopyBytes(credit.database, bytes);
      }
    }
    entry.host.pending -= 1;
    if (entry.counted && 'database' in entry.command)
      this.releaseOutstanding(entry.command.database);
    if (entry.closeout) {
      entry.closeout.borrowing = false;
      if (!entry.closeout.active) this.releaseOutstanding(entry.closeout.database);
    }
    const policy = entry.policyCall;
    const read = policy?.resource;
    if (
      read &&
      (!entry.posted ||
        policy?.phase === 'new' ||
        policy?.phase === 'done' ||
        policy?.phase === 'refused')
    ) {
      if (entry.posted && error instanceof ControlStoreWorkerError && error.commit === 'unknown') {
        this.fail(entry.host);
        void entry.host.exited.promise.then(() => this.releasePolicyRead(read));
      } else this.releasePolicyRead(read);
    }
    if (error !== undefined) entry.reject(error);
    else if (reply !== undefined) entry.resolve(reply);
    if (entry.host.pending === 0 && !this.hasPolicyReads(entry.host)) entry.host.worker?.unref();
    this.completeBackupDrain();
  }

  /** Compares the original Main owners without disclosing a capture failure or its payload. */
  private schemaApplicationFactsCurrent(entry: Pending): boolean {
    if (entry.command.operation !== 'schema-application') return true;
    const facts = entry.schemaApplicationFacts;
    if (!facts) return false;
    try {
      return isDeepStrictEqual(
        facts.captured,
        ControlSchemaApplicationFactsSchema.parse(facts.capture())
      );
    } catch {
      return false;
    }
  }

  /** Reserves the exact post-predecessor copy before the owner publishes any of it. */
  private async receivePhysicalForecast(value: unknown, host: WriterHost): Promise<void> {
    const parsed = ControlPhysicalForecastSchema.safeParse(value);
    if (!parsed.success) {
      this.fail(host);
      return;
    }
    const forecast = parsed.data;
    const entry = this.pending.get(forecast.id);
    const opening = this.openings.get(forecast.database);
    if (
      !entry ||
      entry.host !== host ||
      !entry.posted ||
      entry.physicalForecasted ||
      !('database' in entry.command) ||
      entry.command.database !== forecast.database ||
      !opening ||
      opening.host !== host
    ) {
      this.fail(host);
      return;
    }
    entry.physicalForecasted = true;
    let decision: 'admitted' | 'no-space' | 'unavailable' | 'precondition' = 'admitted';
    const reserved: NativeCapacityReservation[] = [];
    try {
      // This check precedes even the capacity-owner lookup and every forPath/reservation.
      if (!this.schemaApplicationFactsCurrent(entry))
        throw new ControlStoreWorkerError('precondition', 'not-committed');
      if (entry.command.operation === 'open' && opening.command.physicalScope) {
        const scope = opening.command.physicalScope;
        const dataRoot = opening.command.dataRoot;
        if (!dataRoot) throw new ControlStoreWorkerError('precondition', 'not-committed');
        const [current, currentPath, currentRoot] = await Promise.all([
          stat(opening.path),
          realpath(opening.command.path),
          realpath(dataRoot),
        ]);
        // Failure or disposal during these reads cannot acquire capacity for a settled request.
        if (
          this.pending.get(forecast.id) !== entry ||
          this.openings.get(forecast.database) !== opening ||
          host.failed
        )
          throw new ControlStoreWorkerError('unavailable', 'not-committed');
        if (
          currentPath !== opening.path ||
          `${current.dev}:${current.ino}` !== opening.identity ||
          lightAppDbPath(currentRoot, scope.workspaceId, scope.appId) !== opening.path
        )
          throw new ControlStoreWorkerError('precondition', 'not-committed');
      }
      const root = opening.command.dataRoot ?? dirname(opening.path);
      const admission = this.fileAdmissions.get(resolve(root));
      if (!admission) throw new Error('Missing native capacity owner.');
      const physicalRoot = dirname(opening.path);
      // The opening owns both roots. A forecast cannot name another Workspace or supply a root.
      const schemaHistoryRoot =
        opening.command.initialize === 'workspace' &&
        opening.command.productOwner?.kind === 'workspace' &&
        opening.command.dataRoot
          ? resolveDataRootPath(
              opening.command.dataRoot,
              'workspaces',
              opening.command.productOwner.workspaceId,
              'knowledge',
              'schema',
              'history'
            )
          : undefined;
      for (const file of forecast.files) {
        const target = resolve(file.path);
        if (
          target !== physicalRoot &&
          !target.startsWith(`${physicalRoot}/`) &&
          (schemaHistoryRoot === undefined ||
            (target !== schemaHistoryRoot && !target.startsWith(`${schemaHistoryRoot}/`)))
        )
          throw new Error('Physical forecast is outside its admitted scope.');
        reserved.push(
          admission.forPath(target).reserve(
            {
              stagingBytes: 0n,
              extractionBytes: 0n,
              derivativeBytes: 0n,
              publicationBytes: BigInt(file.publicationBytes),
            },
            'ordinary'
          )
        );
      }
      for (const reservation of reserved) {
        entry.capacity.push(reservation);
        host.capacity.add(reservation);
      }
    } catch (error) {
      for (const reservation of reserved) reservation.release();
      decision =
        error instanceof ControlStoreWorkerError && error.code === 'precondition'
          ? 'precondition'
          : error instanceof FileAdmissionError
            ? 'no-space'
            : 'unavailable';
    }
    try {
      host.worker!.postMessage(
        ControlPhysicalForecastDecisionSchema.parse({
          version: CONTROL_WORKER_VERSION,
          id: forecast.id,
          database: forecast.database,
          operation: 'physical-forecast',
          decision,
        })
      );
    } catch {
      this.fail(host);
    }
  }

  private postPolicyFrame(host: WriterHost, frame: ControlPolicyBridgeMessage): void {
    if (host.failed || !host.worker) throw new ControlStoreWorkerError('unavailable', 'unknown');
    const call = this.findPolicyCall(frame.id);
    if (!call || !('operation' in frame))
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    const core = !('openingRequestId' in frame);
    if (
      host !== (core ? call.core.host : call.borrower.host) ||
      frame.database !== (core ? call.core.command.database : call.borrower.command.database) ||
      ('openingRequestId' in frame && frame.openingRequestId !== call.borrower.openingRequestId)
    )
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    if (frame.operation === 'runtime-policy-return') {
      if (
        !call.resource?.active ||
        !call.grant ||
        !isDeepStrictEqual(frame.binding, call.grant.binding) ||
        (core && call.phase !== 'return' && !call.borrower.host.terminated) ||
        (!core && (!('decision' in frame) || frame.decision !== 'ack' || !call.returnAcknowledged))
      )
        throw new ControlStoreWorkerError('precondition', 'not-committed');
    } else if (
      core &&
      (!call.resource?.active ||
        call.phase !== 'borrow' ||
        !('borrower' in frame) ||
        !isDeepStrictEqual(frame.borrower, this.policyBorrower(call)) ||
        frame.coreIdentity !== call.core.identity)
    )
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    else if (
      !core &&
      'grant' in frame &&
      (!call.resource?.active ||
        call.phase !== 'granted' ||
        !isDeepStrictEqual(frame.grant, call.grant))
    )
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    const budget = call.resource
      ? core
        ? call.resource.remainingBytes
        : call.resource.workspaceBytes
      : (this.pending.get(call.id)?.inputBytes ?? 0);
    const parsed = ControlPolicyBridgeMessageSchema.parse(frame);
    if (Buffer.byteLength(JSON.stringify(parsed)) + 64 > budget)
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    host.worker.postMessage(parsed);
  }

  /** Physical custody starts at the original admitted id, before any native RO attempt. */
  private retainPolicyCall(call: PolicyCall): void {
    const base: { version: typeof CONTROL_WORKER_VERSION; id: number } = {
      version: CONTROL_WORKER_VERSION,
      id: call.id,
    };
    const coreIdentity = call.core.identity;
    if (coreIdentity === undefined)
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    const resource = this.retainPolicyRead(
      call.core,
      call.borrower,
      this.policyFrameBudget(call, coreIdentity),
      async () => {
        if (call.phase === 'new' || call.phase === 'refused') return; // No CoreBorrow posted/issued.
        if (!call.grant) throw new ControlStoreWorkerError('unavailable', 'unknown');
        if (call.returnPosted) throw new ControlStoreWorkerError('unavailable', 'unknown');
        call.returnPosted = true;
        this.postPolicyFrame(call.core.host, {
          ...base,
          operation: 'runtime-policy-return',
          database: call.core.command.database,
          binding: call.grant.binding,
        });
        await call.returned.promise;
      }
    );
    resource.call = call;
    call.resource = resource;
  }

  private policyBorrower(call: PolicyCall): ControlPolicyGrant['binding']['borrower'] {
    const scope = call.borrower.command.productOwner;
    const openingRequestId = call.borrower.openingRequestId;
    const host = this.hosts.indexOf(call.borrower.host);
    if (scope?.kind !== 'workspace' || openingRequestId === undefined || host <= 0)
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    return {
      host,
      openingRequestId,
      database: call.borrower.command.database,
      requestId: call.id,
      workspaceId: scope.workspaceId,
    };
  }

  private findPolicyCall(id: number): PolicyCall | undefined {
    const pending = this.pending.get(id)?.policyCall;
    if (pending) return pending;
    for (const opening of this.openings.values())
      for (const resource of opening.policyReads)
        if (resource.call?.id === id) return resource.call;
    return undefined;
  }

  /** Dominating frozen frame forms bound both destinations and the retained native grant. */
  private policyFrameBudget(
    call: PolicyCall,
    coreIdentity: string
  ): { core: number; workspace: number } {
    const uuid = '00000000-0000-4000-8000-000000000000';
    const binding = {
      coreDatabase: call.core.command.database,
      coreIdentity,
      openingId: uuid,
      publisherId: uuid,
      transitionId: uuid,
      borrower: this.policyBorrower(call),
    };
    const grant = {
      binding,
      policy: {
        serverRevision: `sha256:${'0'.repeat(64)}`,
        workspaceRevision: `sha256:${'0'.repeat(64)}`,
      },
    };
    const base = { version: CONTROL_WORKER_VERSION, id: call.id };
    const workspace = {
      ...base,
      database: binding.borrower.database,
      openingRequestId: binding.borrower.openingRequestId,
    };
    const size = (frame: unknown) => Buffer.byteLength(JSON.stringify(frame)) + 64;
    // CoreReturn dominates CoreBorrow; granted replies dominate return ACKs.
    // Workspace granted continuation/ReturnNeeded dominate ACK/Needed respectively.
    // Fund raw/validated/outgoing copies plus the separately retained issued Grant.
    return {
      core:
        3 *
          Math.max(
            size({
              ...base,
              operation: 'runtime-policy-return',
              database: binding.coreDatabase,
              binding,
            }),
            size({ ...base, status: 'runtime-policy-borrow-granted', grant })
          ) +
        size(grant),
      workspace:
        3 *
        Math.max(
          size({ ...workspace, operation: 'runtime-policy-borrow', decision: 'granted', grant }),
          size({ ...workspace, status: 'runtime-policy-return-needed', binding })
        ),
    };
  }

  /** No generic request()/Pending for any bridge phase: correlation is the original slot. */
  private async receivePolicyFrame(value: unknown, host: WriterHost): Promise<void> {
    const frame = ControlPolicyBridgeMessageSchema.parse(value);
    const call = this.findPolicyCall(frame.id);
    if (!call) {
      if (
        'status' in frame &&
        (frame.status === 'runtime-policy-returned' ||
          frame.status === 'runtime-policy-return-refused')
      )
        return;
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    }
    const base: { version: typeof CONTROL_WORKER_VERSION; id: number } = {
      version: CONTROL_WORKER_VERSION,
      id: call.id,
    };
    const borrower = this.policyBorrower(call);
    const workspace = {
      ...base,
      database: borrower.database,
      openingRequestId: borrower.openingRequestId,
    };
    if ('status' in frame && frame.status === 'runtime-policy-borrow-needed') {
      if (
        host !== call.borrower.host ||
        call.phase !== 'new' ||
        frame.database !== workspace.database ||
        frame.openingRequestId !== workspace.openingRequestId ||
        frame.coreIdentity !== call.core.identity
      )
        throw new ControlStoreWorkerError('precondition', 'not-committed');
      const resource = call.resource;
      if (!resource?.active) throw new ControlStoreWorkerError('precondition', 'not-committed');
      if (call.core.retirement) {
        call.phase = 'refused'; // Physical retirement excludes late grant, not reader cleanup.
        this.postPolicyFrame(host, {
          ...workspace,
          operation: 'runtime-policy-borrow',
          decision: 'refused',
          code: 'precondition',
          commit: 'not-committed',
        });
        return;
      }
      try {
        call.phase = 'borrow';
        this.postPolicyFrame(call.core.host, {
          ...base,
          operation: 'runtime-policy-borrow',
          database: call.core.command.database,
          coreIdentity: frame.coreIdentity,
          borrower,
        });
        const grant = await call.borrowed.promise;
        if (!this.pending.has(call.id) || call.borrower.host.failed) {
          await this.abandonPolicyRead(resource);
          return;
        }
        call.phase = 'granted';
        this.postPolicyFrame(host, {
          ...workspace,
          operation: 'runtime-policy-borrow',
          decision: 'granted',
          grant,
        });
      } catch (error) {
        if (call.resource?.active && (call.phase as PolicyCall['phase']) !== 'refused') {
          this.fail(call.core.host);
          this.fail(host);
        } else if (!host.failed)
          this.postPolicyFrame(host, {
            ...workspace,
            operation: 'runtime-policy-borrow',
            decision: 'refused',
            code: error instanceof ControlStoreWorkerError ? error.code : 'precondition',
            commit: 'not-committed',
          });
      }
      return;
    }
    if ('status' in frame && frame.status === 'runtime-policy-return-needed') {
      if (
        host !== call.borrower.host ||
        !call.grant ||
        !call.resource ||
        frame.database !== workspace.database ||
        frame.openingRequestId !== workspace.openingRequestId ||
        !isDeepStrictEqual(frame.binding, call.grant.binding)
      )
        throw new ControlStoreWorkerError('precondition', 'not-committed');
      if (call.phase === 'return' || call.phase === 'done') return; // Same cached close; no extra wire clone.
      if (call.phase !== 'granted')
        throw new ControlStoreWorkerError('precondition', 'not-committed');
      call.phase = 'return';
      try {
        await call.resource.returnAfterTermination();
        call.phase = 'done';
        this.postPolicyFrame(host, {
          ...workspace,
          operation: 'runtime-policy-return',
          binding: call.grant.binding,
          decision: 'ack',
          outcome: 'returned',
        });
      } catch {
        this.fail(host);
      }
      return;
    }
    if (host !== call.core.host || !('status' in frame))
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    if (frame.status === 'runtime-policy-borrow-granted') {
      const binding = frame.grant.binding;
      if (
        call.phase !== 'borrow' ||
        binding.coreDatabase !== call.core.command.database ||
        binding.coreIdentity !== call.core.identity ||
        !isDeepStrictEqual(binding.borrower, borrower)
      )
        throw new ControlStoreWorkerError('precondition', 'not-committed');
      call.grant = structuredClone(frame.grant);
      call.borrowed.resolve(call.grant);
    } else if (frame.status === 'runtime-policy-borrow-refused') {
      if (call.phase !== 'borrow')
        throw new ControlStoreWorkerError('precondition', 'not-committed');
      call.phase = 'refused';
      call.borrowed.reject(new ControlStoreWorkerError(frame.code, frame.commit));
    } else if (
      frame.status === 'runtime-policy-returned' ||
      frame.status === 'runtime-policy-return-refused'
    ) {
      if (call.phase === 'done') return;
      if (
        !call.returnPosted ||
        !call.grant ||
        !isDeepStrictEqual(frame.binding, call.grant.binding)
      )
        throw new ControlStoreWorkerError('precondition', 'not-committed');
      if (frame.status === 'runtime-policy-returned') {
        call.returnAcknowledged = true;
        call.returned.resolve();
      } else call.returned.reject(new ControlStoreWorkerError(frame.code, frame.commit));
    } else throw new ControlStoreWorkerError('precondition', 'not-committed');
  }

  /** Rejects unknown/miscorrelated wire meanings without falsely reporting rollback. */
  private receive(value: unknown, host: WriterHost): void {
    if (
      value &&
      typeof value === 'object' &&
      'status' in value &&
      typeof value.status === 'string' &&
      value.status.startsWith('runtime-policy-')
    ) {
      void this.receivePolicyFrame(value, host).catch(() => this.fail(host));
      return;
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      'status' in value &&
      value.status === 'physical-forecast'
    ) {
      void this.receivePhysicalForecast(value, host);
      return;
    }
    if (!isControlWorkerReply(value)) {
      this.fail(host);
      return;
    }
    const entry = this.pending.get(value.id);
    if (
      entry === undefined ||
      entry.host !== host ||
      !entry.posted ||
      (value.status === 'ok' && value.operation !== entry.command.operation) ||
      (value.status === 'error' &&
        value.domain !== undefined &&
        value.domain.operation !== entry.command.operation)
    ) {
      this.fail(host);
      return;
    }
    if (
      value.status === 'error' &&
      entry.policyCall?.resource &&
      entry.policyCall.phase !== 'done' &&
      entry.policyCall.phase !== 'refused' &&
      (entry.policyCall.phase !== 'new' || value.commit === 'unknown')
    )
      this.fail(host);
    // Main owns these disclosure inputs. A new report refused before physical admission
    // must not escape under a Policy that changed during released native computation.
    if (
      value.status === 'error' &&
      entry.command.operation === 'schema-application' &&
      value.commit === 'not-committed' &&
      !entry.physicalForecasted &&
      value.domain?.operation === 'schema-application' &&
      'details' in value.domain &&
      value.domain.details !== undefined &&
      'actualReport' in value.domain.details &&
      !this.schemaApplicationFactsCurrent(entry)
    ) {
      this.complete(
        value.id,
        undefined,
        new ControlStoreWorkerError('precondition', 'not-committed')
      );
      return;
    }
    if (value.status === 'error')
      this.complete(
        value.id,
        undefined,
        (entry.command.operation === 'products' || entry.command.operation === 'transition') &&
          value.commit === 'not-committed' &&
          value.domain &&
          value.domain.operation !== 'resolved-agent-setup' &&
          ['request_executing', 'thread_busy', 'conflict'].includes(value.domain.code)
          ? new PendingRequestCommandError(
              value.domain.code,
              value.domain.message,
              value.domain.status
            )
          : new ControlStoreWorkerError(value.code, value.commit, value.domain)
      );
    else this.complete(value.id, value);
    // Native outer-commit uncertainty/integrity poison cannot leave dependent borrowers
    // able to overlap a successor Core opening. Preserve the original reply above first.
    if (
      value.status === 'error' &&
      (value.commit === 'unknown' || value.code === 'integrity') &&
      'database' in entry.command &&
      this.openings.get(entry.command.database)?.command.initialize === 'core' &&
      (this.openings.get(entry.command.database)?.policyReads.size ?? 0) > 0
    )
      this.fail(host);
  }

  /** No reply, worker loss or protocol failure proves that a posted write did not commit. */
  private fail(host: WriterHost): void {
    if (host.failed) return;
    host.failed = true;
    if (!host.worker) {
      host.terminated = true;
      host.exited.resolve();
    }
    for (const opening of this.openings.values())
      for (const resource of opening.policyReads) {
        if (resource.core.host === host || resource.borrower.host === host) {
          resource.call?.borrowed.reject(new ControlStoreWorkerError('unavailable', 'unknown'));
          if (resource.core.host === host || resource.call?.returnPosted)
            resource.call?.returned.reject(new ControlStoreWorkerError('unavailable', 'unknown'));
          if (
            resource.call?.returnPosted &&
            !resource.call.returnAcknowledged &&
            resource.core.host !== host
          )
            this.fail(resource.core.host); // Never repost a valid return whose ACK was lost.
        }
        // A failed Core cannot leave a live dependent able to overlap a successor opening.
        if (resource.core.host === host) {
          this.fail(resource.borrower.host);
          void Promise.all([host.exited.promise, resource.borrower.host.exited.promise]).then(() =>
            this.releasePolicyRead(resource)
          );
        }
        if (resource.borrower.host === host) {
          void host.exited.promise.then(resource.returnAfterExit).catch(() => {
            // No transport failure is promoted to an ACK; cleanup is exit-owned.
          });
        }
      }
    for (const [id, entry] of this.pending) {
      if (entry.host !== host) continue;
      const posted = entry.posted;
      this.complete(
        id,
        undefined,
        new ControlStoreWorkerError('unavailable', posted ? 'unknown' : 'not-committed'),
        !posted
      );
    }
    // A failed channel must not retain a writable connection or continue queued work.
    void host.worker?.terminate();
  }
}
