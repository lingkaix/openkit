import type { TaskSteerReceiptMetadata } from '../runtime/task-steer-receipt.js';
import {
  isRecordedItemFailure,
  prepareControlReadMetadata,
} from '../storage/control-store-read-metadata.js';
import {
  ControlScopedNotebookSqlInputSchema,
  isSeparateScopedNotebookReceipt,
} from '../storage/scoped-notebook-sql-codecs.js';
import type { WorkspaceCommandReceipt } from '../storage/workspace-command-receipt-codecs.js';
import { resolvePersonalWorkspaceIdInDb } from '../storage/workspace-owner-records.js';
import { StoreRecordNotFoundError } from './store-errors.js';

export { StoreRecordNotFoundError } from './store-errors.js';

import { ArtifactAuthorityError, projectArtifactVersion } from '../artifact-authority.js';
import {
  prepareWorkspaceNotebookReads,
  readWorkspaceNotebookSelection,
  type WorkspaceNotebookSelection,
} from '../knowledge/notebook-workspace-selection.js';
import { prepareWorkspaceKnowledgeProposal } from '../storage/control-store-knowledge.js';
import {
  type ControlKnowledgeHead,
  type ControlKnowledgeProposal,
  controlKnowledgeHeadGuardStatement,
  controlKnowledgeHeadStatements,
  controlKnowledgeProposalStatement,
  controlKnowledgeReviewStatement,
  readControlKnowledgeProposal,
} from '../storage/control-store-knowledge-heads.js';
import { readImmutableContentBytes } from '../storage/immutable-content-read.js';
import {
  ActorRefReaderSchema,
  knowledgeProposalDocumentDigest,
  knowledgeProposalId,
} from '../storage/knowledge-proposal-codecs.js';
import type {
  WorkspaceFrozenAdmission,
  WorkspaceMutationAdmission,
} from '../workspace-mutation-admission.js';
import {
  decidedTurnFieldsConflict,
  displayProjectionFieldsEqual,
  stopReasonMatchesSealedStatus,
  terminalTurnPublicationConflict,
  terminalTurnWriteRejected,
} from './conversation-write-policy.js';

export { commandRequestExpiresAt, commandRequestKey } from '../storage/command-request-records.js';

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setImmediate as yieldToMain } from 'node:timers/promises';
import {
  isDeepStrictEqual as alreadyDecidedPublicationBytesEqual,
  isDeepStrictEqual,
} from 'node:util';
import type {
  IntroduceWorkspaceArtifactResponse,
  KnowledgeManagerDraftProposalRequest,
  KnowledgeManagerDraftProposalResponse,
  KnowledgeProposalApplication,
  KnowledgeProposalReview,
  MaterializedWorkspaceRoot,
  ReadArtifactVersionResponse,
  SubmitKnowledgeProposalDecisionRequest,
  SubmitKnowledgeProposalDecisionResponse,
} from '@openkit/app-api-schemas';
import {
  KnowledgeManagerDraftProposalRequestSchema,
  KnowledgeProposalReviewSchema,
  SubmitKnowledgeProposalDecisionRequestSchema,
  SubmitKnowledgeProposalDecisionResponseSchema,
} from '@openkit/app-api-schemas';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import type {
  ActorRef,
  AuditEvent,
  KnowledgeNotebookPageSchema,
  PolicyDocumentV1,
  WorkspaceRecordSchema,
  WorkspaceResourcesSchema,
} from '@openkit/protocol';
import {
  type AgentSessionSchema,
  type ApprovalRequestSchema,
  ArtifactSchema,
  type ArtifactVersion,
  type ArtifactVersionRecord,
  ArtifactVersionRecordSchema,
  allocateEntityId,
  deriveEntityId,
  formatReferenceUri,
  ItemSchema,
  isSealedTurnTerminal,
  PROTOCOL_VERSION,
  parseReferenceScope,
  parseReferenceUri,
  responsibleUserIdForActor,
  type ServerTurnEventEnvelope,
  ServerTurnEventEnvelopeSchema,
  SseEventEnvelopeSchema,
  ThreadIdSchema,
  ThreadSchema,
  TurnSchema,
  WorkspaceIdSchema,
  workspaceIdForOwner,
  writeRetainedV1,
} from '@openkit/protocol';
import { parse as parseJsonc } from 'jsonc-parser';
import { ArtifactReviewError, type ControlReviewCommandInput } from '../artifact-review-codecs.js';
import type { CreateArtifactReviewInput } from '../artifact-reviews.js';
import { prepareAuditEvent, prepareAuditEventStatement } from '../audit-events.js';
import {
  assertScopeAdmitted,
  isScopeAdmitted,
  refuseScope,
  type ScopeAdmissionFailure,
  scopeAdmissionFailures,
} from '../bootstrap/readiness.js';
import { resolveDataRoot } from '../config/data-root.js';
import {
  initializeDefaultKnowledgeBaseId,
  readDefaultKnowledgeBaseId,
} from '../config/knowledge-base.js';
import { loadOpenKitConfig } from '../config/openkit-config.js';
import { captureCoverageBindingFromOpenKitConfig } from '../config/runtime-config.js';
import { uuidv5 } from '../generative-kernel/uuid.js';
import { unresolvedNotebookSubjects } from '../knowledge/conflicts.js';
import { KnowledgeNotebook, validateNotebookFiles } from '../knowledge/notebook.js';
import { NotebookError } from '../knowledge/notebook-error.js';
import {
  initializeWorkspaceNotebook,
  type NotebookInitialization,
} from '../knowledge/notebook-initialization.js';
import type { NotebookEdit } from '../knowledge/notebook-publication.js';
import {
  importedWorkspaceNotebookReferences,
  prepareNotebookCandidateValidation,
  validateNotebookCandidate,
} from '../knowledge/notebook-validation.js';
import {
  attributedNotebookPageBytes,
  createDefaultScopeKnowledgeSchemaText,
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
  KnowledgePageValidationError,
  parseOkfDocument,
  stringListFrontmatterField,
  validateKnowledgePageCandidate,
} from '../knowledge/okf.js';
import { readSourcePointers } from '../knowledge/source-pointers.js';
import { OperationError } from '../operation-error.js';
import { EMPTY_POLICY_DOCUMENT } from '../policy/statements.js';
import {
  decodeEndedExecutionStep,
  decodeExecutionJournalIntent,
  decodeExecutionJournalInvocation,
  encodeExecutionJournalValue,
} from '../runtime/execution-journal.js';
import type {
  EndedExecutionStep,
  ExecutionInvocation,
  ExecutionJournalIntent,
  ExecutionJournalSettlement,
} from '../runtime/execution-step-journal.js';
import { ensureTurnFeedback } from '../runtime/feedback.js';
import type { IdempotentCommandReceipt } from '../runtime/idempotent-command.js';
import type {
  ControlPendingCommandInput,
  ControlPendingCommandResult,
} from '../runtime/pending-requests.js';
import {
  loadApprovalProjections,
  loadApprovalProjectionsFromSqlite,
} from '../runtime/pending-requests.js';
import type { RuntimeAgent } from '../runtime/types.js';
import type { AppDb } from '../storage/app-db.js';
import {
  artifactVersionRecordPath,
  publishArtifactVersionRecord,
  readArtifactVersionHistory,
  readArtifactVersionRecord,
  rollbackArtifactVersionRecord,
} from '../storage/artifacts/artifact-version-records.js';
import type { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import {
  ArtifactPayloadCleanupError,
  type StagedArtifactPayload,
} from '../storage/artifacts/file-payload.js';
import { verifyArtifactFilePayload } from '../storage/artifacts/file-records.js';
import { CanonicalPublicationError } from '../storage/canonical-publication-error.js';
import { withCanonicalFileWriteAdmission } from '../storage/canonical-write-capacity.js';
import {
  commandRequestExpiresAt,
  commandRequestKey,
  getCommandRequestRecord,
  getCommandRequestRecordFromDb,
  listCommandRequestRecords,
  normalizeCommandRequestResponse,
  prepareControlCommandRequestStatement,
  readCommandRequestRecordsFromSqlite,
  recordCommandRequestRecord,
  recordCommandRequestRecordInDb,
} from '../storage/command-request-records.js';
import {
  type ControlAdmission,
  type ControlAdmissionResult,
  ControlAdmissionSchema,
} from '../storage/control-store-admission-codecs.js';
import type { ControlMcpItemCall } from '../storage/control-store-capability.js';
import { commandInputHash } from '../storage/control-store-input.js';
import type { ControlPendingTransition } from '../storage/control-store-pending.js';
import type { ControlProductMutation } from '../storage/control-store-product-records.js';
import {
  type ControlProductEntry,
  ControlProductEntrySchema,
  type ControlProductOwner,
  closeWorkspaceProductReadHandles,
  decode as decodeControlProduct,
  getWorkspaceProductReadHandle,
  openControlStoreProductReadHandle,
} from '../storage/control-store-product-records.js';
import {
  type ControlItemAppend,
  type ControlTerminalTransition,
  checkControlItemAppend,
  eventAgreesWithSealedTurnOutcome,
  eventConflictsWithSealedTurnOutcome,
} from '../storage/control-store-products.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  nativeUserDatabasePath,
} from '../storage/control-store-worker-client.js';
import {
  bindCoreSqlite,
  bindWorkspaceSqlite,
  type CoreDb,
  openWorkspaceDbAtRoot,
  openWorkspaceReadDb,
  type UserDb,
  type WorkspaceDb,
} from '../storage/db.js';
import {
  coreDbPath,
  ensureLayoutDirectories,
  ensureWorkspaceLayout,
  resolveDataRootPath,
  workspaceDbPath,
} from '../storage/fs-layout.js';
import {
  prepareRetainedProductJson,
  publishImmutableProductJson,
} from '../storage/immutable-content.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { StoredServerEventPayloadV1Schema } from '../storage/retained-server-work-v1.js';
import {
  projectTurnEventRequestId,
  THREAD_REQUIRED_FEATURES,
} from '../storage/retained-work-events-v1.js';
import { StoredItemPayloadV1Schema } from '../storage/retained-work-items-v1.js';
import {
  assertServerItemRevision,
  loadServerThreadRecords,
  readServerTurnEvents,
} from '../storage/server-thread-records.js';
import { assertServerTurnEventLineage } from '../storage/server-turn-event-lineage.js';
import {
  AgentSessionRecordSchema,
  artifactReferenceItemId,
  assertCanonicalDirectory,
  assertCanonicalRegularFile,
  assertImmutableItemAttribution,
  assertSafeWorkspacePathSegment,
  assertTurnEventPayloadLineage,
  type CaptureCoverageBinding,
  CaptureCoverageBindingSchema,
  isCurrentAgentSessionStatus,
  KnowledgeProposalRecordSchema,
  listDirectoryNames,
  listNativeProducts,
  loadWorkspace,
  loadWorkspaceFileRecords,
  type NativeProductScope,
  nativeProductMetadataScope,
  nativeProductScope,
  parseCanonicalWorkspaceHistory,
  parseOwnedKnowledgePage,
  parseWorkspaceKnowledgeProposalDocument,
  preserveDescriptiveRecord,
  projectWorkspaceSystemRecord,
  publishCanonicalPath,
  publishTurnFileInputs,
  readCanonicalTextFile,
  readNativeItemLineage,
  readNativeProduct,
  readNativeProductEntries,
  readNativeProductPages,
  readNativeThreadItem,
  readNativeThreadTurnPages,
  readNativeTurnEvents,
  readNativeTurnHistory,
  readNativeTurnHistorySteps,
  readNativeTurnItemCounts,
  readNativeTurnWriteHead,
  readWorkspaceArtifacts,
  readWorkspaceKnowledgePage,
  readWorkspaceKnowledgePages,
  readWorkspaceTurnEvents,
  refuseWorkspaceIdentityConflicts,
  serializeKnowledgeProposalRecord,
  type ThreadTimelineSnapshot,
  TURN_STREAM_EVENT_WINDOW_SIZE,
  TurnReaderSchema,
  verifyTurnFileInputs,
  type WorkspaceFileRecords,
  WorkspaceSystemRecordSchema,
  withNativeThreadTimelineSnapshot,
  workspaceFileRecordIdentities,
  writeWorkspaceConfiguration,
  writeWorkspaceFileRecords,
} from '../storage/workspace-file-records.js';
import { isTargetIssuedEffectAuthority } from '../storage/workspace-import-authority.js';
import { getWorkspaceRegistryLifecycleFact } from '../workspace-sharing.js';

type WorkspaceRecord = import('zod').infer<typeof WorkspaceRecordSchema>;
type ProtocolWorkspaceResources = import('zod').infer<typeof WorkspaceResourcesSchema>;
type WorkspaceResources = Omit<ProtocolWorkspaceResources, 'agents'> & { agents: RuntimeAgent[] };

/** Staged workspace root made available before an imported workspace is published. */
export interface ImportWorkspaceStage {
  /** Imported workspace id. */
  workspaceId: string;
  /** Same-filesystem staging root that will be renamed into the final workspace root. */
  workspaceRoot: string;
}

/** Immutable facts from this one Proposal preparation; never a current admission decision. */
interface PreparedKnowledgeProposalFacts {
  readonly selection: WorkspaceNotebookSelection;
  readonly validate?: Awaited<ReturnType<typeof prepareNotebookCandidateValidation>>;
  readonly knowledgeIds?: ReadonlySet<string>;
}

/** Exact previously inspected candidate material for the same creation projection. */
interface PreparedKnowledgeProposalProjection {
  readonly notebook: KnowledgeNotebook;
  readonly candidate: Awaited<ReturnType<KnowledgeNotebook['retainedCandidateAsync']>>;
}

type KnowledgeNotebookPage = import('zod').infer<typeof KnowledgeNotebookPageSchema>;
type Thread = import('zod').infer<typeof ThreadSchema>;
type Turn = import('zod').infer<typeof TurnSchema>;
type Item = import('zod').infer<typeof ItemSchema>;
type Artifact = import('zod').infer<typeof ArtifactSchema>;
type ApprovalRequest = import('zod').infer<typeof ApprovalRequestSchema>;
type Agent = RuntimeAgent;
type ProtocolAgentSession = import('zod').infer<typeof AgentSessionSchema>;

/** Durable app-local AgentSession stored beside protocol-safe session fields. */
export type AgentSession = ProtocolAgentSession & {
  configVersion: number | null;
  environmentPackageSnapshotId: string | null;
  /** Accepted ready native handle digest; with `id` as locator it is the resume pair. */
  nativeHandleDigest: string | null;
  /** Immutable original attachment; an absent historical generation remains unknown. */
  retainedStorage: {
    storageRef: string;
    workSlotRef: string;
    attachmentGeneration?: number;
  } | null;
  policySnapshotId: string | null;
  sessionCompatibilityKey: string | null;
  stale: boolean;
  workspaceRoots: MaterializedWorkspaceRoot[];
};
type SseEventEnvelope = import('zod').infer<typeof SseEventEnvelopeSchema>;
type AgentSessionInput = Omit<
  AgentSession,
  | 'configVersion'
  | 'environmentPackageSnapshotId'
  | 'nativeHandleDigest'
  | 'retainedStorage'
  | 'policySnapshotId'
  | 'sandboxSummary'
  | 'sessionCompatibilityKey'
  | 'stale'
  | 'workspaceRoots'
> &
  Partial<
    Pick<
      AgentSession,
      | 'configVersion'
      | 'environmentPackageSnapshotId'
      | 'nativeHandleDigest'
      | 'retainedStorage'
      | 'policySnapshotId'
      | 'sandboxSummary'
      | 'sessionCompatibilityKey'
      | 'stale'
      | 'workspaceRoots'
    >
  >;

type EventListener = (event: SseEventEnvelope) => void;
type TurnEventInput = Omit<
  SseEventEnvelope,
  'protocolVersion' | 'requestId' | 'sequence' | 'timestamp'
> & {
  requestId?: string | null;
};

/** Actual products and evidence that must commit with a service or Worker Turn outcome. */
export interface TerminalTurnPublication {
  /** Exact assigned Session projection decided with this Turn; it supplies no cleanup or release proof. */
  readonly agentSession?: Pick<AgentSession, 'id' | 'status' | 'message' | 'updatedAt'>;
  /** New or changed Items included in the terminal snapshot, in publication order. */
  readonly items?: readonly Item[];
  /** Existing ordered terminal projections committed before the final completion envelope. */
  readonly precedingEvents?: readonly TurnEventInput[];
  /** Existing Pending associations settled with this exact terminal publication. */
  readonly pending?: readonly ControlPendingCommandInput[];
  /** Original invocation correlation; omission preserves the existing null projection. */
  readonly requestId?: string | null;
  /** Observed stop cause, checked against the terminal status by the native owner. */
  readonly stopReason?: 'completed' | 'length' | 'budget_exhausted' | 'error' | 'aborted';
  /** Existing runtime evidence records; no record is inferred from product terminality. */
  readonly evidence?: ControlTerminalTransition['evidence'];
  /** Synchronized immutable content referenced by the supplied runtime evidence. */
  readonly evidenceContent?: ControlTerminalTransition['evidenceContent'];
  /** Applicable original scope-owned receipt and Audit; User receipts stay User-owned. */
  readonly command?: ControlTerminalTransition['command'];
  /** Original waiting internal Stop, acknowledged with the same terminal tuple or neither. */
  readonly interruptCommand?: ControlTerminalTransition['interruptCommand'];
  /** Actual admitted execution and step identities; omission creates no execution or release. */
  readonly execution?: ControlTerminalTransition['execution'];
}

/**
 * Stable command names tracked by the app-local idempotency ledger.
 */
export type CommandRequestName =
  | 'task.steer'
  | 'knowledge.tell'
  | 'knowledge.maintain'
  | 'knowledge.server.maintain'
  | 'knowledge.server.tell'
  | 'administration.server-mcp-create'
  | 'administration.server-mcp-stage-version'
  | 'administration.server-mcp-select-version'
  | 'administration.server-mcp-update-binding'
  | 'administration.server-mcp-remove'
  | 'vault.server-mcp-secret-create'
  | 'vault.server-mcp-secret-rotate'
  | 'vault.server-mcp-secret-revoke'
  | 'vault.server-mcp-grant-create'
  | 'vault.server-mcp-grant-revoke'
  | 'vault.server-mcp-grant-narrow'
  | 'catalog.shared-mcp-set-disabled'
  | 'catalog.skill-import'
  | 'catalog.skill-select'
  | 'catalog.skill-pin'
  | 'catalog.skill-remove'
  | 'catalog.skill-purge'
  | 'catalog.skill-candidate-submit'
  | 'catalog.skill-candidate-decide'
  | 'catalog.skill-candidate-withdraw'
  | 'workspace.create'
  | 'workspace.update'
  | 'workspace.invitation.create'
  | 'workspace.invitation.accept'
  | 'workspace.invitation.decline'
  | 'workspace.invitation.revoke'
  | 'workspace.member.remove'
  | 'workspace.leave'
  | 'workspace.ownership.transfer'
  | 'workspace.access.recover'
  | 'workspace.delete'
  | 'workspace.retire-quarantined'
  | 'user.disable'
  | 'knowledge.notebook.create'
  | 'knowledge.notebook.delete'
  | 'knowledge.package.import'
  | 'knowledge.notebook.update'
  | 'knowledge.notebook.restore'
  | 'knowledge.schema.apply'
  | 'knowledge.source.register'
  | 'thread.create'
  | 'thread.update'
  | 'thread.archive'
  | 'conversation.submit'
  | 'task.start'
  | 'turn.start'
  | 'turn.input.submit'
  | 'turn.interrupt'
  | 'git_push.approval.request'
  | 'git_push.execute'
  | 'approval.respond'
  | 'user_input.answer'
  | 'pending_request.withdraw'
  | 'workspace_sync.review.decide'
  | 'workspace_sync.recovery.decide'
  | 'knowledge.proposal.draft'
  | 'knowledge.proposal.decide'
  | 'knowledge.proposal.reverse'
  | 'goal.create'
  | 'goal.card.create'
  | 'goal.card.edit'
  | 'goal.card.cancel'
  | 'goal.plan.propose'
  | 'goal.cancel'
  | 'goal.completion.accept'
  | 'goal.start'
  | 'goal.plan'
  | 'goal.plan.approve'
  | 'goal.plan.revise'
  | 'goal.intent.revise'
  | 'goal.pause'
  | 'goal.resume'
  | 'goal.step'
  | 'goal.review.decide'
  | 'goal.steering.send'
  | 'goal.steering.follow_up'
  | 'goal.steering.cancel'
  | 'worker.recovery.retry'
  | 'worker_environment.purge'
  | 'worker_environment.prepare'
  | 'administration.configuration.apply'
  | 'worker_environment.activate'
  | 'artifact.import'
  | 'artifact.version-commit'
  | 'artifact.version-file-commit'
  | 'evaluation.candidate-set-create'
  | 'evaluation.candidate-set-select'
  | 'evaluation.judgement-add'
  | 'material.range-correct'
  | 'artifact.introduce'
  | 'artifact.submit'
  | 'artifact.review.decide'
  | 'artifact.review.select'
  | 'material.create'
  | 'material.save'
  | 'material.bind'
  | 'material.unbind'
  | 'material.exclude'
  | 'material.restore'
  | 'kernel.apps.create'
  | 'kernel.schema.update'
  | 'kernel.snapshots.rollback'
  | 'kernel.format.upgrade'
  | 'catalog.light-app-import'
  | 'catalog.light-app-history-import'
  | 'catalog.light-app-select'
  | 'catalog.light-app-pin'
  | 'kernel.apps.retire'
  | 'kernel.records.create'
  | 'kernel.records.update'
  | 'kernel.records.batch'
  | 'generative-ui.publish';

/**
 * Resource kind returned by an idempotent command.
 */
export type CommandRequestResponseKind =
  | 'catalog_mcp'
  | 'vault_reference'
  | 'vault_grant'
  | 'light_app_definition'
  | 'light_app_catalog'
  | 'skill_version'
  | 'skill_catalog'
  | 'skill_candidate'
  | 'workspace'
  | 'workspace_invitation'
  | 'workspace_member'
  | 'workspace_recovery'
  | 'workspace_deletion'
  | 'user'
  | 'knowledge'
  | 'knowledge_notebook_revision'
  | 'knowledge_schema_report'
  | 'knowledge_source'
  | 'thread'
  | 'turn'
  | 'approval'
  | 'pending_request'
  | 'git_push_record'
  | 'artifact'
  | 'artifact_review'
  | 'evaluation_candidate_set'
  | 'evaluation_judgement'
  | 'workspace_sync_review'
  | 'knowledge_proposal'
  | 'knowledge_proposal_review'
  | 'goal'
  | 'goal_plan'
  | 'goal_review'
  | 'pending_user_turn'
  | 'steering_terminal_outcome'
  | 'material'
  | 'material_revision'
  | 'thread_material_binding'
  | 'light_app'
  | 'light_app_record'
  | 'light_app_batch'
  | 'generative_presentation'
  | 'worker_environment';

/**
 * Non-secret scope identifiers used to isolate idempotency keys.
 */
export type CommandRequestScope = Readonly<Record<string, string>>;

/** Bounded, non-authoritative metadata retained only by a `conversation.submit` receipt. */
export interface ConversationCommandReceiptMetadata {
  /** Opaque target accepted by the original command. */
  readonly targetRef: string;
  /** Product-visible logical model accepted by the original command. */
  readonly logicalModelId: string | null;
  /** Actual receiving Workspace and Thread selected by the branch. */
  readonly receivingWorkspaceId: string;
  readonly receivingThreadId: string;
  /** Optional downstream business owner created by a handoff. */
  readonly downstream:
    | { readonly kind: 'task'; readonly turnId: string }
    | { readonly kind: 'goal'; readonly goalId: string; readonly turnId: string }
    | null;
  /** Closed Chat outcome needed to locate its fixed durable owners. */
  readonly resultKind:
    | 'knowledge-answer'
    | 'provider-answer'
    | 'clarification'
    | 'task-handoff'
    | 'goal-handoff'
    | 'worker-turn'
    | 'goal-intent'
    | 'goal-steering'
    | 'refused';
  /** Original successful HTTP status for the closed outcome. */
  readonly status: 200 | 202;
}

/**
 * Resource pointer stored for replaying an idempotent command response.
 */
export interface CommandRequestResponse {
  /** Resource kind produced by the original command. */
  kind: CommandRequestResponseKind;
  /** Resource id produced by the original command. */
  id: string;
  /** Bounded receipt metadata allowed only for `conversation.submit`. */
  conversationMetadata?: ConversationCommandReceiptMetadata;
  /** Completed Task steer result; native dispatch evidence stays with its existing Harness owner. */
  steerMetadata?: TaskSteerReceiptMetadata;
}

/**
 * Persisted idempotency ledger record.
 */
export interface CommandRequestRecord {
  /** Stable ledger key derived from command, scope, and request id. */
  key: string;
  /** Command name that accepted the request. */
  command: CommandRequestName;
  /** Caller-supplied idempotency and correlation id. */
  requestId: string;
  /** Non-secret scope ids used for deduplication. */
  scope: CommandRequestScope;
  /** Hash of canonical command input. */
  inputHash: string;
  /** Resource pointer returned by the command. */
  response: CommandRequestResponse;
  /** Timestamp when the record was created. */
  createdAt: string;
  /** Timestamp when the record should be pruned. */
  expiresAt: string;
}

/**
 * Input used to create one idempotency ledger record.
 */
export interface CommandRequestRecordInput {
  /** Command name that accepted the request. */
  command: CommandRequestName;
  /** Caller-supplied idempotency and correlation id. */
  requestId: string;
  /** Non-secret scope ids used for deduplication. */
  scope: CommandRequestScope;
  /** Hash of canonical command input. */
  inputHash: string;
  /** Resource pointer returned by the command. */
  response: CommandRequestResponse;
  /** Optional creation timestamp for tests and migrations. */
  createdAt?: string;
  /** Optional expiry timestamp for tests and migrations. */
  expiresAt?: string;
}

/** Immutable create-only Knowledge Proposal stored before human review. */
export type KnowledgeProposalRecord = Omit<
  KnowledgeManagerDraftProposalResponse['proposal'],
  'status'
>;

/** Append-only human decision row for one Knowledge Proposal. */
export type KnowledgeProposalReviewRecord = KnowledgeProposalReview;

/** Input used to create one deterministic immutable Knowledge Proposal. */
export interface CreateKnowledgeProposalInput extends KnowledgeManagerDraftProposalRequest {
  /** Workspace that owns the proposal. */
  workspaceId: string;
  /** Exact external-owner references already verified by the calling authority. */
  verifiedExternalReferences: readonly string[];
  /** Authenticated producer assigned by the calling route. */
  producer: ActorRef;
  /** Canonical proposal creation timestamp. */
  createdAt: string;
}

/** Native exact multi-page candidate; caller supplies current Source and scope admission. */
export interface CreateNotebookProposalInput extends NotebookEdit {
  workspaceId: string;
  sourceReferences: readonly string[];
  verifiedExternalReferences: readonly string[];
  producer: ActorRef;
  createdAt: string;
}

/** Input used to append one human Knowledge Proposal decision. */
export interface RecordKnowledgeProposalReviewDecisionInput
  extends SubmitKnowledgeProposalDecisionRequest {
  /** Workspace that owns the proposal. */
  workspaceId: string;
  /** Immutable proposal receiving the decision. */
  proposalId: string;
  /** Exact external-owner references reverified by the calling authority. */
  verifiedExternalReferences: readonly string[];
  /** Authenticated human actor assigned by the calling route. */
  actor: ActorRef;
  /** Canonical decision timestamp. */
  decidedAt: string;
}

/** Knowledge source kind tracked by the first source registry slice. */
export type KnowledgeSourceKind = 'upload' | 'url' | 'document' | 'transcript' | 'code';

/**
 * Stored workspace source identity record.
 */
export interface KnowledgeSourceRecord {
  /** Stable source id. */
  id: string;
  /** Workspace that owns the source. */
  workspaceId: string;
  /** Source material category. */
  kind: KnowledgeSourceKind;
  /** Human-readable source title. */
  title: string;
  /** External or workspace URI when one exists. */
  uri: string | null;
  /** Stable digest for the captured source bytes or text. */
  contentDigest: string;
  /** Thread that originated the source capture, when applicable. */
  originatingThreadId: string | null;
  /** Turn that originated the source capture, when applicable. */
  originatingTurnId: string | null;
  /** File id from the originating turn input, when applicable. */
  originatingFileId: string | null;
  /** ISO timestamp when the source was captured. */
  capturedAt: string;
  /** ISO timestamp for creation. */
  createdAt: string;
  /** ISO timestamp for latest update. */
  updatedAt: string;
}

interface TurnStreamState {
  sequence: number;
  events: SseEventEnvelope[];
  listeners: Set<EventListener>;
}

/** Default admission-time capture pair when no authored switch is on. */
export const DEFAULT_CAPTURE_COVERAGE_BINDING: CaptureCoverageBinding = {
  scope: 'server',
  value: 'off',
};

interface CreateTurnOptions {
  /** Actual initiating command facts committed with this admitted Turn, never a later receipt backfill. */
  commandReceipt?: IdempotentCommandReceipt;
  /** Exact entry-owned response metadata, including a selected Worker's original conversation receipt. */
  commandReceiptResponse?: CommandRequestRecord['response'];
  /** Native internal-role admission facts retained on the existing Turn. */
  internalExecution?: Turn['internalExecution'];
  /** Exact ordered metadata and verified private payload sources published with this Turn. */
  fileInputs?: Turn['fileInputs'];
  /** Private same-filesystem sources; never serialized into protocol records. */
  filePayloadPaths?: readonly string[];
  /** Shared runtime disk owner for exact serialized writes of a fresh file Turn. */
  fileWriteAdmission?: FileStorageAdmission;
  /** Entry-owned final synchronous request, authority and capacity check. */
  assertFileInputAdmission?: () => void;
  /** Scheduler-owned turn id when external coordination already reserved lineage. */
  turnId?: string;
  /** Immutable explicit or composed effort captured when the Turn is admitted. */
  reasoningEffort?: Turn['reasoningEffort'];
  /** Exact per-run Skill input captured on the canonical admitted Turn. */
  skillSelections?: Turn['skillSelections'];
  /** Command-owned start time when a Core-local Turn must share one accepted timestamp. */
  startedAt?: string;
  /** Admission-time capture pair when the caller already resolved the effective setting. */
  captureCoverage?: CaptureCoverageBinding;
  /** Initial status. Ordinary turns start running. Outcome turns may start pending. */
  status?: 'pending' | 'running';
  /** Agent bound at admission. */
  agentId?: string | null;
  /** AgentSession bound at admission. */
  agentSessionId?: string | null;
  /** Trigger recorded at admission. */
  triggerSource?: Turn['triggerSource'];
  /** Executor that this admission may freeze outcomes for. */
  executorKind?: 'worker' | 'assistant' | 'coordinator' | 'person';
}

/** Server admission shares existing internal-role Turn choices without Workspace file or runtime hooks. */
export type CreateServerTurnOptions = Pick<
  CreateTurnOptions,
  | 'turnId'
  | 'startedAt'
  | 'internalExecution'
  | 'reasoningEffort'
  | 'skillSelections'
  | 'triggerSource'
  | 'agentId'
  | 'captureCoverage'
> & { status?: Turn['status']; completedAt?: string };

const SERVER_TURN_UPDATE_FIELDS = [
  'agentId',
  'agentProfileId',
  'agentSessionId',
  'completedAt',
  'configVersion',
  'durationMs',
  'error',
  'status',
  'triggerSource',
  'internalExecution',
];

/** Existing mutable Turn lifecycle fields for Server-owned history. */
export type ServerTurnUpdate = Partial<
  Pick<
    Turn,
    | 'agentId'
    | 'agentProfileId'
    | 'agentSessionId'
    | 'completedAt'
    | 'configVersion'
    | 'durationMs'
    | 'error'
    | 'status'
    | 'triggerSource'
    | 'internalExecution'
  >
>;

/** Transcript input without server-authored ordering and ownership. */
export type ServerTurnEventInput = Omit<
  ServerTurnEventEnvelope,
  'owner' | 'protocolVersion' | 'requestId' | 'sequence' | 'timestamp'
> & { requestId?: string | null };

/** Original Worker submission facts joined to Artifact files, its native reference, Review, events and receipt. */
export interface ArtifactSubmissionPublication {
  readonly review: CreateArtifactReviewInput;
  readonly receipt: Extract<ControlReviewCommandInput, { mode: 'submit' }>['receipt'];
  readonly fileAdmission: FileStorageAdmission;
}

/** Hooks invoked when a Turn is admitted or first becomes terminal. */
export interface TurnAdmissionHooks {
  /** Freezes matching ready outcomes into the admitted Turn. */
  onAdmitted?: (turn: Turn) => void | Promise<void>;
  /** Prepares immutable outcome projections; the native owner freezes them with admission. */
  prepareAdmission?: (
    turn: Turn,
    executor?: 'worker' | 'assistant' | 'coordinator' | 'person'
  ) =>
    | { items: readonly Item[]; pending: readonly ControlPendingCommandInput[] }
    | Promise<{ items: readonly Item[]; pending: readonly ControlPendingCommandInput[] }>;
  /** Supplies owned terminal association changes to the same native terminal tuple. */
  prepareTerminal?: (turn: Turn) => readonly ControlPendingCommandInput[];
  /** Commits the minimal Task result before canonical file publication. */
  onTerminalFact?: (turn: Turn) => void;
  /** Admits the next outcome Turn after a terminal barrier. */
  onTerminal?: (turn: Turn) => void | Promise<void>;
}

/** Completes an already-decided publication against a sealed-terminal Turn. */
export const ALREADY_DECIDED_PUBLICATION_ADMISSION = {
  category: 'already-decided-publication',
} as const;

/** Explicit trusted progress status producer; this grants no post-terminal authority or weaker ACK. */
export const RETAINED_PROGRESS_PUBLICATION = 'progress' as const;

/** Item fields admitted by the named post-terminal display-projection refresh. */
export const DISPLAY_PROJECTION_REFRESH_FIELDS = ['level', 'title', 'summary'] as const;

/** Named field-limited display-projection refresh; this is not already-decided publication. */
export const DISPLAY_PROJECTION_REFRESH_ADMISSION = {
  category: 'display-projection-refresh',
} as const;

/**
 * Configuration-apply marker Item on the Turn that executes the apply.
 * Pending docs/specs/20260930-pending_requests.md; this category stays admitted.
 */
export const CONFIGURATION_APPLY_PENDING_DELAYED_USER_INPUT_ADMISSION = {
  category: 'configuration-apply-pending-delayed-user-input',
} as const;

/** Admission for completing an already-decided publication after terminal. */
export type AlreadyDecidedPublicationAdmission = typeof ALREADY_DECIDED_PUBLICATION_ADMISSION;

/** Admission for a named field-limited display-projection refresh after terminal. */
export type DisplayProjectionRefreshAdmission = typeof DISPLAY_PROJECTION_REFRESH_ADMISSION;

/** Admission for the configuration-apply marker pending delayed-user-input ownership. */
export type ConfigurationApplyPendingDelayedUserInputAdmission =
  typeof CONFIGURATION_APPLY_PENDING_DELAYED_USER_INPUT_ADMISSION;

/** Declared post-terminal write category; the two equality rules stay separate types. */
export type TerminalTurnWriteAdmission =
  | AlreadyDecidedPublicationAdmission
  | DisplayProjectionRefreshAdmission
  | ConfigurationApplyPendingDelayedUserInputAdmission;

/** Accepted store input for one workspace-only Artifact introduction. */
export interface IntroduceArtifactInput {
  /** Workspace that owns the Artifact and Thread. */
  readonly workspaceId: string;
  /** Idle Thread that will receive the Core-local Turn. */
  readonly threadId: string;
  /** Workspace-only imported Artifact to communicate. */
  readonly artifactId: string;
  /** Exact Artifact version accepted by the caller. */
  readonly expectedArtifactVersion: number;
  /** Command identity copied into the reference proof. */
  readonly requestId: string;
  /** Accepted command timestamp. */
  readonly acceptedAt: string;
  /** Deterministic Core-local Turn id reserved by the command owner. */
  readonly turnId: string;
  /** Exact authenticated actor whose command created the introduction Turn. */
  readonly triggerActor: ActorRef;
}

/** One admitted manual revision; its completed Core-local Turn supplies Item-backed publication. */
export interface CommitArtifactVersionInput {
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly threadId: string;
  readonly expectedArtifactVersion: number;
  readonly actor: ActorRef;
  readonly requestId: string;
  readonly recordedAt: string;
  readonly title: string;
  readonly summary: string | null;
  readonly content: Artifact['content'];
  readonly contentDigest?: string;
  readonly command?: 'artifact.version-commit' | 'artifact.version-file-commit';
}

/**
 * Optional store configuration.
 */
export interface FsStoreOptions {
  /** Optional data root for durable file-backed storage. */
  dataRoot?: string;
  /** Actual admitted Workspace connection, borrowed for the existing native read/compute lifetime. */
  nativeProductScope?: NativeProductScope;
  /** Original Main admission facts supplied only to the native request lifetime. */
  scopeRefusals?: readonly ScopeAdmissionFailure[];
}

function now(): string {
  return new Date().toISOString();
}

/** Closed product-safe failure codes raised by Knowledge Proposal authority. */
export type KnowledgeProposalAuthorityErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'recovery_required';

