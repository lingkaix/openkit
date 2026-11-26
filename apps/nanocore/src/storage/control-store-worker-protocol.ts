import { isAbsolute } from 'node:path';
import {
  ApplyKnowledgeSchemaRequestSchema,
  type ApplyKnowledgeSchemaResponse,
  ApplyKnowledgeSchemaResponseSchema,
  GoalViewSchema,
  PreviewKnowledgeSchemaResponseSchema,
  type ServerEvidenceBundleRecord,
  ServerEvidenceBundleRecordSchema,
} from '@openkit/app-api-schemas';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import {
  ActorRefSchema,
  AuditEventSchema,
  deriveEntityId,
  GatewayRouteLineageEntrySchema,
  ItemSchema,
  KernelAuditEvidenceSchema,
  KnowledgeBaseIdSchema,
  PolicyDigestV1Schema,
  PolicyDocumentV1Schema,
  RequestIdSchema,
  SseEventEnvelopeSchema,
  TimestampSchema,
  UserActorRefSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import {
  type ControlReviewCommandInput,
  ControlReviewCommandInputSchema,
  type ControlReviewCommandResult,
  ControlReviewCommandResultSchema,
} from '../artifact-review-codecs.js';
import {
  type ControlAccessTokenLifecycle,
  type ControlAccessTokenLifecycleResult,
  ControlAccessTokenLifecycleResultSchema,
  ControlAccessTokenLifecycleSchema,
} from '../auth/access-token-lifecycle-codecs.js';
import {
  ADMIN_RECOVERY_REQUIRED,
  type ControlAdminRecoveryInput,
  ControlAdminRecoveryInputSchema,
} from '../auth/admin-recovery-codecs.js';
import {
  type ControlBetterAuthInput,
  ControlBetterAuthInputSchema,
  type ControlBetterAuthResult,
  ControlBetterAuthResultSchema,
  isBetterAuthRefusal,
} from '../auth/better-auth-codecs.js';
import {
  type ControlBootstrapConsume,
  type ControlBootstrapConsumeResult,
  ControlBootstrapConsumeResultSchema,
  ControlBootstrapConsumeSchema,
} from '../auth/bootstrap-consume-codecs.js';
import {
  type ControlBootstrapEnsure,
  type ControlBootstrapEnsureResult,
  ControlBootstrapEnsureResultSchema,
  ControlBootstrapEnsureSchema,
} from '../auth/bootstrap-ensure-codecs.js';
import type { Actor } from '../auth/identity.js';
import {
  type ControlLocalIdentity,
  ControlLocalIdentityResultSchema,
  ControlLocalIdentitySchema,
} from '../auth/local-identity-codecs.js';
import {
  type ControlNanoHostTransportInput,
  ControlNanoHostTransportInputSchema,
  type ControlNanoHostTransportResult,
  ControlNanoHostTransportResultSchema,
  isNanoHostTransportAdminRefusal,
} from '../auth/nanohost-transport-codecs.js';
import type { ScopeAdmissionFailure } from '../bootstrap/readiness.js';
import {
  ControlAppRefusalSchema,
  type ControlAppResult,
  ControlAppResultSchema,
  type ControlAppScope,
  ControlAppScopeSchema,
  type ControlAppWire,
  ControlAppWireSchema,
} from '../generative-kernel/native-command-codecs.js';
import {
  type ControlGenerativePresentationWire,
  ControlGenerativePresentationWireSchema,
} from '../generative-ui/native-publication-codecs.js';
import { ITEM_DELTA_PROTOCOL_MESSAGE } from '../lib/item-delta-validation.js';
import {
  type ControlExecutionJournalInput,
  ControlExecutionJournalInputSchema,
} from '../runtime/execution-journal.js';
import type { ExecutionStepRef } from '../runtime/execution-step-journal.js';
import {
  type ControlGoalCommandResult,
  type ControlGoalInput,
  ControlGoalInputSchema,
} from '../runtime/goal-codecs.js';
import type { IdempotentCommandReceipt } from '../runtime/idempotent-command.js';
import type { AdmittedNanoHostAttemptRecovery } from '../runtime/nanohost-attempt-recovery.js';
import { ControlPendingCommandResultSchema } from '../runtime/pending-request-codecs.js';
import type { ControlPendingCommandResult } from '../runtime/pending-requests.js';
import {
  ProjectWorkerBackendCleanupInputSchema,
  WorkerBackendCleanupProjectionResultSchema,
} from '../runtime/worker-backend-cleanup-codecs.js';
import type {
  ProjectWorkerBackendCleanupInput,
  WorkerBackendCleanupProjectionResult,
} from '../runtime/worker-backend-cleanup-projection.js';
import {
  type ControlWorkerRejectedEvidence,
  ControlWorkerRejectedEvidenceSchema,
} from '../runtime/worker-control-rejected-evidence-codecs.js';
import { WorkerImageSettlementSchema } from '../runtime/worker-image-settlements-records.js';
import {
  type ControlMaterialCommandResult,
  ControlMaterialCommandResultSchema,
  type ControlMaterialWireInput,
  ControlMaterialWireInputSchema,
  controlMaterialTextSpans,
} from '../workspace-materials.js';
import {
  type ControlAccessTokenVerification,
  type ControlAccessTokenVerificationResult,
  ControlAccessTokenVerificationResultSchema,
  ControlAccessTokenVerificationSchema,
} from './access-token-verification-codecs.js';
import {
  type ControlAutomationScanner,
  type ControlAutomationScannerResult,
  ControlAutomationScannerResultSchema,
  ControlAutomationScannerSchema,
} from './automation-scanner-codecs.js';
import type {
  CommunicationWriterCommand,
  CommunicationWriterReply,
} from './communication-writer.js';
import type { ControlKernelStore } from './control-kernel-port.js';
import {
  ChannelInboundEnvelopeSchema,
  ChannelInboundKeySchema,
  ChannelInboundOriginSchema,
  ChannelInboundOutcomeSchema,
  type ControlAdmissionInput,
  ControlAdmissionInputSchema,
  type ControlAdmissionResult,
  ControlKnowledgeAdmissionInputSchema,
  type ControlKnowledgeAdmissionResult,
  ControlKnowledgeAdmissionResultSchema,
  type CoreSchedulerRefusal,
  CoreSchedulerRefusalSchema,
  type CoreSchedulerResult,
  CoreSchedulerResultSchema,
  type CoreSchedulerWire,
  CoreSchedulerWireSchema,
  PairingAuditIntentSchema,
  WorkspaceQueueInputWriteSchema,
} from './control-store-admission-codecs.js';
import {
  type ControlCapabilityCommandResult,
  ControlCapabilityCommandResultSchema,
  type ControlCapabilityWireInput,
  ControlCapabilityWireInputSchema,
  type ControlMcpItemCall,
  ControlMcpItemCallSchema,
  controlCapabilityText,
} from './control-store-capability.js';
import {
  type ControlScalarText,
  ControlScalarTextSchema,
  commandInputHash,
  readControlScalarText,
} from './control-store-input.js';
import {
  controlKnowledgeContentSchema,
  decodeControlKnowledgeHead,
} from './control-store-knowledge-heads.js';
import { type ControlPendingPlan, ControlPendingPlanSchema } from './control-store-pending-plan.js';
import {
  CONTROL_PRODUCT_LIMITS,
  type ControlProductContentMount,
  ControlProductContentMountSchema,
  ControlProductEntrySchema,
  ControlProductMutationSchema,
  type ControlProductOwner,
  type ControlProductTransition,
  ControlProductTransitionSchema,
} from './control-store-product-records.js';
import {
  type ControlEventAppend,
  type ControlEventAppendResult,
  ControlEventAppendSchema,
  type ControlTerminalResult,
} from './control-store-products.js';
import {
  type ControlItemAppend,
  ControlItemAppendSchema,
  type ControlPendingTransition,
  ControlPendingTransitionSchema,
  type ControlPublicationInput,
  ControlPublicationInputSchema,
  type ControlTerminalTransition,
  ControlTerminalTransitionSchema,
  controlProductMetadataJson,
} from './control-store-publication-codecs.js';
import type {
  ControlRecoveryCaptureInput,
  ControlRecoveryCleanupInput,
  ControlRecoveryMoveOutInput,
  ControlRecoverySafetyInput,
  ControlRecoverySafetyResult,
} from './control-store-recovery.js';
import {
  type ControlCoreImageResult,
  ControlCoreImageResultSchema,
  type ControlCoreJournalInput,
  ControlCoreJournalInputSchema,
  ControlCoreJournalRefusalSchema,
  ControlCoreNanoHostAcceptedFinalResultSchema,
  ControlCoreNanoHostFinalDecisionSchema,
  type ControlNanoHostFirstSubmissionInput,
  ControlNanoHostFirstSubmissionInputSchema,
  type ControlNanoHostFirstSubmissionResult,
  ControlNanoHostFirstSubmissionResultSchema,
  type ControlNanoHostTerminalReleaseInput,
  ControlNanoHostTerminalReleaseInputSchema,
} from './core-journal-codecs.js';
import {
  type ControlEvaluationCandidate,
  ControlEvaluationCandidateResultSchema,
  ControlEvaluationCandidateSchema,
} from './evaluation-candidate-codecs.js';
import {
  type ControlExecutionAttemptInput,
  ControlExecutionAttemptInputSchema,
  ControlExecutionAttemptRefusalSchema,
  type ControlExecutionAttemptResult,
  ControlExecutionAttemptResultSchema,
} from './execution-attempt-codecs.js';
import {
  type ControlHarnessLifecycleInput,
  ControlHarnessLifecycleInputSchema,
  ControlHarnessLifecycleRefusalSchema,
  type ControlHarnessLifecycleResult,
  ControlHarnessLifecycleResultSchema,
} from './harness-lifecycle-codecs.js';
import { SPLIT_STORAGE_JOURNALS, type SplitStorageOwner } from './migrate.js';
import type { NanoHostEpochPlacement } from './nanohost-epoch-invalidation.js';
import {
  type NanoHostRuntimeTargetTransition,
  NanoHostRuntimeTargetTransitionSchema,
} from './nanohost-epoch-invalidation-codecs.js';
import {
  type NanoHostEpochKernelInput,
  NanoHostEpochKernelInputSchema,
  type NanoHostEpochKernelReply,
  NanoHostEpochKernelReplySchema,
} from './nanohost-epoch-kernel-codecs.js';
import type { NanoHostEpochInvalidation, NanoHostEpochReceipt } from './nanohost-port.js';
import { NanoHostWorkerRecoveryState } from './nanohost-recovery-native.js';
import {
  type ControlPrivateWorkspaceInput,
  ControlPrivateWorkspaceInputSchema,
  ControlPrivateWorkspaceRefusalSchema,
  ControlPrivateWorkspaceResultSchema,
} from './private-workspace-codecs.js';
import {
  type ControlRemoteMcpAudit,
  ControlRemoteMcpAuditSchema,
} from './remote-mcp-audit-codecs.js';
import {
  type RepairWorkerInput,
  RepairWorkerInputSchema,
  type RepairWorkerReply,
  RepairWorkerReplySchema,
} from './repair-kernel-codecs.js';
import {
  type ControlResolvedAgentSetupInput,
  ControlResolvedAgentSetupInputSchema,
  ControlResolvedAgentSetupRefusalSchema,
  type ControlResolvedAgentSetupResult,
  ControlResolvedAgentSetupResultSchema,
} from './resolved-agent-setup-codecs.js';
import { StoredWorkOwnerV1Schema } from './retained-work-metadata-v1.js';
import {
  type RuntimePolicyPublicationInput,
  RuntimePolicyPublicationInputSchema,
  type RuntimePolicyPublicationResult,
  RuntimePolicyPublicationResultSchema,
} from './runtime-policy-publication.js';
import {
  type ControlRuntimeTargetInput,
  ControlRuntimeTargetInputSchema,
  ControlRuntimeTargetRefusalSchema,
  type ControlRuntimeTargetResult,
  ControlRuntimeTargetResultSchema,
} from './runtime-target-codecs.js';
import {
  type ControlScopedNotebookSqlInput,
  ControlScopedNotebookSqlInputSchema,
} from './scoped-notebook-sql-codecs.js';
import {
  type ControlSecurityTrigger,
  ControlSecurityTriggerRefusalSchema,
  type ControlSecurityTriggerResult,
  ControlSecurityTriggerResultSchema,
  ControlSecurityTriggerSchema,
} from './security-trigger-codecs.js';
import {
  type ControlServerAdminTokenDefault,
  ControlServerAdminTokenDefaultSchema,
} from './server-admin-token-default-codecs.js';
import type {
  ServerCallAdmission,
  ServerWorkIntent,
  ServerWorkReceipt,
} from './server-work-port.js';
import type { StorageDecision, StorageResult } from './storage-owner.js';
import {
  type ControlThreadReadMembershipWire,
  ControlThreadReadMembershipWireSchema,
  THREAD_READ_RECEIPT_INVALID,
  ThreadReadMembershipResultSchema,
} from './thread-read-membership-codecs.js';
import {
  type ControlVaultInput,
  ControlVaultInputSchema,
  type ControlVaultResult,
  ControlVaultResultSchema,
  isControlVaultRefusal,
} from './vault-native-codecs.js';
import {
  OBSERVATION_POSITION_CONFLICT,
  ObservationOmissionResultSchema,
} from './work-observation-collection.js';
import {
  ControlWorkObservationChunkInputSchema,
  type ControlWorkObservationCommandInput,
  ControlWorkObservationInputSchema,
  type ControlWorkObservationResult,
  parseWorkObservationRecord,
  type RetainedWorkObservation,
} from './work-observations.js';
import {
  type ControlBackendSessionInput,
  ControlBackendSessionInputSchema,
  ControlBackendSessionRefusalSchema,
  type ControlBackendSessionResult,
  ControlBackendSessionResultSchema,
} from './worker-backend-session-codecs.js';
import {
  type ControlWorkerFinalStatusInput,
  ControlWorkerFinalStatusInputSchema,
  ControlWorkerFinalStatusRefusalSchema,
  type ControlWorkerFinalStatusResult,
  ControlWorkerFinalStatusResultSchema,
} from './worker-control-final-status-codecs.js';
import {
  type ControlWorkerHeartbeatInput,
  ControlWorkerHeartbeatInputSchema,
  ControlWorkerHeartbeatRefusalSchema,
  type ControlWorkerHeartbeatResult,
  ControlWorkerHeartbeatResultSchema,
} from './worker-control-heartbeat-codecs.js';
import {
  type ControlWorkerRecordInput,
  ControlWorkerRecordInputSchema,
  ControlWorkerRecordRefusalSchema,
  type ControlWorkerRecordResult,
  ControlWorkerRecordResultSchema,
} from './worker-control-record-codecs.js';
import {
  type ControlWorkerImageInput,
  ControlWorkerImageInputSchema,
  ControlWorkerImageRefusalSchema,
} from './worker-image-codecs.js';
import {
  type ControlWorkerStorageInput,
  ControlWorkerStorageInputSchema,
  ControlWorkerStorageRefusalSchema,
  ControlWorkerStorageResultSchema,
} from './worker-storage-binding-codecs.js';
import {
  type ControlWorkspaceApplyPlan,
  ControlWorkspaceApplyPlanSchema,
} from './workspace-apply-plan-codecs.js';
import {
  type ControlWorkspaceBackendHandoff,
  ControlWorkspaceBackendHandoffRefusalSchema,
  type ControlWorkspaceBackendHandoffResult,
  ControlWorkspaceBackendHandoffResultSchema,
  ControlWorkspaceBackendHandoffSchema,
} from './workspace-backend-handoff-codecs.js';
import {
  type ControlWorkspaceBaseline,
  ControlWorkspaceBaselineRefusalSchema,
  ControlWorkspaceBaselineSchema,
} from './workspace-baseline-codecs.js';
import {
  type ControlWorkspaceCapture,
  ControlWorkspaceCaptureRefusalSchema,
  type ControlWorkspaceCaptureResult,
  ControlWorkspaceCaptureResultSchema,
  ControlWorkspaceCaptureSchema,
} from './workspace-capture-codecs.js';
import {
  type ControlWorkspaceDeletionInput,
  ControlWorkspaceDeletionInputSchema,
  type ControlWorkspaceDeletionResult,
  ControlWorkspaceDeletionResultSchema,
} from './workspace-deletion-codecs.js';
import {
  type ControlRecoverySourceReactivationInput,
  ControlRecoverySourceReactivationInputSchema,
  ControlRecoverySourceReactivationRefusalSchema,
} from './workspace-reactivation-codecs.js';
import type { WorkspaceRecoveryCliReport } from './workspace-recovery-cli.js';
import {
  type ControlWorkspaceRecoveryDecision,
  ControlWorkspaceRecoveryDecisionRefusalSchema,
  ControlWorkspaceRecoveryDecisionResultSchema,
  ControlWorkspaceRecoveryDecisionSchema,
} from './workspace-recovery-decision-codecs.js';
import {
  type ControlRecoveryTargetPreparationInput,
  ControlRecoveryTargetPreparationInputSchema,
  type ControlRecoveryTargetRegistrationInput,
  ControlRecoveryTargetRegistrationInputSchema,
  ControlRecoveryTargetRegistrationRefusalSchema,
  ControlRecoveryTargetRegistrationResultSchema,
} from './workspace-recovery-target-codecs.js';
import {
  type ControlWorkspaceReviewDecision,
  ControlWorkspaceReviewDecisionResultSchema,
  ControlWorkspaceReviewDecisionSchema,
  type ControlWorkspaceReviewFinish,
  ControlWorkspaceReviewFinishSchema,
  WORKSPACE_REVIEW_REFUSALS,
} from './workspace-review-codecs.js';
import {
  type ControlCoreSharing,
  ControlCoreSharingActorSchema,
  type ControlCoreSharingRefusal,
  ControlCoreSharingRefusalSchema,
  type ControlCoreSharingResult,
  ControlCoreSharingResultSchema,
  ControlCoreSharingSchema,
} from './workspace-sharing-codecs.js';
import {
  type ControlWorkspaceStageReview,
  ControlWorkspaceStageReviewRefusalSchema,
  ControlWorkspaceStageReviewSchema,
} from './workspace-stage-review-codecs.js';
import {
  type ControlWorkspaceTakeover,
  ControlWorkspaceTakeoverRefusalSchema,
  ControlWorkspaceTakeoverResultSchema,
  ControlWorkspaceTakeoverSchema,
} from './workspace-takeover-codecs.js';

/** Internal wire version; effect-bearing initialization requires matching peers, not a retained-format migration. */
export const CONTROL_WORKER_VERSION = 98;

/** Original admitted slot identity; the relay derives these from real host/opening bindings. */
export const ControlPolicyBorrowerSchema = z
  .object({
    host: z
      .number()
      .int()
      .positive()
      .safe()
      .refine((host) => host <= CONTROL_WORKER_LIMITS.workspaceWorkers),
    database: z.string().min(1),
    openingRequestId: z.number().int().nonnegative().safe(),
    requestId: z.number().int().nonnegative().safe(),
    workspaceId: WorkspaceIdSchema,
  })
  .strict();
export const ControlPolicyBindingSchema = z
  .object({
    coreDatabase: z.string().min(1),
    coreIdentity: z.string().regex(/^\d+:\d+$/),
    openingId: z.uuid(),
    publisherId: z.uuid(),
    transitionId: z.uuid(),
    borrower: ControlPolicyBorrowerSchema,
  })
  .strict();
/** Issued by the actual Core publication owner, never reconstructed from inspect. */
export const ControlPolicyGrantSchema = z
  .object({
    binding: ControlPolicyBindingSchema,
    policy: z
      .object({
        serverRevision: PolicyDigestV1Schema,
        workspaceRevision: PolicyDigestV1Schema.nullable(),
      })
      .strict(),
  })
  .strict();
export type ControlPolicyBinding = z.infer<typeof ControlPolicyBindingSchema>;
export type ControlPolicyGrant = z.infer<typeof ControlPolicyGrantSchema>;

/** Non-retained inputs from the original Main Policy, Review and scope-admission owners. */
const schemaApplicationActor = ControlCoreSharingActorSchema.transform(
  (actor): Actor => ({
    kind: actor.kind,
    userId: actor.userId,
    ...(actor.sessionId !== undefined ? { sessionId: actor.sessionId } : {}),
    ...(actor.tokenId !== undefined ? { tokenId: actor.tokenId } : {}),
    ...(actor.tokenScope !== undefined ? { tokenScope: actor.tokenScope } : {}),
    ...(actor.tokenWorkspaceIds !== undefined
      ? { tokenWorkspaceIds: actor.tokenWorkspaceIds }
      : {}),
    ...(actor.adminTokenId !== undefined ? { adminTokenId: actor.adminTokenId } : {}),
  })
);

export const ControlSchemaApplicationFactsSchema = z
  .object({
    presentedActor: schemaApplicationActor,
    effectivePolicy: PolicyDocumentV1Schema,
    reviewRequiredPageIds: z.array(z.string()),
    scopeRefusals: z.array(
      z
        .object({
          scope: z.enum(['workspace', 'user']),
          id: z.string().min(1),
          check: z.enum(['layout', 'database', 'records', 'recovery', 'index', 'retired']),
          requiredFeature: z.string().optional(),
        })
        .strict()
        .transform(
          ({ requiredFeature, ...failure }): ScopeAdmissionFailure =>
            requiredFeature === undefined ? failure : { ...failure, requiredFeature }
        )
    ),
  })
  .strict();

/** The exact same synchronous supplier is used before posting and before physical admission. */
export type ControlSchemaApplicationFacts = z.infer<typeof ControlSchemaApplicationFactsSchema>;

const schemaApplicationReceipt = z
  .object({
    key: z.string().min(1),
    command: z.literal('knowledge.schema.apply'),
    requestId: RequestIdSchema,
    scope: z.record(z.string(), z.string()),
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    responseKind: z.literal('knowledge_schema_report'),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict() satisfies z.ZodType<IdempotentCommandReceipt>;

/** One closed schema application; current authority and dependency decisions remain in native owners. */
export const ControlSchemaApplicationInputSchema = z
  .object({
    request: ApplyKnowledgeSchemaRequestSchema,
    requestActor: schemaApplicationActor,
    producer: UserActorRefSchema,
    receipt: schemaApplicationReceipt,
    candidateHead: z
      .object({
        workspaceId: WorkspaceIdSchema,
        knowledgeBaseId: KnowledgeBaseIdSchema,
        notebookCommit: z.string().min(1),
        schemaContent: controlKnowledgeContentSchema,
      })
      .strict()
      .transform((head, context) => {
        try {
          return decodeControlKnowledgeHead({ ...head, requiredFeatures: [] });
        } catch {
          context.addIssue({ code: 'custom', message: 'Invalid Workspace Knowledge head.' });
          return z.NEVER;
        }
      }),
    facts: ControlSchemaApplicationFactsSchema,
  })
  .strict();

/** Complete typed payload transported through the original binary content account. */
export type ControlSchemaApplicationInput = z.infer<typeof ControlSchemaApplicationInputSchema>;

/** The original Workspace input reference and its bounded UTF-8 frame. */
export const ControlWorkspaceQueueInputWireSchema = WorkspaceQueueInputWriteSchema.omit({
  text: true,
})
  .extend(ControlScalarTextSchema.shape)
  .refine(
    (wire) =>
      wire.input.owner.workspaceId === wire.workspaceId &&
      wire.digest === `sha256:${wire.input.digest}` &&
      wire.byteLength <= CONTROL_PRODUCT_LIMITS.immutableBodyBytes &&
      Buffer.byteLength(JSON.stringify(wire)) <= CONTROL_PRODUCT_LIMITS.metadataBytes
  );

/** Exact original scalar frame; reports have no new per-report maximum. */
export const ControlSchemaApplicationWireSchema = ControlScalarTextSchema.extend({
  workspaceId: WorkspaceIdSchema,
}).strict();

/** Closed native envelope, separate from the complete schema application payload. */
export type ControlSchemaApplicationWire = z.infer<typeof ControlSchemaApplicationWireSchema>;

/** Decodes exact UTF-8 bytes and the original domain codecs before native computation. */
export function readControlSchemaApplicationInput(
  wire: ControlSchemaApplicationWire,
  content: ArrayBuffer
): ControlSchemaApplicationInput {
  const input = ControlSchemaApplicationInputSchema.parse(
    JSON.parse(readControlScalarText(wire, content))
  );
  if (
    input.request.workspaceId !== wire.workspaceId ||
    input.candidateHead.workspaceId !== wire.workspaceId
  )
    throw new TypeError('Schema application Workspace does not match its native owner.');
  return input;
}

/** The original prepared boot event under its exact Core Audit identity. */
export const ControlBootAuditInputSchema = AuditEventSchema.extend({
  category: z.literal('system'),
  workspaceId: z.null(),
  turnId: z.null(),
  createdAt: TimestampSchema,
  occurredAt: TimestampSchema,
  kernelEvidence: KernelAuditEvidenceSchema,
}).refine((event) => {
  const evidence = event.kernelEvidence;
  return (
    'bootId' in evidence &&
    event.action === evidence.kind &&
    event.resource === `server:boot:${evidence.bootId}` &&
    event.id === deriveEntityId('aud', [evidence.bootId, evidence.kind.slice('boot.'.length)])
  );
});

/** Validated lifecycle facts; this wire carries neither SQL nor a new durable record. */
export type ControlBootAuditInput = z.infer<typeof AuditEventSchema> & {
  readonly createdAt: string;
  readonly occurredAt: string;
};

/** Physical copy sizes selected after admitted predecessors, while the original FIFO slot remains held. */
export const ControlPhysicalForecastSchema = z
  .object({
    version: z.literal(CONTROL_WORKER_VERSION),
    id: z.number().int().nonnegative().safe(),
    database: z.string().min(1),
    status: z.literal('physical-forecast'),
    files: z
      .array(
        z
          .object({
            path: z.string().refine(isAbsolute),
            publicationBytes: z.number().int().nonnegative().safe(),
          })
          .strict()
      )
      .min(1),
  })
  .strict()
  .refine(
    (forecast) =>
      new Set(forecast.files.map((file) => file.path)).size === forecast.files.length &&
      Buffer.byteLength(JSON.stringify(forecast)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
  );

/** Synchronous admission answer for the existing request, never another queued operation. */
export const ControlPhysicalForecastDecisionSchema = z
  .object({
    version: z.literal(CONTROL_WORKER_VERSION),
    id: z.number().int().nonnegative().safe(),
    database: z.string().min(1),
    operation: z.literal('physical-forecast'),
    decision: z.enum(['admitted', 'no-space', 'unavailable', 'precondition']),
  })
  .strict();

/** Exact post-predecessor publication forecast on each affected filesystem. */
export type ControlPhysicalForecastFiles = z.infer<typeof ControlPhysicalForecastSchema>['files'];

/** Exact admitted provenance sources; bytes stay on the affected filesystem, never in the message. */
export const ControlProvenanceInputSchema = z
  .object({
    workspaceId: z.string().min(1),
    turnId: z.string().min(1),
    backend: z
      .object({
        kind: z.string(),
        placement: z.enum(['local', 'remote', 'unknown']),
        version: z.string().nullable(),
      })
      .strict(),
    collectedAt: z.string(),
    environmentPackage: AgentEnvironmentPackageSchema,
    files: z
      .array(
        z
          .object({
            path: z.string().refine(isAbsolute),
            relativePath: z.string().min(1),
            dev: z.string().regex(/^\d+$/),
            ino: z.string().regex(/^\d+$/),
            byteLength: z.number().int().nonnegative(),
            sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
          })
          .strict()
      )
      .max(66),
    normalizedBytes: z.number().int().nonnegative(),
    normalizedDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();
/** Closed private preparation input for the existing native FIFO. */
export type ControlProvenanceInput = z.infer<typeof ControlProvenanceInputSchema>;
/** Metadata acknowledgement is emitted only after its covering FULL commit. */
export const ControlProvenanceResultSchema = z.union([
  z.strictObject({
    complete: z.boolean(),
    indexBundleId: z.string().nullable(),
    rawBundleId: z.string(),
    runtimeEvidenceId: z.string(),
  }),
  ObservationOmissionResultSchema,
]);

/** Fixed reference placement, batching and per-database pending admission bounds. */
export const CONTROL_WORKER_LIMITS = {
  /** Additional Workspace databases share these hosts; the server has its own host. */
  workspaceWorkers: 4,
  batchTransitions: 32,
  batchWaitMs: 5,
  pendingTransitions: 1024,
  /** Includes the active publication; one Turn cannot reserve the whole database budget. */
  pendingTurnTransitions: 8,
  /** Per-database envelopes and ordinary cloned backing, separate from binary/echo. */
  pendingBytes: 64 * 1024 * 1024,
  /** Per-database binary input plus echoed range-text capacity remains independently bounded. */
  materialPendingBytes: 64 * 1024 * 1024,
} as const;

/** SQLite bind values that survive structured cloning without executable content. */
export type ControlSqlValue = string | number | bigint | Uint8Array | null;

/** One fully materialized SQLite row; no cursor crosses the worker boundary. */
export type ControlSqlRow = Record<string, ControlSqlValue>;

/**
 * One trusted, bounded SQLite statement in a local transition.
 *
 * SQL and statement order come from Core code, never a public request. Conditions belong in SQL predicates and these in-worker assertions, not a main-thread read/decision round trip. Bind caller data; synchronize immutable inputs first. There are no callbacks, result references, external effects or transaction SQL.
 */
export type ControlSqlStatement =
  | {
      readonly mode: 'run';
      readonly sql: string;
      readonly parameters: readonly ControlSqlValue[];
      /** A conditional mutation must affect this many rows or roll back its transition. */
      readonly expectChanges?: number;
    }
  | {
      readonly mode: 'get';
      readonly sql: string;
      readonly parameters: readonly ControlSqlValue[];
      /** Check existence inside the same savepoint as all dependent mutations. */
      readonly expectRow?: 'present' | 'absent';
    };

/** A statement result, available to the caller only after durable outer COMMIT. */
export type ControlSqlResult =
  | { readonly mode: 'run'; readonly changes: number; readonly lastInsertRowid: number | bigint }
  | { readonly mode: 'get'; readonly row: ControlSqlRow | null };

/** Existing journals that require no app-specific recovery-copy callback. */
export type ControlInitializationScope = 'core' | 'user' | 'workspace';

/** Trusted composition data sent to the fixed journal/file for a split Server owner. */
export interface ServerOwnerDescriptor<
  Owner extends Exclude<SplitStorageOwner, 'discord'> = Exclude<SplitStorageOwner, 'discord'>,
> {
  readonly owner: Owner;
}

// Validate the private wire shape here. The native handler validates the original
// placement, request identity, input digest and receipt against retained state.
const nanoHostEpochPlacement = z.strictObject({
  deploymentId: z.string().min(1),
  runtimeTargetId: z.string().min(1),
  physicalEpoch: z.string().regex(/^[a-f0-9]{64}$/u),
  generation: z.string().regex(/^[1-9][0-9]*$/u),
}) satisfies z.ZodType<NanoHostEpochPlacement>;

const nanoHostHolderIds = z.array(z.string().min(1));
const nanoHostEpochIntent = z.strictObject({
  deploymentId: nanoHostEpochPlacement.shape.deploymentId,
  sourceOwner: z.literal('nanohost'),
  verb: z.literal('fence-vault-epoch'),
  occurrenceKey: z.string().min(1),
  requestId: z.string().min(1),
  expectedGeneration: nanoHostEpochPlacement.shape.generation,
  inputDigest: z.string().min(1),
  target: z.strictObject({
    runtimeTargetId: nanoHostEpochPlacement.shape.runtimeTargetId,
    physicalEpoch: nanoHostEpochPlacement.shape.physicalEpoch,
    holderReceiptIds: nanoHostHolderIds,
  }),
}) satisfies z.ZodType<NanoHostEpochInvalidation>;

const nanoHostReceiptFields = { intent: nanoHostEpochIntent, receiptDigest: z.string().min(1) };
const nanoHostEpochReceipt = z.discriminatedUnion('disposition', [
  z.strictObject({
    ...nanoHostReceiptFields,
    disposition: z.literal('applied'),
    result: z.strictObject({ fencedHolderReceiptIds: nanoHostHolderIds }),
  }),
  z.strictObject({
    ...nanoHostReceiptFields,
    disposition: z.literal('refused'),
    reason: z.string().min(1),
  }),
]) satisfies z.ZodType<NanoHostEpochReceipt>;

/** Build results and defaults whose writes complete in the NanoHost file. */
export type NanoHostLocalWorkerImageInput =
  | Extract<ControlWorkerImageInput, { kind: 'environment' }>
  | {
      readonly kind: 'settlement';
      readonly value: Extract<ControlWorkerImageInput, { kind: 'settlement' }>['value'] & {
        readonly operation: 'image.build';
      };
    };

type BackendSessionTransition = Extract<ControlBackendSessionInput, { kind: 'transition' }>;

/** Original backend tuples whose SQL writes and decisions are local to NanoHost. */
export type NanoHostLocalBackendSessionInput =
  | Extract<ControlBackendSessionInput, { kind: 'handoff' }>
  | (BackendSessionTransition & {
      readonly toState: Exclude<BackendSessionTransition['toState'], 'launching'>;
    });

/** Original storage tuples after the caller's governing decision. */
export type NanoHostLocalWorkerStorageInput = Exclude<
  ControlWorkerStorageInput,
  { kind: 'purge-pending' }
>;

const nanoHostRecoveryClassification = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('arm-reconnect'),
    classifiedAt: z.iso.datetime({ precision: 3 }),
  }),
  z.strictObject({ kind: z.literal('needs-evidence') }),
  z.strictObject({
    kind: z.literal('transition'),
    toState: z.enum(['cleanup-pending', 'cleanup-failed', 'physical-cleaned']),
    target: ControlRuntimeTargetResultSchema.unwrap().strict(),
  }),
  z.strictObject({ kind: z.literal('workspace-handoff') }),
  z.strictObject({ kind: z.literal('finish-cleanup') }),
]);

const nanoHostRecoveryClassificationInput = z
  .strictObject({
    dataRoot: z.string().min(1),
    coreIdentity: z.string().regex(/^\d+:\d+$/),
    attemptId: z.string().min(1),
    expectedPhase: z.enum(['open', 'closing']),
    observationHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    expectedSession: ControlBackendSessionResultSchema,
    expectedRecovery: NanoHostWorkerRecoveryState,
    observedAt: z.iso.datetime({ precision: 3 }),
    classification: nanoHostRecoveryClassification,
  })
  .refine(
    ({ expectedPhase, classification }) =>
      expectedPhase === 'closing' ||
      classification.kind === 'arm-reconnect' ||
      classification.kind === 'needs-evidence'
  );

const nanoHostPreparedImageResult = z.strictObject({
  settlement: WorkerImageSettlementSchema,
  target: ControlCoreImageResultSchema.shape.target,
  acquisitionDecisionDigest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .optional(),
});

const nanoHostHarnessTurnInput = ControlHarnessLifecycleInputSchema.refine(
  (
    input
  ): input is Extract<
    ControlHarnessLifecycleInput,
    {
      kind:
        | 'operation.queue'
        | 'operation.dispatch'
        | 'operation.settle'
        | 'session-binding.open'
        | 'runtime.create'
        | 'harness.claim-idle-capture-drain';
    }
  > =>
    input.kind === 'operation.queue' ||
    input.kind === 'operation.dispatch' ||
    input.kind === 'operation.settle' ||
    input.kind === 'session-binding.open' ||
    input.kind === 'runtime.create' ||
    input.kind === 'harness.claim-idle-capture-drain'
);

const nanoHostIdleSandboxInput = ControlHarnessLifecycleInputSchema.refine(
  (
    input
  ): input is Extract<
    ControlHarnessLifecycleInput,
    { kind: 'sandbox.claim-idle-drain' | 'sandbox.restore-admission' }
  > => input.kind === 'sandbox.claim-idle-drain' || input.kind === 'sandbox.restore-admission'
);
const nanoHostIdleSandboxAuthority = z.strictObject({
  target: ControlCoreImageResultSchema.shape.target,
  rollback: z
    .strictObject({
      sandboxBindingRef: z.string().min(1),
      claimedAt: z.iso.datetime(),
    })
    .optional(),
});

const nanoHostOwnerMutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('transport'), input: ControlNanoHostTransportInputSchema }),
  z.strictObject({
    kind: z.literal('runtime-target'),
    input: NanoHostRuntimeTargetTransitionSchema,
  }),
  z.strictObject({ kind: z.literal('begin-retirement'), input: nanoHostEpochPlacement }),
  z.strictObject({ kind: z.literal('stage-invalidation'), input: nanoHostEpochIntent }),
  z.strictObject({ kind: z.literal('settle-invalidation'), input: nanoHostEpochReceipt }),
  z.strictObject({
    kind: z.literal('harness-lifecycle'),
    input: ControlHarnessLifecycleInputSchema.nanoHostLocal,
  }),
  z.strictObject({
    kind: z.literal('harness-turn-lifecycle'),
    input: nanoHostHarnessTurnInput,
    coreIdentity: z.string().regex(/^\d+:\d+$/),
  }),
  z.strictObject({
    kind: z.literal('sandbox-release-refusal-drain'),
    executionId: z.string().regex(/^sandbox-release-refusal:sha256:[a-f0-9]{64}$/),
    coreIdentity: z.string().regex(/^\d+:\d+$/),
  }),
  z.strictObject({
    kind: z.literal('harness-idle-sandbox'),
    input: nanoHostIdleSandboxInput,
    coreIdentity: z.string().regex(/^\d+:\d+$/),
    authority: nanoHostIdleSandboxAuthority,
  }),
  z.strictObject({
    kind: z.literal('worker-image'),
    input: ControlWorkerImageInputSchema.refine(
      (input) => input.kind === 'environment' || input.value.operation === 'image.build'
    ),
  }),
  z.strictObject({
    kind: z.literal('prepared-image-result'),
    input: nanoHostPreparedImageResult,
  }),
  z.strictObject({
    kind: z.literal('backend-session'),
    input: ControlBackendSessionInputSchema.refine(
      (input) =>
        input.kind === 'handoff' || (input.kind === 'transition' && input.toState !== 'launching')
    ),
  }),
  z.strictObject({
    kind: z.literal('backend-session-materialize'),
    input: ControlBackendSessionInputSchema.refine((input) => input.kind === 'materializing'),
    coreIdentity: z.string().regex(/^\d+:\d+$/),
  }),
  z.strictObject({
    kind: z.literal('recovery-classification'),
    input: nanoHostRecoveryClassificationInput,
  }),
  z.strictObject({
    kind: z.literal('worker-storage-binding'),
    input: ControlWorkerStorageInputSchema.refine((input) => input.kind !== 'purge-pending'),
  }),
  z.strictObject({
    kind: z.literal('worker-storage-purge'),
    input: ControlWorkerStorageInputSchema.refine((input) => input.kind === 'purge-pending'),
    coreIdentity: z.string().regex(/^\d+:\d+$/),
  }),
]);

