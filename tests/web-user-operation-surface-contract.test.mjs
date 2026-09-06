import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PUBLIC_OPERATION_ACCESS } from '../apps/nanocore/src/auth/operation-access.ts';
import { SURFACES } from '../apps/web/src/app/surfaces.ts';

const EXPECTED_CATALOG_SIZE = 195;
const EXPECTED_SERVER_SIZE = 46;
const EXPECTED_GATEWAY_SIZE = 2;
const EXPECTED_INCLUDED_SIZE = 147;

/** Included operations whose current Web projection is explicitly deferred to a Roadmap owner. */
const NON_RELEASE_READY_ROADMAP = new Map([
  ['createAutomation', 'R092'],
  ['deleteAutomation', 'R092'],
  ['deleteWorkspace', 'R049'],
  ['downloadWorkspaceExportArchive', 'R008'],
  ['draftKnowledgeProposal', 'R070'],
  ['dryRunWorkspaceArchiveImport', 'R008'],
  ['importWorkspaceArchive', 'R008'],
  ['listAutomations', 'R092'],
  ['recoverDeletedWorkspace', 'R049'],
  ['reverseKnowledgeProposal', 'R072'],
  ['updateAutomation', 'R092'],
]);

/** Published Tier-A titles from the live surface catalog. Unpublished B/C names are rejected. */
const WEB_SURFACES = new Set(
  SURFACES.filter((surface) => surface.tier === 'A').map((surface) => surface.title)
);

/**
 * Explicit grouped Web dispositions for every included catalog operation.
 *
 * This object is the coverage inventory. It is not a production owner.
 * The guard admits catalog membership, disposition, and a published surface title.
 * It does not prove UI behavior.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, WebOperationDisposition>>>>}
 */
