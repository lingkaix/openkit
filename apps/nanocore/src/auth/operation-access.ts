import type { ProductOperation } from '../policy/workspace-access.js';

/** Public authorization scope declared by one canonical operation. */
export type PublicOperationScope = 'server' | 'user' | 'workspace';

/** Closed direct Workspace-resolution shapes used by Workspace-scoped operations. */
export type PublicOperationResolver =
  | 'actor-quick-chat-workspace'
  | 'authorized-workspace-set'
  | 'body-workspace'
  | 'opaque-child-workspace'
  | 'path-workspace'
  | 'workspace-child-lineage';

/** Authentication owners for non-Workspace public operations. */
export type PublicOperationAuthentication =
  | 'bootstrap-secret'
  | 'canonical-user'
  | 'deployment-admin'
  | 'gateway-actor';

/** Fields shared by every public-operation access declaration. */
interface PublicOperationAccessBase {
  /** Whether the operation may mutate product state or cause an external effect. */
  readonly mutating: boolean;
  /** Product operation evaluated by the policy owner. */
  readonly policyOperation: ProductOperation;
  /** Top-level authorization scope. */
  readonly scope: PublicOperationScope;
}

/** Access declaration for one deployment-scoped operation. */
export interface ServerOperationAccess extends PublicOperationAccessBase {
  /** Route-owned deployment or bootstrap authentication contract. */
  readonly authentication: 'bootstrap-secret' | 'deployment-admin';
  /** Server operations never use a Workspace resolver. */
  readonly resolver?: never;
  /** Deployment-scoped operation discriminator. */
  readonly scope: 'server';
  /** Server operations never use conditional Workspace attribution. */
  readonly workspaceResolver?: never;
}

/** Access declaration for one canonical-user operation. */
export interface UserOperationAccess extends PublicOperationAccessBase {
  /** Canonical-user authentication contract. */
  readonly authentication: 'canonical-user';
  /** Ordinary user operations never use a direct Workspace resolver. */
  readonly resolver?: never;
  /** User-scoped operation discriminator. */
  readonly scope: 'user';
  /** Ordinary user operations never use conditional Workspace attribution. */
  readonly workspaceResolver?: never;
}

/** Access declaration for a Gateway operation with optional Workspace attribution. */
export interface GatewayOperationAccess extends PublicOperationAccessBase {
  /** Gateway-specific actor contract for attributed and unattributed requests. */
  readonly authentication: 'gateway-actor';
  /** Gateway operations never use a direct Workspace resolver. */
  readonly resolver?: never;
  /** User-scoped operation discriminator. */
  readonly scope: 'user';
  /** Optional Workspace attribution resolved only from Gateway metadata. */
  readonly workspaceResolver: 'gateway-metadata-workspace';
}

/** Access declaration for one Workspace-scoped operation. */
export interface WorkspaceOperationAccess extends PublicOperationAccessBase {
  /** Workspace operations rely on the authenticated request actor. */
  readonly authentication?: never;
  /** Authoritative Workspace-resolution strategy. */
  readonly resolver: PublicOperationResolver;
  /** Workspace-scoped operation discriminator. */
  readonly scope: 'workspace';
  /** Workspace operations never use conditional Workspace attribution. */
  readonly workspaceResolver?: never;
}

/** Canonical access metadata for one public operation. */
export type PublicOperationAccess =
  | ServerOperationAccess
  | UserOperationAccess
  | GatewayOperationAccess
  | WorkspaceOperationAccess;

/**
 * Adds operation keys that share one explicit authorization declaration.
 *
 * @param catalog Mutable catalog under construction.
 * @param operationKeys Canonical App operation identifiers or direct route keys.
 * @param access Explicit access declaration shared by the named operations.
 * @throws When an operation key is registered more than once.
 */
function registerOperations(
  catalog: Record<string, PublicOperationAccess>,
  operationKeys: readonly string[],
  access: PublicOperationAccess
): void {
  const frozenAccess = Object.freeze(access);
  for (const operationKey of operationKeys) {
    if (Object.hasOwn(catalog, operationKey)) {
      throw new Error(`Duplicate public operation access metadata for ${operationKey}.`);
    }
    catalog[operationKey] = frozenAccess;
  }
}

const catalog: Record<string, PublicOperationAccess> = {};

