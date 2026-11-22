import type {
  ServerEvidenceBundleRecord,
  WorkspaceBlocker,
  WorkspaceReconciliationRecord,
} from '@openkit/app-api-schemas';
import type Database from 'better-sqlite3';
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
import { type DataRootLock, retainDataRootLock } from '../bootstrap/lock.js';
import { assertScopeAdmitted } from '../bootstrap/readiness.js';
import type { DiscordChannelOwners } from '../channel-services.js';
import { BootConfigError } from '../config/mode.js';
import { ItemDeltaProtocolError } from '../lib/item-delta-validation.js';
import { AttentionError } from '../notifications/attention-error.js';
import type { ControlGoalCommandResult, ControlGoalInput } from '../runtime/goal-codecs.js';
import { GoalCommandError } from '../runtime/goal-error.js';
import { WorkspaceCollectionError } from '../runtime/workspace-collect-wire.js';
import {
  PreservedWorkspaceCaptureRefusal,
  WorkspaceCaptureRecoveryRequired,
} from '../runtime/workspace-snapshot-chain.js';
import type {
  ControlAutomationScanner,
  ControlAutomationScannerResult,
} from './automation-scanner-codecs.js';
import type { CommunicationAttentionOwner } from './communication-attention.js';
import type {
  CommunicationDiscordWrites,
  PairingAuthorityObservation,
  WithPairingAuthority,
} from './communication-discord.js';
import { communicationOwner } from './communication-owner.js';
import type {
  CommunicationWriterCommand,
  CommunicationWriterReply,
} from './communication-writer.js';
import type { ControlKernelStore } from './control-kernel-port.js';
import {
  CoreSchedulerRefusalSchema,
  CoreSchedulerResultSchema,
} from './control-store-admission-codecs.js';
import { ControlStoreWorkerError } from './control-store-worker-error.js';
import { coreDbPath, readDataRootLayoutMarker } from './fs-layout.js';
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
  type ControlSecurityTrigger,
  type ControlSecurityTriggerResult,
  ControlSecurityTriggerSchema,
  SecurityTriggerRefusal,
} from './security-trigger-codecs.js';
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
import { lstatSync, realpathSync, type Stats, statSync } from 'node:fs';
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
import type { NanoHostAdministratorEnroll } from '../auth/nanohost-operations.js';
import {
  type ControlNanoHostTransportInput,
  ControlNanoHostTransportInputSchema,
  type ControlNanoHostTransportResult,
  isNanoHostTransportAdminRefusal,
  NANOHOST_TRANSPORT_ADMIN_REFUSAL,
  nanoHostTransportAdminFacts,
} from '../auth/nanohost-transport-codecs.js';
import type {
  listNanoHostTransportTokenRecords,
  NanoHostTransportTokenRecord,
} from '../auth/nanohost-transport-token-store.js';
import { KernelCommandError } from '../generative-kernel/errors.js';
import {
  type ControlAppInput,
  ControlAppInputSchema,
  type ControlAppResult,
  type ControlAppWire,
} from '../generative-kernel/native-command-codecs.js';
import type { ControlGenerativePresentation } from '../generative-ui/native-publication-codecs.js';

import { NotebookError } from '../knowledge/notebook.js';
import { StoreRecordNotFoundError } from '../lib/store-errors.js';
import {
  IdempotencyKeyConflictError,
  OperationError,
  restoreControlCapabilityFailure,
} from '../operation-error.js';
import {
  requireSchedulerExecutionAttempt,
  type SchedulerExecutionAttemptRecord,
} from '../runtime/execution-attempt-records.js';
import {
  type ControlExecutionJournalInput,
  createExecutionStepJournalReader,
  decodeExecutionJournalIntent,
  readExecutionJournalInvocation,
  readKernelSchedulerGrantInDb,
} from '../runtime/execution-journal.js';
import type { ExecutionStepKind } from '../runtime/execution-step-journal.js';
import type { IdempotentCommandReceipt } from '../runtime/idempotent-command.js';
import type { AdmittedNanoHostAttemptRecovery } from '../runtime/nanohost-attempt-recovery.js';
import type { AdmittedNanoHostHarnessTurnLifecycle } from '../runtime/nanohost-harness.js';
import type { hasQueuedNanoHostHarnessOperation } from '../runtime/nanohost-harness-records.js';
import {
  getNanoHostRuntimeTarget,
  type NanoHostRuntimeTargetRecord,
} from '../runtime/nanohost-runtime-target-records.js';
import { PendingRequestCommandError } from '../runtime/pending-request-error.js';
import type { ControlPendingCommandResult } from '../runtime/pending-requests.js';
import type {
  ProjectWorkerBackendCleanupInput,
  WorkerBackendCleanupProjectionResult,
} from '../runtime/worker-backend-cleanup-projection.js';
import type { getWorkerBackendSession } from '../runtime/worker-backend-session-records.js';
import type { ControlWorkerRejectedEvidence } from '../runtime/worker-control-rejected-evidence-codecs.js';
import { WorkerImageSettlementConflict } from '../runtime/worker-image-settlements-records.js';
import {
  type WorkerStorageBinding,
  WorkerStorageBindingError,
} from '../runtime/worker-storage-binding-records.js';
import type { WriteNanoHostStorageAttachment } from '../runtime/worker-storage-bindings.js';
import {
  type ControlMaterialCommandInput,
  type ControlMaterialCommandResult,
  prepareControlMaterialTransfer,
} from '../workspace-materials.js';
import { getWorkspaceInvitation } from '../workspace-sharing.js';
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
import type { WorkInputRef } from './control-kernel-port.js';
import { CONTROL_STORE_BUDGET, type ControlCheckpoint } from './control-store.js';
import type {
  CommandReceipt,
  ControlAdmission,
  ControlAdmissionInput,
  ControlAdmissionResult,
  ControlCommandReceiptAdmission,
  ControlKnowledgeAdmissionResult,
} from './control-store-admission-codecs.js';
import {
  CommandReceiptSchema,
  type CoreSchedulerResult,
  PairingAuditIntentSchema,
  SchedulerAdmissionTransitionError,
} from './control-store-admission-codecs.js';
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
  type CommunicationKernelInput,
  type CommunicationKernelReply,
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
  ControlWorkspaceQueueInputWireSchema,
  controlMaterialTransferSize,
  controlWorkerInputBytes,
  controlWorkObservationTransferSize,
  hashNanoHostRecoveryObservation,
  isControlProductCohort,
  isControlWorkerReply,
  isControlWorkerRequest,
  type NanoHostLocalBackendSessionInput,
  type NanoHostLocalWorkerImageInput,
  type NanoHostLocalWorkerStorageInput,
  type NanoHostOwnerMutation,
  type NanoHostOwnerMutationResult,
  type ServerOwnerDescriptor,
  type ServerWorkKernelInput,
  type ServerWorkOwnerMutation,
  type ServerWorkOwnerMutationResult,
} from './control-store-worker-protocol.js';
import {
  type ControlCoreImageResult,
  type ControlCoreJournalInput,
  type ControlNanoHostFirstSubmissionInput,
  ControlNanoHostFirstSubmissionInputSchema,
  type ControlNanoHostFirstSubmissionResult,
  type ControlNanoHostTerminalReleaseInput,
  ControlNanoHostTerminalReleaseInputSchema,
  readCoreJournalLineage,
} from './core-journal-codecs.js';
import type {
  inspectCoreNanoHostTerminalRelease,
  nanoHostTerminalReleaseWorkspaceStep,
} from './core-journal-native.js';
import {
  type CoreDb,
  inspectServerOwnerFile,
  openAdmittedWorkspaceReadDb,
  openCoreReadDb,
  openServerOwnerReadConnection,
  openUserReadDb,
  serverStoragePath,
  type UserDb,
  type WorkspaceDb,
} from './db.js';
import type { ControlEvaluationCandidate } from './evaluation-candidate-codecs.js';
import {
  type ControlExecutionAttemptCommand,
  type ControlExecutionAttemptResult,
  ExecutionAttemptRefusal,
} from './execution-attempt-codecs.js';
import { DEFAULT_FILE_RESERVE_BYTES } from './file-reserve.js';
import { ensureUserLayout, resolveDataRootPath, userDbPath, workspaceDbPath } from './fs-layout.js';
import type {
  ControlHarnessLifecycleInput,
  ControlHarnessLifecycleResult,
} from './harness-lifecycle-codecs.js';
import { hasPendingUserMigrations, ServerOwnerAdmissionError } from './migrate.js';
import {
  type NanoHostEpochPlacement,
  type NanoHostRuntimeTargetEpochKernel,
  type NanoHostRuntimeTargetEpochStore,
  transitionNanoHostRuntimeTarget,
} from './nanohost-epoch-invalidation.js';
import type { NanoHostRuntimeTargetTransition } from './nanohost-epoch-invalidation-codecs.js';
import type {
  inspectNanoHostRuntimeTargetTransition,
  prepareNanoHostRuntimeTargetTransition,
  readNanoHostEpochInvalidation,
  readPendingNanoHostEpochRetirement,
} from './nanohost-epoch-invalidation-native.js';
import type {
  NanoHostEpochKernelInput,
  NanoHostEpochKernelReply,
} from './nanohost-epoch-kernel-codecs.js';
import type { NanoHostStore } from './nanohost-port.js';
import {
  type NanoHostRecoveryMutation,
  readNanoHostRecoveryLease,
} from './nanohost-recovery-native.js';
import { nanoHostStoreDescriptor } from './nanohost-store-descriptor.js';
import type { ControlRemoteMcpAudit } from './remote-mcp-audit-codecs.js';
import type { RepairWorkerInput, RepairWorkerReply } from './repair-kernel-codecs.js';
import type {
  ControlRuntimeTargetInput,
  ControlRuntimeTargetResult,
} from './runtime-target-codecs.js';
import type { ControlServerAdminTokenDefault } from './server-admin-token-default-codecs.js';
import type { readServerCallUsageIds } from './server-work-call.js';
import type { ServerWorkCommandBinding } from './server-work-command.js';
import type {
  inspectServerWorkContainmentEvidence,
  publishContainmentEvidenceHandoff,
} from './server-work-evidence.js';
import type {
  isServerWorkPublished,
  readServerWorkIntent,
  readServerWorkLocalReceipt,
  readStagedServerWork,
  StagedServerWork,
} from './server-work-intents.js';
import type { ServerWorkIntent, ServerWorkReceipt } from './server-work-port.js';
import { serverWorkStorageDescriptor } from './server-work-schema.js';
import type {
  StorageDecision,
  StorageOwner,
  StorageReceiptLookup,
  StorageResult,
  StorageStatus,
  StorageUnavailable,
} from './storage-owner.js';
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
import type {
  ControlWorkerFinalStatusCommand,
  ControlWorkerFinalStatusResult,
} from './worker-control-final-status-codecs.js';
import type {
  ControlWorkerHeartbeatCommand,
  ControlWorkerHeartbeatResult,
} from './worker-control-heartbeat-codecs.js';
import type {
  ControlWorkerRecordCommand,
  ControlWorkerRecordResult,
} from './worker-control-record-codecs.js';
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
type WorkerControlFinalStage = NonNullable<
  Extract<ControlWorkerCommand, { operation: 'worker-control-final-status' }>['nanoHostFinal']
>;
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
const captureReadCall = Symbol('capture-read-call');
/** One existing capture's funded App OPEN; never serialized or inherited by business frames. */
interface ControlCaptureReadCall {
  readonly kind: 'capture-read';
  readonly [captureReadCall]: true;
  readonly capture: CaptureReadGeneration;
  readonly hold: PostingHold;
  readonly released: Promise<void>;
  readonly command: Omit<OpenCommand, 'operation'>;
  readonly path: string;
  readonly identity: string;
}
type ControlFrozenNativeCall =
  | ControlCaptureReadCall
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
  readonly capacity: Set<NativeCapacityReservation | WorkspaceMutationLease>;
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

/** Resolves the first submitted Core grant before reading its recovery evidence in NanoHost. */
export function readAdmittedNanoHostAttempt(
  core: CoreDb,
  sqlite: Database.Database,
  attempt: SchedulerExecutionAttemptRecord
) {
  const { attemptId, agentSessionId, inputRef, bindingRef, operationId } = attempt;
  if (!operationId || !agentSessionId || !inputRef || !bindingRef || !attempt.deadline)
    throw new ServerOwnerAdmissionError('recovery-required');
  const grant = readKernelSchedulerGrantInDb(
    core,
    { owner: { kind: 'server' }, executionId: attemptId },
    operationId
  );
  if (!grant?.deadline || grant.backendId !== 'nanohost')
    throw new ServerOwnerAdmissionError('recovery-required');
  const lease = { grant, attempt: { ...attempt, agentSessionId, inputRef, bindingRef } };
  return { lease, ...readNanoHostRecoveryLease(sqlite, lease) };
}

/** Projects only the six acknowledged Workspace occurrences needed by the Core release owner. */
async function prepareNanoHostReleaseWorkspace(
  db: WorkspaceDb,
  attempt: SchedulerExecutionAttemptRecord,
  projectStep: typeof nanoHostTerminalReleaseWorkspaceStep
): Promise<Pick<ControlNanoHostTerminalReleaseInput, 'workspaceExecutionId' | 'workspaceSteps'>> {
  const executions = db.sqlite
    .prepare('SELECT id FROM control_executions WHERE work_id=? LIMIT 2')
    .all(attempt.turnId) as { id: string }[];
  if (executions.length !== 1)
    throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
  const owner = { kind: 'workspace' as const, workspaceId: attempt.workspaceId };
  const ref = { owner, executionId: executions[0]!.id };
  const reader = createExecutionStepJournalReader(db, owner);
  const ended = await reader.readEndedSteps(ref);
  const completed = await Promise.all(
    ended
      .filter((step) => step.state === 'completed' && step.control.attemptId === attempt.attemptId)
      .map(async (step) => ({ step, carriage: (await reader.readInvocation(step.ref)).carriage }))
  );
  const proof = (kind: ExecutionStepKind, operation: string) => {
    const matches = completed.filter(
      ({ step, carriage }) => step.control.kind === kind && carriage.operation === operation
    );
    if (matches.length !== 1)
      throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
    return projectStep(matches[0]!.step, matches[0]!.carriage);
  };
  return {
    workspaceExecutionId: ref.executionId,
    workspaceSteps: {
      terminal: proof('terminal-publication', 'worker.terminal-publication'),
      output: proof('collect', 'worker.collect.publication'),
      evidence: proof('collect', 'worker.collect.transcript'),
      collection: proof('collect', 'worker.collect.capture'),
      consume: proof('consume-receipt', 'turn.start'),
      release: proof('release', 'worker.release'),
    },
  };
}

/** NanoHost composition supplies the landed readers over the admitted query-only connection. */
interface NanoHostOwnerReaders {
  readonly terminalRelease?: {
    readonly inspect: typeof inspectCoreNanoHostTerminalRelease;
    readonly projectStep: typeof nanoHostTerminalReleaseWorkspaceStep;
  };
  readonly isEnrollmentAdministrator?: (
    coreDb: CoreDb,
    actor: ReturnType<typeof nanoHostTransportAdminFacts>,
    now?: Date
  ) => boolean;
  readonly listNanoHostTransportTokenRecords: typeof listNanoHostTransportTokenRecords;
  readonly prepareNanoHostRuntimeTargetTransition: typeof prepareNanoHostRuntimeTargetTransition;
  readonly readNanoHostEpochInvalidation: typeof readNanoHostEpochInvalidation;
  readonly inspectNanoHostRuntimeTargetTransition: typeof inspectNanoHostRuntimeTargetTransition;
  readonly getWorkerBackendSession: typeof getWorkerBackendSession;
  readonly hasQueuedNanoHostHarnessOperation?: typeof hasQueuedNanoHostHarnessOperation;
  readonly readPendingNanoHostEpochRetirement: typeof readPendingNanoHostEpochRetirement;
}

/** Serving composition supplies current proofs from the deciding owners immediately before posting. */
interface NanoHostServingGate {
  enabled(): boolean;
  verifyImagePublication?(input: NanoHostLocalWorkerImageInput): boolean;
  verifyWorkspaceHandoff?(session: ControlBackendSessionResult): boolean;
  verifyStorageBinding?(input: NanoHostLocalWorkerStorageInput): boolean;
}

/** Private local methods for composition after owner and Core authority admission. */
export interface NanoHostOwnerBinding
  extends Pick<
    NanoHostStore,
    'stageEpochInvalidation' | 'readEpochInvalidation' | 'settleEpochInvalidation'
  > {
  transport(input: ControlNanoHostTransportInput): Promise<ControlNanoHostTransportResult>;
  enrollTransport: NanoHostAdministratorEnroll;
  readRuntimeTarget(
    targetId: string
  ): StorageResult<'nanohost', NanoHostRuntimeTargetRecord | null>;
  firstSubmission(
    input: Pick<ControlNanoHostFirstSubmissionInput, 'attemptId' | 'observedAt'>
  ): Promise<ControlNanoHostFirstSubmissionResult>;
  harnessLifecycle(
    input: Extract<NanoHostOwnerMutation, { kind: 'harness-lifecycle' }>['input']
  ): Promise<void>;
  readonly harnessTurnLifecycle: AdmittedNanoHostHarnessTurnLifecycle;
  writeIdleHarnessDrain(
    input: Extract<
      ControlHarnessLifecycleInput,
      { kind: 'sandbox.claim-idle-drain' | 'sandbox.restore-admission' }
    >
  ): Promise<void>;
  releaseTerminalScopes(attemptId: string, fenceRef: string): Promise<void>;
  /** Joins the current serving acknowledgement before ordinary Worker control admission. */
  waitForWorkerControlAcknowledgement(): Promise<void>;
  workerControlHeartbeat(
    input: ControlWorkerHeartbeatCommand
  ): Promise<ControlWorkerHeartbeatResult>;
  workerControlRecord(input: ControlWorkerRecordCommand): Promise<ControlWorkerRecordResult>;
  workerControlFinalStatus(
    input: ControlWorkerFinalStatusCommand
  ): Promise<ControlWorkerFinalStatusResult>;
  workerImage(input: NanoHostLocalWorkerImageInput): Promise<void>;
  settlePreparedImage(
    input: Extract<NanoHostOwnerMutation, { kind: 'prepared-image-result' }>['input']
  ): Promise<void>;
  backendSession(input: NanoHostLocalBackendSessionInput): Promise<ControlBackendSessionResult>;
  closeRecovery: AdmittedNanoHostAttemptRecovery['close'];
  classifyRecovery(
    input: NanoHostRecoveryMutation & {
      readonly kind: Exclude<NanoHostRecoveryMutation['kind'], 'retire-orphan'>;
    }
  ): ReturnType<AdmittedNanoHostAttemptRecovery['commit']>;

  workerStorageBinding(input: NanoHostLocalWorkerStorageInput): Promise<WorkerStorageBinding>;
  readonly writeStorageAttachment: WriteNanoHostStorageAttachment;
  prepareRuntimeTarget(
    input: ControlRuntimeTargetInput,
    occurrenceId: string
  ): Promise<StorageResult<'nanohost', NanoHostRuntimeTargetTransition>>;
  transitionRuntimeTarget(
    kernel: NanoHostRuntimeTargetEpochKernel,
    original: NanoHostRuntimeTargetTransition
  ): Promise<StorageResult<'nanohost' | 'control-kernel', ControlRuntimeTargetResult>>;
  /** Runs a synchronous projection on the captured query-only generation. */
  read<Value>(query: (sqlite: Database.Database) => Value): StorageResult<'nanohost', Value>;
  /** Waits for a serving acknowledgement without reading an unsettled outcome. */
  readWorkerCompletion<Value>(
    query: (sqlite: Database.Database) => Value
  ): StorageResult<'nanohost', Value> | { readonly state: 'pending' };
  beginEpochRetirement(placement: NanoHostEpochPlacement): Promise<StorageResult<'nanohost', void>>;
  readPendingEpochRetirement(): Promise<StorageResult<'nanohost', NanoHostEpochPlacement | null>>;
  listTransportTokens(): Promise<StorageResult<'nanohost', NanoHostTransportTokenRecord[]>>;
}

/** Server work composition supplies retained owner reads and its closed activation predicate. */
interface ServerWorkOwnerReaders {
  readonly inspectServerWorkContainmentEvidence: typeof inspectServerWorkContainmentEvidence;
  readonly publishContainmentEvidenceHandoff: typeof publishContainmentEvidenceHandoff;
  readonly readServerWorkIntent: typeof readServerWorkIntent;
  readonly readServerWorkLocalReceipt: typeof readServerWorkLocalReceipt;
  readonly readServerCallUsageIds: typeof readServerCallUsageIds;
  readonly readStagedServerWork: typeof readStagedServerWork;
  readonly isServerWorkPublished: typeof isServerWorkPublished;
}

type RepairReplyValues = {
  [Kind in RepairWorkerReply['kind']]: Extract<RepairWorkerReply, { kind: Kind }>['value'];
};

export type ServerWorkKernel = Pick<
  ControlKernelStore,
  'status' | 'decideServerWork' | 'inspectServerWork'
>;

/** Exact retained Core reads supplied by the separately admitted kernel composition. */
interface ServerWorkCoreReaders {
  readonly inspectServerWork?: ControlKernelStore['inspectServerWork'];
  readonly readContainmentEvidenceHandoff?: (
    core: CoreDb,
    evidenceId: string
  ) => ServerEvidenceBundleRecord | null;
}

export type ServerWorkOwnerBinding = ServerWorkCommandBinding['owner'] & {
  readStaged(requestId: string): Promise<StorageResult<'server-work', StagedServerWork | null>>;
  publishContainment(evidenceId: string): ReturnType<typeof publishContainmentEvidenceHandoff>;
  withProducer<Value>(effect: () => Promise<Value>): Promise<StorageResult<'server-work', Value>>;
};

/** Projects owner-local failures through the existing storage admission outcomes. */
function serverOwnerUnavailable<Owner extends StorageOwner>(
  owner: Owner,
  error: unknown
): StorageUnavailable<Owner> {
  let reason: StorageUnavailable<Owner>['reason'] = 'recovery-required';
  if (error instanceof ServerOwnerAdmissionError) reason = error.reason;
  if (error instanceof ControlStoreWorkerError) {
    switch (error.code) {
      case 'owner-missing':
        reason = 'missing';
        break;
      case 'owner-unsupported':
        reason = 'unsupported';
        break;
      case 'integrity':
        reason = 'corrupt';
        break;
      case 'no-space':
        reason = 'full';
        break;
      case 'migration_missing':
      case 'migration_failed':
        reason = 'migration-failed';
        break;
    }
  }
  return { state: 'unavailable', owner, reason };
}

type CommunicationKernel = NonNullable<DiscordChannelOwners['kernel']> &
  Pick<ControlKernelStore, 'inspectPairingAudit' | 'relayPairingAudit'>;

type CommunicationResult<Value> = StorageResult<'communication', Value>;

type CommunicationKernelValues = {
  [Reply in CommunicationKernelReply as Reply['kind']]: Reply['value'];
};

interface CommunicationOwnerDependencies {
  readonly observeAuthority: (
    selection: Parameters<WithPairingAuthority>[0]
  ) => PairingAuthorityObservation;
  readonly createCommunicationDiscord: typeof import('./communication-discord.js').createCommunicationDiscord;
  readonly readPendingPairingAuditInDb: typeof import('./communication-pairing-native.js').readPendingPairingAuditInDb;
  readonly relayNextPairingAudit: typeof import('./communication-pairing-relay.js').relayNextPairingAudit;
  readonly CommunicationWriterCommandSchema: typeof import('./communication-writer.js').CommunicationWriterCommandSchema;
  readonly CommunicationWriterReplySchema: typeof import('./communication-writer.js').CommunicationWriterReplySchema;
}

export interface CommunicationOwnerBinding {
  readonly owners: DiscordChannelOwners;
  readonly withProducer: <Value>(
    effect: () => Promise<Value>
  ) => Promise<CommunicationResult<Value>>;
  readonly wakePairingAudit: () => void;
  readonly setExpiryAgeMs: (ageMs: number | undefined) => void;
}