const WEB_OPERATION_GROUPS = {
  'Agent environment': {
    getAgentEnvironmentPackageSnapshot: { disposition: 'live', surface: 'Debug' },
    listAgentEnvironmentPackageSnapshots: { disposition: 'live', surface: 'Debug' },
  },
  Agents: {
    getAgentCatalogEntry: { disposition: 'workflow', surface: 'Agents' },
    listAgentCatalog: { disposition: 'live', surface: 'Agents' },
  },
  'App utilities': {
    cancelSchedulerAdmission: { disposition: 'live', surface: 'Recovery' },
    listInterruptedWorkers: { disposition: 'live', surface: 'Recovery' },
    listSchedulerAdmissions: { disposition: 'live', surface: 'Recovery' },
    quickChat: { disposition: 'workflow', surface: 'Chat' },
    refreshAgentHealth: { disposition: 'live', surface: 'Agents' },
    retryInterruptedWorkerCheckpoint: { disposition: 'live', surface: 'Recovery' },
    retrySchedulerAdmission: { disposition: 'live', surface: 'Recovery' },
    searchApp: { disposition: 'workflow', surface: 'Overview' },
    submitTurnFeedback: { disposition: 'live', surface: 'Chat' },
  },
  Artifacts: {
    importWorkspaceArtifact: { disposition: 'live', surface: 'Artifacts' },
    introduceWorkspaceArtifact: { disposition: 'live', surface: 'Artifacts' },
  },
  Automations: {
    createAutomation: { disposition: 'roadmap', roadmap: 'R092' },
    deleteAutomation: { disposition: 'roadmap', roadmap: 'R092' },
    listAutomations: { disposition: 'roadmap', roadmap: 'R092' },
    updateAutomation: { disposition: 'roadmap', roadmap: 'R092' },
  },
  Dashboards: {
    getConversationTargets: { disposition: 'live', surface: 'Chat' },
    getThreadDashboard: { disposition: 'live', surface: 'Chat' },
    getWorkspaceDashboard: { disposition: 'live', surface: 'Overview' },
    listHumanAttention: { disposition: 'live', surface: 'Overview' },
    listThreadItems: { disposition: 'live', surface: 'Chat' },
  },
  'Diagnostics and evidence': {
    getCapabilityUsage: { disposition: 'live', surface: 'Usage & audit' },
    listWorkspaceAuditEvents: { disposition: 'live', surface: 'Usage & audit' },
    listWorkspaceEvidenceBundles: { disposition: 'live', surface: 'Debug' },
    listWorkspacePermissionDecisions: { disposition: 'live', surface: 'Usage & audit' },
    listWorkspaceRuntimeEvidence: { disposition: 'live', surface: 'Debug' },
  },
  'Knowledge Manager': {
    answerKnowledgeManager: { disposition: 'live', surface: 'Knowledge' },
    checkKnowledgeHealth: { disposition: 'live', surface: 'Knowledge' },
    draftKnowledgeProposal: { disposition: 'roadmap', roadmap: 'R070' },
    listKnowledgeClaims: { disposition: 'live', surface: 'Knowledge' },
    listKnowledgeConflicts: { disposition: 'live', surface: 'Knowledge' },
    listKnowledgeObservations: { disposition: 'live', surface: 'Knowledge' },
    listKnowledgeSources: { disposition: 'live', surface: 'Knowledge' },
    prepareKnowledgeContext: { disposition: 'live', surface: 'Knowledge' },
    readKnowledgeIndexes: { disposition: 'live', surface: 'Knowledge' },
    readKnowledgeSource: { disposition: 'live', surface: 'Knowledge' },
    recordKnowledgeClaim: { disposition: 'live', surface: 'Knowledge' },
    recordKnowledgeConflict: { disposition: 'live', surface: 'Knowledge' },
    recordKnowledgeObservation: { disposition: 'live', surface: 'Knowledge' },
    registerKnowledgeSource: { disposition: 'live', surface: 'Knowledge' },
    resolveKnowledgeConflict: { disposition: 'live', surface: 'Knowledge' },
    retrieveKnowledge: { disposition: 'live', surface: 'Knowledge' },
    suggestKnowledgeRepairs: { disposition: 'live', surface: 'Knowledge' },
  },
  Materials: {
    bindThreadMaterial: { disposition: 'live', surface: 'Material' },
    createWorkspaceMaterial: { disposition: 'live', surface: 'Material' },
    excludeThreadMaterial: { disposition: 'live', surface: 'Material' },
    getThreadMaterial: { disposition: 'live', surface: 'Material' },
    getWorkspaceMaterial: { disposition: 'live', surface: 'Material' },
    getWorkspaceMaterialRevision: { disposition: 'live', surface: 'Material' },
    listWorkspaceMaterialRevisions: { disposition: 'live', surface: 'Material' },
    listWorkspaceMaterials: { disposition: 'live', surface: 'Material' },
    restoreThreadMaterial: { disposition: 'live', surface: 'Material' },
    saveWorkspaceMaterialRevision: { disposition: 'live', surface: 'Material' },
    unbindThreadMaterial: { disposition: 'live', surface: 'Material' },
  },
  Modes: {
    approveThreadGoalPlan: { disposition: 'live', surface: 'Goal' },
    cancelGoalSteering: { disposition: 'live', surface: 'Material' },
    convertGoalSteeringToFollowUp: { disposition: 'live', surface: 'Material' },
    createThreadGoalPlan: { disposition: 'live', surface: 'Goal' },
    getThreadGoalSummary: { disposition: 'live', surface: 'Goal' },
    pauseThreadGoal: { disposition: 'live', surface: 'Goal' },
    resumeThreadGoal: { disposition: 'live', surface: 'Goal' },
    reviseThreadGoalPlan: { disposition: 'live', surface: 'Goal' },
    runThreadGoalStep: { disposition: 'live', surface: 'Goal' },
    submitConversation: { disposition: 'live', surface: 'Chat' },
    startTaskMode: { disposition: 'live', surface: 'Task' },
    startThreadGoal: { disposition: 'live', surface: 'Goal' },
    submitThreadGoalSteering: { disposition: 'live', surface: 'Goal' },
  },
  Repositories: {
    executeGitPush: { disposition: 'live', surface: 'Repositories' },
    getGitPushRecord: { disposition: 'live', surface: 'Repositories' },
    getWorkspaceRepositoryDiagnostics: { disposition: 'live', surface: 'Repositories' },
    listGitPushRecords: { disposition: 'live', surface: 'Repositories' },
    listWorkspaceRepositories: { disposition: 'live', surface: 'Repositories' },
    requestGitPushApproval: { disposition: 'live', surface: 'Repositories' },
    setDefaultWorkspaceRepository: { disposition: 'workflow', surface: 'Repositories' },
  },
  Reviews: {
    listArtifactReviews: { disposition: 'live', surface: 'Artifact review' },
    reverseKnowledgeProposal: { disposition: 'roadmap', roadmap: 'R072' },
    submitArtifactReviewDecision: { disposition: 'live', surface: 'Artifact review' },
    submitGoalReviewDecision: { disposition: 'live', surface: 'Goal' },
    submitKnowledgeProposalDecision: { disposition: 'live', surface: 'Knowledge' },
  },
  Portability: {
    downloadWorkspaceExportArchive: { disposition: 'roadmap', roadmap: 'R008' },
    dryRunWorkspaceArchiveImport: { disposition: 'roadmap', roadmap: 'R008' },
    dryRunWorkspaceImport: { disposition: 'live', surface: 'Portability' },
    exportWorkspace: { disposition: 'live', surface: 'Portability' },
    importWorkspaceArchive: { disposition: 'roadmap', roadmap: 'R008' },
    importWorkspace: { disposition: 'live', surface: 'Portability' },
  },
  Vault: {
    listWorkspaceVaultGrants: { disposition: 'live', surface: 'Vault' },
    listWorkspaceVaultInjectionPlans: { disposition: 'live', surface: 'Vault' },
    listWorkspaceVaultInjectionReceipts: { disposition: 'live', surface: 'Vault' },
    listWorkspaceVaultReferences: { disposition: 'live', surface: 'Vault' },
    listWorkspaceVaultUseRecords: { disposition: 'live', surface: 'Vault' },
    rebindWorkspaceVaultReference: { disposition: 'live', surface: 'Portability' },
  },
  'Workspace sharing': {
    acceptWorkspaceInvitation: { disposition: 'live', surface: 'Account' },
    changeWorkspaceMemberAccess: { disposition: 'live', surface: 'Account' },
    createWorkspaceInvitation: { disposition: 'live', surface: 'Account' },
    declineWorkspaceInvitation: { disposition: 'live', surface: 'Account' },
    deleteWorkspace: { disposition: 'roadmap', roadmap: 'R049' },
    leaveWorkspace: { disposition: 'live', surface: 'Account' },
    listAuthorizedWorkspaces: { disposition: 'live', surface: 'Account' },
    listMyWorkspaceInvitations: { disposition: 'live', surface: 'Account' },
    listWorkspaceInvitations: { disposition: 'live', surface: 'Account' },
    listWorkspaceMembers: { disposition: 'live', surface: 'Account' },
    removeWorkspaceMember: { disposition: 'live', surface: 'Account' },
    recoverDeletedWorkspace: { disposition: 'roadmap', roadmap: 'R049' },
    revokeWorkspaceInvitation: { disposition: 'live', surface: 'Account' },
    transferWorkspaceOwnership: { disposition: 'live', surface: 'Account' },
  },
  'My admin access': {
    listMyAdminAccessTokens: { disposition: 'live', surface: 'My admin access' },
    setMyAdminAccessTokenDefault: { disposition: 'live', surface: 'My admin access' },
  },
  'Workspace Sync and recovery': {
    getWorkspaceApplyResult: { disposition: 'live', surface: 'Workspace changes' },
    getWorkspaceSyncReview: { disposition: 'live', surface: 'Workspace changes' },
    listBackendWorkspaceHandles: { disposition: 'live', surface: 'Workspace changes' },
    listStagedWorkspaceReviews: { disposition: 'live', surface: 'Workspace changes' },
    listWorkerOutputManifests: { disposition: 'live', surface: 'Workspace changes' },
    listWorkspaceApplyPlans: { disposition: 'live', surface: 'Workspace changes' },
    listWorkspaceApplyResults: { disposition: 'live', surface: 'Workspace changes' },
    listWorkspaceChangeSets: { disposition: 'live', surface: 'Workspace changes' },
    listWorkspaceInputSnapshots: { disposition: 'live', surface: 'Workspace changes' },
    listWorkspaceMaterializationRecords: { disposition: 'live', surface: 'Workspace changes' },
    listWorkspaceQuarantineRecords: { disposition: 'live', surface: 'Workspace changes' },
    listWorkspaceReconciliationRecords: { disposition: 'live', surface: 'Workspace changes' },
    listWorkspaceSyncReviews: { disposition: 'live', surface: 'Workspace changes' },
    submitWorkspaceRecoveryDecision: { disposition: 'live', surface: 'Workspace changes' },
    submitWorkspaceSyncReviewDecision: { disposition: 'live', surface: 'Workspace changes' },
  },
  'Core approval': {
    'POST /api/approvals/:approvalRequestId/respond': { disposition: 'live', surface: 'Overview' },
  },
  'Core artifacts': {
    'GET /api/workspaces/:workspaceId/artifacts': {
      disposition: 'live',
      surface: 'Artifacts',
    },
    'GET /api/workspaces/:workspaceId/artifacts/:artifactId': {
      disposition: 'live',
      surface: 'Artifact review',
    },
    'GET /api/workspaces/:workspaceId/artifacts/:artifactId/content': {
      disposition: 'workflow',
      surface: 'Artifact review',
    },
  },
  'Core Knowledge CRUD': {
    'DELETE /api/workspaces/:workspaceId/knowledge/:knowledgeEntryId': {
      disposition: 'live',
      surface: 'Knowledge',
    },
    'GET /api/workspaces/:workspaceId/knowledge': { disposition: 'live', surface: 'Knowledge' },
    'PATCH /api/workspaces/:workspaceId/knowledge/:knowledgeEntryId': {
      disposition: 'live',
      surface: 'Knowledge',
    },
    'POST /api/workspaces/:workspaceId/knowledge': { disposition: 'live', surface: 'Knowledge' },
  },
  'Core thread reads': {
    'GET /api/workspaces/:workspaceId/threads': { disposition: 'live', surface: 'Chat' },
    'GET /api/workspaces/:workspaceId/threads/:threadId': { disposition: 'live', surface: 'Chat' },
    'GET /api/workspaces/:workspaceId/threads/:threadId/events': {
      disposition: 'live',
      surface: 'Chat',
    },
    'GET /api/workspaces/:workspaceId/threads/:threadId/turns/:turnId': {
      disposition: 'workflow',
      surface: 'Chat',
    },
  },
  'Core turn commands': {
    'POST /api/turns': { disposition: 'live', surface: 'Chat' },
    'POST /api/workspaces/:workspaceId/threads/:threadId/turns/:turnId/interrupt': {
      disposition: 'live',
      surface: 'Chat',
    },
  },
  'Core workspace lifecycle and reads': {
    'GET /api/workspaces': { disposition: 'live', surface: 'Chat' },
    'GET /api/workspaces/:workspaceId': { disposition: 'live', surface: 'General' },
    'GET /api/workspaces/:workspaceId/resources': { disposition: 'workflow', surface: 'Overview' },
    'PATCH /api/workspaces/:workspaceId': { disposition: 'live', surface: 'General' },
  },
  'Core workspace and Thread writes': {
    'PATCH /api/workspaces/:workspaceId/threads/:threadId': {
      disposition: 'live',
      surface: 'Chat',
    },
    'POST /api/workspaces': { disposition: 'live', surface: 'New workspace' },
    'POST /api/workspaces/:workspaceId/threads': { disposition: 'live', surface: 'Chat' },
    'POST /api/workspaces/:workspaceId/threads/:threadId/archive': {
      disposition: 'live',
      surface: 'Chat',
    },
  },
};