registerOperations(
  catalog,
  [
    'getStorageLayoutReport',
    'getAppDiagnostics',
    'getSetupDiagnostics',
    'listOpenKitAccessTokens',
    'listRuntimeConfigFiles',
    'getRuntimeConfigFile',
    'getRuntimeConfigSchemas',
    'validateRuntimeConfig',
    'listSubscriptionProviders',
    'listProviderSubscriptionAccounts',
    'getProviderSubscriptionAccountStatus',
    'getProviderSubscriptionAccountQuota',
    'listServerAuditEvents',
    'listServerPermissionDecisions',
    'verifyDataRootBackup',
    'getVaultAdminStatus',
    'listServerVaultUseRecords',
    'getNanoHostRuntimeTargetStatus',
    'listNanoHostTransportTokens',
  ],
  {
    authentication: 'deployment-admin',
    mutating: false,
    policyOperation: 'api.call',
    scope: 'server',
  }
);
registerOperations(
  catalog,
  [
    'createOpenKitAccessToken',
    'revokeOpenKitAccessToken',
    'rotateOpenKitAccessToken',
    'reloadRuntimeConfig',
    'createRuntimeConfigFile',
    'updateRuntimeConfigFile',
    'createProviderSubscriptionAccount',
    'updateProviderSubscriptionAccount',
    'deleteProviderSubscriptionAccount',
    'startProviderSubscriptionAccountLogin',
    'cancelProviderSubscriptionAccountLogin',
    'logoutProviderSubscriptionAccount',
    'createDataRootBackup',
    'unlockVaultAdminBackend',
    'lockVaultAdminBackend',
    'bootstrapCodexAuthJsonVaultReference',
    'setProviderApiKey',
    'enrollNanoHost',
    'issueNanoHostTransportToken',
    'revokeNanoHostTransportToken',
    'rotateNanoHostTransportToken',
    'abortNanoHostTransportTokenRotation',
    'decommissionNanoHost',
  ],
  {
    authentication: 'deployment-admin',
    mutating: true,
    policyOperation: 'api.call',
    scope: 'server',
  }
);
registerOperations(catalog, ['consumeOpenKitBootstrapToken'], {
  authentication: 'bootstrap-secret',
  mutating: true,
  policyOperation: 'api.call',
  scope: 'server',
});
registerOperations(catalog, ['getWorkspaceAccessRecoveryState'], {
  authentication: 'deployment-admin',
  mutating: false,
  policyOperation: 'deployment.recover',
  scope: 'server',
});
registerOperations(catalog, ['recoverWorkspaceAccess'], {
  authentication: 'deployment-admin',
  mutating: true,
  policyOperation: 'deployment.recover',
  scope: 'server',
});
registerOperations(catalog, ['disableUser'], {
  authentication: 'deployment-admin',
  mutating: true,
  policyOperation: 'api.call',
  scope: 'server',
});

registerOperations(catalog, ['dryRunWorkspaceImport', 'dryRunWorkspaceArchiveImport'], {
  authentication: 'canonical-user',
  mutating: false,
  policyOperation: 'workspace.write',
  scope: 'user',
});
registerOperations(catalog, ['listMyWorkspaceInvitations'], {
  authentication: 'canonical-user',
  mutating: false,
  policyOperation: 'invitation.respond',
  scope: 'user',
});
registerOperations(catalog, ['listMyAdminAccessTokens'], {
  authentication: 'canonical-user',
  mutating: false,
  policyOperation: 'api.call',
  scope: 'user',
});
registerOperations(catalog, ['setMyAdminAccessTokenDefault'], {
  authentication: 'canonical-user',
  mutating: true,
  policyOperation: 'api.call',
  scope: 'user',
});
registerOperations(catalog, ['acceptWorkspaceInvitation', 'declineWorkspaceInvitation'], {
  authentication: 'canonical-user',
  mutating: true,
  policyOperation: 'invitation.respond',
  scope: 'user',
});
registerOperations(catalog, ['leaveWorkspace'], {
  authentication: 'canonical-user',
  mutating: true,
  policyOperation: 'workspace.leave',
  scope: 'user',
});
registerOperations(catalog, ['recoverDeletedWorkspace'], {
  authentication: 'canonical-user',
  mutating: true,
  policyOperation: 'workspace.write',
  scope: 'user',
});
registerOperations(catalog, ['importWorkspace', 'importWorkspaceArchive', 'POST /api/workspaces'], {
  authentication: 'canonical-user',
  mutating: true,
  policyOperation: 'workspace.write',
  scope: 'user',
});
registerOperations(catalog, ['POST /v1/chat/completions', 'POST /v1/responses'], {
  authentication: 'gateway-actor',
  mutating: true,
  policyOperation: 'llm.gateway.use',
  scope: 'user',
  workspaceResolver: 'gateway-metadata-workspace',
});