/**
 * Creates one bounded Knowledge Proposal authority failure.
 *
 * @param code Stable public failure code.
 * @returns Error carrying the corresponding HTTP status.
 */
/** Native Knowledge Proposal refusal; only its owning family projects it. */
export class KnowledgeProposalAuthorityError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(readonly code: KnowledgeProposalAuthorityErrorCode) {
    super('Knowledge Proposal authority check failed.');
    this.status = code === 'invalid_request' ? 400 : code === 'not_found' ? 404 : 409;
  }
}

export function knowledgeProposalAuthorityError(
  code: KnowledgeProposalAuthorityErrorCode
): Error & { code: KnowledgeProposalAuthorityErrorCode; status: 400 | 404 | 409 } {
  return new KnowledgeProposalAuthorityError(code);
}

/**
 * Computes one lowercase SHA-256 content digest over exact UTF-8 bytes.
 *
 * @param content Exact content bytes represented as a UTF-8 string.
 * @returns Prefixed content digest.
 */
function contentDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/**
 * Checks whether one idempotency record has expired.
 *
 * @param record Ledger record to inspect.
 * @param referenceTime Timestamp used as the current time.
 * @returns True when the record is expired.
 */
function isCommandRequestExpired(record: CommandRequestRecord, referenceTime: string): boolean {
  return new Date(record.expiresAt).getTime() <= new Date(referenceTime).getTime();
}

/**
 * Resolves the current owner-only personal Workspace, retaining the original derivation for an absent binding.
 *
 * @param userId Canonical user id.
 * @param dataRoot Actual Core owner, when present; in-memory callers retain the initial derivation.
 * @returns Current bound personal Workspace id, or its original identity when no binding exists.
 */
export function quickChatWorkspaceIdForUser(userId: string, dataRoot?: string | null): string {
  const initialId = deriveEntityId('ws', ['quick_chat', userId]);
  if (!dataRoot) return initialId;
  const core = openControlStoreProductReadHandle(coreDbPath(dataRoot), { kind: 'server' });
  try {
    return resolvePersonalWorkspaceIdInDb(core, userId);
  } finally {
    core.close();
  }
}

/**
 * Builds a product-safe sandbox summary from app-local workspace roots.
 *
 * @param roots Workspace roots captured for a session.
 * @returns Stable sandbox summary without host paths.
 */
function sandboxSummaryForWorkspaceRoots(
  roots: MaterializedWorkspaceRoot[]
): ProtocolAgentSession['sandboxSummary'] {
  if (roots.length === 0) {
    return null;
  }

  return {
    access: roots.some((root) => root.access === 'read-write') ? 'read-write' : 'read-only',
    workspaceRootRefs: roots.map((root) => root.id),
    summary: `${roots.length} workspace root${roots.length === 1 ? '' : 's'} materialized.`,
  };
}

/**
 * Returns empty dynamic resources for a workspace.
 *
 * @param knowledge Seed canonical Notebook pages.
 * @returns Workspace resources without a second agent or model catalog.
 */
function createWorkspaceResources(knowledge: KnowledgeNotebookPage[] = []): WorkspaceResources {
  return {
    knowledge,
    skills: [],
    agents: [],
    models: [],
  };
}

/** Builds the canonical empty history used when publishing a new Workspace. */
function emptyWorkspaceFileRecords(workspace: WorkspaceRecord): WorkspaceFileRecords {
  return {
    workspace,
    knowledge: [],
    threads: [],
    turns: [],
    itemRevisions: [],
    artifacts: [],
    knowledgeProposals: [],
    knowledgeProposalReviews: [],
    knowledgeSources: [],
    agentSessions: [],
    streamEvents: [],
  };
}

/** Title write guard. The name is the title captured when generation started. */
export interface ThreadUpdatePrecondition {
  readonly status: 'active';
  readonly name: string;
}

/** The thread was renamed, archived, deleted, or otherwise no longer matches the guarded title. */
export class ThreadUpdatePreconditionError extends Error {
  public constructor() {
    super('Thread no longer has the expected active title.');
    this.name = 'ThreadUpdatePreconditionError';
  }
}

/** Refuses a title write when the same record read is no longer the guarded active name. */
export function assertThreadUpdatePrecondition(
  record: { readonly status?: unknown; readonly name?: unknown },
  precondition: ThreadUpdatePrecondition | undefined
): void {
  if (!precondition) return;
  if (record.status !== precondition.status || record.name !== precondition.name) {
    throw new ThreadUpdatePreconditionError();
  }
}

/** Live native references share their physical scope across Store views; failed imports cannot erase them. */
const pendingArtifactReferences = new Map<string, number>();

/**
 * Native product Store with immutable Storage history and independent file-owned resources.
 */
export class FsStore {
  // A failed post-rename sync leaves visible bytes uncertain and caches stale until ordinary reopen.
  private readonly unacknowledgedWorkspaces = new Set<string>();
  private workspaces = new Map<string, WorkspaceRecord>();
  private workspaceResources = new Map<string, WorkspaceResources>();
  private workspaceResourcePolicyProjection:
    | ((workspaceId: string) => PolicyDocumentV1 | null)
    | null = null;
  private workspaceAgentCatalogProjection: (() => RuntimeAgent[]) | null = null;
  private serverThreads = new Map<string, Thread>();
  private serverTurns = new Map<string, Turn>();
  private serverItems = new Map<string, Item>();
  private serverStreams = new Map<
    string,
    {
      sequence: number;
      events: ServerTurnEventEnvelope[];
      listeners: Set<(event: ServerTurnEventEnvelope) => void>;
    }
  >();
  private threads = new Map<string, Thread>();
  private turns = new Map<string, Turn>();
  private items = new Map<string, Item>();
  private itemRevisions: Item[] = [];
  private approvals = new Map<string, ApprovalRequest>();
  private agentSessions = new Map<string, AgentSession>();
  private artifacts = new Map<string, Artifact>();
  /** Durable file heads awaiting the native submission acknowledgement; readers cannot expose them. */
  private pendingArtifactSubmissions = new Set<string>();
  private artifactVersions = new Map<string, ArtifactVersionRecord[]>();
  private knowledgeProposals = new Map<string, KnowledgeProposalRecord>();
  private knowledgeProposalReviews = new Map<string, KnowledgeProposalReviewRecord[]>();
  private commandRequests = new Map<string, CommandRequestRecord>();
  private streams = new Map<string, TurnStreamState>();
  // C2-B2: retain only after-ACK notification proofs, so the pure tail needs neither I/O nor an await.
  private readonly acknowledgedTurnEvents = new WeakMap<
    object,
    SseEventEnvelope | ServerTurnEventEnvelope
  >();
  private liveCaptureCoverage: CaptureCoverageBinding = DEFAULT_CAPTURE_COVERAGE_BINDING;
  private turnCaptureCoverage = new Map<string, CaptureCoverageBinding>();
  private turnExecutors = new Map<string, 'worker' | 'assistant' | 'coordinator' | 'person'>();
  private turnAdmissionHooks: TurnAdmissionHooks | null = null;
  private terminalHookDepth = 0;
  private workspaceMutationAdmission?: WorkspaceMutationAdmission;
  private readonly dataRoot: string | null;
  /** A request-scoped existing owner binding; never an owned connection or a second Store. */
  private readonly borrowedProductScope?: NativeProductScope;
  private readonly suppliedScopeRefusals: readonly ScopeAdmissionFailure[] | undefined;

  /** Validates native product closure and file-owned resources after their native journals are present. */
  public static validateFileAuthority(dataRoot: string): void {
    const server = loadServerThreadRecords(dataRoot);
    const serverIds = new Set([
      ...server.threads.map(({ id }) => id),
      ...server.turns.flatMap((turn) => [turn.id, ...turn.items.map(({ id }) => id)]),
    ]);
    for (const records of loadWorkspaceFileRecords(dataRoot)) {
      try {
        FsStore.readWorkspaceHistory(
          records,
          join(dataRoot, 'workspaces', records.workspace.id),
          serverIds
        );
      } catch {
        refuseScope(dataRoot, { scope: 'workspace', id: records.workspace.id, check: 'records' });
      }
    }
  }

  /** Uses the same retained lineage and Artifact version checks for boot admission and disposable projections. */
  private static readWorkspaceHistory(
    records: WorkspaceFileRecords,
    workspaceRoot: string,
    serverIds: ReadonlySet<string>
  ): Map<string, ArtifactVersionRecord[]> {
    const versions = new Map<string, ArtifactVersionRecord[]>();
    for (const thread of records.threads) {
      if (serverIds.has(thread.id)) throw new Error('Conflicting Thread owner.');
    }
    const turns = new Map(records.turns.map((turn) => [turn.id, turn]));
    for (const turn of records.turns) {
      if (serverIds.has(turn.id)) throw new Error('Conflicting Turn owner.');
      for (const item of turn.items) {
        if (serverIds.has(item.id)) throw new Error('Conflicting Item owner.');
        if (
          item.type === 'user-input-request' &&
          item.responsibleUserId !== responsibleUserIdForActor(turn.triggerActor)
        ) {
          throw new Error('Invalid responsible user.');
        }
        if (item.type === 'user-input-response') {
          const request = turn.items.find(
            (candidate) =>
              candidate.type === 'user-input-request' &&
              candidate.userInputRequestId === item.userInputRequestId
          );
          if (
            request?.type === 'user-input-request' &&
            request.responsibleUserId !== item.actor.id
          ) {
            throw new Error('Invalid response actor.');
          }
        }
      }
    }
    for (const artifact of records.artifacts) {
      versions.set(
        artifact.id,
        readArtifactVersionHistory(workspaceRoot, artifact, turns, records.itemRevisions)
      );
    }
    return versions;
  }

  public constructor(options: FsStoreOptions = {}) {
    this.dataRoot =
      options.dataRoot ?? (process.env.OPENKIT_DATA_ROOT ? resolveDataRoot(process.env) : null);

    this.suppliedScopeRefusals = options.scopeRefusals;
    if (options.nativeProductScope) {
      const scope = options.nativeProductScope;
      if (
        !this.dataRoot ||
        scope.owner.kind !== 'workspace' ||
        !scope.sqlite ||
        resolve(scope.path) !== resolve(workspaceDbPath(this.dataRoot, scope.owner.workspaceId)) ||
        !isDeepStrictEqual(
          scope.contentMount,
          nativeProductScope(this.dataRoot, scope.owner).contentMount
        )
      )
        throw new NotebookError('recovery_required');
      // The physical owner admitted the scope and retains its connection and transaction.
      const reader = openControlStoreProductReadHandle(scope.path, scope.owner, scope.sqlite);
      reader.close();
      this.borrowedProductScope = scope;
      return;
    }
    if (this.dataRoot) {
      this.liveCaptureCoverage = captureCoverageBindingFromOpenKitConfig(
        loadOpenKitConfig(this.dataRoot)
      );
      const serverRecords = loadServerThreadRecords(this.dataRoot);
      for (const thread of serverRecords.threads) this.serverThreads.set(thread.id, thread);
      for (const turn of serverRecords.turns) {
        this.serverTurns.set(turn.id, turn);
        for (const item of turn.items) this.serverItems.set(item.id, item);
        const events = serverRecords.turnEvents.get(turn.id) ?? [];
        this.serverStreams.set(turn.id, {
          sequence: events.at(-1)?.sequence ?? 0,
          events: events.slice(-TURN_STREAM_EVENT_WINDOW_SIZE),
          listeners: new Set(),
        });
      }
      for (const [turnId, binding] of serverRecords.turnCaptureCoverage)
        this.turnCaptureCoverage.set(turnId, binding);
      const workspaceRecords = loadWorkspaceFileRecords(this.dataRoot);

      if (workspaceRecords.length > 0) {
        this.restoreWorkspaceFileRecords(workspaceRecords);
        return;
      }
    }
  }

  /**
   * Restores in-memory indexes from canonical workspace file records.
   *
   * @param workspaceRecords Canonical records loaded for every published workspace.
   */
  private restoreWorkspaceFileRecords(workspaceRecords: readonly WorkspaceFileRecords[]): void {
    const serverIds = new Set([
      ...this.serverThreads.keys(),
      ...this.serverTurns.keys(),
      ...this.serverItems.keys(),
    ]);
    for (const records of workspaceRecords) {
      let versions: Map<string, ArtifactVersionRecord[]>;
      try {
        versions = FsStore.readWorkspaceHistory(
          records,
          this.workspaceRootPath(records.workspace.id),
          serverIds
        );
      } catch (error) {
        if (!this.dataRoot) throw error;
        refuseScope(this.dataRoot, {
          scope: 'workspace',
          id: records.workspace.id,
          check: 'records',
        });
        continue;
      }
      this.installWorkspaceProjection(records, versions);
    }

    if (this.dataRoot) {
      for (const approval of loadApprovalProjections(
        this.dataRoot,
        [...this.turns.values()],
        [...this.commandRequests.values()]
      )) {
        this.approvals.set(approval.id, approval);
      }
    }
  }

  /** Installs already-validated target records without I/O or cross-Workspace discovery. */
  private installWorkspaceProjection(
    records: WorkspaceFileRecords,
    versions: ReadonlyMap<string, ArtifactVersionRecord[]>
  ): void {
    this.workspaces.set(records.workspace.id, records.workspace);
    this.workspaceResources.set(
      records.workspace.id,
      createWorkspaceResources([...records.knowledge])
    );
    for (const thread of records.threads) this.threads.set(thread.id, thread);
    for (const turn of records.turns) {
      this.turns.set(turn.id, turn);
      for (const item of turn.items) this.items.set(item.id, item);
    }
    if (records.turnCaptureCoverage) {
      for (const [turnId, binding] of records.turnCaptureCoverage) {
        this.turnCaptureCoverage.set(turnId, binding);
      }
    }
    this.itemRevisions.push(...records.itemRevisions);
    for (const session of records.agentSessions) {
      this.agentSessions.set(session.id, session);
    }
    for (const artifact of records.artifacts) {
      this.artifacts.set(artifact.id, artifact);
      this.artifactVersions.set(artifact.id, versions.get(artifact.id)!);
    }

    for (const proposal of records.knowledgeProposals) {
      this.knowledgeProposals.set(proposal.id, proposal);
    }
    for (const review of records.knowledgeProposalReviews) {
      this.knowledgeProposalReviews.set(review.proposalId, [
        ...(this.knowledgeProposalReviews.get(review.proposalId) ?? []),
        review,
      ]);
    }
    for (const [turnId, events] of records.streamEvents) {
      this.streams.set(turnId, {
        sequence: events.at(-1)?.sequence ?? 0,
        events: [...events],
        listeners: new Set(),
      });
    }
  }

  /**
   * Removes expired idempotency ledger records.
   *
   * @returns True when at least one record was removed.
   */
  private pruneExpiredCommandRequests(): boolean {
    const referenceTime = now();
    let changed = false;

    for (const [key, record] of this.commandRequests.entries()) {
      if (isCommandRequestExpired(record, referenceTime)) {
        this.commandRequests.delete(key);
        changed = true;
      }
    }

    return changed;
  }

  /**
   * Returns active idempotency records for tests and diagnostics.
   *
   * @param workspaceId Optional exact Workspace owner; unrelated scopes are not opened.
   * @returns Non-expired idempotency records in the selected scope.
   */
  public listCommandRequests(workspaceId?: string): CommandRequestRecord[] {
    if (this.dataRoot) {
      return listCommandRequestRecords(this.dataRoot, now(), workspaceId);
    }

    this.pruneExpiredCommandRequests();

    return [...this.commandRequests.values()].filter(
      (record) => workspaceId === undefined || record.scope.workspaceId === workspaceId
    );
  }

  /**
   * Looks up one non-expired idempotency record.
   *
   * @param command Stable command name.
   * @param requestId Caller-supplied idempotency id.
   * @param scope Non-secret command scope ids.
   * @param commandDb Optional open Core, User, Workspace or App database for owner-local reads.
   * @returns Matching command request record, or null.
   */
  public getCommandRequest(
    command: CommandRequestName,
    requestId: string,
    scope: CommandRequestScope,
    commandDb?: CoreDb | UserDb | WorkspaceDb | AppDb
  ): CommandRequestRecord | null {
    const key = commandRequestKey(command, requestId, scope);

    if (commandDb) {
      return getCommandRequestRecordFromDb(commandDb, key, now());
    }

    if (this.dataRoot) {
      return getCommandRequestRecord(this.dataRoot, scope, key, now());
    }

    this.pruneExpiredCommandRequests();

    return this.commandRequests.get(key) ?? null;
  }

  /** Acknowledges the original post-product Workspace command receipt and its separate expiry maintenance. */
  public async publishWorkspaceCommandReceipt(receipt: WorkspaceCommandReceipt): Promise<void> {
    if (!this.dataRoot)
      throw new Error('Workspace command receipts require persistent scope ownership.');
    await getControlStoreWorkerClient().recordWorkspaceCommandReceipt(this.dataRoot, receipt);
  }

  /** Commits one completed steer receipt and Audit without changing live or terminal product content. */
  public async publishTaskSteerReceipt(
    admission: Pick<ControlAdmission, 'receipt' | 'audit'>
  ): Promise<void> {
    if (admission.receipt.command !== 'task.steer' || !admission.receipt.scope.workspaceId)
      throw new Error('Task steer requires its original Workspace receipt scope.');
    if (this.dataRoot) {
      await this.writeNativeProducts(
        this.nativeScope({ kind: 'workspace', workspaceId: admission.receipt.scope.workspaceId }),
        [],
        [],
        admission
      );
    } else {
      if (admission.receipt.response.kind !== 'turn' || !admission.receipt.response.steerMetadata)
        throw new Error('Task steer requires its completed Turn disposition.');
      this.recordCommandRequest({
        ...admission.receipt,
        command: 'task.steer',
        response: {
          kind: 'turn',
          id: admission.receipt.response.id,
          steerMetadata: admission.receipt.response.steerMetadata,
        },
      });
    }
  }

  /**
   * Records the resource pointer for a completed idempotent command.
   *
   * @param input Idempotency record input.
   * @param commandDb Optional open Core, User, Workspace or App database for owner-local writes.
   * @returns Persisted idempotency record.
   */
  public recordCommandRequest(
    input: CommandRequestRecordInput,
    commandDb?: CoreDb | UserDb | WorkspaceDb | AppDb
  ): CommandRequestRecord {
    const createdAt = input.createdAt ?? now();
    const record: CommandRequestRecord = {
      key: commandRequestKey(input.command, input.requestId, input.scope),
      command: input.command,
      requestId: input.requestId,
      scope: input.scope,
      inputHash: input.inputHash,
      response: normalizeCommandRequestResponse(input.command, input.response),
      createdAt,
      expiresAt: input.expiresAt ?? commandRequestExpiresAt(createdAt),
    };

    if (commandDb) {
      recordCommandRequestRecordInDb(commandDb, record);
    } else if (this.dataRoot) {
      recordCommandRequestRecord(this.dataRoot, record);
    } else {
      this.commandRequests.set(record.key, record);
    }

    return record;
  }

  /** Refuses stale Workspace state after a failed canonical directory commit; only reopen clears it. */
  private assertWorkspacePublicationAcknowledged(workspaceId: string): void {
    if (this.dataRoot)
      assertScopeAdmitted(this.dataRoot, 'workspace', workspaceId, this.suppliedScopeRefusals);
    if (this.unacknowledgedWorkspaces.has(workspaceId)) {
      throw new CanonicalPublicationError(
        'FsStore: directory synchronization failed after rename during publication acknowledgement. Ordinary Store reopen is required.'
      );
    }
  }

  /** Applies the same refusal to opaque Turn reads without changing absent-id behavior. */
  private assertTurnPublicationAcknowledged(turnId: string): void {
    const lineage = this.dataRoot ? this.getTurnLineage(turnId) : null;
    if (lineage) this.assertWorkspacePublicationAcknowledged(lineage.workspaceId);
    else {
      const turn = this.turns.get(turnId);
      if (turn) this.assertWorkspacePublicationAcknowledged(workspaceIdForOwner(turn.owner));
    }
  }

  /**
   * Writes independently file-owned resources; activated products never pass through this writer.
   *
   * @param workspaceId Workspace to persist.
   * @param updateWorkspaceConfigName Whether Core may refresh its owned config name.
   * @param initialArtifact Actual admitted initial version and optional original, consumed by its directory publication.
   */
  private persist(
    workspaceId: string,
    updateWorkspaceConfigName = false,
    initialArtifact?: { readonly record: ArtifactVersionRecord; readonly payloadPath?: string }
  ): void {
    if (!this.dataRoot) {
      return;
    }

    const startedAt = performance.now();
    try {
      this.assertWorkspacePublicationAcknowledged(workspaceId);
      const workspaceRoot = ensureWorkspaceLayout(this.dataRoot, workspaceId).root;
      try {
        this.writeWorkspaceFileRecordsToRoot(
          workspaceId,
          workspaceRoot,
          updateWorkspaceConfigName,
          initialArtifact
        );
      } catch (error) {
        if (error instanceof CanonicalPublicationError) {
          this.unacknowledgedWorkspaces.add(workspaceId);
        }
        throw error;
      }
    } finally {
      try {
        const durationMs = performance.now() - startedAt;
        if (durationMs >= 100) {
          console.error(
            JSON.stringify({
              stage: 'workspace-persist',
              durationMs: Math.round(durationMs),
              timestamp: new Date().toISOString(),
              workspaceId,
            })
          );
        }
      } catch {
        // Diagnostics must not change the owning operation.
      }
    }
  }

  /**
   * Publishes one new workspace with its migrated database through a same-filesystem staging root.
   *
   * @param records Complete canonical records to publish.
   * @param knowledgeBaseId Fresh or already-reminted default identity supplied by native creation/import.
   * @param stageWorkspace Optional side-effect writer that runs under the staging root.
   * @param notebookInitialization Actual native creation attribution, required for file-backed publication.
   * @param initialNotebookFiles Exact admitted root tree; retained imports must not be regenerated from entry projections.
   * @param initialNotebookSchemaText Exact imported scope schema; fresh creation uses the default schema.
   * @param initialNotebookSources Verified and reminted Source blobs in the same first Notebook tree.
   * @param fileWriteAdmission Request admission for synchronous staging and final file publication. No scope spans native content awaits.
   * @param finalizeNativeWorkspace Stopped private SQL dependencies, after native history verification and before publication.
   */
  private async persistNewWorkspaceAtomically(
    records: WorkspaceFileRecords,
    knowledgeBaseId: string,
    stageWorkspace?: (stage: ImportWorkspaceStage) => void,
    notebookInitialization?: NotebookInitialization,
    initialNotebookFiles?: Readonly<Record<string, string>>,
    initialNotebookSchemaText?: string,
    initialNotebookSources?: Readonly<Record<string, string>>,
    fileWriteAdmission?: FileStorageAdmission,
    finalizeNativeWorkspace?: (stage: ImportWorkspaceStage) => void
  ): Promise<void> {
    const dataRoot = this.dataRoot;
    if (!dataRoot) {
      return;
    }
    if (!notebookInitialization) {
      throw new Error('Fresh Workspace publication requires native notebook attribution.');
    }
    if (records.knowledge.length && !initialNotebookFiles) {
      throw new Error('Workspace import requires exact admitted notebook bytes.');
    }

    const workspaceId = records.workspace.id;
    const finalRoot = this.workspaceRootPath(workspaceId);
    const stagingRoot = join(dirname(finalRoot), '.staging', `${workspaceId}-${randomUUID()}`);
    const stagingParent = dirname(stagingRoot);

    if (existsSync(finalRoot)) {
      throw new Error(`Workspace path already exists: ${workspaceId}`);
    }

    try {
      let initialWorkspaceDb: WorkspaceDb | undefined;
      let initialSchemaText: string | undefined;
      const prepareFiles = () => {
        ensureLayoutDirectories(dataRoot);
        mkdirSync(stagingParent, { recursive: true });
        assertCanonicalDirectory(stagingParent);
        // A private initializer may never overwrite a live scope or a previous staging invocation.
        if (existsSync(stagingRoot) || existsSync(finalRoot))
          throw new Error('Workspace bootstrap requires a genuinely unpublished scope.');
        mkdirSync(stagingRoot, { mode: 0o700 });
        writeWorkspaceConfiguration(stagingRoot, records.workspace, false);
        initializeDefaultKnowledgeBaseId({
          dataRoot,
          workspaceRoot: stagingRoot,
          scope: { kind: 'workspace', workspaceId },
          knowledgeBaseId,
        });
        initialWorkspaceDb = openWorkspaceDbAtRoot({
          dataRoot,
          workspaceId,
          workspaceRoot: stagingRoot,
        });
        applyScopedMigrations(initialWorkspaceDb, undefined, 'pre-knowledge');
        initialSchemaText =
          initialNotebookSchemaText ??
          createDefaultScopeKnowledgeSchemaText(new Date().toISOString());
      };
      try {
        if (fileWriteAdmission) withCanonicalFileWriteAdmission(fileWriteAdmission, prepareFiles);
        else prepareFiles();
        await initializeWorkspaceNotebook({
          workspaceRoot: stagingRoot,
          workspaceId,
          workspaceDb: initialWorkspaceDb!,
          initialization: notebookInitialization,
          files: initialNotebookFiles ?? {},
          ...(fileWriteAdmission ? { fileWriteAdmission } : {}),
          ...(initialNotebookSources === undefined
            ? {}
            : { sourcePointers: initialNotebookSources }),
          revalidate: () => ({
            pageScopeId: `page/workspace/${workspaceId}/${knowledgeBaseId}`,
            scopeSchemaText: initialSchemaText!,
            reviewRequiredPageIds: [],
            registeredSources: new Map(
              records.knowledgeSources.map((source) => [source.id, source.contentDigest])
            ),
            resolvedReferences: importedWorkspaceNotebookReferences(
              initialNotebookFiles ?? {},
              `page/workspace/${workspaceId}/${knowledgeBaseId}`
            ),
          }),
        });
      } finally {
        initialWorkspaceDb?.sqlite.close();
      }
      const stage = () => stageWorkspace?.({ workspaceId, workspaceRoot: stagingRoot });
      if (fileWriteAdmission) withCanonicalFileWriteAdmission(fileWriteAdmission, stage);
      else stage();
      const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId }, stagingRoot);
      const entries: Array<{
        input: ControlProductEntry;
        id: string;
        identity: string;
        readMetadata: string;
      }> = [];
      for (const turn of records.turns) {
        const revisions = new Map<string, number>();
        const items = records.itemRevisions.filter((item) => item.turnId === turn.id);
        for (const [index, item] of items.entries()) {
          const revision = revisions.get(item.id) ?? 0;
          const content = await publishImmutableProductJson(
            scope.contentMount,
            scope.owner,
            join(stagingRoot, 'runtime', 'staging'),
            writeRetainedV1(item)
          );
          entries.push({
            input: {
              kind: 'item',
              turnId: turn.id,
              sequence: index + 1,
              expectedRevision: revision,
              content,
            },
            id: item.id,
            readMetadata: prepareControlReadMetadata('item', writeRetainedV1(item)),
            identity: JSON.stringify({
              id: item.id,
              type: item.type,
              owner: item.owner,
              threadId: item.threadId,
              turnId: item.turnId,
              actor: 'actor' in item ? item.actor : null,
              responsibleUserId: 'responsibleUserId' in item ? item.responsibleUserId : null,
              causationId: item.causationId ?? null,
            }),
          });
          revisions.set(item.id, revision + 1);
        }
        for (const event of records.streamEvents.find(([id]) => id === turn.id)?.[1] ?? []) {
          const content = await publishImmutableProductJson(
            scope.contentMount,
            scope.owner,
            join(stagingRoot, 'runtime', 'staging'),
            writeRetainedV1(event)
          );
          entries.push({
            input: {
              kind: 'event',
              turnId: turn.id,
              sequence: event.sequence,
              expectedRevision: 0,
              content,
            },
            id: `${turn.id}:${event.sequence}`,
            readMetadata: prepareControlReadMetadata('event', writeRetainedV1(event)),
            identity: JSON.stringify({ threadId: turn.threadId, turnId: turn.id }),
          });
        }
        if (turn.fileInputs?.length) {
          // The import callback owns already verified copied originals; it must finish before native publication.
          verifyTurnFileInputs(stagingRoot, turn);
        }
      }
      const productDb = openWorkspaceDbAtRoot({
        dataRoot,
        workspaceId,
        workspaceRoot: stagingRoot,
      });
      try {
        if (existsSync(finalRoot)) throw new Error('Workspace bootstrap is not private.');
        assertCanonicalDirectory(stagingParent);
        assertCanonicalDirectory(stagingRoot);
        productDb.sqlite.transaction(() => {
          for (const table of [
            'control_workspaces',
            'control_threads',
            'control_agent_sessions',
            'control_turns',
            'control_product_entries',
          ]) {
            if (productDb.sqlite.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
              throw new Error('Workspace bootstrap requires an empty native product scope.');
          }
          parseCanonicalWorkspaceHistory({ ...records, turnEvents: records.streamEvents });
          const workspaceRecord = writeRetainedV1(projectWorkspaceSystemRecord(records.workspace));
          decodeControlProduct('workspace', workspaceRecord, scope.owner);
          productDb.sqlite
            .prepare(
              'INSERT INTO control_workspaces (id,schema_version,revision,record_json) VALUES (?,1,1,?)'
            )
            .run(workspaceId, JSON.stringify(workspaceRecord));
          for (const thread of records.threads) {
            const record = writeRetainedV1({
              ...thread,
              requiredFeatures: [...THREAD_REQUIRED_FEATURES],
            });
            decodeControlProduct('thread', record, scope.owner);
            productDb.sqlite
              .prepare(
                'INSERT INTO control_threads (id,schema_version,revision,workspace_id,status,record_json) VALUES (?,1,1,?,?,?)'
              )
              .run(thread.id, workspaceId, thread.status, JSON.stringify(record));
          }
          for (const session of records.agentSessions) {
            const record = writeRetainedV1(session);
            decodeControlProduct('agent-session', record, scope.owner);
            productDb.sqlite
              .prepare(
                'INSERT INTO control_agent_sessions (id,schema_version,revision,workspace_id,thread_id,status,record_json) VALUES (?,1,1,?,?,?,?)'
              )
              .run(
                session.id,
                workspaceId,
                session.threadId,
                session.status,
                JSON.stringify(record)
              );
          }
          for (const turn of records.turns) {
            const coverage = records.turnCaptureCoverage?.get(turn.id);
            const record = writeRetainedV1({
              ...turn,
              items: [],
              ...(coverage ? { captureCoverage: coverage } : {}),
            });
            decodeControlProduct('turn', record, scope.owner);
            productDb.sqlite
              .prepare(
                'INSERT INTO control_turns (id,schema_version,revision,thread_id,agent_session_id,status,record_json) VALUES (?,1,1,?,?,?,?)'
              )
              .run(
                turn.id,
                turn.threadId,
                turn.agentSessionId ?? null,
                turn.status,
                JSON.stringify(record)
              );
          }
          for (const entry of entries) {
            const input = entry.input;
            productDb.sqlite
              .prepare(
                'INSERT INTO control_product_entries (kind,turn_id,sequence,id,revision,schema_version,content_json,identity_json,read_metadata_json) VALUES (?,?,?,?,?,1,?,?,?)'
              )
              .run(
                input.kind,
                input.turnId,
                input.sequence,
                entry.id,
                input.expectedRevision + 1,
                JSON.stringify(input.content),
                entry.identity,
                entry.readMetadata
              );
          }
        })();
      } finally {
        productDb.sqlite.close();
      }
      // Inspect the actual committed private rows and immutable bytes before publication, not only producer DTOs.
      const nativeTurns = records.turns.map((turn) => readNativeTurnHistory(scope, turn.id)!);
      parseCanonicalWorkspaceHistory({
        ...records,
        turns: nativeTurns.map((history) => history.turn),
        itemRevisions: nativeTurns.flatMap((history) => history.itemRevisions),
        turnEvents: nativeTurns.map((history) => [
          history.turn.id,
          readNativeTurnEvents(scope, history.turn),
        ]),
      });
      // The stopped importer joins verified native dependent rows before the private root becomes visible.
      finalizeNativeWorkspace?.({ workspaceId, workspaceRoot: stagingRoot });
      const publishFiles = () => {
        writeWorkspaceFileRecords(stagingRoot, records);
        publishCanonicalPath(stagingRoot, finalRoot);
      };
      if (fileWriteAdmission) withCanonicalFileWriteAdmission(fileWriteAdmission, publishFiles);
      else publishFiles();
      // Publication makes this exact, verified final scope eligible for native family admission.
      const native = this.nativeScope({ kind: 'workspace', workspaceId });
      await getControlStoreWorkerClient().open({
        database: `workspace:${native.path}`,
        path: native.path,
        dataRoot,
        create: false,
        initialize: 'workspace',
        productOwner: native.owner,
        contentMount: native.contentMount,
      });
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }

  /** Writes only the independently file-owned Workspace configuration and Artifact families. */
  private writeWorkspaceFileRecordsToRoot(
    workspaceId: string,
    workspaceRoot: string,
    updateWorkspaceConfigName = false,
    initialArtifact?: { readonly record: ArtifactVersionRecord; readonly payloadPath?: string }
  ): void {
    writeWorkspaceFileRecords(
      workspaceRoot,
      {
        workspace: this.getWorkspace(workspaceId),
        // Pending SQL acknowledgement must hide a head from readers, never from its file writer.
        artifacts: [...this.artifacts.values()].filter(
          (artifact) => artifact.workspaceId === workspaceId
        ),
      },
      updateWorkspaceConfigName,
      initialArtifact
    );
  }

  /**
   * Returns one owner-independent Workspace root path under the configured data-root layout.
   *
   * @param workspaceId Workspace whose root path should be returned.
   * @returns Workspace root path.
   */
  private workspaceRootPath(workspaceId: string): string {
    this.assertWorkspacePublicationAcknowledged(workspaceId);
    if (!this.dataRoot) {
      throw new Error('FsStore data root is not configured.');
    }

    assertSafeWorkspacePathSegment(workspaceId, 'Workspace id');
    return resolveDataRootPath(this.dataRoot, 'workspaces', workspaceId);
  }