/** Original local tuples posted only on a specific acknowledged NanoHost opening. */
export type NanoHostOwnerMutation =
  | { readonly kind: 'transport'; readonly input: ControlNanoHostTransportInput }
  | { readonly kind: 'runtime-target'; readonly input: NanoHostRuntimeTargetTransition }
  | { readonly kind: 'begin-retirement'; readonly input: NanoHostEpochPlacement }
  | { readonly kind: 'stage-invalidation'; readonly input: NanoHostEpochInvalidation }
  | { readonly kind: 'settle-invalidation'; readonly input: NanoHostEpochReceipt }
  | {
      readonly kind: 'harness-lifecycle';
      readonly input: z.output<typeof ControlHarnessLifecycleInputSchema.nanoHostLocal>;
    }
  | {
      readonly kind: 'harness-turn-lifecycle';
      readonly input: z.output<typeof nanoHostHarnessTurnInput>;
      readonly coreIdentity: string;
    }
  | {
      readonly kind: 'sandbox-release-refusal-drain';
      readonly executionId: string;
      readonly coreIdentity: string;
    }
  | {
      readonly kind: 'harness-idle-sandbox';
      readonly input: z.output<typeof nanoHostIdleSandboxInput>;
      readonly coreIdentity: string;
      readonly authority: z.output<typeof nanoHostIdleSandboxAuthority>;
    }
  | { readonly kind: 'worker-image'; readonly input: NanoHostLocalWorkerImageInput }
  | {
      readonly kind: 'prepared-image-result';
      readonly input: z.infer<typeof nanoHostPreparedImageResult>;
    }
  | { readonly kind: 'backend-session'; readonly input: NanoHostLocalBackendSessionInput }
  | {
      readonly kind: 'backend-session-materialize';
      readonly input: Extract<ControlBackendSessionInput, { kind: 'materializing' }>;
      readonly coreIdentity: string;
    }
  | {
      readonly kind: 'recovery-classification';
      readonly input: z.infer<typeof nanoHostRecoveryClassificationInput>;
    }
  | { readonly kind: 'worker-storage-binding'; readonly input: NanoHostLocalWorkerStorageInput }
  | {
      readonly kind: 'worker-storage-purge';
      readonly input: Extract<ControlWorkerStorageInput, { kind: 'purge-pending' }>;
      readonly coreIdentity: string;
    };

const nanoHostTargetResultSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ready'), value: ControlRuntimeTargetResultSchema }),
  z.strictObject({
    state: z.literal('unavailable'),
    owner: z.literal('nanohost'),
    reason: z.enum([
      'disabled',
      'missing',
      'unsupported',
      'corrupt',
      'full',
      'migration-failed',
      'recovery-required',
    ]),
  }),
]) satisfies z.ZodType<StorageResult<'nanohost', ControlRuntimeTargetResult>>;

const nanoHostOwnerResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('transport'), value: ControlNanoHostTransportResultSchema }),
  z.strictObject({ kind: z.literal('runtime-target'), value: nanoHostTargetResultSchema }),
  z.strictObject({ kind: z.literal('begin-retirement'), value: z.null() }),
  z.strictObject({ kind: z.literal('stage-invalidation'), value: z.null() }),
  z.strictObject({ kind: z.literal('settle-invalidation'), value: z.null() }),
  z.strictObject({ kind: z.literal('harness-lifecycle'), value: z.null() }),
  z.strictObject({
    kind: z.literal('harness-turn-lifecycle'),
    value: ControlHarnessLifecycleResultSchema,
  }),
  z.strictObject({ kind: z.literal('sandbox-release-refusal-drain'), value: z.null() }),
  z.strictObject({ kind: z.literal('harness-idle-sandbox'), value: z.null() }),
  z.strictObject({ kind: z.literal('worker-image'), value: z.null() }),
  z.strictObject({ kind: z.literal('prepared-image-result'), value: z.null() }),
  z.strictObject({ kind: z.literal('backend-session'), value: ControlBackendSessionResultSchema }),
  z.strictObject({
    kind: z.literal('backend-session-materialize'),
    value: ControlBackendSessionResultSchema,
  }),
  z.strictObject({
    kind: z.literal('recovery-classification'),
    value: ControlBackendSessionResultSchema,
  }),
  z.strictObject({
    kind: z.literal('worker-storage-binding'),
    value: ControlWorkerStorageResultSchema,
  }),
  z.strictObject({
    kind: z.literal('worker-storage-purge'),
    value: ControlWorkerStorageResultSchema,
  }),
]);

/** Correlates the original tuple's local result with the covering FULL acknowledgement. */
export type NanoHostOwnerMutationResult =
  | Exclude<
      z.infer<typeof nanoHostOwnerResultSchema>,
      { kind: 'worker-storage-binding' | 'worker-storage-purge' }
    >
  | {
      readonly kind: 'worker-storage-binding';
      readonly value: import('../runtime/worker-storage-binding-records.js').WorkerStorageBinding;
    }
  | {
      readonly kind: 'worker-storage-purge';
      readonly value: import('../runtime/worker-storage-binding-records.js').WorkerStorageBinding;
    };

/** An execution close may carry one exact observation from the admitted Native file. */
const nanoHostRecoveryClose = z.strictObject({
  coreOpeningRequestId: z.number().int().nonnegative().safe(),
  ownerIdentity: z.string().regex(/^\d+:\d+$/),
  expectedPhase: z.enum(['open', 'closing', 'closed']),
  observationHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  /** K8b: the final decision this close consumes, rechecked in the same Core transaction. */
  finalHash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
});

/** K8b: a capture publication may carry the accepted-final commitment it consumes, with both pinned peers. */
const nanoHostFinalGuard = z.strictObject({
  coreIdentity: z.string().regex(/^\d+:\d+$/),
  nanoHostIdentity: z.string().regex(/^\d+:\d+$/),
  attemptId: z.string().min(1).max(256),
  commitmentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

/** The pinned peers and the commitment that one guarded capture publication consumes. */
export type NanoHostFinalGuard = z.infer<typeof nanoHostFinalGuard>;

const nanoHostDecisionPeers = z.strictObject({
  nanoHostIdentity: z.string().regex(/^\d+:\d+$/),
  workspaceIdentity: z.string().regex(/^\d+:\d+$/),
});

const nanoHostTerminalReleaseResult = z.union([
  z.strictObject({
    state: z.literal('settled'),
    receipt: z.strictObject({
      execution: z.strictObject({
        owner: z.strictObject({ kind: z.literal('server') }),
        executionId: z.string().min(1).max(128),
      }),
      stepId: z.string().min(1).max(128),
    }),
  }),
  z.strictObject({ state: z.enum(['conflict', 'unknown']) }),
]);

const nanoHostCoreReadPeer = z.strictObject({
  openingRequestId: z.number().int().nonnegative().safe(),
  ownerIdentity: z.string().regex(/^\d+:\d+$/),
});

const nanoHostFinalStage = z.discriminatedUnion('kind', [
  nanoHostCoreReadPeer.extend({ kind: z.literal('intake') }),
  nanoHostCoreReadPeer.extend({ kind: z.literal('observe') }),
  z.strictObject({
    kind: z.literal('settle'),
    coreIdentity: z.string().regex(/^\d+:\d+$/),
    decision: ControlCoreNanoHostFinalDecisionSchema,
  }),
]);

const nanoHostFinalCoreResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('intake'), value: ControlCoreNanoHostFinalDecisionSchema }),
  z.strictObject({
    kind: z.literal('observe'),
    value: ControlCoreNanoHostAcceptedFinalResultSchema,
  }),
]);

/**
 * K8b: one hash of the final decision that a recovery mutation consumes. Its writer recomputes the same
 * decision from its pinned snapshots and compares this hash before it commits.
 */
export function hashNanoHostFinalDecision(decision: unknown): string {
  return commandInputHash(decision);
}

/** A close replay compares the original placement and Native observation across Core phase changes. */
export function hashNanoHostRecoveryObservation({
  lease,
  session,
  proof,
}: Pick<Parameters<AdmittedNanoHostAttemptRecovery['close']>[0], 'lease' | 'session' | 'proof'>) {
  const { queueEntryId, workspaceId, threadId, agentSessionId, createdAt } = lease.attempt;
  return commandInputHash({
    grant: lease.grant,
    queueEntryId,
    workspaceId,
    threadId,
    agentSessionId,
    createdAt,
    session,
    proof,
  });
}

const nanoHostOwnerOperation = { operation: z.literal('nanohost-owner') };
/** Existing domain refusals on the captured NanoHost wire operation. */
export const NanoHostOwnerRefusalSchema = z.union([
  ControlRuntimeTargetRefusalSchema.extend(nanoHostOwnerOperation),
  ControlHarnessLifecycleRefusalSchema.extend(nanoHostOwnerOperation),
  ControlWorkerImageRefusalSchema.extend(nanoHostOwnerOperation),
  ControlBackendSessionRefusalSchema.extend(nanoHostOwnerOperation),
  ControlWorkerStorageRefusalSchema.extend(nanoHostOwnerOperation),
]);

const communicationKernelInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reserve'), envelope: ChannelInboundEnvelopeSchema }),
  z.strictObject({ kind: z.literal('bind'), origin: ChannelInboundOriginSchema }),
  z.strictObject({
    kind: z.literal('settle'),
    envelope: ChannelInboundEnvelopeSchema,
    outcome: ChannelInboundOutcomeSchema,
  }),
  z.strictObject({ kind: z.literal('inspect'), key: ChannelInboundKeySchema }),
  z.strictObject({
    kind: z.literal('relay-audit'),
    intent: PairingAuditIntentSchema,
    event: AuditEventSchema,
  }),
  z.strictObject({ kind: z.literal('inspect-audit'), intent: PairingAuditIntentSchema }),
]);

export type CommunicationKernelInput = z.infer<typeof communicationKernelInputSchema>;

type KernelValue<Result> =
  Extract<Awaited<Result>, { state: 'ready' }> extends {
    value: infer Value;
  }
    ? Value
    : never;

export type CommunicationKernelReply =
  | { kind: 'reserve'; value: KernelValue<ReturnType<ControlKernelStore['reserveChannelInbound']>> }
  | { kind: 'bind'; value: KernelValue<ReturnType<ControlKernelStore['bindChannelInboundOrigin']>> }
  | { kind: 'settle'; value: KernelValue<ReturnType<ControlKernelStore['settleChannelInbound']>> }
  | { kind: 'inspect'; value: KernelValue<ReturnType<ControlKernelStore['inspectChannelInbound']>> }
  | { kind: 'relay-audit'; value: KernelValue<ReturnType<ControlKernelStore['relayPairingAudit']>> }
  | {
      kind: 'inspect-audit';
      value: KernelValue<ReturnType<ControlKernelStore['inspectPairingAudit']>>;
    };

const communicationReceiptDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const channelReceipt = z.strictObject({
  intent: ChannelInboundEnvelopeSchema,
  disposition: z.literal('applied'),
  receiptDigest: communicationReceiptDigest,
  result: ChannelInboundOutcomeSchema,
});
const pairingReceipt = z.strictObject({
  intent: PairingAuditIntentSchema,
  disposition: z.literal('applied'),
  receiptDigest: communicationReceiptDigest,
  result: z.strictObject({ eventId: AuditEventSchema.shape.id }),
});
const receiptHold = z.strictObject({ state: z.enum(['conflict', 'unknown']) });
const receiptAbsent = z.strictObject({ state: z.literal('absent') });
const settledChannel = z.strictObject({ state: z.literal('settled'), receipt: channelReceipt });
const settledPairing = z.strictObject({ state: z.literal('settled'), receipt: pairingReceipt });
const communicationKernelReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('reserve'),
    value: z.strictObject({
      state: z.enum(['reserved-now', 'inspect-original', 'conflict', 'unknown']),
    }),
  }),
  z.strictObject({
    kind: z.literal('bind'),
    value: z.strictObject({
      state: z.enum(['bound-now', 'inspect-original', 'conflict', 'unknown']),
    }),
  }),
  z.strictObject({
    kind: z.literal('settle'),
    value: z.union([settledChannel, receiptHold]),
  }),
  z.strictObject({
    kind: z.literal('inspect'),
    value: z.union([
      z.strictObject({ state: z.literal('unknown') }),
      receiptAbsent,
      z.strictObject({ state: z.literal('reserved'), envelope: ChannelInboundEnvelopeSchema }),
      z.strictObject({ state: z.literal('origin-bound'), origin: ChannelInboundOriginSchema }),
      settledChannel.extend({ origin: ChannelInboundOriginSchema.nullable() }),
    ]),
  }),
  z.strictObject({ kind: z.literal('relay-audit'), value: z.union([settledPairing, receiptHold]) }),
  z.strictObject({
    kind: z.literal('inspect-audit'),
    value: z.union([settledPairing, receiptHold, receiptAbsent]),
  }),
]);

const serverWorkDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const serverWorkIntentFields = {
  deploymentId: z.string().min(1),
  sourceOwner: z.literal('server-work'),
  occurrenceKey: z.string().min(1),
  requestId: z.string().min(1),
  expectedGeneration: z.string().min(1).nullable(),
  inputDigest: serverWorkDigest,
};
const serverWorkTarget = z.strictObject({
  actor: ActorRefSchema,
  credentialRef: z.string().min(1).nullable(),
  recordRef: z.string().min(1),
});
const serverThreadTarget = serverWorkTarget.extend({ threadId: z.string().min(1) });
const serverCallTarget = serverWorkTarget.extend({ callId: z.string().min(1) });
const serverCallAdmission = z.strictObject({
  ...serverWorkIntentFields,
  verb: z.literal('admit-call'),
  target: serverCallTarget.extend({
    threadId: z.string().min(1).nullable(),
    turnId: z.string().min(1).nullable(),
    routeRef: z.string().min(1),
    budgetRef: z.string().min(1).nullable(),
  }),
});
const serverWorkIntent = z.union([
  z.strictObject({
    ...serverWorkIntentFields,
    verb: z.literal('admit-thread'),
    target: serverThreadTarget,
  }),
  z.strictObject({
    ...serverWorkIntentFields,
    verb: z.enum(['admit-turn', 'settle-turn']),
    target: serverThreadTarget.extend({ turnId: z.string().min(1) }),
  }),
  serverCallAdmission,
  z.strictObject({
    ...serverWorkIntentFields,
    verb: z.enum(['settle-call', 'settle-usage']),
    target: serverCallTarget,
  }),
]);
const serverWorkAppliedReceipt = z.strictObject({
  intent: serverWorkIntent,
  receiptDigest: serverWorkDigest,
  disposition: z.literal('applied'),
  result: z.strictObject({ decisionRef: z.string().min(1) }),
});
const serverWorkReceipt = z.discriminatedUnion('disposition', [
  serverWorkAppliedReceipt,
  z.strictObject({
    intent: serverWorkIntent,
    receiptDigest: serverWorkDigest,
    disposition: z.literal('refused'),
    reason: z.string().min(1),
  }),
]);
const serverWorkKernelInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inspect'), intent: serverWorkIntent }),
  z.strictObject({
    kind: z.literal('decide'),
    intent: serverWorkIntent,
    ownerIdentity: z.string().regex(/^\d+:\d+$/),
  }),
]);