registerOperations(catalog, ['quickChat'], {
  mutating: true,
  policyOperation: 'turn.run',
  resolver: 'actor-quick-chat-workspace',
  scope: 'workspace',
});
registerOperations(
  catalog,
  [
    'listAutomations',
    'listAgentCatalog',
    'getAgentCatalogEntry',
    'listInterruptedWorkers',
    'listAuthorizedWorkspaces',
    'searchApp',
    'GET /api/workspaces',
  ],
  {
    mutating: false,
    policyOperation: 'workspace.read',
    resolver: 'authorized-workspace-set',
    scope: 'workspace',
  }
);
registerOperations(catalog, ['listWorkspaceMembers', 'listWorkspaceInvitations'], {
  mutating: false,
  policyOperation: 'membership.manage',
  resolver: 'path-workspace',
  scope: 'workspace',
});
registerOperations(catalog, ['createWorkspaceInvitation'], {
  mutating: true,
  policyOperation: 'membership.manage',
  resolver: 'path-workspace',
  scope: 'workspace',
});
registerOperations(
  catalog,
  ['revokeWorkspaceInvitation', 'changeWorkspaceMemberAccess', 'removeWorkspaceMember'],
  {
    mutating: true,
    policyOperation: 'membership.manage',
    resolver: 'workspace-child-lineage',
    scope: 'workspace',
  }
);
registerOperations(catalog, ['transferWorkspaceOwnership', 'deleteWorkspace'], {
  mutating: true,
  policyOperation: 'workspace.lifecycle',
  resolver: 'path-workspace',
  scope: 'workspace',
});
registerOperations(catalog, ['createAutomation'], {
  mutating: true,
  policyOperation: 'workspace.write',
  resolver: 'body-workspace',
  scope: 'workspace',
});
registerOperations(catalog, ['POST /api/turns'], {
  mutating: true,
  policyOperation: 'turn.run',
  resolver: 'body-workspace',
  scope: 'workspace',
});
registerOperations(catalog, ['updateAutomation', 'deleteAutomation', 'submitTurnFeedback'], {
  mutating: true,
  policyOperation: 'workspace.write',
  resolver: 'opaque-child-workspace',
  scope: 'workspace',
});
registerOperations(catalog, ['POST /api/approvals/:approvalRequestId/respond'], {
  mutating: true,
  policyOperation: 'approval.respond',
  resolver: 'opaque-child-workspace',
  scope: 'workspace',
});