const communicationHeld = {
  state: 'unavailable',
  owner: 'communication',
  reason: 'recovery-required',
} as const;

/** The file's canonical location and identity are checked against its acknowledged opening. */
function readPhysicalDatabaseIdentity(path: string) {
  const current = statSync(path);
  return { path: realpathSync(path), identity: `${current.dev}:${current.ino}`, file: current };
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
  /** A second NanoHost tuple cannot rely on a write whose FULL ACK is outstanding. */
  nanoHostWritePending?: true | 'core-owner-read' | 'target-stable-write';
  communicationRelayWake?: () => void;
  communicationBindingPending?: boolean;
  communicationReader?: Database.Database;
  nanoHostCoreHoldPending?: Promise<void>;
  nanoHostTargetTransition?: true;
  nanoHostReader?: Promise<Database.Database>;
  readNanoHost?: NanoHostOwnerBinding['read'];
  prepareNanoHostBackend?(
    input:
      | Extract<ControlBackendSessionInput, { kind: 'materializing' }>
      | NanoHostLocalBackendSessionInput
  ): Promise<ControlBackendSessionResult>;
  /** Request-local capture enrollment stays with this existing physical Workspace owner. */
  captureReads?: CaptureReadGeneration;
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

/** The existing capture's release ledger and phase rendezvous, not another scope registry. */
interface CaptureReadGeneration {
  readonly root: Opening;
  readonly workspaceId: string;
  readonly dataRoot: string;
  readonly acquired: Array<() => void>;
  readonly inFlightOpens: Map<string, Promise<void>>;
  active: boolean;
  postingHeld: boolean;
  enumerating: boolean;
  copyingPath: string | undefined;
  changed: ReturnType<typeof Promise.withResolvers<void>>;
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

/** A caller may stop an unposted publication and observe actual settlement after posting. */
export interface ControlStorePublicationGuard {
  readonly signal: AbortSignal;
  readonly deadline: number;
  postedSettlement?: Promise<void>;
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
  /** Deduplicates the async physical recheck within this same admitted capture-read slot. */
  captureReadChecking?: boolean;
  /** Binary input and echoed range content remain admitted until reply or known disposal. */
  readonly materialBytes: number;
  readonly inputBytes: number;
  readonly capacity: NativeCapacityReservation[];
  /** The accepted parent's real unit is handed to this child through ACK or backing disposal. */
  readonly workspaceLeases: readonly WorkspaceMutationLease[];
  /** A forecast is resolved once within this request's existing slot. */
  physicalForecasted?: boolean;
  readonly verifyNanoHostPost?: (mutation: NanoHostOwnerMutation) => boolean;
  /** Original owner capture; neither the supplier nor facts are sent back in a forecast decision. */
  readonly schemaApplicationFacts?: {
    readonly captured: ControlSchemaApplicationFacts;
    readonly capture: () => ControlSchemaApplicationFacts;
  };
  readonly closeout?: CapabilityCloseoutCredit | undefined;
  readonly policyCall?: PolicyCall;
  /** Main admission is rechecked for the Workspace named in the original framed create. */
  readonly schedulerWorkspaceId?: string;
  readonly progressCopy?: { readonly credit: ProgressCopyCredit; readonly bytes: number };
  readonly productPublication?: {
    readonly guard: ControlStorePublicationGuard;
    readonly receipt: PromiseWithResolvers<void>;
    readonly detach: () => void;
  };
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
      return !command.create && command.serverOwner === undefined;
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

// Physical host disposal never releases a logical Workspace exclusion.
const workspaceMutationOwners = new Map<string, WorkspaceMutationScope>();
let singleton: ControlStoreWorkerClient | undefined;

/**
 * Returns the process-local writer coordinator, without opening a database.
 *
 * A failed native host is never restarted by this getter. Explicit shutdown must finish before a later call can start a new host; no request is replayed. A released product scope must transfer its complete producer and shared receipt closure before using this host. A legacy main writable handle is not a table-level access-control boundary.
 *
 * @returns Shared coordinator for admitted database scopes, never a synchronous SQL facade.
 */
export function getControlStoreWorkerClient(): ControlStoreWorkerClient {
  if (!isMainThread) throw new ControlStoreWorkerError('unavailable', 'not-committed');
  if (singleton === undefined || singleton.isClosed) singleton = new ControlStoreWorkerClient();
  return singleton;
}

/** Synchronous primitives may borrow offline roots, but never bypass a live native App owner. */
export function assertExistingAppReadReady(
  dataRoot: string,
  workspaceId: string,
  appId: string
): void {
  if (isMainThread) singleton?.assertExistingAppReadReady(dataRoot, workspaceId, appId);
}

/** Stops the existing process-local host without creating one; callers must finish shutdown before removing its database roots. */
export async function shutdownControlStoreWorkerClient(): Promise<void> {
  if (singleton) await singleton.shutdown();
  else closeWorkspaceProductReadHandles();
}

/** Owns the worker lifetime, finite pre-post admission and asynchronous acknowledgements. */
/** Nonwaiting freeze result; the caller owns release only after successful admission. */
export type WorkspaceFreezeAdmission =
  | { readonly status: 'busy' }
  | { readonly status: 'blocked'; readonly blockers: readonly WorkspaceBlocker[] }
  | WorkspaceFrozenAdmission;

/** Exact process-local owner of one successful freeze; release invalidates its native bindings. */
export interface WorkspaceFrozenAdmission {
  readonly status: 'frozen';
  readonly release: () => void;
}

/** Exact retained target admission or source capture that caused this process-local boot exclusion. */
export type WorkspaceRecoveryFreezeOrigin =
  | {
      readonly admissionId: string;
      readonly revision: number;
      readonly candidateRef: string;
    }
  | { readonly captureId: string }
  | { readonly deletionRequestId: string; readonly revision: number };

/** Source recovery binds only canonical bytes; target recovery also binds its owned candidate. */
interface CaptureClosure {
  owner: WorkspaceFrozenAdmission | null;
  preparing?: true;
  origin?: WorkspaceRecoveryFreezeOrigin;
  recovery?:
    | { readonly canonical: object; readonly candidate?: object }
    | { readonly canonical?: object; readonly candidate: object };
}

/** Process-local mutation admission state for one Workspace. */
interface WorkspaceMutationGateState {
  admitted: number;
  closed: boolean;
  captureClosed: CaptureClosure | null;
  waiters: Set<() => void>;
}

/** Registered canonical publishers that can write after ordinary handler admission. */
export const WORKSPACE_MUTATION_LATE_PUBLISHERS = [
  'worker-turn-closeout',
  'mcp-workspace-data',
] as const;

/** Registered canonical publisher that must name late mutation admission. */
export type WorkspaceMutationLatePublisher = (typeof WORKSPACE_MUTATION_LATE_PUBLISHERS)[number];

/** A live lease on the existing gate, never a command/retry authorization or serialized marker. */
interface WorkspaceMutationLease {
  readonly owner: WorkspaceMutationScope;
  readonly workspaceId: string;
  readonly release: () => void;
}

/** Ordinary Workspace mutation and exclusive lifecycle gates of one logical scope. */
interface WorkspaceMutationScope {
  readonly gates: Map<string, WorkspaceMutationGateState>;
  readonly deletionTails: Map<string, Promise<void>>;
}

/** Both freeze entry paths preserve the original closed, typed inspection failure. */
function freezeBlockers(
  readBlockers: () => readonly WorkspaceBlocker[]
): readonly WorkspaceBlocker[] {
  try {
    return readBlockers();
  } catch {
    return [{ kind: 'unavailable', reason: 'unavailable', actions: [] }];
  }
}

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
  private readonly operations = new Map<
    Promise<unknown>,
    {
      publication: ControlPublicationIdentity | undefined;
      workspaceLeases: readonly WorkspaceMutationLease[];
    }
  >();
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
    workspaceLeases: readonly WorkspaceMutationLease[];
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
  private communicationProducerHold = false;
  private readonly communicationProducers = new Set<Promise<unknown>>();
  private readonly serverWorkProducers = new Set<Promise<unknown>>();
  private readonly communicationLease = new AsyncLocalStorage<{
    readonly database: string;
    readonly retention: boolean;
    active: boolean;
  }>();
  /** Returns the actual logical scope gates; physical host disposal never releases them. */
  private workspaceMutations(dataRoot: string): WorkspaceMutationScope {
    const root = resolve(dataRoot);
    let owner = workspaceMutationOwners.get(root);
    if (!owner) {
      owner = { gates: new Map(), deletionTails: new Map() };
      workspaceMutationOwners.set(root, owner);
    }
    return owner;
  }

  private workspaceGate(
    owner: WorkspaceMutationScope,
    workspaceId: string
  ): WorkspaceMutationGateState {
    let state = owner.gates.get(workspaceId);
    if (!state) {
      state = { admitted: 0, closed: false, captureClosed: null, waiters: new Set() };
      owner.gates.set(workspaceId, state);
    }
    return state;
  }

  /** Owns the original verified Worker closeout body and its actual native operation lifetime. */
  public runWorkerCloseout<T>(
    dataRoot: string,
    workspaceId: string,
    operation: () => Promise<T>
  ): Promise<T> | null {
    const release = this.enterWorkspaceLatePublisher(dataRoot, workspaceId, 'worker-turn-closeout');
    if (!release) return null;
    return this.runOperation(operation, undefined, undefined, undefined, undefined, {
      owner: this.workspaceMutations(dataRoot),
      workspaceId,
      release,
    }).finally(release);
  }

  /** Fences an idle target before synchronous authoritative inspection, without draining live work. */
  public tryFreezeWorkspace(
    dataRoot: string,
    workspaceId: string,
    readBlockers: () => readonly WorkspaceBlocker[]
  ): WorkspaceFreezeAdmission {
    const owner = this.workspaceMutations(dataRoot);
    const state = this.workspaceGate(owner, workspaceId);
    if (this.isScopeClosed(owner, workspaceId) || state.admitted !== 0) return { status: 'busy' };
    const closure: CaptureClosure = { owner: null };
    state.captureClosed = closure;
    const blockers = freezeBlockers(readBlockers);
    if (blockers.length !== 0) {
      if (state.captureClosed === closure) state.captureClosed = null;
      return { status: 'blocked', blockers };
    }
    if (state.captureClosed !== closure || state.closed) return { status: 'busy' };
    return this.ownFreeze(owner, workspaceId, state, closure);
  }

  /** Stops new ordinary calls while original bounded calls/cleanup settle, then takes the same cut. */
  public async tryFreezeWorkspaceAfterDrain(
    dataRoot: string,
    workspaceId: string,
    prepare: () => Promise<readonly WorkspaceBlocker[] | undefined>,
    readBlockers: () => readonly WorkspaceBlocker[]
  ): Promise<WorkspaceFreezeAdmission> {
    const owner = this.workspaceMutations(dataRoot);
    const state = this.workspaceGate(owner, workspaceId);
    if (this.isScopeClosed(owner, workspaceId)) return { status: 'busy' };
    const closure: CaptureClosure = { owner: null, preparing: true };
    state.captureClosed = closure;
    const drain = async () => {
      while (state.admitted !== 0) await new Promise<void>((resolve) => state.waiters.add(resolve));
    };
    try {
      await drain();
      const preparationBlockers = await prepare();
      if (preparationBlockers?.length) {
        if (state.captureClosed === closure) state.captureClosed = null;
        return { status: 'blocked', blockers: preparationBlockers };
      }
      await drain();
    } catch {
      // Unknown physical stop must not reopen admission. All original prepare calls are joined.
      delete closure.preparing;
      return {
        status: 'blocked',
        blockers: [{ kind: 'unavailable', reason: 'unavailable', actions: [] }],
      };
    }
    if (state.captureClosed !== closure || state.closed) {
      if (state.captureClosed === closure) state.captureClosed = null;
      return { status: 'busy' };
    }
    delete closure.preparing;
    const blockers = freezeBlockers(readBlockers);
    if (blockers.length) {
      if (state.captureClosed === closure) state.captureClosed = null;
      return { status: 'blocked', blockers };
    }
    if (state.captureClosed !== closure || state.closed || state.admitted !== 0)
      return { status: 'busy' };
    return this.ownFreeze(owner, workspaceId, state, closure);
  }

  /** Rejoins only the retained origin of an ownerless recovery exclusion, without opening it. */
  public tryResumeWorkspaceRecovery(
    dataRoot: string,
    workspaceId: string,
    origin: WorkspaceRecoveryFreezeOrigin,
    readBlockers: () => readonly WorkspaceBlocker[]
  ): WorkspaceFreezeAdmission {
    const owner = this.workspaceMutations(dataRoot);
    const state = owner.gates.get(workspaceId);
    const closure = state?.captureClosed;
    if (
      !state ||
      state.closed ||
      state.admitted !== 0 ||
      !closure ||
      closure.owner !== null ||
      !isDeepStrictEqual(closure.origin, origin)
    )
      return { status: 'busy' };
    const blockers = freezeBlockers(readBlockers);
    if (blockers.length !== 0) return { status: 'blocked', blockers };
    if (
      state.captureClosed !== closure ||
      state.closed ||
      state.admitted !== 0 ||
      closure.owner !== null
    )
      return { status: 'busy' };
    return this.ownFreeze(owner, workspaceId, state, closure);
  }

  /** Transfers only the same live deletion closure to its exact newly retained target admission. */
  public transferWorkspaceDeletionRecovery(
    dataRoot: string,
    workspaceId: string,
    owner: WorkspaceFrozenAdmission,
    deletion: { readonly deletionRequestId: string; readonly revision: number },
    target: {
      readonly admissionId: string;
      readonly revision: number;
      readonly candidateRef: string;
    }
  ): void {
    const gates = this.workspaceMutations(dataRoot).gates;
    if (
      !this.ownsWorkspaceFreeze(dataRoot, workspaceId, owner) ||
      !isDeepStrictEqual(gates.get(workspaceId)!.captureClosed!.origin, deletion)
    )
      throw new Error('Workspace deletion recovery closure changed.');
    gates.get(workspaceId)!.captureClosed!.origin = Object.freeze({ ...target });
  }

  /** Restores exclusion provenance only; this never recovers a live permission. */
  public restoreWorkspaceRecoveryClosed(
    dataRoot: string,
    workspaceId: string,
    origin: WorkspaceRecoveryFreezeOrigin
  ): void {
    const state = this.workspaceGate(this.workspaceMutations(dataRoot), workspaceId);
    const current = state.captureClosed;
    // Retain the live Core closeout owner; provenance never creates a new owner.
    if (
      'admissionId' in origin &&
      current?.owner &&
      !state.closed &&
      (!current.origin || isDeepStrictEqual(current.origin, origin))
    ) {
      current.origin = Object.freeze({ ...origin });
      return;
    }
    state.captureClosed = { owner: null, origin: Object.freeze({ ...origin }) };
  }

  /** Gives the same closure a live owner; a resumed release restores its prior exclusion. */
  private ownFreeze(
    scope: WorkspaceMutationScope,
    workspaceId: string,
    state: WorkspaceMutationGateState,
    closure: CaptureClosure
  ): WorkspaceFrozenAdmission {
    let released = false;
    const owner: WorkspaceFrozenAdmission = {
      status: 'frozen',
      release: () => {
        if (released) return;
        released = true;
        if (state.captureClosed !== closure) return;
        if (closure.origin) {
          closure.owner = null;
          delete closure.recovery;
        } else this.reopenScope(scope, workspaceId, 'capture');
      },
    };
    closure.owner = owner;
    return owner;
  }

  /** Tests this exact live freeze without creating a gate or recovering permission from a Boolean. */
  public ownsWorkspaceFreeze(
    dataRoot: string,
    workspaceId: string,
    owner: WorkspaceFrozenAdmission
  ): boolean {
    const state = this.workspaceMutations(dataRoot).gates.get(workspaceId);
    return !!state && !state.closed && state.captureClosed?.owner === owner;
  }

  /** A resumed owner must match its retained origin; a fresh freeze has no predecessor origin. */
  public ownsWorkspaceRecoveryOrigin(
    dataRoot: string,
    workspaceId: string,
    owner: WorkspaceFrozenAdmission,
    origin: WorkspaceRecoveryFreezeOrigin
  ): boolean {
    if (!this.ownsWorkspaceFreeze(dataRoot, workspaceId, owner)) return false;
    const retained =
      this.workspaceMutations(dataRoot).gates.get(workspaceId)!.captureClosed!.origin;
    return !retained || isDeepStrictEqual(retained, origin);
  }

  /** The recovery owner installs only its exact native bindings; replacing them retires old calls. */
  public bindWorkspaceRecovery(
    dataRoot: string,
    workspaceId: string,
    owner: WorkspaceFrozenAdmission,
    bindings:
      | {
          readonly canonical: ControlRecoveryNativeBinding;
          readonly candidate?: ControlRecoveryNativeBinding;
        }
      | {
          readonly canonical?: ControlRecoveryNativeBinding;
          readonly candidate: ControlRecoveryNativeBinding;
        }
  ): void {
    if (!this.ownsWorkspaceFreeze(dataRoot, workspaceId, owner))
      throw new Error('Workspace recovery freeze is not current.');
    const scope = this.workspaceMutations(dataRoot);
    // A proven staging database belongs to the original logical owner, not an independent gate.
    for (const binding of [bindings.canonical, bindings.candidate]) {
      if (!binding) continue;
      if (workspaceMutationOwners.get(resolve(binding.sourceDataRoot)) !== scope)
        throw new Error('Recovery binding must use its original native scope owner.');
      const root = resolve(binding.command.dataRoot!);
      const previous = workspaceMutationOwners.get(root);
      if (
        previous &&
        previous !== scope &&
        [...previous.gates.values()].some(
          (state) => state.admitted !== 0 || state.closed || state.captureClosed !== null
        )
      )
        throw new Error('Recovery candidate already has an active native scope owner.');
      workspaceMutationOwners.set(root, scope);
    }
    scope.gates.get(workspaceId)!.captureClosed!.recovery = { ...bindings };
  }

  /** A native exception belongs only to the current closure and exact installed binding object. */
  public isWorkspaceRecoveryBinding(
    dataRoot: string,
    workspaceId: string,
    owner: WorkspaceFrozenAdmission,
    binding: object
  ): boolean {
    if (!this.ownsWorkspaceFreeze(dataRoot, workspaceId, owner)) return false;
    const bindings =
      this.workspaceMutations(dataRoot).gates.get(workspaceId)!.captureClosed!.recovery;
    return !!bindings && (bindings.canonical === binding || bindings.candidate === binding);
  }

  /** Counts ordinary admission or existing settlement; capture exclusion fences both without changing legacy deletion settlement. */
  public enterWorkspaceMutation(
    dataRoot: string,
    workspaceId: string,
    exclusion: 'ordinary' | 'capture' = 'ordinary'
  ): (() => void) | null {
    return this.enterScope(this.workspaceMutations(dataRoot), workspaceId, exclusion);
  }

  private enterScope(
    owner: WorkspaceMutationScope,
    workspaceId: string,
    exclusion: 'ordinary' | 'capture'
  ): (() => void) | null {
    const state = this.workspaceGate(owner, workspaceId);
    if (this.isScopeClosed(owner, workspaceId, exclusion)) {
      return null;
    }
    state.admitted += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      state.admitted -= 1;
      if (state.admitted === 0) {
        for (const resolve of state.waiters) {
          resolve();
        }
        state.waiters.clear();
      }
    };
  }

  /** Admits one registered late publisher through the same Workspace gate. */
  public enterWorkspaceLatePublisher(
    dataRoot: string,
    workspaceId: string,
    publisher: WorkspaceMutationLatePublisher
  ): (() => void) | null {
    if (!WORKSPACE_MUTATION_LATE_PUBLISHERS.includes(publisher)) {
      throw new Error(`Unknown Workspace late publisher: ${publisher}.`);
    }
    const owner = this.workspaceMutations(dataRoot);
    const state = owner.gates.get(workspaceId);
    // Existing closeout may settle during preparation, never through the actual cut or deletion.
    return this.enterScope(
      owner,
      workspaceId,
      publisher === 'worker-turn-closeout' && state?.captureClosed?.preparing && !state.closed
        ? 'capture'
        : 'ordinary'
    );
  }

  /** Closes one Workspace gate and waits for previously admitted mutations to leave. */
  public async closeWorkspaceMutations(dataRoot: string, workspaceId: string): Promise<void> {
    const state = this.workspaceGate(this.workspaceMutations(dataRoot), workspaceId);
    state.closed = true;
    if (state.admitted === 0) {
      return;
    }
    await new Promise<void>((resolve) => state.waiters.add(resolve));
  }

  /** Releases only the selected owner closure; capture release cannot reopen a concurrent deletion. */
  public reopenWorkspaceMutations(
    dataRoot: string,
    workspaceId: string,
    closure: 'ordinary' | 'capture' = 'ordinary'
  ): void {
    this.reopenScope(this.workspaceMutations(dataRoot), workspaceId, closure);
  }

  private reopenScope(
    owner: WorkspaceMutationScope,
    workspaceId: string,
    closure: 'ordinary' | 'capture'
  ): void {
    const state = this.workspaceGate(owner, workspaceId);
    if (state.admitted !== 0) {
      throw new Error('Workspace mutation gate cannot reopen while mutations remain admitted.');
    }
    if (closure === 'capture') state.captureClosed = null;
    else state.closed = false;
  }

  /** Restores an owned closure without clearing a different lifecycle owner's exclusion. */
  public restoreWorkspaceMutationsClosed(
    dataRoot: string,
    workspaceId: string,
    closure: 'ordinary' | 'capture' = 'ordinary'
  ): void {
    const state = this.workspaceGate(this.workspaceMutations(dataRoot), workspaceId);
    if (closure === 'capture') state.captureClosed = { owner: null };
    else state.closed = true;
  }

  /** Tests ordinary exclusion or the capture-only exclusion required by already-owned low-level settlement. */
  public isWorkspaceMutationClosed(
    dataRoot: string,
    workspaceId: string,
    exclusion: 'ordinary' | 'capture' = 'ordinary'
  ): boolean {
    return this.isScopeClosed(this.workspaceMutations(dataRoot), workspaceId, exclusion);
  }

  private isScopeClosed(
    owner: WorkspaceMutationScope,
    workspaceId: string,
    exclusion: 'ordinary' | 'capture' = 'ordinary'
  ): boolean {
    const state = this.workspaceGate(owner, workspaceId);
    return (
      (state.captureClosed !== null &&
        (exclusion === 'ordinary' || !state.captureClosed.preparing)) ||
      (exclusion === 'ordinary' && state.closed)
    );
  }

  /** A live capture owner can release its fence; retained recovery and deletion closures cannot. */
  public isWorkspaceCaptureActive(dataRoot: string, workspaceId: string): boolean {
    const state = this.workspaceMutations(dataRoot).gates.get(workspaceId);
    return !!state && !state.closed && state.captureClosed?.owner != null;
  }

  /**
   * Hides lifecycle closures, including a restored deletion's exact recovery fence.
   * Other capture fences keep authorized reads visible; mutations use `isWorkspaceMutationClosed`.
   */
  public isWorkspaceLifecycleClosed(dataRoot: string, workspaceId: string): boolean {
    const state = this.workspaceMutations(dataRoot).gates.get(workspaceId);
    return (
      state?.closed === true ||
      (state?.captureClosed?.origin !== undefined &&
        'deletionRequestId' in state.captureClosed.origin)
    );
  }

  /** Serializes deletion-request admission for one Workspace. */
  public async runWorkspaceDeletionExclusive<T>(
    dataRoot: string,
    workspaceId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const tails = this.workspaceMutations(dataRoot).deletionTails;
    const preceding = tails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = preceding.then(() => current);
    tails.set(workspaceId, tail);
    await preceding;
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(workspaceId) === tail) {
        tails.delete(workspaceId);
      }
    }
  }
  private readonly fileAdmissions = new Map<string, FileStorageAdmission>();
  private readonly explicitFileAdmissionRoots = new Set<string>();
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
    const root = resolve(dataRoot);
    this.fileAdmissions.set(root, admission);
    this.explicitFileAdmissionRoots.add(root);
  }

  /** Returns the existing selected owner for this exact root without creating a policy. */
  getFileStorageAdmission(dataRoot: string): FileStorageAdmission | undefined {
    return this.fileAdmissions.get(resolve(dataRoot));
  }

  /** Path-only User/private OPENs reuse the nearest explicitly configured root policy. */
  private fileAdmissionForPath(path: string): FileStorageAdmission | undefined {
    const candidate = resolve(path);
    let selected: { root: string; admission: FileStorageAdmission; explicit: boolean } | undefined;
    for (const [root, admission] of this.fileAdmissions) {
      const explicit = this.explicitFileAdmissionRoots.has(root);
      if (
        (candidate === root || candidate.startsWith(`${root}/`)) &&
        (!selected ||
          (explicit && !selected.explicit) ||
          (explicit === selected.explicit && root.length > selected.root.length))
      )
        selected = { root, admission, explicit };
    }
    return selected?.admission;
  }

  /** Retires only a superseded compatibility reserve; shared outstanding forecasts remain held. */
  private compatibilityFileAdmission(dataRoot: string): FileStorageAdmission {
    const root = resolve(dataRoot);
    const admission: FileStorageAdmission = new FileStorageAdmission(root, () => {
      return this.fileAdmissionForPath(root) === admission
        ? BigInt(DEFAULT_FILE_RESERVE_BYTES)
        : 0n;
    });
    return admission;
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
    const explicitRoot =
      command.operation === 'open' ? command.dataRoot : opening?.command.dataRoot;
    let admission =
      explicitRoot === undefined
        ? this.fileAdmissionForPath(path)
        : this.fileAdmissions.get(resolve(root));
    if (!admission) {
      admission = this.compatibilityFileAdmission(root);
      this.fileAdmissions.set(resolve(root), admission);
    }
    const entries: ControlProductEntry[] = [];
    switch (command.operation) {
      case 'products':
      case 'transition':
        if ('entries' in command.transition) entries.push(...command.transition.entries);
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
            : command.operation === 'workspace-queue-input'
              ? undefined
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
   * @param resource Original physical opening or DB handle whose producer prepares this operation.
   * @returns The original producer result after its own closeout.
   */
  async runOperation<T>(
    operation: () => Promise<T>,
    publication?: ControlPublicationIdentity,
    reservation?:
      | string
      | { readonly database: string; readonly closeout: CapabilityCloseoutCredit },
    closeout?: { readonly database: string; readonly callId: string },
    progressCopy?: ProgressCopyCredit,
    workspaceLease?: WorkspaceMutationLease,
    resource?: CoreDb | UserDb | WorkspaceDb | Omit<OpenCommand, 'operation'>
  ): Promise<T> {
    this.assertAccepting();
    const reservedDatabase = typeof reservation === 'string' ? reservation : reservation?.database;
    if (reservedDatabase !== undefined) this.assertScopeProducerAdmission(reservedDatabase);
    if (
      closeout &&
      (this.outstanding.get(closeout.database) ?? 0) >= CONTROL_WORKER_LIMITS.pendingTransitions
    )
      throw new ControlStoreWorkerError('busy', 'not-committed');
    const inherited = this.operationContext.getStore();
    const workspaceLeases = workspaceLease ? [workspaceLease] : [];
    const retainedParents: WorkspaceMutationLease[] = [];
    try {
      if (resource) {
        const database =
          'database' in resource ? resource.database : `${resource.scope}:${resource.sqlite.name}`;
        if (!(inherited?.active && inherited.reservation === database))
          this.assertScopeProducerAdmission(database);
        const admitted = this.openings.get(database)?.command;
        const physical =
          'database' in resource
            ? (resource.physicalScope ?? resource.productOwner)
            : (admitted?.physicalScope ??
              admitted?.productOwner ??
              (resource.scope === 'workspace'
                ? { kind: 'workspace' as const, workspaceId: resource.workspaceId }
                : undefined));
        const dataRoot = admitted?.dataRoot ?? resource.dataRoot;
        if (dataRoot && (physical?.kind === 'workspace' || physical?.kind === 'app')) {
          const owner = this.workspaceMutations(dataRoot);
          if (
            !workspaceLeases.some(
              (lease) => lease.owner === owner && lease.workspaceId === physical.workspaceId
            )
          ) {
            const release = this.enterScope(owner, physical.workspaceId, 'capture');
            if (!release)
              throw new OperationError(
                'workspace_frozen',
                'Workspace is temporarily frozen.',
                409,
                {
                  details: {
                    workspaceId: physical.workspaceId,
                    operation: 'capture',
                    retryable: true,
                    blockers: [
                      {
                        kind: 'publication',
                        reason: 'frozen',
                        reference: { workspaceId: physical.workspaceId },
                        actions: [],
                      },
                    ],
                  },
                }
              );
            const retained = { owner, workspaceId: physical.workspaceId, release };
            retainedParents.push(retained);
            workspaceLeases.push(retained);
          }
        }
      }
      for (const parent of inherited?.active ? inherited.workspaceLeases : []) {
        if (
          workspaceLeases.some(
            (lease) => lease.owner === parent.owner && lease.workspaceId === parent.workspaceId
          )
        )
          continue;
        const release = this.enterScope(parent.owner, parent.workspaceId, 'capture');
        if (!release) throw new ControlStoreWorkerError('busy', 'not-committed');
        const retained = { owner: parent.owner, workspaceId: parent.workspaceId, release };
        retainedParents.push(retained);
        workspaceLeases.push(retained);
      }
    } catch (error) {
      for (const lease of retainedParents) lease.release();
      throw error;
    }
    const credit = closeout && { ...closeout, active: true, borrowing: false };
    if (credit)
      this.outstanding.set(credit.database, (this.outstanding.get(credit.database) ?? 0) + 1);
    const context = {
      active: true,
      publication,
      workspaceLeases,
      progressCopy:
        progressCopy ?? (resource && inherited?.active ? inherited.progressCopy : undefined),
      // Nested preparation may borrow only while the original funded operation is still live.
      get reservation() {
        return (
          reservedDatabase ?? (resource && inherited?.active ? inherited.reservation : undefined)
        );
      },
      closeout:
        credit ??
        (typeof reservation === 'object' ? reservation.closeout : undefined) ??
        (resource && inherited?.active ? inherited.closeout : undefined),
    };
    // Register before invoking the producer, without delaying its original synchronous snapshot.
    const accepted = Promise.withResolvers<T>();
    const promise = accepted.promise;
    // Resource preparation retains caller-owned refusals just like its ordinary request.
    // Existing explicit operations and opening-dependent requests keep shutdown failure ownership.
    const drained = resource
      ? promise.then(
          () => undefined,
          () => undefined
        )
      : promise;
    this.operations.set(drained, {
      publication: context.publication,
      workspaceLeases: context.workspaceLeases,
    });
    try {
      Promise.resolve(this.operationContext.run(context, operation)).then(
        accepted.resolve,
        accepted.reject
      );
    } catch (error) {
      accepted.reject(error);
    }
    try {
      return await promise;
    } finally {
      context.active = false;
      this.operations.delete(drained);
      for (const lease of retainedParents) lease.release();
      if (credit) {
        credit.active = false;
        // An unawaited descendant still owns its actual native backing until its reply or disposal.
        if (!credit.borrowing) this.releaseOutstanding(credit.database);
      }
    }
  }

  /** Counts the same Turn's accepted preparation and direct native observation slots once. */
  /** Only the same original direct native Turn packets participate in the existing bound. */
  private directNativeTurn(
    command: ControlWorkerCommand
  ): { readonly turnId: string | null } | undefined {
    if (
      command.operation === 'observation' ||
      command.operation === 'provenance' ||
      command.operation === 'generative-presentation' ||
      command.operation === 'worker-control-evidence'
    )
      return command.input;
    if (
      command.operation === 'transition' &&
      'kind' in command.transition &&
      command.transition.kind === 'scheduler-work'
    )
      return command.transition.input.turnId === null ? undefined : command.transition.input;
    return undefined;
  }

  private pendingTurnPublications(key: string): number {
    const [physical, turn] = JSON.parse(key) as [string, string];
    let count = this.turnTails.get(key)?.pending ?? 0;
    for (const entry of this.pending.values()) {
      const nativeTurn = this.directNativeTurn(entry.command);
      if (
        entry.counted &&
        nativeTurn &&
        'database' in entry.command &&
        this.openings.get(entry.command.database)?.path === physical &&
        nativeTurn.turnId === turn
      )
        count += 1;
    }
    return count;
  }

  /** Owns JSON input before same-Turn head capture through ACK; only an exact terminal Item borrows its invocation credit. */
  async runTurnPublication<I, T>(
    opening: Omit<OpenCommand, 'operation'>,
    turns: readonly string[],
    input: I,
    prepare: (owned: I) => Promise<T>,
    closeoutCallId?: string,
    progressPublication?: ControlItemAppend
  ): Promise<T> {
    this.assertAccepting();
    const physical = opening.physicalScope ?? opening.productOwner;
    const owner =
      opening.dataRoot && (physical?.kind === 'workspace' || physical?.kind === 'app')
        ? this.workspaceMutations(opening.dataRoot)
        : undefined;
    const workspaceId =
      physical?.kind === 'workspace' || physical?.kind === 'app' ? physical.workspaceId : undefined;
    const release =
      owner && workspaceId ? this.enterScope(owner, workspaceId, 'capture') : undefined;
    if (release === null)
      throw new OperationError('workspace_frozen', 'Workspace is temporarily frozen.', 409, {
        details: {
          workspaceId,
          operation: 'capture',
          retryable: true,
          blockers: [
            { kind: 'publication', reason: 'frozen', reference: { workspaceId }, actions: [] },
          ],
        },
      });
    const workspaceLease =
      owner && workspaceId && release ? { owner, workspaceId, release } : undefined;
    try {
      const target = structuredClone(opening);
      const database = target.database;
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
              input: progressPublication,
              version: CONTROL_WORKER_VERSION,
              id: Number.MAX_SAFE_INTEGER,
            }),
            controlWorkerInputBytes({
              ...target,
              operation: 'open',
              version: CONTROL_WORKER_VERSION,
              id: Number.MAX_SAFE_INTEGER,
            })
          ) + 64
        : 0;
      const progressCopy: ProgressCopyCredit | undefined = progressPublication && {
        database,
        itemId: progressPublication.item.id,
        turnId: progressPublication.item.turnId,
        category: progressPublication.category,
        openingHash: commandInputHash(target),
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
      const physicalPath = realpathSync(target.path);
      const keys = [...new Set(turns)].map((turn) => JSON.stringify([physicalPath, turn]));
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
        progressCopy,
        workspaceLease
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
    } finally {
      release?.();
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
    const matches = [...this.operations].filter(([, operation]) =>
      isDeepStrictEqual(operation.publication, publication)
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
  private reserveOpening(
    command: Omit<OpenCommand, 'operation'>,
    serverFile: Stats | undefined
  ): {
    path: string;
    identity: string | undefined;
    host: WriterHost;
  } {
    let path: string;
    let identity: string | undefined;
    try {
      let incoming: Stats | undefined;
      if (command.serverOwner) {
        path = serverStoragePath(command.dataRoot!, command.serverOwner.owner);
        if (command.path !== path || command.database !== `server-owner:${path}`)
          throw new ServerOwnerAdmissionError('unsupported');
        incoming = serverFile;
        if (!incoming && !command.create) throw new ServerOwnerAdmissionError('missing');
      } else {
        incoming = statSync(command.path, { throwIfNoEntry: false });
        const leaf = lstatSync(command.path, { throwIfNoEntry: false });
        if (!incoming && leaf?.isSymbolicLink())
          throw new Error('A dangling link cannot reserve a new database.');
        path = incoming
          ? realpathSync(command.path)
          : join(realpathSync(dirname(command.path)), basename(command.path));
      }
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
    } catch (error) {
      if (error instanceof ServerOwnerAdmissionError) throw error;
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
    opening?: Opening,
    accepted?: Pending
  ): void {
    const context = this.operationContext.getStore();
    const continuing =
      (context?.active && 'database' in command && context.reservation === command.database) ||
      (accepted !== undefined && this.pending.get(accepted.request.id) === accepted);
    const physical =
      opening ?? ('database' in command ? this.openings.get(command.database) : undefined);
    const dataRoot = command.operation === 'open' ? command.dataRoot : physical?.command.dataRoot;
    const admission = dataRoot ? this.workspaceMutations(dataRoot) : undefined;
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
      // These closed inputs admit new work, not an already-owned Worker closeout.
      const logical =
        command.operation === 'private-workspace'
          ? [
              ...('workspaceId' in command.input ? [command.input.workspaceId] : []),
              ...('expectedWorkspaceId' in command.input
                ? [command.input.expectedWorkspaceId]
                : []),
            ]
          : [];
      const ordinary =
        (command.operation === 'capability' && command.input.kind === 'admit') ||
        (command.operation === 'terminal' && !continuing);
      const workspaceId =
        logical.find(
          (id) => admission && this.isScopeClosed(admission, id, accepted ? 'capture' : 'ordinary')
        ) ??
        ((owner?.kind === 'workspace' || owner?.kind === 'app') &&
        admission &&
        this.isScopeClosed(admission, owner.workspaceId, ordinary ? 'ordinary' : 'capture')
          ? owner.workspaceId
          : undefined);
      if (workspaceId)
        throw new OperationError('workspace_frozen', 'Workspace is temporarily frozen.', 409, {
          details: {
            workspaceId,
            operation: 'capture',
            retryable: true,
            blockers: [
              {
                kind: 'publication',
                reason: 'frozen',
                reference: { workspaceId },
                actions: [],
              },
            ],
          },
        });
      return;
    }
    if ('kind' in recovery && recovery.kind === 'capture-read') {
      const capture = recovery.capture;
      const physical = command.operation === 'open' ? command.physicalScope : undefined;
      // Actual posting adds transport identity to the same admitted business binding.
      const {
        operation: _operation,
        version: _version,
        id: _id,
        ...admitted
      } = command as ControlWorkerRequest;
      if (
        recovery[captureReadCall] !== true ||
        !capture.active ||
        this.backupHold ||
        capture.root.captureReads !== capture ||
        capture.root.retirement ||
        capture.root.host.failed ||
        !dataRoot ||
        !this.isWorkspaceCaptureActive(dataRoot, capture.workspaceId) ||
        command.operation !== 'open' ||
        command.create !== false ||
        command.initialize !== undefined ||
        physical?.kind !== 'app' ||
        physical.workspaceId !== capture.workspaceId ||
        !isDeepStrictEqual(admitted, recovery.command) ||
        this.databaseHolds.get(command.database) !== recovery.hold ||
        recovery.hold.released !== recovery.released ||
        !command.dataRoot
      )
        throw new ControlStoreWorkerError('busy', 'not-committed');
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
              !dataRoot ||
              !this.ownsWorkspaceFreeze(dataRoot, recovery.input.workspaceId, recovery.freeze)
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
          !dataRoot ||
          !this.ownsWorkspaceFreeze(dataRoot, recovery.input.workspaceId, recovery.freeze) ||
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
      // A private candidate has a different physical root, but belongs to the original Core owner.
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
          !this.isWorkspaceRecoveryBinding(
            binding.sourceDataRoot,
            owner.workspaceId,
            freeze,
            binding
          ) ||
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
        !this.isWorkspaceRecoveryBinding(
          binding.sourceDataRoot,
          owner.workspaceId,
          freeze,
          binding
        ) ||
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

  /** Checks the original ACK and physical identity without changing the synchronous read API. */
  assertExistingAppReadReady(dataRoot: string, workspaceId: string, appId: string): void {
    const opening = this.appReadOpening(dataRoot, workspaceId, appId);
    if (!opening) return;
    const path = resolve(lightAppDbPath(dataRoot, workspaceId, appId));
    this.assertAppReadIdentity(opening, workspaceId, appId, {
      ...readPhysicalDatabaseIdentity(path),
      root: realpathSync(dataRoot),
      originalRoot: realpathSync(opening.command.dataRoot!),
    });
  }

  /** Noncreating state check shared by the synchronous primitive and async admission. */
  private appReadOpening(
    dataRoot: string,
    workspaceId: string,
    appId: string
  ): Opening | undefined {
    const path = resolve(lightAppDbPath(dataRoot, workspaceId, appId));
    const opening = this.openings.get(`app:${path}`);
    const parent = this.openings.get(`workspace:${workspaceDbPath(dataRoot, workspaceId)}`);
    if (opening?.retirement || parent?.retirement)
      throw new ControlStoreWorkerError('busy', 'not-committed');
    if (this.stopping && !this.closed) throw new ControlStoreWorkerError('busy', 'not-committed');
    if (this.closed || (!parent && !opening)) return undefined;
    if (
      !opening ||
      !opening.acknowledged ||
      opening.host.failed ||
      parent?.host.failed ||
      !opening.command.dataRoot
    )
      throw new ControlStoreWorkerError('unavailable', 'not-committed');
    return opening;
  }

  private assertAppReadIdentity(
    opening: Opening,
    workspaceId: string,
    appId: string,
    facts: { path: string; identity: string; root: string; originalRoot: string }
  ): void {
    const owner = opening.command.physicalScope ?? opening.command.productOwner;
    if (
      owner?.kind !== 'app' ||
      owner.workspaceId !== workspaceId ||
      owner.appId !== appId ||
      facts.path !== opening.path ||
      facts.identity !== opening.identity ||
      facts.root !== facts.originalRoot
    )
      throw new ControlStoreWorkerError('unavailable', 'not-committed');
  }

  /** Async callers do not borrow the synchronous primitive's metadata exceptions. */
  private async assertExistingAppReadReadyAsync(
    dataRoot: string,
    workspaceId: string,
    appId: string
  ): Promise<void> {
    const opening = this.appReadOpening(dataRoot, workspaceId, appId);
    if (!opening) return;
    const path = resolve(lightAppDbPath(dataRoot, workspaceId, appId));
    const [current, canonicalPath, root, originalRoot] = await Promise.all([
      stat(path),
      realpath(path),
      realpath(dataRoot),
      realpath(opening.command.dataRoot!),
    ]);
    if (this.appReadOpening(dataRoot, workspaceId, appId) !== opening)
      throw new ControlStoreWorkerError('unavailable', 'not-committed');
    this.assertAppReadIdentity(opening, workspaceId, appId, {
      path: canonicalPath,
      identity: `${current.dev}:${current.ino}`,
      root,
      originalRoot,
    });
  }

  private wakeCaptureReads(capture: CaptureReadGeneration): void {
    const previous = capture.changed;
    capture.changed = Promise.withResolvers<void>();
    previous.resolve();
  }

  /** Reuses warm read ownership, or funds one existing cold App in the matching capture. */
  async openExistingAppForRead(
    dataRoot: string,
    workspaceId: string,
    appId: string
  ): Promise<void> {
    this.assertAccepting();
    const canonicalDataRoot = await realpath(dataRoot);
    const path = await realpath(lightAppDbPath(dataRoot, workspaceId, appId));
    const database = `app:${path}`;
    const command: Omit<OpenCommand, 'operation'> = {
      database,
      path,
      dataRoot,
      create: false,
      physicalScope: { kind: 'app', workspaceId, appId },
    };
    for (;;) {
      if (this.isWorkspaceLifecycleClosed(dataRoot, workspaceId))
        throw new OperationError('workspace_frozen', 'Workspace is temporarily frozen.', 409, {
          details: { workspaceId, retryable: true },
        });
      const existing = this.openings.get(database);
      if (existing) {
        if (existing.retirement || existing.host.failed)
          throw new ControlStoreWorkerError('busy', 'not-committed');
        await existing.promise;
        await this.assertExistingAppReadReadyAsync(dataRoot, workspaceId, appId);
        return;
      }
      const parent = this.openings.get(`workspace:${workspaceDbPath(dataRoot, workspaceId)}`);
      const capture = parent?.captureReads;
      if (!this.isWorkspaceCaptureActive(dataRoot, workspaceId)) {
        await this.openFrozen(command);
        await this.assertExistingAppReadReadyAsync(dataRoot, workspaceId, appId);
        return;
      }
      if (!capture?.active || capture.dataRoot !== canonicalDataRoot || this.backupHold)
        throw new ControlStoreWorkerError('busy', 'not-committed');
      const admitted = capture.inFlightOpens.get(database);
      if (admitted) {
        await admitted;
        await this.assertExistingAppReadReadyAsync(dataRoot, workspaceId, appId);
        return;
      }
      if (capture.enumerating || capture.copyingPath === path) {
        await capture.changed.promise;
        continue;
      }
      // Register before the first asynchronous hold acquisition, including failure settlement.
      const accepted = Promise.withResolvers<void>();
      capture.inFlightOpens.set(database, accepted.promise);
      const original = (async () => {
        let release: (() => void) | undefined;
        try {
          release = await this.pauseForDataRootBackup(database);
          if (!capture.active) throw new ControlStoreWorkerError('busy', 'not-committed');
          if (capture.postingHeld) capture.acquired.push(release);
          const hold = this.databaseHolds.get(database)!;
          const current = await stat(path);
          await this.openFrozen(command, {
            kind: 'capture-read',
            [captureReadCall]: true,
            capture,
            hold,
            released: hold.released,
            command,
            path,
            identity: `${current.dev}:${current.ino}`,
          });
          await this.assertExistingAppReadReadyAsync(dataRoot, workspaceId, appId);
        } catch (error) {
          if (!this.openings.has(database)) release?.();
          throw error;
        } finally {
          if (!capture.postingHeld || !capture.active) release?.();
        }
      })();
      void original.then(accepted.resolve, accepted.reject);
      const remove = () => capture.inFlightOpens.delete(database);
      void accepted.promise.then(remove, remove);
      await accepted.promise;
      return;
    }
  }

  /** Sets exclusion before joining accepted OPENs; only the original phase reply releases copy. */
  async captureReadBarrier(database: string, phase: string, path?: string): Promise<void> {
    const capture = this.openings.get(database)?.captureReads;
    if (!capture?.active) return;
    if (phase === 'enumeration' || phase === 'cut') capture.enumerating = true;
    else if (phase === 'pin') {
      capture.enumerating = false;
      this.wakeCaptureReads(capture);
      return;
    } else if (phase === 'db-backup' && path) capture.copyingPath = resolve(path);
    else if (phase === 'mutable-copy' && path) {
      if (capture.copyingPath !== resolve(path))
        throw new ControlStoreWorkerError('precondition', 'not-committed');
      capture.copyingPath = undefined;
      this.wakeCaptureReads(capture);
      return;
    } else return;
    await Promise.allSettled(
      [...capture.inFlightOpens]
        .filter(([key]) => phase !== 'db-backup' || key === `app:${capture.copyingPath}`)
        .map(([, promise]) => promise)
    );
    if (
      capture.root.host.failed ||
      [...this.openings.values()].some(
        (opening) =>
          opening.command.physicalScope?.workspaceId === capture.workspaceId && opening.host.failed
      )
    )
      throw new ControlStoreWorkerError('unavailable', 'unknown');
  }

  /** Ends this request's generation before releasing its existing physical holds. */
  async finishCaptureReads(database: string): Promise<void> {
    const root = this.openings.get(database);
    const capture = root?.captureReads;
    if (!capture) return;
    capture.active = false;
    this.wakeCaptureReads(capture);
    await Promise.allSettled(capture.inFlightOpens.values());
    if (capture.root.captureReads === capture) delete capture.root.captureReads;
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
    const snapshot = structuredClone(command);
    if (snapshot.migrateServerOwner)
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    if (recovery) return this.openFrozen(snapshot, recovery);
    return this.admitOpen(snapshot);
  }

  private admitOpen(command: Omit<OpenCommand, 'operation'>): Promise<void> {
    return this.runOperation(
      () => this.openFrozen(command),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      command
    );
  }

  /** Opens an existing file after kernel boot and before its owner starts effects. */
  async openServerOwner<Owner extends ServerOwnerDescriptor['owner']>(
    dataRoot: string,
    descriptor: ServerOwnerDescriptor<Owner>
  ): Promise<StorageStatus<Owner>> {
    return this.admitServerOwner(dataRoot, descriptor, false);
  }

  /** Creates storage only for trusted fresh install, first enable or authorized rebuild. */
  async provisionServerOwner<Owner extends ServerOwnerDescriptor['owner']>(
    dataRoot: string,
    descriptor: ServerOwnerDescriptor<Owner>
  ): Promise<StorageStatus<Owner>> {
    return this.admitServerOwner(dataRoot, descriptor, true);
  }

  /** Migrates an existing, stopped owner under the Data Root lock. */
  async migrateServerOwner<Owner extends ServerOwnerDescriptor['owner']>(
    dataRoot: string,
    descriptor: ServerOwnerDescriptor<Owner>,
    lock: DataRootLock
  ): Promise<StorageStatus<Owner>> {
    const release = retainDataRootLock(lock, dataRoot);
    if (!release)
      return { state: 'unavailable', owner: descriptor.owner, reason: 'recovery-required' };
    try {
      return await this.admitServerOwner(dataRoot, descriptor, false, true);
    } finally {
      release();
    }
  }

  /** Owns each serving reader through the exact acknowledged writer generation. */
  async openServerOwnerReadDb(
    dataRoot: string,
    owner: ServerOwnerDescriptor['owner']
  ): Promise<Database.Database> {
    const database = `server-owner:${serverStoragePath(dataRoot, owner)}`;
    return this.openAcknowledgedServerOwnerReadDb(database, owner, this.openings.get(database));
  }

  /** Opens a query-only reader against the captured generation, including during async acquisition. */
  private async openAcknowledgedServerOwnerReadDb(
    database: string,
    owner: ServerOwnerDescriptor['owner'],
    opening: Opening | undefined
  ): Promise<Database.Database> {
    if (
      !opening?.acknowledged ||
      !opening.identity ||
      !opening.command.dataRoot ||
      opening.command.serverOwner?.owner !== owner
    )
      throw new ServerOwnerAdmissionError('recovery-required');
    const assertCurrent = (identity: string) => {
      if (
        this.stopping ||
        opening.retirement ||
        opening.host.failed ||
        this.openings.get(database) !== opening ||
        opening.identity !== identity
      )
        throw new ServerOwnerAdmissionError('recovery-required');
    };
    assertCurrent(opening.identity);
    const release = reserveMainScopeReadAcquisition(opening.path);
    try {
      return await openServerOwnerReadConnection(opening.command.dataRoot, owner, assertCurrent);
    } finally {
      release();
    }
  }

  /** Observes only the acknowledged owner already selected for the live deployment. */
  readAdmittedNanoHost<Value>(
    dataRoot: string,
    query: (sqlite: Database.Database) => Value
  ): StorageResult<'nanohost', Value> {
    const database = `server-owner:${serverStoragePath(dataRoot, 'nanohost')}`;
    return (
      this.openings.get(database)?.readNanoHost?.(query) ?? {
        state: 'unavailable',
        owner: 'nanohost',
        reason: 'missing',
      }
    );
  }

  /** Binds gated NanoHost methods through existing-only admission and one acknowledged opening. */
  async bindNanoHostOwner(
    dataRoot: string,
    readers: NanoHostOwnerReaders,
    gate: NanoHostServingGate
  ): Promise<StorageResult<'nanohost', NanoHostOwnerBinding>> {
    const { owner } = nanoHostStoreDescriptor;
    const disabled = { state: 'unavailable', owner, reason: 'disabled' } as const;
    try {
      if (!gate.enabled()) return disabled;
      const root = await realpath(dataRoot);
      const status = await this.openServerOwner(root, nanoHostStoreDescriptor);
      if (status.state !== 'ready') return status;

      const database = `server-owner:${serverStoragePath(root, owner)}`;
      const opening = this.openings.get(database);
      const openingRequestId = opening?.openingRequestId;
      if (
        !opening?.acknowledged ||
        opening.command.serverOwner?.owner !== owner ||
        openingRequestId === undefined
      )
        throw new ServerOwnerAdmissionError('recovery-required');

      const assertCurrent = (ownPendingWrite = false) => {
        if (!gate.enabled()) throw new ControlStoreWorkerError('unavailable', 'not-committed');
        if (this.stopping || opening.host.failed || this.openings.get(database) !== opening)
          throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
        this.assertScopeProducerAdmission(database);
        if (opening.nanoHostWritePending && !ownPendingWrite)
          throw new ControlStoreWorkerError('busy', 'not-committed');
      };
      assertCurrent();
      opening.nanoHostReader ??= this.openAcknowledgedServerOwnerReadDb(database, owner, opening);
      const sqlite = await opening.nanoHostReader;
      assertCurrent();

      const readCurrent = <Value>(
        query: (sqlite: Database.Database) => Value,
        ownPendingWrite = false
      ): Value => {
        // A Core decision can pin the same Native reader without changing its target.
        // Physical polls may observe it while other writers remain excluded.
        assertCurrent(ownPendingWrite || opening.nanoHostWritePending === 'core-owner-read');
        const physical = readPhysicalDatabaseIdentity(opening.path);
        if (
          !sqlite.open ||
          !physical.file.isFile() ||
          physical.file.nlink !== 1 ||
          physical.path !== opening.path ||
          physical.identity !== opening.identity
        )
          throw new ServerOwnerAdmissionError('recovery-required');
        return query(sqlite);
      };
      const read = <Value>(
        query: (sqlite: Database.Database) => Value
      ): StorageResult<'nanohost', Value> => {
        try {
          if (!gate.enabled()) return disabled;
          return { state: 'ready', value: readCurrent(query) };
        } catch (error) {
          return serverOwnerUnavailable(owner, error);
        }
      };
      opening.readNanoHost = read;
      const readWorkerCompletion: NanoHostOwnerBinding['readWorkerCompletion'] = (query) => {
        try {
          if (!gate.enabled()) return disabled;
          if (opening.nanoHostTargetTransition)
            throw new ControlStoreWorkerError('busy', 'not-committed');
          if (
            opening.nanoHostWritePending === 'target-stable-write' ||
            opening.nanoHostWritePending === 'core-owner-read'
          ) {
            readCurrent(() => undefined, true);
            return { state: 'pending' };
          }
          return read(query);
        } catch (error) {
          return serverOwnerUnavailable(owner, error);
        }
      };
      const readRuntimeTarget: NanoHostOwnerBinding['readRuntimeTarget'] = (targetId) => {
        try {
          if (!gate.enabled()) return disabled;
          if (opening.nanoHostTargetTransition)
            throw new ControlStoreWorkerError('busy', 'not-committed');
          // These serving mutations leave the selected RuntimeTarget unchanged.
          return {
            state: 'ready',
            value: readCurrent(
              (handle) => getNanoHostRuntimeTarget({ sqlite: handle }, targetId),
              opening.nanoHostWritePending === 'target-stable-write'
            ),
          };
        } catch (error) {
          return serverOwnerUnavailable(owner, error);
        }
      };
      const verifyPost = (mutation: NanoHostOwnerMutation): boolean => {
        assertCurrent(true);
        switch (mutation.kind) {
          case 'worker-image':
            return gate.verifyImagePublication?.(mutation.input) === true;
          case 'backend-session': {
            if (mutation.input.kind !== 'handoff') return true;
            const session = readCurrent(
              (handle) =>
                readers.getWorkerBackendSession({ sqlite: handle }, mutation.input.attemptId),
              true
            );
            return session !== null && gate.verifyWorkspaceHandoff?.(session) === true;
          }
          case 'worker-storage-binding':
            return gate.verifyStorageBinding?.(mutation.input) === true;
          default:
            return true;
        }
      };

      const write = async <Kind extends NanoHostOwnerMutation['kind']>(
        mutation: NanoHostOwnerMutation & { kind: Kind },
        verifyStorageAttachment?: (sqlite: Database.Database) => boolean
      ): Promise<Extract<NanoHostOwnerMutationResult, { kind: Kind }>> => {
        assertCurrent();
        opening.nanoHostWritePending =
          mutation.kind === 'backend-session-materialize' ||
          mutation.kind === 'backend-session' ||
          mutation.kind === 'harness-lifecycle' ||
          mutation.kind === 'harness-turn-lifecycle' ||
          mutation.kind === 'recovery-classification' ||
          mutation.kind === 'worker-image' ||
          (mutation.kind === 'worker-storage-binding' && verifyStorageAttachment)
            ? 'target-stable-write'
            : true;
        try {
          const reply = (await this.request(
            { operation: 'nanohost-owner', database, openingRequestId, mutation },
            undefined,
            undefined,
            false,
            undefined,
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            verifyStorageAttachment
              ? () =>
                  !opening.nanoHostTargetTransition && readCurrent(verifyStorageAttachment, true)
              : verifyPost
          )) as Extract<Success, { operation: 'nanohost-owner' }>;
          return reply.result as Extract<NanoHostOwnerMutationResult, { kind: Kind }>;
        } catch (error) {
          if (
            error instanceof ControlStoreWorkerError &&
            (error.commit === 'unknown' || error.code === 'integrity')
          )
            this.fail(opening.host);
          if (
            error instanceof ControlStoreWorkerError &&
            error.domain?.operation === 'nanohost-owner'
          ) {
            const domain = error.domain;
            switch (mutation.kind) {
              case 'harness-lifecycle':
              case 'harness-turn-lifecycle':
                if (domain.code === 'harness_refused') {
                  const refusal = new Error(domain.message, { cause: error });
                  if (domain.exhaustedBound)
                    Object.assign(refusal, {
                      reasonCode: 'busy',
                      exhaustedBound: domain.exhaustedBound,
                    });
                  throw refusal;
                }
                break;
              case 'worker-image':
              case 'prepared-image-result':
                if (domain.code === 'unsupported_retained_format')
                  throw new TypeError(domain.message, { cause: error });
                if (domain.code === 'worker_image_conflict')
                  throw new WorkerImageSettlementConflict();
                break;
              case 'backend-session':
              case 'backend-session-materialize':
                if (domain.code === 'backend_session_refused') {
                  const Constructor =
                    domain.errorName === 'TypeError'
                      ? TypeError
                      : domain.errorName === 'SyntaxError'
                        ? SyntaxError
                        : Error;
                  throw new Constructor(domain.message, { cause: error });
                }
                break;
              case 'worker-storage-binding':
                throw new WorkerStorageBindingError(
                  domain.code as WorkerStorageBindingError['code'],
                  domain.message
                );
            }
          }
          throw error;
        } finally {
          delete opening.nanoHostWritePending;
        }
      };

      const waitForWorkerControlAcknowledgement = async (): Promise<void> => {
        const pending = opening.nanoHostCoreHoldPending;
        if (pending && !this.backupHold && !opening.nanoHostTargetTransition) await pending;
      };

      // Drain Core postings while the original authority is used by the Native writer.
      const withCoreHold = async <Value>(submit: (identity: string) => Promise<Value>) => {
        const corePath = serverStoragePath(root, 'control-kernel');
        const coreKey = `core:${corePath}`;
        const core = this.openings.get(coreKey);
        const identity = core?.identity;
        assertCurrent();
        if (
          !core?.acknowledged ||
          !identity ||
          core.command.initialize !== 'core' ||
          core.command.dataRoot !== root ||
          core.host.failed ||
          core.retirement ||
          this.backupHold ||
          opening.nanoHostCoreHoldPending
        )
          throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
        const acknowledged = Promise.withResolvers<void>();
        opening.nanoHostCoreHoldPending = acknowledged.promise;
        try {
          return await this.runOperation(
            async () => {
              const resume = await this.pauseForDataRootBackup(coreKey);
              try {
                let physical: ReturnType<typeof readPhysicalDatabaseIdentity>;
                try {
                  physical = readPhysicalDatabaseIdentity(corePath);
                } catch {
                  throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
                }
                if (
                  this.openings.get(coreKey) !== core ||
                  core.host.failed ||
                  core.retirement ||
                  !physical.file.isFile() ||
                  physical.file.nlink !== 1 ||
                  physical.path !== corePath ||
                  physical.identity !== identity
                )
                  throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
                return await submit(identity);
              } finally {
                if (opening.host.failed) await opening.host.exited.promise;
                resume();
              }
            },
            undefined,
            database
          );
        } finally {
          delete opening.nanoHostCoreHoldPending;
          acknowledged.resolve();
        }
      };

      const enrollTransport: NanoHostAdministratorEnroll = async (input) => {
        const enrolled = ControlNanoHostTransportInputSchema.parse(input);
        const isAdministrator = readers.isEnrollmentAdministrator;
        if (
          enrolled.kind !== 'enroll' ||
          !enrolled.actor ||
          enrolled.actor.userId !== enrolled.record.responsibleServerAdminActorId ||
          enrolled.record.predecessorTokenId != null ||
          !isAdministrator
        )
          throw new ControlStoreWorkerError('precondition', 'not-committed');
        const actor = nanoHostTransportAdminFacts(enrolled.actor);
        return withCoreHold(async () => {
          let authorized: boolean;
          try {
            const reader = openCoreReadDb(root);
            try {
              authorized = isAdministrator(reader, actor, enrolled.record.now);
            } finally {
              reader.sqlite.close();
            }
          } catch {
            throw new ControlStoreWorkerError('precondition', 'not-committed');
          }
          if (!authorized) {
            const refusal = NANOHOST_TRANSPORT_ADMIN_REFUSAL;
            throw new OperationError(refusal.code, refusal.message, refusal.status, {
              cause: new ControlStoreWorkerError('precondition', 'not-committed'),
            });
          }
          const result = (
            await write({ kind: 'transport', input: { kind: 'enroll', record: enrolled.record } })
          ).value;
          if (result.kind !== 'record') throw new ControlStoreWorkerError('integrity', 'unknown');
          return result;
        });
      };

      const withNativeReadForCore = async <Value>(
        run: (core: Opening, openingRequestId: number, nativeIdentity: string) => Promise<Value>
      ): Promise<Value> => {
        assertCurrent();
        readCurrent(() => undefined);
        if (
          opening.nanoHostTargetTransition ||
          opening.nanoHostCoreHoldPending ||
          !opening.identity ||
          this.backupHold
        )
          throw new ControlStoreWorkerError('busy', 'not-committed');
        const nativeIdentity = opening.identity;
        const corePath = coreDbPath(root);
        const coreKey = `core:${corePath}`;
        const core = this.openings.get(coreKey);
        const coreOpeningRequestId = core?.openingRequestId;
        if (
          !core?.acknowledged ||
          core.command.initialize !== 'core' ||
          coreOpeningRequestId === undefined ||
          core.host.failed ||
          core.retirement ||
          readPhysicalDatabaseIdentity(corePath).identity !== core.identity
        )
          throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
        if (this.databaseHolds.has(coreKey))
          throw new ControlStoreWorkerError('busy', 'not-committed');
        const releaseNative = reserveMainScopeReadAcquisition(opening.path);
        const acknowledged = Promise.withResolvers<void>();
        opening.nanoHostCoreHoldPending = acknowledged.promise;
        opening.nanoHostWritePending = 'core-owner-read';
        try {
          return await run(core, coreOpeningRequestId, nativeIdentity);
        } finally {
          if (core.host.failed) await core.host.exited.promise;
          delete opening.nanoHostWritePending;
          delete opening.nanoHostCoreHoldPending;
          acknowledged.resolve();
          releaseNative();
        }
      };

      const withWorkspaceForAttempt = async <Value>(
        attemptId: string,
        run: (workspaceIdentity: string) => Promise<Value>
      ): Promise<Value> => {
        const reader = openCoreReadDb(root);
        let workspaceId: string;
        try {
          workspaceId = requireSchedulerExecutionAttempt(reader, attemptId).workspaceId;
        } finally {
          reader.sqlite.close();
        }
        const workspaceKey = `workspace:${workspaceDbPath(root, workspaceId)}`;
        const workspace = this.openings.get(workspaceKey);
        const workspaceIdentity = workspace?.identity;
        if (
          !workspace?.acknowledged ||
          !workspaceIdentity ||
          workspace.command.initialize !== 'workspace' ||
          workspace.command.productOwner?.kind !== 'workspace' ||
          workspace.command.productOwner.workspaceId !== workspaceId ||
          workspace.host.failed ||
          workspace.retirement
        )
          throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
        if (this.databaseHolds.has(workspaceKey))
          throw new ControlStoreWorkerError('busy', 'not-committed');

        return this.runOperation(
          async () => {
            const resume = await this.pauseForDataRootBackup(workspaceKey);
            try {
              return await run(workspaceIdentity);
            } finally {
              resume();
            }
          },
          undefined,
          database,
          undefined,
          undefined,
          undefined,
          workspace.command
        );
      };

      const releaseTerminalScopes: NanoHostOwnerBinding['releaseTerminalScopes'] = async (
        attemptId,
        fenceRef
      ) => {
        const terminalRelease = readers.terminalRelease;
        if (!terminalRelease)
          throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
        await waitForWorkerControlAcknowledgement();
        await withNativeReadForCore((core, openingRequestId, nanoHostIdentity) =>
          withWorkspaceForAttempt(attemptId, async (workspaceIdentity) => {
            const reader = openCoreReadDb(root);
            try {
              const attempt = requireSchedulerExecutionAttempt(reader, attemptId);
              if (
                attempt.phase !== 'closed' ||
                !attempt.agentSessionId ||
                attempt.fenceRef !== fenceRef
              )
                throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
              const target = readCurrent((sqlite) => {
                const session = readers.getWorkerBackendSession({ sqlite }, attemptId);
                return session && getNanoHostRuntimeTarget({ sqlite }, session.runtimeTargetId);
              });
              if (!target?.physicalEpoch || !target.connectionGeneration)
                throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
              const workspace = openAdmittedWorkspaceReadDb(root, attempt.workspaceId);
              let evidence: Awaited<ReturnType<typeof prepareNanoHostReleaseWorkspace>>;
              try {
                if (
                  readPhysicalDatabaseIdentity(workspace.sqlite.name).identity !== workspaceIdentity
                )
                  throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
                evidence = await prepareNanoHostReleaseWorkspace(
                  workspace,
                  attempt,
                  terminalRelease.projectStep
                );
              } finally {
                workspace.sqlite.close();
              }
              const input = ControlNanoHostTerminalReleaseInputSchema.parse({
                attemptId,
                fenceRef,
                target: {
                  targetId: target.targetId,
                  identityId: target.identityId,
                  deploymentId: target.deploymentId,
                  physicalEpoch: target.physicalEpoch,
                  connectionGeneration: target.connectionGeneration,
                },
                coveredScopeRefs: [
                  `workspace:${attempt.workspaceId}`,
                  `thread:${attempt.threadId}`,
                  `turn:${attempt.turnId}`,
                  `session:${attempt.agentSessionId}`,
                ],
                ...evidence,
              });
              const coreKey = core.command.database;
              if (this.backupHold || this.databaseHolds.has(coreKey))
                throw new ControlStoreWorkerError('busy', 'not-committed');
              try {
                const reply = await this.request({
                  operation: 'nanohost-terminal-release',
                  database: coreKey,
                  openingRequestId,
                  input,
                  peers: { nanoHostIdentity, workspaceIdentity },
                });
                if (reply.operation !== 'nanohost-terminal-release')
                  throw new ControlStoreWorkerError('integrity', 'unknown');
                if (reply.result.state !== 'settled')
                  throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
              } catch (error) {
                if (!(error instanceof ControlStoreWorkerError) || error.commit !== 'unknown')
                  throw error;
                if (core.host.failed) await core.host.exited.promise;
                if (
                  readPhysicalDatabaseIdentity(core.path).identity !== core.identity ||
                  terminalRelease.inspect(reader, input).state !== 'settled'
                )
                  throw error;
              }
            } finally {
              reader.sqlite.close();
            }
          })
        );
      };

      const firstSubmission: NanoHostOwnerBinding['firstSubmission'] = (original) =>
        withNativeReadForCore(async (core, coreOpeningRequestId, nativeIdentity) => {
          const coreKey = core.command.database;
          const input = readCurrent((handle) => {
            const session = readers.getWorkerBackendSession({ sqlite: handle }, original.attemptId);
            const target =
              session && getNanoHostRuntimeTarget({ sqlite: handle }, session.runtimeTargetId);
            if (!target?.physicalEpoch || !target.connectionGeneration || !session)
              throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
            return ControlNanoHostFirstSubmissionInputSchema.parse({
              ...original,
              placement: {
                runtimeTargetId: session.runtimeTargetId,
                identityId: target.identityId,
                deploymentId: session.deploymentId,
                physicalEpoch: session.originPhysicalEpoch,
                connectionGeneration: target.connectionGeneration,
              },
            });
          });

          try {
            return await withWorkspaceForAttempt(input.attemptId, async (workspaceIdentity) => {
              try {
                readCurrent(() => undefined, true);
                if (
                  this.backupHold ||
                  this.databaseHolds.has(coreKey) ||
                  opening.nanoHostTargetTransition
                )
                  throw new ControlStoreWorkerError('busy', 'not-committed');
                const reply = await this.request({
                  operation: 'nanohost-first-submission',
                  database: coreKey,
                  openingRequestId: coreOpeningRequestId,
                  input,
                  peers: { nanoHostIdentity: nativeIdentity, workspaceIdentity },
                });
                if (
                  reply.operation !== 'nanohost-first-submission' ||
                  reply.result.attempt.attemptId !== input.attemptId
                )
                  throw new ControlStoreWorkerError('integrity', 'unknown');
                return reply.result;
              } finally {
                if (core.host.failed) await core.host.exited.promise;
              }
            });
          } catch (error) {
            if (
              error instanceof ControlStoreWorkerError &&
              error.domain?.operation === 'nanohost-first-submission'
            )
              throw new ExecutionAttemptRefusal(error.domain.message);
            throw error;
          }
        });

      const writeHarnessTurn = (
        input: Extract<NanoHostOwnerMutation, { kind: 'harness-turn-lifecycle' }>['input']
      ) => {
        const original = structuredClone(input);
        return withCoreHold(
          async (coreIdentity) =>
            (await write({ kind: 'harness-turn-lifecycle', input: original, coreIdentity })).value
        );
      };
      const writeStorageAttachment: WriteNanoHostStorageAttachment = (input, authority) => {
        const original = structuredClone(input);
        const { attemptId, verifyBeforePost } = authority;
        return withCoreHold(() =>
          withWorkspaceForAttempt(attemptId, async () => {
            try {
              return (
                await write({ kind: 'worker-storage-binding', input: original }, verifyBeforePost)
              ).value;
            } finally {
              if (opening.host.failed) await opening.host.exited.promise;
            }
          })
        );
      };
      const writeWorkerObservation = async <Value>(
        publish: (coreIdentity: string) => Promise<Value>
      ) => {
        await waitForWorkerControlAcknowledgement();
        return withCoreHold(async (coreIdentity) => {
          assertCurrent();
          if (opening.nanoHostTargetTransition)
            throw new ControlStoreWorkerError('busy', 'not-committed');
          opening.nanoHostWritePending = 'target-stable-write';
          try {
            return await publish(coreIdentity);
          } catch (error) {
            if (error instanceof ControlStoreWorkerError && error.commit === 'unknown')
              this.fail(opening.host);
            throw error;
          } finally {
            if (opening.host.failed) await opening.host.exited.promise;
            delete opening.nanoHostWritePending;
          }
        });
      };
      const workerControlFinalStatus: NanoHostOwnerBinding['workerControlFinalStatus'] = async (
        input
      ) => {
        const original = structuredClone(input);
        const intake = await withNativeReadForCore((core, openingRequestId, ownerIdentity) =>
          this.workerControlFinalStage(core.command.database, original, {
            kind: 'intake',
            openingRequestId,
            ownerIdentity,
          })
        );
        if (!('kind' in intake) || intake.kind !== 'intake')
          throw new ControlStoreWorkerError('integrity', 'unknown');
        const settled = await writeWorkerObservation((coreIdentity) =>
          this.workerControlFinalStage(database, original, {
            kind: 'settle',
            coreIdentity,
            decision: intake.value,
          })
        );
        if ('kind' in settled) throw new ControlStoreWorkerError('integrity', 'unknown');
        const observed = await withNativeReadForCore((core, openingRequestId, ownerIdentity) =>
          this.workerControlFinalStage(core.command.database, original, {
            kind: 'observe',
            openingRequestId,
            ownerIdentity,
          })
        );
        if (!('kind' in observed) || observed.kind !== 'observe')
          throw new ControlStoreWorkerError('integrity', 'unknown');
        if (observed.value.state !== 'applied' && observed.value.state !== 'inspect-original')
          throw new ControlStoreWorkerError('owner-recovery-required', 'unknown');
        return settled;
      };
      const harnessTurnLifecycle: AdmittedNanoHostHarnessTurnLifecycle = {
        queue: async ({ prepared, body, harnessInstanceId, operation, timestamp }) => {
          const result = await writeHarnessTurn({
            kind: 'operation.queue',
            prepared,
            body,
            harnessInstanceId,
            operation,
            timestamp,
          });
          if (typeof result !== 'number') throw new ControlStoreWorkerError('integrity', 'unknown');
          return result;
        },
        dispatch: async ({ sandboxIntegrationBindingRef, now }) => {
          const hasQueuedOperation = readers.hasQueuedNanoHostHarnessOperation;
          if (!hasQueuedOperation || opening.nanoHostTargetTransition)
            throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
          if (
            opening.nanoHostWritePending === 'target-stable-write' ||
            opening.nanoHostCoreHoldPending
          ) {
            // An in-flight serving write grants this poll no command. Verify only the owner.
            readCurrent(() => undefined, true);
            return null;
          }
          // Empty polls leave the Native and Core writers available to their live producers.
          if (
            !readCurrent((sqlite) => hasQueuedOperation({ sqlite }, sandboxIntegrationBindingRef))
          )
            return null;
          const result = await writeHarnessTurn({
            kind: 'operation.dispatch',
            sandboxIntegrationBindingRef,
            ...(now ? { observedAt: now() } : {}),
          });
          if (typeof result !== 'object') throw new ControlStoreWorkerError('integrity', 'unknown');
          return result;
        },
        settle: async (input) => {
          const result = await writeHarnessTurn({ ...input, kind: 'operation.settle' });
          if (result !== 'settled' && result !== 'replayed')
            throw new ControlStoreWorkerError('integrity', 'unknown');
          return result;
        },
        acknowledge: (input) =>
          withNativeReadForCore(async (core, openingRequestId, ownerIdentity) => {
            const reply = await this.request({
              operation: 'harness-lifecycle',
              database: core.command.database,
              input: { ...input, kind: 'result.acknowledge' },
              nanoHostAckPeer: { openingRequestId, ownerIdentity },
            });
            if (reply.operation !== 'harness-lifecycle' || reply.result !== null)
              throw new ControlStoreWorkerError('integrity', 'unknown');
          }),
      };

      opening.prepareNanoHostBackend = async (input) => {
        const original = structuredClone(input);
        if (original.kind === 'handoff') {
          return withCoreHold(
            async () => (await write({ kind: 'backend-session', input: original })).value
          );
        }
        if (original.kind === 'transition') {
          return (await write({ kind: 'backend-session', input: original })).value;
        }
        return withCoreHold(
          async (coreIdentity) =>
            (
              await write({
                kind: 'backend-session-materialize',
                input: original,
                coreIdentity,
              })
            ).value
        );
      };

      const writeUnavailable = (error: unknown): StorageUnavailable<'nanohost'> =>
        error instanceof ControlStoreWorkerError &&
        error.code === 'unavailable' &&
        error.commit === 'not-committed' &&
        !gate.enabled()
          ? disabled
          : serverOwnerUnavailable(owner, error);

      const result = async <Value>(
        readOrWrite: () => Promise<Value>
      ): Promise<StorageResult<'nanohost', Value>> => {
        try {
          return { state: 'ready', value: await readOrWrite() };
        } catch (error) {
          return writeUnavailable(error);
        }
      };
      const epoch: NanoHostRuntimeTargetEpochStore = {
        beginEpochRetirement: (input) =>
          result(async () => {
            await write({ kind: 'begin-retirement', input });
          }),
        stageEpochInvalidation: (input) =>
          result(async () => {
            await write({ kind: 'stage-invalidation', input });
          }),
        settleEpochInvalidation: (input) =>
          result(async () => {
            await write({ kind: 'settle-invalidation', input });
          }),
        readEpochInvalidation: async (requestId) =>
          read((handle) => readers.readNanoHostEpochInvalidation(handle, requestId)),
        inspectRuntimeTargetTransition: async (original) => {
          const inspected = read((handle) =>
            readers.inspectNanoHostRuntimeTargetTransition(handle, original)
          );
          return inspected.state === 'ready' ? inspected.value : inspected;
        },
        mutateRuntimeTarget: async (original) => {
          try {
            return (await write({ kind: 'runtime-target', input: original })).value;
          } catch (error) {
            return writeUnavailable(error);
          }
        },
      };

      return {
        state: 'ready',
        value: {
          transport: async (input) => (await write({ kind: 'transport', input })).value,
          enrollTransport,
          readWorkerCompletion,
          readRuntimeTarget,
          firstSubmission,
          harnessTurnLifecycle,
          writeIdleHarnessDrain: async (input) => {
            await waitForWorkerControlAcknowledgement();
            const result = await writeHarnessTurn(input);
            if (result !== null) throw new ControlStoreWorkerError('integrity', 'unknown');
          },
          releaseTerminalScopes,
          writeStorageAttachment,
          waitForWorkerControlAcknowledgement,
          workerControlHeartbeat: (input) => {
            const original = structuredClone(input);
            return writeWorkerObservation((identity) =>
              this.workerControlHeartbeat(database, original, identity)
            );
          },
          workerControlRecord: (input) => {
            const original = structuredClone(input);
            return writeWorkerObservation((identity) =>
              this.workerControlRecord(database, original, identity)
            );
          },
          workerControlFinalStatus,
          harnessLifecycle: async (input) => {
            await write({ kind: 'harness-lifecycle', input });
          },
          workerImage: async (input) => {
            await write({ kind: 'worker-image', input });
          },
          settlePreparedImage: async (input) => {
            await write({ kind: 'prepared-image-result', input });
          },
          backendSession: async (input) => (await write({ kind: 'backend-session', input })).value,
          closeRecovery: async ({ lease, session, proof, cause, observedAt, outcomeRef }) => {
            let nativeHeld = false;
            try {
              readCurrent(() => undefined);
              if (opening.nanoHostTargetTransition || !opening.identity)
                throw new ControlStoreWorkerError('busy', 'not-committed');
              const coreKey = `core:${coreDbPath(root)}`;
              const core = this.openings.get(coreKey);
              if (!core?.acknowledged || core.openingRequestId === undefined)
                return { state: 'unavailable', owner: 'control-kernel', reason: 'missing' };
              const identity = opening.identity;
              const coreOpeningRequestId = core.openingRequestId;
              const scope = this.workspaceMutations(root);
              const workspaceId = lease.attempt.workspaceId;
              const release = this.enterScope(scope, workspaceId, 'capture');
              if (!release) throw new ControlStoreWorkerError('busy', 'not-committed');
              opening.nanoHostWritePending = true;
              nativeHeld = true;
              try {
                return await this.runOperation(
                  async () => {
                    const reply = await this.request({
                      operation: 'execution-attempt',
                      database: coreKey,
                      input: {
                        kind: 'closing',
                        attemptId: lease.grant.attemptId,
                        cause,
                        observedAt,
                        ...(outcomeRef === undefined ? {} : { outcomeRef }),
                      },
                      nanoHostRecoveryClose: {
                        coreOpeningRequestId,
                        ownerIdentity: identity,
                        expectedPhase: lease.attempt.phase,
                        observationHash: hashNanoHostRecoveryObservation({ lease, session, proof }),
                      },
                    });
                    const value = (reply as Extract<Success, { operation: 'execution-attempt' }>)
                      .result;
                    if (
                      !value ||
                      value.phase === 'open' ||
                      value.attemptId !== lease.grant.attemptId ||
                      value.operationId !== lease.grant.operationId
                    )
                      throw new ControlStoreWorkerError('owner-recovery-required', 'unknown');
                    return { state: 'ready', value };
                  },
                  undefined,
                  database,
                  undefined,
                  undefined,
                  { owner: scope, workspaceId, release },
                  core.command
                );
              } finally {
                release();
              }
            } catch (error) {
              return serverOwnerUnavailable(nativeHeld ? 'control-kernel' : owner, error);
            } finally {
              if (nativeHeld) delete opening.nanoHostWritePending;
            }
          },
          classifyRecovery: async (input) => {
            const { lease, expectedSession, expectedRecovery, observedAt, ...classification } =
              structuredClone(input);
            const closeout =
              classification.kind !== 'arm-reconnect' && classification.kind !== 'needs-evidence';
            const coreKey = `core:${coreDbPath(root)}`;
            const core = this.openings.get(coreKey);
            const coreIdentity = core?.identity;
            if (!core?.acknowledged || !coreIdentity)
              return { state: 'unavailable', owner: 'control-kernel', reason: 'missing' };
            const expectedPhase = lease.attempt.phase;
            if (expectedPhase === 'closed' || (closeout && expectedPhase !== 'closing'))
              return { state: 'unavailable', owner: 'control-kernel', reason: 'recovery-required' };
            const scope = this.workspaceMutations(root);
            const workspaceId = lease.attempt.workspaceId;
            const release = this.enterScope(scope, workspaceId, 'capture');
            if (!release) return { state: 'unavailable', owner, reason: 'recovery-required' };
            try {
              const commit = (identity: string) =>
                result(
                  async () =>
                    (
                      await write({
                        kind: 'recovery-classification',
                        input: {
                          dataRoot: root,
                          coreIdentity: identity,
                          attemptId: lease.grant.attemptId,
                          expectedPhase,
                          observationHash: hashNanoHostRecoveryObservation({
                            lease,
                            session: expectedSession,
                            proof: expectedRecovery,
                          }),
                          expectedSession,
                          expectedRecovery,
                          observedAt,
                          classification,
                        },
                      })
                    ).value
                );
              return await this.runOperation(
                () => (closeout ? withCoreHold(commit) : commit(coreIdentity)),
                undefined,
                coreKey,
                undefined,
                undefined,
                { owner: scope, workspaceId, release },
                opening.command
              );
            } catch (error) {
              return serverOwnerUnavailable(owner, error);
            } finally {
              release();
            }
          },
          workerStorageBinding: async (input) =>
            (await write({ kind: 'worker-storage-binding', input })).value,
          prepareRuntimeTarget: async (input, occurrenceId) =>
            read((handle) =>
              readers.prepareNanoHostRuntimeTargetTransition(handle, input, occurrenceId)
            ),
          transitionRuntimeTarget: async (kernel, original) => {
            if (!gate.enabled()) return disabled;
            if (this.backupHold || opening.nanoHostTargetTransition)
              return serverOwnerUnavailable(
                owner,
                new ControlStoreWorkerError('busy', 'not-committed')
              );
            opening.nanoHostTargetTransition = true;
            try {
              return await this.runOperation(
                () => transitionNanoHostRuntimeTarget(epoch, kernel, original),
                undefined,
                database
              );
            } catch (error) {
              return serverOwnerUnavailable(owner, error);
            } finally {
              delete opening.nanoHostTargetTransition;
            }
          },
          beginEpochRetirement: epoch.beginEpochRetirement,
          stageEpochInvalidation: epoch.stageEpochInvalidation,
          settleEpochInvalidation: epoch.settleEpochInvalidation,
          readEpochInvalidation: epoch.readEpochInvalidation,
          readPendingEpochRetirement: async () => read(readers.readPendingNanoHostEpochRetirement),
          listTransportTokens: async () =>
            read((handle) => readers.listNanoHostTransportTokenRecords({ sqlite: handle })),
          read,
        },
      };
    } catch (error) {
      return serverOwnerUnavailable(owner, error);
    }
  }

  /** Closes intake before waiting so accepted producers can finish their original ACKs. */
  private holdCommunicationProducers(): (() => void) | null {
    if (this.communicationProducerHold) return null;
    this.communicationProducerHold = true;
    return () => {
      this.communicationProducerHold = false;
      for (const opening of this.openings.values()) opening.communicationRelayWake?.();
    };
  }

  /** Supplies the exact Core reservation and receipt for a Native retirement, including boot. */
  nanoHostEpochKernel(db: CoreDb): NanoHostRuntimeTargetEpochKernel {
    const database = `core:${serverStoragePath(db.dataRoot, 'control-kernel')}`;
    const unavailable = {
      state: 'unavailable',
      owner: 'control-kernel',
      reason: 'recovery-required',
    } as const;
    const readOwnerIdentity = () => {
      const path = serverStoragePath(db.dataRoot, 'nanohost');
      const ownerKey = `server-owner:${path}`;
      const opening = this.openings.get(ownerKey);
      const admitted = this.operationContext.getStore();
      return opening?.acknowledged &&
        opening.command.serverOwner?.owner === 'nanohost' &&
        !opening.host.failed &&
        (!opening.retirement || (admitted?.active && admitted.reservation === ownerKey))
        ? opening.identity
        : undefined;
    };
    const post = async (
      input: NanoHostEpochKernelInput
    ): Promise<StorageResult<'control-kernel', NanoHostEpochKernelReply>> => {
      const core = this.openings.get(database);
      if (
        !core?.acknowledged ||
        core.path !== db.sqlite.name ||
        core.command.initialize !== 'core' ||
        core.openingRequestId === undefined ||
        core.host.failed ||
        core.retirement
      )
        return unavailable;
      try {
        const reply = await this.request({
          operation: 'nanohost-epoch-kernel',
          database,
          openingRequestId: core.openingRequestId,
          input,
        });
        if (reply.operation !== 'nanohost-epoch-kernel' || reply.result.kind !== input.kind)
          return unavailable;
        return { state: 'ready', value: reply.result };
      } catch (error) {
        return serverOwnerUnavailable('control-kernel', error);
      }
    };
    return {
      reserveHolderIntent: async (placement) => {
        const identity = readOwnerIdentity();
        if (!identity) return unavailable;
        const result = await post({
          kind: 'reserve',
          placement,
          ownerIdentity: identity,
        });
        if (result.state !== 'ready') return result;
        if (result.value.kind !== 'reserve' || result.value.value.state !== 'settled')
          return unavailable;
        return { state: 'ready', value: result.value.value.receipt };
      },
      fenceNanoHostEpoch: async (intent) => {
        const identity = readOwnerIdentity();
        if (!identity) return unavailable;
        const result = await post({ kind: 'fence', intent, ownerIdentity: identity });
        if (result.state !== 'ready') return result;
        return result.value.kind === 'fence'
          ? { state: 'ready', value: result.value.value }
          : unavailable;
      },
      inspectNanoHostEpochFence: async (intent) => {
        const result = await post({ kind: 'inspect', intent });
        if (result.state !== 'ready') return result;
        return result.value.kind === 'inspect'
          ? { state: 'ready', value: result.value.value }
          : unavailable;
      },
    };
  }

  /** Covers the six Communication receipt operations on the existing admitted Core writer. */
  communicationKernel(db: CoreDb): CommunicationKernel {
    const core = nativeProductScope(db.dataRoot, { kind: 'server' });
    const database = `core:${core.path}`;
    const unavailable = {
      state: 'unavailable',
      owner: 'control-kernel',
      reason: 'recovery-required',
    } as const;
    const currentCore = () => {
      const opening = this.openings.get(database);
      return opening?.acknowledged &&
        opening.path === db.sqlite.name &&
        !opening.host.failed &&
        !opening.retirement
        ? opening
        : undefined;
    };
    const post = async <Kind extends CommunicationKernelInput['kind']>(
      input: CommunicationKernelInput & { kind: Kind }
    ): Promise<StorageResult<'control-kernel', CommunicationKernelValues[Kind]>> => {
      const coreOpening = currentCore();
      const lease = this.communicationLease.getStore();
      const communication = lease && this.openings.get(lease.database);
      if (
        coreOpening?.openingRequestId === undefined ||
        !lease?.active ||
        !communication?.acknowledged ||
        communication.command.serverOwner?.owner !== 'communication' ||
        communication.command.dataRoot !== db.dataRoot ||
        !communication.identity ||
        communication.host.failed ||
        communication.retirement
      )
        return unavailable;
      try {
        const reply = await this.request({
          operation: 'communication-kernel',
          database,
          openingRequestId: coreOpening.openingRequestId,
          communicationIdentity: communication.identity,
          input,
        });
        if (reply.operation !== 'communication-kernel' || reply.result.kind !== input.kind)
          throw new ControlStoreWorkerError('invalid-request', 'unknown');
        return {
          state: 'ready',
          value: reply.result.value as CommunicationKernelValues[Kind],
        };
      } catch (error) {
        if (
          error instanceof ControlStoreWorkerError &&
          (error.commit === 'unknown' || error.code === 'integrity')
        )
          this.fail(coreOpening.host);
        return serverOwnerUnavailable('control-kernel', error);
      }
    };

    const inspectChannelInbound: CommunicationKernel['inspectChannelInbound'] = (key) => {
      const { deploymentId, sourceOwner, verb, occurrenceKey } = key;
      return post({ kind: 'inspect', key: { deploymentId, sourceOwner, verb, occurrenceKey } });
    };
    return {
      status: () => (currentCore() ? { state: 'ready', owner: 'control-kernel' } : unavailable),
      reserveChannelInbound: (envelope) => post({ kind: 'reserve', envelope }),
      bindChannelInboundOrigin: (origin) => post({ kind: 'bind', origin }),
      inspectChannelInbound,
      settleChannelInbound: async (envelope, outcome) => {
        if (outcome.kind === 'handled') return post({ kind: 'settle', envelope, outcome });
        const original = await inspectChannelInbound(envelope);
        if (original.state !== 'ready') return original;
        if (original.value.state === 'settled') return post({ kind: 'settle', envelope, outcome });
        if (original.value.state !== 'origin-bound')
          return { state: 'ready', value: { state: 'unknown' } };
        const release = this.enterWorkspaceMutation(db.dataRoot, original.value.origin.workspaceId);
        if (!release) return unavailable;
        try {
          return await post({ kind: 'settle', envelope, outcome });
        } finally {
          release();
        }
      },
      relayPairingAudit: async (intent, event) => {
        const parsed = PairingAuditIntentSchema.safeParse(intent);
        return parsed.success
          ? post({ kind: 'relay-audit', intent: parsed.data, event })
          : unavailable;
      },
      inspectPairingAudit: async (intent) => {
        const parsed = PairingAuditIntentSchema.safeParse(intent);
        return parsed.success ? post({ kind: 'inspect-audit', intent: parsed.data }) : unavailable;
      },
    };
  }

  /** Binds the staged owner only after both lifecycle and the production receipt adapter qualify. */
  async bindCommunicationOwner(input: {
    readonly coreDb: CoreDb;
    readonly kernel?: CommunicationKernel;
    readonly dependencies: CommunicationOwnerDependencies;
  }): Promise<
    CommunicationResult<CommunicationOwnerBinding> | StorageUnavailable<'control-kernel'>
  > {
    const { coreDb, kernel, dependencies } = input;
    if (!kernel) return { state: 'unavailable', owner: 'control-kernel', reason: 'missing' };
    const kernelStatus = kernel.status();
    if (kernelStatus.state !== 'ready') return kernelStatus;
    const owner = 'communication';
    let claimedOpening: Opening | undefined;
    let readConnection: Database.Database | undefined;
    let bound = false;
    try {
      const {
        observeAuthority,
        createCommunicationDiscord,
        readPendingPairingAuditInDb,
        relayNextPairingAudit,
        CommunicationWriterCommandSchema,
        CommunicationWriterReplySchema,
      } = dependencies;
      const root = await realpath(coreDb.dataRoot);
      const opened = await this.openServerOwner(root, communicationOwner);
      if (opened.state !== 'ready') return opened;

      const database = `server-owner:${serverStoragePath(root, owner)}`;
      const opening = this.openings.get(database);
      const openingRequestId = opening?.openingRequestId;
      const cell = opening?.command.communicationExpiryPolicy;
      if (
        !opening?.acknowledged ||
        openingRequestId === undefined ||
        !cell ||
        opening.command.serverOwner?.owner !== owner ||
        opening.communicationRelayWake ||
        opening.communicationBindingPending
      )
        return communicationHeld;
      opening.communicationBindingPending = true;
      claimedOpening = opening;
      const sqlite = await this.openAcknowledgedServerOwnerReadDb(database, owner, opening);
      readConnection = sqlite;
      const policy = new BigInt64Array(cell);
      const deploymentId = readDataRootLayoutMarker(root).deploymentId;
      const available = () =>
        (!this.stopping || this.communicationLease.getStore()?.active === true) &&
        !opening.host.failed &&
        !opening.retirement &&
        this.openings.get(database) === opening &&
        sqlite.open;
      const status = (): StorageStatus<'communication'> =>
        available() ? { state: 'ready', owner } : communicationHeld;
      const read = <Value>(
        query: (database: Database.Database) => Value
      ): CommunicationResult<Value> =>
        available() ? { state: 'ready', value: query(sqlite) } : communicationHeld;

      const withProducer: CommunicationOwnerBinding['withProducer'] = async (effect) => {
        if (this.stopping || this.communicationProducerHold || !available())
          return communicationHeld;
        const lease = { database, retention: false, active: true };
        const accepted = this.runOperation(() => this.communicationLease.run(lease, effect));
        this.communicationProducers.add(accepted);
        try {
          return { state: 'ready', value: await accepted };
        } finally {
          lease.active = false;
          this.communicationProducers.delete(accepted);
        }
      };

      const write = async <Command extends CommunicationWriterCommand, Value>(
        mutation: Command,
        value: (reply: Extract<CommunicationWriterReply, { stage: Command['stage'] }>) => Value
      ): Promise<CommunicationResult<Value>> => {
        const lease = this.communicationLease.getStore();
        if (
          !available() ||
          !lease?.active ||
          lease.database !== database ||
          lease.retention !== (mutation.stage === 'discord-retention')
        )
          return communicationHeld;
        try {
          const json = JSON.stringify(CommunicationWriterCommandSchema.parse(mutation));
          const reply = await this.request(
            {
              operation: 'communication-owner',
              database,
              openingRequestId,
              stage: mutation.stage,
              input: frameControlScalarText(json),
              content: new ArrayBuffer(0),
            },
            [json]
          );
          const decoded =
            reply.operation === 'communication-owner'
              ? CommunicationWriterReplySchema.safeParse(reply.result)
              : null;
          if (!decoded?.success || decoded.data.stage !== mutation.stage)
            throw new ControlStoreWorkerError('invalid-request', 'unknown');
          return {
            state: 'ready',
            value: value(
              decoded.data as Extract<CommunicationWriterReply, { stage: Command['stage'] }>
            ),
          };
        } catch (error) {
          if (error instanceof ControlStoreWorkerError) {
            if (error.commit === 'unknown' || error.code === 'integrity') this.fail(opening.host);
            if (
              error.commit === 'not-committed' &&
              error.domain?.operation === 'communication-owner'
            ) {
              const { code, message, status, kind } = error.domain;
              if (kind === 'attention')
                throw new AttentionError(code as ConstructorParameters<typeof AttentionError>[0]);
              throw new OperationError(code, message, status);
            }
          }
          return serverOwnerUnavailable(owner, error);
        }
      };
      const noValue = () => undefined;
      const settleReceipt = (
        stage: 'settle-origin' | 'settle-handled' | 'settle-pairing-audit',
        input: unknown
      ) => write(CommunicationWriterCommandSchema.parse({ stage, input }), noValue);
      const writer: CommunicationDiscordWrites = {
        stageEnvelope: (envelope, externalAccountId) =>
          write(
            { stage: 'stage-envelope', envelope, externalAccountId },
            (reply) => reply.admission
          ),
        issueChallenge: (input, authority) =>
          write({ stage: 'issue-challenge', input, authority }, noValue),
        revokeChallenges: (userId, authority) =>
          write({ stage: 'revoke-challenges', input: { userId }, authority }, noValue),
        pair: (input, authority) =>
          write({ stage: 'pair', input, authority }, (reply) => reply.change),
        unbind: (input, authority) =>
          write({ stage: 'unbind', input, authority }, (reply) => reply.change),
        writeDisclosure: (input, authority) =>
          write({ stage: 'write-disclosure', input, authority }, noValue),
        claimOrigin: (input) => write({ stage: 'claim-origin', input }, (reply) => reply.claimed),
        settleInbound: (input) => settleReceipt('settle-origin', input),
        settleHandled: (input) => settleReceipt('settle-handled', input),
        settleRefusal: (input) => write({ stage: 'settle-refusal', input }, noValue),
        applyRetention: async (input, authority) => {
          const applied = await write(
            { stage: 'discord-retention', input, authority },
            (reply) => reply.acknowledgement
          );
          if (applied.state !== 'ready') return applied;
          return applied.value === null
            ? { state: 'unavailable', owner, reason: 'disabled' }
            : { state: 'ready', value: applied.value };
        },
      };
      const withAuthority: WithPairingAuthority = async ({ userId, actor }, post) => {
        const scope = nativeProductScope(root, { kind: 'server' });
        const coreKey = `core:${scope.path}`;
        const admitted = this.openings.get(coreKey);
        if (!admitted?.acknowledged || coreDb.sqlite.name !== scope.path || this.backupHold)
          return communicationHeld;
        // Only Core postings are held. The exact Communication write can commit and ACK independently.
        const resume = await this.pauseForDataRootBackup(coreKey);
        try {
          if (
            kernel.status().state !== 'ready' ||
            admitted.host.failed ||
            this.openings.get(coreKey) !== admitted
          )
            return communicationHeld;
          return await post(observeAuthority({ userId, ...(actor ? { actor } : {}) }));
        } finally {
          resume();
        }
      };
      let relayRequested = false;
      let relaying = false;
      function wakePairingAudit() {
        relayRequested = true;
        tryStartRelay();
      }
      const tryStartRelay = () => {
        if (
          !relayRequested ||
          relaying ||
          this.communicationProducerHold ||
          !available() ||
          kernel.status().state !== 'ready'
        )
          return;
        relayRequested = false;
        relaying = true;
        void withProducer(async () => {
          do {
            const result = await relayNextPairingAudit(
              {
                readPendingPairingAudit: async () => read(readPendingPairingAuditInDb),
                settlePairingAudit: (input) => settleReceipt('settle-pairing-audit', input),
              },
              kernel
            );
            if (result.state !== 'ready' || result.value !== 'relayed') return;
          } while (available() && kernel.status().state === 'ready');
        })
          .catch(() => undefined)
          .finally(() => {
            relaying = false;
            tryStartRelay();
          });
      };
      const readExpiryAgeMs = () => {
        const value = Atomics.load(policy, 0);
        return value === 0n ? undefined : Number(value);
      };
      const communication = createCommunicationDiscord({
        status,
        read,
        writer,
        withAuthority,
        kernel,
        pairingAuditReady: wakePairingAudit,
        retention: {
          readExpiryAgeMs,
          withProducerDrain: async (post) => {
            if (this.communicationLease.getStore()?.active) return communicationHeld;
            const resume = this.holdCommunicationProducers();
            if (!resume) return communicationHeld;
            const lease = { database, retention: true, active: true };
            try {
              return await this.runOperation(async () => {
                await Promise.allSettled(this.communicationProducers);
                if (!available()) return communicationHeld;
                return this.communicationLease.run(lease, post);
              });
            } finally {
              lease.active = false;
              resume();
            }
          },
        },
      });
      const attention: CommunicationAttentionOwner = {
        read,
        enqueue: (input) => write({ stage: 'enqueue-attention', input }, (reply) => reply.delivery),
        claim: (input) => write({ stage: 'claim-attention', input }, (reply) => reply.delivery),
        settle: (input) => write({ stage: 'settle-attention', input }, noValue),
        reconcile: async () => {
          const admitted = await withProducer(() =>
            write({ stage: 'reconcile-attention' }, (reply) => reply.changes)
          );
          return admitted.state === 'ready' ? admitted.value : admitted;
        },
        withWorkspace: async (workspaceId, effect) => {
          const admitted = await withProducer(async () => {
            const release = this.enterWorkspaceMutation(root, workspaceId);
            if (!release) return communicationHeld;
            try {
              return { state: 'ready' as const, value: await effect() };
            } finally {
              release();
            }
          });
          return admitted.state === 'ready' ? admitted.value : admitted;
        },
      };
      const reconciled = await attention.reconcile();
      if (reconciled.state !== 'ready') return reconciled;
      opening.communicationReader = sqlite;
      opening.communicationRelayWake = tryStartRelay;
      bound = true;
      return {
        state: 'ready',
        value: {
          owners: { deploymentId, kernel, communication, attention },
          withProducer,
          wakePairingAudit,
          setExpiryAgeMs: (ageMs) => {
            if (!available()) throw new ServerOwnerAdmissionError('recovery-required');
            if (ageMs !== undefined && (!Number.isSafeInteger(ageMs) || ageMs <= 0))
              throw new TypeError('Communication expiry age must be a positive safe integer.');
            Atomics.store(policy, 0, BigInt(ageMs ?? 0));
          },
        },
      };
    } catch (error) {
      return serverOwnerUnavailable(owner, error);
    } finally {
      if (claimedOpening) delete claimedOpening.communicationBindingPending;
      if (!bound && readConnection?.open) readConnection.close();
    }
  }

  /** Runs the original kernel-only repair protocol on the acknowledged Core opening. */
  async repairKernelCommand<Kind extends RepairWorkerInput['kind']>(
    db: CoreDb,
    input: RepairWorkerInput & { kind: Kind }
  ): Promise<StorageResult<'control-kernel', RepairReplyValues[Kind]>> {
    const path = serverStoragePath(db.dataRoot, 'control-kernel');
    const database = `core:${path}`;
    const opening = this.openings.get(database);
    const held = {
      state: 'unavailable',
      owner: 'control-kernel',
      reason: 'recovery-required',
    } as const;
    if (
      !opening?.acknowledged ||
      opening.path !== db.sqlite.name ||
      opening.openingRequestId === undefined ||
      opening.command.initialize !== 'core' ||
      opening.host.failed ||
      opening.retirement
    )
      return held;

    const reply = await this.request({
      operation: 'repair-kernel',
      database,
      openingRequestId: opening.openingRequestId,
      input: structuredClone(input),
    });
    if (reply.operation !== 'repair-kernel' || reply.result.kind !== input.kind)
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    return {
      state: 'ready',
      value: reply.result.value as RepairReplyValues[Kind],
    };
  }

  /** Sends original Server-work decisions to the admitted Core writer and permits exact inspection. */
  serverWorkKernel(db: CoreDb): ServerWorkKernel {
    const corePath = serverStoragePath(db.dataRoot, 'control-kernel');
    const database = `core:${corePath}`;
    const ownerKey = `server-owner:${serverStoragePath(db.dataRoot, 'server-work')}`;
    const unavailable = {
      state: 'unavailable',
      owner: 'control-kernel',
      reason: 'recovery-required',
    } as const;
    const currentCore = () => {
      const core = this.openings.get(database);
      return core?.acknowledged &&
        core.path === db.sqlite.name &&
        core.openingRequestId !== undefined &&
        core.command.initialize === 'core' &&
        !core.host.failed &&
        !core.retirement
        ? { openingRequestId: core.openingRequestId }
        : undefined;
    };
    const post = async (
      input: ServerWorkKernelInput
    ): Promise<StorageResult<'control-kernel', StorageReceiptLookup<ServerWorkReceipt>>> => {
      const core = currentCore();
      if (!core) return unavailable;
      try {
        const reply = await this.request({
          operation: 'server-work-kernel',
          database,
          openingRequestId: core.openingRequestId,
          input,
        });
        if (
          reply.operation !== 'server-work-kernel' ||
          reply.result.kind !== input.kind ||
          (reply.result.value.state === 'settled' &&
            !isDeepStrictEqual(reply.result.value.receipt.intent, input.intent))
        )
          throw new ControlStoreWorkerError('invalid-request', 'unknown');
        return {
          state: 'ready',
          value: reply.result.value,
        };
      } catch (error) {
        if (error instanceof ControlStoreWorkerError && error.commit === 'unknown') throw error;
        return serverOwnerUnavailable('control-kernel', error);
      }
    };
    return {
      status: () => (currentCore() ? { state: 'ready', owner: 'control-kernel' } : unavailable),
      decideServerWork: async <Intent extends ServerWorkIntent>(intent: Intent) => {
        const producer = this.operationContext.getStore();
        const owner = this.openings.get(ownerKey);
        if (
          !producer?.active ||
          producer.reservation !== ownerKey ||
          !owner?.acknowledged ||
          owner.command.serverOwner?.owner !== 'server-work' ||
          owner.host.failed ||
          owner.retirement ||
          !owner.identity
        )
          return unavailable;
        const result = await post({
          kind: 'decide',
          intent,
          ownerIdentity: owner.identity,
        });
        // The private wire reply above compares the complete original intent before narrowing.
        return result as StorageResult<
          'control-kernel',
          StorageDecision<ServerWorkReceipt<Intent>>
        >;
      },
      inspectServerWork: async <Intent extends ServerWorkIntent>(intent: Intent) =>
        (await post({ kind: 'inspect', intent })) as StorageResult<
          'control-kernel',
          StorageReceiptLookup<ServerWorkReceipt<Intent>>
        >,
    };
  }

  /** Binds Server-work methods to the existing-only acknowledged owner and optional Core authority. */
  async bindServerWorkOwner(
    dataRoot: string,
    readers?: ServerWorkOwnerReaders,
    core?: ServerWorkCoreReaders
  ): Promise<StorageResult<'server-work', ServerWorkOwnerBinding>> {
    const { owner } = serverWorkStorageDescriptor;
    const disabled = { state: 'unavailable', owner, reason: 'disabled' } as const;
    try {
      const root = await realpath(dataRoot);
      const status = await this.openServerOwner(root, serverWorkStorageDescriptor);
      if (status.state !== 'ready') return status;
      const database = `server-owner:${serverStoragePath(root, owner)}`;
      const opening = this.openings.get(database);
      const openingRequestId = opening?.openingRequestId;
      if (
        !opening?.acknowledged ||
        opening.command.serverOwner?.owner !== owner ||
        openingRequestId === undefined
      )
        throw new ServerOwnerAdmissionError('recovery-required');

      const assertCurrent = () => {
        if (this.stopping || opening.host.failed || this.openings.get(database) !== opening)
          throw new ServerOwnerAdmissionError('recovery-required');
        this.assertScopeProducerAdmission(database);
      };
      assertCurrent();

      const corePath = serverStoragePath(root, 'control-kernel');
      const coreKey = `core:${corePath}`;
      const coreOpening = this.openings.get(coreKey);
      const assertCore = async () => {
        if (
          !coreOpening?.acknowledged ||
          !coreOpening.identity ||
          coreOpening.command.initialize !== 'core' ||
          coreOpening.command.dataRoot !== root ||
          coreOpening.retirement ||
          coreOpening.host.failed ||
          this.stopping ||
          this.openings.get(coreKey) !== coreOpening
        )
          throw new ServerOwnerAdmissionError('recovery-required');
        const [file, path] = await Promise.all([stat(corePath), realpath(corePath)]);
        if (
          !file.isFile() ||
          file.nlink !== 1 ||
          path !== corePath ||
          `${file.dev}:${file.ino}` !== coreOpening.identity ||
          coreOpening.retirement ||
          coreOpening.host.failed ||
          this.stopping ||
          this.openings.get(coreKey) !== coreOpening
        )
          throw new ServerOwnerAdmissionError('recovery-required');
      };
      const result = async <Value>(
        operation: () => Promise<Value>
      ): Promise<StorageResult<'server-work', Value>> => {
        try {
          return { state: 'ready', value: await operation() };
        } catch (error) {
          if (error instanceof ItemDeltaProtocolError) throw error;
          return serverOwnerUnavailable(owner, error);
        }
      };
      const read = <Value>(
        query: (sqlite: Database.Database, readers: ServerWorkOwnerReaders) => Value
      ) =>
        readers
          ? result(async () => {
              assertCurrent();
              const sqlite = await this.openAcknowledgedServerOwnerReadDb(database, owner, opening);
              try {
                assertCurrent();
                return query(sqlite, readers);
              } finally {
                sqlite.close();
              }
            })
          : Promise.resolve(disabled);
      const write = async <Kind extends ServerWorkOwnerMutation['kind']>(
        mutation: ServerWorkOwnerMutation & { kind: Kind },
        bodies?: readonly Uint8Array[]
      ): Promise<Extract<ServerWorkOwnerMutationResult, { kind: Kind }>> => {
        assertCurrent();
        try {
          const reply = (await this.request(
            {
              operation: 'server-work-owner',
              database,
              openingRequestId,
              mutation,
            },
            bodies
          )) as Extract<Success, { operation: 'server-work-owner' }>;
          return reply.result as Extract<ServerWorkOwnerMutationResult, { kind: Kind }>;
        } catch (error) {
          if (
            error instanceof ControlStoreWorkerError &&
            (error.commit === 'unknown' || error.code === 'integrity')
          )
            this.fail(opening.host);
          throw error;
        }
      };

      const inspectOriginal = async <Intent extends ServerWorkIntent>(intent: Intent) => {
        if (!core?.inspectServerWork) throw new ServerOwnerAdmissionError('recovery-required');
        assertCurrent();
        await assertCore();
        const inspected = structuredClone(await core.inspectServerWork(structuredClone(intent)));
        await assertCore();
        if (inspected.state === 'unavailable')
          throw new ServerOwnerAdmissionError(
            inspected.reason === 'disabled' ? 'recovery-required' : inspected.reason
          );
        if (
          inspected.value.state !== 'settled' ||
          !isDeepStrictEqual(inspected.value.receipt.intent, intent)
        )
          throw new ControlStoreWorkerError('precondition', 'not-committed');
        return inspected.value.receipt;
      };

      const requireOriginal = async (receipt: ServerWorkReceipt) => {
        if (!isDeepStrictEqual(await inspectOriginal(receipt.intent), receipt))
          throw new ControlStoreWorkerError('precondition', 'not-committed');
      };

      const readOriginalContainment = async (
        evidenceId: string
      ): Promise<StorageResult<'control-kernel', ServerEvidenceBundleRecord | null>> => {
        if (!core?.readContainmentEvidenceHandoff)
          return { state: 'unavailable', owner: 'control-kernel', reason: 'disabled' };
        try {
          await assertCore();
          const reader = openCoreReadDb(root);
          try {
            if (reader.sqlite.name !== corePath)
              throw new ServerOwnerAdmissionError('recovery-required');
            const value = structuredClone(core.readContainmentEvidenceHandoff(reader, evidenceId));
            await assertCore();
            return { state: 'ready', value };
          } finally {
            reader.sqlite.close();
          }
        } catch (error) {
          return {
            state: 'unavailable',
            owner: 'control-kernel',
            reason: error instanceof ServerOwnerAdmissionError ? error.reason : 'recovery-required',
          };
        }
      };

      return {
        state: 'ready',
        value: {
          status: () => {
            try {
              assertCurrent();
              return { state: 'ready', owner };
            } catch (error) {
              return serverOwnerUnavailable(owner, error);
            }
          },
          stage: async (intent, payload) => {
            const mutation = { kind: 'stage', intent: structuredClone(intent), payload } as const;
            if (!core?.inspectServerWork || !readers) return disabled;
            return result(async () => {
              await assertCore();
              await write(mutation);
              return mutation.intent;
            });
          },
          settle: async (receipt) => {
            const mutation = { kind: 'settle', receipt: structuredClone(receipt) } as const;
            if (!core?.inspectServerWork || !readers) return disabled;
            return result(async () => {
              await requireOriginal(mutation.receipt);
              await write(mutation);
            });
          },
          claimCallContact: async (receipt) => {
            const mutation = { kind: 'claim-contact', receipt: structuredClone(receipt) } as const;
            if (!core?.inspectServerWork || !readers) return disabled;
            return result(async () => {
              await requireOriginal(mutation.receipt);
              try {
                return (await write(mutation)).value;
              } catch (error) {
                if (error instanceof ControlStoreWorkerError && error.commit === 'unknown')
                  return { state: 'inspect-original' as const };
                throw error;
              }
            });
          },
          stageKnowledge: (input) => {
            const mutation = { kind: 'stage-knowledge', input: structuredClone(input) } as const;
            if (!core?.inspectServerWork || !readers) return Promise.resolve(disabled);
            return result(async () => {
              await assertCore();
              return (await write(mutation)).value;
            });
          },
          readUsageIds: (receipt) => {
            const original = structuredClone(receipt);
            return read((sqlite, readers) => readers.readServerCallUsageIds(sqlite, original));
          },
          writeRouteLineage: (receipt, { logicalModelId, entry, entryIndex }) => {
            const mutation = {
              kind: 'write-route-lineage',
              receipt: structuredClone(receipt),
              input: structuredClone({
                logicalModelId,
                entry,
                ...(entryIndex === undefined ? {} : { entryIndex }),
              }),
            } as const;
            if (!core?.inspectServerWork || !readers) return Promise.resolve(disabled);
            return result(async () => {
              await requireOriginal(mutation.receipt);
              return (await write(mutation)).value;
            });
          },
          publishTurnProgress: (admission, input) => {
            const mutation = {
              kind: 'publish-turn-progress',
              admission: structuredClone(admission),
              input: structuredClone(input),
            } as const;
            if (!core?.inspectServerWork || !readers) return Promise.resolve(disabled);
            return result(async () => {
              const receipt = await inspectOriginal(mutation.admission);
              if (receipt.disposition !== 'applied')
                throw new ControlStoreWorkerError('precondition', 'not-committed');
              await write(mutation);
            });
          },
          appendObservation: (admission, input) => {
            const { bodies, ...metadata } = input;
            const mutation = {
              kind: 'append-observation',
              admission: structuredClone(admission),
              input: structuredClone({
                ...metadata,
                observation: { ...metadata.observation },
                bodies: bodies.map(({ bytes, ...body }) => ({
                  ...body,
                  byteLength: bytes.byteLength,
                })),
              }),
            } as const;
            if (!core?.inspectServerWork || !readers) return Promise.resolve(disabled);
            return result(async () => {
              const receipt = await inspectOriginal(mutation.admission);
              if (receipt.disposition !== 'applied')
                throw new ControlStoreWorkerError('precondition', 'not-committed');
              return (
                await write(
                  mutation,
                  bodies.map((body) => body.bytes)
                )
              ).value;
            });
          },
          readIntent: (requestId) =>
            read((sqlite, readers) => readers.readServerWorkIntent(sqlite, requestId)),
          readStaged: (requestId) =>
            read((sqlite, readers) => readers.readStagedServerWork(sqlite, requestId)),
          readLocalReceipt: (requestId) =>
            read((sqlite, readers) => readers.readServerWorkLocalReceipt(sqlite, requestId)),
          isPublished: (receipt) => {
            const original = structuredClone(receipt);
            return read((sqlite, readers) => readers.isServerWorkPublished(sqlite, original));
          },
          withProducer: (effect) =>
            result(async () => {
              assertCurrent();
              if (this.backupHold) throw new ServerOwnerAdmissionError('recovery-required');
              const accepted = this.runOperation(effect, undefined, database);
              this.serverWorkProducers.add(accepted);
              try {
                return await accepted;
              } finally {
                this.serverWorkProducers.delete(accepted);
              }
            }),
          publishContainment: async (evidenceId) => {
            if (!readers) return disabled;
            return readers.publishContainmentEvidenceHandoff({
              evidenceId,
              readHandoff: readOriginalContainment,
              store: {
                publish: async (record) => {
                  try {
                    await write({ kind: 'publish-containment', record });
                    return { state: 'ready', value: undefined };
                  } catch (error) {
                    if (
                      error instanceof ServerOwnerAdmissionError ||
                      (error instanceof ControlStoreWorkerError &&
                        [
                          'owner-missing',
                          'owner-unsupported',
                          'owner-recovery-required',
                          'not-open',
                          'no-space',
                          'integrity',
                        ].includes(error.code))
                    )
                      return serverOwnerUnavailable(owner, error);
                    throw error;
                  }
                },
                inspect: (record) =>
                  read((sqlite, readers) =>
                    readers.inspectServerWorkContainmentEvidence(sqlite, record)
                  ),
              },
            });
          },
        },
      };
    } catch (error) {
      return serverOwnerUnavailable(owner, error);
    }
  }

  /** Closes an admitted owner and retains its bytes. */
  async closeServerOwner(dataRoot: string, owner: ServerOwnerDescriptor['owner']): Promise<void> {
    let database = `server-owner:${serverStoragePath(dataRoot, owner)}`;
    if (!this.openings.has(database))
      database = `server-owner:${serverStoragePath(await realpath(dataRoot), owner)}`;
    if (!this.openings.has(database)) return;
    if (owner !== 'communication') {
      await this.close(database);
      return;
    }
    if (this.communicationLease.getStore()?.active)
      throw new ControlStoreWorkerError('busy', 'not-committed');
    const resume = this.holdCommunicationProducers();
    if (!resume) throw new ControlStoreWorkerError('busy', 'not-committed');
    try {
      await Promise.allSettled(this.communicationProducers);
      await this.close(database);
    } finally {
      resume();
    }
  }

  /** Projects owner-local admission failures without failing Core or another owner. */
  private async admitServerOwner<Owner extends ServerOwnerDescriptor['owner']>(
    dataRoot: string,
    descriptor: ServerOwnerDescriptor<Owner>,
    create: boolean,
    migrateServerOwner?: true
  ): Promise<StorageStatus<Owner>> {
    const owner = descriptor.owner;
    try {
      const root = await realpath(dataRoot);
      const path = serverStoragePath(root, owner);
      const database = `server-owner:${path}`;
      const communicationExpiryPolicy =
        owner === 'communication'
          ? (this.openings.get(database)?.command.communicationExpiryPolicy ??
            new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT))
          : undefined;
      await this.admitOpen({
        database,
        path,
        dataRoot: root,
        create,
        serverOwner: { owner },
        ...(migrateServerOwner ? { migrateServerOwner } : {}),
        ...(communicationExpiryPolicy ? { communicationExpiryPolicy } : {}),
      });
      return { state: 'ready', owner };
    } catch (error) {
      return serverOwnerUnavailable(owner, error);
    }
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
    const serverFile = command.serverOwner
      ? await inspectServerOwnerFile(command.dataRoot!, command.serverOwner.owner)
      : undefined;
    this.assertAccepting();
    this.assertFrozenCall({ ...command, operation: 'open' }, recovery);
    const existing = this.openings.get(command.database);
    if (existing) {
      if (command.migrateServerOwner) throw new ServerOwnerAdmissionError('recovery-required');
      if (existing.host.failed) throw new ControlStoreWorkerError('unavailable', 'not-committed');
      if (existing.retirement) {
        // Only preparation admitted before retirement may finish through its original scope drain.
        // New reserved operations and Turn publications are refused before acquiring this context.
        const context = this.operationContext.getStore();
        if (!context?.active || context.reservation !== command.database)
          throw new ControlStoreWorkerError('busy', 'not-committed');
      }
      this.assertParentOpenAdmission(command, existing.path);
      if (command.serverOwner) {
        if (
          existing.acknowledged &&
          (!serverFile || `${serverFile.dev}:${serverFile.ino}` !== existing.identity)
        )
          throw new ServerOwnerAdmissionError('recovery-required');
      }
      if (
        !isDeepStrictEqual(existing.command, command) &&
        !(
          command.serverOwner &&
          isDeepStrictEqual(
            { ...existing.command, create: command.create, migrateServerOwner: undefined },
            { ...command, migrateServerOwner: undefined }
          )
        ) &&
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
    const physical = this.reserveOpening(binding, serverFile);
    this.assertParentOpenAdmission(binding, physical.path);
    const submit = () =>
      this.request({ ...binding, operation: 'open' }, undefined, physical.host, false, recovery);
    const opening: Opening = {
      command: binding,
      ...physical,
      acknowledged: false,
      openingRequestId: undefined,
      policyReads: new Set(),
      promise: (binding.migrateServerOwner
        ? drainMainScopeReadHandles([physical.path]).then(submit)
        : submit()
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
      // An unknown migration may still own the file. Hold its deployment lock through actual exit.
      if (binding.migrateServerOwner && physical.host.failed) await physical.host.exited.promise;
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
    // Existing producers keep their original context/credits; exact recovery keeps its frozen owner.
    if (recovery || this.operationContext.getStore()?.active)
      return this.writeFrozen(database, statements, recovery);
    const opening = this.openings.get(database)?.command;
    const physical = opening?.physicalScope ?? opening?.productOwner;
    if (!opening?.dataRoot || (physical?.kind !== 'workspace' && physical?.kind !== 'app'))
      return this.writeFrozen(database, statements, recovery);
    const owner = this.workspaceMutations(opening.dataRoot);
    const release = this.enterScope(owner, physical.workspaceId, 'capture');
    // Preserve the original typed refusal and its exact binding checks.
    if (!release) return this.writeFrozen(database, statements, recovery);
    return this.runOperation(
      () => this.writeFrozen(database, statements, recovery),
      undefined,
      undefined,
      undefined,
      undefined,
      { owner, workspaceId: physical.workspaceId, release }
    ).finally(release);
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
  async transition(database: string, transition: ControlAdmission): Promise<ControlAdmissionResult>;
  async transition(database: string, transition: ControlCommandReceiptAdmission): Promise<null>;
  async transition(
    database: string,
    transition: Extract<ControlAdmissionInput, { kind: 'knowledge-work' }>
  ): Promise<ControlKnowledgeAdmissionResult>;
  async transition(
    database: string,
    transition: Extract<ControlAdmissionInput, { kind: 'scheduler-work' }>,
    publicationGuard?: ControlStorePublicationGuard
  ): Promise<CoreSchedulerResult>;
  async transition(
    database: string,
    transition: ControlAdmissionInput
  ): Promise<ControlAdmissionResult | ControlKnowledgeAdmissionResult | CoreSchedulerResult | null>;
  async transition(
    database: string,
    transition: ControlAdmissionInput,
    publicationGuard?: ControlStorePublicationGuard
  ): Promise<
    ControlAdmissionResult | ControlKnowledgeAdmissionResult | CoreSchedulerResult | null
  > {
    return this.runOperation(
      async () => {
        const scheduler = 'kind' in transition && transition.kind === 'scheduler-work';
        try {
          // Preserve the original inner scheduler JSON and binary account, not an inline metadata body.
          const json = scheduler
            ? JSON.stringify(transition.input)
            : 'kind' in transition && transition.kind === 'command-receipt'
              ? JSON.stringify(transition)
              : undefined;
          const reply = scheduler
            ? await this.request(
                {
                  operation: 'transition',
                  database,
                  transition: {
                    kind: 'scheduler-work',
                    input: {
                      byteLength: Buffer.byteLength(json!),
                      turnId:
                        transition.input.mode === 'create' ? transition.input.entry.turnId : null,
                    },
                  },
                  content: new ArrayBuffer(0),
                },
                [json!],
                undefined,
                false,
                undefined,
                [],
                undefined,
                undefined,
                publicationGuard,
                transition.input.mode === 'create' ? transition.input.entry.workspaceId : undefined
              )
            : json === undefined
              ? await this.request({
                  operation: 'transition',
                  database,
                  transition: transition as Exclude<
                    ControlAdmissionInput,
                    { kind: 'command-receipt' | 'scheduler-work' }
                  >,
                })
              : await this.request(
                  {
                    operation: 'transition',
                    database,
                    transition: { kind: 'command-receipt', input: frameControlScalarText(json) },
                    content: new ArrayBuffer(0),
                  },
                  [json]
                );
          const result = (reply as Extract<Success, { operation: 'transition' }>).result;
          if (scheduler && !CoreSchedulerResultSchema.safeParse(result).success)
            throw new ControlStoreWorkerError('invalid-request', 'unknown');
          if ('kind' in transition && transition.kind === 'command-receipt' && result !== null)
            throw new ControlStoreWorkerError('invalid-request', 'unknown');
          return result;
        } catch (error) {
          if (
            'kind' in transition &&
            error instanceof ControlStoreWorkerError &&
            error.domain?.operation === 'transition'
          ) {
            if (scheduler && !CoreSchedulerRefusalSchema.safeParse(error.domain).success)
              throw new ControlStoreWorkerError('invalid-request', 'unknown');
            if (scheduler && 'kind' in error.domain) {
              if (error.domain.kind === 'decoder') throw new SyntaxError(error.domain.message);
              if (error.domain.kind === 'transition')
                throw new SchedulerAdmissionTransitionError(
                  error.domain.message,
                  error.domain.code
                );
              throw new OperationError(
                error.domain.code,
                error.domain.message,
                error.domain.status
              );
            }
            if (error.domain.code === 'idempotency_key_conflict')
              throw new IdempotencyKeyConflictError();
            if (
              transition.kind === 'knowledge-work' &&
              (error.domain.code === 'invalid_request' || error.domain.code === 'recovery_required')
            )
              throw new NotebookError(error.domain.code);
          }
          throw error;
        }
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      this.openings.get(database)?.command
    );
  }

  /** Submits a whole non-command product/lifecycle transition; success follows outer FULL COMMIT, never a queued-write acknowledgement. */
  async products(
    database: string,
    transition: ControlProductTransition,
    guard?: ControlStorePublicationGuard
  ): Promise<void> {
    await this.request(
      { operation: 'products', database, transition },
      undefined,
      undefined,
      false,
      undefined,
      [],
      undefined,
      undefined,
      guard
    );
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
    return this.runOperation(
      async () => {
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
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      this.openings.get(database)?.command
    );
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
    return this.runOperation(
      async () => {
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
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      this.openings.get(database)?.command
    );
  }

  /** Publishes or inspects only the actual canonical Core owner's disposable loaded-Policy readiness. */
  async runtimePolicyPublication(
    db: CoreDb,
    value: RuntimePolicyPublicationInput
  ): Promise<RuntimePolicyPublicationResult> {
    return this.runOperation(
      async () => {
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
        const reply = await this.request({
          operation: 'runtime-policy-publication',
          database,
          input,
        });
        return RuntimePolicyPublicationResultSchema.parse(
          (reply as Extract<Success, { operation: 'runtime-policy-publication' }>).result
        );
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      db
    );
  }

  /** The sole new ingress. The ordinary admission callback remains PREPOST. */
  async activateHarnessLoginWithPolicyBorrow(
    coreDb: CoreDb,
    workspaceDb: WorkspaceDb,
    record: ControlVaultMainInputMap['thread-login-activate'],
    beforeSubmit?: () => void | Promise<void>
  ): Promise<null> {
    return this.runOperation(
      async () => {
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
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coreDb
    );
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
    return this.runOperation(
      async () => {
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
          db.scope === 'core'
            ? { kind: 'server' }
            : { kind: 'workspace', workspaceId: db.workspaceId }
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
              throw new OperationError(
                error.domain.code,
                error.domain.message,
                error.domain.status,
                {
                  cause: error,
                }
              );
            if (error.domain.code === 'vault_grant_narrowing')
              throw new VaultGrantNarrowingError(error.domain.status as 400 | 409);
            if (error.domain.code === 'vault_record_format')
              throw new TypeError(error.domain.message, { cause: error });
            throw new Error(error.domain.message, { cause: error });
          }
          throw error;
        }
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      db
    );
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
      admission = this.compatibilityFileAdmission(root);
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
    const opening = this.openings.get(database);
    try {
      return await this.runOperation(
        async () => {
          const owned = ControlAppInputSchema.parse(input);
          const json = JSON.stringify(owned);
          const wire: ControlAppWire = {
            workspaceId: owned.workspaceId,
            appId: owned.appId,
            kind: owned.change.kind,
            byteLength: Buffer.byteLength(json),
            ...(owned.execution ? { turnId: owned.execution.turnId } : {}),
          };
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
                if (!opening || !reply.identity)
                  throw new Error('App replacement identity is missing.');
                const current = statSync(opening.path);
                const identity = `${current.dev}:${current.ino}`;
                if (identity !== reply.identity)
                  throw new Error('App replacement identity changed.');
                opening.identity = identity;
              } catch {
                if (opening) this.fail(opening.host);
                throw new ControlStoreWorkerError('unavailable', 'unknown');
              }
            }
            return reply.result;
          } catch (error) {
            if (
              error instanceof ControlStoreWorkerError &&
              error.domain?.operation === 'app-kernel'
            ) {
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
          }
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        opening?.command
      );
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
    const core = this.openings.get(database);
    const dataRoot = core?.command.dataRoot;
    if (!core?.acknowledged || !dataRoot)
      throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
    const native = `server-owner:${serverStoragePath(dataRoot, 'nanohost')}`;
    const selected = this.openings.get(native);
    if (!selected?.acknowledged || selected.readNanoHost?.(() => true).state !== 'ready')
      throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
    await this.runOperation(
      async () => {
        await this.request({ operation: 'worker-control-evidence', database: native, input });
      },
      undefined,
      native,
      undefined,
      undefined,
      undefined,
      selected.command
    );
  }

  /** Publishes the exact existing presentation tuple under the native byte, Turn and FIFO accounts. */
  async generativePresentation(
    database: string,
    input: ControlGenerativePresentation
  ): Promise<string> {
    return this.runOperation(
      async () => {
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
          return (reply as Extract<Success, { operation: 'generative-presentation' }>)
            .presentationId;
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
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      this.openings.get(database)?.command
    );
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

  /** Initializes or reuses the canonical local User under captured fresh authority and FULL commit. */
  async localIdentity(db: CoreDb, input: ControlLocalIdentity): Promise<string> {
    return this.runOperation(
      async () => {
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
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      db
    );
  }

  /** Consumes exactly the original first-owner tuple through the admitted Core FULL writer. */
  async bootstrapConsume(
    db: CoreDb,
    input: ControlBootstrapConsume
  ): Promise<ControlBootstrapConsumeResult> {
    return this.runOperation(
      async () => {
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
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      db
    );
  }

  /** Ensures only the original startup Bootstrap setting through the admitted Core FULL writer. */
  async bootstrapEnsure(
    db: CoreDb,
    input: ControlBootstrapEnsure
  ): Promise<ControlBootstrapEnsureResult> {
    return this.runOperation(
      async () => {
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
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      db
    );
  }

  /** Performs canonical issue/revoke/rotation through the existing admitted Core FULL writer. */
  async accessTokenLifecycle(
    db: CoreDb,
    input: ControlAccessTokenLifecycle
  ): Promise<ControlAccessTokenLifecycleResult> {
    return this.runOperation(
      async () => {
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
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      db
    );
  }

  /** Executes the closed Server security family on the existing exact Core FULL owner. */
  async securityTrigger(
    db: CoreDb,
    input: ControlSecurityTrigger
  ): Promise<ControlSecurityTriggerResult> {
    return this.runOperation(
      async () => {
        const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
        if (
          db.scope !== 'core' ||
          db.sqlite.name !== scope.path ||
          !ControlSecurityTriggerSchema.safeParse(input).success
        )
          throw new ControlStoreWorkerError('invalid-request', 'not-committed');
        const database = `core:${scope.path}`;
        const admitted = this.openings.get(database);
        try {
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
                this.request({ operation: 'security-trigger', database, input }),
              ])
            )[1];
          } else {
            if (
              admitted.command.path !== scope.path ||
              admitted.command.dataRoot !== db.dataRoot ||
              !isDeepStrictEqual(admitted.command.productOwner, scope.owner)
            )
              throw new ControlStoreWorkerError('invalid-request', 'not-committed');
            reply = await this.request({ operation: 'security-trigger', database, input });
          }
          if (reply.operation !== 'security-trigger')
            throw new ControlStoreWorkerError('invalid-request', 'unknown');
          return reply.result;
        } catch (error) {
          if (
            error instanceof ControlStoreWorkerError &&
            error.commit === 'not-committed' &&
            error.domain?.operation === 'security-trigger'
          )
            throw new SecurityTriggerRefusal(error.domain.code);
          throw error;
        }
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      db
    );
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

  /** Stages exact input at its existing Workspace and returns the reference after FULL commit. */
  async stageWorkspaceQueueInput(
    dataRoot: string,
    draft: {
      readonly workspaceId: string;
      readonly threadId: string;
      readonly turnId: string;
      readonly originalInvocationId: string;
      readonly input: WorkInputRef;
      readonly text: string;
    }
  ): Promise<WorkInputRef> {
    const { text, ...scope } = draft;
    const wire = ControlWorkspaceQueueInputWireSchema.safeParse({
      ...scope,
      ...frameControlScalarText(text),
    });
    if (!wire.success) throw new ControlStoreWorkerError('invalid-request', 'not-committed');

    const target = nativeProductScope(dataRoot, wire.data.input.owner);
    const opening = {
      database: `workspace:${target.path}`,
      path: target.path,
      dataRoot,
      create: false,
      initialize: 'workspace' as const,
      productOwner: target.owner,
      contentMount: target.contentMount,
    };
    return this.runOperation(
      async () => {
        assertScopeAdmitted(dataRoot, 'workspace', wire.data.workspaceId);
        const admitted = this.openings.get(opening.database);
        await this.openFrozen({ ...opening, create: admitted?.command.create ?? false });
        const reply = await this.request(
          {
            operation: 'workspace-queue-input',
            database: opening.database,
            input: wire.data,
            content: new ArrayBuffer(0),
          },
          [text]
        );
        if (reply.operation !== 'workspace-queue-input' || reply.result !== null)
          throw new ControlStoreWorkerError('invalid-request', 'unknown');
        return wire.data.input;
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      opening
    );
  }

  /** Reuses the exact physical owner for a closed originally standalone Core or Workspace Audit. */
  async standaloneAudit(
    db: CoreDb | WorkspaceDb,
    input: ControlStandaloneAuditInput
  ): Promise<void> {
    return this.runOperation(
      async () => {
        const scope = nativeProductScope(
          db.dataRoot,
          db.scope === 'core'
            ? { kind: 'server' }
            : { kind: 'workspace', workspaceId: db.workspaceId }
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
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      db
    );
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
    const scope = nativeProductScope(workspaceDb.dataRoot, {
      kind: 'workspace',
      workspaceId: workspaceDb.workspaceId,
    });
    const database = `workspace:${scope.path}`;
    return this.runOperation(
      async () => {
        guardExistingResolvedAgentSetup(workspaceDb, input.recordId);
        const setup = StoredResolvedAgentSetupV1Schema.parse(redactResolvedAgentSetup(input.setup));
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
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workspaceDb
    );
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
      admission = this.compatibilityFileAdmission(root);
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

  /** Preserves exact original post-effect receipts and the separate post-ACK FULL maintenance commit. */
  async recordCommandReceipt(owner: string | WorkspaceDb, value: CommandReceipt): Promise<void> {
    return this.runOperation(
      async () => {
        const receipt = CommandReceiptSchema.parse(value);
        if (
          typeof owner !== 'string' &&
          (!('workspaceId' in receipt.scope) || receipt.scope.workspaceId !== owner.workspaceId)
        )
          throw new ControlStoreWorkerError('invalid-request', 'not-committed');
        const dataRoot = typeof owner === 'string' ? owner : owner.dataRoot;
        let database: string;
        if ('userId' in receipt.scope) {
          const userId = receipt.scope.userId;
          if (receipt.command === 'workspace.create') ensureUserLayout(dataRoot, userId);
          const path = userDbPath(dataRoot, userId);
          database = `user:${path}`;
          const create =
            receipt.command === 'workspace.create' &&
            (this.openings.get(database)?.command.create ??
              !statSync(path, { throwIfNoEntry: false }));
          await this.open({ database, path, create, initialize: 'user' });
        } else {
          const scope = nativeProductScope(
            dataRoot,
            'coreId' in receipt.scope
              ? { kind: 'server' }
              : { kind: 'workspace', workspaceId: receipt.scope.workspaceId }
          );
          const path = scope.path;
          if (typeof owner !== 'string' && owner.sqlite.name !== path)
            throw new ControlStoreWorkerError('invalid-request', 'not-committed');
          database = `${'coreId' in receipt.scope ? 'core' : 'workspace'}:${path}`;
          await this.open({
            database,
            path,
            dataRoot,
            create: false,
            initialize: 'coreId' in receipt.scope ? 'core' : 'workspace',
            productOwner: scope.owner,
            contentMount: scope.contentMount,
          });
        }
        await this.transition(database, { kind: 'command-receipt', stage: 'record', receipt });
        // Sample the maintenance clock only after the original record's FULL ACK.
        const scope =
          'userId' in receipt.scope
            ? { userId: receipt.scope.userId }
            : 'coreId' in receipt.scope
              ? { coreId: 'server' as const }
              : { workspaceId: receipt.scope.workspaceId };
        await this.transition(database, {
          kind: 'command-receipt',
          stage: 'maintenance',
          scope,
          referenceTime: new Date().toISOString(),
        });
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      typeof owner === 'string' ? this.openings.get(owner)?.command : owner
    );
  }

  /** Publishes only the original Server Notebook Audit; command receipts use transition. */
  async scopedNotebookSql(database: string, input: ControlScopedNotebookSqlInput): Promise<void> {
    const reply = await this.request({ operation: 'scoped-notebook-sql', database, input });
    if (reply.operation !== 'scoped-notebook-sql' || reply.result !== null)
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
  }

  /** Reuses the canonical User physical owner and covering FULL acknowledgement. */
  async userCapability(
    db: UserDb,
    input: Extract<
      ControlCapabilityCommandInput,
      { kind: 'user-permission' | 'user-participant-audit' | 'user-audit' }
    >
  ): Promise<null> {
    return this.runOperation(
      async () => {
        const path = nativeUserDatabasePath(db);
        if (input.userId !== db.userId)
          throw new ControlStoreWorkerError('invalid-request', 'not-committed');
        const database = `user:${path}`;
        await this.open({ database, path, create: false, initialize: 'user' });
        const result = await this.capability(database, input);
        if (result !== null) throw new ControlStoreWorkerError('invalid-request', 'unknown');
        return null;
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      db
    );
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
    return this.runOperation(
      async () => {
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
          if (
            error instanceof ControlStoreWorkerError &&
            error.domain?.operation === 'capability'
          ) {
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
            throw new GoalCommandError(
              error.domain.code,
              error.domain.message,
              error.domain.status
            );
          }
          throw error;
        }
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      this.openings.get(database)?.command
    );
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
    return this.runOperation(
      async () => {
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
              if (refusal.code === 'idempotency_key_conflict')
                throw new IdempotencyKeyConflictError();
              throw new OperationError(refusal.code, refusal.message, refusal.status, {
                ...(refusal.details ? { details: refusal.details } : {}),
              });
            }
            throw error;
          }
        }
        throw new ControlStoreWorkerError('busy', 'not-committed');
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      db
    );
  }

  /** Executes one complete Material-family body; only its outer FULL commit acknowledges the result. */
  async material(
    database: string,
    input: ControlMaterialCommandInput
  ): Promise<ControlMaterialCommandResult> {
    return this.runOperation(
      async () => {
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
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      this.openings.get(database)?.command
    );
  }

  /** Commits both terminal streams and the attempt close inside one existing native savepoint. */
  async workerControlFinalStatus(database: string, command: ControlWorkerFinalStatusCommand) {
    const result = await this.workerControlFinalStage(database, command);
    if ('kind' in result) throw new ControlStoreWorkerError('integrity', 'unknown');
    return result;
  }

  private async workerControlFinalStage(
    database: string,
    command: ControlWorkerFinalStatusCommand,
    nanoHostFinal?: WorkerControlFinalStage
  ) {
    return this.runOperation(
      async () => {
        const { payload, ...metadata } = command;
        const json = JSON.stringify(payload);
        const reply = await this.request(
          {
            operation: 'worker-control-final-status',
            database,
            input: { ...metadata, byteLength: Buffer.byteLength(json) },
            ...(nanoHostFinal ? { nanoHostFinal } : {}),
          },
          [json]
        );
        return (reply as Extract<Success, { operation: 'worker-control-final-status' }>).result;
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      this.openings.get(database)?.command
    );
  }

  /** Commits heartbeat fingerprint and attempt liveness inside one existing native savepoint. */
  async workerControlHeartbeat(
    database: string,
    command: ControlWorkerHeartbeatCommand,
    nanoHostCoreIdentity?: string
  ) {
    return this.runOperation(
      async () => {
        const { payload, ...metadata } = command;
        const json = JSON.stringify(payload);
        const reply = await this.request(
          {
            operation: 'worker-control-heartbeat',
            database,
            input: { ...metadata, byteLength: Buffer.byteLength(json) },
            ...(nanoHostCoreIdentity ? { nanoHostCoreIdentity } : {}),
          },
          [json]
        );
        return (reply as Extract<Success, { operation: 'worker-control-heartbeat' }>).result;
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      this.openings.get(database)?.command
    );
  }

  /** Commits one original nonterminal control stage inside one existing native savepoint. */
  async workerControlRecord(
    database: string,
    command: ControlWorkerRecordCommand,
    nanoHostCoreIdentity?: string
  ) {
    return this.runOperation(
      async () => {
        const { payload, ...metadata } = command;
        const json = JSON.stringify(payload);
        const reply = await this.request(
          {
            operation: 'worker-control-record',
            database,
            input: { ...metadata, byteLength: Buffer.byteLength(json) },
            ...(nanoHostCoreIdentity ? { nanoHostCoreIdentity } : {}),
          },
          [json]
        );
        return (reply as Extract<Success, { operation: 'worker-control-record' }>).result;
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      this.openings.get(database)?.command
    );
  }

  /** Returns only after the exact Core journal tuple is covered by FULL. */
  async coreJournal(
    database: string,
    input: ControlCoreJournalInput | ControlCoreImageResult
  ): Promise<string | null> {
    this.assertAccepting();
    let release: (() => void) | undefined;
    let nativeRead: Opening | undefined;
    try {
      input = structuredClone(input);
      const opening = this.openings.get(database);
      if (!opening?.command.dataRoot || opening.command.productOwner?.kind !== 'server')
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      let workspaceId: string | undefined;
      if (input.kind === 'containment-intent') workspaceId = input.lineage.workspaceId;
      else if (input.kind === 'idle-intent') workspaceId = input.package.workspaceId;
      else if (
        input.kind !== 'containment-inspect' &&
        input.kind !== 'image-intent' &&
        input.kind !== 'image-result' &&
        input.kind !== 'image-abandon' &&
        opening?.command.dataRoot
      ) {
        // These references address immutable originals, not caller-selected effect scopes.
        // Resolve the posted snapshot synchronously before enrolling its original Workspace.
        const reader = openCoreReadDb(opening.command.dataRoot);
        try {
          if (reader.sqlite.name !== opening.command.path)
            throw new ControlStoreWorkerError('invalid-request', 'not-committed');
          if (input.kind === 'idle-settle') {
            const intent = decodeExecutionJournalIntent(input.intentJson);
            const original = readExecutionJournalInvocation(reader, {
              execution: intent.execution.ref,
              stepId: intent.stepId,
            });
            if (!original.control.attemptId)
              throw new ControlStoreWorkerError('invalid-request', 'not-committed');
            workspaceId = requireSchedulerExecutionAttempt(
              reader,
              original.control.attemptId
            ).workspaceId;
          } else {
            const ref = { ...input.ref, stepId: 'quarantine' };
            // Absent originals retain the native owner's existing null/refusal behavior.
            if (
              reader.sqlite
                .prepare(
                  'SELECT 1 FROM control_execution_steps WHERE execution_id = ? AND step_id = ?'
                )
                .get(ref.execution.executionId, ref.stepId)
            ) {
              workspaceId = readCoreJournalLineage(
                readExecutionJournalInvocation(reader, ref).control.inputRefs
              ).workspaceId;
            }
          }
        } finally {
          reader.sqlite.close();
        }
      }
      const owner =
        opening?.command.dataRoot && workspaceId
          ? this.workspaceMutations(opening.command.dataRoot)
          : undefined;
      if (owner && workspaceId) {
        release = this.enterScope(owner, workspaceId, 'capture') ?? undefined;
        if (!release) throw new ControlStoreWorkerError('busy', 'not-committed');
      }
      const nativeDatabase = `server-owner:${serverStoragePath(opening.command.dataRoot, 'nanohost')}`;
      if (
        input.kind === 'image-intent' ||
        input.kind === 'image-result' ||
        input.kind === 'containment-stop-outcome'
      ) {
        const candidate = this.openings.get(nativeDatabase);
        if (
          candidate?.acknowledged &&
          candidate.identity &&
          candidate.command.serverOwner?.owner === 'nanohost' &&
          !candidate.retirement &&
          !candidate.host.failed &&
          !candidate.nanoHostWritePending &&
          !candidate.nanoHostTargetTransition &&
          !this.backupHold
        ) {
          candidate.nanoHostWritePending =
            input.kind === 'image-intent' || input.kind === 'image-result'
              ? 'core-owner-read'
              : true;
          nativeRead = candidate;
        }
      }
      if (input.kind === 'image-result' && !nativeRead)
        throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
      return await this.runOperation(
        async () => {
          const reply = await this.request({
            operation: 'core-journal',
            database,
            input,
            ...(nativeRead?.identity ? { nanoHostOwnerIdentity: nativeRead.identity } : {}),
          });
          return (reply as Extract<Success, { operation: 'core-journal' }>).result;
        },
        undefined,
        nativeRead ? nativeDatabase : undefined,
        undefined,
        undefined,
        owner && workspaceId && release ? { owner, workspaceId, release } : undefined
      );
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'core-journal') {
        if (input.kind === 'image-result' && error.domain.reasonCode === 'image_result_conflict')
          throw new WorkerImageSettlementConflict();
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
    } finally {
      if (nativeRead) delete nativeRead.nanoHostWritePending;
      release?.();
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
          case 'unsupported_decision':
            throw new OperationError(
              'workspace_recovery_decision_failed',
              'Workspace recovery staging and quarantine are unavailable. Use resume_collection with a matching durable output manifest, or abandon with evidence retained.',
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

  /** The packaged self-check borrows Core facts and writes through its acknowledged Native owner. */
  private async runSimulatorNative<T>(
    database: string,
    operation: (native: string, simulatorCoreIdentity: string) => Promise<T>
  ): Promise<T> {
    const core = this.openings.get(database);
    const dataRoot = core?.command.dataRoot;
    const identity = core?.identity;
    if (
      process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR !== '1' ||
      !core?.acknowledged ||
      core.command.initialize !== 'core' ||
      !dataRoot ||
      !identity ||
      core.host.failed
    )
      throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
    this.assertScopeProducerAdmission(database);
    const native = `server-owner:${serverStoragePath(dataRoot, 'nanohost')}`;
    const owner = this.openings.get(native);
    if (!owner?.acknowledged || owner.readNanoHost?.(() => true).state !== 'ready')
      throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
    const releaseCore = reserveMainScopeReadAcquisition(core.path);
    owner.nanoHostWritePending = true;
    try {
      return await this.runOperation(
        () => operation(native, identity),
        undefined,
        native,
        undefined,
        undefined,
        undefined,
        owner.command
      );
    } finally {
      delete owner.nanoHostWritePending;
      releaseCore();
    }
  }

  /** Commits one original backend-session tuple before its dependent effect or release. */
  async backendSession(
    database: string,
    input: ControlBackendSessionInput
  ): Promise<ControlBackendSessionResult> {
    try {
      if (
        process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR !== '1' &&
        (input.kind === 'materializing' ||
          input.kind === 'handoff' ||
          (input.kind === 'transition' &&
            input.fromState === 'materializing' &&
            input.toState === 'materialized'))
      ) {
        const core = this.openings.get(database);
        const root =
          core?.acknowledged && core.command.initialize === 'core'
            ? core.command.dataRoot
            : undefined;
        const native =
          root && this.openings.get(`server-owner:${serverStoragePath(root, 'nanohost')}`);
        if (!native || !native.prepareNanoHostBackend)
          throw new ControlStoreWorkerError('owner-recovery-required', 'not-committed');
        return await native.prepareNanoHostBackend(
          input.kind === 'transition' ? { ...input, toState: 'materialized' } : input
        );
      }
      const reply =
        process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR === '1'
          ? await this.runSimulatorNative(database, (native, simulatorCoreIdentity) =>
              this.request({
                operation: 'backend-session',
                database: native,
                input,
                simulatorCoreIdentity,
              })
            )
          : await this.request({ operation: 'backend-session', database, input });
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
          : input.kind === 'simulator-final'
            ? await this.runSimulatorNative(database, (native, simulatorCoreIdentity) =>
                this.request({
                  operation: 'execution-attempt',
                  database: native,
                  input,
                  simulatorCoreIdentity,
                })
              )
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
    // Create/revoke already name their Workspace. Invitee transitions address the
    // original immutable invitation identity; user.disable remains physical Core only.
    let workspaceId = 'workspaceId' in input ? input.workspaceId : undefined;
    const command = input.command;
    const invitationId =
      command === 'workspace.invitation.accept' || command === 'workspace.invitation.decline'
        ? input.invitationId
        : undefined;
    const opening = this.openings.get(database);
    if (invitationId !== undefined) {
      if (!opening?.command.dataRoot || opening.command.productOwner?.kind !== 'server')
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      const reader = openCoreReadDb(opening.command.dataRoot);
      try {
        if (reader.sqlite.name !== opening.command.path)
          throw new ControlStoreWorkerError('invalid-request', 'not-committed');
        // Missing originals keep the native owner's existing denial; this read grants no authority.
        workspaceId = getWorkspaceInvitation(reader, invitationId)?.workspaceId;
      } finally {
        reader.sqlite.close();
      }
    }
    if (workspaceId && !opening?.command.dataRoot)
      throw new ControlStoreWorkerError(opening ? 'invalid-request' : 'not-open', 'not-committed');
    const owner = workspaceId ? this.workspaceMutations(opening!.command.dataRoot!) : undefined;
    const release =
      owner && workspaceId ? this.enterScope(owner, workspaceId, 'ordinary') : undefined;
    if (release === null) throw new OperationError('workspace_frozen', 'Workspace is frozen.', 409);
    const workspaceLease =
      owner && workspaceId && release ? { owner, workspaceId, release } : undefined;
    try {
      let prepared: ControlCoreSharing;
      try {
        prepared = structuredClone(input);
      } catch {
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      }
      // The accepted producer cannot be retargeted before its deferred native post.
      if (
        prepared.command !== command ||
        (command === 'workspace.invitation.accept' || command === 'workspace.invitation.decline'
          ? !('invitationId' in prepared) || prepared.invitationId !== invitationId
          : ('workspaceId' in prepared ? prepared.workspaceId : undefined) !== workspaceId)
      )
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      let call: ControlCoreRetirementCall | undefined;
      if (prepared.command === 'workspace.retire-quarantined') {
        const opening = this.openings.get(database);
        if (!opening || opening.identity === undefined || !assertCurrent)
          throw new ControlStoreWorkerError('precondition', 'not-committed');
        call = {
          kind: 'core-sharing-retirement',
          [coreRetirementCall]: true,
          input: prepared,
          command: opening.command,
          path: opening.path,
          identity: opening.identity,
          assertCurrent,
        };
      }
      const submit = () =>
        this.request(
          { operation: 'core-sharing', database, input: prepared },
          undefined,
          undefined,
          false,
          call
        );
      const reply = workspaceLease
        ? await this.runOperation(
            submit,
            undefined,
            undefined,
            undefined,
            undefined,
            workspaceLease
          )
        : await submit();
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
    } finally {
      release?.();
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

  /** Releases the query-only NanoHost connection before the usual reader drain. */
  private async closeNanoHostReader(opening: Opening): Promise<void> {
    const reader = await opening.nanoHostReader?.catch(() => undefined);
    if (reader?.open) reader.close();
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
          if (opening.communicationReader?.open) opening.communicationReader.close();
          await this.closeNanoHostReader(opening);
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
          await this.closeNanoHostReader(opening);
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
  /** Joins existing Turn preparation and live original Worker operations on this same component. */
  drainWorkspacePreparations(dataRoot: string, workspaceId: string): Promise<void> | undefined {
    const database = `workspace:${join(dataRoot, 'workspaces', workspaceId, 'db/workspace.sqlite')}`;
    const path =
      this.openings.get(database)?.path ?? resolve(database.slice(database.indexOf(':') + 1));
    const owner = this.workspaceMutations(dataRoot);
    const context = this.operationContext.getStore();
    if (
      context?.active &&
      (context.reservation === database ||
        context.workspaceLeases.some(
          (lease) => lease.owner === owner && lease.workspaceId === workspaceId
        ))
    )
      throw new OperationError(
        'workspace_blocked',
        'A Workspace producer cannot join its own capture.',
        409
      );
    const current = () => [
      ...[...this.turnTails]
        .filter(([key]) => JSON.parse(key)[0] === path)
        .map(([, entry]) => entry.tail),
      ...[...this.operations]
        .filter(([, operation]) =>
          operation.workspaceLeases.some(
            (lease) => lease.owner === owner && lease.workspaceId === workspaceId
          )
        )
        .map(([promise]) => promise),
    ];
    const entered = current();
    if (entered.length === 0) return undefined;
    return (async () => {
      let pending = entered;
      while (pending.length !== 0) {
        await Promise.allSettled(pending);
        pending = current();
      }
    })();
  }

  /** Installs the existing target hold without joining a competing target or global hold. Only posted ACKs may settle. */
  tryPauseForWorkspaceCapture(database: string): Promise<() => void> | null {
    const root = this.openings.get(database);
    const parent = root?.command;
    const owner = parent?.productOwner;
    if (root?.captureReads?.active) return null;
    const canonicalDataRoot = parent?.dataRoot ? realpathSync(parent.dataRoot) : undefined;
    const keys = [
      database,
      ...[...this.openings.entries()]
        .filter(
          ([, entry]) =>
            owner?.kind === 'workspace' &&
            entry.command.physicalScope?.workspaceId === owner.workspaceId &&
            entry.command.dataRoot !== undefined &&
            parent?.dataRoot !== undefined &&
            realpathSync(entry.command.dataRoot) === canonicalDataRoot
        )
        .map(([key]) => key),
    ];
    if (this.backupHold || keys.some((key) => this.databaseHolds.has(key))) return null;
    const acquired: Array<() => void> = [];
    const capture: CaptureReadGeneration | undefined =
      root && owner?.kind === 'workspace' && parent?.dataRoot
        ? {
            root,
            workspaceId: owner.workspaceId,
            dataRoot: canonicalDataRoot!,
            acquired,
            inFlightOpens: new Map(),
            active: true,
            postingHeld: true,
            enumerating: false,
            copyingPath: undefined,
            changed: Promise.withResolvers<void>(),
          }
        : undefined;
    if (capture) capture.root.captureReads = capture;
    return Promise.allSettled(
      keys.map(async (key) => {
        const release = await this.pauseForDataRootBackup(key);
        acquired.push(release);
        return release;
      })
    ).then(async (results) => {
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') {
        await this.finishCaptureReads(database);
        for (const release of acquired) release();
        throw failed.reason;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (capture) {
          capture.postingHeld = false;
          capture.enumerating = false;
          capture.copyingPath = undefined;
          this.wakeCaptureReads(capture);
        }
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
    const resumeCommunication = database === undefined ? this.holdCommunicationProducers() : null;
    if (database === undefined && !resumeCommunication)
      throw new ControlStoreWorkerError('busy', 'not-committed');
    if (resumeCommunication && this.communicationProducers.size !== 0) {
      await Promise.allSettled(this.communicationProducers);
      if (failed()) {
        resumeCommunication();
        throw new ControlStoreWorkerError('unavailable', 'not-committed');
      }
    }
    if (
      database === undefined &&
      (this.serverWorkProducers.size !== 0 ||
        [...this.openings.values()].some(
          (opening) => opening.nanoHostTargetTransition || opening.nanoHostCoreHoldPending
        ))
    ) {
      resumeCommunication?.();
      throw new ControlStoreWorkerError('busy', 'not-committed');
    }
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
      resumeCommunication?.();
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
        for (const opening of this.openings.values()) {
          if (opening.communicationReader?.open) opening.communicationReader.close();
        }
        await Promise.all(
          [...this.openings.values()].map((opening) => this.closeNanoHostReader(opening))
        );
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
    policyCall?: PolicyCall,
    publicationGuard?: ControlStorePublicationGuard,
    schedulerWorkspaceId?: string,
    verifyNanoHostPost?: Pending['verifyNanoHostPost']
  ): Promise<Success> {
    if (publicationGuard?.signal.aborted)
      return Promise.reject(new ControlStoreWorkerError('precondition', 'not-committed'));
    if (command.operation !== 'shutdown') {
      try {
        this.assertAccepting();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const database = 'database' in command ? command.database : undefined;
    const context = this.operationContext.getStore();
    const opening = database === undefined ? undefined : this.openings.get(database);
    try {
      this.assertFrozenCall(command, recovery, opening);
    } catch (error) {
      return Promise.reject(error);
    }
    const parentLeases = context?.active ? context.workspaceLeases : [];
    const scoped = command.operation === 'open' ? command : opening?.command;
    const physical = scoped?.physicalScope ?? scoped?.productOwner;
    const workspaceLeases: WorkspaceMutationLease[] = [];
    // These are real admitted resource units, never a permission/scope descriptor.
    const retainWorkspace = (owner: WorkspaceMutationScope, workspaceId: string) => {
      if (
        workspaceLeases.some((lease) => lease.owner === owner && lease.workspaceId === workspaceId)
      )
        return;
      const release = this.enterScope(owner, workspaceId, 'capture');
      if (!release) throw new ControlStoreWorkerError('busy', 'not-committed');
      workspaceLeases.push({ owner, workspaceId, release });
    };
    let handedToPending = false;
    try {
      for (const parent of parentLeases) retainWorkspace(parent.owner, parent.workspaceId);
      if (
        !recovery &&
        scoped?.dataRoot &&
        (physical?.kind === 'workspace' || physical?.kind === 'app')
      )
        retainWorkspace(this.workspaceMutations(scoped.dataRoot), physical.workspaceId);
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
      const nativeTurn = this.directNativeTurn(command);
      if (
        (database !== undefined &&
          (this.outstanding.get(database) ?? 0) - (borrowed ? 1 : 0) >=
            CONTROL_WORKER_LIMITS.pendingTransitions) ||
        (nativeTurn &&
          opening &&
          !borrowed &&
          this.pendingTurnPublications(JSON.stringify([opening.path, nativeTurn.turnId])) >=
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
          controlWorkerInputBytes({
            ...command,
            version: CONTROL_WORKER_VERSION,
            id: this.nextId,
          }) + 64;
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
        command.operation === 'generative-presentation' ||
        command.operation === 'app-kernel' ||
        command.operation === 'schema-application' ||
        command.operation === 'communication-owner' ||
        (command.operation === 'server-work-owner' &&
          command.mutation.kind === 'append-observation') ||
        (command.operation === 'transition' &&
          'kind' in command.transition &&
          (command.transition.kind === 'command-receipt' ||
            command.transition.kind === 'scheduler-work')) ||
        command.operation === 'standalone-audit' ||
        command.operation === 'workspace-queue-input' ||
        command.operation === 'thread-read-membership' ||
        command.operation === 'worker-control-final-status' ||
        command.operation === 'worker-control-heartbeat' ||
        command.operation === 'worker-control-record' ||
        (command.operation === 'execution-attempt' && command.input.kind === 'create')
      ) {
        const size =
          command.operation === 'transition' &&
          'kind' in command.transition &&
          (command.transition.kind === 'command-receipt' ||
            command.transition.kind === 'scheduler-work')
            ? { byteLength: command.transition.input.byteLength, replyByteLength: 0 }
            : command.operation === 'execution-attempt'
              ? {
                  byteLength: command.input.kind === 'create' ? command.input.byteLength : 0,
                  replyByteLength: 0,
                }
              : command.operation === 'material'
                ? controlMaterialTransferSize(command.input)
                : command.operation === 'generative-presentation' ||
                    command.operation === 'app-kernel' ||
                    command.operation === 'schema-application' ||
                    command.operation === 'communication-owner' ||
                    command.operation === 'standalone-audit' ||
                    command.operation === 'workspace-queue-input' ||
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
                    : command.operation === 'server-work-owner' &&
                        command.mutation.kind === 'append-observation'
                      ? {
                          byteLength: command.mutation.input.bodies.reduce(
                            (total, body) => total + body.byteLength,
                            0
                          ),
                          replyByteLength: 0,
                        }
                      : command.operation === 'capability'
                        ? {
                            byteLength: controlCapabilityText(command.input)?.byteLength ?? 0,
                            replyByteLength: 0,
                          }
                        : undefined;
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
              return Promise.reject(
                new ControlStoreWorkerError('invalid-request', 'not-committed')
              );
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
      if (!recovery && scoped?.dataRoot && command.operation === 'private-workspace') {
        const owner = this.workspaceMutations(scoped.dataRoot);
        if ('workspaceId' in command.input) retainWorkspace(owner, command.input.workspaceId);
        if ('expectedWorkspaceId' in command.input)
          retainWorkspace(owner, command.input.expectedWorkspaceId);
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
        for (const lease of workspaceLeases) host.capacity.add(lease);
        if (closeout) closeout.borrowing = true;
        const cancelUnposted = publicationGuard
          ? () => {
              if (!this.pending.get(id)?.posted)
                this.complete(
                  id,
                  undefined,
                  new ControlStoreWorkerError('precondition', 'not-committed')
                );
            }
          : undefined;
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
          workspaceLeases,
          closeout,
          ...(fundsProgress ? { progressCopy: { credit: fundsProgress, bytes: inputBytes } } : {}),
          ...(schemaApplicationFacts ? { schemaApplicationFacts } : {}),
          ...(verifyNanoHostPost ? { verifyNanoHostPost } : {}),
          ...(policyCall ? { policyCall } : {}),
          ...(schedulerWorkspaceId === undefined ? {} : { schedulerWorkspaceId }),
          ...(publicationGuard && cancelUnposted
            ? {
                productPublication: {
                  guard: publicationGuard,
                  receipt: Promise.withResolvers<void>(),
                  detach: () =>
                    publicationGuard.signal.removeEventListener('abort', cancelUnposted),
                },
              }
            : {}),
          resolve,
          reject,
        };
        if (policyCall) policyCall.id = id;
        this.pending.set(id, entry);
        handedToPending = true;
        if (database !== undefined && !borrowed)
          this.outstanding.set(database, (this.outstanding.get(database) ?? 0) + 1);
        if (publicationGuard && cancelUnposted)
          publicationGuard.signal.addEventListener('abort', cancelUnposted, { once: true });
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
      this.operations.set(operation, {
        publication: undefined,
        workspaceLeases,
      });
      const release = () => this.operations.delete(operation);
      void operation.then(release, release);
      return result;
    } catch (error) {
      return Promise.reject(error);
    } finally {
      if (!handedToPending) for (const lease of workspaceLeases) lease.release();
    }
  }

  /** Async physical checks stay in the original finite request slot and precede native posting. */
  private post(entry: Pending): void {
    const recovery = entry.recovery;
    if (!recovery || !('kind' in recovery) || recovery.kind !== 'capture-read') {
      this.postChecked(entry);
      return;
    }
    if (entry.posted || entry.captureReadChecking) return;
    entry.captureReadChecking = true;
    void (async () => {
      const command = entry.command;
      if (command.operation !== 'open' || !command.dataRoot)
        throw new ControlStoreWorkerError('busy', 'not-committed');
      const [current, path, root] = await Promise.all([
        stat(recovery.path),
        realpath(command.path),
        realpath(command.dataRoot),
      ]);
      if (
        path !== recovery.path ||
        root !== recovery.capture.dataRoot ||
        `${current.dev}:${current.ino}` !== recovery.identity
      )
        throw new ControlStoreWorkerError('busy', 'not-committed');
    })().then(
      () => {
        entry.captureReadChecking = false;
        if (this.pending.get(entry.request.id) === entry) this.postChecked(entry);
      },
      (error: unknown) => {
        entry.captureReadChecking = false;
        if (this.pending.get(entry.request.id) === entry)
          this.complete(
            entry.request.id,
            undefined,
            error instanceof ControlStoreWorkerError
              ? error
              : new ControlStoreWorkerError('precondition', 'not-committed')
          );
      }
    );
  }

  /** Rechecks current holds and authority without an async gap before the original post. */
  private postChecked(entry: Pending): void {
    if (entry.posted || this.pending.get(entry.request.id) !== entry) return;
    const publication = entry.productPublication;
    const opening =
      'database' in entry.command ? this.openings.get(entry.command.database) : undefined;
    try {
      this.assertFrozenCall(entry.command, entry.recovery, opening, entry);
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
      ('database' in entry.command &&
        this.databaseHolds.has(entry.command.database) &&
        !(entry.recovery && 'kind' in entry.recovery && entry.recovery.kind === 'capture-read'))
    )
      return;
    const members = entry.cohort?.frame.requests.map(
      (request) => this.pending.get(request.id)!
    ) ?? [entry];
    if (members.some((member) => !member.ready)) return;
    try {
      for (const member of members) {
        const memberOpening =
          'database' in member.command ? this.openings.get(member.command.database) : undefined;
        this.assertFrozenCall(member.command, member.recovery, memberOpening, member);
        if (member.schedulerWorkspaceId !== undefined) {
          const dataRoot = memberOpening?.command.dataRoot;
          if (dataRoot === undefined)
            throw new ControlStoreWorkerError('invalid-request', 'not-committed');
          assertScopeAdmitted(dataRoot, 'workspace', member.schedulerWorkspaceId);
        }
      }
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
    if (entry.command.operation === 'nanohost-owner') {
      try {
        if (entry.verifyNanoHostPost?.(entry.command.mutation) !== true)
          throw new ControlStoreWorkerError('precondition', 'not-committed');
      } catch (error) {
        this.complete(
          entry.request.id,
          undefined,
          error instanceof ControlStoreWorkerError
            ? error
            : new ControlStoreWorkerError('precondition', 'not-committed')
        );
        return;
      }
    }
    if (publication && performance.now() >= publication.guard.deadline) {
      this.complete(
        entry.request.id,
        undefined,
        new ControlStoreWorkerError('precondition', 'not-committed')
      );
      return;
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
      return;
    }
    if (publication)
      publication.guard.postedSettlement = Promise.race([
        publication.receipt.promise,
        entry.host.exited.promise,
      ]);
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
    entry.productPublication?.detach();
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
      for (const lease of entry.workspaceLeases) {
        lease.release();
        entry.host.capacity.delete(lease);
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
      const admission =
        opening.command.dataRoot === undefined
          ? this.fileAdmissionForPath(opening.path)
          : this.fileAdmissions.get(resolve(root));
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
      (value.status === 'ok' &&
        value.operation === 'server-work-owner' &&
        entry.command.operation === 'server-work-owner' &&
        value.result.kind !== entry.command.mutation.kind) ||
      (value.status === 'ok' &&
        value.operation === 'nanohost-owner' &&
        entry.command.operation === 'nanohost-owner' &&
        value.result.kind !== entry.command.mutation.kind) ||
      (value.status === 'ok' &&
        value.operation === 'communication-owner' &&
        entry.command.operation === 'communication-owner' &&
        value.result.stage !== entry.command.stage) ||
      (value.status === 'error' &&
        value.domain !== undefined &&
        value.domain.operation !== entry.command.operation)
    ) {
      this.fail(host);
      return;
    }
    entry.productPublication?.receipt.resolve();
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
        value.commit === 'not-committed' && value.domain?.code === 'core.protocol.invalid_delta'
          ? new ItemDeltaProtocolError(undefined, entry.command.operation !== 'server-work-owner')
          : (entry.command.operation === 'products' || entry.command.operation === 'transition') &&
              value.commit === 'not-committed' &&
              value.domain &&
              value.domain.operation !== 'resolved-agent-setup' &&
              ['request_executing', 'thread_busy', 'conflict'].includes(value.domain.code)
            ? new PendingRequestCommandError(
                value.domain.code,
                value.domain.message,
                value.domain.status,
                { cause: new ControlStoreWorkerError(value.code, value.commit, value.domain) }
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