/** Exact original intent and the admitted file identity required for a first decision. */
export type ServerWorkKernelInput = z.infer<typeof serverWorkKernelInputSchema>;

const serverWorkSettled = z.strictObject({
  state: z.literal('settled'),
  receipt: serverWorkReceipt,
});
const serverWorkKernelReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('decide'),
    value: z.union([receiptHold, serverWorkSettled]),
  }),
  z.strictObject({
    kind: z.literal('inspect'),
    value: z.union([receiptHold, receiptAbsent, serverWorkSettled]),
  }),
]);

/** The original decision or inspection returned by the Core worker. */
export type ServerWorkKernelReply = z.infer<typeof serverWorkKernelReplySchema>;

const serverWorkTurnAdmission = z.strictObject({
  ...serverWorkIntentFields,
  verb: z.literal('admit-turn'),
  target: serverThreadTarget.extend({ turnId: z.string().min(1) }),
});
const serverKnowledgeCommand = z.strictObject({
  input: ControlKnowledgeAdmissionInputSchema,
  deploymentId: z.string().min(1),
  credentialRef: z.string().min(1).nullable(),
  originalInput: z.string().max(CONTROL_PRODUCT_LIMITS.payloadBytes),
});
const serverWorkRouteLineage = z.strictObject({
  logicalModelId: z.string().min(1),
  entry: GatewayRouteLineageEntrySchema,
  entryIndex: z.number().int().nonnegative().optional(),
});
const serverWorkTurnProgress = z.strictObject({
  products: z.array(ControlProductMutationSchema).max(CONTROL_PRODUCT_LIMITS.entries),
  entries: z.array(ControlProductEntrySchema).max(CONTROL_PRODUCT_LIMITS.entries),
});

const serverWorkObservation = z.strictObject({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  observation: z.record(z.string(), z.unknown()),
  deferBodyPublication: z.literal(true).optional(),
  bodies: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        mediaType: z.string().min(1),
        boundary: z.string().min(1),
        byteLength: z
          .number()
          .int()
          .min(0)
          .max(16 * 1024 * 1024),
      })
    )
    .max(CONTROL_PRODUCT_LIMITS.entries),
});
const serverWorkOwnerMutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('stage'),
    intent: serverWorkIntent,
    payload: z.string().max(CONTROL_PRODUCT_LIMITS.payloadBytes),
  }),
  z.strictObject({ kind: z.literal('settle'), receipt: serverWorkReceipt }),
  z.strictObject({
    kind: z.literal('claim-contact'),
    receipt: serverWorkAppliedReceipt.extend({ intent: serverCallAdmission }),
  }),
  z.strictObject({ kind: z.literal('stage-knowledge'), input: serverKnowledgeCommand }),
  z.strictObject({
    kind: z.literal('append-observation'),
    admission: serverWorkTurnAdmission,
    input: serverWorkObservation,
  }),
  z.strictObject({
    kind: z.literal('write-route-lineage'),
    receipt: serverWorkAppliedReceipt.extend({ intent: serverCallAdmission }),
    input: serverWorkRouteLineage,
  }),
  z.strictObject({
    kind: z.literal('publish-turn-progress'),
    admission: serverWorkTurnAdmission,
    input: serverWorkTurnProgress,
  }),
  z.strictObject({
    kind: z.literal('publish-containment'),
    record: ServerEvidenceBundleRecordSchema.extend({ rawEvidenceRefs: z.tuple([]) }),
  }),
]);

export type ServerWorkOwnerMutation =
  | { readonly kind: 'stage'; readonly intent: ServerWorkIntent; readonly payload: string }
  | { readonly kind: 'settle'; readonly receipt: ServerWorkReceipt }
  | {
      readonly kind: 'claim-contact';
      readonly receipt: Extract<ServerWorkReceipt<ServerCallAdmission>, { disposition: 'applied' }>;
    }
  | { readonly kind: 'stage-knowledge'; readonly input: z.infer<typeof serverKnowledgeCommand> }
  | {
      readonly kind: 'append-observation';
      readonly admission: z.infer<typeof serverWorkTurnAdmission>;
      readonly input: z.infer<typeof serverWorkObservation>;
    }
  | {
      readonly kind: 'write-route-lineage';
      readonly receipt: Extract<ServerWorkReceipt<ServerCallAdmission>, { disposition: 'applied' }>;
      readonly input: z.infer<typeof serverWorkRouteLineage>;
    }
  | {
      readonly kind: 'publish-turn-progress';
      readonly admission: z.infer<typeof serverWorkTurnAdmission>;
      readonly input: {
        readonly products: readonly z.infer<typeof ControlProductMutationSchema>[];
        readonly entries: readonly z.infer<typeof ControlProductEntrySchema>[];
      };
    }
  | { readonly kind: 'publish-containment'; readonly record: ServerEvidenceBundleRecord };

const serverWorkOwnerResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('stage'), value: z.null() }),
  z.strictObject({ kind: z.literal('settle'), value: z.null() }),
  z.strictObject({
    kind: z.literal('stage-knowledge'),
    value: z.strictObject({
      intent: serverWorkTurnAdmission,
      busy: z.boolean(),
      replayed: z.boolean(),
    }),
  }),
  z.strictObject({ kind: z.literal('publish-turn-progress'), value: z.null() }),
  z.strictObject({
    kind: z.literal('append-observation'),
    value: z.union([
      ObservationOmissionResultSchema,
      z.strictObject({
        disposition: z.enum(['committed', 'duplicate']),
        observation: z.custom<RetainedWorkObservation['observation']>((value) => {
          try {
            parseWorkObservationRecord(value);
            return true;
          } catch {
            return false;
          }
        }),
      }),
    ]),
  }),
  z.strictObject({ kind: z.literal('write-route-lineage'), value: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('publish-containment'), value: z.null() }),
  z.strictObject({
    kind: z.literal('claim-contact'),
    value: z.strictObject({ state: z.enum(['claimed-now', 'refused', 'inspect-original']) }),
  }),
]);

/** One result from the original Server work mutation's covering FULL commit. */
export type ServerWorkOwnerMutationResult = z.infer<typeof serverWorkOwnerResultSchema>;

/**
 * Trusted internal database-worker requests.
 *
 * An id is transient message correlation, never a replacement command receipt. A database key denotes an already-admitted physical scope, not new ownership. The host must cap outstanding writes before postMessage using the same pending bound: a worker-side cap alone cannot bound a blocked MessagePort's backlog. Pure reads use separate read-only/query_only connections and do not use this API.
 */
export type ControlWorkerCommand =
  | { readonly operation: 'shutdown' }
  | ({ readonly database: string } & (
      | {
          readonly operation: 'open';
          /** Absolute admitted path. Only split owner provisioning can create its parent. */
          readonly path: string;
          /** Explicit fresh-scope admission; false must never initialize a missing database. */
          readonly create: boolean;
          /** Apply the existing scope journal before opening completes; never bypass app recovery. */
          readonly initialize?: ControlInitializationScope;
          /** Explicit admitted product owner; absent on legacy primitive-only fixture scopes. */
          readonly productOwner?: ControlProductOwner;
          /** Exact App physical binding, never a retained product owner. */
          readonly physicalScope?: ControlAppScope;
          /** Independent service or extension writer with no legacy raw SQL entry. */
          readonly serverOwner?: ServerOwnerDescriptor;
          /** Trusted existing-owner migration under writer exclusion, with a verified pre-DDL copy. */
          readonly migrateServerOwner?: true;
          /** One trusted live policy cell captured by the Communication owner OPEN. */
          readonly communicationExpiryPolicy?: SharedArrayBuffer;
          /** Exact admitted root for same-connection scoped domain bodies; never inferred from a caller-selected database key. */
          readonly dataRoot?: string;
          /** Admitted private Storage binding; never derived from an incoming content locator. */
          readonly contentMount?: ControlProductContentMount;
        }
      | {
          readonly operation: 'app-kernel';
          readonly input: ControlAppWire;
          readonly content: ArrayBuffer;
        }
      | { readonly operation: 'write'; readonly statements: readonly ControlSqlStatement[] }
      | { readonly operation: 'recovery-history'; readonly workspaceId: string }
      | { readonly operation: 'recovery-cleanup'; readonly input: ControlRecoveryCleanupInput }
      | { readonly operation: 'recovery-capture'; readonly input: ControlRecoveryCaptureInput }
      | {
          readonly operation: 'recovery-source-reactivation';
          readonly input: ControlRecoverySourceReactivationInput;
        }
      | { readonly operation: 'recovery-move-out'; readonly input: ControlRecoveryMoveOutInput }
      | { readonly operation: 'recovery-safety'; readonly input: ControlRecoverySafetyInput }
      | {
          readonly operation: 'transition';
          readonly transition:
            | Exclude<ControlAdmissionInput, { kind: 'command-receipt' | 'scheduler-work' }>
            | { readonly kind: 'command-receipt'; readonly input: ControlScalarText }
            | { readonly kind: 'scheduler-work'; readonly input: CoreSchedulerWire };
          readonly content?: ArrayBuffer;
        }
      | { readonly operation: 'products'; readonly transition: ControlProductTransition }
      | {
          readonly operation: 'item';
          readonly input: ControlItemAppend;
          readonly mcpCall?: ControlMcpItemCall;
        }
      | { readonly operation: 'event'; readonly input: ControlEventAppend }
      | { readonly operation: 'publication'; readonly input: ControlPublicationInput }
      | { readonly operation: 'project-cleanup'; readonly input: ProjectWorkerBackendCleanupInput }
      | {
          readonly operation: 'observation';
          readonly input: ControlWorkObservationCommandInput;
          readonly content?: ArrayBuffer;
        }
      | {
          readonly operation: 'capability';
          readonly input: ControlCapabilityWireInput;
          readonly immediate?: boolean;
          readonly content?: ArrayBuffer;
        }
      | { readonly operation: 'provenance'; readonly input: ControlProvenanceInput }
      | {
          readonly operation: 'generative-presentation';
          readonly input: ControlGenerativePresentationWire;
          readonly content?: ArrayBuffer;
        }
      | {
          readonly operation: 'thread-read-membership';
          readonly input: ControlThreadReadMembershipWire;
          readonly content?: ArrayBuffer;
        }
      | { readonly operation: 'goal'; readonly input: ControlGoalInput }
      | {
          readonly operation: 'worker-control-evidence';
          readonly input: ControlWorkerRejectedEvidence;
        }
      | { readonly operation: 'boot-audit'; readonly input: ControlBootAuditInput }
      | { readonly operation: 'admin-recovery'; readonly input: ControlAdminRecoveryInput }
      | { readonly operation: 'better-auth'; readonly input: ControlBetterAuthInput }
      | {
          readonly operation: 'runtime-policy-publication';
          readonly input: RuntimePolicyPublicationInput;
        }
      | {
          readonly operation: 'vault';
          readonly input: ControlVaultInput;
          readonly policyRead?: true;
        }
      | { readonly operation: 'nanohost-transport'; readonly input: ControlNanoHostTransportInput }
      | {
          readonly operation: 'nanohost-epoch-kernel';
          readonly openingRequestId: number;
          readonly input: NanoHostEpochKernelInput;
        }
      | {
          readonly operation: 'nanohost-first-submission';
          readonly openingRequestId: number;
          readonly input: ControlNanoHostFirstSubmissionInput;
          readonly peers: z.infer<typeof nanoHostDecisionPeers>;
        }
      | {
          readonly operation: 'nanohost-terminal-release';
          readonly openingRequestId: number;
          readonly input: ControlNanoHostTerminalReleaseInput;
          readonly peers: z.infer<typeof nanoHostDecisionPeers>;
        }
      | {
          readonly operation: 'repair-kernel';
          readonly openingRequestId: number;
          readonly input: RepairWorkerInput;
        }
      | {
          readonly operation: 'server-work-kernel';
          readonly openingRequestId: number;
          readonly input: ServerWorkKernelInput;
        }
      | {
          readonly operation: 'server-work-owner';
          readonly openingRequestId: number;
          readonly mutation: ServerWorkOwnerMutation;
          readonly content?: ArrayBuffer;
        }
      | {
          readonly operation: 'nanohost-owner';
          readonly openingRequestId: number;
          readonly mutation: NanoHostOwnerMutation;
        }
      | {
          readonly operation: 'communication-kernel';
          readonly openingRequestId: number;
          readonly communicationIdentity: string;
          readonly input: CommunicationKernelInput;
        }
      | {
          readonly operation: 'communication-owner';
          readonly openingRequestId: number;
          readonly stage: CommunicationWriterCommand['stage'];
          readonly input: ControlScalarText;
          readonly content: ArrayBuffer;
        }
      | { readonly operation: 'journal'; readonly input: ControlExecutionJournalInput }
      | {
          readonly operation: 'pending';
          // A grouped decision carries only its private plan reference.
          readonly input: ControlPendingTransition | ControlPendingPlan;
        }
      | {
          readonly operation: 'workspace-queue-input';
          readonly input: z.infer<typeof ControlWorkspaceQueueInputWireSchema>;
          readonly content: ArrayBuffer;
        }
      | {
          readonly operation: 'schema-application';
          readonly input: ControlSchemaApplicationWire;
          readonly content: ArrayBuffer;
        }
      | {
          readonly operation: 'material';
          readonly input: ControlMaterialWireInput;
          readonly content?: ArrayBuffer;
        }
      | { readonly operation: 'worker-storage-binding'; readonly input: ControlWorkerStorageInput }
      | {
          readonly operation: 'core-journal';
          readonly input: ControlCoreJournalInput | ControlCoreImageResult;
          readonly nanoHostOwnerIdentity?: string;
        }
      | { readonly operation: 'worker-image'; readonly input: ControlWorkerImageInput }
      | { readonly operation: 'runtime-target'; readonly input: ControlRuntimeTargetInput }
      | {
          readonly operation: 'backend-session';
          readonly input: ControlBackendSessionInput;
          readonly simulatorCoreIdentity?: string;
        }
      | {
          readonly operation: 'workspace-backend-handoff';
          readonly input: ControlWorkspaceBackendHandoff;
        }
      | {
          readonly operation: 'workspace-stage-review';
          readonly input: ControlWorkspaceStageReview;
        }
      | { readonly operation: 'private-workspace'; readonly input: ControlPrivateWorkspaceInput }
      | { readonly operation: 'workspace-baseline'; readonly input: ControlWorkspaceBaseline }
      | {
          readonly operation: 'workspace-capture';
          readonly input: ControlWorkspaceCapture;
          readonly nanoHostFinalGuard?: NanoHostFinalGuard;
        }
      | { readonly operation: 'workspace-takeover'; readonly input: ControlWorkspaceTakeover }
      | {
          readonly operation: 'workspace-recovery-decision';
          readonly input: ControlWorkspaceRecoveryDecision;
        }
      | {
          readonly operation: 'standalone-audit';
          readonly input: ControlScalarText;
          readonly content: ArrayBuffer;
          readonly nanoHostOwnerIdentity?: string;
        }
      | {
          readonly operation: 'resolved-agent-setup';
          readonly input: ControlResolvedAgentSetupInput;
        }
      | { readonly operation: 'scoped-notebook-sql'; readonly input: ControlScopedNotebookSqlInput }
      | { readonly operation: 'workspace-apply-plan'; readonly input: ControlWorkspaceApplyPlan }
      | { readonly operation: 'automation-scanner'; readonly input: ControlAutomationScanner }
      | { readonly operation: 'security-trigger'; readonly input: ControlSecurityTrigger }
      | {
          readonly operation: 'workspace-review-finish';
          readonly input: ControlWorkspaceReviewFinish;
        }
      | {
          readonly operation: 'workspace-review-decision';
          readonly input: ControlWorkspaceReviewDecision;
        }
      | {
          readonly operation: 'local-identity';
          readonly input: ControlLocalIdentity;
        }
      | {
          readonly operation: 'bootstrap-consume';
          readonly input: ControlBootstrapConsume;
        }
      | {
          readonly operation: 'bootstrap-ensure';
          readonly input: ControlBootstrapEnsure;
        }
      | {
          readonly operation: 'access-token-lifecycle';
          readonly input: ControlAccessTokenLifecycle;
        }
      | {
          readonly operation: 'server-admin-token-default';
          readonly input: ControlServerAdminTokenDefault;
        }
      | {
          readonly operation: 'access-token-verification';
          readonly input: ControlAccessTokenVerification;
          readonly nanoHostPeer?: z.infer<typeof nanoHostCoreReadPeer>;
        }
      | { readonly operation: 'remote-mcp-audit'; readonly input: ControlRemoteMcpAudit }
      | {
          readonly operation: 'execution-attempt';
          readonly input: ControlExecutionAttemptInput;
          readonly content?: ArrayBuffer;
          readonly simulatorCoreIdentity?: string;
          readonly nanoHostRecoveryClose?: z.infer<typeof nanoHostRecoveryClose>;
        }
      | {
          readonly operation: 'worker-control-final-status';
          readonly input: ControlWorkerFinalStatusInput;
          readonly content?: ArrayBuffer;
          readonly nanoHostFinal?: z.infer<typeof nanoHostFinalStage>;
        }
      | {
          readonly operation: 'worker-control-heartbeat';
          readonly input: ControlWorkerHeartbeatInput;
          readonly content?: ArrayBuffer;
          readonly nanoHostCoreIdentity?: string;
        }
      | {
          readonly operation: 'worker-control-record';
          readonly input: ControlWorkerRecordInput;
          readonly content?: ArrayBuffer;
          readonly nanoHostCoreIdentity?: string;
        }
      | {
          readonly operation: 'harness-lifecycle';
          readonly input: ControlHarnessLifecycleInput;
          readonly nanoHostAckPeer?: z.infer<typeof nanoHostCoreReadPeer>;
        }
      | {
          readonly operation: 'recovery-target-preparation';
          readonly input: ControlRecoveryTargetPreparationInput;
        }
      | {
          readonly operation: 'recovery-target-registration';
          readonly input: ControlRecoveryTargetRegistrationInput;
        }
      | { readonly operation: 'workspace-deletion'; readonly input: ControlWorkspaceDeletionInput }
      | { readonly operation: 'core-sharing'; readonly input: ControlCoreSharing }
      | { readonly operation: 'evaluation-candidate'; readonly input: ControlEvaluationCandidate }
      | { readonly operation: 'review'; readonly input: ControlReviewCommandInput }
      | { readonly operation: 'terminal'; readonly input: ControlTerminalTransition }
      | { readonly operation: 'checkpoint' | 'reclaim' | 'close' | 'recovery-seal' }
    ));