registerOperations(catalog, ['refreshAgentHealth'], {
  mutating: true,
  policyOperation: 'turn.run',
  resolver: 'path-workspace',
  scope: 'workspace',
});
registerOperations(
  catalog,
  [
    'listSchedulerAdmissions',
    'getWorkspaceDashboard',
    'listWorkspaceMaterials',
    'listWorkspaceSyncReviews',
    'listWorkspaceInputSnapshots',
    'listWorkspaceMaterializationRecords',
    'listWorkerOutputManifests',
    'listWorkspaceChangeSets',
    'listStagedWorkspaceReviews',
    'listWorkspaceApplyResults',
    'listWorkspaceApplyPlans',
    'listWorkspaceReconciliationRecords',
    'listWorkspaceQuarantineRecords',
    'GET /api/workspaces/:workspaceId',
    'GET /api/workspaces/:workspaceId/resources',
  ],
  {
    mutating: false,
    policyOperation: 'workspace.read',
    resolver: 'path-workspace',
    scope: 'workspace',
  }
);
registerOperations(
  catalog,
  [
    'answerKnowledgeManager',
    'listKnowledgeSources',
    'listKnowledgeObservations',
    'listKnowledgeClaims',
    'listKnowledgeConflicts',
    'readKnowledgeIndexes',
    'suggestKnowledgeRepairs',
    'checkKnowledgeHealth',
    'GET /api/workspaces/:workspaceId/knowledge',
  ],
  {
    mutating: false,
    policyOperation: 'knowledge.read',
    resolver: 'path-workspace',
    scope: 'workspace',
  }
);
registerOperations(catalog, ['retrieveKnowledge', 'prepareKnowledgeContext'], {
  mutating: true,
  policyOperation: 'knowledge.read',
  resolver: 'path-workspace',
  scope: 'workspace',
});
registerOperations(
  catalog,
  [
    'registerKnowledgeSource',
    'recordKnowledgeObservation',
    'recordKnowledgeClaim',
    'recordKnowledgeConflict',
    'POST /api/workspaces/:workspaceId/knowledge',
  ],
  {
    mutating: true,
    policyOperation: 'knowledge.write',
    resolver: 'path-workspace',
    scope: 'workspace',
  }
);
registerOperations(catalog, ['draftKnowledgeProposal'], {
  mutating: true,
  policyOperation: 'knowledge.propose',
  resolver: 'path-workspace',
  scope: 'workspace',
});
registerOperations(catalog, ['importWorkspaceArtifact'], {
  mutating: true,
  policyOperation: 'artifact.write',
  resolver: 'path-workspace',
  scope: 'workspace',
});
registerOperations(
  catalog,
  ['createWorkspaceMaterial', 'POST /api/workspaces/:workspaceId/threads'],
  {
    mutating: true,
    policyOperation: 'workspace.write',
    resolver: 'path-workspace',
    scope: 'workspace',
  }
);
registerOperations(
  catalog,
  [
    'listHumanAttention',
    'getCapabilityUsage',
    'listWorkspaceAuditEvents',
    'listWorkspaceEvidenceBundles',
    'listWorkspaceRuntimeEvidence',
    'listWorkspacePermissionDecisions',
    'listBackendWorkspaceHandles',
    'listAgentEnvironmentPackageSnapshots',
    'listWorkspaceVaultUseRecords',
    'listGitPushRecords',
  ],
  {
    mutating: false,
    policyOperation: 'audit.read',
    resolver: 'path-workspace',
    scope: 'workspace',
  }
);
registerOperations(catalog, ['exportWorkspace'], {
  mutating: true,
  policyOperation: 'workspace.export',
  resolver: 'path-workspace',
  scope: 'workspace',
});
registerOperations(catalog, ['downloadWorkspaceExportArchive'], {
  mutating: false,
  policyOperation: 'workspace.export',
  resolver: 'path-workspace',
  scope: 'workspace',
});
registerOperations(
  catalog,
  [
    'listWorkspaceVaultReferences',
    'listWorkspaceVaultGrants',
    'listWorkspaceVaultInjectionPlans',
    'listWorkspaceVaultInjectionReceipts',
  ],
  {
    mutating: false,
    policyOperation: 'vault.admin',
    resolver: 'path-workspace',
    scope: 'workspace',
  }
);
registerOperations(catalog, ['listWorkspaceRepositories', 'getWorkspaceRepositoryDiagnostics'], {
  mutating: false,
  policyOperation: 'workspace.configure',
  resolver: 'path-workspace',
  scope: 'workspace',
});
registerOperations(catalog, ['setDefaultWorkspaceRepository'], {
  mutating: true,
  policyOperation: 'workspace.configure',
  resolver: 'path-workspace',
  scope: 'workspace',
});
registerOperations(catalog, ['PATCH /api/workspaces/:workspaceId'], {
  mutating: true,
  policyOperation: 'workspace.lifecycle',
  resolver: 'path-workspace',
  scope: 'workspace',
});
registerOperations(catalog, ['GET /api/workspaces/:workspaceId/threads'], {
  mutating: false,
  policyOperation: 'thread.read',
  resolver: 'path-workspace',
  scope: 'workspace',
});
registerOperations(catalog, ['GET /api/workspaces/:workspaceId/artifacts'], {
  mutating: false,
  policyOperation: 'artifact.read',
  resolver: 'path-workspace',
  scope: 'workspace',
});