/**
 * One inventory row: a published Web surface or a named Roadmap owner.
 *
 * @typedef {{ disposition: 'live' | 'workflow', surface: string, roadmap?: undefined } | { disposition: 'roadmap', roadmap: string, surface?: undefined }} WebOperationDisposition
 */

/**
 * Partitions the runtime public-operation catalog by Web inclusion.
 *
 * @param {Readonly<Record<string, { authentication?: string, scope: string }>>} catalog
 * Runtime `PUBLIC_OPERATION_ACCESS` value.
 * @returns {{ gateway: string[], included: string[], server: string[], total: number }}
 * Sorted operation-key partitions.
 */
function partitionCatalog(catalog) {
  const entries = Object.entries(catalog);
  const gateway = [];
  const included = [];
  const server = [];

  for (const [operationKey, access] of entries) {
    if (access.scope === 'server') {
      server.push(operationKey);
      continue;
    }
    if (access.authentication === 'gateway-actor') {
      gateway.push(operationKey);
      continue;
    }
    if (access.scope === 'user' || access.scope === 'workspace') {
      included.push(operationKey);
    }
  }

  gateway.sort();
  included.sort();
  server.sort();
  return { gateway, included, server, total: entries.length };
}

/**
 * Flattens the grouped inventory and records any repeated operation keys.
 *
 * @param {Readonly<Record<string, Readonly<Record<string, WebOperationDisposition>>>>} groups
 * Grouped disposition inventory.
 * @returns {{ duplicates: string[], operations: Map<string, WebOperationDisposition> }}
 * Deduped operation map plus duplicate keys.
 */