/** Transient correlation header; the command receipt remains in the owning SQL tuple. */
export type ControlWorkerRequest = ControlWorkerCommand & {
  readonly version: typeof CONTROL_WORKER_VERSION;
  readonly id: number;
};

/** One eligible same-Turn prefix, transported atomically into existing per-request slots. */
export interface ControlProductCohort {
  readonly version: typeof CONTROL_WORKER_VERSION;
  readonly operation: 'products';
  readonly requests: readonly Extract<ControlWorkerRequest, { operation: 'products' }>[];
  /** First-idle progress and causal barriers bypass intentional writer coalescing. */
  readonly immediate: boolean;
}

/** Counts envelopes and complete cloned backing before copying binary payloads. */
export function controlWorkerInputBytes(
  command: ControlWorkerCommand | ControlWorkerRequest
): number {
  let binaryBytes = 0;
  const json = JSON.stringify(
    command,
    function (this: Record<string, unknown>, key, value: unknown) {
      // Read the original holder: Buffer.toJSON otherwise hides its cloned backing.
      const original = this[key];
      if (typeof original === 'bigint') return original.toString();
      if (original instanceof ArrayBuffer || ArrayBuffer.isView(original)) {
        // Scalar/Material binary and range echo share one reservation; other backing is counted.
        if (
          command.operation !== 'material' &&
          !(
            (command.operation === 'capability' ||
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
              command.operation === 'execution-attempt' ||
              command.operation === 'worker-control-final-status' ||
              command.operation === 'worker-control-heartbeat' ||
              command.operation === 'worker-control-record') &&
            key === 'content' &&
            this === command
          )
        )
          binaryBytes +=
            original instanceof ArrayBuffer ? original.byteLength : original.buffer.byteLength;
        return null;
      }
      return value;
    }
  );
  return Buffer.byteLength(json) + binaryBytes;
}

/** Validates a finite same-Turn Item/event cohort before any member is admitted. */
export function isControlProductCohort(value: unknown): value is ControlProductCohort {
  if (
    !isRecord(value) ||
    !exactFields(value, ['version', 'operation', 'requests', 'immediate']) ||
    value.version !== CONTROL_WORKER_VERSION ||
    value.operation !== 'products' ||
    typeof value.immediate !== 'boolean' ||
    !Array.isArray(value.requests) ||
    value.requests.length === 0 ||
    value.requests.length > CONTROL_WORKER_LIMITS.batchTransitions
  )
    return false;
  let first: Extract<ControlWorkerRequest, { operation: 'products' }> | undefined;
  for (const [index, request] of value.requests.entries()) {
    if (!isControlWorkerRequest(request) || request.operation !== 'products') return false;
    const { products, entries, pending, journalIntents } = request.transition;
    if (
      products.length !== 1 ||
      products[0]?.kind !== 'turn' ||
      entries.length !== 1 ||
      products[0].record.id !== entries[0]?.turnId ||
      pending?.length ||
      journalIntents?.length
    )
      return false;
    first ??= request;
    if (
      request.database !== first.database ||
      entries[0]?.turnId !== first.transition.entries[0]?.turnId ||
      request.id !== first.id + index
    )
      return false;
  }
  return true;
}

/** Closed failure categories; SQL text, bindings and native error messages are not returned. */
export const CONTROL_WORKER_FAILURE_CODES = [
  'invalid-request',
  'not-open',
  'busy',
  'precondition',
  'constraint',
  'sql-failed',
  'no-space',
  'unavailable',
  'commit-unknown',
  'migration_missing',
  'migration_failed',
  'migration_unsupported_core',
  'migration_unsupported_user',
  'migration_unsupported_workspace',
  'migration_unsupported_app',
  'owner-missing',
  'owner-unsupported',
  'owner-recovery-required',
  'integrity',
] as const;

/** Closed native failure code, with no SQL text or bound values. */
export type ControlWorkerFailureCode = (typeof CONTROL_WORKER_FAILURE_CODES)[number];

/** Trusted domain refusals preserve the existing public contract; native SQL diagnostics never enter this projection. */
interface OrdinaryControlWorkerDomainRefusal {
  readonly operation:
    | 'app-kernel'
    | 'provenance'
    | 'observation'
    | 'admin-recovery'
    | 'better-auth'
    | 'nanohost-transport'
    | 'worker-storage-binding'
    | 'workspace-apply-plan'
    | 'automation-scanner'
    | 'workspace-review-decision'
    | 'workspace-review-finish'
    | 'vault'
    | 'thread-read-membership'
    | 'generative-presentation'
    | 'evaluation-candidate'
    | 'goal'
    | 'capability'
    | 'schema-application'
    | 'material'
    | 'review'
    | 'pending'
    | 'products'
    | 'transition'
    | 'item'
    | 'event'
    | 'terminal'
    | 'publication'
    | 'server-work-owner';
  readonly code: string;
  readonly message: string;
  readonly status: number;
  /** Trusted original owner class for this capability refusal. */
  readonly kind?: 'operation' | 'mcp' | 'turn' | 'pending' | 'ledger';
  readonly appDetails?: {
    readonly path?: string | undefined;
    readonly limit?: string | undefined;
    readonly maximum?: number | undefined;
    readonly expectedRevision?: number | undefined;
    readonly currentRevision?: number | undefined;
  };
}

/** Existing native refusals plus the sharing family's exact current-record projection. */
const communicationOwnerRefusalSchema = z.strictObject({
  operation: z.literal('communication-owner'),
  kind: z.enum(['attention', 'operation']),
  code: z.string().min(1).max(96),
  message: z.string().min(1).max(512),
  status: z.union([z.literal(400), z.literal(403), z.literal(404), z.literal(409), z.literal(503)]),
});

const nanoHostFirstSubmissionRefusalSchema = ControlExecutionAttemptRefusalSchema.extend({
  operation: z.literal('nanohost-first-submission'),
});

export type ControlWorkerDomainRefusal =
  | z.infer<typeof communicationOwnerRefusalSchema>
  | z.infer<typeof ControlSecurityTriggerRefusalSchema>
  | z.infer<typeof ControlPrivateWorkspaceRefusalSchema>
  | OrdinaryControlWorkerDomainRefusal
  | z.infer<typeof ControlWorkspaceBaselineRefusalSchema>
  | z.infer<typeof ControlWorkspaceCaptureRefusalSchema>
  | z.infer<typeof ControlWorkspaceTakeoverRefusalSchema>
  | z.infer<typeof ControlWorkspaceRecoveryDecisionRefusalSchema>
  | z.infer<typeof ControlResolvedAgentSetupRefusalSchema>
  | z.infer<typeof ControlWorkspaceStageReviewRefusalSchema>
  | z.infer<typeof ControlWorkspaceBackendHandoffRefusalSchema>
  | z.infer<typeof ControlSchemaApplicationRefusalSchema>
  | z.infer<typeof ControlWorkerFinalStatusRefusalSchema>
  | z.infer<typeof ControlWorkerHeartbeatRefusalSchema>
  | z.infer<typeof ControlWorkerRecordRefusalSchema>
  | z.infer<typeof ControlExecutionAttemptRefusalSchema>
  | z.infer<typeof nanoHostFirstSubmissionRefusalSchema>
  | z.infer<typeof ControlCoreJournalRefusalSchema>
  | z.infer<typeof ControlWorkerImageRefusalSchema>
  | z.infer<typeof ControlRuntimeTargetRefusalSchema>
  | z.infer<typeof NanoHostOwnerRefusalSchema>
  | z.infer<typeof ControlBackendSessionRefusalSchema>
  | z.infer<typeof ControlHarnessLifecycleRefusalSchema>
  | z.infer<typeof ControlRecoveryTargetRegistrationRefusalSchema>
  | z.infer<typeof ControlRecoverySourceReactivationRefusalSchema>
  | ControlCoreSharingRefusal
  | CoreSchedulerRefusal;

/** Safe current impact only; native exception diagnostics and input facts never leave the owner. */
export const ControlSchemaApplicationRefusalSchema = z
  .object({
    operation: z.literal('schema-application'),
    code: z.enum([
      'invalid_request',
      'conflict',
      'review_required',
      'recovery_required',
      'idempotency_key_conflict',
      'workspace_access_denied',
      'schema_readset_changed',
      'operation_storage_unavailable',
    ]),
    message: z.enum([
      'Schema application invalid request.',
      'Schema application conflict.',
      'Schema application review required.',
      'Schema application recovery required.',
      'Schema application idempotency key conflict.',
      'Schema application workspace access denied.',
      'Schema application schema readset changed.',
      'Schema application operation storage unavailable.',
    ]),
    status: z.union([z.literal(400), z.literal(403), z.literal(409), z.literal(503)]),
    details: z
      .union([
        z
          .object({
            baseSchemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
            currentSchemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          })
          .strict(),
        z
          .object({
            reviewedReport: PreviewKnowledgeSchemaResponseSchema,
            actualReport: PreviewKnowledgeSchemaResponseSchema,
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

/**
 * Worker reply. Success for writes follows the outer FULL-durability COMMIT.
 *
 * Worker loss, missing replies and commit-unknown are not proof of non-commit. Inspect the original command receipt under its identity/fingerprint; this transport neither retries nor supplies another durable queue or recovery owner.
 */
export type ControlWorkerReply = {
  readonly version: typeof CONTROL_WORKER_VERSION;
  readonly id: number;
} & (
  | {
      readonly status: 'ok';
      readonly operation:
        | 'open'
        | 'close'
        | 'shutdown'
        | 'boot-audit'
        | 'worker-control-evidence'
        | 'products'
        | 'publication'
        | 'recovery-cleanup'
        | 'recovery-capture'
        | 'recovery-move-out';
    }
  | {
      readonly status: 'ok';
      readonly operation: 'recovery-safety';
      readonly result: ControlRecoverySafetyResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'nanohost-epoch-kernel';
      readonly result: NanoHostEpochKernelReply;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'nanohost-first-submission';
      readonly result: ControlNanoHostFirstSubmissionResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'nanohost-terminal-release';
      readonly result: StorageDecision<ExecutionStepRef>;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'repair-kernel';
      readonly result: RepairWorkerReply;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'server-work-kernel';
      readonly result: ServerWorkKernelReply;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'server-work-owner';
      readonly result: ServerWorkOwnerMutationResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'nanohost-owner';
      readonly result: NanoHostOwnerMutationResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'communication-kernel';
      readonly result: CommunicationKernelReply;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'communication-owner';
      readonly result: CommunicationWriterReply;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'nanohost-transport';
      readonly result: ControlNanoHostTransportResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'runtime-policy-publication';
      readonly result: RuntimePolicyPublicationResult;
    }
  | { readonly status: 'ok'; readonly operation: 'vault'; readonly result: ControlVaultResult }
  | { readonly status: 'ok'; readonly operation: 'admin-recovery'; readonly auditEventId: string }
  | {
      readonly status: 'ok';
      readonly operation: 'better-auth';
      readonly result: ControlBetterAuthResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'app-kernel';
      readonly result: ControlAppResult;
      readonly identity?: string;
    }
  | { readonly status: 'ok'; readonly operation: 'recovery-history'; readonly done: boolean }
  | { readonly status: 'ok'; readonly operation: 'recovery-seal'; readonly digest: string | null }
  | {
      readonly status: 'ok';
      readonly operation: 'provenance';
      readonly result: z.infer<typeof ControlProvenanceResultSchema>;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'thread-read-membership';
      readonly itemIds: string[];
    }
  | {
      readonly status: 'ok';
      readonly operation: 'evaluation-candidate';
      readonly result: import('@openkit/app-api-schemas').CandidateSetRecord;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'core-sharing';
      readonly result: ControlCoreSharingResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'workspace-backend-handoff';
      readonly result: ControlWorkspaceBackendHandoffResult;
    }
  | { readonly status: 'ok'; readonly operation: 'standalone-audit'; readonly result: null }
  | { readonly status: 'ok'; readonly operation: 'workspace-queue-input'; readonly result: null }
  | {
      readonly status: 'ok';
      readonly operation: 'resolved-agent-setup';
      readonly result: ControlResolvedAgentSetupResult;
    }
  | { readonly status: 'ok'; readonly operation: 'scoped-notebook-sql'; readonly result: null }
  | { readonly status: 'ok'; readonly operation: 'workspace-stage-review'; readonly result: null }
  | {
      readonly status: 'ok';
      readonly operation: 'private-workspace';
      readonly result: string | null;
    }
  | { readonly status: 'ok'; readonly operation: 'workspace-baseline'; readonly result: null }
  | {
      readonly status: 'ok';
      readonly operation: 'workspace-capture';
      readonly result: ControlWorkspaceCaptureResult;
    }
  | { readonly status: 'ok'; readonly operation: 'workspace-takeover'; readonly result: boolean }
  | {
      readonly status: 'ok';
      readonly operation: 'workspace-recovery-decision';
      readonly result: z.infer<typeof ControlWorkspaceRecoveryDecisionResultSchema>;
    }
  | { readonly status: 'ok'; readonly operation: 'workspace-review-finish'; readonly result: null }
  | {
      readonly status: 'ok';
      readonly operation: 'workspace-review-decision';
      readonly result: import('@openkit/app-api-schemas').WorkspaceSyncReviewItem;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'workspace-apply-plan';
      readonly result: ControlWorkspaceApplyPlan;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'automation-scanner';
      readonly result: ControlAutomationScannerResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'security-trigger';
      readonly result: ControlSecurityTriggerResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'worker-storage-binding';
      readonly result: import('../runtime/worker-storage-binding-records.js').WorkerStorageBinding;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'harness-lifecycle';
      readonly result: ControlHarnessLifecycleResult;
      readonly idleAcknowledgedAt?: string;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'execution-attempt';
      readonly result: ControlExecutionAttemptResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'recovery-source-reactivation';
      readonly result: null;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'recovery-target-preparation';
      readonly result: null;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'recovery-target-registration';
      readonly result: WorkspaceRecoveryCliReport;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'workspace-deletion';
      readonly result: ControlWorkspaceDeletionResult;
    }
  | { readonly status: 'ok'; readonly operation: 'core-journal'; readonly result: string | null }
  | { readonly status: 'ok'; readonly operation: 'worker-image'; readonly result: null }
  | {
      readonly status: 'ok';
      readonly operation: 'local-identity';
      readonly result: string;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'bootstrap-consume';
      readonly result: ControlBootstrapConsumeResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'bootstrap-ensure';
      readonly result: ControlBootstrapEnsureResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'access-token-lifecycle';
      readonly result: ControlAccessTokenLifecycleResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'server-admin-token-default';
      readonly result: boolean;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'access-token-verification';
      readonly result: ControlAccessTokenVerificationResult;
    }
  | { readonly status: 'ok'; readonly operation: 'remote-mcp-audit'; readonly result: null }
  | {
      readonly status: 'ok';
      readonly operation: 'runtime-target';
      readonly result: ControlRuntimeTargetResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'backend-session';
      readonly result: ControlBackendSessionResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'worker-control-final-status';
      readonly result: ControlWorkerFinalStatusResult | z.infer<typeof nanoHostFinalCoreResult>;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'worker-control-heartbeat';
      readonly result: ControlWorkerHeartbeatResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'worker-control-record';
      readonly result: ControlWorkerRecordResult;
    }
  | { readonly status: 'ok'; readonly operation: 'journal'; readonly resultJson: string }
  | {
      readonly status: 'ok';
      readonly operation: 'generative-presentation';
      readonly presentationId: string;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'item';
      readonly result: ControlItemAppend['item'];
    }
  | {
      readonly status: 'ok';
      readonly operation: 'event';
      readonly result: ControlEventAppendResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'pending';
      readonly result: ControlPendingCommandResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'write';
      readonly results: readonly ControlSqlResult[];
    }
  | {
      readonly status: 'ok';
      readonly operation: 'transition';
      readonly result:
        | ControlAdmissionResult
        | ControlKnowledgeAdmissionResult
        | CoreSchedulerResult
        | null;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'project-cleanup';
      readonly result: WorkerBackendCleanupProjectionResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'observation';
      readonly result: ControlWorkObservationResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'capability';
      readonly result: ControlCapabilityCommandResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'goal';
      readonly result: ControlGoalCommandResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'schema-application';
      readonly result: ApplyKnowledgeSchemaResponse;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'material';
      readonly result: ControlMaterialCommandResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'review';
      readonly result: ControlReviewCommandResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'terminal';
      readonly result: ControlTerminalResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'checkpoint';
      readonly pressure: {
        readonly busy: number;
        readonly log: number;
        readonly checkpointed: number;
        readonly walBytes: number;
        readonly walAgeMs: number;
      };
    }
  | { readonly status: 'ok'; readonly operation: 'reclaim'; readonly complete: boolean }
  | {
      readonly status: 'error';
      readonly code: ControlWorkerFailureCode;
      readonly commit: 'not-committed' | 'unknown';
      readonly domain?: ControlWorkerDomainRefusal;
    }
);

/** Checks cloneable SQLite values without accepting non-finite or executable content. */
export function isControlSqlValue(value: unknown): value is ControlSqlValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (value instanceof Uint8Array && !(value.buffer instanceof SharedArrayBuffer))
  );
}

/** Recognizes data records, not dates, binary buffers, arrays or other native objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Checks a materialized result; no iterator or callback may cross the boundary. */
function isSqlResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const result = value;
  if (result.mode === 'run') {
    return (
      Number.isSafeInteger(result.changes) &&
      (result.changes as number) >= 0 &&
      (typeof result.lastInsertRowid === 'bigint' || Number.isSafeInteger(result.lastInsertRowid))
    );
  }
  return (
    result.mode === 'get' &&
    (result.row === null ||
      (isRecord(result.row) && Object.values(result.row).every(isControlSqlValue)))
  );
}

/** Validates only a trusted, bounded domain refusal, never an arbitrary native exception or SQL message. */
function isDomainRefusal(value: unknown): value is ControlWorkerDomainRefusal {
  if (isRecord(value) && value.operation === 'observation')
    return (
      value.code === OBSERVATION_POSITION_CONFLICT.code &&
      value.message === OBSERVATION_POSITION_CONFLICT.message &&
      value.status === OBSERVATION_POSITION_CONFLICT.status &&
      exactFields(value, ['operation', 'code', 'message', 'status'])
    );
  if (isRecord(value) && value.operation === 'security-trigger')
    return ControlSecurityTriggerRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'automation-scanner')
    return (
      value.code === 'unsupported_retained_format' &&
      value.message === 'Unsupported retained record format.' &&
      value.status === 409 &&
      exactFields(value, ['operation', 'code', 'message', 'status'])
    );
  if (isRecord(value) && value.operation === 'recovery-source-reactivation')
    return ControlRecoverySourceReactivationRefusalSchema.safeParse(value).success;
  if (
    isRecord(value) &&
    (value.operation === 'recovery-target-registration' ||
      value.operation === 'recovery-target-preparation')
  )
    return ControlRecoveryTargetRegistrationRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'private-workspace')
    return ControlPrivateWorkspaceRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'resolved-agent-setup')
    return ControlResolvedAgentSetupRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'workspace-stage-review')
    return ControlWorkspaceStageReviewRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'workspace-recovery-decision')
    return ControlWorkspaceRecoveryDecisionRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'workspace-takeover')
    return ControlWorkspaceTakeoverRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'workspace-capture')
    return ControlWorkspaceCaptureRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'workspace-baseline')
    return ControlWorkspaceBaselineRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'workspace-backend-handoff')
    return ControlWorkspaceBackendHandoffRefusalSchema.safeParse(value).success;
  if (
    isRecord(value) &&
    (value.operation === 'workspace-review-decision' ||
      value.operation === 'workspace-review-finish')
  ) {
    const facts =
      typeof value.code === 'string' && Object.hasOwn(WORKSPACE_REVIEW_REFUSALS, value.code)
        ? WORKSPACE_REVIEW_REFUSALS[value.code as keyof typeof WORKSPACE_REVIEW_REFUSALS]
        : undefined;
    return (
      !!facts &&
      exactFields(value, ['operation', 'code', 'message', 'status']) &&
      value.message === facts.message &&
      value.status === facts.status
    );
  }
  if (isRecord(value) && value.operation === 'workspace-apply-plan')
    return (
      exactFields(value, ['operation', 'code', 'message', 'status']) &&
      typeof value.message === 'string' &&
      Buffer.byteLength(value.message) <= CONTROL_PRODUCT_LIMITS.metadataBytes &&
      ((value.code === 'workspace_sync_review_failed' &&
        value.status === 404 &&
        value.message === 'Workspace apply plan replay conflict.') ||
        (value.code === 'unsupported_retained_format' &&
          value.status === 409 &&
          value.message === 'Unsupported retained record format.'))
    );

  if (isRecord(value) && value.operation === 'core-journal')
    return ControlCoreJournalRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'worker-image')
    return ControlWorkerImageRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'nanohost-owner')
    return NanoHostOwnerRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'communication-owner')
    return communicationOwnerRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'runtime-target')
    return ControlRuntimeTargetRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'backend-session')
    return ControlBackendSessionRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'worker-control-record')
    return ControlWorkerRecordRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'worker-control-heartbeat')
    return ControlWorkerHeartbeatRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'worker-control-final-status')
    return ControlWorkerFinalStatusRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'execution-attempt')
    return ControlExecutionAttemptRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'nanohost-first-submission')
    return nanoHostFirstSubmissionRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'harness-lifecycle')
    return ControlHarnessLifecycleRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'worker-storage-binding')
    return ControlWorkerStorageRefusalSchema.safeParse(value).success;
  if (
    isRecord(value) &&
    value.operation === 'transition' &&
    ['decoder', 'authority', 'transition', 'turn'].includes(String(value.kind))
  )
    return (
      Buffer.byteLength(JSON.stringify(value)) <= CONTROL_PRODUCT_LIMITS.metadataBytes &&
      CoreSchedulerRefusalSchema.safeParse(value).success
    );
  if (isRecord(value) && value.operation === 'core-sharing')
    return ControlCoreSharingRefusalSchema.safeParse(value).success;
  if (isRecord(value) && value.operation === 'schema-application')
    return ControlSchemaApplicationRefusalSchema.safeParse(value).success;

  if (isRecord(value) && value.operation === 'app-kernel')
    return ControlAppRefusalSchema.safeParse(value).success;

  return (
    isRecord(value) &&
    exactFields(value, ['operation', 'code', 'message', 'status'], ['kind']) &&
    (value.kind === undefined ||
      (value.operation === 'capability' &&
        ['operation', 'mcp', 'turn', 'pending', 'ledger'].includes(String(value.kind)))) &&
    (value.kind !== 'ledger' ||
      (value.operation === 'capability' &&
        value.code === 'capability_ledger_refused' &&
        value.status === 409)) &&
    // This reserved owner refusal carries no native exception text or SQL details.
    (value.code !== 'unsupported_retained_format' ||
      ((value.operation === 'goal' || value.operation === 'capability') &&
        value.message === 'Unsupported retained record format.' &&
        value.status === 409)) &&
    ((['event', 'products', 'transition', 'terminal', 'publication', 'server-work-owner'].includes(
      String(value.operation)
    ) &&
      value.code === 'core.protocol.invalid_delta' &&
      value.message === ITEM_DELTA_PROTOCOL_MESSAGE &&
      value.status === 409) ||
      (value.operation === 'provenance' &&
        value.code === 'conflict' &&
        value.status === 409 &&
        ['Runtime evidence replay conflict.', 'Runtime provenance replay conflict.'].includes(
          String(value.message)
        )) ||
      ((value.operation === 'item' || value.operation === 'event') &&
        value.code === 'conflict' &&
        value.status === 409) ||
      (value.operation === 'vault' &&
        isControlVaultRefusal(value.code, value.message, value.status)) ||
      (value.operation === 'nanohost-transport' &&
        isNanoHostTransportAdminRefusal(value.code, value.message, value.status)) ||
      (value.operation === 'better-auth' &&
        isBetterAuthRefusal(value.code, value.message, value.status)) ||
      (value.operation === 'admin-recovery' &&
        value.status === 409 &&
        value.code === 'recovery_required' &&
        value.message === ADMIN_RECOVERY_REQUIRED) ||
      (value.operation === 'thread-read-membership' &&
        value.status === 409 &&
        value.code === 'recovery_required' &&
        value.message === THREAD_READ_RECEIPT_INVALID) ||
      (value.operation === 'generative-presentation' &&
        value.status === 409 &&
        ((value.code === 'idempotency_key_conflict' &&
          value.message === 'The requestId was already used for different command input.') ||
          (value.code === 'recovery_required' &&
            [
              'Interrupted presentation publication requires recovery.',
              'Interrupted answer publication requires recovery.',
            ].includes(String(value.message))))) ||
      value.operation === 'goal' ||
      value.operation === 'capability' ||
      value.operation === 'pending' ||
      ((value.operation === 'products' || value.operation === 'transition') &&
        ['request_executing', 'thread_busy', 'conflict'].includes(String(value.code)) &&
        value.status === 409) ||
      ((value.operation === 'material' ||
        value.operation === 'review' ||
        value.operation === 'evaluation-candidate') &&
        ((['stale', 'conflict', 'recovery_required', 'idempotency_key_conflict'].includes(
          String(value.code)
        ) &&
          value.status === 409) ||
          (['source_digest_mismatch', 'invalid_request'].includes(String(value.code)) &&
            value.status === 400) ||
          (value.code === 'not_found' && value.status === 404))) ||
      (value.operation === 'transition' &&
        ((value.code === 'invalid_request' && value.status === 400) ||
          ((value.code === 'recovery_required' || value.code === 'idempotency_key_conflict') &&
            value.status === 409)))) &&
    typeof value.code === 'string' &&
    value.code.length > 0 &&
    value.code.length <= 128 &&
    typeof value.message === 'string' &&
    Buffer.byteLength(value.message) <= CONTROL_PRODUCT_LIMITS.metadataBytes &&
    Number.isInteger(value.status) &&
    (value.status as number) >= 400 &&
    (value.status as number) <= 599
  );
}

