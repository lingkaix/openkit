import {
  ArtifactIdSchema,
  CreateKnowledgeEntryRequestSchema,
  CreateThreadRequestSchema,
  DeleteKnowledgeEntryRequestSchema,
  GetArtifactResponseSchema,
  KnowledgeEntrySchema,
  ListArtifactsResponseSchema,
  ListKnowledgeEntriesResponseSchema,
  RequestIdSchema,
  ThreadIdSchema,
  ThreadSchema,
  TurnIdSchema,
  TurnReadProjectionSchema,
  UpdateKnowledgeEntryRequestSchema,
  WorkspaceIdSchema,
  WorkspaceResourcesResponseSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import {
  ReverseKnowledgeProposalRequestSchema,
  ReverseKnowledgeProposalResponseSchema,
  SubmitKnowledgeProposalDecisionRequestSchema,
  SubmitKnowledgeProposalDecisionResponseSchema,
} from './action-center.js';
import { ListThreadItemsResponseSchema, ThreadDashboardResponseSchema } from './dashboard.js';
import { GOAL_OPERATION_DEFINITIONS } from './goal.js';
import {
  KnowledgeDerivedIndexesResponseSchema,
  KnowledgeManagerAnswerRequestSchema,
  KnowledgeManagerAnswerResponseSchema,
  KnowledgeManagerDraftProposalRequestSchema,
  KnowledgeManagerDraftProposalResponseSchema,
  KnowledgeManagerHealthCheckRequestSchema,
  KnowledgeManagerHealthCheckResponseSchema,
  KnowledgeManagerPrepareContextRequestSchema,
  KnowledgeManagerPrepareContextResponseSchema,
  KnowledgeManagerSuggestRepairRequestSchema,
  KnowledgeManagerSuggestRepairResponseSchema,
  KnowledgeRetrievalResponseSchema,
  ListKnowledgeClaimsResponseSchema,
  ListKnowledgeConflictsResponseSchema,
  ListKnowledgeObservationsResponseSchema,
  ListKnowledgeSourcesResponseSchema,
  ReadKnowledgeSourceResponseSchema,
  RecordKnowledgeClaimRequestSchema,
  RecordKnowledgeClaimResponseSchema,
  RecordKnowledgeConflictRequestSchema,
  RecordKnowledgeConflictResponseSchema,
  RecordKnowledgeObservationRequestSchema,
  RecordKnowledgeObservationResponseSchema,
  RegisterKnowledgeSourceRequestSchema,
  RegisterKnowledgeSourceResponseSchema,
  ResolveKnowledgeConflictRequestSchema,
  ResolveKnowledgeConflictResponseSchema,
  RetrieveKnowledgeRequestSchema,
} from './knowledge-manager.js';
import {
  CreateLightAppRecordRequestSchema,
  GetLightAppResponseSchema,
  LightAppRecordSchema,
} from './light-apps.js';
import {
  ImportWorkspaceArtifactRequestSchema,
  ImportWorkspaceArtifactResponseSchema,
  IntroduceWorkspaceArtifactRequestSchema,
  IntroduceWorkspaceArtifactResponseSchema,
  ListArtifactReviewsResponseSchema,
  SubmitArtifactReviewDecisionRequestSchema,
  SubmitArtifactReviewDecisionResponseSchema,
} from './material.js';
import { NanoHostRuntimeTargetStatusResponseSchema } from './nanohost.js';
import { ListAuthorizedWorkspacesResponseSchema } from './workspace-sharing.js';

/** Current trusted authentication procedures eligible for Kernel operations. */
type KernelCredential =
  | 'local-user'
  | 'user-session'
  | 'user-bearer'
  | 'deployment-administrator'
  | 'worker-package';

/** Closed descriptors used by this slice; implementations remain on the server. */
export interface KernelOperationDefinition {
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  readonly outputSchema: z.ZodType;
  readonly credentials: readonly KernelCredential[];
  readonly scope: { readonly kind: 'body-workspace'; readonly field: 'workspaceId' };
  readonly target: { readonly kind: 'workspace-light-app'; readonly field: 'appId' };
  readonly policyOperation: 'workspace.read' | 'workspace.write';
  readonly mutating: boolean;
}

const credentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
  'worker-package',
] as const;
const selectors = { workspaceId: WorkspaceIdSchema, appId: z.string().uuid() };