registerOperations(
  catalog,
  [
    'retryInterruptedWorkerCheckpoint',
    'retrySchedulerAdmission',
    'cancelSchedulerAdmission',
    'startTaskMode',
    'startThreadGoal',
    'submitThreadGoalSteering',
    'convertGoalSteeringToFollowUp',
    'cancelGoalSteering',
    'createThreadGoalPlan',
    'reviseThreadGoalPlan',
    'pauseThreadGoal',
    'resumeThreadGoal',
    'runThreadGoalStep',
    'POST /api/workspaces/:workspaceId/threads/:threadId/turns/:turnId/interrupt',
  ],
  {
    mutating: true,
    policyOperation: 'turn.run',
    resolver: 'workspace-child-lineage',
    scope: 'workspace',
  }
);
registerOperations(catalog, ['submitConversation'], {
  mutating: true,
  policyOperation: 'turn.run',
  resolver: 'workspace-child-lineage',
  scope: 'workspace',
});
registerOperations(catalog, ['getConversationTargets'], {
  mutating: false,
  policyOperation: 'thread.read',
  resolver: 'path-workspace',
  scope: 'workspace',
});
registerOperations(
  catalog,
  [
    'getThreadGoalSummary',
    'getThreadDashboard',
    'listThreadItems',
    'getThreadMaterial',
    'GET /api/workspaces/:workspaceId/threads/:threadId',
    'GET /api/workspaces/:workspaceId/threads/:threadId/events',
    'GET /api/workspaces/:workspaceId/threads/:threadId/turns/:turnId',
  ],
  {
    mutating: false,
    policyOperation: 'thread.read',
    resolver: 'workspace-child-lineage',
    scope: 'workspace',
  }
);
registerOperations(
  catalog,
  [
    'approveThreadGoalPlan',
    'submitArtifactReviewDecision',
    'submitKnowledgeProposalDecision',
    'submitGoalReviewDecision',
    'submitWorkspaceSyncReviewDecision',
    'submitWorkspaceRecoveryDecision',
  ],
  {
    mutating: true,
    policyOperation: 'review.apply',
    resolver: 'workspace-child-lineage',
    scope: 'workspace',
  }
);
registerOperations(catalog, ['readKnowledgeSource'], {
  mutating: false,
  policyOperation: 'knowledge.read',
  resolver: 'workspace-child-lineage',
  scope: 'workspace',
});
registerOperations(
  catalog,
  [
    'reverseKnowledgeProposal',
    'resolveKnowledgeConflict',
    'PATCH /api/workspaces/:workspaceId/knowledge/:knowledgeEntryId',
    'DELETE /api/workspaces/:workspaceId/knowledge/:knowledgeEntryId',
  ],
  {
    mutating: true,
    policyOperation: 'knowledge.write',
    resolver: 'workspace-child-lineage',
    scope: 'workspace',
  }
);
registerOperations(
  catalog,
  [
    'listArtifactReviews',
    'GET /api/workspaces/:workspaceId/artifacts/:artifactId',
    'GET /api/workspaces/:workspaceId/artifacts/:artifactId/content',
  ],
  {
    mutating: false,
    policyOperation: 'artifact.read',
    resolver: 'workspace-child-lineage',
    scope: 'workspace',
  }
);
registerOperations(catalog, ['introduceWorkspaceArtifact'], {
  mutating: true,
  policyOperation: 'artifact.write',
  resolver: 'workspace-child-lineage',
  scope: 'workspace',
});
registerOperations(
  catalog,
  [
    'getWorkspaceMaterial',
    'listWorkspaceMaterialRevisions',
    'getWorkspaceMaterialRevision',
    'getWorkspaceSyncReview',
    'getWorkspaceApplyResult',
  ],
  {
    mutating: false,
    policyOperation: 'workspace.read',
    resolver: 'workspace-child-lineage',
    scope: 'workspace',
  }
);
registerOperations(
  catalog,
  [
    'saveWorkspaceMaterialRevision',
    'bindThreadMaterial',
    'unbindThreadMaterial',
    'excludeThreadMaterial',
    'restoreThreadMaterial',
    'PATCH /api/workspaces/:workspaceId/threads/:threadId',
    'POST /api/workspaces/:workspaceId/threads/:threadId/archive',
  ],
  {
    mutating: true,
    policyOperation: 'workspace.write',
    resolver: 'workspace-child-lineage',
    scope: 'workspace',
  }
);
registerOperations(catalog, ['getAgentEnvironmentPackageSnapshot', 'getGitPushRecord'], {
  mutating: false,
  policyOperation: 'audit.read',
  resolver: 'workspace-child-lineage',
  scope: 'workspace',
});
registerOperations(catalog, ['rebindWorkspaceVaultReference'], {
  mutating: true,
  policyOperation: 'vault.admin',
  resolver: 'workspace-child-lineage',
  scope: 'workspace',
});
registerOperations(catalog, ['requestGitPushApproval', 'executeGitPush'], {
  mutating: true,
  policyOperation: 'repo.push',
  resolver: 'workspace-child-lineage',
  scope: 'workspace',
});

/** Canonical access metadata for every public App API and direct Core/Gateway operation. */
export const PUBLIC_OPERATION_ACCESS: Readonly<Record<string, PublicOperationAccess>> =
  Object.freeze(catalog);