/**
 * Checks worker replies before a caller promise can be completed.
 *
 * Unknown additive fields are ignored; unknown versions, operations and core result values fail closed.
 *
 * @param value Structured-cloned message from the dedicated writer.
 * @returns Whether its closed core has a supported meaning.
 */
export function isControlWorkerReply(value: unknown): value is ControlWorkerReply {
  if (!isRecord(value)) return false;
  const reply = value;
  if (
    reply.version !== CONTROL_WORKER_VERSION ||
    !Number.isSafeInteger(reply.id) ||
    (reply.id as number) < 0
  )
    return false;
  if (reply.status === 'error') {
    return (
      CONTROL_WORKER_FAILURE_CODES.some((code) => code === reply.code) &&
      (reply.commit === 'not-committed' || reply.commit === 'unknown') &&
      (reply.domain === undefined ||
        (reply.code === 'precondition' &&
          reply.commit === 'not-committed' &&
          isDomainRefusal(reply.domain)))
    );
  }
  if (reply.status !== 'ok') return false;
  if (reply.operation === 'recovery-seal')
    return (
      reply.digest === null ||
      (typeof reply.digest === 'string' && /^[0-9a-f]{64}$/.test(reply.digest))
    );
  if (reply.operation === 'recovery-history') return typeof reply.done === 'boolean';
  if (reply.operation === 'recovery-safety')
    return (
      reply.result === 'preserved' || reply.result === 'unavailable' || reply.result === 'moved-out'
    );
  if (reply.operation === 'runtime-policy-publication')
    return RuntimePolicyPublicationResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'vault') return ControlVaultResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'nanohost-epoch-kernel')
    return (
      exactFields(reply, ['version', 'id', 'status', 'operation', 'result']) &&
      NanoHostEpochKernelReplySchema.safeParse(reply.result).success
    );
  if (reply.operation === 'nanohost-first-submission')
    return (
      exactFields(reply, ['version', 'id', 'status', 'operation', 'result']) &&
      ControlNanoHostFirstSubmissionResultSchema.safeParse(reply.result).success
    );
  if (reply.operation === 'nanohost-terminal-release')
    return (
      exactFields(reply, ['version', 'id', 'status', 'operation', 'result']) &&
      nanoHostTerminalReleaseResult.safeParse(reply.result).success
    );
  if (reply.operation === 'repair-kernel')
    return RepairWorkerReplySchema.safeParse(reply.result).success;
  if (reply.operation === 'server-work-kernel')
    return (
      exactFields(reply, ['version', 'id', 'status', 'operation', 'result']) &&
      serverWorkKernelReplySchema.safeParse(reply.result).success
    );
  if (reply.operation === 'server-work-owner')
    return (
      exactFields(reply, ['version', 'id', 'status', 'operation', 'result']) &&
      serverWorkOwnerResultSchema.safeParse(reply.result).success
    );
  if (reply.operation === 'nanohost-owner')
    return (
      exactFields(reply, ['version', 'id', 'status', 'operation', 'result']) &&
      nanoHostOwnerResultSchema.safeParse(reply.result).success
    );
  if (reply.operation === 'communication-kernel')
    return (
      exactFields(reply, ['version', 'id', 'status', 'operation', 'result']) &&
      communicationKernelReplySchema.safeParse(reply.result).success
    );
  if (reply.operation === 'communication-owner')
    return (
      exactFields(reply, ['version', 'id', 'status', 'operation', 'result']) &&
      isRecord(reply.result) &&
      typeof reply.result.stage === 'string'
    );
  if (reply.operation === 'nanohost-transport')
    return ControlNanoHostTransportResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'better-auth')
    return ControlBetterAuthResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'admin-recovery')
    return typeof reply.auditEventId === 'string' && reply.auditEventId.length > 0;
  if (reply.operation === 'app-kernel')
    return (
      exactFields(reply, ['version', 'id', 'status', 'operation', 'result'], ['identity']) &&
      (reply.identity === undefined ||
        (typeof reply.identity === 'string' && /^\d+:\d+$/.test(reply.identity))) &&
      ControlAppResultSchema.safeParse(reply.result).success
    );
  if (reply.operation === 'thread-read-membership')
    return ThreadReadMembershipResultSchema.safeParse(reply.itemIds).success;
  if (reply.operation === 'generative-presentation')
    return typeof reply.presentationId === 'string';
  if (reply.operation === 'provenance')
    return ControlProvenanceResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'event') return SseEventEnvelopeSchema.safeParse(reply.result).success;
  if (reply.operation === 'item') return ItemSchema.safeParse(reply.result).success;
  if (
    reply.operation === 'open' ||
    reply.operation === 'close' ||
    reply.operation === 'shutdown' ||
    reply.operation === 'boot-audit' ||
    reply.operation === 'worker-control-evidence' ||
    reply.operation === 'products' ||
    reply.operation === 'recovery-cleanup' ||
    reply.operation === 'recovery-capture' ||
    reply.operation === 'recovery-move-out' ||
    reply.operation === 'publication'
  )
    return true;
  if (reply.operation === 'project-cleanup')
    return WorkerBackendCleanupProjectionResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'capability')
    return ControlCapabilityCommandResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'observation') {
    if (ObservationOmissionResultSchema.safeParse(reply.result).success) return true;
    if (
      !isRecord(reply.result) ||
      (reply.result.disposition !== 'committed' && reply.result.disposition !== 'duplicate')
    )
      return false;
    try {
      const observation = parseWorkObservationRecord(reply.result.observation);
      if (reply.result.publication === null) return true;
      const publication = parseWorkObservationRecord(reply.result.publication);
      return publication.type === 'content.published' && publication.parent === observation.id;
    } catch {
      return false;
    }
  }
  if (reply.operation === 'terminal') {
    const result = reply.result;
    return (
      isRecord(result) &&
      typeof result.turnId === 'string' &&
      result.turnId.length > 0 &&
      Number.isSafeInteger(result.revision) &&
      (result.revision as number) > 0 &&
      typeof result.replayed === 'boolean' &&
      (result.reap === null ||
        (isRecord(result.reap) &&
          typeof result.reap.id === 'string' &&
          result.reap.id.length > 0 &&
          Number.isSafeInteger(result.reap.sequence) &&
          (result.reap.sequence as number) > 0)) &&
      (result.response === null ||
        (isRecord(result.response) &&
          result.response.kind === 'turn' &&
          result.response.id === result.turnId)) &&
      (result.execution === null ||
        (isRecord(result.execution) &&
          typeof result.execution.executionId === 'string' &&
          result.execution.executionId.length > 0 &&
          Number.isSafeInteger(result.execution.revision) &&
          (result.execution.revision as number) > 0 &&
          (result.execution.phase === 'closing' || result.execution.phase === 'closed')))
    );
  }
  if (reply.operation === 'pending')
    return ControlPendingCommandResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'journal')
    return (
      typeof reply.resultJson === 'string' &&
      Buffer.byteLength(reply.resultJson) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (reply.operation === 'review')
    return ControlReviewCommandResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'worker-control-record')
    return ControlWorkerRecordResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'worker-control-heartbeat')
    return ControlWorkerHeartbeatResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'worker-control-final-status')
    return (
      ControlWorkerFinalStatusResultSchema.safeParse(reply.result).success ||
      nanoHostFinalCoreResult.safeParse(reply.result).success
    );
  if (
    reply.operation === 'recovery-target-preparation' ||
    reply.operation === 'recovery-source-reactivation'
  )
    return reply.result === null;
  if (reply.operation === 'recovery-target-registration')
    return ControlRecoveryTargetRegistrationResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'workspace-deletion')
    return ControlWorkspaceDeletionResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'core-journal')
    return reply.result === null || typeof reply.result === 'string';
  if (reply.operation === 'worker-image' || reply.operation === 'remote-mcp-audit')
    return reply.result === null;
  if (reply.operation === 'local-identity')
    return ControlLocalIdentityResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'bootstrap-consume')
    return ControlBootstrapConsumeResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'bootstrap-ensure')
    return ControlBootstrapEnsureResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'access-token-lifecycle')
    return ControlAccessTokenLifecycleResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'server-admin-token-default') return typeof reply.result === 'boolean';
  if (reply.operation === 'access-token-verification')
    return ControlAccessTokenVerificationResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'runtime-target')
    return ControlRuntimeTargetResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'private-workspace')
    return ControlPrivateWorkspaceResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'standalone-audit' || reply.operation === 'workspace-queue-input')
    return reply.result === null;
  if (reply.operation === 'resolved-agent-setup')
    return ControlResolvedAgentSetupResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'scoped-notebook-sql') return reply.result === null;
  if (reply.operation === 'workspace-stage-review') return reply.result === null;
  if (reply.operation === 'workspace-baseline') return reply.result === null;
  if (reply.operation === 'workspace-recovery-decision')
    return ControlWorkspaceRecoveryDecisionResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'workspace-takeover')
    return ControlWorkspaceTakeoverResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'workspace-capture')
    return ControlWorkspaceCaptureResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'workspace-backend-handoff')
    return ControlWorkspaceBackendHandoffResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'workspace-review-finish') return reply.result === null;
  if (reply.operation === 'workspace-review-decision')
    return ControlWorkspaceReviewDecisionResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'security-trigger')
    return ControlSecurityTriggerResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'automation-scanner')
    return ControlAutomationScannerResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'workspace-apply-plan')
    return ControlWorkspaceApplyPlanSchema.safeParse(reply.result).success;
  if (reply.operation === 'backend-session')
    return ControlBackendSessionResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'execution-attempt')
    return ControlExecutionAttemptResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'harness-lifecycle')
    return (
      ControlHarnessLifecycleResultSchema.safeParse(reply.result).success &&
      (reply.idleAcknowledgedAt === undefined ||
        (reply.result === null && z.iso.datetime().safeParse(reply.idleAcknowledgedAt).success))
    );
  if (reply.operation === 'worker-storage-binding')
    return ControlWorkerStorageResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'core-sharing')
    return ControlCoreSharingResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'evaluation-candidate')
    return ControlEvaluationCandidateResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'schema-application')
    return ApplyKnowledgeSchemaResponseSchema.safeParse(reply.result).success;
  if (reply.operation === 'material')
    return ControlMaterialCommandResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'goal') {
    return (
      isRecord(reply.result) &&
      typeof reply.result.replayed === 'boolean' &&
      GoalViewSchema.safeParse(reply.result.view).success &&
      (reply.result.refusal === null ||
        (isRecord(reply.result.refusal) &&
          isDomainRefusal({ ...reply.result.refusal, operation: 'goal' })))
    );
  }
  if (reply.operation === 'write')
    return Array.isArray(reply.results) && reply.results.every(isSqlResult);
  if (reply.operation === 'transition') {
    return (
      reply.result === null ||
      CoreSchedulerResultSchema.safeParse(reply.result).success ||
      ControlKnowledgeAdmissionResultSchema.safeParse(reply.result).success ||
      (isRecord(reply.result) &&
        typeof reply.result.replayed === 'boolean' &&
        isRecord(reply.result.response) &&
        ['thread', 'turn'].includes(String(reply.result.response.kind)) &&
        typeof reply.result.response.id === 'string' &&
        reply.result.response.id.length > 0)
    );
  }
  if (reply.operation === 'reclaim') return typeof reply.complete === 'boolean';
  if (reply.operation !== 'checkpoint' || !isRecord(reply.pressure)) return false;
  const pressure = reply.pressure as Record<string, unknown>;
  return (
    Number.isSafeInteger(pressure.busy) &&
    (pressure.busy as number) >= 0 &&
    Number.isSafeInteger(pressure.log) &&
    (pressure.log as number) >= -1 &&
    Number.isSafeInteger(pressure.checkpointed) &&
    (pressure.checkpointed as number) >= -1 &&
    Number.isSafeInteger(pressure.walBytes) &&
    (pressure.walBytes as number) >= 0 &&
    typeof pressure.walAgeMs === 'number' &&
    Number.isFinite(pressure.walAgeMs) &&
    pressure.walAgeMs >= 0
  );
}