/** Sole declarative contract for the first Generative Kernel operation slice. */
export const KERNEL_OPERATION_DEFINITIONS = {
  'kernel.apps.get': {
    description: 'Read one Light App schema and capabilities.',
    inputSchema: z.object(selectors).strict(),
    outputSchema: GetLightAppResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace-light-app', field: 'appId' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'kernel.records.create': {
    description: 'Create one Light App record.',
    inputSchema: CreateLightAppRecordRequestSchema.extend({
      ...selectors,
      collection: z.string().min(1),
      requestId: RequestIdSchema,
    }),
    outputSchema: LightAppRecordSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace-light-app', field: 'appId' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
} as const satisfies Record<string, KernelOperationDefinition>;

/** Canonical ids inferred from the single definition table. */
export type KernelOperationId = keyof typeof KERNEL_OPERATION_DEFINITIONS;
/** Complete logical input for a selected operation. */
export type KernelOperationInput<K extends KernelOperationId> = z.infer<
  (typeof KERNEL_OPERATION_DEFINITIONS)[K]['inputSchema']
>;
/** Validated result of a selected operation. */
export type KernelOperationOutput<K extends KernelOperationId> = z.infer<
  (typeof KERNEL_OPERATION_DEFINITIONS)[K]['outputSchema']
>;

/** One existing administration read used to prove the real internal assembly seam. */
export const ADMINISTRATION_OPERATION_DEFINITIONS = {
  'nanohost.runtime-target': {
    description:
      "Read the configured NanoHost execution-host RuntimeTarget readiness. NanoHost is not an LLM Provider. Input must be an empty object; this Tool cannot select a host, deployment, or scope. The result is Core's stored projection at observedAt, not a live host probe.",
    inputSchema: z.object({}).strict(),
    outputSchema: NanoHostRuntimeTargetStatusResponseSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'server' },
    target: { kind: 'configured-runtime-target' },
    policyOperation: 'api.call',
    mutating: false,
  },
} as const;

/** Credentials already used by the public Workspace, Thread and Turn families. */
const publicCredentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;
const workspaceSelector = { workspaceId: WorkspaceIdSchema };
const threadSelector = { ...workspaceSelector, threadId: ThreadIdSchema };

