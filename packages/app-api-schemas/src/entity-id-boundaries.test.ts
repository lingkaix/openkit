import { WorkspaceImportedFromSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  ArtifactReviewHumanAttentionSourceSchema,
  ExecutionAttemptHumanAttentionSourceSchema,
  KnowledgeProposalReviewSchema,
  ReverseKnowledgeProposalRequestSchema,
  ReverseKnowledgeProposalResponseSchema,
} from './action-center.js';
import { ServerPermissionDecisionSchema, WorkspacePermissionDecisionSchema } from './audit.js';
import {
  AuthUserSchema,
  OpenKitAccessTokenRecordSchema,
  SetMyAdminAccessTokenDefaultRequestSchema,
} from './auth.js';
import { ChatModeHandoffSchema } from './chat-mode.js';
import { DashboardArtifactSummarySchema, ThreadDashboardResponseSchema } from './dashboard.js';
import {
  KnowledgeSourceDerivedRepresentationSchema,
  KnowledgeSourceSchema,
  RegisterKnowledgeSourceRequestSchema,
} from './knowledge-manager.js';
import { KNOWLEDGE_OPERATION_DEFINITIONS } from './knowledge-operation-definitions.js';
import * as material from './material.js';
import {
  NanoHostRuntimeTargetStatusResponseSchema,
  NanoHostTransportTokenRecordSchema,
} from './nanohost.js';
import { SkillCatalogCandidateSchema } from './resource-catalog.js';
import { AgentNativeEnvironmentResponseSchema } from './runtime-config.js';
import {
  DataRootBackupManifestSchema,
  WorkspaceExportManifestSchema,
  WorkspaceImportCollisionSchema,
  WorkspaceImportDryRunResponseSchema,
  WorkspaceImportResponseSchema,
} from './storage.js';
import { TaskModeContextRefSchema } from './task-mode.js';
import { WorkspaceVaultInjectionReceiptSchema } from './vault-injection.js';
import { VAULT_OPERATION_DEFINITIONS } from './vault-operations.js';
import { ServerVaultUseRecordSchema, WorkspaceVaultUseRecordSchema } from './vault-use.js';
import {
  PrepareWorkerEnvironmentRequestSchema,
  SelectWorkerEnvironmentRequestSchema,
  WorkerEnvironmentStorageChoiceSchema,
  WorkerEnvironmentStorageRefSchema,
} from './worker-environment.js';
import { WORKSPACE_LIFECYCLE_OPERATION_DEFINITIONS } from './workspace-lifecycle-operations.js';
import { TransferWorkspaceOwnershipRequestSchema } from './workspace-sharing.js';