/** Removes quoted data/identifiers and comments only for the narrow SQL admission checks. */
function sqlCode(sql: string): string {
  // SQLite ends -- comments only at LF; a CR and any quotes after it are still comment data.
  return sql.replace(
    /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/g,
    ' '
  );
}

/** Refuses SQLite semantics that can roll back an outer batch instead of one savepoint. */
export function hasControlSqlRollback(sql: string): boolean {
  return /\bROLLBACK\b/i.test(sqlCode(sql));
}

/** Effect messages have exact keys; no unknown assertion can silently disappear. */
function exactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

/** Checks a trusted SQL step without permitting transaction control or shared mutable bindings. */
function isSqlStatement(value: unknown): value is ControlSqlStatement {
  if (!isRecord(value) || typeof value.sql !== 'string' || !Array.isArray(value.parameters))
    return false;
  if (
    !/^(SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|EXPLAIN|VALUES)\b/i.test(
      sqlCode(value.sql).trimStart()
    ) ||
    hasControlSqlRollback(value.sql)
  )
    return false;
  if (!value.parameters.every(isControlSqlValue)) return false;
  if (value.mode === 'run') {
    return (
      exactFields(value, ['mode', 'sql', 'parameters'], ['expectChanges']) &&
      (value.expectChanges === undefined ||
        (Number.isSafeInteger(value.expectChanges) && (value.expectChanges as number) >= 0))
    );
  }
  return (
    value.mode === 'get' &&
    exactFields(value, ['mode', 'sql', 'parameters'], ['expectRow']) &&
    (value.expectRow === undefined || value.expectRow === 'present' || value.expectRow === 'absent')
  );
}

/** Reads only an ordinary, fixed, attached ArrayBuffer; native getters reject forged or shared backing. */
export function controlMaterialArrayBufferByteLength(value: unknown): number | undefined {
  try {
    if (!(value instanceof ArrayBuffer)) return undefined;
    const prototype = ArrayBuffer.prototype;
    const byteLength = Object.getOwnPropertyDescriptor(prototype, 'byteLength')!.get!.call(
      value
    ) as number;
    if (
      Object.getOwnPropertyDescriptor(prototype, 'resizable')?.get?.call(value) ||
      Object.getOwnPropertyDescriptor(prototype, 'detached')?.get?.call(value)
    )
      return undefined;
    return byteLength;
  } catch {
    return undefined;
  }
}

/** Bounds contiguous binary fields and reserves the UTF-8 text echoed by range replies until settlement. */
export function controlMaterialTransferSize(
  input: ControlMaterialWireInput
): { byteLength: number; replyByteLength: number } | undefined {
  let byteLength = 0;
  for (const span of controlMaterialTextSpans(input)) {
    if (span.offset !== byteLength || !Number.isSafeInteger(byteLength + span.byteLength))
      return undefined;
    byteLength += span.byteLength;
  }
  return {
    byteLength,
    replyByteLength:
      input.mode === 'range-correct' || input.mode === 'range-judgement' ? byteLength : 0,
  };
}

/** Charges exact transferred WorkBody bytes within the existing per-database binary budget. */
export function controlWorkObservationTransferSize(
  input: ControlWorkObservationCommandInput
): number | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  if ('chunk' in input)
    return ControlWorkObservationChunkInputSchema.safeParse(input).success
      ? input.chunk.byteLength
      : undefined;
  if (!ControlWorkObservationInputSchema.safeParse(input).success) return undefined;
  const bytes = input.publishBodies ? input.bodies.reduce((sum, body) => sum + body.bytes, 0) : 0;
  return Number.isSafeInteger(bytes) && bytes <= CONTROL_WORKER_LIMITS.materialPendingBytes
    ? bytes
    : undefined;
}

/**
 * Validates the complete effect-bearing request before posting and again before native admission.
 *
 * @param value Proposed message including its transient correlation header.
 * @returns Whether every effect/assertion is supported; unknown fields fail closed.
 */