function flattenInventory(groups) {
  const operations = new Map();
  const duplicates = [];

  for (const dispositions of Object.values(groups)) {
    for (const [operationKey, disposition] of Object.entries(dispositions)) {
      if (operations.has(operationKey)) {
        duplicates.push(operationKey);
        continue;
      }
      operations.set(operationKey, disposition);
    }
  }

  return { duplicates, operations };
}

/**
 * Asserts one inventory row is live/workflow with a known surface, or an accepted Roadmap exception.
 *
 * @param {string} operationKey Catalog operation key.
 * @param {WebOperationDisposition} disposition Inventory row.
 */
function assertDisposition(operationKey, disposition) {
  if (disposition.disposition === 'live' || disposition.disposition === 'workflow') {
    assert.equal(
      typeof disposition.surface,
      'string',
      `${operationKey} live/workflow disposition requires a Web surface`
    );
    assert.ok(
      WEB_SURFACES.has(disposition.surface),
      `${operationKey} surface is not a published Web surface: ${disposition.surface}`
    );
    assert.equal(
      disposition.roadmap,
      undefined,
      `${operationKey} live/workflow disposition must not carry a Roadmap id`
    );
    return;
  }

  assert.equal(
    disposition.disposition,
    'roadmap',
    `${operationKey} has unknown disposition ${disposition.disposition}`
  );
  assert.ok(
    NON_RELEASE_READY_ROADMAP.has(operationKey),
    `${operationKey} has no accepted roadmap-only disposition`
  );
  assert.equal(
    disposition.roadmap,
    NON_RELEASE_READY_ROADMAP.get(operationKey),
    `${operationKey} roadmap disposition must match its accepted owner`
  );
  assert.equal(
    disposition.surface,
    undefined,
    `${operationKey} roadmap disposition must not carry a Web surface`
  );
}