  /**
   * Returns the retained page scope used by Workspace citation admission.
   *
   * @param workspaceId Workspace whose default Knowledge Base owns the pages.
   * @returns Exact retained scope, or undefined for a store without a data root.
   */
  private workspaceKnowledgePageScopeId(workspaceId: string): string | undefined {
    if (!this.dataRoot) return undefined;
    const knowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot: this.dataRoot,
      scope: { kind: 'workspace', workspaceId },
    });
    return `page/workspace/${workspaceId}/${knowledgeBaseId}`;
  }

  /**
   * Validates one immutable proposal tuple and its exact current evidence.
   *
   * @param proposal Proposal owner to verify.
   * @param verifiedExternalReferences Exact Core/S39 references verified by their owners.
   * @throws KnowledgePageValidationError when any candidate or source authority is invalid.
   */
  private assertValidKnowledgeProposal(
    proposal: KnowledgeProposalRecord,
    verifiedExternalReferences: readonly string[],
    prepared?: PreparedKnowledgeProposalFacts
  ): void {
    let scopeSchemaText: string | undefined;
    let pageScopeId: string | undefined;
    try {
      KnowledgeProposalRecordSchema.parse(proposal);
      pageScopeId = this.workspaceKnowledgePageScopeId(proposal.workspaceId);
      if (this.dataRoot) {
        scopeSchemaText = this.workspaceKnowledgeSelection(
          proposal.workspaceId,
          prepared?.selection
        ).scopeSchemaText;
      }
    } catch {
      throw new KnowledgePageValidationError();
    }

    if (proposal.changes) {
      if (
        proposal.knowledgePageId !== undefined ||
        proposal.canonicalPageBytes !== undefined ||
        proposal.confidence !== undefined ||
        proposal.contentDigest !== contentDigest(JSON.stringify(proposal.changes)) ||
        new Set(proposal.changes.map((change) => change.path)).size !== proposal.changes.length
      )
        throw new KnowledgePageValidationError();
      const notebook = prepared?.selection.notebook ?? this.proposalNotebook(proposal.workspaceId);
      const base = { files: notebook.readContent(proposal.baseRevision) };
      const files = { ...base.files };
      for (const { path, content } of proposal.changes) {
        if (content === null) delete files[path];
        else files[path] = content;
      }
      validateNotebookFiles(
        Object.fromEntries(
          proposal.changes
            .filter((change) => change.content !== null)
            .map((change) => [change.path, change.content!])
        ),
        true
      );
      const resolved = this.resolveKnowledgePageSourceReferences(
        proposal.workspaceId,
        proposal.sourceReferences,
        verifiedExternalReferences,
        proposal.baseRevision,
        prepared?.selection
      );
      const facts = {
        ownerScope: proposal.ownerScope,
        ...(pageScopeId === undefined ? {} : { pageScopeId }),
        base,
        candidate: { files },
        scopeSchemaText: scopeSchemaText ?? DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
        registeredSources: new Map(
          this.knowledgeProposalSources(proposal.workspaceId, prepared?.selection).map((source) => [
            source.id,
            source.contentDigest,
          ])
        ),
        resolvedReferences: new Map(
          proposal.changes.map(({ path }) => [path.slice(0, -3), resolved])
        ),
      };
      const result = prepared?.validate
        ? prepared.validate(facts)
        : validateNotebookCandidate(facts);
      if (
        result.errors.length ||
        !isDeepStrictEqual(
          result.changedPaths,
          proposal.changes.map(({ path }) => path)
        ) ||
        !isDeepStrictEqual(result.sourceReferences, proposal.sourceReferences)
      )
        throw new KnowledgePageValidationError();
      return;
    }
    if (
      proposal.knowledgePageId === undefined ||
      proposal.canonicalPageBytes === undefined ||
      proposal.confidence === undefined
    )
      throw new KnowledgePageValidationError();

    const candidatePath = `knowledge/pages/${proposal.knowledgePageId}.md`;
    const parsed = parseOkfDocument({ path: candidatePath, content: proposal.canonicalPageBytes });
    const sourceReferences = parsed.document
      ? stringListFrontmatterField(parsed.document, 'source_refs')
      : null;
    if (
      proposal.contentDigest !== contentDigest(proposal.canonicalPageBytes) ||
      !parsed.ok ||
      parsed.document.conceptId !== proposal.knowledgePageId ||
      (parsed.document.frontmatter.openkit_entry_id !== undefined &&
        parsed.document.frontmatter.openkit_entry_id !== proposal.knowledgePageId) ||
      parsed.document.frontmatter.type !== 'KnowledgePage' ||
      parsed.document.frontmatter.openkit_status !== 'active' ||
      (parsed.document.frontmatter.status !== undefined &&
        parsed.document.frontmatter.status !== 'stable') ||
      parsed.document.frontmatter.review_state !== 'accepted' ||
      JSON.stringify(sourceReferences) !== JSON.stringify(proposal.sourceReferences)
    ) {
      throw new KnowledgePageValidationError();
    }

    const knowledgeIds =
      prepared?.knowledgeIds ??
      new Set(this.getWorkspaceResources(proposal.workspaceId).knowledge.map((entry) => entry.id));
    const resolvedReferences = this.resolveKnowledgePageSourceReferences(
      proposal.workspaceId,
      proposal.sourceReferences,
      verifiedExternalReferences,
      proposal.baseRevision,
      prepared?.selection
    );

    const report = validateKnowledgePageCandidate({
      path: candidatePath,
      content: proposal.canonicalPageBytes,
      ...(pageScopeId === undefined ? {} : { pageScopeId }),
      expectedOwnerScope: { kind: 'workspace', workspaceId: proposal.workspaceId },
      ...(scopeSchemaText === undefined ? {} : { scopeSchemaText }),
      registeredSources: new Map(
        this.knowledgeProposalSources(proposal.workspaceId, prepared?.selection).map((source) => [
          source.id,
          source.contentDigest,
        ])
      ),
      knowledgeIds,
      resolvedReferences,
    });
    if (report.conformance !== 'scope-schema-valid' || report.errors.length > 0) {
      throw new KnowledgePageValidationError();
    }
  }

  /**
   * Resolves one closed Knowledge Page source-reference set against current owners.
   *
   * @param workspaceId Workspace that must own every local reference.
   * @param sourceReferences Complete source references carried by the page.
   * @param verifiedExternalReferences Exact work-history references verified outside the store.
   * @param notebookRevision Immutable Proposal base, or the current published revision for direct edits.
   * @returns Complete reference set after every current owner is verified.
   * @throws KnowledgePageValidationError when any reference is missing or contradictory.
   */
  private resolveKnowledgePageSourceReferences(
    workspaceId: string,
    sourceReferences: readonly string[],
    verifiedExternalReferences: readonly string[],
    notebookRevision?: string,
    preparedSelection?: WorkspaceNotebookSelection
  ): ReadonlySet<string> {
    const externalReferences = new Set(verifiedExternalReferences);
    if (
      externalReferences.size !== verifiedExternalReferences.length ||
      verifiedExternalReferences.some(
        (reference) =>
          !/^(?:turn|item|context-package):/.test(reference) ||
          !sourceReferences.includes(reference)
      )
    ) {
      throw new KnowledgePageValidationError();
    }

    const resolvedReferences = new Set(externalReferences);
    for (const reference of sourceReferences) {
      const qualifiedSource = /^source:(.+)@(sha256:[a-f0-9]{64})$/.exec(reference);
      const pagePin = parseReferenceUri(reference);
      const pageScope = pagePin && parseReferenceScope(pagePin.reference.scopeId);
      if (!qualifiedSource && !pagePin) {
        if (!externalReferences.has(reference)) throw new KnowledgePageValidationError();
        continue;
      }
      let ownerId: string;
      let expectedDigest: string;
      if (qualifiedSource) {
        ownerId = qualifiedSource[1]!;
        expectedDigest = qualifiedSource[2]!;
      } else {
        if (
          !pagePin?.contentDigest ||
          pageScope?.family !== 'page' ||
          pageScope.kind !== 'workspace' ||
          pageScope.workspaceId !== workspaceId ||
          !this.dataRoot
        )
          throw new KnowledgePageValidationError();
        try {
          if (pagePin.reference.scopeId !== this.workspaceKnowledgePageScopeId(workspaceId))
            throw new KnowledgePageValidationError();
        } catch {
          throw new KnowledgePageValidationError();
        }
        ownerId = pagePin.reference.objectId;
        expectedDigest = pagePin.contentDigest;
      }
      if (qualifiedSource) {
        try {
          const source = preparedSelection
            ? this.knowledgeProposalSources(workspaceId, preparedSelection).find(
                ({ id }) => id === ownerId
              )
            : this.getKnowledgeSource(workspaceId, ownerId!);
          if (source?.contentDigest !== expectedDigest) throw new KnowledgePageValidationError();
        } catch {
          throw new KnowledgePageValidationError();
        }
        // Synchronous closure validates the canonical pointer. Original bytes are verified
        // only by the asynchronous Storage delivery owner, never by another Store reader.
        resolvedReferences.add(reference);
        continue;
      }

      let pageBytes: string | null;
      try {
        const selected = this.workspaceKnowledgeSelection(workspaceId, preparedSelection);
        pageBytes = readWorkspaceKnowledgePage(
          selected,
          ownerId,
          // Exact equality with the current SQL head proves this ancestry check by identity.
          preparedSelection && notebookRevision === selected.head.notebookCommit
            ? undefined
            : notebookRevision
        );
      } catch {
        throw new KnowledgePageValidationError();
      }
      if (!pageBytes || contentDigest(pageBytes) !== expectedDigest) {
        throw new KnowledgePageValidationError();
      }
      const parsed = parseOkfDocument({
        path: `knowledge/pages/${ownerId}.md`,
        content: pageBytes,
      });
      if (
        !parsed.ok ||
        parsed.document.conceptId !== ownerId ||
        (parsed.document.frontmatter.openkit_entry_id !== undefined &&
          parsed.document.frontmatter.openkit_entry_id !== ownerId) ||
        parsed.document.frontmatter.type !== 'KnowledgePage' ||
        parsed.document.frontmatter.openkit_status !== 'active' ||
        (parsed.document.frontmatter.status !== undefined &&
          parsed.document.frontmatter.status !== 'stable') ||
        parsed.document.frontmatter.review_state !== 'user-authored' ||
        !isDeepStrictEqual(parsed.document.frontmatter.scope, { kind: 'workspace', workspaceId })
      ) {
        throw new KnowledgePageValidationError();
      }
      resolvedReferences.add(reference);
    }

    return resolvedReferences;
  }

  /** Reads current canonical Source facts without reopening synchronous immutable Git readers. */
  private knowledgeProposalSources(
    workspaceId: string,
    preparedSelection?: WorkspaceNotebookSelection
  ): KnowledgeSourceRecord[] {
    if (!preparedSelection) return this.listKnowledgeSources(workspaceId);
    this.getWorkspace(workspaceId);
    const selection = this.workspaceKnowledgeSelection(workspaceId, preparedSelection);
    return [
      ...readSourcePointers(
        { dataRoot: this.dataRoot!, ownerScope: { kind: 'workspace', workspaceId } },
        undefined,
        selection
      ).values(),
    ].map(({ source }) => ({ ...source, workspaceId }));
  }

  /**
   * Rejects publication while one latest unresolved conflict names the proposal target or source.
   *
   * @param proposal Immutable proposal whose publication boundary is being checked.
   * @throws Knowledge Proposal conflict failure before any Review or Page mutation.
   */
  private assertNoUnresolvedKnowledgeProposalConflict(proposal: KnowledgeProposalRecord): void {
    const scopeId = this.workspaceKnowledgePageScopeId(proposal.workspaceId);
    if (scopeId === undefined) throw new KnowledgePageValidationError();
    const targetIds = proposal.changes
      ? proposal.changes.map(({ path }) => path.slice(0, -3))
      : [proposal.knowledgePageId!];
    const relevantReferences = new Set<string>([
      ...targetIds.map((objectId) => formatReferenceUri({ scopeId, objectId })),
      ...proposal.sourceReferences,
    ]);
    for (const reference of proposal.sourceReferences) {
      const qualifiedSource = /^source:(.+)@sha256:[a-f0-9]{64}$/.exec(reference);
      if (qualifiedSource) relevantReferences.add(`source:${qualifiedSource[1]}`);
      const pagePin = parseReferenceUri(reference);
      if (pagePin) relevantReferences.add(formatReferenceUri(pagePin.reference));
    }

    const notebook = this.proposalNotebook(proposal.workspaceId);
    const subjects = unresolvedNotebookSubjects(
      notebook.readRevision(notebook.publishedRevision()).files,
      scopeId
    );
    if ([...relevantReferences].some((reference) => subjects.has(reference))) {
      throw knowledgeProposalAuthorityError('conflict');
    }
  }

  /**
   * Re-reads one proposal file and verifies its exact immutable bytes.
   *
   * @param proposal Proposal owner held in memory.
   * @returns Exact verified proposal-file bytes.
   * @throws Error with recovery_required when durable authority is missing or changed.
   */
  private verifiedKnowledgeProposalBytes(
    proposal: KnowledgeProposalRecord,
    prepared?: PreparedKnowledgeProposalProjection
  ): string {
    const expected = serializeKnowledgeProposalRecord(proposal);
    if (!this.dataRoot) {
      return expected;
    }

    try {
      const root = this.workspaceRootPath(proposal.workspaceId);
      const scope = this.nativeScope({ kind: 'workspace', workspaceId: proposal.workspaceId });
      const sqlite =
        scope.sqlite ??
        getWorkspaceProductReadHandle(scope.path, {
          kind: 'workspace',
          workspaceId: proposal.workspaceId,
        }).sqlite;
      const selected = readControlKnowledgeProposal(
        { scope: 'workspace', workspaceId: proposal.workspaceId, sqlite },
        proposal.id
      );
      if (!selected) throw knowledgeProposalAuthorityError('recovery_required');
      const actual = new TextDecoder('utf-8', { fatal: true }).decode(
        readImmutableContentBytes(
          {
            root: join(root, 'knowledge', 'content'),
            knowledgeBaseId: selected.proposal.knowledgeBaseId,
            mount: selected.proposal.documentContent.reference.locator.mount,
          },
          scope.owner,
          selected.proposal.documentContent,
          selected.proposal.documentContent.byteLength
        )
      );
      if (actual !== expected) {
        throw knowledgeProposalAuthorityError('recovery_required');
      }
      const notebook = prepared?.notebook ?? this.proposalNotebook(proposal.workspaceId);
      const candidate = prepared?.candidate ?? notebook.retainedCandidate(proposal.id);
      const content = proposal.canonicalPageBytes;
      const baseFiles = notebook.readContent(proposal.baseRevision);
      const candidateContent = notebook.readContent(proposal.candidateRevision);
      const changes = [...new Set([...Object.keys(baseFiles), ...Object.keys(candidateContent)])]
        .sort()
        .filter((path) => baseFiles[path] !== candidateContent[path])
        .map((path) => ({ path, content: candidateContent[path] ?? null }));
      if (
        candidate.revision !== proposal.candidateRevision ||
        candidate.parentRevision !== proposal.baseRevision ||
        (proposal.changes
          ? !isDeepStrictEqual(changes, proposal.changes) ||
            contentDigest(JSON.stringify(changes)) !== proposal.contentDigest
          : content !== candidateContent[`${proposal.knowledgePageId}.md`] ||
            content === undefined ||
            contentDigest(content) !== proposal.contentDigest) ||
        candidate.metadata.authority.kind !== 'proposal' ||
        candidate.metadata.authority.proposalId !== proposal.id ||
        !isDeepStrictEqual(candidate.metadata.producer, proposal.producer) ||
        candidate.metadata.summary !== proposal.rationale ||
        !isDeepStrictEqual(candidate.metadata.sourceReferences, proposal.sourceReferences) ||
        knowledgeProposalId(proposal.ownerScope, candidate.metadata.changeRequest.requestId) !==
          proposal.id
      )
        throw knowledgeProposalAuthorityError('recovery_required');
      return actual;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'recovery_required'
      ) {
        throw error;
      }
      throw knowledgeProposalAuthorityError('recovery_required');
    }
  }

  /**
   * Re-reads one retained Review file and verifies its ordered decision core and Proposal digest.
   *
   * @param proposal Immutable Proposal that owns the Review history.
   * @param reviewId Exact Review row to return.
   * @param proposalBytes Already verified immutable Proposal-file bytes.
   * @returns Exact verified Review row.
   * @throws Error with recovery_required when durable Review authority is missing or changed.
   */
  private verifiedKnowledgeProposalReview(
    proposal: KnowledgeProposalRecord,
    reviewId: string,
    proposalBytes: string
  ): KnowledgeProposalReviewRecord {
    const decisions = this.knowledgeProposalReviews.get(proposal.id) ?? [];
    const review = decisions.find((candidate) => candidate.reviewId === reviewId);
    if (
      !review ||
      review.workspaceId !== proposal.workspaceId ||
      review.proposalDigest !== contentDigest(proposalBytes) ||
      review.knowledgePageId !== proposal.knowledgePageId ||
      review.contentDigest !== proposal.contentDigest ||
      !isDeepStrictEqual(
        review.changedPageIds,
        proposal.changes?.map(({ path }) => path.slice(0, -3))
      ) ||
      review.baseRevision !== proposal.baseRevision ||
      review.candidateRevision !== proposal.candidateRevision ||
      !isDeepStrictEqual(review.ownerScope, proposal.ownerScope)
    ) {
      throw knowledgeProposalAuthorityError('recovery_required');
    }
    if (!this.dataRoot) {
      return review;
    }

    try {
      const scope = this.nativeScope({ kind: 'workspace', workspaceId: proposal.workspaceId });
      const sqlite =
        scope.sqlite ??
        getWorkspaceProductReadHandle(scope.path, {
          kind: 'workspace',
          workspaceId: proposal.workspaceId,
        }).sqlite;
      const selected = readControlKnowledgeProposal(
        { scope: 'workspace', workspaceId: proposal.workspaceId, sqlite },
        proposal.id
      );
      if (!selected) throw knowledgeProposalAuthorityError('recovery_required');
      const retained = {
        proposalId: proposal.id,
        ownerScope: proposal.ownerScope,
        decisions: selected.reviews,
      };
      if (
        !isDeepStrictEqual(retained, {
          proposalId: proposal.id,
          ownerScope: proposal.ownerScope,
          decisions,
        })
      ) {
        throw knowledgeProposalAuthorityError('recovery_required');
      }
      const audits = sqlite
        .prepare(
          `SELECT actor_json FROM audit_events WHERE workspace_id = ? AND request_id = ?
         AND category = 'knowledge' AND action = 'knowledge.proposal.decide' AND outcome = 'succeeded'`
        )
        .all(proposal.workspaceId, review.requestId) as { actor_json: string | null }[];
      if (
        audits.length !== 1 ||
        audits[0]!.actor_json === null ||
        !isDeepStrictEqual(
          ActorRefReaderSchema.parse(JSON.parse(audits[0]!.actor_json!)),
          review.actor
        )
      )
        throw knowledgeProposalAuthorityError('recovery_required');
      return review;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'recovery_required'
      ) {
        throw error;
      }
      throw knowledgeProposalAuthorityError('recovery_required');
    }
  }

  private refreshWorkspaceCounts(workspaceId: string): void {
    // Native reads join current counts directly; rebuilding the unused fixture cache repeats file I/O.
    if (this.dataRoot) return;
    const workspace = this.getWorkspace(workspaceId);
    const resources = this.getWorkspaceResources(workspaceId);
    this.workspaces.set(workspaceId, {
      ...workspace,
      counts: {
        threadCount: this.listThreads(workspaceId).length,
        artifactCount: this.listArtifacts(workspaceId).length,
        knowledgeEntryCount: resources.knowledge.length,
      },
      updatedAt: now(),
    });
  }

  public listWorkspaces(): WorkspaceRecord[] {
    const steps = this.listWorkspacesSteps();
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  /** Shares the original owner read in released page/proof contributions for one admitted call. */
  public *listWorkspacesSteps(): Generator<void, WorkspaceRecord[], void> {
    const ids = this.dataRoot
      ? listDirectoryNames(join(this.dataRoot, 'workspaces')).filter((id) => id !== '.staging')
      : [...this.workspaces.keys()];
    const admittedIds: string[] = [];
    for (const id of ids) {
      if (
        !this.dataRoot ||
        isScopeAdmitted(this.dataRoot, 'workspace', id, this.suppliedScopeRefusals)
      )
        admittedIds.push(id);
      yield;
    }
    const records: WorkspaceRecord[] = [];
    for (const id of admittedIds) {
      records.push(this.getWorkspace(id));
      yield;
    }
    return records;
  }

  /**
   * Ensures the built-in owner-only personal Workspace for one canonical user.
   *
   * @param userId Canonical user id whose Core binding selects the current Workspace.
   * @returns Existing or newly created personal Workspace.
   * @throws Error when the reserved id already belongs to another Workspace kind.
   */
  public async ensureQuickChatWorkspace(userId: string): Promise<WorkspaceRecord> {
    const workspaceId = quickChatWorkspaceIdForUser(userId, this.dataRoot);
    this.assertWorkspacePublicationAcknowledged(workspaceId);
    const existing = this.dataRoot
      ? existsSync(this.workspaceRootPath(workspaceId))
        ? this.getWorkspace(workspaceId)
        : undefined
      : this.workspaces.get(workspaceId);
    if (existing) {
      if (existing.kind !== 'personal') {
        throw new Error(`Reserved personal workspace id ${workspaceId} has another kind.`);
      }
      if (this.dataRoot) {
        // An overlapping publisher can expose the final directory before its original open ACK.
        const native = this.nativeScope({ kind: 'workspace', workspaceId });
        await getControlStoreWorkerClient().open({
          database: `workspace:${native.path}`,
          path: native.path,
          dataRoot: this.dataRoot,
          create: false,
          initialize: 'workspace',
          productOwner: native.owner,
          contentMount: native.contentMount,
        });
      }
      return existing;
    }

    const timestamp = now();
    const workspace: WorkspaceRecord = {
      id: workspaceId,
      name: 'Personal',
      kind: 'personal',
      status: 'active',
      counts: {
        threadCount: 0,
        artifactCount: 0,
        knowledgeEntryCount: 0,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.persistNewWorkspaceAtomically(
      emptyWorkspaceFileRecords(workspace),
      allocateEntityId('kb'),
      undefined,
      {
        requestId: uuidv5(`openkit:personal-workspace-initialize:${workspaceId}`),
        producer: { kind: 'user', id: userId },
        instructionReference: `personal-workspace-initialize:${workspaceId}`,
      }
    );
    this.workspaces.set(workspace.id, workspace);
    this.workspaceResources.set(workspace.id, createWorkspaceResources());
    return workspace;
  }

  /** Creates a fresh Workspace with native User attribution or the service-owned empty notebook seed. */
  public async createWorkspace(
    name: string,
    notebookInitialization?: NotebookInitialization
  ): Promise<WorkspaceRecord> {
    const timestamp = now();
    const workspace: WorkspaceRecord = {
      id: allocateEntityId('ws'),
      name,
      kind: 'general',
      status: 'active',
      counts: {
        threadCount: 0,
        artifactCount: 0,
        knowledgeEntryCount: 0,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const resources = createWorkspaceResources();
    await this.persistNewWorkspaceAtomically(
      emptyWorkspaceFileRecords(workspace),
      allocateEntityId('kb'),
      undefined,
      notebookInitialization ?? {
        requestId: randomUUID(),
        producer: { kind: 'system', id: 'notebook-initializer', responsibleUserId: null },
        instructionReference: 'workspace.create:empty-notebook-seed',
      }
    );
    this.workspaces.set(workspace.id, workspace);
    this.workspaceResources.set(workspace.id, resources);
    return workspace;
  }

  /**
   * Imports one verified workspace snapshot into the file-backed store.
   *
   * @param input Complete canonical workspace history to persist.
   * @returns Imported workspace record with recomputed counts.
   * @throws Error when target ids collide or records point at another workspace.
   */
  public async importWorkspaceSnapshot(input: {
    workspace: WorkspaceRecord;
    /** Already reminted target binding from the verified import; synthetic imports allocate a fresh base. */
    defaultKnowledgeBaseId?: string;
    threads: readonly Thread[];
    turns: readonly Turn[];
    knowledge: readonly KnowledgeNotebookPage[];
    itemRevisions: readonly Item[];
    artifacts: readonly Artifact[];
    agentSessions: readonly AgentSession[];
    turnEvents: readonly (readonly [string, readonly SseEventEnvelope[]])[];
    knowledgeSources?: readonly KnowledgeSourceRecord[];
    initialNotebookSources?: Readonly<Record<string, string>>;
    /** Actual importer/fixture creator; file-backed publication must not invent a responsible actor. */
    notebookInitialization?: NotebookInitialization;
    /** Exact admitted imported tree, including unknown OKF metadata and reserved navigation bytes. */
    initialNotebookFiles?: Readonly<Record<string, string>>;
    /** Exact imported scope schema used to validate and initialize the target Notebook. */
    initialNotebookSchemaText?: string;
    /** Immutable capture admission for imported Turns; absence remains unknown history. */
    turnCaptureCoverage?: ReadonlyMap<string, CaptureCoverageBinding>;
    stageWorkspace?: (stage: ImportWorkspaceStage) => void;
    /** Stopped private SQL dependency publication after native products exist and before the root rename. */
    finalizeNativeWorkspace?: (stage: ImportWorkspaceStage) => void;
    /** Request capacity applies only during synchronous file mutation, never native content awaits. */
    fileWriteAdmission?: FileStorageAdmission;
  }): Promise<WorkspaceRecord> {
    const history = parseCanonicalWorkspaceHistory({
      workspace: input.workspace,
      threads: input.threads,
      turns: input.turns,
      itemRevisions: input.itemRevisions,
      artifacts: input.artifacts,
      knowledgeSources: input.knowledgeSources,
      agentSessions: input.agentSessions,
      turnEvents: input.turnEvents,
    });
    if (
      this.dataRoot
        ? existsSync(this.workspaceRootPath(history.workspace.id))
        : this.workspaces.has(history.workspace.id)
    ) {
      throw new Error(`Workspace already exists: ${history.workspace.id}`);
    }

    for (const thread of history.threads) {
      if (this.dataRoot ? this.findNativeOwner('thread', thread.id) : this.threads.has(thread.id)) {
        throw new Error(`Thread already exists: ${thread.id}`);
      }
    }

    const importedTurnIds = new Set(history.turns.map((turn) => turn.id));
    const captureCoverage = new Map<string, CaptureCoverageBinding>();
    for (const [turnId, binding] of input.turnCaptureCoverage ?? []) {
      if (!importedTurnIds.has(turnId)) {
        throw new Error(`Capture coverage references missing imported Turn: ${turnId}`);
      }
      captureCoverage.set(turnId, CaptureCoverageBindingSchema.parse(binding));
    }

    const currentItems = history.turns.flatMap((turn) => turn.items);

    for (const turn of history.turns) {
      if (this.dataRoot ? this.findNativeOwner('turn', turn.id) : this.turns.has(turn.id)) {
        throw new Error(`Turn already exists: ${turn.id}`);
      }
    }
    for (const item of history.itemRevisions) {
      if (this.dataRoot ? this.findNativeOwner('item', item.id) : this.items.has(item.id)) {
        throw new Error(`Thread item already exists: ${item.id}`);
      }
    }
    for (const artifact of history.artifacts) {
      if (this.artifacts.has(artifact.id)) {
        throw new Error(`Artifact already exists: ${artifact.id}`);
      }
    }
    for (const session of history.agentSessions) {
      if (
        this.dataRoot
          ? this.findNativeOwner('agent-session', session.id)
          : this.agentSessions.has(session.id)
      ) {
        throw new Error(`AgentSession already exists: ${session.id}`);
      }
    }

    const workspace: WorkspaceRecord = {
      ...history.workspace,
      counts: {
        threadCount: history.threads.length,
        artifactCount: history.artifacts.length,
        knowledgeEntryCount: input.knowledge.length,
      },
    };

    const records: WorkspaceFileRecords = {
      workspace,
      knowledge: [...input.knowledge],
      threads: history.threads,
      turns: history.turns,
      turnCaptureCoverage: captureCoverage,
      itemRevisions: history.itemRevisions,
      artifacts: history.artifacts,
      knowledgeProposals: [],
      knowledgeProposalReviews: [],
      knowledgeSources: history.knowledgeSources,
      agentSessions: history.agentSessions,
      streamEvents: history.turnEvents,
    };

    const importedArtifactVersions = new Map<string, ArtifactVersionRecord[]>();
    await this.persistNewWorkspaceAtomically(
      records,
      input.defaultKnowledgeBaseId ?? allocateEntityId('kb'),
      (stage) => {
        input.stageWorkspace?.(stage);
        const turns = new Map(history.turns.map((turn) => [turn.id, turn]));
        for (const artifact of history.artifacts) {
          importedArtifactVersions.set(
            artifact.id,
            readArtifactVersionHistory(stage.workspaceRoot, artifact, turns, history.itemRevisions)
          );
        }
      },
      input.notebookInitialization,
      input.initialNotebookFiles,
      input.initialNotebookSchemaText,
      input.initialNotebookSources,
      input.fileWriteAdmission,
      input.finalizeNativeWorkspace
    );

    this.workspaces.set(workspace.id, workspace);
    this.workspaceResources.set(workspace.id, createWorkspaceResources([...input.knowledge]));
    for (const thread of history.threads) {
      this.threads.set(thread.id, thread);
    }
    for (const turn of history.turns) {
      this.turns.set(turn.id, turn);
      const binding = captureCoverage.get(turn.id);
      if (binding) this.turnCaptureCoverage.set(turn.id, binding);
    }
    for (const item of currentItems) {
      this.items.set(item.id, item);
    }
    this.itemRevisions.push(...history.itemRevisions);
    for (const artifact of history.artifacts) {
      this.artifacts.set(artifact.id, artifact);
      const versions = importedArtifactVersions.get(artifact.id);
      if (versions) this.artifactVersions.set(artifact.id, versions);
    }
    for (const session of history.agentSessions) {
      this.agentSessions.set(session.id, session);
    }
    for (const [turnId, events] of history.turnEvents) {
      this.streams.set(turnId, {
        sequence: events.at(-1)?.sequence ?? 0,
        events: events.slice(-TURN_STREAM_EVENT_WINDOW_SIZE),
        listeners: new Set(),
      });
    }
    if (this.dataRoot) {
      for (const approval of loadApprovalProjections(
        this.dataRoot,
        [...this.turns.values()],
        [...this.commandRequests.values()]
      )) {
        if (approval.workspaceId === workspace.id) this.approvals.set(approval.id, approval);
      }
    }

    return workspace;
  }

  /**
   * Removes a workspace that was published before a coordinated external import failed.
   *
   * @param workspaceId Imported workspace to compensate.
   */
  public rollbackImportedWorkspace(workspaceId: string): void {
    this.getWorkspace(workspaceId);

    if (this.dataRoot) {
      const root = this.workspaceRootPath(workspaceId);
      if (lstatSync(root, { throwIfNoEntry: false })) {
        assertCanonicalDirectory(root);
        closeWorkspaceProductReadHandles(root);
        rmSync(root, { recursive: true });
      }
    }

    this.evictWorkspace(workspaceId);
  }

  /** Revalidates and installs one restored target while its existing recovery freeze stays closed. */
  public reloadRecoveredWorkspace(workspaceId: string, freeze: WorkspaceFrozenAdmission): void {
    WorkspaceIdSchema.parse(workspaceId);
    const gate = this.workspaceMutationAdmission;
    if (!this.dataRoot || !gate?.ownsFreeze(workspaceId, freeze))
      throw new Error('Workspace recovery freeze is not current.');
    const root = join(this.dataRoot, 'workspaces', workspaceId);
    closeWorkspaceProductReadHandles(root);
    const records = loadWorkspace(root, workspaceId);
    const versions = FsStore.readWorkspaceHistory(
      records,
      root,
      new Set([
        ...this.serverThreads.keys(),
        ...this.serverTurns.keys(),
        ...this.serverItems.keys(),
      ])
    );
    const identities = workspaceFileRecordIdentities(records);
    const peers = listDirectoryNames(join(this.dataRoot, 'workspaces')).filter(
      (id) =>
        id !== '.staging' &&
        id !== workspaceId &&
        isScopeAdmitted(this.dataRoot!, 'workspace', id, this.suppliedScopeRefusals)
    );
    const peerIds = new Set(peers);
    const claims: Array<readonly [string, Iterable<string>]> = [[workspaceId, identities]];
    const nativeKinds = {
      thread: 'thread',
      turn: 'turn',
      item: 'item',
      session: 'agent-session',
    } as const;
    for (const identity of identities) {
      const separator = identity.indexOf(':');
      const kind = identity.slice(0, separator) as keyof typeof nativeKinds;
      const nativeKind = nativeKinds[kind];
      if (!nativeKind) continue;
      const found = this.findNativeOwner(nativeKind, identity.slice(separator + 1), workspaceId);
      if (found?.owner.kind === 'server') throw new Error('Conflicting Server product owner.');
      if (found?.owner.kind === 'workspace') claims.push([found.owner.workspaceId, [identity]]);
    }
    // These maps are the live file publishers' operands, including an unresolved publication claim.
    for (const artifact of this.artifacts.values())
      if (peerIds.has(artifact.workspaceId))
        claims.push([artifact.workspaceId, [`artifact:${artifact.id}`]]);
    for (const proposal of this.knowledgeProposals.values())
      if (peerIds.has(proposal.workspaceId))
        claims.push([proposal.workspaceId, [`proposal:${proposal.id}`]]);
    for (const peer of peers)
      claims.push([peer, this.listKnowledgeSources(peer).map(({ id }) => `source:${id}`)]);
    if (
      peers.some(
        (id) => !isScopeAdmitted(this.dataRoot!, 'workspace', id, this.suppliedScopeRefusals)
      )
    )
      throw new Error('Workspace recovery peer authority is unavailable.');
    if (refuseWorkspaceIdentityConflicts(this.dataRoot, claims))
      throw new Error('Conflicting Workspace product owner.');
    const db = openWorkspaceReadDb(this.dataRoot, workspaceId);
    let approvals: ApprovalRequest[];
    try {
      approvals = loadApprovalProjectionsFromSqlite(
        db.sqlite,
        records.turns,
        readCommandRequestRecordsFromSqlite(db.sqlite)
      );
    } finally {
      db.sqlite.close();
    }
    if (!gate.ownsFreeze(workspaceId, freeze))
      throw new Error('Workspace recovery freeze is not current.');
    this.evictWorkspaceProjection(workspaceId, root);
    this.installWorkspaceProjection(records, versions);
    for (const approval of approvals) this.approvals.set(approval.id, approval);
  }

  /** Settles this target's reopen-only marker after the recovery owner validates placement and all projections. */
  public settleRecoveredWorkspacePublication(
    workspaceId: string,
    freeze: WorkspaceFrozenAdmission
  ): void {
    if (
      !this.workspaceMutationAdmission?.ownsFreeze(workspaceId, freeze) ||
      !this.workspaces.has(workspaceId)
    )
      throw new Error('Workspace recovery freeze is not current.');
    this.unacknowledgedWorkspaces.delete(workspaceId);
  }

  /** Removes one Workspace from process-local read models without touching its filesystem root. */
  public evictWorkspace(workspaceId: string): void {
    this.assertWorkspacePublicationAcknowledged(workspaceId);
    this.evictWorkspaceProjection(
      workspaceId,
      this.dataRoot ? this.workspaceRootPath(workspaceId) : undefined
    );
  }

  /** Drops only the target's disposable projections after its caller has validated ownership. */
  private evictWorkspaceProjection(workspaceId: string, root?: string): void {
    if (root) closeWorkspaceProductReadHandles(root);
    const turnIds = new Set(
      [...this.turns.values()]
        .filter((turn) => workspaceIdForOwner(turn.owner) === workspaceId)
        .map((turn) => turn.id)
    );

    this.workspaces.delete(workspaceId);
    this.workspaceResources.delete(workspaceId);
    for (const [threadId, thread] of this.threads) {
      if (workspaceIdForOwner(thread.owner) === workspaceId) {
        this.threads.delete(threadId);
      }
    }
    for (const turnId of turnIds) {
      this.turns.delete(turnId);
      this.turnCaptureCoverage.delete(turnId);
      this.turnExecutors.delete(turnId);
      this.streams.delete(turnId);
    }
    for (const [itemId, item] of this.items) {
      if (workspaceIdForOwner(item.owner) === workspaceId) {
        this.items.delete(itemId);
      }
    }
    this.itemRevisions = this.itemRevisions.filter(
      (item) => workspaceIdForOwner(item.owner) !== workspaceId
    );
    for (const [artifactId, artifact] of this.artifacts) {
      if (artifact.workspaceId === workspaceId) {
        this.artifacts.delete(artifactId);
        this.pendingArtifactSubmissions.delete(artifactId);
        this.artifactVersions.delete(artifactId);
      }
    }
    for (const [sessionId, session] of this.agentSessions) {
      if (session.workspaceId === workspaceId) {
        this.agentSessions.delete(sessionId);
      }
    }
    for (const [proposalId, proposal] of this.knowledgeProposals) {
      if (proposal.workspaceId === workspaceId) {
        this.knowledgeProposals.delete(proposalId);
        this.knowledgeProposalReviews.delete(proposalId);
      }
    }

    for (const [approvalId, approval] of this.approvals) {
      if (approval.workspaceId === workspaceId) {
        this.approvals.delete(approvalId);
      }
    }
  }

  /** Joins committed native system metadata with the existing configuration and derived read projections. */
  public getWorkspace(workspaceId: string): WorkspaceRecord {
    this.assertWorkspacePublicationAcknowledged(workspaceId);
    if (this.dataRoot) {
      const root = this.workspaceRootPath(workspaceId);
      if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) {
        // An unpublished target has no Workspace authority; known identity still requires recovery.
        const core = openControlStoreProductReadHandle(
          join(this.dataRoot, 'server', 'db', 'core.sqlite'),
          { kind: 'server' }
        );
        try {
          if (
            this.workspaces.has(workspaceId) ||
            getWorkspaceRegistryLifecycleFact(
              bindCoreSqlite(core.sqlite, this.dataRoot),
              workspaceId
            )
          ) {
            refuseScope(this.dataRoot, { scope: 'workspace', id: workspaceId, check: 'database' });
            this.assertWorkspacePublicationAcknowledged(workspaceId);
          }
        } finally {
          core.close();
        }
        throw new StoreRecordNotFoundError(`Workspace not found: ${workspaceId}`);
      }
      const scope = this.nativeScope({ kind: 'workspace', workspaceId });
      const native = readNativeProduct(
        scope,
        'workspace',
        workspaceId,
        scope.sqlite
          ? undefined
          : getWorkspaceProductReadHandle(scope.path, { kind: 'workspace', workspaceId })
      );
      if (!native) throw new StoreRecordNotFoundError(`Workspace not found: ${workspaceId}`);
      const system = WorkspaceSystemRecordSchema.parse(native.record);
      const config = WorkspaceConfigSchema.parse(
        parseJsonc(
          readCanonicalTextFile(
            join(this.workspaceRootPath(workspaceId), 'config', 'workspace.jsonc')
          )
        )
      );
      // Counts are a disposable projection. Metadata-only authority reads must not decode unrelated Notebook bodies.
      // Each access still reads current committed products and validates the exact current Knowledge pages.
      const readCounts = () => {
        this.refreshBorrowedArtifactInventory(workspaceId);
        return {
          threadCount: listNativeProducts(scope, 'thread').length,
          artifactCount: [...this.artifacts.values()].filter(
            (artifact) =>
              artifact.workspaceId === workspaceId &&
              !this.pendingArtifactSubmissions.has(artifact.id)
          ).length,
          knowledgeEntryCount: readWorkspaceKnowledgePages(
            this.workspaceRootPath(workspaceId),
            this.workspaceKnowledgeSelection(workspaceId)
          ).length,
        };
      };
      return {
        ...system,
        name: config.workspace.name,
        get counts() {
          return readCounts();
        },
      };
    }
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new StoreRecordNotFoundError(`Workspace not found: ${workspaceId}`);
    return structuredClone(workspace);
  }

  /**
   * Installs a live Agent catalog read projection for Workspace resources.
   *
   * The callback is consulted on each read. It does not persist catalog rows.
   *
   * @param projection Current-snapshot catalog projection.
   */
  public setWorkspaceAgentCatalogProjection(projection: () => RuntimeAgent[]): void {
    this.workspaceAgentCatalogProjection = projection;
  }

  /** Binds current loaded Workspace Policy without copying its durable authority into the store. */
  public setWorkspaceResourcePolicyProjection(
    projection: (workspaceId: string) => PolicyDocumentV1 | null
  ): void {
    this.workspaceResourcePolicyProjection = projection;
  }

  /** Reads current effective restrictions; an unpublished configuration cannot activate or remove them. */
  public getWorkspaceResourceAccess(workspaceId: string): PolicyDocumentV1 {
    const effective = this.workspaceResourcePolicyProjection?.(workspaceId);
    if (effective !== undefined && effective !== null) return effective;
    if (!this.dataRoot) return EMPTY_POLICY_DOCUMENT;
    const path = join(this.dataRoot, 'workspaces', workspaceId, 'config', 'workspace.jsonc');
    if (!existsSync(path)) return EMPTY_POLICY_DOCUMENT;
    const authored =
      WorkspaceConfigSchema.parse(parseJsonc(readFileSync(path, 'utf8'))).workspace.policy
        ?.mediation ?? EMPTY_POLICY_DOCUMENT;
    // New imports stay closed until their validated configuration joins the runtime snapshot.
    if (this.workspaceResourcePolicyProjection && authored.statements.length)
      throw new Error('Workspace resource Policy is not loaded.');
    return authored;
  }

  /**
   * Returns stored Workspace resources without the live Agent catalog overlay.
   *
   * @param workspaceId Workspace whose stored resources should be read.
   * @returns Unprojected Workspace resource rows.
   */
  private storedWorkspaceResources(workspaceId: string): WorkspaceResources {
    this.getWorkspace(workspaceId);
    const resources = this.workspaceResources.get(workspaceId);

    if (!resources) {
      throw new StoreRecordNotFoundError(`Workspace resources not found: ${workspaceId}`);
    }

    return resources;
  }

  /** Reads Workspace resources with current Agent supply, without persisting the projection. */
  public getWorkspaceResources(workspaceId: string): WorkspaceResources {
    const resources = this.storedWorkspaceResources(workspaceId);
    const project = this.workspaceAgentCatalogProjection;

    const knowledge = this.dataRoot
      ? readWorkspaceKnowledgePages(
          this.workspaceRootPath(workspaceId),
          this.workspaceKnowledgeSelection(workspaceId)
        )
      : resources.knowledge;
    return { ...resources, knowledge, ...(project ? { agents: project() } : {}) };
  }

  public async updateWorkspace(
    workspaceId: string,
    input: {
      name?: WorkspaceRecord['name'] | undefined;
      kind?: WorkspaceRecord['kind'] | undefined;
      status?: WorkspaceRecord['status'] | undefined;
    }
  ): Promise<WorkspaceRecord> {
    const scope = this.dataRoot ? this.nativeScope({ kind: 'workspace', workspaceId }) : undefined;
    const previous = scope ? readNativeProduct(scope, 'workspace', workspaceId) : undefined;
    const workspace = {
      ...this.getWorkspace(workspaceId),
      ...(previous ? WorkspaceSystemRecordSchema.parse(previous.record) : {}),
    };
    const updated: WorkspaceRecord = {
      ...workspace,
      name: input.name ?? workspace.name,
      kind: input.kind ?? workspace.kind,
      status: input.status ?? workspace.status,
      updatedAt: now(),
    };
    if (this.dataRoot) {
      await this.writeNativeProducts(scope!, [
        {
          kind: 'workspace',
          expectedRevision: previous!.revision,
          record: writeRetainedV1(projectWorkspaceSystemRecord(updated)),
        },
      ]);
      // Authored configuration remains a separate file-owned effect, not part of the SQL acknowledgement.
      if (input.name !== undefined)
        writeWorkspaceConfiguration(this.workspaceRootPath(workspaceId), updated, true);
    }
    this.workspaces.set(workspaceId, updated);
    return this.getWorkspace(workspaceId);
  }

  /** Refreshes joined Workspace names after an accepted runtime-config reload. */
  public refreshWorkspaceConfigNames(
    workspaceNames: readonly { readonly workspaceId: string; readonly name: string }[]
  ): void {
    // Reload projects only admitted owners; an excluded sibling keeps its retained configuration.
    const admittedNames = workspaceNames.filter(
      ({ workspaceId }) =>
        !this.dataRoot ||
        isScopeAdmitted(this.dataRoot, 'workspace', workspaceId, this.suppliedScopeRefusals)
    );
    for (const { workspaceId } of admittedNames) {
      this.assertWorkspacePublicationAcknowledged(workspaceId);
    }
    for (const { workspaceId, name } of admittedNames) {
      const workspace = this.workspaces.get(workspaceId);
      if (workspace && workspace.name !== name) {
        this.workspaces.set(workspaceId, { ...workspace, name });
      }
    }
  }

  /** Returns canonical published pages, or explicit in-memory fixture pages. */
  public listKnowledge(workspaceId: string): KnowledgeNotebookPage[] {
    if (this.borrowedProductScope) {
      this.getWorkspace(workspaceId);
      return readWorkspaceKnowledgePages(
        this.workspaceRootPath(workspaceId),
        this.workspaceKnowledgeSelection(workspaceId)
      );
    }
    return this.getWorkspaceResources(workspaceId).knowledge;
  }

  /**
   * Returns one canonical Workspace Notebook page by id.
   *
   * @param workspaceId Workspace that owns the page.
   * @param knowledgePageId Knowledge page id to return.
   * @returns Canonical page with complete Markdown bytes.
   */
  public getKnowledgePage(workspaceId: string, knowledgePageId: string): KnowledgeNotebookPage {
    const entry = this.listKnowledge(workspaceId).find((item) => item.id === knowledgePageId);

    if (!entry) {
      throw new StoreRecordNotFoundError(`Knowledge page not found: ${knowledgePageId}`);
    }

    return entry;
  }

  /**
   * Creates or replaces one agent in a workspace resource set.
   *
   * @param workspaceId Workspace that owns the agent.
   * @param agent Agent read model to store.
   * @returns Stored agent.
   */
  public upsertAgent(workspaceId: string, agent: Agent): Agent {
    const resources = this.storedWorkspaceResources(workspaceId);
    let replaced = false;
    const agents = resources.agents.map((candidate) => {
      if (candidate.id !== agent.id) {
        return candidate;
      }

      replaced = true;
      return agent;
    });

    if (!replaced) {
      agents.push(agent);
    }

    this.workspaceResources.set(workspaceId, {
      ...resources,
      agents,
    });
    return agent;
  }

  /**
   * Refresh agent health timestamps for one workspace.
   *
   * @param workspaceId Workspace whose agents should be refreshed.
   * @returns Agent health read models.
   */
  public refreshAgentHealth(workspaceId: string): Array<{
    agentId: string;
    status: Agent['health']['status'];
    message: string | null;
    checkedAt: string;
  }> {
    const checkedAt = now();

    return this.getWorkspaceResources(workspaceId).agents.map((agent) => ({
      agentId: agent.id,
      status: agent.health.status,
      message: agent.health.message,
      checkedAt,
    }));
  }

  /** Joins every native publisher to the same application-owned Workspace gate, including background admissions. */
  public setWorkspaceMutationAdmission(admission: WorkspaceMutationAdmission): void {
    if (this.workspaceMutationAdmission && this.workspaceMutationAdmission !== admission)
      throw new Error('Store already has a different Workspace mutation owner.');
    if (this.dataRoot) getControlStoreWorkerClient(admission);
    this.workspaceMutationAdmission = admission;
  }

  /** Acquires the existing gate for a direct producer; this creates no separate writer registry. */
  public enterWorkspaceMutation(
    workspaceId: string,
    exclusion: 'ordinary' | 'capture' = 'ordinary'
  ): () => void {
    const release = this.workspaceMutationAdmission?.enter(workspaceId, exclusion);
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
    return release ?? (() => undefined);
  }

  /** Orders head capture through ACK; file/effect owners stay outside this boundary. */
  private publishTurn<I, T>(
    owner: ControlProductOwner,
    turns: readonly string[],
    input: I,
    prepare: (owned: I) => Promise<T>,
    closeoutCallId?: string,
    progressItem?: ControlItemAppend
  ): Promise<T> {
    if (!this.dataRoot) return prepare(input);
    const scope = this.nativeScope(owner);
    const release =
      owner.kind === 'workspace'
        ? this.enterWorkspaceMutation(owner.workspaceId, 'capture')
        : () => undefined;
    return getControlStoreWorkerClient()
      .runTurnPublication(
        `${owner.kind === 'server' ? 'core' : 'workspace'}:${scope.path}`,
        turns,
        input,
        prepare,
        closeoutCallId,
        progressItem
          ? {
              input: progressItem,
              opening: {
                database: `workspace:${scope.path}`,
                path: scope.path,
                dataRoot: this.dataRoot,
                create: false,
                initialize: 'workspace',
                productOwner: scope.owner,
                contentMount: scope.contentMount,
              },
            }
          : undefined
      )
      .finally(release);
  }

  /** Releases the native boundary before hooks, while retaining their shutdown lifetime. */
  private publishTurnMutation<I>(
    owner: ControlProductOwner,
    turnId: string,
    input: I,
    prepare: (owned: I) => Promise<Turn | { turn: Turn; notify: boolean }>
  ): Promise<Turn> {
    const publication = this.publishTurn(owner, [turnId], input, prepare);
    // If shutdown refuses the separate hook lifetime, its caller still owns the refusal below.
    void publication.catch(() => undefined);
    const finish = async () => {
      const result = await publication;
      const turn = 'turn' in result ? result.turn : result;
      if ('turn' in result && result.notify && this.terminalHookDepth < 8) {
        this.terminalHookDepth++;
        try {
          await this.turnAdmissionHooks?.onTerminal?.(turn);
        } finally {
          this.terminalHookDepth--;
        }
      }
      return turn;
    };
    return this.dataRoot ? getControlStoreWorkerClient().runOperation(finish) : finish();
  }

  /** Appends an immutable revision and conditions it on the same native Turn and Item revision. */
  private async persistNativeItem(
    item: Item,
    history: NonNullable<
      ReturnType<typeof readNativeTurnHistory> | ReturnType<typeof readNativeTurnWriteHead>
    >,
    admission?: TerminalTurnWriteAdmission
  ): Promise<Item> {
    const scope = this.nativeScope(item.owner);
    const prior = history.itemRevisions.filter((row) => row.id === item.id);
    const previousRevision = 'itemRevision' in history ? history.itemRevision : prior.length;
    const previous = prior.at(-1);
    const retained = previous
      ? (preserveDescriptiveRecord(
          previous,
          StoredItemPayloadV1Schema.parse(previous),
          item
        ) as Item)
      : item;
    const content = await prepareRetainedProductJson(
      scope.contentMount,
      scope.owner,
      join(dirname(dirname(scope.path)), 'runtime', 'staging'),
      writeRetainedV1(retained)
    );
    const entries: ControlProductEntry[] = [
      {
        kind: 'item',
        turnId: item.turnId,
        sequence:
          ('itemSequence' in history ? history.itemSequence : history.itemRevisions.length) + 1,
        expectedRevision: previousRevision,
        ...content,
      },
    ];
    if (isSealedTurnTerminal(history.turn.status)) {
      if (!admission) throw terminalTurnWriteRejected(item.turnId);
      await this.writeNativePublication(scope, history, entries, admission.category);
    } else {
      await this.writeNativeProducts(
        scope,
        [{ kind: 'turn', expectedRevision: history.revision, record: history.metadata }],
        entries
      );
    }
    // The worker verifies and commits these exact immutable bytes; only its FULL ACK releases them.
    return retained;
  }

  /** Reads one opaque Workspace Item only after resolving its native owner selectors. */
  private workspaceItemById(itemId: string): Item | undefined {
    if (!this.dataRoot) return this.items.get(itemId);
    const lineage = this.findNativeOwner('item', itemId);
    return lineage?.owner.kind === 'workspace' && lineage.turnId && lineage.threadId
      ? this.getTurn(lineage.owner.workspaceId, lineage.threadId, lineage.turnId).items.find(
          (item) => item.id === itemId
        )
      : undefined;
  }

  /**
   * Commits one original scoped Notebook SQL stage on the existing Core or User physical owner.
   * The optional admission recheck is the caller's existing synchronous semantic check after opening;
   * it never travels to the worker or authorizes SQL. Completion facts and receipts settle the original effect.
   * Newly moved standalone receipts retain their separate acknowledged expiry-maintenance stage.
   */
  public async commitScopedNotebookStage(
    db: CoreDb | UserDb,
    stage:
      | {
          readonly kind: 'audit';
          readonly event: AuditEvent & { createdAt: string; occurredAt: string };
        }
      | { readonly kind: 'receipt'; readonly receipt: CommandRequestRecord },
    revalidatePublication?: () => void
  ): Promise<void> {
    if (
      !this.dataRoot ||
      resolve(db.dataRoot) !== resolve(this.dataRoot) ||
      !db.sqlite.open ||
      db.sqlite.inTransaction
    )
      throw new NotebookError('recovery_required');
    const client = getControlStoreWorkerClient();
    let database: string;
    if (db.scope === 'user') {
      const path = nativeUserDatabasePath(db);
      database = `user:${path}`;
      await client.open({ database, path, create: false, initialize: 'user' });
    } else {
      const scope = this.nativeScope({ kind: 'server' });
      if (resolve(db.sqlite.name) !== resolve(scope.path))
        throw new NotebookError('recovery_required');
      database = `core:${scope.path}`;
      await client.open({
        database,
        path: scope.path,
        dataRoot: this.dataRoot,
        create: false,
        initialize: 'core',
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      });
    }
    if (
      stage.kind === 'audit' &&
      stage.event.action === 'knowledge.notebook.admit' &&
      !revalidatePublication
    )
      throw new NotebookError('recovery_required');
    if (revalidatePublication) {
      const checked: unknown = revalidatePublication();
      if (checked && typeof (checked as { then?: unknown }).then === 'function')
        throw new TypeError('Notebook publication admission must be synchronous.');
    }
    if (stage.kind === 'audit' && db.scope === 'user') {
      if (stage.event.workspaceId !== null) throw new NotebookError('recovery_required');
      await client.capability(database, {
        kind: 'user-audit',
        userId: db.userId,
        event: { ...stage.event, workspaceId: null },
      });
    } else {
      const input =
        stage.kind === 'audit'
          ? { action: 'server-audit', event: stage.event }
          : db.scope === 'user'
            ? { action: 'user-receipt', userId: db.userId, receipt: stage.receipt }
            : { action: 'server-receipt', receipt: stage.receipt };
      await client.scopedNotebookSql(database, ControlScopedNotebookSqlInputSchema.parse(input));
      if (
        stage.kind === 'receipt' &&
        isSeparateScopedNotebookReceipt(db.scope, stage.receipt.command)
      ) {
        // The original receipt has already committed; expiry maintenance is a separate FULL stage.
        const maintenance =
          db.scope === 'user'
            ? {
                action: 'user-receipt-maintenance',
                userId: db.userId,
                command: stage.receipt.command,
                referenceTime: now(),
              }
            : {
                action: 'server-receipt-maintenance',
                command: stage.receipt.command,
                referenceTime: now(),
              };
        await client.scopedNotebookSql(
          database,
          ControlScopedNotebookSqlInputSchema.parse(maintenance)
        );
      }
    }
  }

  /**
   * Commits one admitted Workspace Knowledge tuple with its original Audit and command facts.
   *
   * The caller prepares immutable bytes and owns current semantic admission. This
   * method selects only the existing native physical owner and fixed Knowledge
   * statements; it accepts no SQL or mutation callback. FULL ACK precedes projection.
   *
   * @param input Exact selected heads, optional original Proposal/Review, Audits and receipt.
   * @returns Completion only after the native tuple is durably acknowledged.
   */
  public async commitWorkspaceKnowledge(input: {
    readonly workspaceDb: WorkspaceDb;
    readonly expectedHead: ControlKnowledgeHead;
    readonly nextHead?: ControlKnowledgeHead;
    readonly newProposal?: ControlKnowledgeProposal;
    readonly review?: {
      readonly proposalId: string;
      readonly review: KnowledgeProposalReviewRecord;
    };
    readonly audits: readonly AuditEvent[];
    readonly receipt?: CommandRequestRecord;
    /** Existing synchronous semantic admission; it selects no SQL or effect. */
    readonly revalidatePublication: () => void;
  }): Promise<void> {
    const db = input.workspaceDb;
    if (
      !this.dataRoot ||
      resolve(db.dataRoot) !== resolve(this.dataRoot) ||
      db.scope !== 'workspace' ||
      !db.sqlite.open ||
      db.sqlite.inTransaction ||
      input.expectedHead.workspaceId !== db.workspaceId ||
      (input.nextHead &&
        (input.nextHead.workspaceId !== db.workspaceId ||
          input.nextHead.knowledgeBaseId !== input.expectedHead.knowledgeBaseId)) ||
      (input.newProposal &&
        (input.newProposal.workspaceId !== db.workspaceId ||
          input.newProposal.knowledgeBaseId !== input.expectedHead.knowledgeBaseId)) ||
      input.audits.some((event) => event.workspaceId !== db.workspaceId)
    )
      throw new NotebookError('recovery_required');
    // Reviewed Schema application has its own current native read/compute tuple.
    if (input.receipt?.command === 'knowledge.schema.apply')
      throw new NotebookError('recovery_required');
    const scope = this.nativeScope({ kind: 'workspace', workspaceId: db.workspaceId });
    if (resolve(db.sqlite.name) !== resolve(scope.path))
      throw new NotebookError('recovery_required');
    const database = `workspace:${scope.path}`;
    const client = getControlStoreWorkerClient();
    try {
      const command = {
        database,
        path: scope.path,
        dataRoot: this.dataRoot,
        create: false as const,
        initialize: 'workspace' as const,
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      };
      await client.open(command);
      // The existing semantic owner checks authority again after native opening.
      const admission: unknown = input.revalidatePublication();
      if (admission && typeof (admission as { then?: unknown }).then === 'function')
        throw new TypeError('Knowledge publication admission must be synchronous.');
      await client.write(database, [
        ...(input.nextHead
          ? controlKnowledgeHeadStatements(input.nextHead, input.expectedHead)
          : [controlKnowledgeHeadGuardStatement(db, input.expectedHead)]),
        ...(input.newProposal ? [controlKnowledgeProposalStatement(input.newProposal)] : []),
        ...(input.review
          ? [controlKnowledgeReviewStatement(db, input.review.proposalId, input.review.review)]
          : []),
        ...input.audits.map(prepareAuditEventStatement),
        ...(input.receipt
          ? [prepareControlCommandRequestStatement(db.workspaceId, input.receipt)]
          : []),
      ]);
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.commit === 'not-committed' &&
        error.code === 'precondition'
      )
        throw new NotebookError('conflict');
      throw error;
    }
  }

  /** Resolves the real admitted SQLite and private Storage owner, never an alias or synthetic Workspace. */
  private nativeScope(owner: ControlProductOwner): NativeProductScope {
    if (!this.dataRoot) throw new Error('Native product storage is not configured.');
    if (owner.kind === 'workspace') this.assertWorkspacePublicationAcknowledged(owner.workspaceId);
    const borrowed = this.borrowedProductScope;
    if (borrowed && isDeepStrictEqual(borrowed.owner, owner)) return borrowed;
    return nativeProductScope(this.dataRoot, owner);
  }

  /** Sends one complete conditional tuple; cache publication must follow its FULL COMMIT acknowledgement. */
  private async writeNativeProducts(
    scope: NativeProductScope,
    products: ControlProductMutation[],
    entries: ControlProductEntry[] = [],
    admission?: Pick<ControlAdmission, 'receipt' | 'audit'>,
    journalIntents?: readonly ExecutionJournalIntent[],
    pending?: readonly ControlPendingCommandInput[]
  ): Promise<ControlAdmissionResult | undefined> {
    const release =
      scope.owner.kind === 'workspace'
        ? this.enterWorkspaceMutation(scope.owner.workspaceId, 'capture')
        : () => undefined;
    try {
      const client = getControlStoreWorkerClient();
      const database = `${scope.owner.kind === 'server' ? 'core' : 'workspace'}:${scope.path}`;
      await client.open({
        database,
        path: scope.path,
        dataRoot: this.dataRoot!,
        create: false,
        initialize: scope.owner.kind === 'server' ? 'core' : 'workspace',
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      });
      if (admission)
        return await client.transition(database, {
          ...admission,
          products,
          entries,
          ...(pending?.length ? { pending: [...pending] } : {}),
        });
      await client.products(database, {
        products,
        entries,
        ...(pending?.length ? { pending: [...pending] } : {}),
        ...(journalIntents?.length
          ? { journalIntents: journalIntents.map(encodeExecutionJournalValue) }
          : {}),
      });
      return undefined;
    } finally {
      release();
    }
  }

  /** Completes only the declared post-terminal Item/event publication under its unchanged native Turn. */
  private async writeNativePublication(
    scope: NativeProductScope,
    history: { turn: Pick<Turn, 'id'>; revision: number },
    entries: ControlProductEntry[],
    category: TerminalTurnWriteAdmission['category']
  ): Promise<void> {
    const client = getControlStoreWorkerClient();
    const database = `${scope.owner.kind === 'server' ? 'core' : 'workspace'}:${scope.path}`;
    await client.open({
      database,
      path: scope.path,
      dataRoot: this.dataRoot!,
      create: false,
      initialize: scope.owner.kind === 'server' ? 'core' : 'workspace',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    await client.publication(database, {
      category,
      turnId: history.turn.id,
      expectedRevision: history.revision,
      entries,
    });
  }

  /** Synchronizes exact Item bytes for a complete native tuple, without admitting their entries. */
  private async prepareNativeItems(
    scope: NativeProductScope,
    items: readonly Item[]
  ): Promise<ControlProductEntry[]> {
    const counts = new Map<string, number>();
    const entries: ControlProductEntry[] = [];
    for (const value of items) {
      const item = ItemSchema.parse(value);
      if (!isDeepStrictEqual(item.owner, scope.owner))
        throw new Error('Native Item owner conflicts.');
      const existing = readNativeProductEntries(scope, item.turnId, 'item');
      const previous = existing.filter((row) => row.id === item.id).at(-1);
      if (previous) {
        const stored = readNativeTurnHistory(scope, item.turnId)?.turn.items.find(
          (candidate) => candidate.id === item.id
        );
        if (!stored || !alreadyDecidedPublicationBytesEqual(stored, item))
          throw terminalTurnPublicationConflict(item.turnId);
        continue;
      }
      const offset = counts.get(item.turnId) ?? 0;
      entries.push({
        kind: 'item',
        turnId: item.turnId,
        sequence: existing.length + offset + 1,
        expectedRevision: 0,
        ...(await prepareRetainedProductJson(
          scope.contentMount,
          scope.owner,
          join(dirname(dirname(scope.path)), 'runtime', 'staging'),
          writeRetainedV1(item)
        )),
      });
      counts.set(item.turnId, offset + 1);
    }
    return entries;
  }

  /** Prepares the actual Pending freeze and immutable Items for a native owner that admits its own Turn. */
  public async prepareNativeTurnPendingAdmission(
    turn: Turn,
    executor: 'worker' | 'coordinator'
  ): Promise<{ entries: ControlProductEntry[]; pending: readonly ControlPendingCommandInput[] }> {
    const admission = await this.turnAdmissionHooks?.prepareAdmission?.(turn, executor);
    const entries = await this.prepareNativeItems(
      this.nativeScope(turn.owner),
      admission?.items ?? []
    );
    return { entries, pending: admission?.pending ?? [] };
  }

  /** Executes one closed Pending transition with its complete prepared Item and original receipt tuple. */
  public async applyPendingRequestCommand(
    ...args: Parameters<FsStore['applyPendingRequestCommandPublication']>
  ): Promise<ControlPendingCommandResult> {
    const turns = [...new Set((args[2]?.items ?? []).map((item) => item.turnId))];
    if (!turns.length) return this.applyPendingRequestCommandPublication(...args);
    if (args[2] === undefined) args[2] = {};
    return this.publishTurn({ kind: 'workspace', workspaceId: args[0] }, turns, args, (owned) =>
      this.applyPendingRequestCommandPublication(...owned)
    );
  }

  /** Applies the original checks inside the admitted same-Turn boundary. */
  private async applyPendingRequestCommandPublication(
    workspaceId: string,
    input: ControlPendingCommandInput,
    publication: { items?: readonly Item[]; receipt?: ControlPendingTransition['receipt'] } = {}
  ): Promise<ControlPendingCommandResult> {
    const scope = this.nativeScope({ kind: 'workspace', workspaceId });
    const entries = await this.prepareNativeItems(scope, publication.items ?? []);
    const client = getControlStoreWorkerClient();
    const database = `workspace:${scope.path}`;
    await client.open({
      database,
      path: scope.path,
      dataRoot: this.dataRoot!,
      create: false,
      initialize: 'workspace',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    return client.pendingCommand(database, {
      input,
      products: [],
      entries,
      receipt: publication.receipt ?? null,
    });
  }

  /** Prepares the existing Thread archive mutation and receipt for its Pending closeout tuple. */
  public preparePendingArchiveAdmission(
    workspaceId: string,
    threadId: string,
    admission: Pick<ControlAdmission, 'receipt' | 'audit'>
  ): ControlAdmission {
    const scope = this.nativeScope({ kind: 'workspace', workspaceId });
    const current = readNativeProduct(scope, 'thread', threadId);
    if (!current) throw new StoreRecordNotFoundError(`Thread not found: ${threadId}`);
    return {
      ...admission,
      products: [
        {
          kind: 'thread',
          expectedRevision: current.revision,
          record: writeRetainedV1({ ...current.record, status: 'archived', updatedAt: now() }),
        },
      ],
      entries: [],
    };
  }

  /** Publishes an actual Core-local Pending Turn, its row associations, Items and terminal event in one native tuple. */
  public async publishPendingRequestServiceTurn(
    ...args: Parameters<FsStore['publishPendingRequestServiceTurnPublication']>
  ): Promise<Turn> {
    return this.publishTurn(
      { kind: 'workspace', workspaceId: args[0] },
      [args[2].turnId],
      args,
      (owned) => this.publishPendingRequestServiceTurnPublication(...owned)
    );
  }

  /** Applies the original checks inside the admitted same-Turn boundary. */
  private async publishPendingRequestServiceTurnPublication(
    workspaceId: string,
    threadId: string,
    input: {
      turnId: string;
      summary: string;
      actor: ActorRef;
      now: string;
      items: readonly Item[];
      pending: readonly ControlPendingCommandInput[];
      admission?: ControlAdmission;
      archive?: boolean;
    }
  ): Promise<Turn> {
    const scope = this.nativeScope({ kind: 'workspace', workspaceId });
    const existing = readNativeTurnHistory(scope, input.turnId);
    const turn = TurnSchema.parse({
      ...(existing?.turn ?? {
        id: input.turnId,
        owner: scope.owner,
        threadId,
        triggerActor: input.actor,
        configVersion: null,
        error: null,
        startedAt: input.now,
        agentId: null,
        agentSessionId: null,
        triggerSource: { kind: 'system-input', summary: input.summary },
      }),
      status: 'completed',
      completedAt: existing?.turn.completedAt ?? input.now,
      durationMs: existing?.turn.durationMs ?? 0,
      items: [
        ...new Map(
          [...(existing?.turn.items ?? []), ...input.items].map((item) => [item.id, item])
        ).values(),
      ],
    });
    if (turn.agentId || turn.agentSessionId || turn.threadId !== threadId)
      throw new Error('Pending service publication requires its original Core-local Turn.');
    const entries = await this.prepareNativeItems(scope, input.items);
    const priorEvent = existing
      ? this.getTurnEventsForExport(turn.id).find((event) => event.data.type === 'turn-completed')
      : undefined;
    const event =
      priorEvent ??
      SseEventEnvelopeSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        workspaceId,
        threadId,
        turnId: turn.id,
        requestId: null,
        timestamp: turn.completedAt,
        sequence: 1,
        event: 'turn.completed',
        data: { type: 'turn-completed', stopReason: 'completed', turn },
      });
    let content: Pick<ControlProductEntry, 'content' | 'publication'>;
    if (priorEvent) {
      // Sealed replay retains exact immutable bytes, including retained descriptive field order.
      const reader = openControlStoreProductReadHandle(scope.path, scope.owner);
      try {
        const entry = reader.entries(turn.id, 'event', event.sequence - 1, 1)[0];
        if (!entry || entry.sequence !== event.sequence)
          throw terminalTurnPublicationConflict(turn.id);
        content = { content: entry.content };
      } finally {
        reader.close();
      }
    } else {
      content = await prepareRetainedProductJson(
        scope.contentMount,
        scope.owner,
        join(dirname(dirname(scope.path)), 'runtime', 'staging'),
        writeRetainedV1(event)
      );
    }
    entries.push({
      kind: 'event',
      turnId: turn.id,
      sequence: event.sequence,
      expectedRevision: 0,
      ...content,
    });
    const [command] = input.pending;
    if (!command)
      throw new Error('Pending service publication requires its original deciding transition.');
    const client = getControlStoreWorkerClient();
    const database = `workspace:${scope.path}`;
    await client.open({
      database,
      path: scope.path,
      dataRoot: this.dataRoot!,
      create: false,
      initialize: 'workspace',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    await client.pendingCommand(database, {
      input: command,
      products: [],
      entries: [],
      receipt: null,
      ...(input.admission ? { admission: input.admission } : {}),
      terminal: {
        owner: scope.owner,
        turn: {
          kind: 'turn',
          expectedRevision: existing?.revision ?? 0,
          record: writeRetainedV1({
            ...(existing?.metadata ?? { captureCoverage: this.liveCaptureCoverage }),
            ...turn,
            items: [],
          }),
        },
        products:
          input.archive && !input.admission
            ? [
                {
                  kind: 'thread',
                  expectedRevision: readNativeProduct(scope, 'thread', threadId)!.revision,
                  record: writeRetainedV1({
                    ...readNativeProduct(scope, 'thread', threadId)!.record,
                    status: 'archived',
                    updatedAt: input.now,
                  }),
                },
              ]
            : [],
        entries,
        pending: [...input.pending],
        reap: { reason: 'completed', inferredBy: 'pending-request-publication' },
        evidence: [],
        evidenceContent: [],
        command: null,
        execution: null,
      },
    });
    return this.getTurnById(turn.id);
  }

  /** Commits one existing Workspace execution intent before its actual effect. */
  public async writeWorkspaceExecutionJournalIntent(
    workspaceId: string,
    input: ExecutionJournalIntent
  ): Promise<ExecutionInvocation> {
    const result = await this.writeWorkspaceExecutionJournal(workspaceId, {
      kind: 'intent',
      inputJson: encodeExecutionJournalValue(input),
    });
    return decodeExecutionJournalInvocation(result);
  }

  /** Settles the original Workspace step from observed facts; this does not itself prove physical release. */
  public async settleWorkspaceExecutionJournalStep(
    workspaceId: string,
    input: ExecutionJournalSettlement,
    consumeIntent?: ExecutionJournalIntent
  ): Promise<EndedExecutionStep> {
    const result = await this.writeWorkspaceExecutionJournal(workspaceId, {
      kind: 'settle',
      inputJson: encodeExecutionJournalValue(input),
      ...(consumeIntent ? { consumeIntentJson: encodeExecutionJournalValue(consumeIntent) } : {}),
    });
    return decodeEndedExecutionStep(result);
  }

  /** Uses the admitted native scope and the existing closed journal body, without a Main writer. */
  private async writeWorkspaceExecutionJournal(
    workspaceId: string,
    input: import('../runtime/execution-journal.js').ControlExecutionJournalInput
  ): Promise<string> {
    const scope = this.nativeScope({ kind: 'workspace', workspaceId });
    const client = getControlStoreWorkerClient();
    const database = `workspace:${scope.path}`;
    await client.open({
      database,
      path: scope.path,
      dataRoot: this.dataRoot!,
      create: false,
      initialize: 'workspace',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    return client.journal(database, input);
  }

  /** Discovers opaque identities from native indexed selectors, not cached bodies or a new registry. */
  private findNativeOwner(
    kind: 'thread' | 'turn' | 'agent-session' | 'item',
    id: string,
    excludedWorkspaceId?: string
  ): { owner: ControlProductOwner; threadId: string | null; turnId?: string } | undefined {
    const steps = this.findNativeOwnerSteps(kind, id, excludedWorkspaceId);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  /** Shares the original owner read in released page/proof contributions for one admitted call. */
  private *findNativeOwnerSteps(
    kind: 'thread' | 'turn' | 'agent-session' | 'item',
    id: string,
    excludedWorkspaceId?: string
  ): Generator<
    void,
    { owner: ControlProductOwner; threadId: string | null; turnId?: string } | undefined,
    void
  > {
    if (!this.dataRoot) return undefined;
    const owners: ControlProductOwner[] = [
      { kind: 'server' },
      ...listDirectoryNames(join(this.dataRoot, 'workspaces'))
        // Match startup readers: refused scopes cannot participate in another owner's discovery.
        .filter(
          (id) =>
            id !== '.staging' &&
            id !== excludedWorkspaceId &&
            isScopeAdmitted(this.dataRoot!, 'workspace', id, this.suppliedScopeRefusals)
        )
        .map((workspaceId) => ({ kind: 'workspace' as const, workspaceId })),
    ];
    let result:
      | { owner: ControlProductOwner; threadId: string | null; turnId?: string }
      | undefined;
    for (const owner of owners) {
      if (kind === 'agent-session' && owner.kind === 'server') continue;
      const root =
        owner.kind === 'server'
          ? join(this.dataRoot, 'server')
          : join(this.dataRoot, 'workspaces', owner.workspaceId);
      const path = join(root, 'db', owner.kind === 'server' ? 'core.sqlite' : 'workspace.sqlite');
      let reader: ReturnType<typeof openControlStoreProductReadHandle> | undefined;
      try {
        if (owner.kind === 'workspace') {
          assertCanonicalDirectory(root);
          assertCanonicalDirectory(dirname(path));
          assertCanonicalRegularFile(path);
        }
        reader =
          owner.kind === 'workspace'
            ? getWorkspaceProductReadHandle(
                path,
                owner,
                this.borrowedProductScope &&
                  isDeepStrictEqual(owner, this.borrowedProductScope.owner)
                  ? this.borrowedProductScope.sqlite
                  : undefined
              )
            : openControlStoreProductReadHandle(path, owner);
        if (owner.kind === 'workspace' && !reader.get('workspace', owner.workspaceId))
          throw new Error('The native Workspace identity is unavailable.');
      } catch (error) {
        if (owner.kind === 'workspace') closeWorkspaceProductReadHandles(path);
        else reader?.close();
        if (owner.kind === 'server') throw error;
        refuseScope(this.dataRoot, {
          scope: 'workspace',
          id: owner.workspaceId,
          check: 'database',
        });
        yield;
        continue;
      }
      try {
        const table = {
          thread: 'control_threads',
          turn: 'control_turns',
          'agent-session': 'control_agent_sessions',
          item: 'control_product_entries',
        }[kind];
        const row =
          kind === 'item'
            ? (reader.sqlite
                .prepare(
                  "SELECT schema_version,turn_id,identity_json FROM control_product_entries WHERE kind='item' AND id=? LIMIT 1"
                )
                .get(id) as
                | { schema_version: number; identity_json: string; turn_id: string }
                | undefined)
            : (reader.sqlite
                .prepare(
                  `SELECT schema_version,${kind === 'thread' ? 'id AS thread_id' : 'thread_id'} FROM ${table} WHERE id=?`
                )
                .get(id) as { schema_version: number; thread_id: string | null } | undefined);
        if (row) {
          if (row.schema_version !== 1)
            throw new Error('Unsupported native product selector format.');
          if (result) {
            if (excludedWorkspaceId) {
              const identity = `${kind === 'agent-session' ? 'session' : kind}:${id}`;
              const claims: Array<readonly [string, readonly string[]]> = [
                [excludedWorkspaceId, [identity]],
              ];
              for (const peer of [result.owner, owner])
                if (peer.kind === 'workspace') claims.push([peer.workspaceId, [identity]]);
              refuseWorkspaceIdentityConflicts(this.dataRoot, claims);
            }
            throw new Error('Conflicting native product owner; recovery_required.');
          }
          const threadId =
            'identity_json' in row ? JSON.parse(row.identity_json).threadId : row.thread_id;
          result = {
            owner,
            threadId: threadId === null ? null : ThreadIdSchema.parse(threadId),
            ...('turn_id' in row ? { turnId: row.turn_id as string } : {}),
          };
        }
      } catch (error) {
        if (owner.kind === 'workspace') closeWorkspaceProductReadHandles(path);
        throw error;
      } finally {
        if (owner.kind === 'server' || reader.sqlite === this.borrowedProductScope?.sqlite)
          reader.close();
      }
      yield;
    }
    return result;
  }

  /** Retains process-local listeners for native Turns admitted by another owner. */
  private turnStream(turnId: string): TurnStreamState {
    let stream = this.streams.get(turnId);
    if (!stream) {
      stream = { sequence: 0, events: [], listeners: new Set() };
      this.streams.set(turnId, stream);
    }
    return stream;
  }

  /** Retains only Server listener state; native rows remain the product authority. */
  private serverTurnStream(turnId: string) {
    let stream = this.serverStreams.get(turnId);
    if (!stream) {
      stream = { sequence: 0, events: [], listeners: new Set() };
      this.serverStreams.set(turnId, stream);
    }
    return stream;
  }

  /** Lists Server narratives for a caller already admitted by the Server authority owner. */
  public listServerThreads(): Thread[] {
    return this.dataRoot
      ? listNativeProducts(
          nativeProductMetadataScope(this.dataRoot!, { kind: 'server' }),
          'thread'
        ).map((row) => ThreadSchema.parse(row.record))
      : structuredClone([...this.serverThreads.values()]);
  }

  /** Creates a Server narrative with no Workspace anchor or private User audience. */
  public async createServerThread(
    title: string,
    threadId?: string,
    entryPath: Thread['entryPath'] = 'knowledge-manager'
  ): Promise<Thread> {
    const thread = ThreadSchema.parse({
      id: threadId ?? allocateEntityId('th'),
      owner: { kind: 'server' },
      visibility: 'server',
      name: title,
      preview: title,
      status: 'active',
      entryPath,
      threadSource: 'conversation',
      createdAt: now(),
      updatedAt: now(),
    });
    if (
      this.dataRoot
        ? this.findNativeOwner('thread', thread.id)
        : this.serverThreads.has(thread.id) || this.threads.has(thread.id)
    )
      throw new Error(`Thread already exists: ${thread.id}`);
    if (this.dataRoot) {
      await this.writeNativeProducts(this.nativeScope({ kind: 'server' }), [
        { kind: 'thread', expectedRevision: 0, record: writeRetainedV1(thread) },
      ]);
      return this.getServerThread(thread.id);
    }
    this.serverThreads.set(thread.id, thread);
    return thread;
  }

  /** Reads one canonical Server narrative after current Server authority admission. */
  public getServerThread(threadId: string): Thread {
    const thread = this.dataRoot
      ? (readNativeProduct(
          nativeProductMetadataScope(this.dataRoot!, { kind: 'server' }),
          'thread',
          threadId
        )?.record as Thread | undefined)
      : this.serverThreads.get(threadId);
    if (!thread) throw new StoreRecordNotFoundError(`Server Thread not found: ${threadId}`);
    return ThreadSchema.parse(thread);
  }

  /** Changes only mutable narrative metadata; placement, entry and lineage remain fixed. */
  public async updateServerThread(
    threadId: string,
    input: Partial<Pick<Thread, 'name' | 'status'>>
  ): Promise<Thread> {
    const scope = this.dataRoot ? this.nativeScope({ kind: 'server' }) : undefined;
    const previous = scope ? readNativeProduct(scope, 'thread', threadId) : undefined;
    const thread = previous ? ThreadSchema.parse(previous.record) : this.getServerThread(threadId);
    for (const key of Object.keys(input))
      if (!['name', 'status'].includes(key))
        throw new Error(`Server Thread update cannot change field: ${key}`);
    const updated = ThreadSchema.parse({ ...thread, ...input, updatedAt: now() });
    if (this.dataRoot) {
      await this.writeNativeProducts(scope!, [
        { kind: 'thread', expectedRevision: previous!.revision, record: writeRetainedV1(updated) },
      ]);
      return this.getServerThread(threadId);
    }
    this.serverThreads.set(threadId, updated);
    return updated;
  }

  /** Creates an already-decided Core-local Turn through the complete native terminal owner. */
  private async createNativeTerminalTurn(
    scope: NativeProductScope,
    turn: Turn,
    captureCoverage: CaptureCoverageBinding,
    products: ControlProductMutation[],
    entries: ControlProductEntry[] = [],
    pending: readonly ControlPendingCommandInput[] = []
  ): Promise<void> {
    const event = (
      scope.owner.kind === 'server' ? ServerTurnEventEnvelopeSchema : SseEventEnvelopeSchema
    ).parse({
      protocolVersion: PROTOCOL_VERSION,
      ...(scope.owner.kind === 'server'
        ? { owner: scope.owner }
        : { workspaceId: scope.owner.workspaceId }),
      threadId: turn.threadId,
      turnId: turn.id,
      requestId: null,
      timestamp: turn.completedAt,
      sequence: 1,
      event: 'turn.completed',
      data: {
        type: 'turn-completed',
        stopReason:
          turn.status === 'completed'
            ? 'completed'
            : turn.status === 'failed'
              ? 'error'
              : 'aborted',
        turn,
      },
    });
    entries.push({
      kind: 'event',
      turnId: turn.id,
      sequence: 1,
      expectedRevision: 0,
      ...(await prepareRetainedProductJson(
        scope.contentMount,
        scope.owner,
        join(dirname(dirname(scope.path)), 'runtime', 'staging'),
        writeRetainedV1(event)
      )),
    });
    const client = getControlStoreWorkerClient();
    const database = `${scope.owner.kind === 'server' ? 'core' : 'workspace'}:${scope.path}`;
    await client.open({
      database,
      path: scope.path,
      dataRoot: this.dataRoot!,
      create: false,
      initialize: scope.owner.kind === 'server' ? 'core' : 'workspace',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    await client.terminal(database, {
      owner: scope.owner,
      turn: {
        kind: 'turn',
        expectedRevision: 0,
        record: writeRetainedV1({ ...turn, items: [], captureCoverage }),
      },
      products,
      entries,
      pending: [...pending],
      reap: { reason: turn.status, inferredBy: 'native-terminal-creation' },
      evidence: [],
      evidenceContent: [],
      command: null,
      execution: null,
    });
    this.acknowledgedTurnEvents.set(event, structuredClone(event));
  }

  /** Admits one sequential Server Turn; the runtime owner chooses the model and performs execution. */
  public async createServerTurn(
    threadId: string,
    input: string,
    triggerActor: ActorRef,
    configVersion: number | null = null,
    options: CreateServerTurnOptions = {}
  ): Promise<Turn> {
    const thread = this.getServerThread(threadId);
    if (thread.status === 'archived') throw new Error(`Server Thread is archived: ${threadId}`);
    const terminal = isSealedTurnTerminal(options.status ?? 'running');
    if (
      !terminal &&
      this.listServerThreadTurns(threadId).some(
        (turn) => turn.status === 'pending' || turn.status === 'running'
      )
    )
      throw new Error(`Server Thread has a Turn in flight: ${threadId}`);
    const timestamp = options.startedAt ?? now();
    const turn = TurnSchema.parse({
      ...options,
      id: options.turnId ?? allocateEntityId('tu'),
      owner: { kind: 'server' },
      threadId,
      triggerActor,
      items: [],
      status: options.status ?? 'running',
      error: null,
      configVersion,
      startedAt: timestamp,
      completedAt: terminal ? (options.completedAt ?? timestamp) : null,
      durationMs: terminal
        ? Math.max(
            0,
            new Date(options.completedAt ?? timestamp).getTime() - new Date(timestamp).getTime()
          )
        : null,
    });
    if (
      this.dataRoot
        ? this.findNativeOwner('turn', turn.id)
        : this.serverTurns.has(turn.id) || this.turns.has(turn.id)
    )
      throw new Error(`Turn already exists: ${turn.id}`);
    const updatedThread = { ...thread, preview: input, updatedAt: timestamp };
    if (this.dataRoot) {
      const scope = this.nativeScope({ kind: 'server' });
      const previousThread = readNativeProduct(scope, 'thread', threadId)!;
      if (terminal) {
        await this.createNativeTerminalTurn(
          scope,
          turn,
          options.captureCoverage ?? this.liveCaptureCoverage,
          [
            {
              kind: 'thread',
              expectedRevision: previousThread.revision,
              record: writeRetainedV1({
                ...previousThread.record,
                preview: input,
                updatedAt: timestamp,
              }),
            },
          ]
        );
        return this.getServerTurnById(turn.id);
      }
      await this.writeNativeProducts(scope, [
        {
          kind: 'thread',
          expectedRevision: previousThread.revision,
          record: writeRetainedV1({
            ...previousThread.record,
            preview: input,
            updatedAt: timestamp,
          }),
        },
        {
          kind: 'turn',
          expectedRevision: 0,
          record: writeRetainedV1({
            ...turn,
            items: [],
            captureCoverage: options.captureCoverage ?? this.liveCaptureCoverage,
          }),
        },
      ]);
      this.serverTurnStream(turn.id);
      return this.getServerTurnById(turn.id);
    }
    this.serverTurns.set(turn.id, turn);
    this.serverStreams.set(turn.id, { sequence: 0, events: [], listeners: new Set() });
    this.turnCaptureCoverage.set(turn.id, options.captureCoverage ?? this.liveCaptureCoverage);
    this.serverThreads.set(threadId, updatedThread);
    return turn;
  }

  /** Reads one Turn only within its exact Server Thread. */
  public getServerTurn(threadId: string, turnId: string): Turn {
    const turn = this.getServerTurnById(turnId);
    if (turn.threadId !== threadId)
      throw new StoreRecordNotFoundError(`Server Turn not found: ${turnId}`);
    return turn;
  }

  /** Reads a Server Turn by its opaque identity after Server authority admission. */
  public getServerTurnById(turnId: string): Turn {
    const turn = this.dataRoot
      ? readNativeTurnHistory(this.nativeScope({ kind: 'server' }), turnId)?.turn
      : this.serverTurns.get(turnId);
    if (!turn) throw new StoreRecordNotFoundError(`Server Turn not found: ${turnId}`);
    return TurnSchema.parse(TurnReaderSchema.parse(turn));
  }

  /** Lists only this Server Thread's Turns in durable admission order. */
  public listServerThreadTurns(threadId: string): Turn[] {
    this.getServerThread(threadId);
    return this.dataRoot
      ? [...readNativeThreadTurnPages(this.nativeScope({ kind: 'server' }), threadId)].flatMap(
          (page) => page.map((row) => this.getServerTurnById(row.record.id as string))
        )
      : [...this.serverTurns.values()].filter((turn) => turn.threadId === threadId);
  }

  /** Updates the existing closed lifecycle without changing immutable Server owner or admission facts. */
  public async updateServerTurn(
    ...args: Parameters<FsStore['updateServerTurnPublication']>
  ): Promise<Turn> {
    return this.publishTurnMutation({ kind: 'server' }, args[0], args, (owned) =>
      this.updateServerTurnPublication(...owned)
    );
  }

  /** Applies the original checks inside the admitted same-Turn boundary. */
  private async updateServerTurnPublication(
    turnId: string,
    input: ServerTurnUpdate
  ): Promise<Turn | { turn: Turn; notify: boolean }> {
    const native = this.dataRoot
      ? readNativeTurnHistory(this.nativeScope({ kind: 'server' }), turnId)
      : undefined;
    const turn = native?.turn ?? this.getServerTurnById(turnId);
    for (const key of Object.keys(input))
      if (!SERVER_TURN_UPDATE_FIELDS.includes(key))
        throw new Error(`Server Turn update cannot change field: ${key}`);
    const updated = TurnSchema.parse({
      ...TurnReaderSchema.parse(turn),
      ...input,
      durationMs:
        (input.completedAt ?? turn.completedAt) && turn.startedAt
          ? Math.max(
              0,
              new Date(input.completedAt ?? turn.completedAt!).getTime() -
                new Date(turn.startedAt).getTime()
            )
          : (input.durationMs ?? turn.durationMs),
    });
    if (isSealedTurnTerminal(turn.status)) {
      if (alreadyDecidedPublicationBytesEqual(turn, updated)) return turn;
      throw terminalTurnWriteRejected(turn.id);
    }
    if (this.dataRoot) {
      if (isSealedTurnTerminal(updated.status)) return this.completeTurnPublication(turnId, input);
      const scope = this.nativeScope({ kind: 'server' });
      await this.writeNativeProducts(scope, [
        {
          kind: 'turn',
          expectedRevision: native!.revision,
          record: writeRetainedV1({
            ...native!.metadata,
            ...input,
            durationMs: updated.durationMs,
            items: [],
          }),
        },
      ]);
      return this.getServerTurnById(turnId);
    }
    this.serverTurns.set(turn.id, updated);
    return updated;
  }

  /** Appends a full Item revision to its Server Turn before publishing its in-memory projection. */
  public async createServerItem(
    ...args: Parameters<FsStore['createServerItemPublication']>
  ): Promise<Item> {
    return this.publishTurn({ kind: 'server' }, [args[0].turnId], args, (owned) =>
      this.createServerItemPublication(...owned)
    );
  }

  /** Applies the original checks inside the admitted same-Turn boundary. */
  private async createServerItemPublication(
    input: Item,
    admission?: AlreadyDecidedPublicationAdmission
  ): Promise<Item> {
    const item = ItemSchema.parse(input);
    if (item.owner.kind !== 'server') throw new Error('Server Item requires Server ownership.');
    const native = this.dataRoot
      ? item.type === 'user-input-response'
        ? readNativeTurnHistory(this.nativeScope(item.owner), item.turnId)
        : readNativeTurnWriteHead(this.nativeScope(item.owner), item.turnId, item.id)
      : undefined;
    const turn = native?.turn ?? this.getServerTurn(item.threadId, item.turnId);
    if (turn.threadId !== item.threadId) throw new Error('Server Item Turn lineage mismatch.');
    const existing = turn.items.find((value) => value.id === item.id);
    if (this.items.has(item.id)) throw new Error(`Item already exists: ${item.id}`);
    if (existing) assertServerItemRevision(existing, item);
    if (isSealedTurnTerminal(turn.status)) {
      if (existing && alreadyDecidedPublicationBytesEqual(existing, item)) return existing;
      if (admission?.category !== 'already-decided-publication' || existing)
        throw terminalTurnWriteRejected(turn.id);
    }
    if (this.dataRoot) return this.persistNativeItem(item, native!, admission);
    const updatedTurn = TurnSchema.parse({
      ...turn,
      items: existing
        ? turn.items.map((candidate) => (candidate.id === item.id ? item : candidate))
        : [...turn.items, item],
    });
    this.serverItems.set(item.id, item);
    this.serverTurns.set(turn.id, updatedTurn);
    return item;
  }

  /** Reads an Item within Server history after Server authority admission. */
  public getServerItemById(itemId: string): Item {
    if (this.dataRoot) {
      const lineage = this.findNativeOwner('item', itemId);
      if (lineage?.owner.kind === 'server' && lineage.turnId) {
        const item = this.getServerTurnById(lineage.turnId).items.find(
          (item) => item.id === itemId
        );
        if (item) return item;
      }
      throw new StoreRecordNotFoundError(`Server Item not found: ${itemId}`);
    }
    const item = this.serverItems.get(itemId);
    if (!item) throw new StoreRecordNotFoundError(`Server Item not found: ${itemId}`);
    return item;
  }

  /** Updates a Server Item through the same immutable identity and append boundary as creation. */
  public async updateServerItem(
    ...args: Parameters<FsStore['updateServerItemPublication']>
  ): Promise<Item> {
    const item = this.getServerItemById(args[0]);
    return this.publishTurn({ kind: 'server' }, [item.turnId], args, (owned) =>
      this.updateServerItemPublication(...owned)
    );
  }

  /** Applies the original checks inside the admitted same-Turn boundary. */
  private async updateServerItemPublication(itemId: string, input: Partial<Item>): Promise<Item> {
    const item = this.getServerItemById(itemId);
    const native = this.dataRoot
      ? readNativeTurnHistory(this.nativeScope({ kind: 'server' }), item.turnId)
      : undefined;
    const current = native?.turn.items.find((candidate) => candidate.id === itemId) ?? item;
    const updated = ItemSchema.parse({ ...StoredItemPayloadV1Schema.parse(current), ...input });
    assertServerItemRevision(current, updated);
    return this.dataRoot
      ? this.persistNativeItem(updated, native!)
      : this.createServerItemPublication(updated);
  }

  /** Publishes an existing transcript event family under a Server Turn without a Workspace selector. */
  public async persistServerTurnEvent(
    ...args: Parameters<FsStore['persistServerTurnEventPublication']>
  ): Promise<ServerTurnEventEnvelope> {
    return this.publishTurn({ kind: 'server' }, [args[0]], args, (owned) =>
      this.persistServerTurnEventPublication(...owned)
    );
  }

  /** Applies the original checks inside the admitted same-Turn boundary. */
  private async persistServerTurnEventPublication(
    turnId: string,
    event: ServerTurnEventInput,
    admission?: AlreadyDecidedPublicationAdmission
  ): Promise<ServerTurnEventEnvelope> {
    const itemId =
      'item' in event.data
        ? event.data.item.id
        : 'itemId' in event.data
          ? event.data.itemId
          : undefined;
    const native = this.dataRoot
      ? readNativeTurnWriteHead(this.nativeScope({ kind: 'server' }), turnId, itemId)
      : undefined;
    const turn = native?.turn ?? this.getServerTurnById(turnId);
    const events =
      native && !isSealedTurnTerminal(turn.status) ? [] : this.getServerTurnTranscript(turnId);
    const stream = { sequence: native?.eventSequence ?? events.at(-1)?.sequence ?? 0, events };
    const envelope = ServerTurnEventEnvelopeSchema.parse({
      ...event,
      owner: { kind: 'server' },
      protocolVersion: PROTOCOL_VERSION,
      requestId: event.requestId ?? null,
      sequence: stream.sequence + 1,
      timestamp: now(),
    });
    assertServerTurnEventLineage(envelope, turn);
    if (isSealedTurnTerminal(turn.status)) {
      const existing = stream.events.find(
        (candidate) =>
          candidate.event === envelope.event &&
          candidate.requestId === envelope.requestId &&
          alreadyDecidedPublicationBytesEqual(candidate.data, envelope.data)
      );
      if (existing) {
        this.acknowledgedTurnEvents.set(existing, structuredClone(existing));
        return existing;
      }
      const terminalSnapshot =
        envelope.data.type === 'turn-completed' &&
        stopReasonMatchesSealedStatus(envelope.data.stopReason, turn.status) &&
        alreadyDecidedPublicationBytesEqual(envelope.data.turn, turn);
      const decidedItemSnapshot =
        admission?.category === 'already-decided-publication' &&
        (envelope.data.type === 'item-created' || envelope.data.type === 'item-completed') &&
        alreadyDecidedPublicationBytesEqual(
          turn.items.find((item) => 'item' in envelope.data && item.id === envelope.data.item.id),
          envelope.data.item
        );
      if (!terminalSnapshot && !decidedItemSnapshot) throw terminalTurnWriteRejected(turn.id);
    }
    if (this.dataRoot) {
      const scope = this.nativeScope({ kind: 'server' });
      const previous = { revision: native!.revision, record: native!.metadata };
      const content = await prepareRetainedProductJson(
        scope.contentMount,
        scope.owner,
        join(dirname(dirname(scope.path)), 'runtime', 'staging'),
        writeRetainedV1(envelope)
      );
      const entries: ControlProductEntry[] = [
        { kind: 'event', turnId, sequence: envelope.sequence, expectedRevision: 0, ...content },
      ];
      if (isSealedTurnTerminal(turn.status))
        await this.writeNativePublication(scope, native!, entries, 'already-decided-publication');
      else
        await this.writeNativeProducts(
          scope,
          [{ kind: 'turn', expectedRevision: previous.revision, record: previous.record }],
          entries
        );
    } else {
      const state = this.serverTurnStream(turnId);
      state.sequence = envelope.sequence;
      state.events.push(envelope);
      if (state.events.length > TURN_STREAM_EVENT_WINDOW_SIZE) state.events.shift();
    }
    this.acknowledgedTurnEvents.set(envelope, structuredClone(envelope));
    return envelope;
  }

  /** Delivers a proved durable Server event without introducing an await into a notification tail. */
  public emitServerTurnEvent(
    turnId: string,
    envelope: ServerTurnEventEnvelope
  ): ServerTurnEventEnvelope {
    const committed = this.acknowledgedTurnEvents.get(envelope);
    if (
      !committed ||
      !('owner' in committed) ||
      committed.owner.kind !== 'server' ||
      committed.turnId !== turnId ||
      !alreadyDecidedPublicationBytesEqual(committed, envelope)
    )
      throw new Error('Server notification requires its exact acknowledged native event.');
    for (const listener of this.serverTurnStream(turnId).listeners)
      listener(structuredClone(envelope));
    return envelope;
  }

  /** Returns the complete canonical Server transcript after current Server authority admission. */
  public getServerTurnTranscript(turnId: string): ServerTurnEventEnvelope[] {
    const turn = this.getServerTurnById(turnId);
    return this.dataRoot
      ? readServerTurnEvents(this.dataRoot, turn).map((event) =>
          ServerTurnEventEnvelopeSchema.parse(StoredServerEventPayloadV1Schema.parse(event))
        )
      : [...this.serverTurnStream(turnId).events];
  }

  /** Subscribes to the existing in-process Server Turn stream after Server authority admission. */
  public addServerTurnListener(
    turnId: string,
    listener: (event: ServerTurnEventEnvelope) => void
  ): () => void {
    this.getServerTurnById(turnId);
    const listeners = this.serverTurnStream(turnId).listeners;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /** Reads committed native Thread metadata without migration, pruning or a file/cache fallback. */
  public listThreads(workspaceId: string): Thread[] {
    const steps = this.listThreadsSteps(workspaceId);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  /** Shares the original owner read in released page/proof contributions for one admitted call. */
  public *listThreadsSteps(workspaceId: string): Generator<void, Thread[], void> {
    this.assertWorkspacePublicationAcknowledged(workspaceId);
    if (!this.dataRoot)
      return structuredClone(
        [...this.threads.values()].filter(
          (thread) => workspaceIdForOwner(thread.owner) === workspaceId
        )
      );
    const result: Thread[] = [];
    for (const page of readNativeProductPages(
      this.nativeScope({ kind: 'workspace', workspaceId }),
      'thread'
    )) {
      result.push(...page.map((row) => ThreadSchema.parse(row.record)));
      yield;
    }
    return result;
  }

  /** Creates formal shared work by default; conversation entrypoints supply the authenticated private audience explicitly. */
  public async createThread(
    workspaceId: string,
    title: string,
    threadId?: string,
    entryPath: Thread['entryPath'] = 'conversation',
    audience?: {
      visibility: Thread['visibility'];
      privateOwnerUserId?: string;
      threadSource?: Thread['threadSource'];
      parentThreadId?: string;
    },
    admission?: Pick<ControlAdmission, 'receipt' | 'audit'>
  ): Promise<Thread> {
    const id = threadId ?? allocateEntityId('th');
    if (
      this.dataRoot
        ? this.findNativeOwner('thread', id)
        : this.threads.has(id) || this.serverThreads.has(id)
    ) {
      throw new Error(`Thread already exists: ${id}`);
    }
    if (!audience && entryPath === 'administration')
      throw new Error('Private Thread creation requires its explicit canonical User audience.');
    audience ??= { visibility: 'workspace' };
    if (
      this.getWorkspace(workspaceId).kind === 'personal' &&
      audience.visibility === 'private' &&
      workspaceId !== quickChatWorkspaceIdForUser(audience.privateOwnerUserId ?? '', this.dataRoot)
    ) {
      throw new Error('Personal Workspace private Threads require their owner.');
    }
    if (audience.parentThreadId === id)
      throw new Error('A receiving Thread must differ from its parent.');
    const thread = ThreadSchema.parse({
      id,
      name: title,
      preview: title,
      status: 'active',
      entryPath,
      threadSource: 'conversation',
      ...audience,
      owner: { kind: 'workspace', workspaceId },
      createdAt: now(),
      updatedAt: now(),
    });
    if (this.dataRoot) {
      const scope = this.nativeScope({ kind: 'workspace', workspaceId });
      const result = await this.writeNativeProducts(
        scope,
        [{ kind: 'thread', expectedRevision: 0, record: writeRetainedV1(thread) }],
        [],
        admission
      );
      // Private command admission can select existing history with this same ID without writing it.
      if (
        admission?.receipt.command === 'thread.create' &&
        thread.visibility === 'private' &&
        thread.entryPath === 'conversation'
      )
        return this.getThread(workspaceId, result?.response.id ?? thread.id);
      return this.acknowledgedThreadResult(workspaceId, thread, result);
    }
    const threads = [...this.listThreads(workspaceId), thread];
    const workspace: WorkspaceRecord = {
      ...this.getWorkspace(workspaceId),
      counts: {
        threadCount: threads.length,
        artifactCount: this.listArtifacts(workspaceId).length,
        knowledgeEntryCount: this.getWorkspaceResources(workspaceId).knowledge.length,
      },
      updatedAt: now(),
    };
    this.threads.set(thread.id, thread);
    this.workspaces.set(workspaceId, workspace);
    return thread;
  }

  /**
   * Update one thread's product-visible metadata.
   *
   * @param workspaceId Workspace that owns the thread.
   * @param threadId Thread to update.
   * @param input Thread metadata patch.
   * @param admission Original command receipt and admitted Audit, when this is a command rather than a lifecycle mutation.
   * @param precondition When set, the same record read must still be this active title. A mismatch throws and does not write.
   * @returns Committed Thread after native acknowledgement, including the original response's resource on replay.
   */
  public async updateThread(
    workspaceId: string,
    threadId: string,
    input: Partial<Pick<Thread, 'name' | 'status'>>,
    admission?: Pick<ControlAdmission, 'receipt' | 'audit'>,
    precondition?: ThreadUpdatePrecondition
  ): Promise<Thread> {
    if ('owner' in input) throw new Error('Thread update cannot change field: owner');
    if (this.dataRoot) {
      const scope = this.nativeScope({ kind: 'workspace', workspaceId });
      const previous = readNativeProduct(scope, 'thread', threadId);
      if (!previous) throw new StoreRecordNotFoundError(`Thread not found: ${threadId}`);
      assertThreadUpdatePrecondition(previous.record, precondition);
      const updated = ThreadSchema.parse({
        ...previous.record,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updatedAt: now(),
      });
      const result = await this.writeNativeProducts(
        scope,
        [{ kind: 'thread', expectedRevision: previous.revision, record: writeRetainedV1(updated) }],
        [],
        admission
      );
      return this.acknowledgedThreadResult(workspaceId, updated, result);
    }
    const thread = this.getThread(workspaceId, threadId);
    assertThreadUpdatePrecondition(thread, precondition);
    const updated: Thread = {
      ...thread,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: now(),
    };
    this.threads.set(threadId, updated);
    return updated;
  }

  /**
   * Archive one thread.
   *
   * @param workspaceId Workspace that owns the thread.
   * @param threadId Thread to archive.
   * @returns Archived thread.
   */
  public archiveThread(workspaceId: string, threadId: string): Promise<Thread> {
    return this.updateThread(workspaceId, threadId, { status: 'archived' });
  }

  /** Returns this write's parsed record after acknowledgement and current checks, preserving native selection and replay. */
  private acknowledgedThreadResult(
    workspaceId: string,
    candidate: Thread,
    result: ControlAdmissionResult | undefined
  ): Thread {
    const selectedId = result?.response.id ?? candidate.id;
    const current = this.readThreadRecord(workspaceId, selectedId);
    return result?.replayed || selectedId !== candidate.id
      ? ThreadSchema.parse(current)
      : candidate;
  }

  /** Reads the committed native Thread in its actual scope; no startup reconstruction or mutable file is authoritative. */
  public getThread(workspaceId: string, threadId: string): Thread {
    return ThreadSchema.parse(this.readThreadRecord(workspaceId, threadId));
  }

  /** Reads current Thread metadata with its unchanged native admission, owner and physical refusal checks. */
  private readThreadRecord(workspaceId: string, threadId: string): Thread {
    this.assertWorkspacePublicationAcknowledged(workspaceId);
    let thread = this.threads.get(threadId);
    if (this.dataRoot) {
      try {
        const scope = this.nativeScope({ kind: 'workspace', workspaceId });
        thread = readNativeProduct(
          scope,
          'thread',
          threadId,
          scope.sqlite
            ? undefined
            : getWorkspaceProductReadHandle(scope.path, { kind: 'workspace', workspaceId })
        )?.record as Thread | undefined;
      } catch (error) {
        if (
          !lstatSync(this.workspaceRootPath(workspaceId), { throwIfNoEntry: false })?.isDirectory()
        ) {
          // Only an unpublished parent is absence; missing registered authority still refuses recovery.
          try {
            this.getWorkspace(workspaceId);
          } catch (workspaceError) {
            if (!(workspaceError instanceof StoreRecordNotFoundError)) throw workspaceError;
            throw new StoreRecordNotFoundError(`Thread not found: ${threadId}`);
          }
        }
        throw error;
      }
    }
    if (!thread || thread.owner.kind !== 'workspace' || thread.owner.workspaceId !== workspaceId)
      throw new StoreRecordNotFoundError(`Thread not found: ${threadId}`);
    return thread;
  }

  /**
   * Creates one running turn and updates the owning thread preview.
   *
   * @param workspaceId Workspace that owns the turn.
   * @param threadId Thread that owns the turn.
   * @param input User or scheduler input used for the thread preview.
   * @param triggerActor Exact actor whose accepted action created the Turn.
   * @param configVersion Runtime config version captured for the turn.
   * @param options Optional turn creation controls, including the admission-time capture pair.
   * @returns Created turn.
   * @throws Error when the requested turn id already exists or file publication fails; retained files remain intact.
   */
  public async createTurn(...args: Parameters<FsStore['createTurnPublication']>): Promise<Turn> {
    const release = this.enterWorkspaceMutation(args[0]);
    return this.createTurnPublication(...args).finally(release);
  }

  /** Prepares and publishes one Turn while its common admission remains held. */
  private async createTurnPublication(
    workspaceId: string,
    threadId: string,
    input: string,
    triggerActor: ActorRef,
    configVersion: number | null = null,
    options: CreateTurnOptions = {}
  ): Promise<Turn> {
    const timestamp = options.startedAt ?? now();
    const turnId = options.turnId ?? allocateEntityId('tu');

    if (
      this.dataRoot
        ? this.findNativeOwner('turn', turnId)
        : this.turns.has(turnId) || this.serverTurns.has(turnId)
    ) {
      throw new Error(`Turn already exists: ${turnId}`);
    }

    const thread = this.getThread(workspaceId, threadId);
    const turn = TurnSchema.parse({
      id: turnId,
      owner: { kind: 'workspace', workspaceId },
      threadId,
      triggerActor,
      items: [],
      status: options.status ?? 'running',
      error: null,
      configVersion,
      startedAt: timestamp,
      completedAt: isSealedTurnTerminal(options.status ?? 'running') ? timestamp : null,
      durationMs: isSealedTurnTerminal(options.status ?? 'running') ? 0 : null,
      ...(options.internalExecution !== undefined
        ? { internalExecution: options.internalExecution }
        : {}),
      ...(options.fileInputs?.length ? { fileInputs: options.fileInputs } : {}),
      ...(options.reasoningEffort !== undefined
        ? { reasoningEffort: options.reasoningEffort }
        : {}),
      ...(options.skillSelections !== undefined
        ? { skillSelections: options.skillSelections }
        : {}),
      ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
      ...(options.agentSessionId !== undefined ? { agentSessionId: options.agentSessionId } : {}),
      ...(options.triggerSource !== undefined ? { triggerSource: options.triggerSource } : {}),
    });
    if (options.fileInputs?.length) options.assertFileInputAdmission?.();
    if (this.dataRoot) {
      const scope = this.nativeScope({ kind: 'workspace', workspaceId });
      const previousThread = readNativeProduct(scope, 'thread', threadId)!;
      if (options.fileInputs?.length) {
        if (!options.fileWriteAdmission)
          throw new Error('File Turn publication admission is unavailable.');
        withCanonicalFileWriteAdmission(options.fileWriteAdmission, () =>
          publishTurnFileInputs(this.workspaceRootPath(workspaceId), turn, options.filePayloadPaths)
        );
      }
      const pendingAdmission = await this.turnAdmissionHooks?.prepareAdmission?.(
        turn,
        options.executorKind
      );
      const pendingEntries = await this.prepareNativeItems(scope, pendingAdmission?.items ?? []);
      let commandAdmission: Pick<ControlAdmission, 'receipt' | 'audit'> | undefined;
      if (options.commandReceipt) {
        const { responseKind, ...receipt } = options.commandReceipt;
        const response = options.commandReceiptResponse ?? { kind: responseKind, id: turn.id };
        const conversation = response.conversationMetadata;
        const selectedWorker =
          receipt.command === 'conversation.submit' &&
          conversation?.resultKind === 'worker-turn' &&
          conversation.downstream?.kind === 'task' &&
          conversation.downstream.turnId === turn.id &&
          conversation.receivingWorkspaceId === workspaceId &&
          conversation.receivingThreadId === threadId &&
          typeof receipt.scope.threadId === 'string' &&
          readNativeProduct(scope, 'thread', receipt.scope.threadId) !== undefined;
        if (
          responseKind !== 'turn' ||
          response.kind !== 'turn' ||
          response.id !== turn.id ||
          receipt.scope.workspaceId !== workspaceId ||
          (receipt.command === 'conversation.submit'
            ? !selectedWorker
            : receipt.scope.threadId !== threadId || conversation !== undefined)
        )
          throw new Error('Turn admission requires its exact original command response and scope.');
        commandAdmission = {
          receipt: ControlAdmissionSchema.shape.receipt.parse({
            ...receipt,
            response,
          }),
          audit: ControlAdmissionSchema.shape.audit.parse(
            prepareAuditEvent({
              workspaceId,
              threadId,
              turnId: turn.id,
              requestId: receipt.requestId,
              actor: turn.triggerActor,
              category: 'command',
              action: receipt.command,
              resource: `turn:${turn.id}`,
              outcome: 'succeeded',
              summary: 'Turn admitted.',
              now: new Date(receipt.createdAt),
            })
          ),
        };
      }
      if (isSealedTurnTerminal(turn.status)) {
        await this.createNativeTerminalTurn(
          scope,
          turn,
          options.captureCoverage ?? this.liveCaptureCoverage,
          [
            {
              kind: 'thread',
              expectedRevision: previousThread.revision,
              record: writeRetainedV1({
                ...previousThread.record,
                preview: input,
                updatedAt: timestamp,
              }),
            },
          ],
          pendingEntries,
          pendingAdmission?.pending
        );
        return this.getTurnById(turn.id);
      }
      await this.writeNativeProducts(
        scope,
        [
          {
            kind: 'thread',
            expectedRevision: previousThread.revision,
            record: writeRetainedV1({
              ...previousThread.record,
              preview: input,
              updatedAt: timestamp,
            }),
          },
          {
            kind: 'turn',
            expectedRevision: 0,
            record: writeRetainedV1({
              ...turn,
              items: [],
              captureCoverage: options.captureCoverage ?? this.liveCaptureCoverage,
            }),
          },
        ],
        pendingEntries,
        commandAdmission,
        undefined,
        pendingAdmission?.pending
      );
      if (options.executorKind) this.turnExecutors.set(turn.id, options.executorKind);
      this.turnStream(turn.id);
      if (!this.turnAdmissionHooks?.prepareAdmission)
        await this.turnAdmissionHooks?.onAdmitted?.(this.getTurn(workspaceId, threadId, turn.id));
      return this.getTurn(workspaceId, threadId, turn.id);
    }
    this.turns.set(turn.id, turn);
    if (options.executorKind) this.turnExecutors.set(turn.id, options.executorKind);
    this.threads.set(threadId, {
      ...thread,
      preview: input,
      updatedAt: timestamp,
    });
    this.streams.set(turn.id, {
      sequence: 0,
      events: [],
      listeners: new Set(),
    });
    this.turnCaptureCoverage.set(turn.id, options.captureCoverage ?? this.liveCaptureCoverage);
    await this.turnAdmissionHooks?.onAdmitted?.(turn);
    return this.getTurnById(turn.id);
  }

  /**
   * Registers admission and terminal hooks for pending-request delivery.
   *
   * @param hooks Hooks invoked by Turn admission and the first terminal transition.
   */
  public setTurnAdmissionHooks(hooks: TurnAdmissionHooks | null): void {
    this.turnAdmissionHooks = hooks;
  }

  /**
   * Returns the executor declared when the Turn was admitted.
   *
   * @param turnId Turn id.
   * @returns Executor, or null when admission did not declare one.
   */
  public getTurnExecutor(turnId: string): 'worker' | 'assistant' | 'coordinator' | 'person' | null {
    this.assertTurnPublicationAcknowledged(turnId);
    return this.turnExecutors.get(turnId) ?? null;
  }

  /**
   * Sets the live capture-coverage policy used by later Turn admission.
   *
   * @param binding Resolved pair to snapshot onto the next admitted Turn.
   */
  public setLiveCaptureCoverage(binding: CaptureCoverageBinding): void {
    this.liveCaptureCoverage = binding;
  }

  /**
   * Returns the live capture-coverage policy used by later Turn admission.
   *
   * @returns Current live pair.
   */
  public getLiveCaptureCoverage(): CaptureCoverageBinding {
    return structuredClone(this.liveCaptureCoverage);
  }

  /**
   * Returns the admission-time capture pair recorded for one Turn.
   *
   * @param turnId Turn whose historical pair should be read.
   * @returns Recorded pair, or null when that Turn was never recorded.
   */
  public getTurnCaptureCoverage(turnId: string): CaptureCoverageBinding | null {
    if (this.dataRoot) {
      const lineage = this.findNativeOwner('turn', turnId);
      if (!lineage) return null;
      const record = readNativeProduct(this.nativeScope(lineage.owner), 'turn', turnId)?.record;
      return record?.captureCoverage
        ? CaptureCoverageBindingSchema.parse(record.captureCoverage)
        : null;
    }
    return this.turnCaptureCoverage.get(turnId) ?? null;
  }

  public getTurn(workspaceId: string, threadId: string, turnId: string): Turn {
    const steps = this.getTurnSteps(workspaceId, threadId, turnId);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  /** Shares the original owner read in released page/proof contributions for one admitted call. */
  public *getTurnSteps(
    workspaceId: string,
    threadId: string,
    turnId: string
  ): Generator<void, Turn, void> {
    this.assertWorkspacePublicationAcknowledged(workspaceId);
    const owner = { kind: 'workspace', workspaceId } as const;
    const scope = this.dataRoot ? this.nativeScope(owner) : undefined;
    // Borrow only the existing connection; every native snapshot and immutable proof still ends normally.
    const readScope =
      scope && !scope.sqlite
        ? { ...scope, sqlite: getWorkspaceProductReadHandle(scope.path, owner).sqlite }
        : scope;
    const turn = readScope
      ? (yield* readNativeTurnHistorySteps(readScope, turnId))?.turn
      : this.turns.get(turnId);
    if (
      !turn ||
      turn.owner.kind !== 'workspace' ||
      turn.owner.workspaceId !== workspaceId ||
      turn.threadId !== threadId
    )
      throw new StoreRecordNotFoundError(`Turn not found: ${turnId}`);
    return TurnSchema.parse(TurnReaderSchema.parse(turn));
  }

  /** Reads current Turn metadata using expected selectors; callers still check actual owner and Thread. */
  public getTurnMetadata(
    workspaceId: string,
    threadId: string,
    turnId: string
  ): Omit<Turn, 'items'> {
    const owner = { kind: 'workspace', workspaceId } as const;
    const scope = this.dataRoot ? this.nativeScope(owner) : undefined;
    const record = scope
      ? readNativeProduct(
          scope,
          'turn',
          turnId,
          scope.sqlite ? undefined : getWorkspaceProductReadHandle(scope.path, owner)
        )?.record
      : this.turns.get(turnId);
    if (
      !record ||
      workspaceIdForOwner(record.owner as Turn['owner']) !== workspaceId ||
      record.threadId !== threadId
    ) {
      // A selector miss keeps the original opaque lookup and refusal classification.
      const { items: _items, ...metadata } = this.getTurnById(turnId);
      return metadata;
    }
    const { items: _items, ...metadata } = TurnReaderSchema.parse({ ...record, items: [] });
    return metadata;
  }

  /** Returns only the opaque Turn's canonical Workspace and Thread selectors before content admission. */
  public getTurnLineage(turnId: string): { workspaceId: string; threadId: string } | null {
    if (this.dataRoot) {
      const lineage = this.findNativeOwner('turn', turnId);
      return lineage?.owner.kind === 'workspace' && lineage.threadId
        ? { workspaceId: lineage.owner.workspaceId, threadId: lineage.threadId }
        : null;
    }
    const turn = this.turns.get(turnId);
    return turn ? { workspaceId: workspaceIdForOwner(turn.owner), threadId: turn.threadId } : null;
  }

  public getTurnById(turnId: string): Turn {
    const steps = this.getTurnByIdSteps(turnId);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  /** Shares the original owner read in released page/proof contributions for one admitted call. */
  public *getTurnByIdSteps(turnId: string): Generator<void, Turn, void> {
    if (this.dataRoot) {
      const selected = yield* this.findNativeOwnerSteps('turn', turnId);
      const lineage =
        selected?.owner.kind === 'workspace' && selected.threadId
          ? { workspaceId: selected.owner.workspaceId, threadId: selected.threadId }
          : null;
      if (!lineage) {
        // An opaque miss cannot prove absence while part of its search domain is quarantined.
        // Never open that authority to distinguish absence; known healthy owners still resolve above.
        for (const failure of this.suppliedScopeRefusals ?? scopeAdmissionFailures(this.dataRoot))
          if (failure.scope === 'workspace')
            assertScopeAdmitted(this.dataRoot, 'workspace', failure.id, this.suppliedScopeRefusals);
        throw new StoreRecordNotFoundError(`Turn not found: ${turnId}`);
      }
      return yield* this.getTurnSteps(lineage.workspaceId, lineage.threadId, turnId);
    }
    const turn = this.turns.get(turnId);
    if (!turn) throw new StoreRecordNotFoundError(`Turn not found: ${turnId}`);
    return turn;
  }

  /**
   * List turns for one thread in durable admission order.
   *
   * @param workspaceId Workspace that owns the thread.
   * @param threadId Thread whose turns should be returned.
   * @returns Ordered thread turns.
   */
  public listThreadTurns(workspaceId: string, threadId: string): Turn[] {
    const steps = this.listThreadTurnsSteps(workspaceId, threadId);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  /** Shares the original owner read in released page/proof contributions for one admitted call. */
  public *listThreadTurnsSteps(
    workspaceId: string,
    threadId: string
  ): Generator<void, Turn[], void> {
    this.getThread(workspaceId, threadId);
    const turns: Turn[] = [];
    if (this.dataRoot) {
      const selected: string[] = [];
      for (const page of readNativeThreadTurnPages(
        this.nativeScope({ kind: 'workspace', workspaceId }),
        threadId
      )) {
        for (const row of page) selected.push(row.record.id as string);
        yield;
      }
      for (const id of selected) turns.push(yield* this.getTurnSteps(workspaceId, threadId, id));
    } else
      turns.push(
        ...[...this.turns.values()].filter(
          (turn) => workspaceIdForOwner(turn.owner) === workspaceId && turn.threadId === threadId
        )
      );
    return turns;
  }

  /**
   * Updates a turn and revalidates the protocol record.
   *
   * @param args Turn identity, metadata patch and optional journal, receipt or terminal admission.
   * @returns Updated turn after protocol validation.
   * @throws Error when the turn does not exist, the merged turn violates the protocol schema, or a post-terminal write is not admitted.
   */
  public async updateTurn(...args: Parameters<FsStore['updateTurnPublication']>): Promise<Turn> {
    const owner = this.getTurnById(args[0]).owner;
    // Journal intent timestamps and typed doubles use their existing lossless codec.
    const { journalIntents, ...admission } = args[2] ?? {};
    const journal = journalIntents?.map(encodeExecutionJournalValue);
    const input = [args[0], args[1], args[2] ? admission : undefined, journal] as const;
    return this.publishTurnMutation(owner, args[0], input, (owned) =>
      this.updateTurnPublication(
        owned[0],
        owned[1],
        owned[2]
          ? {
              ...owned[2],
              ...(owned[3] ? { journalIntents: owned[3].map(decodeExecutionJournalIntent) } : {}),
            }
          : undefined
      )
    );
  }

  /** Applies the original checks inside the admitted same-Turn boundary. */
  private async updateTurnPublication(
    turnId: string,
    input: Partial<
      Pick<
        Turn,
        | 'agentId'
        | 'agentProfileId'
        | 'agentSessionId'
        | 'completedAt'
        | 'configVersion'
        | 'durationMs'
        | 'error'
        | 'status'
        | 'triggerSource'
        | 'internalExecution'
      >
    >,
    admission?: (TerminalTurnWriteAdmission | { category?: never }) & {
      journalIntents?: readonly ExecutionJournalIntent[];
      /** Original command receipt and local Audit acknowledged with this live Turn snapshot. */
      commandAdmission?: Pick<ControlAdmission, 'receipt' | 'audit'>;
    }
  ): Promise<Turn | { turn: Turn; notify: boolean }> {
    this.assertTurnPublicationAcknowledged(turnId);
    const lineage = this.dataRoot ? this.getTurnLineage(turnId) : null;
    const native = lineage
      ? readNativeTurnHistory(
          this.nativeScope({ kind: 'workspace', workspaceId: lineage.workspaceId }),
          turnId
        )
      : undefined;
    const turn = native?.turn ?? this.getTurnById(turnId);

    if (!turn) {
      throw new StoreRecordNotFoundError(`Turn not found: ${turnId}`);
    }

    const unsupportedField = Object.keys(input).find(
      (field) =>
        ![
          'agentId',
          'agentProfileId',
          'agentSessionId',
          'completedAt',
          'configVersion',
          'durationMs',
          'error',
          'status',
          'triggerSource',
          'internalExecution',
        ].includes(field)
    );
    if (unsupportedField) {
      throw new Error(`Turn update cannot change field: ${unsupportedField}`);
    }

    const updated = TurnSchema.parse({
      ...TurnReaderSchema.parse(turn),
      ...input,
      durationMs:
        (input.completedAt ?? turn.completedAt) && turn.startedAt
          ? Math.max(
              0,
              new Date(input.completedAt ?? turn.completedAt ?? now()).getTime() -
                new Date(turn.startedAt).getTime()
            )
          : (input.durationMs ?? turn.durationMs),
    });
    if (isSealedTurnTerminal(turn.status)) {
      if (alreadyDecidedPublicationBytesEqual(turn, updated)) {
        return turn;
      }
      if (
        admission?.category === 'already-decided-publication' &&
        !decidedTurnFieldsConflict(turn, updated)
      ) {
        // Fill-only completion of an already-decided terminal Turn.
      } else if (admission?.category === 'already-decided-publication') {
        throw terminalTurnPublicationConflict(turnId);
      } else {
        throw terminalTurnWriteRejected(turnId);
      }
    }
    if (this.dataRoot) {
      const scope = this.nativeScope(turn.owner);
      const previous = { revision: native!.revision, record: native!.metadata };
      if (isSealedTurnTerminal(updated.status)) return this.completeTurnPublication(turnId, input);
      await this.writeNativeProducts(
        scope,
        [
          {
            kind: 'turn',
            expectedRevision: previous.revision,
            record: writeRetainedV1({
              ...previous.record,
              ...input,
              durationMs: updated.durationMs,
              items: [],
            }),
          },
        ],
        [],
        admission?.commandAdmission,
        admission?.journalIntents
      );
      return this.getTurnById(turnId);
    }
    if (!isSealedTurnTerminal(turn.status) && isSealedTurnTerminal(updated.status))
      this.turnAdmissionHooks?.onTerminalFact?.(updated);
    this.turns.set(turnId, updated);
    if (updated.status === 'completed' && !turn.completedAt && updated.completedAt) {
      ensureTurnFeedback(this, updated, updated.agentId ?? null);
    }
    if (
      !isSealedTurnTerminal(turn.status) &&
      isSealedTurnTerminal(updated.status) &&
      this.terminalHookDepth < 8
    ) {
      this.terminalHookDepth += 1;
      try {
        this.turnAdmissionHooks?.onTerminal?.(updated);
      } finally {
        this.terminalHookDepth -= 1;
      }
    }
    return this.getTurnById(turnId);
  }

  /**
   * Commits the complete terminal snapshot through its immutable Workspace or Server owner.
   *
   * @param args Turn identity, terminal metadata patch and optional complete terminal tuple.
   * @returns The authoritative Turn after FULL COMMIT; notifications remain synchronous caller work.
   * @throws When lineage, terminal outcome or conditional native publication cannot be proved.
   */
  public async completeTurn(
    ...args: Parameters<FsStore['completeTurnPublication']>
  ): Promise<Turn> {
    const owner = this.dataRoot
      ? this.findNativeOwner('turn', args[0])?.owner
      : (this.serverTurns.get(args[0])?.owner ?? this.turns.get(args[0])?.owner);
    if (!owner) throw new StoreRecordNotFoundError(`Turn not found: ${args[0]}`);
    if (args[2] === undefined) args[2] = {};
    return this.publishTurnMutation(owner, args[0], args, (owned) =>
      this.completeTurnPublication(...owned)
    );
  }

  /** Applies the original checks inside the admitted same-Turn boundary. */
  private async completeTurnPublication(
    turnId: string,
    patch: Parameters<FsStore['updateTurn']>[1],
    publication: TerminalTurnPublication = {}
  ): Promise<{ turn: Turn; notify: boolean }> {
    const owner = this.dataRoot
      ? this.findNativeOwner('turn', turnId)?.owner
      : this.serverTurns.has(turnId)
        ? { kind: 'server' as const }
        : this.turns.get(turnId)?.owner;
    if (!owner) throw new StoreRecordNotFoundError(`Turn not found: ${turnId}`);
    const scope = this.dataRoot ? this.nativeScope(owner) : undefined;
    const history = scope ? readNativeTurnHistory(scope, turnId) : undefined;
    const before =
      history?.turn ??
      (owner.kind === 'server' ? this.getServerTurnById(turnId) : this.getTurnById(turnId));
    const completedAt = patch.completedAt ?? before.completedAt;
    const items = new Map(before.items.map((item) => [item.id, item]));
    for (const input of publication.items ?? []) {
      const item = ItemSchema.parse(input);
      if (
        !isDeepStrictEqual(item.owner, owner) ||
        item.threadId !== before.threadId ||
        item.turnId !== turnId
      )
        throw new Error('Terminal Item requires its exact Turn owner.');
      const previous = items.get(item.id);
      if (previous) assertImmutableItemAttribution(previous, item);
      items.set(item.id, item);
    }
    const turn = TurnSchema.parse({
      ...TurnReaderSchema.parse(before),
      ...patch,
      completedAt,
      durationMs:
        patch.durationMs !== undefined
          ? patch.durationMs
          : completedAt && before.startedAt
            ? Math.max(0, new Date(completedAt).getTime() - new Date(before.startedAt).getTime())
            : (patch.durationMs ?? before.durationMs),
      items: [...items.values()],
    });
    if (!isSealedTurnTerminal(turn.status) || !turn.completedAt)
      throw new Error('Terminal publication requires a decided outcome and completion timestamp.');
    const events =
      owner.kind === 'server'
        ? this.getServerTurnTranscript(turnId)
        : this.getTurnEventsForExport(turnId);
    const prior = events.find((event) => event.data.type === 'turn-completed');
    const precedingEvents = (publication.precedingEvents ?? []).map((draft, index, drafts) => {
      if (owner.kind !== 'workspace' || draft.data.type === 'turn-completed')
        throw new Error('Terminal preceding events require an existing Workspace projection.');
      const sequence = prior
        ? prior.sequence - drafts.length + index
        : (events.at(-1)?.sequence ?? 0) + index + 1;
      const envelope = SseEventEnvelopeSchema.parse({
        ...draft,
        protocolVersion: PROTOCOL_VERSION,
        timestamp: turn.completedAt,
        sequence,
        requestId: projectTurnEventRequestId(
          draft.requestId ?? publication.requestId,
          owner.workspaceId,
          turn.threadId
        ),
      });
      if (
        envelope.turnId !== turnId ||
        envelope.threadId !== turn.threadId ||
        envelope.workspaceId !== owner.workspaceId ||
        (prior &&
          !alreadyDecidedPublicationBytesEqual(
            events.find((event) => event.sequence === sequence),
            envelope
          ))
      )
        throw terminalTurnPublicationConflict(turnId);
      return envelope;
    });
    const stopReason =
      publication.stopReason ??
      (turn.status === 'completed' ? 'completed' : turn.status === 'failed' ? 'error' : 'aborted');
    const event =
      prior ??
      (owner.kind === 'server' ? ServerTurnEventEnvelopeSchema : SseEventEnvelopeSchema).parse({
        protocolVersion: PROTOCOL_VERSION,
        ...(owner.kind === 'server' ? { owner } : { workspaceId: owner.workspaceId }),
        threadId: turn.threadId,
        turnId,
        requestId:
          owner.kind === 'server'
            ? (publication.requestId ?? null)
            : projectTurnEventRequestId(publication.requestId, owner.workspaceId, turn.threadId),
        timestamp: turn.completedAt,
        sequence: (events.at(-1)?.sequence ?? 0) + precedingEvents.length + 1,
        event: 'turn.completed',
        data: { type: 'turn-completed', stopReason, turn },
      });
    if (
      prior &&
      (prior.data.type !== 'turn-completed' ||
        prior.data.stopReason !== stopReason ||
        !alreadyDecidedPublicationBytesEqual(prior.data.turn, turn))
    )
      throw terminalTurnPublicationConflict(turnId);
    if (scope) {
      const entries: ControlProductEntry[] = [];
      const revisions = readNativeProductEntries(scope, turnId, 'item');
      // Exact replay compares supplied Items with the decided snapshot, not a later display head.
      const retainedItems = prior && publication.execution ? turn.items : before.items;
      for (const item of publication.items ?? []) {
        const existing = retainedItems.find((candidate) => candidate.id === item.id);
        if (existing && alreadyDecidedPublicationBytesEqual(existing, item)) continue;
        const previous = revisions.filter((row) => row.id === item.id).at(-1);
        const content = await prepareRetainedProductJson(
          scope.contentMount,
          owner,
          join(dirname(dirname(scope.path)), 'runtime', 'staging'),
          writeRetainedV1(item)
        );
        entries.push({
          kind: 'item',
          turnId,
          sequence: revisions.length + entries.length + 1,
          expectedRevision: previous?.revision ?? 0,
          ...content,
        });
      }
      for (const terminalEvent of [...precedingEvents, event]) {
        let content: Pick<ControlProductEntry, 'content' | 'publication'>;
        if (prior) {
          // Replay retains each original immutable descriptor, including preceding projections.
          const reader = openControlStoreProductReadHandle(scope.path, owner);
          try {
            const entry = reader.entries(turnId, 'event', terminalEvent.sequence - 1, 1)[0];
            if (!entry || entry.sequence !== terminalEvent.sequence)
              throw terminalTurnPublicationConflict(turnId);
            content = { content: entry.content };
          } finally {
            reader.close();
          }
        } else {
          content = await prepareRetainedProductJson(
            scope.contentMount,
            owner,
            join(dirname(dirname(scope.path)), 'runtime', 'staging'),
            writeRetainedV1(terminalEvent)
          );
        }
        entries.push({
          kind: 'event',
          turnId,
          sequence: terminalEvent.sequence,
          expectedRevision: 0,
          ...content,
        });
      }
      if (prior && isSealedTurnTerminal(before.status) && publication.execution) {
        // Replay the original journal tuple, including omitted Items and preceding events.
        const reader = openControlStoreProductReadHandle(scope.path, owner);
        try {
          const step = reader.sqlite
            .prepare(
              "SELECT s.control_json FROM control_execution_steps s JOIN control_executions e ON e.id=s.execution_id WHERE e.id=? AND e.work_id=? AND e.phase IN ('closing','closed') AND s.step_id=? AND s.state='completed' AND json_extract(s.control_json,'$.kind')='terminal-publication'"
            )
            .get(publication.execution.executionId, turnId, publication.execution.terminalStepId) as
            | { control_json: string }
            | undefined;
          const refs: unknown = step && JSON.parse(step.control_json).outputRefs;
          if (
            !Array.isArray(refs) ||
            !refs.length ||
            refs.some((ref) => typeof ref !== 'string' || !ref)
          )
            throw terminalTurnPublicationConflict(turnId);
          // Repeated Item bytes are valid; select the newest revision matching the journal digest.
          const descriptor = reader.sqlite.prepare(
            "SELECT schema_version AS schemaVersion,kind,sequence,revision,content_json FROM control_product_entries WHERE kind IN ('item','event') AND turn_id=? AND json_extract(content_json,'$.reference.contentDigest')=? ORDER BY revision DESC,sequence DESC LIMIT 1"
          );
          const original = refs.map((digest) => {
            const row = descriptor.get(turnId, digest) as
              | {
                  schemaVersion: number;
                  kind: string;
                  sequence: number;
                  revision: number;
                  content_json: string;
                }
              | undefined;
            if (!row || row.schemaVersion !== 1) throw terminalTurnPublicationConflict(turnId);
            return ControlProductEntrySchema.parse({
              kind: row.kind,
              turnId,
              sequence: row.sequence,
              expectedRevision: row.revision - 1,
              content: JSON.parse(row.content_json),
            });
          });
          for (const entry of entries)
            if (!original.some((retained) => isDeepStrictEqual(retained, entry)))
              throw terminalTurnPublicationConflict(turnId);
          entries.splice(0, entries.length, ...original);
        } finally {
          reader.close();
        }
      }
      const client = getControlStoreWorkerClient();
      const database = `${owner.kind === 'server' ? 'core' : 'workspace'}:${scope.path}`;
      await client.open({
        database,
        path: scope.path,
        dataRoot: this.dataRoot!,
        create: false,
        initialize: owner.kind === 'server' ? 'core' : 'workspace',
        productOwner: owner,
        contentMount: scope.contentMount,
      });
      const products: ControlTerminalTransition['products'] = [];
      if (publication.agentSession) {
        const candidate = publication.agentSession;
        const current = readNativeProduct(scope, 'agent-session', candidate.id);
        if (
          owner.kind !== 'workspace' ||
          candidate.id !== turn.agentSessionId ||
          !current ||
          current.record.workspaceId !== owner.workspaceId ||
          current.record.threadId !== turn.threadId
        )
          throw new Error('Terminal Session projection requires the exact assigned Turn lineage.');
        products.push({
          kind: 'agent-session',
          expectedRevision: current.revision,
          record: writeRetainedV1(
            AgentSessionRecordSchema.parse({ ...current.record, ...candidate })
          ),
        });
      }
      await client.terminal(database, {
        owner,
        turn: {
          kind: 'turn',
          expectedRevision: history!.revision,
          record: writeRetainedV1({
            ...history!.metadata,
            ...patch,
            completedAt: turn.completedAt,
            durationMs: turn.durationMs,
            items: [],
          }),
        },
        products,
        entries,
        pending:
          owner.kind === 'workspace'
            ? [
                ...(publication.pending ?? []),
                ...(this.turnAdmissionHooks?.prepareTerminal?.(turn) ?? []),
              ]
            : [],
        reap: { reason: turn.status, inferredBy: 'native-terminal-publication' },
        evidence: publication.evidence ?? [],
        evidenceContent: publication.evidenceContent ?? [],
        command: publication.command ?? null,
        ...(publication.interruptCommand ? { interruptCommand: publication.interruptCommand } : {}),
        execution: publication.execution ?? null,
      });
    } else {
      for (const item of publication.items ?? []) {
        if (owner.kind === 'server') await this.createServerItem(item);
        else if (this.items.has(item.id)) await this.updateItem(item.id, item);
        else await this.createItem(item);
      }
      if (owner.kind === 'server') await this.updateServerTurn(turnId, patch);
      else await this.updateTurn(turnId, patch);
      if (!prior) {
        const stream =
          owner.kind === 'server' ? this.serverTurnStream(turnId) : this.turnStream(turnId);
        stream.sequence = event.sequence;
        stream.events.push(...([...precedingEvents, event] as never[]));
        if (stream.events.length > TURN_STREAM_EVENT_WINDOW_SIZE) stream.events.shift();
      }
    }
    // Feedback is a separate file owner and can publish only after native terminal acknowledgement.
    if (scope && owner.kind === 'workspace' && turn.status === 'completed')
      ensureTurnFeedback(this, turn, turn.agentId ?? null);
    for (const terminalEvent of [...precedingEvents, event])
      this.acknowledgedTurnEvents.set(terminalEvent, structuredClone(terminalEvent));
    return {
      turn: owner.kind === 'server' ? this.getServerTurnById(turnId) : this.getTurnById(turnId),
      notify: Boolean(scope && owner.kind === 'workspace' && !prior),
    };
  }

  /**
   * Returns the configured data root for file-backed operations.
   *
   * @returns Data root, or null for in-memory stores.
   */
  public getDataRoot(): string | null {
    return this.dataRoot;
  }

  /**
   * Creates or returns one Item, admitting post-terminal completion or display-projection create when declared.
   *
   * @param args Core-minted Item identity and payload, plus optional admitted post-terminal category; retained caller-chosen IDs enter through import admission.
   * @returns Stored Item.
   * @throws Error when lineage is invalid or a post-terminal write is not admitted.
   */
  public async createItem(...args: Parameters<FsStore['createItemPublication']>): Promise<Item> {
    const publish = () =>
      this.publishTurn(
        args[0].owner,
        [args[0].turnId],
        args,
        (owned) => this.createItemPublication(...owned),
        args[0].type === 'tool-call' && args[0].status !== 'in_progress'
          ? (args[0].causationId ?? undefined)
          : undefined,
        args[2] === RETAINED_PROGRESS_PUBLICATION &&
          args[0].type === 'status' &&
          args[0].owner.kind === 'workspace'
          ? { item: args[0], ...(args[1] && { category: args[1].category }) }
          : undefined
      );
    return this.dataRoot &&
      args[0].type === 'artifact-reference' &&
      args[0].owner.kind === 'workspace'
      ? this.protectArtifactReference(args[0].owner.workspaceId, args[0].artifactId, publish)
      : publish();
  }

  /** Applies the original checks inside the admitted same-Turn boundary. */
  private async createItemPublication(
    input: Item,
    admission?: TerminalTurnWriteAdmission,
    _progress?: typeof RETAINED_PROGRESS_PUBLICATION,
    mcpCall?: ControlMcpItemCall
  ): Promise<Item> {
    const item = ItemSchema.parse(input);
    if (item.owner.kind !== 'workspace')
      throw new Error('Workspace Item requires Workspace ownership.');
    if (this.serverItems.has(item.id)) throw new Error(`Item already exists: ${item.id}`);
    if (this.dataRoot) {
      const scope = this.nativeScope(item.owner);
      const client = getControlStoreWorkerClient();
      const database = `workspace:${scope.path}`;
      await client.open({
        database,
        path: scope.path,
        dataRoot: this.dataRoot,
        create: false,
        initialize: 'workspace',
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      });
      return client.appendItem(
        database,
        { item, ...(admission && { category: admission.category }) },
        mcpCall
      );
    }
    if (mcpCall) throw new Error('MCP Item settlement requires the native Workspace owner.');
    const turn = this.getTurn(item.owner.workspaceId, item.threadId, item.turnId);
    const existing = turn.items.find((value) => value.id === item.id);
    if (checkControlItemAppend(item, turn, existing, turn.items, admission?.category))
      return existing!;
    const updatedTurn = {
      ...turn,
      items: existing
        ? turn.items.map((candidate) => (candidate.id === item.id ? item : candidate))
        : [...turn.items, item],
    };
    this.itemRevisions.push(item);
    this.items.set(item.id, item);
    this.turns.set(item.turnId, updatedTurn);
    return item;
  }

  /**
   * Updates one Item, admitting a named display-projection refresh after the owning Turn is sealed.
   *
   * @param args Item identity, revision patch and optional admitted post-terminal category.
   * @returns Updated Item.
   * @throws Error when the Item does not exist, identity would change, or a post-terminal write is not admitted.
   */
  public async updateItem(...args: Parameters<FsStore['updateItemPublication']>): Promise<Item> {
    const item = this.workspaceItemById(args[0]);
    if (!item) throw new StoreRecordNotFoundError(`Item not found: ${args[0]}`);
    return this.publishTurn(item.owner, [item.turnId], args, (owned) =>
      this.updateItemPublication(...owned)
    );
  }

  /** Applies the original checks inside the admitted same-Turn boundary. */
  private async updateItemPublication(
    itemId: string,
    input: Partial<Item>,
    admission?: TerminalTurnWriteAdmission
  ): Promise<Item> {
    let item = this.workspaceItemById(itemId);

    if (!item) {
      throw new StoreRecordNotFoundError(`Item not found: ${itemId}`);
    }

    const native = this.dataRoot
      ? readNativeTurnHistory(this.nativeScope(item.owner), item.turnId)
      : undefined;
    const turn = native?.turn ?? this.getTurnById(item.turnId);
    const current = turn.items.find((candidate) => candidate.id === itemId);
    if (!current) throw new StoreRecordNotFoundError(`Item not found: ${itemId}`);
    item = StoredItemPayloadV1Schema.parse(current);
    let patch: Partial<Item> = input;
    if (isSealedTurnTerminal(turn.status)) {
      if (admission?.category === 'display-projection-refresh') {
        const unsupportedField = Object.keys(input).find(
          (field) => !DISPLAY_PROJECTION_REFRESH_FIELDS.some((allowed) => allowed === field)
        );
        if (unsupportedField) {
          throw terminalTurnWriteRejected(turn.id);
        }
        const recorded = item as unknown as Record<string, unknown>;
        const patchFields = input as unknown as Record<string, unknown>;
        const projection = {
          level: patchFields.level !== undefined ? patchFields.level : recorded.level,
          title: patchFields.title !== undefined ? patchFields.title : recorded.title,
          summary: patchFields.summary !== undefined ? patchFields.summary : recorded.summary,
        };
        if (displayProjectionFieldsEqual(item, projection)) {
          return item;
        }
        patch = {
          level: projection.level,
          title: projection.title,
          summary: projection.summary,
        } as Partial<Item>;
      } else if (admission?.category === 'already-decided-publication') {
        const candidate = ItemSchema.parse({ ...item, ...input });
        if (alreadyDecidedPublicationBytesEqual(item, candidate)) {
          return item;
        }
        throw terminalTurnPublicationConflict(turn.id);
      } else {
        throw terminalTurnWriteRejected(turn.id);
      }
    }

    const updated = ItemSchema.parse({ ...item, ...patch });
    if (
      updated.id !== item.id ||
      workspaceIdForOwner(updated.owner) !== workspaceIdForOwner(item.owner) ||
      updated.threadId !== item.threadId ||
      updated.turnId !== item.turnId ||
      updated.type !== item.type ||
      updated.createdAt !== item.createdAt
    ) {
      throw new Error(`Item immutable identity cannot change: ${itemId}`);
    }
    assertImmutableItemAttribution(item, updated);
    if (this.dataRoot) return this.persistNativeItem(updated, native!, admission);
    const updatedTurn = {
      ...turn,
      items: turn.items.map((candidate) => (candidate.id === itemId ? updated : candidate)),
    };

    this.itemRevisions.push(updated);
    this.items.set(itemId, updated);
    this.turns.set(item.turnId, updatedTurn);
    return updated;
  }

  /**
   * List durable items for one thread in chronological order.
   *
   * @param workspaceId Workspace that owns the thread.
   * @param threadId Thread whose item history should be returned.
   * @returns Ordered thread items.
   */
  public listThreadItems(workspaceId: string, threadId: string): Item[] {
    return this.listThreadTurns(workspaceId, threadId).flatMap((turn) => turn.items);
  }

  /** Runs one bounded timeline selection in the existing Thread owner's read snapshot. */
  public readThreadTimelineSnapshot<T>(
    workspaceId: string,
    threadId: string,
    read: (snapshot: ThreadTimelineSnapshot) => T
  ): T {
    this.getThread(workspaceId, threadId);
    if (this.dataRoot)
      return withNativeThreadTimelineSnapshot(
        this.nativeScope({ kind: 'workspace', workspaceId }),
        threadId,
        read
      );
    const turns = this.listThreadTurns(workspaceId, threadId);
    const metadata = turns.map((turn, index) => ({
      revision: 1,
      admissionOrder: index + 1,
      record: { ...turn, items: [] },
    }));
    const revisionCounts = new Map<string, number>();
    const sequenceCounts = new Map<string, number>();
    const revisions = this.itemRevisions
      .filter((item) => item.threadId === threadId)
      .map((item) => {
        const sequence = (sequenceCounts.get(item.turnId) ?? 0) + 1;
        const revision = (revisionCounts.get(item.id) ?? 0) + 1;
        sequenceCounts.set(item.turnId, sequence);
        revisionCounts.set(item.id, revision);
        return { item, sequence, revision };
      });
    const digestItem = (item: Item): Item | null =>
      Buffer.byteLength(JSON.stringify(writeRetainedV1(item))) > 65_536 ? null : item;
    const positions = turns.flatMap((turn, index) =>
      turn.items.map((item) => ({
        itemId: item.id,
        turnId: turn.id,
        sequence: revisions.find((entry) => entry.item.id === item.id)!.sequence,
        admissionOrder: index + 1,
      }))
    );
    return read({
      upperOrder: metadata.length,
      activeTurn: () =>
        metadata.find((row) => row.record.status === 'pending' || row.record.status === 'running'),
      agentSession: (sessionId) => {
        const session = this.agentSessions.get(sessionId);
        return session?.workspaceId === workspaceId && session.threadId === threadId
          ? { revision: 1, record: writeRetainedV1(session) }
          : undefined;
      },
      currentPositions: (input) =>
        positions
          .filter((row) => {
            const item = this.items.get(row.itemId)!;
            return (
              item.type === input.type &&
              (!input.turnId || row.turnId === input.turnId) &&
              (!input.status || item.status === input.status)
            );
          })
          .reverse()
          .slice(0, input.limit),
      turnRanks: (turnId) => {
        const index = metadata.findIndex((row) => row.record.id === turnId);
        return index < 0 ? undefined : { position: index + 1, latest: metadata.length };
      },
      pendingAssociations: (requestId, requestItemId) =>
        [...this.items.values()]
          .filter(
            (item) =>
              workspaceIdForOwner(item.owner) === workspaceId &&
              (item.id === requestItemId ||
                item.causationId === requestItemId ||
                ('approvalRequestId' in item && item.approvalRequestId === requestId) ||
                ('userInputRequestId' in item && item.userInputRequestId === requestId))
          )
          .map((item) => ({
            itemId: item.id,
            turnId: item.turnId,
            threadId: item.threadId,
            type: item.type,
          })),
      lastEventAt: (turnId) => this.getTurnEvents(turnId).at(-1)?.timestamp ?? null,
      turns: (window) => {
        const selected = metadata.filter(
          (row) =>
            row.admissionOrder <= window.upper &&
            (window.direction === 'before'
              ? row.admissionOrder < (window.boundary ?? Number.MAX_SAFE_INTEGER)
              : row.admissionOrder > (window.boundary ?? 0))
        );
        return (window.direction === 'before' ? selected.reverse() : selected).slice(
          0,
          window.limit
        );
      },
      turn: (turnId) => metadata.find((row) => row.record.id === turnId),
      position: (itemId) => positions.find((row) => row.itemId === itemId),
      positions: (turnId, input) => {
        const selected = positions.filter(
          (row) =>
            row.turnId === turnId &&
            row.sequence <= input.upper &&
            (input.direction === 'before'
              ? row.sequence < (input.boundary ?? Number.MAX_SAFE_INTEGER)
              : row.sequence > (input.boundary ?? 0)) &&
            input.types.includes(this.items.get(row.itemId)!.type)
        );
        return (input.direction === 'before' ? selected.reverse() : selected).slice(0, input.limit);
      },
      item: (itemId) => {
        const row = positions.find((row) => row.itemId === itemId);
        return row ? this.items.get(itemId) : undefined;
      },
      itemHead: (turnId) =>
        Math.max(0, ...positions.filter((row) => row.turnId === turnId).map((row) => row.sequence)),
      revisionHead: (turnId) => sequenceCounts.get(turnId) ?? 0,
      revisions: (turnId, after, limit) =>
        revisions
          .filter((entry) => entry.item.turnId === turnId && entry.sequence > after)
          .slice(0, limit)
          .map((entry) => ({ ...entry, item: digestItem(entry.item) })),
      revision: (turnId, itemId, revision) => {
        const item = revisions.find(
          (entry) =>
            entry.item.turnId === turnId && entry.item.id === itemId && entry.revision === revision
        )?.item;
        return item ? digestItem(item) : undefined;
      },
      failures: (turnId) => {
        const counts: Partial<Record<Item['type'], number>> = {};
        for (const item of turns.find((turn) => turn.id === turnId)?.items ?? [])
          if (isRecordedItemFailure(item)) counts[item.type] = (counts[item.type] ?? 0) + 1;
        return counts;
      },
      counts: (turnId) => {
        const counts: Partial<Record<Item['type'], number>> = {};
        for (const item of turns.find((turn) => turn.id === turnId)?.items ?? [])
          counts[item.type] = (counts[item.type] ?? 0) + 1;
        return counts;
      },
      catchUp: (userId, receipts) =>
        positions
          .filter((row) => {
            const item = this.items.get(row.itemId)!;
            return (
              ('actor' in item && item.actor.kind === 'user' && item.actor.id === userId) ||
              (['user-message', 'assistant-message'].includes(item.type) &&
                receipts.includes(item.id))
            );
          })
          .at(-1),
    });
  }

  /** Resolves minimal source lineage before the source owner's Thread audience check. */
  public getItemLineage(
    workspaceId: string,
    itemId: string
  ): { threadId: string; turnId: string } | undefined {
    this.getWorkspace(workspaceId);
    if (this.dataRoot)
      return readNativeItemLineage(this.nativeScope({ kind: 'workspace', workspaceId }), itemId);
    const item = this.items.get(itemId);
    return item && workspaceIdForOwner(item.owner) === workspaceId
      ? { threadId: item.threadId, turnId: item.turnId }
      : undefined;
  }

  /** Resolves an exact Item inside its current Workspace and Thread without reading siblings. */
  public getThreadItem(workspaceId: string, threadId: string, itemId: string): Item {
    this.getThread(workspaceId, threadId);
    const item = this.dataRoot
      ? readNativeThreadItem(this.nativeScope({ kind: 'workspace', workspaceId }), threadId, itemId)
      : this.items.get(itemId);
    if (!item || workspaceIdForOwner(item.owner) !== workspaceId || item.threadId !== threadId)
      throw new StoreRecordNotFoundError(`Item not found: ${itemId}`);
    return ItemSchema.parse(item);
  }

  /** Counts one Turn's original Items by immutable type without materializing their bodies. */
  public getThreadTurnItemCounts(
    workspaceId: string,
    threadId: string,
    turnId: string
  ): Partial<Record<Item['type'], number>> {
    this.getThread(workspaceId, threadId);
    if (this.dataRoot) {
      const counts = readNativeTurnItemCounts(
        this.nativeScope({ kind: 'workspace', workspaceId }),
        threadId,
        turnId
      );
      if (!counts) throw new StoreRecordNotFoundError(`Turn not found: ${turnId}`);
      return counts;
    }
    const counts: Partial<Record<Item['type'], number>> = {};
    for (const item of this.getTurn(workspaceId, threadId, turnId).items)
      counts[item.type] = (counts[item.type] ?? 0) + 1;
    return counts;
  }

  /**
   * Lists every durable item revision for one workspace in append order.
   *
   * @param workspaceId Workspace whose item history should be returned.
   * @returns Full item revision history.
   */
  public listWorkspaceItemRevisions(workspaceId: string): Item[] {
    this.getWorkspace(workspaceId);
    if (!this.dataRoot)
      return this.itemRevisions.filter((item) => workspaceIdForOwner(item.owner) === workspaceId);
    const scope = this.nativeScope({ kind: 'workspace', workspaceId });
    return listNativeProducts(scope, 'turn').flatMap(
      (row) => readNativeTurnHistory(scope, row.record.id as string)!.itemRevisions
    );
  }

  /**
   * Returns durable Items from currently admitted Workspaces for app-local read models.
   *
   * @returns Stored items.
   */
  public listAllItems(): Item[] {
    return this.listWorkspaces().flatMap((workspace) =>
      this.listThreads(workspace.id).flatMap((thread) =>
        this.listThreadItems(workspace.id, thread.id)
      )
    );
  }

  /**
   * Creates or replaces one target-issued Approval request.
   *
   * @param input Approval request to store.
   * @returns Stored Approval request.
   * @throws When the id belongs to the portable-import history namespace.
   */
  public createApproval(input: ApprovalRequest): ApprovalRequest {
    this.assertWorkspacePublicationAcknowledged(input.workspaceId);
    if (!isTargetIssuedEffectAuthority(input.id)) {
      throw new Error('Approval id uses the reserved portable-import authority namespace.');
    }

    this.approvals.set(input.id, input);
    return input;
  }

  /** Reads only existing Approval-map lineage under the selected Workspace; its command owner validates the canonical Pending Request. */
  public getApprovalProjectionLineage(
    workspaceId: string,
    requestId: string
  ): { workspaceId: string; threadId: string } | null {
    this.assertWorkspacePublicationAcknowledged(workspaceId);
    const approval = this.approvals.get(requestId);
    if (approval?.workspaceId === workspaceId) return { workspaceId, threadId: approval.threadId };
    return null;
  }

  public getApproval(approvalRequestId: string): ApprovalRequest {
    const approval = this.approvals.get(approvalRequestId);

    if (!approval) {
      throw new StoreRecordNotFoundError(`Approval request not found: ${approvalRequestId}`);
    }

    this.assertWorkspacePublicationAcknowledged(approval.workspaceId);
    return approval;
  }

  public updateApproval(
    approvalRequestId: string,
    input: Partial<ApprovalRequest>
  ): ApprovalRequest {
    const approval = this.getApproval(approvalRequestId);
    const updated: ApprovalRequest = { ...approval, ...input };
    this.assertWorkspacePublicationAcknowledged(updated.workspaceId);
    this.approvals.set(approvalRequestId, updated);
    return updated;
  }

  /** Rechecks the acknowledged Session's selected owner without substituting a later Session head. */
  private assertAgentSessionResultAvailable(agentSession: AgentSession): void {
    const { workspaceId, id } = agentSession;
    const unavailable = () => new StoreRecordNotFoundError(`AgentSession not found: ${id}`);
    if (!isScopeAdmitted(this.dataRoot!, 'workspace', workspaceId, this.suppliedScopeRefusals))
      throw unavailable();
    const root = join(this.dataRoot!, 'workspaces', workspaceId);
    const path = join(root, 'db', 'workspace.sqlite');
    try {
      assertCanonicalDirectory(root);
      assertCanonicalDirectory(dirname(path));
      assertCanonicalRegularFile(path);
      const reader = openControlStoreProductReadHandle(path, { kind: 'workspace', workspaceId });
      try {
        if (!reader.get('workspace', workspaceId))
          throw new Error('The native Workspace identity is unavailable.');
      } finally {
        reader.close();
      }
    } catch {
      refuseScope(this.dataRoot!, { scope: 'workspace', id: workspaceId, check: 'database' });
      throw unavailable();
    }
    this.assertWorkspacePublicationAcknowledged(workspaceId);
  }

  public async createAgentSession(input: AgentSessionInput): Promise<AgentSession> {
    this.getWorkspace(input.workspaceId);
    if (!input.threadId) {
      throw new Error(`AgentSession requires a thread: ${input.id}`);
    }
    this.getThread(input.workspaceId, input.threadId);
    const existing = this.dataRoot
      ? this.findNativeOwner('agent-session', input.id)
      : this.agentSessions.get(input.id);

    if (existing) {
      throw new Error(`AgentSession id already exists: ${input.id}`);
    }

    const workspaceRoots = input.workspaceRoots ?? [];
    const agentSession = AgentSessionRecordSchema.parse({
      configVersion: null,
      environmentPackageSnapshotId: null,
      nativeHandleDigest: null,
      retainedStorage: null,
      policySnapshotId: null,
      sandboxSummary: sandboxSummaryForWorkspaceRoots(workspaceRoots),
      sessionCompatibilityKey: null,
      stale: false,
      workspaceRoots,
      ...input,
    }) as AgentSession;

    if (
      isCurrentAgentSessionStatus(agentSession.status) &&
      this.listThreadAgentSessions(agentSession.workspaceId, input.threadId).some((candidate) =>
        isCurrentAgentSessionStatus(candidate.status)
      )
    ) {
      throw new Error(`Thread already has a current AgentSession: ${input.threadId}`);
    }

    if (this.dataRoot) {
      await this.writeNativeProducts(
        this.nativeScope({ kind: 'workspace', workspaceId: input.workspaceId }),
        [{ kind: 'agent-session', expectedRevision: 0, record: writeRetainedV1(agentSession) }]
      );
      this.assertAgentSessionResultAvailable(agentSession);
      return agentSession;
    }
    this.agentSessions.set(agentSession.id, agentSession);
    return agentSession;
  }

  /**
   * Return one AgentSession by id.
   *
   * @param agentSessionId AgentSession id to load.
   * @returns Stored AgentSession.
   */
  public getAgentSession(agentSessionId: string): AgentSession {
    const steps = this.getAgentSessionSteps(agentSessionId);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  /** Shares the original owner read in released page/proof contributions for one admitted call. */
  public *getAgentSessionSteps(agentSessionId: string): Generator<void, AgentSession, void> {
    if (this.dataRoot) {
      const lineage = yield* this.findNativeOwnerSteps('agent-session', agentSessionId);
      if (!lineage || lineage.owner.kind !== 'workspace')
        throw new StoreRecordNotFoundError(`AgentSession not found: ${agentSessionId}`);
      const row = readNativeProduct(
        this.nativeScope(lineage.owner),
        'agent-session',
        agentSessionId
      );
      if (!row) throw new StoreRecordNotFoundError(`AgentSession not found: ${agentSessionId}`);
      return AgentSessionRecordSchema.parse(row.record) as AgentSession;
    }
    const session = this.agentSessions.get(agentSessionId);
    if (!session) throw new StoreRecordNotFoundError(`AgentSession not found: ${agentSessionId}`);
    return session;
  }

  /** Updates session lifecycle while preserving its write-once native proof and attachment provenance. */
  public async updateAgentSession(
    agentSessionId: string,
    input: Partial<
      Pick<
        AgentSession,
        | 'configVersion'
        | 'environmentPackageSnapshotId'
        | 'message'
        | 'nativeHandleDigest'
        | 'retainedStorage'
        | 'stale'
        | 'status'
        | 'updatedAt'
      >
    >
  ): Promise<AgentSession> {
    const initial = this.getAgentSession(agentSessionId);
    const scope = this.dataRoot
      ? this.nativeScope({ kind: 'workspace', workspaceId: initial.workspaceId })
      : undefined;
    const previous = scope ? readNativeProduct(scope, 'agent-session', agentSessionId) : undefined;
    const agentSession = previous
      ? (AgentSessionRecordSchema.parse(previous.record) as AgentSession)
      : initial;
    const unsupportedField = Object.keys(input).find(
      (field) =>
        ![
          'configVersion',
          'environmentPackageSnapshotId',
          'message',
          'nativeHandleDigest',
          'retainedStorage',
          'stale',
          'status',
          'updatedAt',
        ].includes(field)
    );
    if (unsupportedField) {
      throw new Error(`AgentSession update cannot change field: ${unsupportedField}`);
    }
    // The resume pair is write-once: a later proof for the same binding must carry the same digest.
    if (
      input.retainedStorage !== undefined &&
      agentSession.retainedStorage !== null &&
      (input.retainedStorage?.storageRef !== agentSession.retainedStorage.storageRef ||
        input.retainedStorage?.workSlotRef !== agentSession.retainedStorage.workSlotRef ||
        input.retainedStorage?.attachmentGeneration !==
          agentSession.retainedStorage.attachmentGeneration)
    ) {
      throw new Error('AgentSession retained-storage attachment cannot change.');
    }
    if (
      input.nativeHandleDigest !== undefined &&
      agentSession.nativeHandleDigest !== null &&
      input.nativeHandleDigest !== agentSession.nativeHandleDigest
    ) {
      throw new Error(`AgentSession resume digest cannot change: ${agentSessionId}`);
    }
    if (
      input.status &&
      !isCurrentAgentSessionStatus(agentSession.status) &&
      isCurrentAgentSessionStatus(input.status)
    ) {
      throw new Error(`Terminal AgentSession cannot become current again: ${agentSessionId}`);
    }
    const updated = AgentSessionRecordSchema.parse({
      ...agentSession,
      ...input,
      updatedAt: input.updatedAt ?? now(),
    }) as AgentSession;
    if (this.dataRoot) {
      await this.writeNativeProducts(scope!, [
        {
          kind: 'agent-session',
          expectedRevision: previous!.revision,
          record: writeRetainedV1({ ...previous!.record, ...updated }),
        },
      ]);
      this.assertAgentSessionResultAvailable(updated);
      return updated;
    }
    this.agentSessions.set(agentSessionId, updated);
    return updated;
  }

  /**
   * List AgentSessions for one thread in durable creation order.
   *
   * @param workspaceId Workspace that owns the thread.
   * @param threadId Thread whose AgentSessions should be returned.
   * @returns AgentSessions recorded for the thread.
   */
  public listThreadAgentSessions(workspaceId: string, threadId: string): AgentSession[] {
    this.getThread(workspaceId, threadId);
    return this.listWorkspaceAgentSessions(workspaceId).filter(
      (session) => session.threadId === threadId
    );
  }

  /**
   * Lists every durable AgentSession for one workspace.
   *
   * @param workspaceId Workspace whose sessions should be returned.
   * @returns Workspace-owned AgentSessions.
   */
  public listWorkspaceAgentSessions(workspaceId: string): AgentSession[] {
    const steps = this.listWorkspaceAgentSessionsSteps(workspaceId);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  /** Shares the original owner read in released page/proof contributions for one admitted call. */
  public *listWorkspaceAgentSessionsSteps(
    workspaceId: string
  ): Generator<void, AgentSession[], void> {
    this.getWorkspace(workspaceId);
    if (!this.dataRoot)
      return [...this.agentSessions.values()].filter(
        (session) => session.workspaceId === workspaceId
      );
    const records: AgentSession[] = [];
    for (const page of readNativeProductPages(
      this.nativeScope({ kind: 'workspace', workspaceId }),
      'agent-session'
    )) {
      records.push(
        ...page.map((row) => AgentSessionRecordSchema.parse(row.record) as AgentSession)
      );
      yield;
    }
    return records;
  }

  /**
   * Creates one immutable Artifact and its producing-Turn reference when applicable.
   *
   * @param input Complete Artifact authority.
   * @param filePayload Exact privately staged original for file-backed content.
   * @param admission Declared post-terminal category for the producing Turn artifact-reference Item.
   * @param submission Complete original Worker command joined on the native writer; absent for other existing producers.
   * @returns Imported Artifact synchronously, or turn output after its native tuple acknowledgement.
   * @throws ArtifactAuthorityError when content proof or create-only ownership is invalid.
   */
  public createArtifact(
    input: Artifact & { origin: Extract<Artifact['origin'], { kind: 'imported' }> },
    filePayload?: StagedArtifactPayload,
    admission?: TerminalTurnWriteAdmission,
    submission?: ArtifactSubmissionPublication
  ): Artifact;
  public createArtifact(
    input: Artifact & { origin: Extract<Artifact['origin'], { kind: 'turn-output' }> },
    filePayload?: StagedArtifactPayload,
    admission?: TerminalTurnWriteAdmission,
    submission?: ArtifactSubmissionPublication
  ): Promise<Artifact>;
  public createArtifact(
    input: Artifact,
    filePayload?: StagedArtifactPayload,
    admission?: TerminalTurnWriteAdmission,
    submission?: ArtifactSubmissionPublication
  ): Artifact | Promise<Artifact>;
  public createArtifact(
    input: Artifact,
    filePayload?: StagedArtifactPayload,
    admission?: TerminalTurnWriteAdmission,
    submission?: ArtifactSubmissionPublication
  ): Artifact | Promise<Artifact> {
    const parsed = ArtifactSchema.safeParse(input);
    if (!parsed.success) {
      throw new ArtifactAuthorityError('invalid_request', 'Artifact input is invalid.');
    }
    const artifact = parsed.data;
    if (
      artifact.version !== 1 ||
      (artifact.origin.kind === 'imported' &&
        (artifact.kind !== 'file' || artifact.status !== 'ready' || artifact.summary !== null))
    ) {
      throw new ArtifactAuthorityError(
        'invalid_request',
        'Artifact creation accepts only a valid initial authority shape.'
      );
    }
    this.getWorkspace(artifact.workspaceId);
    const contentDigest =
      artifact.content.format === 'file'
        ? filePayload?.contentDigest
        : `sha256:${createHash('sha256').update(artifact.content.body, 'utf8').digest('hex')}`;
    if (contentDigest !== artifact.contentDigest) {
      throw new ArtifactAuthorityError(
        'source_digest_mismatch',
        'Artifact content does not match its digest.'
      );
    }
    if (
      artifact.content.format === 'file' &&
      (!this.dataRoot || !filePayload || filePayload.byteLength !== artifact.content.byteLength)
    ) {
      throw new ArtifactAuthorityError(
        'invalid_request',
        'Artifact file creation requires exact privately staged bytes and durable storage.'
      );
    }
    if (
      this.artifacts.has(artifact.id) ||
      [...this.items.values()].some(
        (item) => item.type === 'artifact-reference' && item.artifactId === artifact.id
      )
    ) {
      throw new ArtifactAuthorityError(
        'recovery_required',
        'The request-owned Artifact already has authority without a receipt.'
      );
    }

    let producingTurn: Turn | null = null;
    let reference: Extract<Item, { type: 'artifact-reference' }> | null = null;
    if (artifact.origin.kind === 'turn-output') {
      producingTurn = this.getTurn(
        artifact.workspaceId,
        artifact.origin.threadId,
        artifact.origin.turnId
      );
      const itemId = artifactReferenceItemId(artifact.id, producingTurn.id);
      if (this.items.has(itemId)) {
        throw new ArtifactAuthorityError(
          'recovery_required',
          'The producing Artifact reference identity is already occupied.'
        );
      }
      reference = ItemSchema.parse({
        id: itemId,
        owner: { kind: 'workspace', workspaceId: artifact.workspaceId },
        threadId: producingTurn.threadId,
        turnId: producingTurn.id,
        type: 'artifact-reference',
        status: 'completed',
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        title: artifact.title,
        summary: artifact.summary,
        lastMutationRequestId: artifact.lastMutationRequestId,
        createdAt: artifact.createdAt,
        completedAt: artifact.updatedAt,
      }) as Extract<Item, { type: 'artifact-reference' }>;
    }

    const versionRecord = ArtifactVersionRecordSchema.parse({
      artifact,
      version: {
        actor:
          artifact.origin.kind === 'imported' ? artifact.origin.actor : producingTurn!.triggerActor,
        threadId: artifact.threadId,
        turnId: artifact.turnId,
      },
    });

    if (
      submission &&
      (!this.dataRoot || !reference || !producingTurn?.agentId || !producingTurn.agentSessionId)
    )
      throw new ArtifactAuthorityError(
        'invalid_request',
        'Worker Artifact submission requires its actual native producing session.'
      );
    const publishFiles = () => {
      this.artifacts.set(artifact.id, artifact);
      this.refreshWorkspaceCounts(artifact.workspaceId);
      try {
        this.persist(artifact.workspaceId, false, {
          record: versionRecord,
          ...(filePayload ? { payloadPath: filePayload.path } : {}),
        });
        this.artifactVersions.set(artifact.id, [versionRecord]);
      } catch (error) {
        this.artifacts.delete(artifact.id);
        this.refreshWorkspaceCounts(artifact.workspaceId);
        this.persist(artifact.workspaceId);
        throw error;
      }
    };
    if (submission) withCanonicalFileWriteAdmission(submission.fileAdmission, publishFiles);
    else publishFiles();
    if (submission && reference)
      return this.publishArtifactSubmission(artifact, versionRecord, reference, submission);
    if (reference) {
      return this.createItem(reference, admission).then(() => artifact);
    }
    return artifact;
  }

  /** Publishes no process-local Artifact or event before the complete native submission acknowledges. */
  private async publishArtifactSubmission(
    artifact: Artifact,
    version: ArtifactVersionRecord,
    reference: Extract<Item, { type: 'artifact-reference' }>,
    submission: ArtifactSubmissionPublication,
    ordered = false
  ): Promise<Artifact> {
    // The common file owner has published durable bytes. Keep the unacknowledged head out of caches.
    this.pendingArtifactSubmissions.add(artifact.id);
    this.refreshWorkspaceCounts(artifact.workspaceId);
    let entered = false;
    let submitted = false;
    let acknowledged = false;
    try {
      // Private re-entry keeps the synchronous file-admission owner outside the retained JSON.
      if (!ordered)
        return await this.publishTurn(
          { kind: 'workspace', workspaceId: artifact.workspaceId },
          [reference.turnId],
          { artifact, version, reference, review: submission.review, receipt: submission.receipt },
          (owned) => {
            entered = true;
            return this.publishArtifactSubmission(
              owned.artifact,
              owned.version,
              owned.reference,
              { ...owned, fileAdmission: submission.fileAdmission },
              true
            );
          }
        );
      const scope = this.nativeScope({ kind: 'workspace', workspaceId: artifact.workspaceId });
      const turn = this.getTurnById(reference.turnId);
      const stagingRoot = join(dirname(dirname(scope.path)), 'runtime', 'staging');
      const items = readNativeProductEntries(scope, turn.id, 'item');
      const history = this.getTurnEventsForExport(turn.id);
      const timestamp = submission.receipt.createdAt;
      const eventScope = {
        requestId: projectTurnEventRequestId(
          submission.receipt.requestId,
          artifact.workspaceId,
          turn.threadId
        ),
        workspaceId: artifact.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
      };
      const events = [
        { event: 'item.created', data: { type: 'item-created', item: reference } },
        {
          event: 'item.completed',
          data: { type: 'item-completed', item: reference, itemId: reference.id },
        },
        { event: 'artifact.created', data: { type: 'artifact-created', artifact } },
      ].map((event, index) =>
        SseEventEnvelopeSchema.parse({
          ...event,
          ...eventScope,
          protocolVersion: PROTOCOL_VERSION,
          timestamp,
          sequence: (history.at(-1)?.sequence ?? 0) + index + 1,
        })
      );
      const entries: ControlProductEntry[] = [
        {
          kind: 'item',
          turnId: turn.id,
          sequence: items.length + 1,
          expectedRevision: 0,
          ...(await prepareRetainedProductJson(
            scope.contentMount,
            scope.owner,
            stagingRoot,
            writeRetainedV1(reference)
          )),
        },
      ];
      for (const event of events)
        entries.push({
          kind: 'event',
          turnId: turn.id,
          sequence: event.sequence,
          expectedRevision: 0,
          ...(await prepareRetainedProductJson(
            scope.contentMount,
            scope.owner,
            stagingRoot,
            writeRetainedV1(event)
          )),
        });
      const client = getControlStoreWorkerClient();
      const database = `workspace:${scope.path}`;
      await client.open({
        database,
        path: scope.path,
        dataRoot: this.dataRoot!,
        create: false,
        initialize: 'workspace',
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      });
      submitted = true;
      await client.review(database, {
        mode: 'submit',
        artifact,
        review: submission.review,
        receipt: submission.receipt,
        agentId: turn.agentId!,
        agentSessionId: turn.agentSessionId!,
        transition: { products: [], entries },
      });
      acknowledged = true;
      this.pendingArtifactSubmissions.delete(artifact.id);
      this.artifacts.set(artifact.id, artifact);
      this.artifactVersions.set(artifact.id, [version]);
      this.refreshWorkspaceCounts(artifact.workspaceId);
      for (const event of events) {
        this.acknowledgedTurnEvents.set(event, structuredClone(event));
        this.emitTurnEvent(turn.id, event);
      }
      return artifact;
    } catch (error) {
      if (entered) throw error; // The ordered body already applied the original compensation rules.
      const rolledBack =
        !submitted ||
        (error instanceof ControlStoreWorkerError && error.commit === 'not-committed') ||
        error instanceof ArtifactReviewError;
      if (!acknowledged && rolledBack) {
        // Only a proved refusal may remove this request's file authority. Unknown COMMIT keeps its truthful gap.
        this.artifacts.set(artifact.id, artifact);
        this.artifactVersions.set(artifact.id, [version]);
        try {
          withCanonicalFileWriteAdmission(submission.fileAdmission, () =>
            this.rollbackArtifactCreation(artifact.id)
          );
        } catch (cleanupError) {
          throw new ArtifactPayloadCleanupError([error, cleanupError]);
        }
      }
      throw error;
    }
  }

  /** Keeps file authority through native preparation and FULL settlement, across Store views of the same scope. */
  private async protectArtifactReference<T>(
    workspaceId: string,
    artifactId: string,
    publish: () => Promise<T>
  ): Promise<T> {
    const key = JSON.stringify([
      realpathSync(this.nativeScope({ kind: 'workspace', workspaceId }).path),
      artifactId,
    ]);
    pendingArtifactReferences.set(key, (pendingArtifactReferences.get(key) ?? 0) + 1);
    let uncertain = false;
    try {
      return await publish();
    } catch (error) {
      uncertain = error instanceof ControlStoreWorkerError && error.commit === 'unknown';
      throw error;
    } finally {
      // A channel refusal precedes Worker termination. Unknown reference SQL can still commit.
      // Keep its file authority protected for this process; no automatic compensation proves absence.
      if (!uncertain) {
        const remaining = pendingArtifactReferences.get(key)! - 1;
        if (remaining) pendingArtifactReferences.set(key, remaining);
        else pendingArtifactReferences.delete(key);
      }
    }
  }

  /** Rolls back only a newly created request-owned Artifact after handled publication failure. @param artifactId Initial Artifact identity, preflighted absent by the command. */
  public rollbackArtifactCreation(artifactId: string): void {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) return;
    this.assertWorkspacePublicationAcknowledged(artifact.workspaceId);
    if (artifact.version !== 1)
      throw new ArtifactAuthorityError(
        'recovery_required',
        'Artifact rollback cannot remove a later version.'
      );
    if (
      this.dataRoot &&
      artifact.origin.kind === 'imported' &&
      (pendingArtifactReferences.has(
        JSON.stringify([
          realpathSync(
            this.nativeScope({ kind: 'workspace', workspaceId: artifact.workspaceId }).path
          ),
          artifactId,
        ])
      ) ||
        this.listWorkspaceItemRevisions(artifact.workspaceId).some(
          (item) => item.type === 'artifact-reference' && item.artifactId === artifactId
        ))
    )
      throw new ArtifactAuthorityError(
        'recovery_required',
        'Artifact rollback cannot erase a pending or acknowledged native reference.'
      );
    if (this.dataRoot && artifact.origin.kind === 'turn-output') {
      const turn = this.getTurn(
        artifact.workspaceId,
        artifact.origin.threadId,
        artifact.origin.turnId
      );
      if (
        turn.items.some(
          (item) => item.type === 'artifact-reference' && item.artifactId === artifactId
        )
      )
        throw new ArtifactAuthorityError(
          'recovery_required',
          'Artifact rollback cannot erase an acknowledged native Item revision.'
        );
    }
    this.pendingArtifactSubmissions.delete(artifactId);
    this.artifacts.delete(artifactId);
    this.artifactVersions.delete(artifactId);
    this.itemRevisions = this.itemRevisions.filter(
      (item) => item.type !== 'artifact-reference' || item.artifactId !== artifactId
    );
    for (const [id, item] of this.items) {
      if (item.type === 'artifact-reference' && item.artifactId === artifactId) {
        this.items.delete(id);
        const turn = this.turns.get(item.turnId);
        if (turn)
          this.turns.set(turn.id, {
            ...turn,
            items: turn.items.filter((candidate) => candidate.id !== id),
          });
      }
    }
    this.refreshWorkspaceCounts(artifact.workspaceId);
    this.persist(artifact.workspaceId);
  }

  /**
   * Introduces one workspace-only imported Artifact into an idle Thread.
   *
   * @param input Accepted command scope, proof, and deterministic identities.
   * @returns Stable Artifact, Turn, and Item identities.
   * @throws ArtifactAuthorityError when the target is stale, busy, conflicting, or incomplete.
   */
  public async introduceArtifact(
    input: IntroduceArtifactInput
  ): Promise<IntroduceWorkspaceArtifactResponse> {
    this.assertWorkspacePublicationAcknowledged(input.workspaceId);
    let thread: Thread;
    try {
      this.getWorkspace(input.workspaceId);
      thread = this.getThread(input.workspaceId, input.threadId);
    } catch (error) {
      if (!(error instanceof StoreRecordNotFoundError)) throw error;
      throw new ArtifactAuthorityError('stale', 'The requested Workspace or Thread is absent.');
    }
    const artifact = this.artifacts.get(input.artifactId);
    if (!artifact || artifact.workspaceId !== input.workspaceId) {
      throw new ArtifactAuthorityError('stale', 'The requested Artifact is absent.');
    }
    if (
      artifact.origin.kind !== 'imported' ||
      artifact.threadId !== null ||
      artifact.turnId !== null
    ) {
      throw new ArtifactAuthorityError(
        'stale',
        'The requested Artifact is not workspace-only imported content.'
      );
    }
    this.assertArtifactContent(artifact);
    const contentDigest = this.getArtifactVersion(input.workspaceId, input.artifactId, 1).artifact
      .contentDigest;
    if (contentDigest !== artifact.origin.sourceDigest) {
      throw new ArtifactAuthorityError(
        'recovery_required',
        'The imported Artifact has invalid durable content proof.'
      );
    }
    if (artifact.version !== input.expectedArtifactVersion) {
      throw new ArtifactAuthorityError(
        'conflict',
        'The Artifact version does not match the request.'
      );
    }

    const itemId = artifactReferenceItemId(input.artifactId, input.turnId);
    const matchingReference = this.listThreadItems(input.workspaceId, input.threadId).find(
      (item) =>
        item.type === 'artifact-reference' &&
        workspaceIdForOwner(item.owner) === input.workspaceId &&
        item.threadId === input.threadId &&
        item.artifactId === input.artifactId &&
        (item.turnId === input.turnId || item.lastMutationRequestId === input.requestId)
    );
    if (
      (this.dataRoot ? this.findNativeOwner('turn', input.turnId) : this.turns.has(input.turnId)) ||
      (this.dataRoot ? this.findNativeOwner('item', itemId) : this.items.has(itemId)) ||
      this.streams.has(input.turnId) ||
      matchingReference
    ) {
      throw new ArtifactAuthorityError(
        'recovery_required',
        'The Artifact introduction owner tuple already exists without a receipt.'
      );
    }
    if (
      this.listThreadTurns(input.workspaceId, input.threadId).some(
        (turn) => !isSealedTurnTerminal(turn.status)
      )
    ) {
      throw new ArtifactAuthorityError(
        'thread_busy',
        'The Thread already has a non-terminal Turn.'
      );
    }

    const reference = ItemSchema.parse({
      id: itemId,
      owner: { kind: 'workspace', workspaceId: input.workspaceId },
      threadId: input.threadId,
      turnId: input.turnId,
      type: 'artifact-reference',
      status: 'completed',
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      title: artifact.title,
      summary: artifact.summary,
      lastMutationRequestId: input.requestId,
      createdAt: input.acceptedAt,
      completedAt: input.acceptedAt,
    }) as Extract<Item, { type: 'artifact-reference' }>;
    const turn = TurnSchema.parse({
      id: input.turnId,
      owner: { kind: 'workspace', workspaceId: input.workspaceId },
      threadId: input.threadId,
      triggerActor: input.triggerActor,
      items: [reference],
      status: 'completed',
      error: null,
      configVersion: null,
      startedAt: input.acceptedAt,
      completedAt: input.acceptedAt,
      durationMs: 0,
    });
    if (this.dataRoot) {
      return this.protectArtifactReference(input.workspaceId, artifact.id, async () => {
        const scope = this.nativeScope(thread.owner);
        const entries = await this.prepareNativeItems(scope, [reference]);
        try {
          await this.createNativeTerminalTurn(scope, turn, this.liveCaptureCoverage, [], entries);
        } catch (error) {
          this.throwArtifactTerminalFailure(error, input.workspaceId, input.threadId);
        }
        return {
          artifactId: artifact.id,
          artifactVersion: artifact.version,
          turnId: turn.id,
          itemId: reference.id,
        };
      });
    }
    const itemRevisionCount = this.itemRevisions.length;

    this.turns.set(turn.id, turn);
    this.items.set(reference.id, reference);
    this.itemRevisions.push(reference);
    this.streams.set(turn.id, {
      sequence: 0,
      events: [],
      listeners: new Set(),
    });
    try {
      this.persist(input.workspaceId);
    } catch (error) {
      this.turns.delete(turn.id);
      this.items.delete(reference.id);
      this.itemRevisions.length = itemRevisionCount;
      this.streams.delete(turn.id);
      this.persist(input.workspaceId);
      throw error;
    }

    return {
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      turnId: turn.id,
      itemId: reference.id,
    };
  }

  /** Reads file-owned Artifact authority through its original parser and complete producing-Item proof. */
  private refreshBorrowedArtifactInventory(workspaceId: string): void {
    const scope = this.borrowedProductScope;
    if (!scope || scope.owner.kind !== 'workspace' || scope.owner.workspaceId !== workspaceId)
      return;
    this.assertWorkspacePublicationAcknowledged(workspaceId);
    const threads = this.listThreads(workspaceId);
    const histories = listNativeProducts(scope, 'turn').map((row) => {
      const history = readNativeTurnHistory(scope, row.record.id as string);
      if (!history) throw new NotebookError('recovery_required');
      return history;
    });
    const turns = new Map(histories.map(({ turn }) => [turn.id, turn]));
    const revisions = histories.flatMap(({ itemRevisions }) => itemRevisions);
    const root = this.workspaceRootPath(workspaceId);
    const artifacts = readWorkspaceArtifacts(
      root,
      workspaceId,
      new Set(threads.map(({ id }) => id)),
      turns
    );
    const versions = new Map(
      artifacts.map((artifact) => [
        artifact.id,
        readArtifactVersionHistory(root, artifact, turns, revisions),
      ])
    );
    // Publish no partial projection if any retained original or producing Item fails admission.
    for (const [id, artifact] of this.artifacts) {
      if (artifact.workspaceId !== workspaceId) continue;
      this.artifacts.delete(id);
      this.artifactVersions.delete(id);
    }
    for (const artifact of artifacts) {
      this.artifacts.set(artifact.id, artifact);
      this.artifactVersions.set(artifact.id, versions.get(artifact.id)!);
    }
  }

  public listArtifacts(workspaceId: string): Artifact[] {
    this.assertWorkspacePublicationAcknowledged(workspaceId);
    this.refreshBorrowedArtifactInventory(workspaceId);
    return [...this.artifacts.values()].filter(
      (artifact) =>
        artifact.workspaceId === workspaceId && !this.pendingArtifactSubmissions.has(artifact.id)
    );
  }

  public getArtifact(workspaceId: string, artifactId: string): Artifact {
    this.assertWorkspacePublicationAcknowledged(workspaceId);
    this.refreshBorrowedArtifactInventory(workspaceId);
    const artifact = this.artifacts.get(artifactId);

    if (
      !artifact ||
      artifact.workspaceId !== workspaceId ||
      this.pendingArtifactSubmissions.has(artifactId)
    ) {
      throw new StoreRecordNotFoundError(`Artifact not found: ${artifactId}`);
    }

    return artifact;
  }

  /** Lists exact immutable version metadata without substituting the current Artifact. */
  public listArtifactVersions(workspaceId: string, artifactId: string): ArtifactVersion[] {
    this.getArtifact(workspaceId, artifactId);
    const versions = this.artifactVersions.get(artifactId);
    if (!versions)
      throw new ArtifactAuthorityError(
        'recovery_required',
        'The Artifact version history is unavailable.'
      );
    return versions.map((record) => structuredClone(projectArtifactVersion(record)));
  }

  /** Resolves one exact immutable Artifact version and verifies its retained original. */
  public getArtifactVersion(
    workspaceId: string,
    artifactId: string,
    artifactVersion: number
  ): ReadArtifactVersionResponse {
    const current = this.getArtifact(workspaceId, artifactId);
    if (
      !Number.isSafeInteger(artifactVersion) ||
      artifactVersion < 1 ||
      artifactVersion > current.version
    )
      throw new StoreRecordNotFoundError('Artifact version not found.');
    let record = this.artifactVersions.get(artifactId)?.[artifactVersion - 1];
    const admitted = record;
    if (this.dataRoot) {
      try {
        record = readArtifactVersionRecord(
          this.workspaceRootPath(workspaceId),
          artifactId,
          artifactVersion
        );
      } catch {
        throw new ArtifactAuthorityError(
          'recovery_required',
          'The retained Artifact version is unavailable.'
        );
      }
    }
    if (!record)
      throw new ArtifactAuthorityError(
        'recovery_required',
        'The retained Artifact version is unavailable.'
      );
    if (
      !isDeepStrictEqual(record, admitted) ||
      record.artifact.workspaceId !== workspaceId ||
      !isDeepStrictEqual(record.artifact.origin, current.origin)
    )
      throw new ArtifactAuthorityError(
        'recovery_required',
        'The retained Artifact version authority is contradictory.'
      );
    this.assertArtifactContent(record.artifact);
    return structuredClone({ artifact: record.artifact, version: projectArtifactVersion(record) });
  }

  /** Checks current version and audience before staging or publishing a manual revision. */
  public assertArtifactVersionCommit(
    input: Pick<
      CommitArtifactVersionInput,
      'workspaceId' | 'artifactId' | 'threadId' | 'expectedArtifactVersion'
    >
  ): void {
    const current = this.getArtifact(input.workspaceId, input.artifactId);
    const thread = this.getThread(input.workspaceId, input.threadId);
    this.getArtifactVersion(input.workspaceId, input.artifactId, current.version);
    if (
      this.dataRoot &&
      lstatSync(
        dirname(
          artifactVersionRecordPath(
            this.workspaceRootPath(input.workspaceId),
            current.id,
            current.version + 1
          )
        ),
        { throwIfNoEntry: false }
      )
    )
      throw new ArtifactAuthorityError(
        'recovery_required',
        'The Artifact has an unacknowledged next version.'
      );
    if (current.version !== input.expectedArtifactVersion)
      throw new ArtifactAuthorityError(
        'conflict',
        'The Artifact version does not match the request.'
      );
    if (
      (current.origin.kind === 'turn-output' && current.origin.threadId !== thread.id) ||
      (current.origin.kind === 'imported' && thread.visibility !== 'workspace')
    )
      throw new ArtifactAuthorityError(
        'invalid_request',
        'The selected Thread does not preserve the Artifact audience.'
      );
    if (
      this.listThreadTurns(input.workspaceId, input.threadId).some(
        (turn) => !isSealedTurnTerminal(turn.status)
      )
    )
      throw new ArtifactAuthorityError(
        'thread_busy',
        'The Thread already has a non-terminal Turn.'
      );
  }

  /**
   * Commits one immutable next version and its completed Item-backed Core-local Turn.
   *
   * @param input Exact version, original content and command lineage.
   * @param payload Verified staged original for arbitrary file content.
   * @param fileAdmission Existing capacity owner for short synchronous version and head writes.
   */
  public async commitArtifactVersion(
    input: CommitArtifactVersionInput,
    payload?: StagedArtifactPayload,
    fileAdmission?: FileStorageAdmission
  ): Promise<ReadArtifactVersionResponse> {
    this.assertArtifactVersionCommit(input);
    const current = this.getArtifact(input.workspaceId, input.artifactId);
    const command = input.command ?? 'artifact.version-commit';
    const turnId = deriveEntityId('tu', [
      input.actor,
      input.workspaceId,
      input.threadId,
      command,
      input.requestId,
    ]);
    const itemId = artifactReferenceItemId(current.id, turnId);
    if (
      (this.dataRoot ? this.findNativeOwner('turn', turnId) : this.turns.has(turnId)) ||
      (this.dataRoot ? this.findNativeOwner('item', itemId) : this.items.has(itemId)) ||
      this.artifactVersions.get(current.id)?.some((record) => record.version.turnId === turnId)
    )
      throw new ArtifactAuthorityError(
        'recovery_required',
        'The request-owned Artifact version already exists without a receipt.'
      );
    const contentDigest =
      input.content.format === 'file'
        ? payload?.contentDigest
        : `sha256:${createHash('sha256').update(input.content.body, 'utf8').digest('hex')}`;
    if (
      !contentDigest ||
      (input.contentDigest !== undefined && input.contentDigest !== contentDigest) ||
      (input.content.format === 'file' &&
        (!this.dataRoot || !payload || payload.byteLength !== input.content.byteLength))
    )
      throw new ArtifactAuthorityError(
        'source_digest_mismatch',
        'The Artifact version does not match its exact original.'
      );
    const artifact = ArtifactSchema.parse({
      ...current,
      version: current.version + 1,
      title: input.title,
      summary: input.summary,
      content: input.content,
      contentDigest,
      lastMutationRequestId: input.requestId,
      updatedAt: input.recordedAt,
    });
    const record = ArtifactVersionRecordSchema.parse({
      artifact,
      version: {
        actor: input.actor,
        threadId: input.threadId,
        turnId,
      },
    });
    const item = ItemSchema.parse({
      id: itemId,
      owner: { kind: 'workspace', workspaceId: input.workspaceId },
      threadId: input.threadId,
      turnId,
      type: 'artifact-reference',
      status: 'completed',
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      title: artifact.title,
      summary: artifact.summary,
      lastMutationRequestId: input.requestId,
      createdAt: input.recordedAt,
      completedAt: input.recordedAt,
    });
    const turn = TurnSchema.parse({
      id: turnId,
      owner: { kind: 'workspace', workspaceId: input.workspaceId },
      threadId: input.threadId,
      triggerActor: input.actor,
      status: 'completed',
      error: null,
      configVersion: null,
      startedAt: input.recordedAt,
      completedAt: input.recordedAt,
      durationMs: 0,
      items: [item],
    });
    const versions = this.artifactVersions.get(current.id)!;
    if (this.dataRoot) {
      return this.protectArtifactReference(input.workspaceId, current.id, async () => {
        const workspaceRoot = this.workspaceRootPath(input.workspaceId);
        const scope = this.nativeScope(turn.owner);
        const entries = await this.prepareNativeItems(scope, [item]);
        const publishVersion = () =>
          publishArtifactVersionRecord({
            workspaceRoot,
            record,
            ...(payload ? { payloadPath: payload.path } : {}),
          });
        // File capacity is synchronous; no admission context spans native preparation or SQL.
        if (fileAdmission) withCanonicalFileWriteAdmission(fileAdmission, publishVersion);
        else publishVersion();
        try {
          await this.createNativeTerminalTurn(scope, turn, this.liveCaptureCoverage, [], entries);
        } catch (error) {
          if (error instanceof ControlStoreWorkerError && error.commit === 'not-committed') {
            try {
              const compensate = () =>
                rollbackArtifactVersionRecord(workspaceRoot, current.id, artifact.version);
              if (fileAdmission) withCanonicalFileWriteAdmission(fileAdmission, compensate);
              else compensate();
            } catch (cleanupError) {
              this.unacknowledgedWorkspaces.add(input.workspaceId);
              throw new ArtifactPayloadCleanupError([error, cleanupError]);
            }
          } else {
            // An uncertain native result retains the original version for ordinary recovery.
            this.unacknowledgedWorkspaces.add(input.workspaceId);
          }
          this.throwArtifactTerminalFailure(error, input.workspaceId, input.threadId);
        }
        // A native ACK cannot be undone by a later file-head failure.
        this.artifacts.set(current.id, artifact);
        this.artifactVersions.set(current.id, [...versions, record]);
        try {
          const publishHead = () => this.persist(input.workspaceId);
          if (fileAdmission) withCanonicalFileWriteAdmission(fileAdmission, publishHead);
          else publishHead();
        } catch (error) {
          this.unacknowledgedWorkspaces.add(input.workspaceId);
          throw error;
        }
        return structuredClone({
          artifact: record.artifact,
          version: projectArtifactVersion(record),
        });
      });
    }
    const revisionCount = this.itemRevisions.length;
    try {
      this.artifacts.set(current.id, artifact);
      this.artifactVersions.set(current.id, [...versions, record]);
      this.turns.set(turnId, turn);
      this.items.set(itemId, item);
      this.itemRevisions.push(item);
      this.streams.set(turnId, {
        sequence: 0,
        events: [],
        listeners: new Set(),
      });
      this.persist(input.workspaceId);
    } catch (error) {
      this.artifacts.set(current.id, current);
      this.artifactVersions.set(current.id, versions);
      this.turns.delete(turnId);
      this.items.delete(itemId);
      this.streams.delete(turnId);
      this.itemRevisions.length = revisionCount;
      this.persist(input.workspaceId);
      throw error;
    }
    return structuredClone({ artifact: record.artifact, version: projectArtifactVersion(record) });
  }

  /** Projects only a proved native refusal with a currently busy canonical Thread to its existing family error. */
  private throwArtifactTerminalFailure(
    error: unknown,
    workspaceId: string,
    threadId: string
  ): never {
    if (
      error instanceof ControlStoreWorkerError &&
      error.commit === 'not-committed' &&
      error.code === 'precondition' &&
      this.listThreadTurns(workspaceId, threadId).some((turn) => !isSealedTurnTerminal(turn.status))
    )
      throw new ArtifactAuthorityError(
        'thread_busy',
        'The Thread already has a non-terminal Turn.'
      );
    throw error;
  }

  /** Resolves this Workspace's existing single Git content owner. */
  private proposalNotebook(workspaceId: string): KnowledgeNotebook {
    return this.workspaceKnowledgeSelection(workspaceId).notebook;
  }

  /** Reads one exact head and schema using the existing physical Workspace reader. */
  private workspaceKnowledgeSelection(
    workspaceId: string,
    preparedSelection?: WorkspaceNotebookSelection
  ) {
    return readWorkspaceNotebookSelection({
      ...this.workspaceKnowledgeSelectionInput(workspaceId),
      ...(preparedSelection ? { preparedSelection, requirePreparedMatch: true } : {}),
    });
  }

  /** Binds immutable preparation to the same physical Workspace reader as current admission. */
  private workspaceKnowledgeSelectionInput(workspaceId: string) {
    const scope = this.nativeScope({ kind: 'workspace', workspaceId });
    const sqlite =
      scope.sqlite ??
      getWorkspaceProductReadHandle(scope.path, { kind: 'workspace', workspaceId }).sqlite;
    return {
      workspaceRoot: this.workspaceRootPath(workspaceId),
      workspaceDb: { scope: 'workspace' as const, workspaceId, sqlite },
      knowledgeBaseId: readDefaultKnowledgeBaseId({
        dataRoot: this.dataRoot!,
        scope: { kind: 'workspace', workspaceId },
      }),
    };
  }

  /** Prepares exact immutable Proposal inputs, with the existing single-refresh conflict bound. */
  private async prepareWorkspaceKnowledgeProposalReads(
    workspaceId: string,
    revisions: readonly string[] = []
  ): Promise<WorkspaceNotebookSelection> {
    try {
      return await prepareWorkspaceNotebookReads({
        ...this.workspaceKnowledgeSelectionInput(workspaceId),
        revisions,
      });
    } catch (error) {
      if (error instanceof NotebookError && error.code === 'conflict')
        throw knowledgeProposalAuthorityError('conflict');
      throw error;
    }
  }

  /** Refreshes projections only from exact SQL-selected immutable Proposal documents and Reviews. */
  private refreshKnowledgeProposalInventory(
    workspaceId: string,
    prepared?: ReadonlyMap<string, PreparedKnowledgeProposalProjection>
  ): void {
    if (!this.dataRoot) return;
    try {
      const scope = this.nativeScope({ kind: 'workspace', workspaceId });
      const sqlite =
        scope.sqlite ??
        getWorkspaceProductReadHandle(scope.path, { kind: 'workspace', workspaceId }).sqlite;
      const db = { scope: 'workspace' as const, workspaceId, sqlite };
      const root = this.workspaceRootPath(workspaceId);
      const rows = prepared
        ? [...prepared.keys()].map((proposal_id) => ({ proposal_id }))
        : (sqlite
            .prepare('SELECT proposal_id FROM knowledge_notebook_proposals ORDER BY proposal_id')
            .all() as { proposal_id: string }[]);
      const proposals: KnowledgeProposalRecord[] = [];
      const reviews: KnowledgeProposalReviewRecord[] = [];
      for (const row of rows) {
        const current = readControlKnowledgeProposal(db, row.proposal_id);
        if (!current) throw knowledgeProposalAuthorityError('recovery_required');
        const bytes = readImmutableContentBytes(
          {
            root: join(root, 'knowledge', 'content'),
            knowledgeBaseId: current.proposal.knowledgeBaseId,
            mount: current.proposal.documentContent.reference.locator.mount,
          },
          scope.owner,
          current.proposal.documentContent,
          current.proposal.documentContent.byteLength
        );
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const proposal = parseWorkspaceKnowledgeProposalDocument(
          root,
          workspaceId,
          row.proposal_id,
          text,
          prepared?.get(row.proposal_id)
        );
        if (
          proposal.baseRevision !== current.proposal.baseRevision ||
          proposal.candidateRevision !== current.proposal.candidateRevision ||
          proposal.contentDigest !== current.proposal.contentDigest
        )
          throw knowledgeProposalAuthorityError('recovery_required');
        proposals.push(proposal);
        reviews.push(...current.reviews);
      }
      const currentIds = new Set(proposals.map(({ id }) => id));
      for (const [id, record] of this.knowledgeProposals)
        if (record.workspaceId === workspaceId) {
          if (!currentIds.has(id)) this.knowledgeProposals.delete(id);
          this.knowledgeProposalReviews.delete(id);
        }
      for (const proposal of proposals) this.knowledgeProposals.set(proposal.id, proposal);
      for (const review of reviews)
        this.knowledgeProposalReviews.set(review.proposalId, [
          ...(this.knowledgeProposalReviews.get(review.proposalId) ?? []),
          review,
        ]);
    } catch {
      throw knowledgeProposalAuthorityError('recovery_required');
    }
  }

  /** Prepares the original inventory snapshot's immutable facts; current SQL tuples are re-read later. */
  private async prepareKnowledgeProposalProjectionReads(
    workspaceId: string
  ): Promise<ReadonlyMap<string, PreparedKnowledgeProposalProjection>> {
    try {
      const scope = this.nativeScope({ kind: 'workspace', workspaceId });
      const sqlite =
        scope.sqlite ??
        getWorkspaceProductReadHandle(scope.path, {
          kind: 'workspace',
          workspaceId,
        }).sqlite;
      const db = { scope: 'workspace' as const, workspaceId, sqlite };
      const rows = sqlite
        .prepare('SELECT proposal_id FROM knowledge_notebook_proposals ORDER BY proposal_id')
        .all() as { proposal_id: string }[];
      const records = rows.map(({ proposal_id }) => {
        const record = readControlKnowledgeProposal(db, proposal_id);
        if (!record) throw knowledgeProposalAuthorityError('recovery_required');
        return record.proposal;
      });
      const prepared = new Map<string, PreparedKnowledgeProposalProjection>();
      if (!records.length) return prepared;
      const notebook = await new KnowledgeNotebook({
        repositoryPath: join(this.workspaceRootPath(workspaceId), 'knowledge', 'notebook.git'),
      }).withPreparedReadsAsync([
        ...new Set(records.flatMap((record) => [record.baseRevision, record.candidateRevision])),
      ]);
      for (const record of records) {
        prepared.set(record.proposalId, {
          notebook,
          candidate: await notebook.retainedCandidateAsync(record.proposalId),
        });
      }
      return prepared;
    } catch {
      throw knowledgeProposalAuthorityError('recovery_required');
    }
  }

  /** Verifies the exact original without materializing a file body or substituting another version. */
  public assertArtifactContent(artifact: Artifact): void {
    if (artifact.content.format === 'file') {
      if (!this.dataRoot) {
        throw new ArtifactAuthorityError(
          'recovery_required',
          'Artifact file storage is unavailable.'
        );
      }
      try {
        verifyArtifactFilePayload({
          workspaceRoot: this.workspaceRootPath(artifact.workspaceId),
          artifactId: artifact.id,
          version: artifact.version,
          byteLength: artifact.content.byteLength,
          contentDigest: artifact.contentDigest,
        });
      } catch {
        throw new ArtifactAuthorityError('recovery_required', 'The Artifact file is unavailable.');
      }
      return;
    }
    const digest = `sha256:${createHash('sha256').update(artifact.content.body, 'utf8').digest('hex')}`;
    if (digest !== artifact.contentDigest) {
      throw new ArtifactAuthorityError(
        'recovery_required',
        'Artifact content integrity is invalid.'
      );
    }
  }

  /**
   * Creates one deterministic immutable Knowledge Proposal awaiting review.
   *
   * @param input Validated proposal request and server-owned attribution.
   * @returns Stored knowledge proposal.
   */
  public async createKnowledgeProposal(
    input: CreateKnowledgeProposalInput | CreateNotebookProposalInput
  ): Promise<KnowledgeProposalRecord> {
    if (!this.dataRoot) {
      const proposal = await this.prepareKnowledgeProposal(input);
      this.knowledgeProposals.set(proposal.id, proposal);
      return proposal;
    }
    const release = this.enterWorkspaceMutation(input.workspaceId, 'capture');
    const root = this.workspaceRootPath(input.workspaceId);
    const scope = this.nativeScope({ kind: 'workspace', workspaceId: input.workspaceId });
    const reader = openControlStoreProductReadHandle(scope.path, scope.owner);
    const db = bindWorkspaceSqlite(reader.sqlite, this.dataRoot, input.workspaceId);
    try {
      const selected = await this.prepareWorkspaceKnowledgeProposalReads(input.workspaceId);
      const proposal = await this.prepareKnowledgeProposal(input, selected);
      const prepared = await prepareWorkspaceKnowledgeProposal({
        db,
        workspaceRoot: root,
        knowledgeBaseId: selected.head.knowledgeBaseId,
        notebook: selected.notebook,
        proposal,
      });
      // Maintenance's original Turn command is already durable; no nested command receipt is created.
      this.getWorkspace(input.workspaceId);
      const client = getControlStoreWorkerClient();
      const database = `workspace:${scope.path}`;
      await client.open({
        database,
        path: scope.path,
        dataRoot: this.dataRoot,
        create: false,
        initialize: 'workspace',
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      });
      // Preparation and native opening are async boundaries; the current Workspace must still exist.
      this.getWorkspace(input.workspaceId);
      await client.write(database, [
        controlKnowledgeHeadGuardStatement(db, selected.head),
        controlKnowledgeProposalStatement(prepared),
      ]);
      return await this.projectKnowledgeProposalDraftAsync(input.workspaceId, proposal.id);
    } finally {
      db.sqlite.close();
      release();
    }
  }

  /** Prepares the existing immutable candidate without publishing Proposal or Review authority. */
  public async prepareKnowledgeProposal(
    input: CreateKnowledgeProposalInput | CreateNotebookProposalInput,
    preparedSelection?: WorkspaceNotebookSelection
  ): Promise<KnowledgeProposalRecord> {
    this.getWorkspace(input.workspaceId);
    const selection = preparedSelection
      ? this.workspaceKnowledgeSelection(input.workspaceId, preparedSelection)
      : await this.prepareWorkspaceKnowledgeProposalReads(input.workspaceId);
    const notebook = selection.notebook;
    if (notebook.publishedRevision() !== input.baseRevision)
      throw knowledgeProposalAuthorityError('conflict');
    const base = notebook.readRevision(input.baseRevision);
    if (
      'changes' in input &&
      ['knowledgePageId', 'canonicalPageBytes', 'confidence', 'rationale'].some((key) =>
        Object.hasOwn(input, key)
      )
    )
      throw new KnowledgePageValidationError();
    let changes: { path: string; content: string | null }[] | undefined;
    if ('changes' in input) {
      changes = [];
      for (const { path, content } of input.changes) {
        changes.push({
          path,
          content:
            content === null || base.files[path] === content
              ? content
              : attributedNotebookPageBytes(
                  path,
                  content,
                  { kind: 'workspace', workspaceId: input.workspaceId },
                  input.producer.kind === 'agent' ? 'delegated' : 'user-authored'
                ),
        });
        await yieldToMain();
      }
      changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }
    const request =
      'changes' in input
        ? {
            requestId: input.requestId,
            baseRevision: input.baseRevision,
            changes: changes!,
            contentDigest: contentDigest(JSON.stringify(changes)),
            sourceReferences: [...input.sourceReferences],
            rationale: input.summary,
          }
        : KnowledgeManagerDraftProposalRequestSchema.parse({
            requestId: input.requestId,
            baseRevision: input.baseRevision,
            knowledgePageId: input.knowledgePageId,
            canonicalPageBytes: input.canonicalPageBytes,
            contentDigest: input.contentDigest,
            sourceReferences: input.sourceReferences,
            rationale: input.rationale,
            confidence: input.confidence,
          });
    const id = knowledgeProposalId(
      { kind: 'workspace', workspaceId: input.workspaceId },
      request.requestId
    );
    const existing = this.knowledgeProposals.get(id);
    if (existing) throw knowledgeProposalAuthorityError('conflict');
    const proposal = KnowledgeProposalRecordSchema.parse({
      ...request,
      id,
      workspaceId: input.workspaceId,
      operation: 'notebook-change',
      ownerScope: { kind: 'workspace', workspaceId: input.workspaceId },
      candidateRevision: 'pending',
      producer: input.producer,
      createdAt: input.createdAt,
    });
    let validate: PreparedKnowledgeProposalFacts['validate'];
    let knowledgeIds: Set<string> | undefined;
    if (proposal.changes) {
      const files = { ...notebook.readContent(proposal.baseRevision) };
      for (const { path, content } of proposal.changes) {
        if (content === null) delete files[path];
        else files[path] = content;
      }
      validate = await prepareNotebookCandidateValidation({
        ownerScope: proposal.ownerScope,
        base: { files: notebook.readContent(proposal.baseRevision) },
        candidate: { files },
        scopeSchemaText: selection.scopeSchemaText,
        registeredSources: new Map(),
        resolvedReferences: new Map(),
      });
    } else {
      knowledgeIds = new Set();
      for (const [path, content] of Object.entries(base.files)) {
        if (!['index.md', 'log.md'].includes(path.split('/').at(-1)!))
          knowledgeIds.add(parseOwnedKnowledgePage(path, path.slice(0, -3), content).id);
        await yieldToMain();
      }
    }
    this.assertValidKnowledgeProposal(proposal, input.verifiedExternalReferences, {
      selection,
      ...(validate ? { validate } : {}),
      ...(knowledgeIds ? { knowledgeIds } : {}),
    });
    const candidateRevision = await notebook.prepareAsync({
      baseRevision: request.baseRevision,
      changes:
        'changes' in request
          ? Object.fromEntries(request.changes.map(({ path, content }) => [path, content]))
          : { [`${request.knowledgePageId}.md`]: request.canonicalPageBytes },
      metadata: {
        summary: request.rationale,
        changeRequest: {
          requestId: request.requestId,
          inputDigest: commandInputHash({ ...request, producer: input.producer }),
        },
        producer: input.producer,
        authority: { kind: 'proposal', proposalId: id },
        sourceReferences: request.sourceReferences,
      },
    });
    proposal.candidateRevision = candidateRevision;
    await notebook.preloadRevisionAsync(candidateRevision);
    await notebook.retainCandidateAsync({ proposalId: id, candidateRevision });

    return proposal;
  }

  /**
   * Returns one app-local knowledge proposal.
   *
   * @param proposalId Proposal id to inspect.
   * @returns Stored proposal, or null.
   */
  public getKnowledgeProposal(proposalId: string): KnowledgeProposalRecord | null {
    const proposal = this.knowledgeProposals.get(proposalId);
    if (proposal) {
      this.assertWorkspacePublicationAcknowledged(proposal.workspaceId);
      this.refreshKnowledgeProposalInventory(proposal.workspaceId);
    }
    return this.knowledgeProposals.get(proposalId) ?? null;
  }

  /**
   * Projects one immutable Proposal from exact durable authority for receipt replay.
   *
   * @param workspaceId Workspace that owns the proposal.
   * @param proposalId Exact immutable Proposal id to project.
   * @returns Existing Proposal after verifying its canonical file bytes.
   * @throws Error with recovery_required when the owner is missing or changed.
   */
  public projectKnowledgeProposalDraft(
    workspaceId: string,
    proposalId: string
  ): KnowledgeProposalRecord {
    return this.projectKnowledgeProposalDraftWithReads(workspaceId, proposalId);
  }

  /** Prepares exact historical candidate facts off Main before the unchanged native projection checks. */
  public async projectKnowledgeProposalDraftAsync(
    workspaceId: string,
    proposalId: string
  ): Promise<KnowledgeProposalRecord> {
    this.assertWorkspacePublicationAcknowledged(workspaceId);
    const prepared = await this.prepareKnowledgeProposalProjectionReads(workspaceId);
    return this.projectKnowledgeProposalDraftWithReads(
      workspaceId,
      proposalId,
      prepared.get(proposalId),
      prepared
    );
  }

  /** Repeats the original native document and exact candidate tuple predicate after preparation. */
  private projectKnowledgeProposalDraftWithReads(
    workspaceId: string,
    proposalId: string,
    prepared?: PreparedKnowledgeProposalProjection,
    inventory?: ReadonlyMap<string, PreparedKnowledgeProposalProjection>
  ): KnowledgeProposalRecord {
    this.assertWorkspacePublicationAcknowledged(workspaceId);
    this.refreshKnowledgeProposalInventory(workspaceId, inventory);
    const proposal = this.knowledgeProposals.get(proposalId);
    if (!proposal || proposal.workspaceId !== workspaceId) {
      throw knowledgeProposalAuthorityError('recovery_required');
    }
    this.verifiedKnowledgeProposalBytes(proposal, prepared);
    return proposal;
  }

  /** Returns the exact existing immutable Proposal document digest for human Review binding. */
  public knowledgeProposalDigest(workspaceId: string, proposalId: string): string {
    // Projection already verifies the original immutable document and its complete candidate.
    return knowledgeProposalDocumentDigest(
      this.projectKnowledgeProposalDraft(workspaceId, proposalId)
    );
  }

  /**
   * Lists app-local knowledge proposals for one workspace.
   *
   * @param workspaceId Workspace that owns the proposals.
   * @returns Stored knowledge proposal records.
   */
  public listKnowledgeProposals(workspaceId: string): KnowledgeProposalRecord[] {
    this.getWorkspace(workspaceId);
    this.refreshKnowledgeProposalInventory(workspaceId);
    return [...this.knowledgeProposals.values()].filter(
      (proposal) => proposal.workspaceId === workspaceId
    );
  }

  /** Prepares the exact current human decision; the owning native tuple alone publishes it. */
  public prepareKnowledgeProposalReviewDecision(
    input: RecordKnowledgeProposalReviewDecisionInput
  ): SubmitKnowledgeProposalDecisionResponse {
    const proposal = this.knowledgeProposals.get(input.proposalId);
    if (!proposal || proposal.workspaceId !== input.workspaceId)
      throw knowledgeProposalAuthorityError('not_found');
    const command = SubmitKnowledgeProposalDecisionRequestSchema.parse({
      requestId: input.requestId,
      decision: input.decision,
      proposalDigest: input.proposalDigest,
      baseRevision: input.baseRevision,
      candidateRevision: input.candidateRevision,
    });
    const bytes = this.verifiedKnowledgeProposalBytes(proposal);
    if (
      command.proposalDigest !== contentDigest(bytes) ||
      command.baseRevision !== proposal.baseRevision ||
      command.candidateRevision !== proposal.candidateRevision
    )
      throw knowledgeProposalAuthorityError('conflict');
    const decisions = this.knowledgeProposalReviews.get(proposal.id) ?? [];
    if (
      decisions.some(
        (review) => review.decision !== 'deferred' || review.requestId === command.requestId
      )
    )
      throw knowledgeProposalAuthorityError('conflict');
    const accepted = command.decision === 'accepted';
    if (accepted) {
      this.assertNoUnresolvedKnowledgeProposalConflict(proposal);
      this.assertValidKnowledgeProposal(proposal, input.verifiedExternalReferences);
    }
    const notebook = this.proposalNotebook(proposal.workspaceId);
    const base = notebook.readRevision(proposal.baseRevision);
    const review = KnowledgeProposalReviewSchema.parse({
      reviewId: deriveEntityId('kr', {
        ownerScope: proposal.ownerScope,
        proposalId: proposal.id,
        requestId: command.requestId,
      }),
      proposalId: proposal.id,
      workspaceId: proposal.workspaceId,
      ownerScope: proposal.ownerScope,
      baseRevision: proposal.baseRevision,
      candidateRevision: proposal.candidateRevision,
      requestId: command.requestId,
      decision: command.decision,
      actor: input.actor,
      proposalDigest: contentDigest(bytes),
      ...(proposal.changes
        ? { changedPageIds: proposal.changes.map(({ path }) => path.slice(0, -3)) }
        : { knowledgePageId: proposal.knowledgePageId }),
      contentDigest: proposal.contentDigest,
      targetAbsentAtDecision:
        accepted && !proposal.changes
          ? !Object.hasOwn(base.files, `${proposal.knowledgePageId}.md`)
          : null,
      decidedAt: input.decidedAt,
    });
    return SubmitKnowledgeProposalDecisionResponseSchema.parse({
      review,
      application: accepted
        ? {
            ...(proposal.changes
              ? { changedPageIds: proposal.changes.map(({ path }) => path.slice(0, -3)) }
              : { knowledgePageId: proposal.knowledgePageId }),
            contentDigest: proposal.contentDigest,
            present: true,
            notebookRevision: proposal.candidateRevision,
          }
        : null,
    });
  }

  /**
   * Projects one existing decision from exact durable owners without repairing effects.
   *
   * @param workspaceId Workspace that owns the decision.
   * @param reviewId Exact append-only Review row to project.
   * @returns Existing decision response derived from current durable authority.
   * @throws Error with recovery_required when any required owner is missing or changed.
   */
  public projectKnowledgeProposalDecision(
    workspaceId: string,
    reviewId: string
  ): SubmitKnowledgeProposalDecisionResponse {
    this.getWorkspace(workspaceId);
    this.refreshKnowledgeProposalInventory(workspaceId);
    const review = [...this.knowledgeProposalReviews.values()]
      .flat()
      .find(
        (candidate) => candidate.workspaceId === workspaceId && candidate.reviewId === reviewId
      );
    const proposal = review ? this.knowledgeProposals.get(review.proposalId) : null;
    if (!review || !proposal || proposal.workspaceId !== workspaceId) {
      throw knowledgeProposalAuthorityError('recovery_required');
    }
    const proposalBytes = this.verifiedKnowledgeProposalBytes(proposal);
    this.verifiedKnowledgeProposalReview(proposal, review.reviewId, proposalBytes);

    let application: KnowledgeProposalApplication | null = null;
    if (review.decision === 'accepted') {
      const notebook = this.proposalNotebook(workspaceId);
      notebook.history({ revision: proposal.candidateRevision, limit: 1 });
      const pageBytes = notebook.readRevision(proposal.candidateRevision).files[
        `${proposal.knowledgePageId}.md`
      ];
      if (
        !proposal.changes &&
        (pageBytes !== proposal.canonicalPageBytes ||
          pageBytes === undefined ||
          contentDigest(pageBytes) !== proposal.contentDigest)
      )
        throw knowledgeProposalAuthorityError('recovery_required');
      application = {
        ...(proposal.changes
          ? { changedPageIds: proposal.changes.map(({ path }) => path.slice(0, -3)) }
          : { knowledgePageId: proposal.knowledgePageId }),
        contentDigest: proposal.contentDigest,
        present: true,
        notebookRevision: proposal.candidateRevision,
      };
    }

    return SubmitKnowledgeProposalDecisionResponseSchema.parse({ review, application });
  }

  /**
   * Returns the latest recorded decision for one Knowledge Proposal.
   *
   * @param proposalId Proposal id to inspect.
   * @returns Stored proposal review record, or null.
   */
  public getKnowledgeProposalReviewDecision(
    proposalId: string
  ): KnowledgeProposalReviewRecord | null {
    const proposal = this.knowledgeProposals.get(proposalId);
    if (proposal && this.dataRoot)
      return (
        this.listKnowledgeProposalReviewDecisions(proposal.workspaceId)
          .filter((review) => review.proposalId === proposalId)
          .at(-1) ?? null
      );
    const review = this.knowledgeProposalReviews.get(proposalId)?.at(-1);
    if (review) this.assertWorkspacePublicationAcknowledged(review.workspaceId);
    return review ?? null;
  }

  /**
   * Lists app-local knowledge proposal review decisions for one workspace.
   *
   * @param workspaceId Workspace that owns the decisions.
   * @returns Stored proposal review records.
   */
  public listKnowledgeProposalReviewDecisions(
    workspaceId: string
  ): KnowledgeProposalReviewRecord[] {
    this.getWorkspace(workspaceId);
    if (!this.dataRoot)
      return [...this.knowledgeProposalReviews.values()]
        .flat()
        .filter((review) => review.workspaceId === workspaceId);
    try {
      const scope = this.nativeScope({ kind: 'workspace', workspaceId });
      const sqlite =
        scope.sqlite ??
        getWorkspaceProductReadHandle(scope.path, { kind: 'workspace', workspaceId }).sqlite;
      const db = { scope: 'workspace' as const, workspaceId, sqlite };
      const rows = sqlite
        .prepare('SELECT proposal_id FROM knowledge_notebook_proposals ORDER BY rowid')
        .all() as { proposal_id: string }[];
      return rows.flatMap(({ proposal_id }) => {
        const state = readControlKnowledgeProposal(db, proposal_id);
        if (!state) throw knowledgeProposalAuthorityError('recovery_required');
        return state.reviews;
      });
    } catch {
      throw knowledgeProposalAuthorityError('recovery_required');
    }
  }

  /**
   * Returns one Workspace Source metadata projection from the published Notebook.
   *
   * @param workspaceId Workspace that owns the source.
   * @param sourceId Source id to return.
   * @returns Stored source identity record.
   */
  public getKnowledgeSource(workspaceId: string, sourceId: string): KnowledgeSourceRecord {
    const source = this.listKnowledgeSources(workspaceId).find((source) => source.id === sourceId);
    if (!source) throw new StoreRecordNotFoundError(`Knowledge source not found: ${sourceId}`);
    return source;
  }

  /**
   * Lists Source metadata from the current Workspace Notebook.
   *
   * @param workspaceId Workspace that owns the sources.
   * @returns Stored source identity records.
   */
  public listKnowledgeSources(workspaceId: string): KnowledgeSourceRecord[] {
    this.getWorkspace(workspaceId);
    if (!this.dataRoot) return [];
    return [
      ...readSourcePointers(
        {
          dataRoot: this.dataRoot,
          ownerScope: { kind: 'workspace', workspaceId },
        },
        undefined,
        this.workspaceKnowledgeSelection(workspaceId)
      ).values(),
    ].map(({ source }) => ({ ...source, workspaceId }));
  }

  /**
   * Emits one Turn event, admitting completion of an already-decided terminal event after the Turn is sealed.
   *
   * @param args Turn identity, event payload and optional admitted post-terminal category.
   * @returns Stored envelope.
   * @throws Error when the stream is missing, lineage is invalid, or a post-terminal write is not admitted.
   */
  public async persistTurnEvent(
    ...args: Parameters<FsStore['persistTurnEventPublication']>
  ): Promise<SseEventEnvelope> {
    const owner = this.dataRoot
      ? { kind: 'workspace' as const, workspaceId: args[1].workspaceId }
      : this.getTurnById(args[0]).owner;
    return this.publishTurn(owner, [args[0]], args, (owned) =>
      this.persistTurnEventPublication(...owned)
    );
  }

  /** Applies the original checks inside the admitted same-Turn boundary. */
  private async persistTurnEventPublication(
    turnId: string,
    event: TurnEventInput,
    admission?: TerminalTurnWriteAdmission
  ): Promise<SseEventEnvelope> {
    if (this.dataRoot) {
      const scope = this.nativeScope({ kind: 'workspace', workspaceId: event.workspaceId });
      const client = getControlStoreWorkerClient();
      const database = `workspace:${scope.path}`;
      await client.open({
        database,
        path: scope.path,
        dataRoot: this.dataRoot,
        create: false,
        initialize: 'workspace',
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      });
      const envelope = await client.appendEvent(database, {
        turnId,
        event: {
          ...event,
          requestId: projectTurnEventRequestId(event.requestId, event.workspaceId, event.threadId),
        },
        timestamp: now(),
        ...(admission ? { category: admission.category } : {}),
      });
      this.acknowledgedTurnEvents.set(envelope, structuredClone(envelope));
      return envelope;
    }
    const turn = this.getTurnById(turnId);
    const events = this.getTurnEventsForExport(turnId);
    const stream = { sequence: events.at(-1)?.sequence ?? 0, events };
    const projectedRequestId = projectTurnEventRequestId(
      event.requestId,
      event.workspaceId,
      event.threadId
    );
    if (isSealedTurnTerminal(turn.status)) {
      const existingIdentical = stream.events.find(
        (candidate) =>
          candidate.event === event.event &&
          candidate.workspaceId === event.workspaceId &&
          candidate.threadId === event.threadId &&
          candidate.turnId === event.turnId &&
          candidate.requestId === projectedRequestId &&
          alreadyDecidedPublicationBytesEqual(candidate.data, event.data)
      );
      if (existingIdentical) {
        this.acknowledgedTurnEvents.set(existingIdentical, structuredClone(existingIdentical));
        return existingIdentical;
      }
      if (eventConflictsWithSealedTurnOutcome(turn, event)) {
        throw terminalTurnPublicationConflict(turn.id);
      }
      if (
        admission?.category !== 'already-decided-publication' &&
        !eventAgreesWithSealedTurnOutcome(turn, event)
      ) {
        throw terminalTurnWriteRejected(turn.id);
      }
    }

    const envelope = SseEventEnvelopeSchema.parse({
      ...event,
      protocolVersion: PROTOCOL_VERSION,
      requestId: projectedRequestId,
      sequence: stream.sequence + 1,
      timestamp: now(),
    });

    if (
      envelope.workspaceId !== workspaceIdForOwner(turn.owner) ||
      envelope.threadId !== turn.threadId ||
      envelope.turnId !== turn.id
    ) {
      throw new Error(`Turn event ${envelope.event} has invalid lineage for ${turnId}.`);
    }
    assertTurnEventPayloadLineage(
      envelope,
      workspaceIdForOwner(turn.owner),
      turn.threadId,
      turn.id,
      new Set(turn.items.map((item) => item.id))
    );
    const state = this.turnStream(turnId);
    state.sequence = envelope.sequence;
    state.events.push(envelope);
    if (state.events.length > TURN_STREAM_EVENT_WINDOW_SIZE) state.events.shift();
    this.acknowledgedTurnEvents.set(envelope, structuredClone(envelope));
    return envelope;
  }

  /** Publishes a durable event synchronously after all awaited persistence and cleanup preparation. */
  public emitTurnEvent(turnId: string, envelope: SseEventEnvelope): SseEventEnvelope {
    const committed = this.acknowledgedTurnEvents.get(envelope);
    if (
      !committed ||
      !('workspaceId' in committed) ||
      committed.turnId !== turnId ||
      !alreadyDecidedPublicationBytesEqual(committed, envelope)
    )
      throw new Error('Turn notification requires its exact acknowledged native event.');
    for (const listener of this.turnStream(turnId).listeners) listener(structuredClone(envelope));
    return envelope;
  }

  public addTurnListener(turnId: string, listener: EventListener): () => void {
    this.assertTurnPublicationAcknowledged(turnId);
    this.getTurnById(turnId);
    const stream = this.turnStream(turnId);

    if (!stream) {
      throw new StoreRecordNotFoundError(`Turn stream not found: ${turnId}`);
    }

    stream.listeners.add(listener);

    return () => {
      stream.listeners.delete(listener);
    };
  }

  public getTurnEvents(turnId: string): SseEventEnvelope[] {
    return this.dataRoot
      ? this.getTurnEventsForExport(turnId).slice(-TURN_STREAM_EVENT_WINDOW_SIZE)
      : [...(this.streams.get(turnId)?.events ?? [])];
  }

  /**
   * Returns the complete durable event history used by workspace export.
   *
   * @param turnId Turn whose event log should be exported.
   * @returns Full canonical history, or the in-memory history when persistence is disabled.
   */
  public getTurnEventsForExport(turnId: string): SseEventEnvelope[] {
    const turn = this.getTurnById(turnId);
    return this.dataRoot
      ? readWorkspaceTurnEvents(this.workspaceRootPath(workspaceIdForOwner(turn.owner)), turn)
      : this.getTurnEvents(turnId);
  }
}