export function isControlWorkerRequest(value: unknown): value is ControlWorkerRequest {
  if (
    !isRecord(value) ||
    value.version !== CONTROL_WORKER_VERSION ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 0
  )
    return false;
  const header = ['version', 'id', 'operation'];
  if (value.operation === 'shutdown') return exactFields(value, header);
  if (typeof value.database !== 'string' || value.database.length === 0) return false;
  const scoped = [...header, 'database'];
  if (value.operation === 'recovery-source-reactivation')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlRecoverySourceReactivationInputSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'recovery-target-preparation')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlRecoveryTargetPreparationInputSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'recovery-target-registration')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlRecoveryTargetRegistrationInputSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'workspace-deletion')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlWorkspaceDeletionInputSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'recovery-history')
    return (
      exactFields(value, [...scoped, 'workspaceId']) &&
      WorkspaceIdSchema.safeParse(value.workspaceId).success
    );
  if (value.operation === 'recovery-safety')
    return (
      exactFields(value, [...scoped, 'input']) &&
      isRecord(value.input) &&
      exactFields(value.input, ['workspaceId', 'sourceDataRoot']) &&
      WorkspaceIdSchema.safeParse(value.input.workspaceId).success &&
      typeof value.input.sourceDataRoot === 'string' &&
      isAbsolute(value.input.sourceDataRoot) &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'recovery-move-out')
    return (
      exactFields(value, [...scoped, 'input']) &&
      isRecord(value.input) &&
      exactFields(value.input, [
        'workspaceId',
        'captureId',
        'expectedRevision',
        'manifestDigest',
      ]) &&
      WorkspaceIdSchema.safeParse(value.input.workspaceId).success &&
      typeof value.input.captureId === 'string' &&
      value.input.captureId.trim().length > 0 &&
      Number.isSafeInteger(value.input.expectedRevision) &&
      Number(value.input.expectedRevision) >= 1 &&
      typeof value.input.manifestDigest === 'string' &&
      /^sha256:[0-9a-f]{64}(?![\s\S])/.test(value.input.manifestDigest) &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'recovery-capture')
    return (
      exactFields(value, [...scoped, 'input']) &&
      isRecord(value.input) &&
      exactFields(value.input, ['workspaceId', 'captureId', 'state']) &&
      WorkspaceIdSchema.safeParse(value.input.workspaceId).success &&
      typeof value.input.captureId === 'string' &&
      value.input.captureId.trim().length > 0 &&
      (value.input.state === 'finished' || value.input.state === 'abandoned') &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'recovery-cleanup')
    return (
      exactFields(value, [...scoped, 'input']) &&
      isRecord(value.input) &&
      exactFields(value.input, ['workspaceId', 'action', 'summary', 'preparation']) &&
      WorkspaceIdSchema.safeParse(value.input.workspaceId).success &&
      (value.input.action === 'workspace.restore' || value.input.action === 'workspace.move-in') &&
      typeof value.input.summary === 'string' &&
      isRecord(value.input.preparation) &&
      exactFields(value.input.preparation, [
        'now',
        'requiredFeatures',
        'restricted',
        'ownerId',
        'memberMappings',
      ]) &&
      typeof value.input.preparation.now === 'string' &&
      Number.isFinite(Date.parse(value.input.preparation.now)) &&
      Array.isArray(value.input.preparation.requiredFeatures) &&
      value.input.preparation.requiredFeatures.every((feature) => typeof feature === 'string') &&
      typeof value.input.preparation.restricted === 'boolean' &&
      UserIdSchema.safeParse(value.input.preparation.ownerId).success &&
      Array.isArray(value.input.preparation.memberMappings) &&
      value.input.preparation.memberMappings.every(
        (pair) =>
          isRecord(pair) &&
          exactFields(pair, ['sourceAccountId', 'targetAccountId']) &&
          UserIdSchema.safeParse(pair.sourceAccountId).success &&
          UserIdSchema.safeParse(pair.targetAccountId).success
      ) &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'event')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlEventAppendSchema.safeParse(value.input).success
    );
  if (value.operation === 'item')
    return (
      exactFields(value, [...scoped, 'input'], ['mcpCall']) &&
      ControlItemAppendSchema.safeParse(value.input).success &&
      (value.mcpCall === undefined ||
        (ControlMcpItemCallSchema.safeParse(value.mcpCall).success &&
          Buffer.byteLength(JSON.stringify(value.mcpCall)) <= CONTROL_PRODUCT_LIMITS.payloadBytes))
    );
  if (value.operation === 'open') {
    return (
      exactFields(
        value,
        [...scoped, 'path', 'create'],
        [
          'initialize',
          'productOwner',
          'physicalScope',
          'dataRoot',
          'contentMount',
          'serverOwner',
          'migrateServerOwner',
          'communicationExpiryPolicy',
        ]
      ) &&
      typeof value.path === 'string' &&
      isAbsolute(value.path) &&
      typeof value.create === 'boolean' &&
      (value.dataRoot === undefined ||
        (typeof value.dataRoot === 'string' && isAbsolute(value.dataRoot))) &&
      (value.migrateServerOwner === undefined ||
        (value.migrateServerOwner === true && value.serverOwner !== undefined && !value.create)) &&
      (value.communicationExpiryPolicy === undefined ||
        (isRecord(value.serverOwner) &&
          value.serverOwner.owner === 'communication' &&
          value.communicationExpiryPolicy instanceof SharedArrayBuffer &&
          value.communicationExpiryPolicy.byteLength === BigInt64Array.BYTES_PER_ELEMENT)) &&
      (value.serverOwner === undefined ||
        (isRecord(value.serverOwner) &&
          exactFields(value.serverOwner, ['owner']) &&
          typeof value.serverOwner.owner === 'string' &&
          value.serverOwner.owner !== 'discord' &&
          Object.hasOwn(SPLIT_STORAGE_JOURNALS, value.serverOwner.owner) &&
          value.productOwner === undefined &&
          value.initialize === undefined &&
          value.physicalScope === undefined &&
          value.contentMount === undefined &&
          typeof value.dataRoot === 'string')) &&
      (value.physicalScope === undefined ||
        (ControlAppScopeSchema.safeParse(value.physicalScope).success &&
          value.productOwner === undefined &&
          value.initialize === undefined &&
          value.contentMount === undefined &&
          typeof value.dataRoot === 'string')) &&
      (value.productOwner === undefined ||
        StoredWorkOwnerV1Schema.safeParse(value.productOwner).success) &&
      (value.contentMount === undefined ||
        (ControlProductContentMountSchema.safeParse(value.contentMount).success &&
          isAbsolute((value.contentMount as ControlProductContentMount).root))) &&
      (value.initialize === undefined ||
        value.initialize === 'core' ||
        value.initialize === 'user' ||
        value.initialize === 'workspace')
    );
  }
  if (
    value.operation === 'transition' &&
    isRecord(value.transition) &&
    value.transition.kind === 'scheduler-work'
  ) {
    const parsed = CoreSchedulerWireSchema.safeParse(value.transition.input);
    return (
      parsed.success &&
      exactFields(value, [...scoped, 'transition', 'content']) &&
      exactFields(value.transition, ['kind', 'input']) &&
      controlMaterialArrayBufferByteLength(value.content) === parsed.data.byteLength
    );
  }
  if (
    value.operation === 'transition' &&
    isRecord(value.transition) &&
    value.transition.kind === 'command-receipt'
  ) {
    const parsed = ControlScalarTextSchema.safeParse(value.transition.input);
    return (
      parsed.success &&
      exactFields(value, [...scoped, 'transition', 'content']) &&
      exactFields(value.transition, ['kind', 'input']) &&
      parsed.data.byteLength <= CONTROL_WORKER_LIMITS.materialPendingBytes &&
      controlMaterialArrayBufferByteLength(value.content) === parsed.data.byteLength
    );
  }
  if (value.operation === 'transition' || value.operation === 'products') {
    try {
      const schema =
        value.operation === 'transition'
          ? ControlAdmissionInputSchema
          : ControlProductTransitionSchema;
      const parsed = schema.safeParse(value.transition);
      return (
        exactFields(value, [...scoped, 'transition']) &&
        parsed.success &&
        ('products' in parsed.data
          ? controlProductMetadataJson(parsed.data).length <= 2 * 1024 * 1024
          : 'input' in parsed.data &&
            Buffer.byteLength(JSON.stringify(parsed.data.input)) <=
              CONTROL_PRODUCT_LIMITS.payloadBytes)
      );
    } catch {
      return false;
    }
  }
  if (value.operation === 'capability') {
    try {
      const parsed = ControlCapabilityWireInputSchema.safeParse(value.input);
      if (
        !parsed.success ||
        !exactFields(value, [...scoped, 'input'], ['content', 'immediate']) ||
        (value.immediate !== undefined && typeof value.immediate !== 'boolean')
      )
        return false;
      const span = controlCapabilityText(parsed.data);
      return (
        (span
          ? controlMaterialArrayBufferByteLength(value.content) === span.byteLength
          : value.content === undefined) &&
        Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
      );
    } catch {
      return false;
    }
  }
  if (value.operation === 'material') {
    try {
      const parsed = ControlMaterialWireInputSchema.safeParse(value.input);
      if (!parsed.success || !exactFields(value, [...scoped, 'input'], ['content'])) return false;
      const size = controlMaterialTransferSize(parsed.data);
      if (!size) return false;
      const hasContent = controlMaterialTextSpans(parsed.data).length > 0;
      return (
        (hasContent
          ? controlMaterialArrayBufferByteLength(value.content) === size.byteLength
          : value.content === undefined) &&
        Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
      );
    } catch {
      return false;
    }
  }
  if (value.operation === 'runtime-policy-publication')
    return (
      exactFields(value, [...scoped, 'input']) &&
      RuntimePolicyPublicationInputSchema.safeParse(value.input).success
    );
  if (value.operation === 'vault') {
    if (
      !exactFields(value, [...scoped, 'input'], ['policyRead']) ||
      (value.policyRead !== undefined && value.policyRead !== true)
    )
      return false;
    // The shared closed Vault schema includes writer CAS, receipt activation and proven/fenced removal.
    const parsed = ControlVaultInputSchema.safeParse(value.input);
    if (value.policyRead && (!parsed.success || parsed.data.kind !== 'thread-login-activate'))
      return false;
    if (!parsed.success) return false;
    let boundedInput = value.input;
    if (parsed.data.kind === 'receipt-create' && parsed.data.record.workerAuthority) {
      // Session authority has no original aggregate cap (#613); the full request still counts
      // against offered/pending bytes. Keep the original receipt's per-record bound unchanged.
      const { workerAuthority: _workerAuthority, ...record } = parsed.data.record;
      boundedInput = { kind: parsed.data.kind, record };
    }
    return Buffer.byteLength(JSON.stringify(boundedInput)) <= CONTROL_PRODUCT_LIMITS.payloadBytes;
  }
  if (value.operation === 'nanohost-epoch-kernel')
    return (
      exactFields(value, [...scoped, 'openingRequestId', 'input']) &&
      Number.isSafeInteger(value.openingRequestId) &&
      (value.openingRequestId as number) >= 0 &&
      NanoHostEpochKernelInputSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (
    value.operation === 'nanohost-first-submission' ||
    value.operation === 'nanohost-terminal-release'
  ) {
    const schema =
      value.operation === 'nanohost-first-submission'
        ? ControlNanoHostFirstSubmissionInputSchema
        : ControlNanoHostTerminalReleaseInputSchema;
    return (
      exactFields(value, [...scoped, 'openingRequestId', 'input', 'peers']) &&
      Number.isSafeInteger(value.openingRequestId) &&
      (value.openingRequestId as number) >= 0 &&
      schema.safeParse(value.input).success &&
      nanoHostDecisionPeers.safeParse(value.peers).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  }
  if (value.operation === 'repair-kernel')
    return (
      exactFields(value, [...scoped, 'openingRequestId', 'input']) &&
      Number.isSafeInteger(value.openingRequestId) &&
      (value.openingRequestId as number) >= 0 &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes &&
      RepairWorkerInputSchema.safeParse(value.input).success
    );
  if (value.operation === 'server-work-kernel')
    return (
      exactFields(value, [...scoped, 'openingRequestId', 'input']) &&
      Number.isSafeInteger(value.openingRequestId) &&
      (value.openingRequestId as number) >= 0 &&
      serverWorkKernelInputSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'server-work-owner') {
    if (
      !exactFields(value, [...scoped, 'openingRequestId', 'mutation'], ['content']) ||
      !Number.isSafeInteger(value.openingRequestId) ||
      (value.openingRequestId as number) < 0
    )
      return false;
    const mutation = serverWorkOwnerMutationSchema.safeParse(value.mutation);
    if (!mutation.success) return false;
    if (mutation.data.kind === 'append-observation') {
      const byteLength = mutation.data.input.bodies.reduce(
        (total, body) => total + body.byteLength,
        0
      );
      return (
        byteLength <= CONTROL_WORKER_LIMITS.materialPendingBytes &&
        (value.content === undefined
          ? byteLength === 0
          : controlMaterialArrayBufferByteLength(value.content) === byteLength) &&
        Buffer.byteLength(JSON.stringify(mutation.data)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
      );
    }
    if (value.content !== undefined) return false;
    if (mutation.data.kind === 'stage') {
      // Bound the original UTF-8 draft separately from the envelope's JSON escaping.
      const { payload, ...metadata } = mutation.data;
      return (
        Buffer.byteLength(payload) <= CONTROL_PRODUCT_LIMITS.payloadBytes &&
        Buffer.byteLength(JSON.stringify(metadata)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
      );
    }
    return Buffer.byteLength(JSON.stringify(mutation.data)) <= CONTROL_PRODUCT_LIMITS.payloadBytes;
  }
  if (value.operation === 'nanohost-owner')
    return (
      exactFields(value, [...scoped, 'openingRequestId', 'mutation']) &&
      Number.isSafeInteger(value.openingRequestId) &&
      (value.openingRequestId as number) >= 0 &&
      nanoHostOwnerMutationSchema.safeParse(value.mutation).success
    );
  if (value.operation === 'communication-kernel')
    return (
      exactFields(value, [...scoped, 'openingRequestId', 'communicationIdentity', 'input']) &&
      Number.isSafeInteger(value.openingRequestId) &&
      (value.openingRequestId as number) >= 0 &&
      typeof value.communicationIdentity === 'string' &&
      /^\d+:\d+$/.test(value.communicationIdentity) &&
      communicationKernelInputSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'communication-owner') {
    const parsed = ControlScalarTextSchema.safeParse(value.input);
    return (
      exactFields(value, [...scoped, 'openingRequestId', 'stage', 'input', 'content']) &&
      Number.isSafeInteger(value.openingRequestId) &&
      (value.openingRequestId as number) >= 0 &&
      typeof value.stage === 'string' &&
      value.stage.length <= 64 &&
      parsed.success &&
      parsed.data.byteLength <= CONTROL_WORKER_LIMITS.materialPendingBytes &&
      controlMaterialArrayBufferByteLength(value.content) === parsed.data.byteLength
    );
  }
  if (value.operation === 'nanohost-transport')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlNanoHostTransportInputSchema.safeParse(value.input).success
    );
  if (value.operation === 'better-auth')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlBetterAuthInputSchema.safeParse(value.input).success
    );
  if (value.operation === 'boot-audit')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlBootAuditInputSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'admin-recovery')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlAdminRecoveryInputSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'worker-control-evidence')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlWorkerRejectedEvidenceSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'schema-application') {
    const parsed = ControlSchemaApplicationWireSchema.safeParse(value.input);
    return (
      parsed.success &&
      exactFields(value, [...scoped, 'input', 'content']) &&
      parsed.data.byteLength <= CONTROL_WORKER_LIMITS.materialPendingBytes &&
      controlMaterialArrayBufferByteLength(value.content) === parsed.data.byteLength
    );
  }
  if (value.operation === 'app-kernel') {
    const parsed = ControlAppWireSchema.safeParse(value.input);
    return (
      parsed.success &&
      exactFields(value, [...scoped, 'input', 'content']) &&
      controlMaterialArrayBufferByteLength(value.content) === parsed.data.byteLength
    );
  }
  if (value.operation === 'worker-control-final-status') {
    const parsed = ControlWorkerFinalStatusInputSchema.safeParse(value.input);
    return (
      parsed.success &&
      exactFields(value, [...scoped, 'input', 'content'], ['nanoHostFinal']) &&
      (value.nanoHostFinal === undefined ||
        nanoHostFinalStage.safeParse(value.nanoHostFinal).success) &&
      parsed.data.byteLength <= CONTROL_WORKER_LIMITS.materialPendingBytes &&
      controlMaterialArrayBufferByteLength(value.content) === parsed.data.byteLength
    );
  }
  if (value.operation === 'worker-control-heartbeat') {
    const parsed = ControlWorkerHeartbeatInputSchema.safeParse(value.input);
    return (
      parsed.success &&
      exactFields(value, [...scoped, 'input', 'content'], ['nanoHostCoreIdentity']) &&
      (value.nanoHostCoreIdentity === undefined ||
        (typeof value.nanoHostCoreIdentity === 'string' &&
          /^\d+:\d+$/.test(value.nanoHostCoreIdentity))) &&
      parsed.data.byteLength <= CONTROL_WORKER_LIMITS.materialPendingBytes &&
      controlMaterialArrayBufferByteLength(value.content) === parsed.data.byteLength
    );
  }
  if (value.operation === 'worker-control-record') {
    const parsed = ControlWorkerRecordInputSchema.safeParse(value.input);
    return (
      parsed.success &&
      exactFields(value, [...scoped, 'input', 'content'], ['nanoHostCoreIdentity']) &&
      (value.nanoHostCoreIdentity === undefined ||
        (typeof value.nanoHostCoreIdentity === 'string' &&
          /^\d+:\d+$/.test(value.nanoHostCoreIdentity))) &&
      parsed.data.byteLength <= CONTROL_WORKER_LIMITS.materialPendingBytes &&
      controlMaterialArrayBufferByteLength(value.content) === parsed.data.byteLength
    );
  }
  if (value.operation === 'execution-attempt') {
    const parsed = ControlExecutionAttemptInputSchema.safeParse(value.input);
    if (
      !parsed.success ||
      !exactFields(
        value,
        [...scoped, 'input'],
        ['content', 'simulatorCoreIdentity', 'nanoHostRecoveryClose']
      )
    )
      return false;
    if (
      value.simulatorCoreIdentity !== undefined &&
      (parsed.data.kind !== 'simulator-final' ||
        !z
          .string()
          .regex(/^\d+:\d+$/)
          .safeParse(value.simulatorCoreIdentity).success)
    )
      return false;
    if (
      value.nanoHostRecoveryClose !== undefined &&
      (parsed.data.kind !== 'closing' ||
        parsed.data.requireUnsubmitted !== undefined ||
        !nanoHostRecoveryClose.safeParse(value.nanoHostRecoveryClose).success)
    )
      return false;
    return (
      Buffer.byteLength(JSON.stringify(parsed.data)) <= CONTROL_PRODUCT_LIMITS.payloadBytes &&
      (parsed.data.kind === 'create'
        ? parsed.data.byteLength <= CONTROL_WORKER_LIMITS.materialPendingBytes &&
          controlMaterialArrayBufferByteLength(value.content) === parsed.data.byteLength
        : value.content === undefined)
    );
  }
  if (value.operation === 'core-journal')
    return (
      exactFields(value, [...scoped, 'input'], ['nanoHostOwnerIdentity']) &&
      (value.nanoHostOwnerIdentity === undefined ||
        (typeof value.nanoHostOwnerIdentity === 'string' &&
          /^\d+:\d+$/.test(value.nanoHostOwnerIdentity))) &&
      (ControlCoreJournalInputSchema.safeParse(value.input).success ||
        ControlCoreImageResultSchema.safeParse(value.input).success) &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'worker-image')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlWorkerImageInputSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'local-identity')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlLocalIdentitySchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'bootstrap-consume')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlBootstrapConsumeSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'bootstrap-ensure')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlBootstrapEnsureSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'access-token-lifecycle')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlAccessTokenLifecycleSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'server-admin-token-default')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlServerAdminTokenDefaultSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'access-token-verification')
    return (
      exactFields(value, [...scoped, 'input'], ['nanoHostPeer']) &&
      (value.nanoHostPeer === undefined ||
        nanoHostCoreReadPeer.safeParse(value.nanoHostPeer).success) &&
      ControlAccessTokenVerificationSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'remote-mcp-audit')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlRemoteMcpAuditSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'runtime-target')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlRuntimeTargetInputSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'private-workspace')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlPrivateWorkspaceInputSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'workspace-queue-input') {
    const parsed = ControlWorkspaceQueueInputWireSchema.safeParse(value.input);
    return (
      parsed.success &&
      exactFields(value, [...scoped, 'input', 'content']) &&
      controlMaterialArrayBufferByteLength(value.content) === parsed.data.byteLength
    );
  }
  if (value.operation === 'standalone-audit') {
    const parsed = ControlScalarTextSchema.safeParse(value.input);
    return (
      parsed.success &&
      exactFields(value, [...scoped, 'input', 'content'], ['nanoHostOwnerIdentity']) &&
      (value.nanoHostOwnerIdentity === undefined ||
        (typeof value.nanoHostOwnerIdentity === 'string' &&
          /^\d+:\d+$/.test(value.nanoHostOwnerIdentity))) &&
      parsed.data.byteLength <= CONTROL_WORKER_LIMITS.materialPendingBytes &&
      controlMaterialArrayBufferByteLength(value.content) === parsed.data.byteLength
    );
  }
  if (value.operation === 'resolved-agent-setup')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlResolvedAgentSetupInputSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'scoped-notebook-sql')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlScopedNotebookSqlInputSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'workspace-stage-review')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlWorkspaceStageReviewSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'workspace-recovery-decision')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlWorkspaceRecoveryDecisionSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'workspace-takeover')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlWorkspaceTakeoverSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'workspace-capture')
    return (
      exactFields(value, [...scoped, 'input'], ['nanoHostFinalGuard']) &&
      (value.nanoHostFinalGuard === undefined ||
        nanoHostFinalGuard.safeParse(value.nanoHostFinalGuard).success) &&
      ControlWorkspaceCaptureSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'workspace-baseline')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlWorkspaceBaselineSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'workspace-backend-handoff')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlWorkspaceBackendHandoffSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'workspace-review-finish')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlWorkspaceReviewFinishSchema.safeParse(value.input).success
    );
  if (value.operation === 'workspace-review-decision')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlWorkspaceReviewDecisionSchema.safeParse(value.input).success
    );
  if (value.operation === 'security-trigger')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlSecurityTriggerSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'automation-scanner')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlAutomationScannerSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'workspace-apply-plan')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlWorkspaceApplyPlanSchema.safeParse(value.input).success
    );
  if (value.operation === 'backend-session') {
    const parsed = ControlBackendSessionInputSchema.safeParse(value.input);
    return (
      exactFields(value, [...scoped, 'input'], ['simulatorCoreIdentity']) &&
      parsed.success &&
      (value.simulatorCoreIdentity === undefined ||
        (z
          .string()
          .regex(/^\d+:\d+$/)
          .safeParse(value.simulatorCoreIdentity).success &&
          (parsed.data.kind === 'materializing' ||
            parsed.data.kind === 'handoff' ||
            (parsed.data.kind === 'transition' && parsed.data.toState !== 'launching')))) &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  }
  if (value.operation === 'harness-lifecycle') {
    const input = ControlHarnessLifecycleInputSchema.safeParse(value.input);
    return (
      exactFields(value, [...scoped, 'input'], ['nanoHostAckPeer']) &&
      input.success &&
      (value.nanoHostAckPeer === undefined ||
        ((input.data.kind === 'result.acknowledge' || input.data.kind === 'operation.settle') &&
          nanoHostCoreReadPeer.safeParse(value.nanoHostAckPeer).success)) &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  }
  if (value.operation === 'worker-storage-binding')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlWorkerStorageInputSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'thread-read-membership') {
    const parsed = ControlThreadReadMembershipWireSchema.safeParse(value.input);
    return (
      parsed.success &&
      exactFields(value, [...scoped, 'input', 'content']) &&
      controlMaterialArrayBufferByteLength(value.content) === parsed.data.byteLength
    );
  }
  if (value.operation === 'generative-presentation') {
    const parsed = ControlGenerativePresentationWireSchema.safeParse(value.input);
    return (
      parsed.success &&
      exactFields(value, [...scoped, 'input', 'content']) &&
      controlMaterialArrayBufferByteLength(value.content) === parsed.data.byteLength
    );
  }
  if (value.operation === 'provenance')
    return (
      exactFields(value, [...scoped, 'input']) &&
      ControlProvenanceInputSchema.safeParse(value.input).success &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (value.operation === 'observation') {
    if (!exactFields(value, [...scoped, 'input'], ['content'])) return false;
    const bytes = controlWorkObservationTransferSize(
      value.input as ControlWorkObservationCommandInput
    );
    return (
      bytes !== undefined &&
      (value.content === undefined
        ? bytes === 0
        : controlMaterialArrayBufferByteLength(value.content) === bytes) &&
      Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  }
  if (
    value.operation === 'publication' ||
    value.operation === 'pending' ||
    value.operation === 'journal' ||
    value.operation === 'project-cleanup' ||
    value.operation === 'goal' ||
    value.operation === 'review' ||
    value.operation === 'core-sharing' ||
    value.operation === 'evaluation-candidate' ||
    value.operation === 'terminal'
  ) {
    try {
      const schema =
        value.operation === 'core-sharing'
          ? ControlCoreSharingSchema
          : value.operation === 'evaluation-candidate'
            ? ControlEvaluationCandidateSchema
            : value.operation === 'publication'
              ? ControlPublicationInputSchema
              : value.operation === 'pending'
                ? typeof value.input === 'object' && value.input !== null && 'plan' in value.input
                  ? ControlPendingPlanSchema
                  : ControlPendingTransitionSchema
                : value.operation === 'journal'
                  ? ControlExecutionJournalInputSchema
                  : value.operation === 'project-cleanup'
                    ? ProjectWorkerBackendCleanupInputSchema
                    : value.operation === 'goal'
                      ? ControlGoalInputSchema
                      : value.operation === 'review'
                        ? ControlReviewCommandInputSchema
                        : value.operation === 'terminal'
                          ? ControlTerminalTransitionSchema
                          : ControlWorkObservationInputSchema;
      return (
        exactFields(value, [...scoped, 'input']) &&
        schema.safeParse(value.input).success &&
        Buffer.byteLength(
          value.operation === 'terminal' ||
            value.operation === 'publication' ||
            value.operation === 'pending' ||
            value.operation === 'goal' ||
            value.operation === 'review'
            ? controlProductMetadataJson(value.input as ControlTerminalTransition)
            : JSON.stringify(value.input)
        ) <= CONTROL_PRODUCT_LIMITS.payloadBytes
      );
    } catch {
      return false;
    }
  }
  if (value.operation === 'write')
    return (
      exactFields(value, [...scoped, 'statements']) &&
      Array.isArray(value.statements) &&
      value.statements.length > 0 &&
      value.statements.every(isSqlStatement)
    );
  return (
    (value.operation === 'checkpoint' ||
      value.operation === 'reclaim' ||
      value.operation === 'close' ||
      value.operation === 'recovery-seal') &&
    exactFields(value, scoped)
  );
}

const policyFrame = z
  .object({ version: z.literal(CONTROL_WORKER_VERSION), id: z.number().int().nonnegative().safe() })
  .strict();
const policyWorkspaceFrame = policyFrame.extend({
  database: z.string().min(1),
  openingRequestId: z.number().int().nonnegative().safe(),
});
const policyRefusal = {
  code: z.enum(CONTROL_WORKER_FAILURE_CODES),
  commit: z.literal('not-committed'),
};
const policyBorrow = z.literal('runtime-policy-borrow');
const policyReturn = z.literal('runtime-policy-return');
const policyBinding = { binding: ControlPolicyBindingSchema };
const policyReturned = { ...policyBinding, outcome: z.literal('returned') };

/** Strict original-slot continuations; binding mismatches are typed refusals, not parser failures. */
export const ControlPolicyBridgeMessageSchema = z
  .union([
    policyWorkspaceFrame.extend({
      status: z.literal('runtime-policy-borrow-needed'),
      coreIdentity: z.string().regex(/^\d+:\d+$/),
    }),
    policyFrame.extend({
      operation: policyBorrow,
      database: z.string().min(1),
      coreIdentity: z.string().regex(/^\d+:\d+$/),
      borrower: ControlPolicyBorrowerSchema,
    }),
    policyFrame.extend({
      status: z.literal('runtime-policy-borrow-granted'),
      grant: ControlPolicyGrantSchema,
    }),
    policyFrame.extend({ status: z.literal('runtime-policy-borrow-refused'), ...policyRefusal }),
    policyWorkspaceFrame.extend({
      operation: policyBorrow,
      decision: z.literal('granted'),
      grant: ControlPolicyGrantSchema,
    }),
    policyWorkspaceFrame.extend({
      operation: policyBorrow,
      decision: z.literal('refused'),
      ...policyRefusal,
    }),
    policyWorkspaceFrame.extend({
      status: z.literal('runtime-policy-return-needed'),
      ...policyBinding,
    }),
    policyFrame.extend({ operation: policyReturn, database: z.string().min(1), ...policyBinding }),
    policyFrame.extend({ status: z.literal('runtime-policy-returned'), ...policyReturned }),
    policyFrame.extend({
      status: z.literal('runtime-policy-return-refused'),
      ...policyBinding,
      ...policyRefusal,
    }),
    policyWorkspaceFrame.extend({
      operation: policyReturn,
      decision: z.literal('ack'),
      ...policyReturned,
    }),
    policyWorkspaceFrame.extend({
      operation: policyReturn,
      decision: z.literal('refused'),
      ...policyBinding,
      ...policyRefusal,
    }),
  ])
  .refine(
    (frame) => Buffer.byteLength(JSON.stringify(frame)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
  );
export type ControlPolicyBridgeMessage = z.infer<typeof ControlPolicyBridgeMessageSchema>;