describe('Web user operation surface contract', () => {
  it('accounts for every included catalog operation and excludes server and Gateway-actor operations', () => {
    const catalog = partitionCatalog(PUBLIC_OPERATION_ACCESS);
    const inventory = flattenInventory(WEB_OPERATION_GROUPS);
    const inventoried = [...inventory.operations.keys()].sort();

    assert.equal(catalog.total, EXPECTED_CATALOG_SIZE);
    assert.equal(catalog.server.length, EXPECTED_SERVER_SIZE);
    assert.equal(catalog.gateway.length, EXPECTED_GATEWAY_SIZE);
    assert.equal(catalog.included.length, EXPECTED_INCLUDED_SIZE);
    assert.deepEqual(catalog.gateway, ['POST /v1/chat/completions', 'POST /v1/responses']);
    assert.deepEqual(inventory.duplicates, []);
    assert.deepEqual(
      inventoried.filter((operationKey) => catalog.server.includes(operationKey)),
      []
    );
    assert.deepEqual(
      inventoried.filter((operationKey) => catalog.gateway.includes(operationKey)),
      []
    );
    assert.deepEqual(
      inventoried.filter((operationKey) => !catalog.included.includes(operationKey)),
      []
    );
    assert.deepEqual(
      catalog.included.filter((operationKey) => !inventory.operations.has(operationKey)),
      []
    );
    assert.deepEqual(inventoried, catalog.included);

    const remainingRoadmapOnly = inventoried.filter((operationKey) => {
      const disposition = inventory.operations.get(operationKey);
      return disposition?.disposition === 'roadmap' && !NON_RELEASE_READY_ROADMAP.has(operationKey);
    });
    assert.deepEqual(remainingRoadmapOnly, []);

    for (const [operationKey, disposition] of inventory.operations) {
      assertDisposition(operationKey, disposition);
    }
  });
});