/** Candidate-first Workspace discovery and its existing resource bundle. */
export const WORKSPACE_OPERATION_DEFINITIONS = {
  'workspace.list': {
    description: 'List authorized Workspaces with effective access and revisions.',
    inputSchema: z.object({}).strict(),
    outputSchema: ListAuthorizedWorkspacesResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'authorized-workspace-set' },
    target: { kind: 'authorized-workspaces' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'workspace.resources': {
    description: 'Read one Workspace resource bundle.',
    inputSchema: z.object(workspaceSelector).strict(),
    outputSchema: WorkspaceResourcesResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
} as const;

/** Creation and audience-scoped Thread reads retain the protocol and dashboard owners. */
export const THREAD_OPERATION_DEFINITIONS = {
  'thread.create': {
    description:
      'Create one Thread; private by default, explicitly workspace-shared for formal work.',
    inputSchema: CreateThreadRequestSchema.strict(),
    outputSchema: ThreadSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
  'thread.read': {
    description: 'Read one visible Thread.',
    inputSchema: z.object(threadSelector).strict(),
    outputSchema: ThreadSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' },
    policyOperation: 'thread.read',
    mutating: false,
  },
  'thread.items': {
    description: 'List durable Items for one visible Thread.',
    inputSchema: z
      .object({
        ...threadSelector,
        since: z.number().nonnegative().optional(),
        limit: z.number().int().positive().optional(),
      })
      .strict(),
    outputSchema: ListThreadItemsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' },
    policyOperation: 'thread.read',
    mutating: false,
  },
  'thread.dashboard': {
    description: 'Read one visible Thread dashboard.',
    inputSchema: z.object(threadSelector).strict(),
    outputSchema: ThreadDashboardResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' },
    policyOperation: 'thread.read',
    mutating: false,
  },
} as const;

/** Turn detail keeps the ordinary product projection and verified Context Package evidence. */
export const TURN_OPERATION_DEFINITIONS = {
  'turn.read': {
    description: 'Read one Turn in its visible Thread.',
    inputSchema: z.object({ ...threadSelector, turnId: TurnIdSchema }).strict(),
    outputSchema: TurnReadProjectionSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: {
      kind: 'addressed-turn',
      threadField: 'threadId',
      turnField: 'turnId',
      missing: 'not-found',
    },
    policyOperation: 'thread.read',
    mutating: false,
  },
} as const;

/** Sole public contracts for the governed Knowledge family, including its request-scoped Manager views. */
export const KNOWLEDGE_OPERATION_DEFINITIONS = {
  'knowledge.answer': {
    description: 'Answer one bounded question from governed Workspace Knowledge.',
    inputSchema: KnowledgeManagerAnswerRequestSchema.extend({ ...workspaceSelector }).strict(),
    outputSchema: KnowledgeManagerAnswerResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.read',
    mutating: false,
  },
  'knowledge.source.list': {
    description: 'List registered Workspace Knowledge Sources.',
    inputSchema: z.object({ ...workspaceSelector }).strict(),
    outputSchema: ListKnowledgeSourcesResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.read',
    mutating: false,
  },
  'knowledge.source.register': {
    description: 'Register one explicit Knowledge Source and captured text material.',
    inputSchema: RegisterKnowledgeSourceRequestSchema.extend({ ...workspaceSelector }).strict(),
    outputSchema: RegisterKnowledgeSourceResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.write',
    mutating: true,
  },
  'knowledge.source.read': {
    description: 'Read one scoped Knowledge Source and its derived metadata.',
    inputSchema: z.object({ ...workspaceSelector, sourceId: z.string().min(1) }).strict(),
    outputSchema: ReadKnowledgeSourceResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.read',
    mutating: false,
  },
  'knowledge.observation.list': {
    description: 'List retained Knowledge maintenance observations.',
    inputSchema: z.object({ ...workspaceSelector }).strict(),
    outputSchema: ListKnowledgeObservationsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.read',
    mutating: false,
  },
  'knowledge.observation.record': {
    description: 'Record one Knowledge maintenance observation.',
    inputSchema: RecordKnowledgeObservationRequestSchema.extend({ ...workspaceSelector }).strict(),
    outputSchema: RecordKnowledgeObservationResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.write',
    mutating: true,
  },
  'knowledge.claim.list': {
    description: 'List Knowledge maintenance claims.',
    inputSchema: z.object({ ...workspaceSelector }).strict(),
    outputSchema: ListKnowledgeClaimsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.read',
    mutating: false,
  },
  'knowledge.claim.record': {
    description: 'Record one Knowledge maintenance claim.',
    inputSchema: RecordKnowledgeClaimRequestSchema.extend({ ...workspaceSelector }).strict(),
    outputSchema: RecordKnowledgeClaimResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.write',
    mutating: true,
  },
  'knowledge.conflict.list': {
    description: 'List the latest Knowledge conflict maintenance records.',
    inputSchema: z.object({ ...workspaceSelector }).strict(),
    outputSchema: ListKnowledgeConflictsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.read',
    mutating: false,
  },
  'knowledge.conflict.record': {
    description: 'Record one Knowledge conflict without publishing content.',
    inputSchema: RecordKnowledgeConflictRequestSchema.extend({ ...workspaceSelector }).strict(),
    outputSchema: RecordKnowledgeConflictResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.write',
    mutating: true,
  },
  'knowledge.conflict.resolve': {
    description: 'Resolve one scoped Knowledge conflict.',
    inputSchema: ResolveKnowledgeConflictRequestSchema.extend({
      ...workspaceSelector,
      conflictId: z.string().min(1),
    }).strict(),
    outputSchema: ResolveKnowledgeConflictResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.write',
    mutating: true,
  },
  'knowledge.indexes': {
    description: 'Read rebuildable Knowledge indexes from their file-backed owner.',
    inputSchema: z.object({ ...workspaceSelector }).strict(),
    outputSchema: KnowledgeDerivedIndexesResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.read',
    mutating: false,
  },
  'knowledge.retrieval': {
    description: 'Retrieve governed Knowledge candidates and record their selection trace.',
    inputSchema: RetrieveKnowledgeRequestSchema.extend({ ...workspaceSelector }).strict(),
    outputSchema: KnowledgeRetrievalResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.read',
    mutating: true,
  },
  'knowledge.context.prepare': {
    description: 'Prepare bounded Knowledge selection material and its existing retrieval trace.',
    inputSchema: KnowledgeManagerPrepareContextRequestSchema.extend({
      ...workspaceSelector,
    }).strict(),
    outputSchema: KnowledgeManagerPrepareContextResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.read',
    mutating: true,
  },
  'knowledge.proposal.draft': {
    description: 'Draft one pending source-verified Knowledge Proposal.',
    inputSchema: KnowledgeManagerDraftProposalRequestSchema.extend({
      ...workspaceSelector,
    }).strict(),
    outputSchema: KnowledgeManagerDraftProposalResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.propose',
    mutating: true,
  },
  'knowledge.repair.suggest': {
    description: 'Suggest bounded review-required repairs without applying them.',
    inputSchema: KnowledgeManagerSuggestRepairRequestSchema.extend({
      ...workspaceSelector,
    }).strict(),
    outputSchema: KnowledgeManagerSuggestRepairResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.read',
    mutating: false,
  },
  'knowledge.health.check': {
    description: 'Inspect Knowledge health without applying or scheduling work.',
    inputSchema: KnowledgeManagerHealthCheckRequestSchema.extend({ ...workspaceSelector }).strict(),
    outputSchema: KnowledgeManagerHealthCheckResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.read',
    mutating: false,
  },
  'knowledge.proposal.decide': {
    description: 'Decide one fixed Knowledge Proposal through its review and publication owner.',
    inputSchema: SubmitKnowledgeProposalDecisionRequestSchema.extend({
      ...workspaceSelector,
      proposalId: z.string().min(1),
    }).strict(),
    outputSchema: SubmitKnowledgeProposalDecisionResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'review.apply',
    mutating: true,
  },
  'knowledge.proposal.reverse': {
    description: 'Reverse the unchanged page application of one accepted Knowledge Proposal.',
    inputSchema: ReverseKnowledgeProposalRequestSchema.extend({
      ...workspaceSelector,
      proposalId: z.string().min(1),
    }).strict(),
    outputSchema: ReverseKnowledgeProposalResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.write',
    mutating: true,
  },
} as const;

/** Sole public contracts for the retained minimal Knowledge Entry family; records stay with the protocol owner. */
export const KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS = {
  'knowledge.list': {
    description: 'List retained Workspace Knowledge Entries.',
    inputSchema: z.object({ ...workspaceSelector }).strict(),
    outputSchema: ListKnowledgeEntriesResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.read',
    mutating: false,
  },
  'knowledge.create': {
    description: 'Create one validated Workspace Knowledge Entry.',
    inputSchema: CreateKnowledgeEntryRequestSchema.extend({ ...workspaceSelector }).strict(),
    outputSchema: KnowledgeEntrySchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.write',
    mutating: true,
  },
  'knowledge.update': {
    description: 'Update one scoped Workspace Knowledge Entry.',
    inputSchema: UpdateKnowledgeEntryRequestSchema.extend({
      ...workspaceSelector,
      knowledgeEntryId: z.string().min(1),
    }).strict(),
    outputSchema: KnowledgeEntrySchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.write',
    mutating: true,
  },
  'knowledge.delete': {
    description: 'Delete one scoped Workspace Knowledge Entry.',
    inputSchema: DeleteKnowledgeEntryRequestSchema.extend({
      ...workspaceSelector,
      knowledgeEntryId: z.string().min(1),
    }).strict(),
    outputSchema: z.null(),
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.write',
    mutating: true,
  },
} as const;

/** Sole public contracts for Artifact inventory, immutable content, import, introduction and version-owned Review decisions. */
export const ARTIFACT_OPERATION_DEFINITIONS = {
  'artifact.list': {
    description: 'List visible submitted outputs and directly imported files.',
    inputSchema: z.object(workspaceSelector).strict(),
    outputSchema: ListArtifactsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'artifact.read',
    mutating: false,
  },
  'artifact.read': {
    description: 'Read one Artifact with its exact inline content and immutable origin.',
    inputSchema: z.object({ ...workspaceSelector, artifactId: ArtifactIdSchema }).strict(),
    outputSchema: GetArtifactResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'artifact.read',
    mutating: false,
  },
  'artifact.import': {
    description: 'Import one immutable Workspace Artifact version.',
    inputSchema: ImportWorkspaceArtifactRequestSchema.safeExtend({ ...workspaceSelector }),
    outputSchema: ImportWorkspaceArtifactResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'artifact.write',
    mutating: true,
    successStatus: 201,
  },
  'artifact.introduce': {
    description: 'Introduce one exact imported Artifact version into an idle Thread.',
    inputSchema: IntroduceWorkspaceArtifactRequestSchema.extend({
      ...threadSelector,
      artifactId: ArtifactIdSchema,
    }),
    outputSchema: IntroduceWorkspaceArtifactResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' },
    policyOperation: 'artifact.write',
    mutating: true,
    successStatus: 201,
  },
  'artifact.review-list': {
    description: 'List version-keyed Reviews for one visible Artifact.',
    inputSchema: z.object({ ...workspaceSelector, artifactId: ArtifactIdSchema }).strict(),
    outputSchema: ListArtifactReviewsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'artifact.read',
    mutating: false,
  },
  'artifact.review.decide': {
    description: 'Decide one exact version-owned Artifact Review.',
    inputSchema: SubmitArtifactReviewDecisionRequestSchema.safeExtend({
      ...workspaceSelector,
      artifactId: ArtifactIdSchema,
      artifactVersion: z.number().int().positive(),
    }),
    outputSchema: SubmitArtifactReviewDecisionResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'review.apply',
    mutating: true,
  },
} as const;

/** JSON product operations; administration's private Tool retains its separate public transport. */
export const PRODUCT_OPERATION_DEFINITIONS = {
  ...KERNEL_OPERATION_DEFINITIONS,
  ...WORKSPACE_OPERATION_DEFINITIONS,
  ...THREAD_OPERATION_DEFINITIONS,
  ...TURN_OPERATION_DEFINITIONS,
  ...KNOWLEDGE_OPERATION_DEFINITIONS,
  ...KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS,
  ...ARTIFACT_OPERATION_DEFINITIONS,
  ...GOAL_OPERATION_DEFINITIONS,
} as const;

/** Static composition of the implemented families; this is not a registration surface. */
export const OPERATION_DEFINITIONS = {
  ...PRODUCT_OPERATION_DEFINITIONS,
  ...ADMINISTRATION_OPERATION_DEFINITIONS,
} as const;
/** JSON product ids inferred from the static public composition. */
export type ProductOperationId = keyof typeof PRODUCT_OPERATION_DEFINITIONS;
/** Exact implemented ids inferred from the definitions. */
export type OperationId = keyof typeof OPERATION_DEFINITIONS;
/** Complete logical input of an implemented operation. */
export type OperationInput<K extends OperationId> = z.infer<
  (typeof OPERATION_DEFINITIONS)[K]['inputSchema']
>;
/** Validated output of an implemented operation. */
export type OperationOutput<K extends OperationId> = z.infer<
  (typeof OPERATION_DEFINITIONS)[K]['outputSchema']
>;

/** Derives the canonical one-route JSON binding without a second path catalog. */
export function operationHttpPath<K extends string>(id: K): `/api/app/operations/${K}` {
  return `/api/app/operations/${id}`;
}
/** Derives the provider/MCP spelling; assemblers check collisions across supplied Tools. */
export function operationToolName(id: string): string {
  return id.replaceAll('.', '_').replaceAll('-', '_');
}
/** Mechanically omits context-bound fields while preserving the remaining schema objects. */
export function operationModelInput(
  schema: z.ZodObject,
  boundFields: readonly string[]
): z.ZodObject {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).filter(([key]) => !boundFields.includes(key))
  );
  // Zod omit rejects refined objects; cloning the shape retains each field and the owner's cross-field checks.
  return schema.clone({ ...schema.def, shape });
}