const uuid7 = '01890f3e-0000-7000-8000-000000000001';
const uuid5 = '01890f3e-0000-5000-8000-000000000001';
const fields = [
  {
    kind: 'tu',
    schema: material.ThreadMaterialActiveDeliverySchema.shape.pendingTurnId,
    derived: true,
  },
  {
    kind: 'tu',
    schema: material.ThreadMaterialActiveDeliverySchema.shape.activeTurnId,
    derived: true,
  },
  {
    kind: 'it',
    schema: material.ThreadMaterialActiveDeliverySchema.shape.contentItemId,
    derived: true,
  },
  {
    kind: 'grant',
    schema: VAULT_OPERATION_DEFINITIONS['vault.grant-narrow'].inputSchema.shape.grantId,
    derived: false,
  },
  ...[
    material.WorkspaceMaterialViewSchema.shape.currentRevisionId,
    material.WorkspaceMaterialRevisionSummarySchema.shape.revisionId,
    material.WorkspaceMaterialRevisionSummarySchema.shape.parentRevisionId,
    material.ArtifactMaterialProposalSchema.shape.baseRevisionId,
    material.ArtifactReviewViewSchema.shape.appliedMaterialRevisionId,
    material.ThreadMaterialActiveDeliverySchema.shape.revisionId,
    material.ThreadMaterialViewSchema.shape.latestQueuedRevisionId,
    material.ThreadMaterialViewSchema.shape.lastWorkerSeenRevisionId,
    material.ThreadMaterialViewSchema.shape.currentTurnRevisionId,
    material.SaveWorkspaceMaterialRevisionRequestSchema.shape.expectedRevisionId,
    material.SaveWorkspaceMaterialRevisionResponseSchema.shape.revisionId,
    material.ExcludeThreadMaterialRequestSchema.shape.expectedQueuedRevisionId,
  ].map((schema) => ({ kind: 'mrev', schema, derived: true })),
  ...[
    material.ArtifactReviewViewSchema.shape.reviewId,
    material.SubmitArtifactReviewDecisionResponseSchema.shape.reviewId,
  ].map((schema) => ({ kind: 'arev', schema, derived: true })),

  {
    kind: 'attempt',
    schema: ExecutionAttemptHumanAttentionSourceSchema.shape.attemptId,
    derived: false,
  },
  {
    kind: 'nhtok',
    schema: NanoHostTransportTokenRecordSchema.shape.predecessorTokenId,
    derived: false,
  },
  {
    kind: 'kf',
    schema:
      KNOWLEDGE_OPERATION_DEFINITIONS['knowledge.conflict.resolve'].inputSchema.shape.conflictId,
    derived: false,
  },
  { kind: 'ar', schema: DashboardArtifactSummarySchema.shape.id, derived: true },
  { kind: 'cand', schema: SkillCatalogCandidateSchema.shape.id, derived: false },
  { kind: 'ks', schema: KnowledgeSourceDerivedRepresentationSchema.shape.sourceId, derived: false },
  { kind: 'arev', schema: ArtifactReviewHumanAttentionSourceSchema.shape.reviewId, derived: true },
  { kind: 'kr', schema: KnowledgeProposalReviewSchema.shape.reviewId, derived: true },
  { kind: 'kr', schema: ReverseKnowledgeProposalRequestSchema.shape.reviewId, derived: true },
  { kind: 'kr', schema: ReverseKnowledgeProposalResponseSchema.shape.reviewId, derived: true },
  {
    kind: 'ks',
    schema: KNOWLEDGE_OPERATION_DEFINITIONS['knowledge.source.read'].inputSchema.shape.sourceId,
    derived: false,
  },

  { kind: 'usr', schema: ThreadDashboardResponseSchema.shape.viewerUserId, derived: false },
  { kind: 'it', schema: ChatModeHandoffSchema.shape.statusItemId, derived: true },
  { kind: 'tu', schema: KnowledgeSourceSchema.shape.originatingTurnId, derived: true },
  {
    kind: 'tu',
    schema: RegisterKnowledgeSourceRequestSchema.shape.originatingTurnId,
    derived: true,
  },
  {
    kind: 'th',
    schema:
      WorkerEnvironmentStorageChoiceSchema.options[1].shape.adjudicatedThreadIds.unwrap().element,
    derived: true,
  },
  {
    kind: 'th',
    schema: SelectWorkerEnvironmentRequestSchema.shape.adjudicatedThreadIds.unwrap().element,
    derived: true,
  },
  {
    kind: 'th',
    schema: PrepareWorkerEnvironmentRequestSchema.options[0].shape.administrationThreadId,
    derived: true,
  },
  {
    kind: 'th',
    schema: PrepareWorkerEnvironmentRequestSchema.options[1].shape.administrationThreadId,
    derived: true,
  },
  {
    kind: 'usr',
    schema: TransferWorkspaceOwnershipRequestSchema.shape.targetUserId,
    derived: false,
  },
  {
    kind: 'ws',
    schema: WorkspaceImportCollisionSchema.options[1].shape.suggestedWorkspaceId,
    derived: true,
  },
  {
    kind: 'ws',
    schema: WorkspaceImportDryRunResponseSchema.shape.exportedWorkspaceId,
    derived: true,
  },
  { kind: 'ws', schema: WorkspaceImportResponseSchema.shape.exportedWorkspaceId, derived: true },
  { kind: 'ws', schema: WorkspaceImportResponseSchema.shape.importedWorkspaceId, derived: true },
  {
    kind: 'usr',
    schema:
      WORKSPACE_LIFECYCLE_OPERATION_DEFINITIONS['workspace.member-access-change'].inputSchema.shape
        .targetUserId,
    derived: false,
  },
  {
    kind: 'usr',
    schema:
      WORKSPACE_LIFECYCLE_OPERATION_DEFINITIONS['workspace.member-remove'].inputSchema.shape
        .targetUserId,
    derived: false,
  },
  {
    kind: 'usr',
    schema:
      WORKSPACE_LIFECYCLE_OPERATION_DEFINITIONS['user.disable'].inputSchema.shape.targetUserId,
    derived: false,
  },
  { kind: 'usr', schema: AuthUserSchema.shape.id, derived: false },
  { kind: 'tok', schema: OpenKitAccessTokenRecordSchema.shape.tokenId, derived: true },
  { kind: 'tok', schema: SetMyAdminAccessTokenDefaultRequestSchema.shape.tokenId, derived: true },
  { kind: 'nhtok', schema: NanoHostTransportTokenRecordSchema.shape.tokenId, derived: false },
  {
    kind: 'dep',
    schema: NanoHostRuntimeTargetStatusResponseSchema.shape.deploymentId,
    derived: false,
  },
  { kind: 'pd', schema: ServerPermissionDecisionSchema.shape.decisionId, derived: true },
  { kind: 'pd', schema: WorkspacePermissionDecisionSchema.shape.decisionId, derived: true },
  { kind: 'wst', schema: WorkerEnvironmentStorageRefSchema, derived: false },
  { kind: 'dep', schema: WorkspaceImportedFromSchema.shape.sourceDeploymentId, derived: false },
  { kind: 'dep', schema: WorkspaceExportManifestSchema.shape.sourceDeploymentId, derived: false },
  { kind: 'dep', schema: DataRootBackupManifestSchema.shape.sourceDeploymentId, derived: false },
  { kind: 'wsexp', schema: WorkspaceExportManifestSchema.shape.id, derived: true },
  { kind: 'drb', schema: DataRootBackupManifestSchema.shape.id, derived: false },
  { kind: 'aud', schema: WorkspaceVaultUseRecordSchema.shape.auditEventId, derived: true },
  { kind: 'aud', schema: ServerVaultUseRecordSchema.shape.auditEventId, derived: true },
  { kind: 'aud', schema: WorkspaceVaultInjectionReceiptSchema.shape.auditEventId, derived: true },
  {
    kind: 'ws',
    schema: AgentNativeEnvironmentResponseSchema.shape.applied.element.shape.workspaceId,
    derived: true,
  },
  {
    kind: 'th',
    schema: AgentNativeEnvironmentResponseSchema.shape.applied.element.shape.threadId,
    derived: true,
  },
];

describe('named App entity boundaries', () => {
  it.each(fields)('uses the shared canonical $kind admission rule', ({ kind, schema, derived }) => {
    expect(schema.safeParse(`${kind}_${uuid7}`).success).toBe(true);
    expect(schema.safeParse(`${kind}_${uuid5}`).success).toBe(derived);
    for (const invalid of [
      `${kind}_legacy`,
      `${kind}_${uuid7.replace('-7000-', '-4000-')}`,
      `${kind}_${uuid7.replace('-8000-', '-c000-')}`,
      `${kind}_${uuid7.toUpperCase()}`,
      `wrong_${uuid7}`,
      `${kind}_${uuid7}\n`,
    ]) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
  });
});

it('keeps participant identity typed only for User and Automation kinds', () => {
  const schema = ThreadDashboardResponseSchema.shape.participants.element;
  for (const [kind, prefix] of [
    ['user', 'usr'],
    ['automation', 'auto'],
  ] as const) {
    expect(
      schema.safeParse({ kind, id: `${prefix}_${uuid7}`, displayName: 'Fixture' }).success
    ).toBe(true);
    for (const id of [`other_${uuid7}`, `${prefix}_old`, `${prefix}_${uuid5}`])
      expect(schema.safeParse({ kind, id, displayName: 'Fixture' }).success).toBe(false);
  }
  for (const kind of ['agent', 'integration', 'system'])
    expect(
      schema.safeParse({ kind, id: 'authored-selector', displayName: 'Fixture' }).success
    ).toBe(true);
});

it.each([
  ['workspace', 'ws'],
  ['thread', 'th'],
  ['artifact', 'ar'],
  ['item', 'it'],
] as const)('types the %s Task context reference', (kind, prefix) => {
  for (const uuid of [uuid7, uuid5])
    expect(TaskModeContextRefSchema.safeParse({ kind, id: `${prefix}_${uuid}` }).success).toBe(
      true
    );
  for (const id of [`wrong_${uuid7}`, `${prefix}_old`])
    expect(TaskModeContextRefSchema.safeParse({ kind, id }).success).toBe(false);
});
it('preserves native Knowledge context identity', () => {
  expect(TaskModeContextRefSchema.safeParse({ kind: 'knowledge', id: 'ws_legacy' }).success).toBe(
    true
  );
});
