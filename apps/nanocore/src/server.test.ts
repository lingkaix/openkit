import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  type ClientHttp2Session,
  connect as connectHttp2,
  createServer as createHttp2Server,
  type ServerHttp2Session,
} from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import {
  CancelSchedulerAdmissionResponseSchema,
  CapabilityUsageResponseSchema,
  DataRootBackupCreateResponseSchema,
  DataRootBackupVerifyResponseSchema,
  KnowledgeRetrievalResponseSchema,
  ListHumanAttentionResponseSchema,
  ListSchedulerAdmissionsResponseSchema,
  ListServerAuditEventsResponseSchema,
  ListServerPermissionDecisionsResponseSchema,
  ListServerVaultUseRecordsResponseSchema,
  ListWorkspaceAuditEventsResponseSchema,
  ListWorkspaceEvidenceBundlesResponseSchema,
  ListWorkspacePermissionDecisionsResponseSchema,
  ListWorkspaceRuntimeEvidenceResponseSchema,
  ListWorkspaceVaultGrantsResponseSchema,
  ListWorkspaceVaultInjectionPlansResponseSchema,
  ListWorkspaceVaultInjectionReceiptsResponseSchema,
  ListWorkspaceVaultUseRecordsResponseSchema,
  RetrySchedulerAdmissionResponseSchema,
  StartTaskModeResponseSchema,
  SubmitConversationResponseSchema,
  SubmitWorkspaceRecoveryDecisionResponseSchema,
  WorkspaceExportResponseSchema,
  WorkspaceImportDryRunResponseSchema,
  WorkspaceImportResponseSchema,
} from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  parseWorkspaceDataSourceCatalog,
  parseWorkspaceMcpServerCatalog,
} from '@openkit/config-schema';
import {
  MetaResponseSchema,
  PROTOCOL_VERSION,
  SseEventEnvelopeSchema,
  ThreadSchema,
} from '@openkit/protocol';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { type CreateAppOptions, createApp as createNanoCoreApp } from './app.js';
import { createArtifactReview } from './artifact-reviews.js';
import { recordServerAuditEvent, recordWorkspaceAuditEvent } from './audit-events.js';
import { ensureLocalUser } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import { createNanoHostTransportSessionAuthority } from './auth/nanohost-transport-session.js';
import { createNanoHostTransportTokenRecord } from './auth/nanohost-transport-token-store.js';
import {
  computeBootReadinessSnapshot,
  createShutdownReadinessSnapshot,
} from './bootstrap/readiness.js';
import {
  finishCapabilityCall,
  recordUsage,
  startCapabilityCall,
} from './capability/usage-ledger.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from './config/runtime-config.js';
import { StructuredWorkerDelegationRequestSchema } from './internal-agents/delegation.js';
import * as workerCoordinator from './internal-agents/worker-coordinator.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { createDemoWorkspaceForUser, FsStore, type FsStoreOptions } from './lib/store.js';
import { OpenAICompatibleProviderError } from './llm/openai-compatible-client.js';
import type { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { attachPiAiFailure } from './llm/pi-ai-failure.js';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from './mode-entry-routes.js';
import { registerOperationJsonRoutes } from './operation-json-routes.js';
import { recordProductPermissionDecision } from './policy/permission-decisions.js';
import { ProviderRegistry } from './providers/registry.js';
import { recordAgentEnvironmentPackageSnapshot } from './runtime/aep-snapshot-ledger.js';
import {
  resolveAgentEnvironmentPackage,
  resolveAgentSessionCompatibilityKey,
} from './runtime/agent-environment.js';
import {
  buildFilesystemWorkspaceChangeSet,
  createFilesystemSnapshotManifest,
  stageFilesystemWorkspaceChanges,
} from './runtime/filesystem-workspace-sync.js';
import { commandInputHash } from './runtime/idempotent-command.js';
import { mcpToolSchemaContentDigest } from './runtime/mcp-tool-schema-snapshots.js';
import { getNanoHostRuntimeTarget } from './runtime/nanohost-runtime-target.js';
import { createNanoHostSessionDispatch } from './runtime/nanohost-session-dispatch.js';
import type {
  CommitPreparedAgentSessionForTurnInput,
  PrepareAgentSessionForTurnInput,
  PreparedAgentSessionForTurn,
  TurnCommandRuntimeContext,
  TurnExecutor,
  TurnStartRuntimeContext,
} from './runtime/types.js';
import {
  getWorkerCheckpoint,
  listExportableWorkerCheckpoints,
  parseWorkerCheckpointContextAssembly,
  updateWorkerCheckpoint,
  upsertWorkerCheckpoint,
} from './runtime/worker-checkpoints.js';
import { WorkerControlGateway } from './runtime/worker-control-gateway.js';
import { listWorkspaceApplyPlans } from './runtime/workspace-apply-plans.js';
import {
  listWorkspaceApplyResults,
  recordWorkspaceApplyResult,
} from './runtime/workspace-apply-results.js';
import { recordFilesystemWorkspaceStagingRoot } from './runtime/workspace-filesystem-staging.js';
import { recordWorkspaceQuarantineRecord } from './runtime/workspace-quarantine-records.js';
import {
  listWorkspaceReconciliationRecords,
  recordWorkspaceReconciliationRecord,
} from './runtime/workspace-reconciliation-records.js';
import {
  getWorkspaceSyncReview,
  listBackendWorkspaceHandles,
  listWorkspaceChangeSets,
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
  listWorkspaceSyncReviews,
  recordWorkspaceSyncReview,
  updateWorkspaceSyncReviewDecision,
} from './runtime/workspace-sync-records.js';
import {
  createSchedulerAdmissionEntry,
  createSchedulerPlacementPlan,
  createSchedulerSessionLease,
  denySchedulerAdmissionEntry,
  listQueuedSchedulerAdmissionEntries,
  listSchedulerAdmissionEntriesForWorkspace,
  requireSchedulerSessionLease,
} from './scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import {
  LOCAL_USER_ID,
  readDataRootLayoutMarker,
  recordDataRootDeploymentMove,
} from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { verifyWorkspaceExportTree } from './storage/workspace-export.js';
import { readWorkspaceImportSnapshot } from './storage/workspace-import.js';
import { readWorkspaceKnowledgeRetrievalTrace } from './storage/workspace-portable-file-state.js';
import { createTestAgentSetup, createTestGatewayConfig } from './test-support/agent-environment.js';
import {
  createAppWithWorkspaceAuthority,
  createApp as createDeterministicTestApp,
} from './test-support/app.js';
import { seedWritableGitRepository } from './test-support/git-repository.js';
import { knowledgeOperationRequest } from './test-support/knowledge-operation.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordTestWorkspaceReviewMaterialization } from './test-support/workspace-sync.js';
import { startTurn as startNativeTurn } from './turn-routes.js';
import { createVaultGrant, listVaultGrants } from './vault/vault-grants.js';
import {
  createVaultReference,
  getVaultReference,
  listVaultReferences,
  rebindWorkspaceVaultReference,
} from './vault/vault-references.js';
import { createVaultUseRecord, listVaultUseRecords } from './vault/vault-use-records.js';
import { createVaultInjectionPlan, listVaultInjectionPlans } from './vault-injection-plans.js';
import {
  createVaultInjectionReceipt,
  listVaultInjectionReceipts,
} from './vault-injection-receipts.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

/**
 * Computes the canonical S16 digest for exact UTF-8 Artifact content.
 *
 * @param content Exact Artifact body.
 * @returns Lowercase SHA-256 digest with the required prefix.
 */
function artifactDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/**
 * Opens a migrated Core database for turn-start repository tests.
 *
 * @returns Migrated Core database handles backed by a temporary data root.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-turn-repository-db-'));
  const coreDb = openCoreDb(dataRoot);

  applyMigrations(coreDb);
  return coreDb;
}

/**
 * Opens a migrated workspace database for server route tests.
 *
 * @param coreDb Core database whose data root owns the workspace database.
 * @param workspaceId Workspace id to open.
 * @returns Migrated workspace database handle.
 */
function openTestWorkspaceDb(coreDb: CoreDb, workspaceId: string): WorkspaceDb {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, workspaceId);
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Records the exact scheduler lease lineage used by interrupted-worker retry route tests.
 *
 * @param coreDb Open Core database handle.
 * @param input Turn and lease state to record.
 */
function recordWorkerRetryLease(
  coreDb: CoreDb,
  input: {
    readonly agentSessionId: string;
    readonly recoveryState: 'awaiting-reconnect' | 'needs-evidence' | null;
    readonly releaseReason: string | null;
    readonly status: 'active' | 'released' | 'failed';
    readonly threadId: string;
    readonly turnId: string;
  }
): void {
  createSchedulerAdmissionEntry(coreDb, {
    triggerActor: { kind: 'user', id: 'user_local' },
    priorityClass: 'interactive',
    profileRef: 'agent_codex_host',
    queueEntryId: `queue_${input.turnId}`,
    requestId: `request_${input.turnId}`,
    requestedAgentId: 'agent_codex_host',
    requiredPoolConstraints: ['openshell.local'],
    threadId: input.threadId,
    turnId: input.turnId,
    turnInput: 'Run interrupted-worker retry fixture.',
    workspaceId: 'ws_demo',
  });
  createSchedulerPlacementPlan(coreDb, {
    degradedOptionalFeatures: [],
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    planId: `plan_${input.turnId}`,
    plannedLeaseDurationMs: 900_000,
    policyDecisionIds: [],
    queueEntryId: `queue_${input.turnId}`,
    schedulerEpoch: 1,
    selectedPoolId: 'pool_local',
    selectedTargetId: 'target_local',
  });
  createSchedulerSessionLease(coreDb, {
    agentSessionId: input.agentSessionId,
    expiresAt: '2099-01-01T01:00:00.000Z',
    heartbeatDeadline: '2099-01-01T00:10:00.000Z',
    leaseId: `lease_${input.turnId}`,
    packageSnapshotId: `aepsnap_${input.turnId}`,
    planId: `plan_${input.turnId}`,
    sandboxTokenBindingRef: `lease-binding:lease_${input.turnId}`,
    startupDeadline: '2099-01-01T00:05:00.000Z',
  });
  coreDb.sqlite
    .prepare(
      `UPDATE scheduler_session_leases
       SET status = ?, release_reason = ?, recovery_state = ?, recovery_deadline = ?
       WHERE lease_id = ?`
    )
    .run(
      input.status,
      input.releaseReason,
      input.recoveryState,
      input.recoveryState === 'awaiting-reconnect' ? '2099-01-01T00:05:00.000Z' : null,
      `lease_${input.turnId}`
    );
}

/**
 * Records a provenance-required package for one Turn and no raw provenance bundle.
 *
 * @param store Store that owns the Turn.
 * @param workspaceDb Workspace database that stores the package snapshot.
 * @param turnId Turn the package must match.
 * @param agentSessionId AgentSession id stored on the package.
 */
function recordProvenanceRequiredStaleBootPackage(
  store: FsStore,
  workspaceDb: WorkspaceDb,
  turnId: string,
  agentSessionId: string
): void {
  const turn = store.getTurnById(turnId);
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agentSetup: createTestAgentSetup({
        requiredCapabilities: ['trusted-worker-inference-relay', 'worker.runtime-provenance.v1'],
      }),
      agentSessionId,
      backend: { kind: 'openshell' },
      createdAt: '2026-09-15T13:38:00.000Z',
      requestId: `req_${turnId}`,
      triggerActor: { kind: 'user', id: LOCAL_USER_ID },
      turn,
      turnInput: 'Stale boot provenance fixture',
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    })
  );
  recordAgentEnvironmentPackageSnapshot(workspaceDb, {
    createdAt: '2026-09-15T13:38:01.000Z',
    environmentPackage,
  });
}

/**
 * Imports the Demo Workspace fixture into a test store when it is absent.
 *
 * @param store Store that should own the fixture.
 * @param userId User id namespace for fixture ids.
 */
function seedDemoWorkspace(store: FsStore, userId = LOCAL_USER_ID): void {
  const demo = createDemoWorkspaceForUser(userId);

  try {
    store.getWorkspace(demo.workspace.id);
    return;
  } catch {
    store.importWorkspaceSnapshot({
      workspace: demo.workspace,
      threads: [demo.thread],
      knowledge: demo.knowledge,
      turns: [],
      itemRevisions: [],
      artifacts: [],
      agentSessions: [],
      turnEvents: [],
    });
  }
}

/**
 * Creates a test store with the legacy Demo Workspace fixture.
 *
 * @param options Store options.
 * @returns Store with Quick Chat plus Demo Workspace.
 */
function createDemoStore(options: FsStoreOptions = {}): FsStore {
  const store = new FsStore(options);
  store.ensureQuickChatWorkspace(LOCAL_USER_ID);
  seedDemoWorkspace(store, LOCAL_USER_ID);
  return store;
}

/**
 * Returns the local provider registry that matches `createTestAgentSetup()`.
 *
 * @returns Registry containing the test OpenRouter profile.
 */
function testProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      displayName: 'Agent OpenRouter',
      id: 'agent-openrouter',
      kind: 'local',
      models: ['openai/gpt-5.2'],
    },
  ]);
}

/** Serializes the explicit Assistant-targeted Composer contract used by Chat tests. */
function conversationRequest(input: {
  readonly input: string;
  readonly requestId: string;
  readonly artifactRefs?: readonly {
    readonly artifactId: string;
    readonly artifactVersion: number;
  }[];
}): string {
  return JSON.stringify({
    input: input.input,
    requestId: input.requestId,
    targetRef: 'internal-role:assistant',
    artifactRefs: input.artifactRefs ?? [],
  });
}

/** Live Chat Mode prompt that must not be classified as external search. */
const LIVE_GOAL_WEB_CHAT_PROMPT =
  '请只阅读本次明确附加的维护报告，回复报告中的验收标记和已通过的 Goal Web 测试数量。如果无法读取正文，请明确说明，不要猜测。不要执行开发任务、修改文件或配置。';

/** Unique marker in the synthetic maintenance report body. */
const LIVE_GOAL_WEB_REPORT_MARKER = 'ACCEPTANCE_MARK=GOAL-WEB-PASSED-7';

/**
 * Creates one imported Markdown Artifact visible to Chat Mode attachment.
 *
 * @param store Store that owns Demo Workspace artifacts.
 * @param input Artifact identity and body.
 * @returns Created Artifact.
 */
function createImportedMarkdownArtifact(
  store: FsStore,
  input: {
    readonly id: string;
    readonly workspaceId?: string;
    readonly title: string;
    readonly body: string;
    readonly requestId: string;
  }
): ReturnType<FsStore['createArtifact']> {
  const timestamp = new Date().toISOString();
  const contentDigest = artifactDigest(input.body);
  return store.createArtifact({
    id: input.id,
    workspaceId: input.workspaceId ?? 'ws_demo',
    threadId: null,
    turnId: null,
    kind: 'file',
    title: input.title,
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'markdown', body: input.body },
    contentDigest,
    lastMutationRequestId: input.requestId,
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: input.requestId,
      sourceDigest: contentDigest,
      actor: { kind: 'user', id: LOCAL_USER_ID },
      requestId: input.requestId,
      recordedAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

/**
 * Builds the existing Chat answering provider fixture and records user prompts.
 *
 * @param prompts Captured provider user prompts.
 * @returns App options that admit Assistant Chat completions.
 */
function chatAnsweringProvider(
  prompts: string[]
): Pick<CreateAppOptions, 'gatewayConfig' | 'internalRoleProfiles' | 'llmPiAiClient'> {
  const gatewayConfig = createTestGatewayConfig();
  return {
    gatewayConfig,
    internalRoleProfiles: {
      schemaVersion: 1,
      defaultLogicalModelId: gatewayConfig.defaultLogicalModelId,
      profiles: [],
    },
    llmPiAiClient: {
      createChatCompletion: async (_provider, request) => {
        const user = request.messages.find((message) => message.role === 'user');
        prompts.push(typeof user?.content === 'string' ? user.content : '');
        return {
          id: 'chatcmpl_assistant_chat',
          object: 'chat.completion',
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Assistant answer.' },
              finish_reason: 'stop',
            },
          ],
        };
      },
    } as unknown as PiAiGatewayClient,
  };
}

/**
 * Creates a test app with the legacy Demo Workspace fixture.
 *
 * @param options App options.
 * @returns Test app.
 */
function createApp(
  options: CreateAppOptions = {},
  canonicalAuthority = false
): ReturnType<typeof createNanoCoreApp> {
  if (options.coreDb) {
    ensureLocalUser(options.coreDb);
  }

  const store =
    options.store ?? createDemoStore(options.coreDb ? { dataRoot: options.coreDb.dataRoot } : {});

  seedDemoWorkspace(store);
  if (options.coreDb) {
    for (const workspace of store.listWorkspaces()) {
      const registered = options.coreDb.sqlite
        .prepare('SELECT 1 FROM workspace_registry WHERE workspace_id = ?')
        .get(workspace.id);
      if (registered) {
        continue;
      }
      recordWorkspaceOwnerMembership({
        coreDb: options.coreDb,
        ownerUserId: LOCAL_USER_ID,
        workspaceId: workspace.id,
      });
    }
  }
  return (canonicalAuthority ? createAppWithWorkspaceAuthority : createDeterministicTestApp)({
    agentManifests: [createTestAgentSetup().manifest],
    openKitConfig: { defaults: { defaultAgentId: 'agent_codex_host' } },
    providerRegistry: testProviderRegistry(),
    ...options,
    store,
  });
}

/**
 * Drafts one source-backed create-only Knowledge Proposal through its public route.
 *
 * @param app Test NanoCore app.
 * @param suffix Safe unique suffix for the proposal fixture.
 * @returns Exact proposal and candidate page tuple used by decision and reversal tests.
 */
async function draftKnowledgeProposalFixture(
  app: ReturnType<typeof createNanoCoreApp>,
  suffix: string
) {
  const sourceResponse = await app.request(
    ...knowledgeOperationRequest(
      'knowledge.source.register',
      { workspaceId: 'ws_demo' },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: `knowledge-source-${suffix}`,
          kind: 'document',
          title: `Proposal source ${suffix}`,
          uri: `file://proposal-source-${suffix}.md`,
          content: `Authoritative proposal source ${suffix}.`,
        }),
      }
    )
  );
  expect(sourceResponse.status, await sourceResponse.clone().text()).toBe(200);
  const source = (await sourceResponse.json()) as {
    source: { id: string; contentDigest: string };
  };
  const sourceReference = `source:${source.source.id}@${source.source.contentDigest}`;
  const knowledgePageId = `proposal-${suffix}`;
  const canonicalPageBytes = [
    '---',
    'type: "KnowledgePage"',
    `title: "Proposal ${suffix}"`,
    'schema_version: "openkit-workspace-knowledge-schema-v2"',
    'openkit_status: "active"',
    'status: "stable"',
    'scope: "workspace"',
    `openkit_entry_id: "${knowledgePageId}"`,
    'openkit_entry_kind: "project-context"',
    `source_refs: ${JSON.stringify([sourceReference])}`,
    'review_state: "accepted"',
    'sensitivity: "normal"',
    'freshness: "current"',
    'created_at: "2026-07-19T00:00:00.000Z"',
    'updated_at: "2026-07-19T00:00:00.000Z"',
    '---',
    `Reusable proposal lesson ${suffix}.`,
    '',
  ].join('\n');
  const contentDigest = artifactDigest(canonicalPageBytes);
  const requestId = knowledgeProposalRequestId(`draft-${suffix}`);
  const response = await app.request(
    ...knowledgeOperationRequest(
      'knowledge.proposal.draft',
      { workspaceId: 'ws_demo' },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId,
          knowledgePageId,
          canonicalPageBytes,
          contentDigest,
          sourceReferences: [sourceReference],
          rationale: `Preserve proposal lesson ${suffix}.`,
          confidence: 0.8,
        }),
      }
    )
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { proposal: { id: string } };

  return {
    proposalId: body.proposal.id,
    knowledgePageId,
    canonicalPageBytes,
    contentDigest,
  };
}

/**
 * Derives one deterministic protocol UUID for a Knowledge Proposal test command.
 *
 * @param label Stable fixture label.
 * @returns Deterministic UUID-shaped request identity.
 */
function knowledgeProposalRequestId(label: string): string {
  const suffix = createHash('sha256').update(label, 'utf8').digest('hex').slice(0, 12);
  return `00000000-0000-4000-8000-${suffix}`;
}

/**
 * Returns the authoritative file path for one Knowledge Page fixture.
 *
 * @param dataRoot Data root that owns the fixture.
 * @param knowledgePageId Safe Knowledge Page identity.
 * @returns Absolute authoritative page path.
 */
function knowledgeProposalPagePath(dataRoot: string, knowledgePageId: string): string {
  return join(dataRoot, 'workspaces', 'ws_demo', 'knowledge', 'pages', `${knowledgePageId}.md`);
}

/**
 * Submits one exact Knowledge Proposal decision through the public route.
 *
 * @param app Test NanoCore app.
 * @param proposalId Addressed Proposal identity.
 * @param requestId Decision command identity.
 * @param decision Human decision to submit.
 * @returns Route response.
 */
function submitKnowledgeProposalDecision(
  app: ReturnType<typeof createNanoCoreApp>,
  proposalId: string,
  requestId: string,
  decision: 'accepted' | 'rejected' | 'deferred'
): Promise<Response> {
  return app.request(
    ...knowledgeOperationRequest(
      'knowledge.proposal.decide',
      { workspaceId: 'ws_demo', proposalId: proposalId },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, decision }),
      }
    )
  );
}

/**
 * Submits one bounded Knowledge Proposal reversal through the public route.
 *
 * @param app Test NanoCore app.
 * @param proposalId Addressed Proposal identity.
 * @param input Exact reversal request.
 * @returns Route response.
 */
function submitKnowledgeProposalReversal(
  app: ReturnType<typeof createNanoCoreApp>,
  proposalId: string,
  input: {
    requestId: string;
    reviewId: string;
    knowledgePageId: string;
    expectedContentDigest: string;
  }
): Promise<Response> {
  return app.request(
    ...knowledgeOperationRequest(
      'knowledge.proposal.reverse',
      { workspaceId: 'ws_demo', proposalId: proposalId },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }
    )
  );
}

/**
 * Returns the server-managed export root for one workspace export response.
 *
 * @param dataRoot Data root that owns server-managed exports.
 * @param workspaceId Workspace id used in the public export handle.
 * @param exportId Export id returned by the App API.
 * @returns Absolute export root path.
 */
function workspaceExportRoot(dataRoot: string, workspaceId: string, exportId: string): string {
  return join(dataRoot, 'server', 'exports', 'workspaces', workspaceId, exportId);
}

/**
 * Reads one exported JSON record file.
 *
 * @param root Workspace export root.
 * @param path Export-relative record path.
 * @returns Parsed JSON record.
 */
function readExportJson(root: string, path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
}

/**
 * Reads one exported line-oriented JSON record family.
 *
 * @param root Workspace export root.
 * @param path Export-relative record path.
 * @returns Parsed JSONL records.
 */
function readExportJsonl(root: string, path: string): Array<Record<string, unknown>> {
  const text = readFileSync(join(root, path), 'utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

/**
 * Creates an OpenShell package fixture bound to one stored turn.
 *
 * @param store Store that owns the workspace and turn.
 * @param turnId Turn id to bind to the package.
 * @returns Parsed Agent Environment Package.
 */
function createOpenShellWorkerControlPackage(
  store: FsStore,
  turnId: string
): AgentEnvironmentPackage {
  const turn = store.getTurnById(turnId);

  return AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agentSetup: createTestAgentSetup(),
      agentSessionId: 'as_dashboard_control_1',
      triggerActor: { kind: 'user', id: 'user_local' },
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-06-16T00:00:00.000Z',
      requestId: 'req_dashboard_control_1',
      turn,
      workspaceCwd: '/workspace',
      workspaceRoots: [],
    })
  );
}

class FakeTurnExecutor implements TurnExecutor {
  public readonly capabilities = {
    approvals: false,
    interrupts: true,
    artifacts: false,
    workspaceConfig: true,
    workspaceKnowledgeEditing: true,
    questions: false,
  };
  public readonly eventFamilies = [
    'workspace.updated',
    'thread.created',
    'thread.updated',
    'turn.started',
    'turn.updated',
    'item.created',
    'item.delta',
    'item.completed',
    'agent.session.updated',
    'turn.completed',
    'error',
  ] as const;
  public readonly startContexts: TurnStartRuntimeContext[] = [];
  private readonly continuity = new SimulatedTurnExecutor();

  /**
   * Admits one AgentSession using the current compatibility-key preview.
   *
   * @param store Store inspected for a current Thread AgentSession.
   * @param input Static AEP inputs for the future Turn.
   * @returns Fresh or reusable AgentSession identity and compatibility key.
   */
  public prepareAgentSessionForTurn(
    store: FsStore,
    input: PrepareAgentSessionForTurnInput
  ): Promise<PreparedAgentSessionForTurn> {
    return this.continuity.prepareAgentSessionForTurn(store, input);
  }

  /**
   * Revalidates the admitted AgentSession after scheduler dispatch.
   *
   * @param store Store mutated when a predecessor must close.
   * @param input Prepared decision retained after lease acquisition.
   */
  public commitPreparedAgentSessionForTurn(
    store: FsStore,
    input: CommitPreparedAgentSessionForTurnInput
  ): Promise<void> {
    return this.continuity.commitPreparedAgentSessionForTurn(store, input);
  }

  /**
   * Emits a deterministic completed turn for route-level tests.
   */
  public async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
  ): Promise<void> {
    this.startContexts.push(context);

    const turn = store.getTurnById(turnId);
    if (!turn.agentId) {
      throw new Error('Fake worker turn requires a selected agent id.');
    }
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const requestId = context.requestId ?? null;
    const agentSessionId = context.agentSessionId ?? `session_${turn.threadId}`;
    let existingAgentSession: ReturnType<FsStore['getAgentSession']> | undefined;
    try {
      existingAgentSession = store.getAgentSession(agentSessionId);
    } catch {
      existingAgentSession = undefined;
    }
    const sessionCompatibilityKey =
      context.sessionCompatibilityKey ??
      (context.agentSetup
        ? resolveAgentSessionCompatibilityKey({
            agentSessionId,
            agentSetup: context.agentSetup,
            backend: { kind: 'openshell' },
            requestId,
            turn,
            turnInput: input,
            triggerActor: context.triggerActor ?? turn.triggerActor,
            workspaceCwd: context.workspaceCwd,
            workspaceRoots: context.workspaceRoots,
            ...(context.workspaceDataSourceCatalog
              ? { workspaceDataSourceCatalog: context.workspaceDataSourceCatalog }
              : {}),
            ...(context.workspaceSourceRefs
              ? { workspaceSourceRefs: context.workspaceSourceRefs }
              : {}),
          })
        : undefined);
    const agentSession = existingAgentSession
      ? store.updateAgentSession(existingAgentSession.id, {
          status: 'busy',
          updatedAt: timestamp,
        })
      : store.createAgentSession({
          id: agentSessionId,
          agentId: turn.agentId,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          status: 'busy',
          message: null,
          ...(sessionCompatibilityKey ? { sessionCompatibilityKey } : {}),
          createdAt: timestamp,
          updatedAt: timestamp,
        });
    store.updateTurn(turnId, { agentSessionId: agentSession.id });
    const userItem = store.createItem({
      id: `it_user_${turnId}`,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      type: 'user-message',
      status: 'completed',
      actor: turn.triggerActor,
      text: input,
      createdAt: turn.startedAt ?? new Date().toISOString(),
      completedAt: turn.startedAt ?? new Date().toISOString(),
    });
    const assistantItem = store.createItem({
      id: `it_assistant_${turnId}`,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      type: 'assistant-message',
      status: 'completed',
      text: 'Completed by fake executor.',
      createdAt: turn.startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    store.emitTurnEvent(turnId, {
      event: 'turn.started',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'turn-started', turnId, status: 'running' },
    });
    store.emitTurnEvent(turnId, {
      event: 'item.created',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'item-created', item: userItem },
    });
    store.emitTurnEvent(turnId, {
      event: 'item.completed',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'item-completed', itemId: userItem.id, item: userItem },
    });
    store.emitTurnEvent(turnId, {
      event: 'agent.session.updated',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'agent-session-updated', agentSession },
    });
    store.emitTurnEvent(turnId, {
      event: 'item.created',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'item-created', item: assistantItem },
    });
    store.emitTurnEvent(turnId, {
      event: 'item.completed',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'item-completed', itemId: assistantItem.id, item: assistantItem },
    });
    const completedTurn = store.updateTurn(turnId, {
      status: 'completed',
      completedAt: assistantItem.completedAt,
    });
    store.updateAgentSession(agentSession.id, {
      status: 'idle',
      updatedAt: assistantItem.completedAt ?? timestamp,
    });
    store.emitTurnEvent(turnId, {
      event: 'turn.completed',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'turn-completed', stopReason: 'completed', turn: completedTurn },
    });
  }

  /**
   * Marks a turn interrupted for route-level tests.
   */
  public async interruptTurn(
    store: FsStore,
    turnId: string,
    context: TurnCommandRuntimeContext = { requestId: null }
  ): Promise<void> {
    const turn = store.updateTurn(turnId, {
      status: 'interrupted',
      completedAt: new Date().toISOString(),
    });
    store.emitTurnEvent(turnId, {
      event: 'turn.completed',
      requestId: context.requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'turn-completed', stopReason: 'aborted', turn },
    });
  }
}

class DelayedTurnExecutor extends FakeTurnExecutor {
  public starts = 0;
  private releaseStart: (() => void) | null = null;
  private readonly startGate = new Promise<void>((resolve) => {
    this.releaseStart = resolve;
  });

  /**
   * Releases the blocked fake turn.
   */
  public release(): void {
    this.releaseStart?.();
  }

  /**
   * Waits until the delayed executor has accepted the turn.
   */
  public async waitForStart(): Promise<void> {
    while (this.starts === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /**
   * Delays a turn until the test releases it.
   */
  public override async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
  ): Promise<void> {
    this.starts += 1;
    await this.startGate;
    await super.startTurn(store, turnId, input, context);
  }
}

class ApprovalTurnExecutor extends FakeTurnExecutor {
  public override readonly capabilities = {
    approvals: true,
    interrupts: true,
    artifacts: false,
    workspaceConfig: true,
    workspaceKnowledgeEditing: true,
    questions: false,
  };
  public approvalResponses = 0;

  /**
   * Records one approval response and returns the stored approval.
   */
  public async respondApproval(
    store: FsStore,
    approvalRequestId: string,
    decision: 'granted' | 'denied',
    _context: TurnCommandRuntimeContext = { requestId: null }
  ) {
    this.approvalResponses += 1;
    return store.updateApproval(approvalRequestId, {
      status: decision,
      resolvedAt: new Date().toISOString(),
    });
  }
}

/**
 * JSON request headers used by route tests.
 */
function jsonHeaders(): HeadersInit {
  return { 'content-type': 'application/json' };
}

class BrokenWorkspaceListStore extends FsStore {
  /**
   * Simulates a workspace load failure after route dispatch.
   *
   * @returns Never returns.
   */
  public failReads = false;
  public override getWorkspace(workspaceId: string): ReturnType<FsStore['getWorkspace']> {
    if (this.failReads) throw new Error('Workspace storage failed.');
    return super.getWorkspace(workspaceId);
  }
}

/**
 * Builds a workspace synchronization review item for route-level export/import tests.
 *
 * @returns Schema-valid workspace sync review item.
 */
function workspaceSyncReviewRouteItem(): Parameters<typeof recordWorkspaceSyncReview>[1]['item'] {
  const patchText = 'diff --git a/docs/sync.md b/docs/sync.md\n';
  const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;

  return {
    artifactId: 'ar_workspace_review_route',
    changeSet: {
      artifactIds: ['ar_workspace_review_route'],
      base: { commit: 'abc123', contentDigest: null },
      bundle: null,
      changedPaths: [{ binary: false, path: 'docs/sync.md', status: 'modified' }],
      createdAt: '2026-07-06T00:00:00.000Z',
      evidenceRefs: [{ kind: 'worker', ref: 'turn_route_1' }],
      head: { commit: 'def456', contentDigest: null },
      id: 'wcs_route_1',
      inputSnapshotId: 'wis_route_1',
      materializationRecordId: 'wmr_route_1',
      patch: {
        bytes: Buffer.byteLength(patchText, 'utf8'),
        digest: patchDigest,
        ref: 'artifact://route-patch',
      },
      redaction: { notes: [], status: 'redacted' },
      resourceId: 'repo_default',
      strategy: 'git',
      workspaceId: 'ws_demo',
    },
    patchPayload: {
      bytes: Buffer.byteLength(patchText, 'utf8'),
      digest: patchDigest,
      mediaType: 'text/x-diff',
      text: patchText,
    },
    review: {
      actionCenterRowId: 'workspace-review:swr_route_1',
      changeSetId: 'wcs_route_1',
      createdAt: '2026-07-06T00:00:00.000Z',
      diffSummary: { additions: 1, deletions: 0, filesChanged: 1 },
      id: 'swr_route_1',
      riskSummary: '1 changed path staged for route import coverage.',
      staging: {
        branch: null,
        ref: 'staging://workspace/wcs_route_1',
        strategy: 'git_worktree',
      },
      status: 'pending',
      updatedAt: '2026-07-06T00:00:00.000Z',
      validation: [],
      workspaceId: 'ws_demo',
    },
  };
}

describe('nanocore server', () => {
  it('lists seeded workspaces', async () => {
    const canonicalStore = createDemoStore();
    const canonicalApp = createApp(
      { ...{ turnExecutor: new FakeTurnExecutor() }, store: canonicalStore },
      true
    );
    const res = await canonicalApp.request('/api/app/operations/workspace.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
  });

  it('returns protocol JSON when workspace listing fails', async () => {
    const broken = new BrokenWorkspaceListStore();
    const canonicalApp = createApp(
      {
        store: broken,
        turnExecutor: new FakeTurnExecutor(),
      },
      true
    );
    broken.failReads = true;
    const res = await canonicalApp.request('/api/app/operations/workspace.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    await expect(res.json()).resolves.toMatchObject({
      code: 'workspace_sharing_failed',
      message: 'Workspace storage failed.',
    });
  });

  it('rejects product work when boot readiness closes product admission', async () => {
    const canonicalStore = createDemoStore();
    const app = createApp({
      ...{
        bootReadiness: computeBootReadinessSnapshot({
          bootId: 'boot_failed',
          subsystems: {
            storage: {
              state: 'failed',
              reasons: [
                {
                  code: 'storage.failed',
                  message: 'Storage is unavailable.',
                  blocks: ['product_work'],
                },
              ],
            },
          },
        }),
        turnExecutor: new FakeTurnExecutor(),
      },
      store: canonicalStore,
    });
    const canonicalApp = createApp(
      {
        ...{
          bootReadiness: computeBootReadinessSnapshot({
            bootId: 'boot_failed',
            subsystems: {
              storage: {
                state: 'failed',
                reasons: [
                  {
                    code: 'storage.failed',
                    message: 'Storage is unavailable.',
                    blocks: ['product_work'],
                  },
                ],
              },
            },
          }),
          turnExecutor: new FakeTurnExecutor(),
        },
        store: canonicalStore,
      },
      true
    );

    const diagnostics = await app.request('/api/app/diagnostics');
    const read = await canonicalApp.request('/api/app/operations/workspace.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const write = await app.request(
      ...operationRequest(
        'workspace.create',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Blocked Workspace' }),
        }
      )
    );
    const gateway = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ content: 'Hello', role: 'user' }], model: 'gpt-test' }),
    });
    const responses = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Hello', model: 'gpt-test' }),
    });
    const quickChat = await app.request(
      ...operationRequest(
        'chat.quick',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: 'Hello' }),
        }
      )
    );
    const turn = await app.request(
      ...operationRequest(
        'turn.start',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: 'Hello',
            threadId: 'th_blocked',
            workspaceId: 'ws_blocked',
          }),
        }
      )
    );

    const threadCount = canonicalStore.listThreads('ws_demo').length;
    const requestId = 'd366ec14-5110-43ab-b086-94a768a3d1d6';
    const createThread = await canonicalApp.request('/api/app/operations/thread.create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': requestId },
      body: JSON.stringify({ workspaceId: 'ws_demo', name: 'Blocked Thread', requestId }),
    });
    expect(createThread.status).toBe(503);
    await expect(createThread.json()).resolves.toMatchObject({ code: 'product_work_unavailable' });
    expect(canonicalStore.listThreads('ws_demo')).toHaveLength(threadCount);
    const createRecord = await canonicalApp.request('/api/app/operations/kernel.records.create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': requestId },
      body: JSON.stringify({ workspaceId: 'ws_demo', requestId }),
    });
    expect(createRecord.status).toBe(503);
    await expect(createRecord.json()).resolves.toMatchObject({ code: 'product_work_unavailable' });

    expect(diagnostics.status).toBe(200);
    expect(read.status).toBe(200);
    expect(write.status).toBe(503);
    await expect(write.json()).resolves.toMatchObject({
      code: 'product_work_unavailable',
    });
    expect(gateway.status).toBe(503);
    await expect(gateway.json()).resolves.toMatchObject({
      code: 'product_work_unavailable',
    });
    expect(responses.status).toBe(503);
    await expect(responses.json()).resolves.toMatchObject({
      code: 'product_work_unavailable',
    });
    expect(quickChat.status).toBe(503);
    await expect(quickChat.json()).resolves.toMatchObject({
      code: 'product_work_unavailable',
    });
    expect(turn.status).toBe(503);
    await expect(turn.json()).resolves.toMatchObject({
      code: 'product_work_unavailable',
    });
  });

  it('uses the latest boot readiness for product admission and diagnostics', async () => {
    let bootReadiness = computeBootReadinessSnapshot({ bootId: 'boot_dynamic' });
    const canonicalStore = createDemoStore();
    const app = createApp(
      {
        store: canonicalStore,
        getBootReadiness: () => bootReadiness,
        turnExecutor: new FakeTurnExecutor(),
      },
      true
    );

    bootReadiness = createShutdownReadinessSnapshot(bootReadiness);

    const read = await app.request('/api/app/operations/workspace.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(read.status).toBe(200);

    const diagnostics = await app.request('/api/app/diagnostics');
    const write = await app.request(
      ...operationRequest(
        'workspace.create',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Blocked Workspace' }),
        }
      )
    );

    const threadCount = canonicalStore.listThreads('ws_demo').length;
    const requestId = 'd366ec14-5110-43ab-b086-94a768a3d1d6';
    const createThread = await app.request('/api/app/operations/thread.create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': requestId },
      body: JSON.stringify({ workspaceId: 'ws_demo', name: 'Blocked Thread', requestId }),
    });
    expect(createThread.status).toBe(503);
    await expect(createThread.json()).resolves.toMatchObject({ code: 'product_work_unavailable' });
    expect(canonicalStore.listThreads('ws_demo')).toHaveLength(threadCount);
    const createRecord = await app.request('/api/app/operations/kernel.records.create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': requestId },
      body: JSON.stringify({ workspaceId: 'ws_demo', requestId }),
    });
    expect(createRecord.status).toBe(503);
    await expect(createRecord.json()).resolves.toMatchObject({ code: 'product_work_unavailable' });

    expect(diagnostics.status).toBe(200);
    await expect(diagnostics.json()).resolves.toMatchObject({
      boot: {
        acceptingProductWork: false,
        subsystems: {
          scheduler: {
            reasons: [expect.objectContaining({ code: 'shutdown.in_progress' })],
          },
        },
      },
    });
    expect(write.status).toBe(503);
    await expect(write.json()).resolves.toMatchObject({
      code: 'product_work_unavailable',
    });
  });

  it('exposes the storage layout report through the App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-storage-report-route-'));
    mkdirSync(join(dataRoot, 'server', 'quarantine'), { recursive: true });
    writeFileSync(join(dataRoot, 'server', 'quarantine', '1-core.sqlite'), 'demo');
    const app = createApp({ dataRoot });

    const res = await app.request(...operationRequest('storage.layout-report', {}));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      dataRoot,
      serverDb: {
        path: 'server/db/core.sqlite',
        exists: false,
        appliedMigrations: [],
      },
      quarantineEntries: [
        {
          scope: 'server',
          path: 'server/quarantine/1-core.sqlite',
          bytes: 4,
        },
      ],
    });
  });

  it('creates and verifies data-root hot backups through server-managed handles', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-backup-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    coreDb.sqlite.close();
    const app = createApp({ dataRoot });

    const createRes = await app.request(
      ...operationRequest('backup.create', {}, { method: 'POST' })
    );

    expect(createRes.status).toBe(200);
    const created = DataRootBackupCreateResponseSchema.parse(await createRes.json());
    expect(created).toMatchObject({
      manifest: {
        recordType: 'data-root-backup',
        backupMode: 'hot',
        consistency: 'crash-consistent',
      },
    });
    expect(created.checkedFiles).toContain('server/db/core.sqlite');
    expect(JSON.stringify(created)).not.toContain(dataRoot);

    const verifyRes = await app.request(
      ...operationRequest(
        'backup.verify',
        { backupId: created.backupId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ backupId: created.backupId }),
        }
      )
    );

    expect(verifyRes.status).toBe(200);
    const verified = DataRootBackupVerifyResponseSchema.parse(await verifyRes.json());
    expect(verified).toMatchObject({ backupId: created.backupId, fileCount: created.fileCount });
    expect(JSON.stringify(verified)).not.toContain(dataRoot);
  });

  it('exports one workspace through the App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-route-'));
    const store = createDemoStore({ dataRoot });
    store.createThread('ws_demo', 'Export route thread');
    store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Export route knowledge',
      content: 'Export this note.',
    });
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const app = createApp({ coreDb, dataRoot, store });

    const res = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );

    expect(res.status).toBe(200);
    const body = WorkspaceExportResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      workspaceId: 'ws_demo',
      fileCount: 24,
      checkedFiles: [
        'records/agent-resource-catalog.json',
        'records/agent-sessions.jsonl',
        'records/artifact-reviews.jsonl',
        'records/goal-state.json',
        'records/item-revisions.jsonl',
        'records/knowledge-claims.jsonl',
        'records/knowledge-conflicts.jsonl',
        'records/knowledge-observations.jsonl',
        'records/knowledge-retrieval-traces.jsonl',
        'records/knowledge.jsonl',
        'records/thread-material-bindings.jsonl',
        'records/threads.jsonl',
        'records/turn-events.jsonl',
        'records/turns.jsonl',
        'records/vault-injection-plans.jsonl',
        'records/vault-injection-receipts.jsonl',
        'records/workspace-material-revisions.jsonl',
        'records/workspace-materials.jsonl',
        'records/workspace-record.json',
        'workspace-files/config/workspace.jsonc',
        'workspace-files/knowledge/pages/index.md',
        'workspace-files/knowledge/pages/mem_2.md',
        'workspace-files/knowledge/pages/mem_project.md',
        'workspace-files/knowledge/schema/workspace-schema.yaml',
      ],
      manifest: {
        recordType: 'workspace-export',
        workspaceId: 'ws_demo',
        exportFormatVersion: 2,
      },
    });
    const exportRoot = workspaceExportRoot(dataRoot, 'ws_demo', body.exportId);
    expect([
      readFileSync(join(exportRoot, 'records/vault-injection-plans.jsonl'), 'utf8'),
      readFileSync(join(exportRoot, 'records/vault-injection-receipts.jsonl'), 'utf8'),
    ]).toEqual(['', '']);
    expect(JSON.stringify(body)).not.toContain(dataRoot);
    coreDb.sqlite.close();
  });

  it('dry-runs workspace import through the App API without creating a workspace', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-dry-run-route-'));
    const store = createDemoStore({ dataRoot });
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const app = createApp({ coreDb, dataRoot, store });
    const beforeCount = store.listWorkspaces().length;
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    const dryRunRes = await app.request(
      ...operationRequest(
        'workspace.import-dry-run',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sourceWorkspaceId: 'ws_demo', exportId: exported.exportId }),
        }
      )
    );

    expect(dryRunRes.status).toBe(200);
    const body = WorkspaceImportDryRunResponseSchema.parse(await dryRunRes.json());
    expect(body).toMatchObject({
      mode: 'dry-run',
      exportId: exported.exportId,
      sourceWorkspaceId: 'ws_demo',
      exportedWorkspaceId: 'ws_demo',
      collision: { status: 'collides', workspaceId: 'ws_demo' },
      verification: { fileCount: 23 },
    });
    expect(store.listWorkspaces()).toHaveLength(beforeCount);
    expect(JSON.stringify(body)).not.toContain(dataRoot);
    coreDb.sqlite.close();
  });

  it('imports one workspace through the App API with collision reminting', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    store.createThread('ws_demo', 'Import source thread');
    store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Import source knowledge',
      content: 'Import this knowledge.',
    });
    const app = createApp({ coreDb, dataRoot, store });
    const sourceDeploymentId = readDataRootLayoutMarker(dataRoot).deploymentId;
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d701',
          }),
        }
      )
    );

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    expect(body).toMatchObject({
      mode: 'imported',
      requestId: '00000000-0000-4000-8000-00000000d701',
      sourceWorkspaceId: 'ws_demo',
      exportedWorkspaceId: 'ws_demo',
      importedWorkspaceId: 'ws_imported_ws_demo',
      collision: { status: 'collides', workspaceId: 'ws_demo' },
      workspace: {
        id: 'ws_imported_ws_demo',
        counts: { threadCount: 2, knowledgeEntryCount: 2 },
        importedFrom: {
          sourceDeploymentId,
          sourceWorkspaceId: 'ws_demo',
          exportCreatedAt: exported.manifest.exportCreatedAt,
        },
      },
    });
    expect(body.workspace.importedFrom?.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(store.getWorkspace('ws_imported_ws_demo').name).toBe('Demo Workspace');
    expect(store.getWorkspace('ws_imported_ws_demo').importedFrom?.sourceWorkspaceId).toBe(
      'ws_demo'
    );
    expect(store.listThreads('ws_imported_ws_demo')).toHaveLength(2);
    expect(store.listKnowledge('ws_imported_ws_demo').map((entry) => entry.title)).toContain(
      'Import source knowledge'
    );
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT user_id, status
           FROM workspace_members
           WHERE workspace_id = ?`
        )
        .get(body.importedWorkspaceId)
    ).toEqual({ status: 'active', user_id: 'user_local' });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_imported_ws_demo');
    try {
      const audit = workspaceDb.sqlite
        .prepare('SELECT * FROM audit_events WHERE action = ?')
        .get('workspace.import') as Record<string, unknown> | undefined;
      expect(audit).toMatchObject({
        workspace_id: 'ws_imported_ws_demo',
        request_id: '00000000-0000-4000-8000-00000000d701',
        category: 'system',
        resource: 'workspace:ws_imported_ws_demo',
        outcome: 'succeeded',
        severity: 'info',
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
    expect(JSON.stringify(body)).not.toContain(dataRoot);
  });

  it('exports and imports workspace audit events as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-audit-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      recordWorkspaceAuditEvent({
        workspaceDb: sourceDb,
        auditEventId: 'aud_workspace_source_event',
        workspaceId: 'ws_demo',
        requestId: '00000000-0000-4000-8000-00000000d721',
        category: 'system',
        action: 'workspace.source_event',
        resource: 'workspace:ws_demo',
        outcome: 'succeeded',
        severity: 'info',
        summary: 'Source workspace event.',
        now: new Date('2026-07-06T00:00:00.000Z'),
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/audit-events.jsonl');

    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d722',
          }),
        }
      )
    );

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      const auditRows = importedDb.sqlite
        .prepare(
          'SELECT audit_event_id, workspace_id, request_id, action, resource FROM audit_events ORDER BY action DESC'
        )
        .all() as Array<Record<string, unknown>>;

      expect(auditRows).toHaveLength(3);
      expect(auditRows).toEqual(
        expect.arrayContaining([
          {
            audit_event_id: 'aud_workspace_source_event',
            workspace_id: body.importedWorkspaceId,
            request_id: '00000000-0000-4000-8000-00000000d721',
            action: 'workspace.source_event',
            resource: `workspace:${body.importedWorkspaceId}`,
          },
          expect.objectContaining({
            workspace_id: body.importedWorkspaceId,
            request_id: '00000000-0000-4000-8000-00000000d722',
            action: 'workspace.import',
            resource: `workspace:${body.importedWorkspaceId}`,
          }),
          expect.objectContaining({
            workspace_id: body.importedWorkspaceId,
            request_id: '00000000-0000-4000-8000-00000000d722',
            action: 'capability.finish',
            resource: 'capability:storage.workspace_import',
          }),
        ])
      );
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('uses the data-root deployment id for workspace export lineage', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    recordDataRootDeploymentMove(dataRoot, 'dep_moved');
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const exportRes = await app.request(
        ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
      );

      expect(exportRes.status).toBe(200);
      const body = WorkspaceExportResponseSchema.parse(await exportRes.json());
      expect(body.manifest.sourceDeploymentId).toBe('dep_moved');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records storage usage when a workspace export is written', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-storage-usage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const exportRes = await app.request(
        ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
      );
      const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());
      const usageRes = await app.request('/api/app/workspaces/ws_demo/capability-usage');

      expect(usageRes.status, await usageRes.clone().text()).toBe(200);
      const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
      expect(usage.capabilityCalls).toEqual([
        expect.objectContaining({
          capabilityId: 'storage.workspace_export',
          family: 'storage',
          operation: 'workspace.export.write',
          providerRef: 'nanocore-storage',
          serviceRef: 'workspace-export',
          status: 'succeeded',
          workspaceId: 'ws_demo',
        }),
      ]);
      expect(usage.usageRecords).toHaveLength(2);
      expect(usage.usageRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'storage',
            providerRef: 'nanocore-storage',
            quantity: exported.fileCount,
            source: 'workspace-export-inventory',
            unit: 'files',
            workspaceId: 'ws_demo',
          }),
          expect.objectContaining({
            category: 'storage',
            providerRef: 'nanocore-storage',
            quantity: exported.totalBytes,
            source: 'workspace-export-inventory',
            unit: 'bytes',
            workspaceId: 'ws_demo',
          }),
        ])
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records storage usage when a workspace import is written', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-storage-usage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const exportRes = await app.request(
        ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
      );
      const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());
      const importRes = await app.request(
        ...operationRequest(
          'workspace.import',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sourceWorkspaceId: 'ws_demo',
              exportId: exported.exportId,
              requestId: '00000000-0000-4000-8000-00000000d733',
            }),
          }
        )
      );

      expect(importRes.status, await importRes.clone().text()).toBe(200);
      const imported = WorkspaceImportResponseSchema.parse(await importRes.json());
      const usageRes = await app.request(
        `/api/app/workspaces/${imported.importedWorkspaceId}/capability-usage`
      );

      expect(usageRes.status, await usageRes.clone().text()).toBe(200);
      const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
      expect(usage.capabilityCalls).toEqual([
        expect.objectContaining({
          capabilityId: 'storage.workspace_import',
          family: 'storage',
          operation: 'workspace.import.write',
          providerRef: 'nanocore-storage',
          serviceRef: 'workspace-import',
          status: 'succeeded',
          workspaceId: imported.importedWorkspaceId,
        }),
      ]);
      expect(usage.usageRecords).toHaveLength(2);
      expect(usage.usageRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'storage',
            providerRef: 'nanocore-storage',
            quantity: imported.verification.fileCount,
            source: 'workspace-import-inventory',
            unit: 'files',
            workspaceId: imported.importedWorkspaceId,
          }),
          expect.objectContaining({
            category: 'storage',
            providerRef: 'nanocore-storage',
            quantity: imported.verification.totalBytes,
            source: 'workspace-import-inventory',
            unit: 'bytes',
            workspaceId: imported.importedWorkspaceId,
          }),
        ])
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('exports and imports capability usage ledger rows as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-usage-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    let callId = '';
    try {
      const call = startCapabilityCall({
        authorityActor: { kind: 'user', id: LOCAL_USER_ID },
        workspaceDb: sourceDb,
        callId: 'cap_workspace_source_call',
        workspaceId: 'ws_demo',
        requestId: '00000000-0000-4000-8000-00000000d731',
        family: 'llm',
        operation: 'quick_chat',
        capabilityId: 'inference.local.quick_chat',
        redactionClass: 'metadata',
        summary: 'Source capability call.',
        providerRef: 'provider:test',
        now: new Date('2026-07-06T00:00:00.000Z'),
      });
      callId = call.id;
      recordUsage({
        workspaceDb: sourceDb,
        call,
        records: [
          {
            usageId: 'use_workspace_source_usage',
            category: 'llm',
            unit: 'tokens',
            quantity: 42,
            modelId: 'model_test',
            providerRef: 'provider:test',
            source: 'unit-test',
          },
        ],
        now: new Date('2026-07-06T00:00:01.000Z'),
      });
      finishCapabilityCall({
        workspaceDb: sourceDb,
        callId,
        status: 'succeeded',
        now: new Date('2026-07-06T00:00:02.000Z'),
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/capability-calls.jsonl');
    expect(exported.checkedFiles).toContain('records/usage-records.jsonl');

    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d732',
          }),
        }
      )
    );

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      const callRow = importedDb.sqlite
        .prepare(
          'SELECT call_id, workspace_id, capability_id, status, provider_ref FROM capability_calls WHERE call_id = ?'
        )
        .get(callId) as Record<string, unknown> | undefined;
      const usageRow = importedDb.sqlite
        .prepare(
          'SELECT usage_id, workspace_id, capability_call_id, category, unit, quantity FROM usage_records WHERE usage_id = ?'
        )
        .get('use_workspace_source_usage') as Record<string, unknown> | undefined;

      expect(callRow).toEqual({
        call_id: callId,
        workspace_id: body.importedWorkspaceId,
        capability_id: 'inference.local.quick_chat',
        status: 'succeeded',
        provider_ref: 'provider:test',
      });
      expect(usageRow).toEqual({
        usage_id: 'use_workspace_source_usage',
        workspace_id: body.importedWorkspaceId,
        capability_call_id: callId,
        category: 'llm',
        unit: 'tokens',
        quantity: 42,
      });
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('exports and imports knowledge source records as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-knowledge-state-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    store.createKnowledgeSource(
      {
        id: 'ks_source_1',
        workspaceId: 'ws_demo',
        kind: 'document',
        title: 'Deployment note',
        uri: 'workspace://ws_demo/docs/deployment.md',
        contentDigest: 'sha256:deployment-note',
        originatingThreadId: null,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt: '2026-07-06T00:00:02.000Z',
        createdAt: '2026-07-06T00:00:02.000Z',
        updatedAt: '2026-07-06T00:00:02.000Z',
      },
      'Deployment note source material.'
    );
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/knowledge-sources.jsonl');
    expect(exported.checkedFiles).toContain('sources/materials/ks_source_1/content.txt');
    expect(exported.checkedFiles).toContain('sources/derived/ks_source_1/text.json');

    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d736',
          }),
        }
      )
    );

    expect(importRes.status).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    expect(store.listKnowledgeSources(body.importedWorkspaceId)).toEqual([
      expect.objectContaining({
        id: 'ks_imported_ws_imported_ws_demo_1',
        workspaceId: body.importedWorkspaceId,
        kind: 'document',
        contentDigest: 'sha256:deployment-note',
      }),
    ]);
    expect(
      store.readKnowledgeSourceMaterial(
        body.importedWorkspaceId,
        'ks_imported_ws_imported_ws_demo_1'
      )
    ).toBe('Deployment note source material.');
    expect(
      store.listKnowledgeSourceDerivedRepresentations(
        body.importedWorkspaceId,
        'ks_imported_ws_imported_ws_demo_1'
      )
    ).toEqual([
      expect.objectContaining({
        sourceId: 'ks_imported_ws_imported_ws_demo_1',
        kind: 'text',
        materialPath: 'sources/materials/ks_imported_ws_imported_ws_demo_1/content.txt',
      }),
    ]);
    expect(store.getKnowledgeSource('ws_demo', 'ks_source_1').workspaceId).toBe('ws_demo');
    expect(JSON.stringify(exported)).not.toContain(dataRoot);
    coreDb.sqlite.close();
  });

  it('round-trips representative workspace records through export import export', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-round-trip-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    store.createThread('ws_demo', 'Round trip thread');
    store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Round trip knowledge',
      content: 'Keep this entry through import.',
    });
    store.createKnowledgeSource({
      id: 'ks_round_trip_1',
      workspaceId: 'ws_demo',
      kind: 'document',
      title: 'Round trip source',
      uri: 'workspace://ws_demo/docs/round-trip.md',
      contentDigest: 'sha256:round-trip-source',
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: '2026-07-06T00:00:02.000Z',
      createdAt: '2026-07-06T00:00:02.000Z',
      updatedAt: '2026-07-06T00:00:02.000Z',
    });
    const sourceReference = createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file:round-trip-source',
      displayName: 'Round trip provider key',
      ownerScope: 'workspace',
      referenceId: 'vault_round_trip_provider',
      secretKind: 'provider-api-key',
      workspaceId: 'ws_demo',
      now: () => '2026-07-06T00:00:03.000Z',
    });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      recordWorkspaceAuditEvent({
        workspaceDb: sourceDb,
        auditEventId: 'aud_round_trip_source',
        workspaceId: 'ws_demo',
        requestId: '00000000-0000-4000-8000-00000000d746',
        category: 'system',
        action: 'workspace.round_trip_source',
        resource: 'workspace:ws_demo',
        outcome: 'succeeded',
        severity: 'info',
        summary: 'Round-trip source event.',
        now: new Date('2026-07-06T00:00:04.000Z'),
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });

    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());
    const sourceRoot = workspaceExportRoot(dataRoot, 'ws_demo', exported.exportId);
    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d747',
          }),
        }
      )
    );
    const importPayload = await importRes.json();
    expect(importRes.status, JSON.stringify(importPayload)).toBe(200);
    const imported = WorkspaceImportResponseSchema.parse(importPayload);
    const reExportRes = await app.request(
      ...operationRequest(
        'workspace.export',
        { workspaceId: imported.importedWorkspaceId },
        { method: 'POST' }
      )
    );
    const reExported = WorkspaceExportResponseSchema.parse(await reExportRes.json());
    const reExportRoot = workspaceExportRoot(
      dataRoot,
      imported.importedWorkspaceId,
      reExported.exportId
    );

    expect(reExported.checkedFiles).toEqual(expect.arrayContaining(exported.checkedFiles));
    expect(readExportJson(sourceRoot, 'records/workspace-record.json')).not.toHaveProperty(
      'counts'
    );
    expect(readExportJson(reExportRoot, 'records/workspace-record.json')).not.toHaveProperty(
      'counts'
    );
    expect(
      readExportJsonl(reExportRoot, 'records/threads.jsonl').map((thread) => thread.name)
    ).toEqual(readExportJsonl(sourceRoot, 'records/threads.jsonl').map((thread) => thread.name));
    expect(
      readExportJsonl(reExportRoot, 'records/knowledge.jsonl').map((entry) => entry.title)
    ).toEqual(readExportJsonl(sourceRoot, 'records/knowledge.jsonl').map((entry) => entry.title));
    expect(readExportJsonl(reExportRoot, 'records/knowledge-sources.jsonl')).toEqual([
      expect.objectContaining({
        contentDigest: 'sha256:round-trip-source',
        uri: `workspace://${imported.importedWorkspaceId}/docs/round-trip.md`,
        workspaceId: imported.importedWorkspaceId,
      }),
    ]);
    expect(readExportJsonl(reExportRoot, 'records/audit-events.jsonl')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'workspace.round_trip_source',
          requestId: '00000000-0000-4000-8000-00000000d746',
          workspaceId: imported.importedWorkspaceId,
        }),
      ])
    );
    expect(readExportJsonl(reExportRoot, 'records/vault-references.jsonl')).toEqual([
      expect.objectContaining({
        backendKind: sourceReference.backendKind,
        displayName: sourceReference.displayName,
        secretKind: sourceReference.secretKind,
      }),
    ]);
    expect(readExportJsonl(reExportRoot, 'records/vault-references.jsonl')[0]).not.toMatchObject({
      sourceReferenceId: sourceReference.referenceId,
    });
    expect(JSON.stringify(reExported)).not.toContain(dataRoot);
    coreDb.sqlite.close();
  });

  it('rejects workspace imports containing os-keychain vault references', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-vault-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceReference = createVaultReference(coreDb, {
      backendKind: 'os-keychain' as never,
      backendLocator: 'os-keychain:redacted-source',
      displayName: 'Workspace provider key',
      ownerScope: 'workspace',
      referenceId: 'vault_ws_demo_provider',
      secretKind: 'provider-api-key',
      workspaceId: 'ws_demo',
      now: () => '2026-07-06T00:00:00.000Z',
    });
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/vault-references.jsonl');

    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d711',
          }),
        }
      )
    );

    expect(importRes.status, await importRes.clone().text()).toBe(400);
    expect(
      listVaultReferences(coreDb).filter(
        (reference) => reference.workspaceId === 'ws_imported_ws_demo'
      )
    ).toEqual([]);
    expect(getVaultReference(coreDb, sourceReference.referenceId)).toEqual(sourceReference);
    coreDb.sqlite.close();
  });

  it('rolls back the published workspace and Core rows when Core import fails', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-core-rollback-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    for (const suffix of ['1', '2']) {
      createVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        backendLocator: `encrypted-file://source-${suffix}`,
        displayName: `Workspace provider key ${suffix}`,
        ownerScope: 'workspace',
        referenceId: `vault_ws_demo_${suffix}`,
        secretKind: 'provider-api-key',
        workspaceId: 'ws_demo',
        now: () => `2026-07-06T00:00:0${suffix}.000Z`,
      });
    }
    const targetWorkspaceId = 'ws_imported_ws_demo';
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://conflict',
      displayName: 'Conflicting server reference',
      ownerScope: 'server',
      referenceId: `vault_imported_${targetWorkspaceId}_2`,
      secretKind: 'provider-api-key',
      now: () => '2026-07-06T00:00:03.000Z',
    });
    const coreRowCounts = coreDb.sqlite.prepare(`SELECT
      (SELECT COUNT(*) FROM vault_references) AS vaultReferences,
      (SELECT COUNT(*) FROM vault_grants) AS vaultGrants,
      (SELECT COUNT(*) FROM vault_injection_plans) AS injectionPlans,
      (SELECT COUNT(*) FROM vault_injection_receipts) AS injectionReceipts`);
    const beforeCoreRows = coreRowCounts.get();
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d712',
          }),
        }
      )
    );

    expect(importRes.status, await importRes.clone().text()).toBe(400);
    expect({
      coreRows: coreRowCounts.get(),
      finalWorkspaceRootExists: existsSync(join(dataRoot, 'workspaces', targetWorkspaceId)),
      storeHasWorkspace: store
        .listWorkspaces()
        .some((workspace) => workspace.id === targetWorkspaceId),
    }).toEqual({
      coreRows: beforeCoreRows,
      finalWorkspaceRootExists: false,
      storeHasWorkspace: false,
    });
    coreDb.sqlite.close();
  });

  it('exports and imports workspace vault use records as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-vault-use-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://redacted-source',
      displayName: 'Workspace GitHub token',
      ownerScope: 'workspace',
      referenceId: 'vault_ws_demo_github',
      secretKind: 'github-token',
      workspaceId: 'ws_demo',
      now: () => '2026-07-06T00:00:00.000Z',
    });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      createVaultUseRecord(sourceDb, {
        useId: 'vuse_ws_demo_1',
        ownerScope: 'workspace',
        workspaceId: 'ws_demo',
        vaultReferenceId: 'vault_ws_demo_github',
        materialVersion: 3,
        backendKind: 'encrypted-file',
        resolvingPath: 'provider',
        capabilityCallId: 'cap_vault_1',
        outcome: 'succeeded',
        auditEventId: 'audit_vault_1',
        usedAt: '2026-07-06T00:10:00.000Z',
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/vault-use-records.jsonl');

    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d842',
          }),
        }
      )
    );

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedReferences = listVaultReferences(coreDb).filter(
      (reference) => reference.workspaceId === body.importedWorkspaceId
    );
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      expect(listVaultUseRecords(importedDb)).toEqual([
        expect.objectContaining({
          useId: 'vuse_ws_demo_1',
          ownerScope: 'workspace',
          workspaceId: body.importedWorkspaceId,
          vaultReferenceId: importedReferences[0]?.referenceId,
          materialVersion: 3,
          backendKind: 'encrypted-file',
          resolvingPath: 'provider',
          grantId: null,
          receiptId: null,
          outcome: 'succeeded',
          auditEventId: 'audit_vault_1',
        }),
      ]);
      expect(JSON.stringify(listVaultUseRecords(importedDb))).not.toContain('redacted-source');
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('exports and imports workspace vault grants as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-vault-grant-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceReference = createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://redacted-source',
      displayName: 'Workspace GitHub token',
      ownerScope: 'workspace',
      referenceId: 'vault_ws_demo_github',
      secretKind: 'github-token',
      workspaceId: 'ws_demo',
      now: () => '2026-07-06T00:00:00.000Z',
    });
    createVaultGrant(coreDb, {
      grantId: 'grant_ws_demo_github',
      vaultReferenceId: sourceReference.referenceId,
      ownerScope: 'workspace',
      workspaceId: 'ws_demo',
      subjectSummary: 'GitHub MCP read access',
      targetAgentId: 'assistant',
      targetCapabilityId: 'mcp.github.call_tool',
      allowedInjectionPaths: ['backend-provider'],
      lifetime: 'workspace',
      policyDecisionId: 'pd_grant_1',
      expiresAt: '2026-07-07T00:00:00.000Z',
      now: () => '2026-07-06T00:11:00.000Z',
    });
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/vault-grants.jsonl');

    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d852',
          }),
        }
      )
    );

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedReference = listVaultReferences(coreDb).find(
      (reference) => reference.workspaceId === body.importedWorkspaceId
    );
    const importedGrants = listVaultGrants(coreDb).filter(
      (grant) => grant.workspaceId === body.importedWorkspaceId
    );

    expect(importedGrants).toEqual([
      expect.objectContaining({
        grantId: `grant_imported_${body.importedWorkspaceId}_1`,
        vaultReferenceId: importedReference?.referenceId,
        ownerScope: 'workspace',
        workspaceId: body.importedWorkspaceId,
        subjectSummary: 'GitHub MCP read access',
        allowedInjectionPaths: ['backend-provider'],
        lifetime: 'workspace',
        status: 'active',
        policyDecisionId: 'pd_grant_1',
        approvalId: null,
        expiresAt: '2026-07-07T00:00:00.000Z',
      }),
    ]);
    expect(importedGrants[0]?.grantId).not.toBe('grant_ws_demo_github');
    expect(importedGrants[0]?.vaultReferenceId).not.toBe(sourceReference.referenceId);
    expect(JSON.stringify(importedGrants)).not.toContain('redacted-source');

    if (!importedReference || !importedGrants[0]) {
      throw new Error('Imported Vault authority fixture is incomplete.');
    }
    expect(
      rebindWorkspaceVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        backendLocator: 'encrypted-file://target/rebound',
        currentVersion: 1,
        referenceId: importedReference.referenceId,
        workspaceId: body.importedWorkspaceId,
      })
    ).toMatchObject({ status: 'active', currentVersion: 1 });
    expect(() =>
      createVaultInjectionPlan(coreDb, {
        backendCapabilityRequirement: 'encrypted-file:resolve',
        expirationBehavior: 'grant-lifetime',
        grantId: importedGrants[0].grantId,
        injectionVisibility: 'gateway-only',
        planId: 'plan_rebound_imported_grant',
        redactionRule: 'status-only',
        revocationBehavior: 'deny-new-use',
      })
    ).toThrow('Vault grant is portable-import history and cannot authorize effects.');
    expect(listVaultGrants(coreDb)).toContainEqual(
      expect.objectContaining({
        grantId: importedGrants[0].grantId,
        policyDecisionId: 'pd_grant_1',
        status: 'active',
      })
    );
    coreDb.sqlite.close();
  });

  it('exports and imports workspace injection plans as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-injection-plan-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceReference = createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://redacted-source',
      displayName: 'Workspace Codex auth',
      ownerScope: 'workspace',
      referenceId: 'vault_ws_demo_codex_auth',
      secretKind: 'codex-auth-json',
      workspaceId: 'ws_demo',
      now: () => '2026-07-06T00:00:00.000Z',
    });
    createVaultGrant(coreDb, {
      grantId: 'grant_ws_demo_codex_auth',
      vaultReferenceId: sourceReference.referenceId,
      ownerScope: 'workspace',
      workspaceId: 'ws_demo',
      subjectSummary: 'Codex auth runtime file',
      allowedInjectionPaths: ['runtime-file'],
      lifetime: 'agent-session',
      policyDecisionId: 'pd_plan_1',
      now: () => '2026-07-06T00:12:00.000Z',
    });
    createVaultInjectionPlan(coreDb, {
      planId: 'plan_ws_demo_codex_auth',
      grantId: 'grant_ws_demo_codex_auth',
      capabilityId: 'runtime.codex_auth',
      injectionVisibility: 'runtime-file',
      targetPath: '/sandbox/.codex/auth.json',
      expirationBehavior: 'expire-with-agent-session',
      revocationBehavior: 'mark-stale-session',
      redactionRule: 'path-only',
      backendCapabilityRequirement: 'runtime-file-upload',
      now: () => '2026-07-06T00:12:01.000Z',
    });
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/vault-injection-plans.jsonl');
    const verified = verifyWorkspaceExportTree({
      exportRoot: workspaceExportRoot(dataRoot, 'ws_demo', exported.exportId),
    });
    expect(() =>
      readWorkspaceImportSnapshot({
        targetWorkspaceId: 'ws_legacy_injection_plan',
        verified: {
          ...verified,
          fileContents: new Map(verified.fileContents).set('records/injection-plans.jsonl', ''),
        },
      })
    ).toThrow('Unsupported workspace export record path: records/injection-plans.jsonl');

    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d862',
          }),
        }
      )
    );

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedGrant = listVaultGrants(coreDb).find(
      (grant) => grant.workspaceId === body.importedWorkspaceId
    );
    const importedPlans = listVaultInjectionPlans(coreDb).filter(
      (plan) => plan.grantId === importedGrant?.grantId
    );

    expect(importedPlans).toEqual([
      expect.objectContaining({
        planId: `plan_imported_${body.importedWorkspaceId}_1`,
        grantId: importedGrant?.grantId,
        packageSnapshotId: null,
        capabilityId: 'runtime.codex_auth',
        injectionVisibility: 'runtime-file',
        targetPath: '/sandbox/.codex/auth.json',
        targetEnvVarName: null,
        expirationBehavior: 'expire-with-agent-session',
        revocationBehavior: 'mark-stale-session',
        redactionRule: 'path-only',
        backendCapabilityRequirement: 'runtime-file-upload',
        status: 'active',
      }),
    ]);
    expect(importedPlans[0]?.planId).not.toBe('plan_ws_demo_codex_auth');
    expect(importedPlans[0]?.grantId).not.toBe('grant_ws_demo_codex_auth');
    expect(JSON.stringify(importedPlans)).not.toContain('redacted-source');
    coreDb.sqlite.close();
  });

  it('exports and imports workspace injection receipts as line-oriented records', async () => {
    const dataRoot = mkdtempSync(
      join(tmpdir(), 'openkit-workspace-import-injection-receipt-route-')
    );
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceReference = createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://redacted-source',
      displayName: 'Workspace GitHub token',
      ownerScope: 'workspace',
      referenceId: 'vault_ws_demo_github_receipt',
      secretKind: 'github-token',
      workspaceId: 'ws_demo',
      now: () => '2026-07-06T00:00:00.000Z',
    });
    createVaultGrant(coreDb, {
      grantId: 'grant_ws_demo_github_receipt',
      vaultReferenceId: sourceReference.referenceId,
      ownerScope: 'workspace',
      workspaceId: 'ws_demo',
      subjectSummary: 'GitHub push token',
      targetCapabilityId: 'mcp.github.call_tool',
      allowedInjectionPaths: ['backend-provider'],
      lifetime: 'capability-call',
      policyDecisionId: 'pd_receipt_1',
      now: () => '2026-07-06T00:13:00.000Z',
    });
    createVaultInjectionPlan(coreDb, {
      planId: 'plan_ws_demo_github_receipt',
      grantId: 'grant_ws_demo_github_receipt',
      capabilityId: 'mcp.github.call_tool',
      injectionVisibility: 'backend-provider',
      expirationBehavior: 'expire-after-capability-call',
      revocationBehavior: 'revoke-backend-handle',
      redactionRule: 'backend-summary-only',
      backendCapabilityRequirement: 'native-handle',
      now: () => '2026-07-06T00:13:01.000Z',
    });
    createVaultInjectionReceipt(coreDb, {
      receiptId: 'receipt_ws_demo_github',
      planId: 'plan_ws_demo_github_receipt',
      grantId: 'grant_ws_demo_github_receipt',
      capabilityCallId: 'cap_receipt_1',
      backendSummary: 'encrypted-file material v7 injected as backend handle',
      injectedAt: '2026-07-06T00:13:02.000Z',
      expiresAt: '2026-07-06T00:18:02.000Z',
      revocationStatus: 'active',
      auditEventId: 'audit_receipt_1',
    });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      createVaultUseRecord(sourceDb, {
        useId: 'vuse_ws_demo_receipt',
        ownerScope: 'workspace',
        workspaceId: 'ws_demo',
        vaultReferenceId: sourceReference.referenceId,
        materialVersion: 7,
        backendKind: 'encrypted-file',
        resolvingPath: 'plan',
        planId: 'plan_ws_demo_github_receipt',
        receiptId: 'receipt_ws_demo_github',
        capabilityCallId: 'cap_receipt_1',
        outcome: 'succeeded',
        auditEventId: 'audit_vault_use_receipt_1',
        usedAt: '2026-07-06T00:13:03.000Z',
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/vault-injection-receipts.jsonl');
    const verified = verifyWorkspaceExportTree({
      exportRoot: workspaceExportRoot(dataRoot, 'ws_demo', exported.exportId),
    });
    expect(() =>
      readWorkspaceImportSnapshot({
        targetWorkspaceId: 'ws_legacy_injection_receipt',
        verified: {
          ...verified,
          fileContents: new Map(verified.fileContents).set('records/injection-receipts.jsonl', ''),
        },
      })
    ).toThrow('Unsupported workspace export record path: records/injection-receipts.jsonl');

    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d872',
          }),
        }
      )
    );

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedGrant = listVaultGrants(coreDb).find(
      (grant) => grant.workspaceId === body.importedWorkspaceId
    );
    const importedPlan = listVaultInjectionPlans(coreDb).find(
      (plan) => plan.grantId === importedGrant?.grantId
    );
    const importedReceipts = listVaultInjectionReceipts(coreDb).filter(
      (receipt) => receipt.planId === importedPlan?.planId
    );
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);

    try {
      expect(importedReceipts).toEqual([
        expect.objectContaining({
          receiptId: `receipt_imported_${body.importedWorkspaceId}_1`,
          planId: importedPlan?.planId,
          grantId: importedGrant?.grantId,
          agentSessionId: null,
          capabilityCallId: 'cap_receipt_1',
          backendSummary: 'encrypted-file material v7 injected as backend handle',
          injectedAt: '2026-07-06T00:13:02.000Z',
          expiresAt: '2026-07-06T00:18:02.000Z',
          revocationStatus: 'active',
          auditEventId: 'audit_receipt_1',
        }),
      ]);
      expect(listVaultUseRecords(importedDb)).toEqual([
        expect.objectContaining({
          useId: 'vuse_ws_demo_receipt',
          workspaceId: body.importedWorkspaceId,
          vaultReferenceId: importedGrant?.vaultReferenceId,
          planId: importedPlan?.planId,
          receiptId: importedReceipts[0]?.receiptId,
        }),
      ]);
      expect(importedReceipts[0]?.receiptId).not.toBe('receipt_ws_demo_github');
      expect(importedReceipts[0]?.planId).not.toBe('plan_ws_demo_github_receipt');
      expect(importedReceipts[0]?.grantId).not.toBe('grant_ws_demo_github_receipt');
      expect(JSON.stringify(importedReceipts)).not.toContain('redacted-source');
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('exports and imports workspace data source catalogs', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-data-sources-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const catalogRoot = join(dataRoot, 'workspaces', 'ws_demo', 'config');
    mkdirSync(catalogRoot, { recursive: true });
    writeFileSync(
      join(catalogRoot, 'data-sources.jsonc'),
      `${JSON.stringify(
        parseWorkspaceDataSourceCatalog({
          schemaVersion: 1,
          sources: [
            {
              id: 'repo_default',
              kind: 'git',
              displayName: 'OpenKit repository',
              locator: { repositoryResourceId: 'repo_default' },
              access: 'read-write',
              sensitivity: 'internal',
              allowedSlotKinds: ['worktree'],
              status: 'active',
            },
          ],
        }),
        null,
        2
      )}\n`
    );
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/data-sources.json');

    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d741',
          }),
        }
      )
    );

    expect(importRes.status).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedCatalog = parseWorkspaceDataSourceCatalog(
      JSON.parse(
        readFileSync(
          join(dataRoot, 'workspaces', body.importedWorkspaceId, 'config', 'data-sources.jsonc'),
          'utf8'
        )
      )
    );

    expect(importedCatalog.sources).toEqual([
      expect.objectContaining({
        id: 'repo_default',
        kind: 'git',
        locator: { repositoryResourceId: 'repo_default' },
      }),
    ]);
    expect(JSON.stringify(exported)).not.toContain(dataRoot);
    coreDb.sqlite.close();
  });

  it('exports and imports workspace sync records as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-sync-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const sourceReview = workspaceSyncReviewRouteItem();
    const sourceTurn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Produce workspace sync review',
      { kind: 'user', id: 'user_local' },
      null,
      {
        turnId: 'turn_route_1',
      }
    );
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: sourceReview.changeSet.createdAt,
      id: 'as_dashboard_control_1',
      message: null,
      status: 'busy',
      threadId: sourceTurn.threadId,
      updatedAt: sourceReview.changeSet.createdAt,
      workspaceId: sourceTurn.workspaceId,
    });
    const environmentPackage = AgentEnvironmentPackageSchema.parse({
      ...createOpenShellWorkerControlPackage(store, sourceTurn.id),
      snapshotId: `aepsnap_test_${sourceReview.changeSet.materializationRecordId}`,
    });
    store.createArtifact({
      id: sourceReview.artifactId,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: sourceTurn.id,
      kind: 'diff',
      title: 'Workspace sync review',
      status: 'ready',
      summary: sourceReview.review.riskSummary,
      version: 1,
      content: { format: 'text', body: sourceReview.patchPayload?.text ?? '' },
      contentDigest: artifactDigest(sourceReview.patchPayload?.text ?? ''),
      lastMutationRequestId: 'workspace-sync-artifact-route-1',
      origin: {
        kind: 'turn-output',
        threadId: sourceTurn.threadId,
        turnId: sourceTurn.id,
        requestId: 'workspace-sync-artifact-route-1',
      },
      createdAt: sourceReview.review.createdAt,
      updatedAt: sourceReview.review.updatedAt,
    });
    try {
      recordAgentEnvironmentPackageSnapshot(sourceDb, {
        createdAt: sourceReview.changeSet.createdAt,
        environmentPackage,
      });
      recordTestWorkspaceReviewMaterialization(sourceDb, sourceReview);
      recordWorkspaceSyncReview(sourceDb, { item: sourceReview });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/staged-workspace-reviews.jsonl');
    expect(exported.checkedFiles).toContain('records/workspace-change-sets.jsonl');
    expect(exported.checkedFiles).toContain('records/workspace-input-snapshots.jsonl');
    expect(exported.checkedFiles).toContain('records/workspace-materialization-records.jsonl');
    expect(exported.checkedFiles).toContain('records/backend-workspace-handles.jsonl');

    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d762',
          }),
        }
      )
    );

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedArtifact = store.listArtifacts(body.importedWorkspaceId)[0];
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      expect(listWorkspaceInputSnapshots(importedDb, body.importedWorkspaceId)).toEqual([
        expect.objectContaining({
          id: 'wis_route_1',
          workspaceId: body.importedWorkspaceId,
          resourceId: 'repo_default',
        }),
      ]);
      expect(listWorkspaceMaterializationRecords(importedDb, body.importedWorkspaceId)).toEqual([
        expect.objectContaining({
          id: 'wmr_route_1',
          workspaceId: body.importedWorkspaceId,
          inputSnapshotId: 'wis_route_1',
          materializedRootRef: `workspace://${body.importedWorkspaceId}/repo_default`,
        }),
      ]);
      expect(listBackendWorkspaceHandles(importedDb, body.importedWorkspaceId)).toEqual([
        expect.objectContaining({
          id: 'bwh_wmr_route_1',
          workspaceId: body.importedWorkspaceId,
          materializationRecordId: 'wmr_route_1',
          transportRefs: [
            {
              kind: 'materialized-root',
              ref: `workspace://${body.importedWorkspaceId}/repo_default`,
            },
          ],
        }),
      ]);
      expect(listWorkspaceChangeSets(importedDb, body.importedWorkspaceId)).toEqual([
        expect.objectContaining({
          id: 'wcs_route_1',
          workspaceId: body.importedWorkspaceId,
          materializationRecordId: 'wmr_route_1',
        }),
      ]);
      expect(listWorkspaceSyncReviews(importedDb, body.importedWorkspaceId)).toEqual([
        expect.objectContaining({
          artifactId: importedArtifact?.id,
          changeSet: expect.objectContaining({
            id: 'wcs_route_1',
            workspaceId: body.importedWorkspaceId,
          }),
          patchPayload: expect.objectContaining({ digest: sourceReview.patchPayload?.digest }),
          review: expect.objectContaining({
            id: 'swr_route_1',
            changeSetId: 'wcs_route_1',
            workspaceId: body.importedWorkspaceId,
          }),
        }),
      ]);
      const stagedAuditRows = importedDb.sqlite
        .prepare('SELECT action FROM audit_events WHERE action = ?')
        .all('workspace.review.stage') as Array<Record<string, unknown>>;
      expect(stagedAuditRows).toHaveLength(1);
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('exports and imports workspace apply results as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-apply-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const sourceReview = workspaceSyncReviewRouteItem();
    const sourceTurn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Produce workspace apply result',
      { kind: 'user', id: 'user_local' },
      null,
      {
        turnId: 'turn_route_1',
      }
    );
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: sourceReview.changeSet.createdAt,
      id: 'as_dashboard_control_1',
      message: null,
      status: 'busy',
      threadId: sourceTurn.threadId,
      updatedAt: sourceReview.changeSet.createdAt,
      workspaceId: sourceTurn.workspaceId,
    });
    const environmentPackage = AgentEnvironmentPackageSchema.parse({
      ...createOpenShellWorkerControlPackage(store, sourceTurn.id),
      snapshotId: `aepsnap_test_${sourceReview.changeSet.materializationRecordId}`,
    });
    store.createArtifact({
      id: sourceReview.artifactId,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: sourceTurn.id,
      kind: 'diff',
      title: 'Workspace apply result',
      status: 'ready',
      summary: sourceReview.review.riskSummary,
      version: 1,
      content: { format: 'text', body: sourceReview.patchPayload?.text ?? '' },
      contentDigest: artifactDigest(sourceReview.patchPayload?.text ?? ''),
      lastMutationRequestId: 'workspace-apply-artifact-route-1',
      origin: {
        kind: 'turn-output',
        threadId: sourceTurn.threadId,
        turnId: sourceTurn.id,
        requestId: 'workspace-apply-artifact-route-1',
      },
      createdAt: sourceReview.review.createdAt,
      updatedAt: sourceReview.review.updatedAt,
    });
    try {
      recordAgentEnvironmentPackageSnapshot(sourceDb, {
        createdAt: sourceReview.changeSet.createdAt,
        environmentPackage,
      });
      recordTestWorkspaceReviewMaterialization(sourceDb, sourceReview);
      recordWorkspaceSyncReview(sourceDb, { item: sourceReview });
      recordWorkspaceApplyResult(sourceDb, {
        requestId: '00000000-0000-4000-8000-00000000d771',
        result: {
          appliedAt: '2026-07-06T00:01:00.000Z',
          appliedPaths: ['docs/sync.md'],
          changeSetId: 'wcs_route_1',
          commitIds: ['commit_route_1'],
          conflictRecords: [],
          id: 'war_route_1',
          reviewId: 'swr_route_1',
          skippedPaths: [],
          status: 'applied',
          verification: [],
          workspaceId: 'ws_demo',
        },
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/workspace-apply-results.jsonl');

    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d772',
          }),
        }
      )
    );

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      expect(listWorkspaceApplyResults(importedDb, body.importedWorkspaceId)).toEqual([
        expect.objectContaining({
          appliedPaths: ['docs/sync.md'],
          changeSetId: 'wcs_route_1',
          commitIds: ['commit_route_1'],
          id: 'war_route_1',
          reviewId: 'swr_route_1',
          status: 'applied',
          workspaceId: body.importedWorkspaceId,
        }),
      ]);
      const applyAuditRows = importedDb.sqlite
        .prepare('SELECT action FROM audit_events WHERE action = ?')
        .all('workspace.apply.finish') as Array<Record<string, unknown>>;
      expect(applyAuditRows).toHaveLength(1);
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('exports and imports workspace permission decisions as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-permission-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    store.createTurn(
      'ws_demo',
      'th_demo',
      'Record permission decision',
      { kind: 'user', id: 'user_local' },
      null,
      {
        turnId: 'turn_demo',
      }
    );
    store.createItem({
      approvalRequestId: 'ap_source_repo_push',
      completedAt: '2026-07-06T00:01:00.000Z',
      createdAt: '2026-07-06T00:01:00.000Z',
      description: 'Portable historical approval.',
      id: 'it_source_repo_push_request',
      kind: 'permission',
      status: 'completed',
      threadId: 'th_demo',
      title: 'Approve source Git push',
      turnId: 'turn_demo',
      type: 'approval-request',
      workspaceId: 'ws_demo',
    });
    store.createItem({
      approvalRequestId: 'ap_source_repo_push',
      completedAt: '2026-07-06T00:01:01.000Z',
      createdAt: '2026-07-06T00:01:01.000Z',
      decision: 'granted',
      id: 'it_source_repo_push_decision',
      decidedAt: '2026-07-06T00:01:01.000Z',
      status: 'completed',
      actor: { kind: 'user', id: 'user_local' },
      causationId: 'it_source_repo_push_request',
      threadId: 'th_demo',
      turnId: 'turn_demo',
      type: 'approval-decision',
      workspaceId: 'ws_demo',
    });
    store.updateTurn('turn_demo', {
      completedAt: '2026-07-06T00:01:01.000Z',
      status: 'completed',
    });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      recordProductPermissionDecision({
        action: 'runtime.launch',
        contextSummary: {
          requestId: '00000000-0000-4000-8000-00000000d781',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          workspaceId: 'ws_demo',
        },
        decisionId: 'pd_workspace_import_1',
        enforcementPoint: 'runtime.worker_turn_loop.start',
        ownerScope: 'workspace',
        policyEngineVersion: 'nanocore-worker-policy:v1',
        policySnapshotId: 'worker_turn_launch_policy',
        reasonCode: 'worker_turn_start_allowed',
        resourceSummary: { kind: 'worker-turn', turnId: 'turn_demo' },
        result: 'allow',
        subjectSummary: { id: 'worker-coordinator', kind: 'nanocore' },
        workspaceDb: sourceDb,
        workspaceId: 'ws_demo',
        now: new Date('2026-07-06T00:02:00.000Z'),
      });
      recordProductPermissionDecision({
        action: 'repo.push',
        approvalId: 'ap_source_repo_push',
        contextSummary: { workspaceId: 'ws_demo' },
        decisionId: 'pd_workspace_import_repo_push',
        enforcementPoint: 'repo.push.approval_response',
        ownerScope: 'workspace',
        policyEngineVersion: 'nanocore-approval-policy:v1',
        policySnapshotId: 'policy_snapshot_runtime',
        reasonCode: 'repo_push_approved',
        resourceSummary: {
          kind: 'git-push-target',
          repositoryResourceId: 'repo_default',
          targetBranch: 'main',
          workspaceId: 'ws_demo',
        },
        result: 'allow',
        subjectSummary: { kind: 'user', userId: 'user_local' },
        workspaceDb: sourceDb,
        workspaceId: 'ws_demo',
        now: new Date('2026-07-06T00:02:01.000Z'),
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/permission-decisions.jsonl');

    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d782',
          }),
        }
      )
    );

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      const decision = importedDb.sqlite
        .prepare(
          `SELECT
            decision_id,
            owner_scope,
            workspace_id,
            action,
            result,
            reason_code,
            audit_event_id
          FROM permission_decisions
          WHERE decision_id = ?`
        )
        .get('pd_workspace_import_1') as Record<string, unknown> | undefined;

      expect(decision).toEqual({
        action: 'runtime.launch',
        audit_event_id: expect.stringMatching(/^aud_/),
        decision_id: 'pd_workspace_import_1',
        owner_scope: 'workspace',
        reason_code: 'worker_turn_start_allowed',
        result: 'allow',
        workspace_id: body.importedWorkspaceId,
      });
      const importedApprovalId = `apr_imported_${body.importedWorkspaceId}_1`;
      expect(() => store.getApproval(importedApprovalId)).toThrow(
        `Approval request not found: ${importedApprovalId}`
      );
      expect(
        importedDb.sqlite
          .prepare(
            `SELECT approval_id AS approvalId, result
             FROM permission_decisions
             WHERE decision_id = ?`
          )
          .get('pd_workspace_import_repo_push')
      ).toEqual({ approvalId: importedApprovalId, result: 'allow' });
      const permissionAuditRows = importedDb.sqlite
        .prepare('SELECT action FROM audit_events WHERE action = ?')
        .all('permission.decision') as Array<Record<string, unknown>>;
      expect(permissionAuditRows).toHaveLength(2);
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('lists workspace-filtered scheduler admissions through App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-admission-list-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Scheduler admission read route');
    createSchedulerAdmissionEntry(coreDb, {
      triggerActor: { kind: 'user', id: 'user_local' },
      queueEntryId: 'queue_read_route_1',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: 'turn_scheduler_read_1',
      turnInput: 'First queued turn with /Users/private local path hidden from response.',
      requestedAgentId: 'agent_codex_host',
      profileRef: 'agent_codex_host',
      priorityClass: 'interactive',
      requiredPoolConstraints: ['openshell.local'],
      now: () => '2026-07-07T00:00:00.000Z',
    });
    createSchedulerAdmissionEntry(coreDb, {
      triggerActor: { kind: 'user', id: 'user_local' },
      queueEntryId: 'queue_read_route_2',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: 'turn_scheduler_read_2',
      turnInput: 'Second queued turn.',
      requestedAgentId: 'agent_codex_host',
      profileRef: 'agent_codex_host',
      priorityClass: 'automation',
      requiredPoolConstraints: ['openshell.local'],
      now: () => '2026-07-07T00:00:01.000Z',
    });
    createSchedulerAdmissionEntry(coreDb, {
      triggerActor: { kind: 'user', id: 'user_local' },
      queueEntryId: 'queue_read_route_denied',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: 'turn_scheduler_read_denied',
      turnInput: 'Denied turn.',
      requestedAgentId: 'agent_codex_host',
      profileRef: 'agent_codex_host',
      priorityClass: 'interactive',
      requiredPoolConstraints: ['openshell.local'],
      now: () => '2026-07-07T00:00:02.000Z',
    });
    denySchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_read_route_denied',
      denialReason: 'no-healthy-target',
    });
    createSchedulerAdmissionEntry(coreDb, {
      triggerActor: { kind: 'user', id: 'user_local' },
      queueEntryId: 'queue_other_workspace',
      workspaceId: 'ws_other',
      threadId: 'th_other',
      turnId: 'turn_other',
      turnInput: 'Other workspace turn.',
      requestedAgentId: 'agent_codex_host',
      profileRef: 'agent_codex_host',
      priorityClass: 'interactive',
      requiredPoolConstraints: ['openshell.local'],
    });
    const app = createApp({ coreDb, dataRoot, store });

    const res = await app.request(
      ...operationRequest('scheduler.list', { workspaceId: 'ws_demo' })
    );

    expect(res.status, await res.clone().text()).toBe(200);
    const payload = ListSchedulerAdmissionsResponseSchema.parse(await res.json());
    expect(payload.items).toMatchObject([
      {
        queueEntryId: 'queue_read_route_1',
        workspaceId: 'ws_demo',
        status: 'queued',
        denialReason: null,
        queuePosition: 1,
      },
      {
        queueEntryId: 'queue_read_route_2',
        workspaceId: 'ws_demo',
        status: 'queued',
        denialReason: null,
        queuePosition: 3,
      },
      {
        queueEntryId: 'queue_read_route_denied',
        workspaceId: 'ws_demo',
        status: 'denied',
        denialReason: 'no-healthy-target',
        queuePosition: null,
      },
    ]);
    expect(JSON.stringify(payload)).not.toContain('/Users/private');
    expect(JSON.stringify(payload)).not.toContain('queue_other_workspace');
    coreDb.sqlite.close();
  });

  it('lists workspace audit events through App API without raw payload fields', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-audit-events-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      recordWorkspaceAuditEvent({
        auditEventId: 'aud_route_1',
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        category: 'system',
        action: 'goal.create',
        resource: 'goal:goal_route_1',
        outcome: 'succeeded',
        summary: 'Goal created.',
        requestId: '00000000-0000-4000-8000-00000000a771',
        now: new Date('2026-07-07T00:00:00.000Z'),
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });

    const res = await app.request('/api/app/workspaces/ws_demo/audit/events');

    expect(res.status, await res.clone().text()).toBe(200);
    const payload = ListWorkspaceAuditEventsResponseSchema.parse(await res.json());
    expect(payload).toMatchObject({
      workspaceId: 'ws_demo',
      auditEvents: [
        {
          action: 'goal.create',
          id: 'aud_route_1',
          resource: 'goal:goal_route_1',
          workspaceId: 'ws_demo',
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('user_secret');
    coreDb.sqlite.close();
  });

  it('lists server audit events through App API without raw payload fields', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-audit-events-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    recordServerAuditEvent({
      auditEventId: 'aud_server_route_1',
      coreDb,
      category: 'system',
      action: 'server.config.update',
      resource: 'server:runtime-config',
      outcome: 'succeeded',
      summary: 'Runtime config updated.',
      requestId: '00000000-0000-4000-8000-00000000a772',
      now: new Date('2026-07-07T00:00:30.000Z'),
    });
    const app = createApp({ coreDb, dataRoot, store });

    const res = await app.request('/api/app/audit/events');

    expect(res.status, await res.clone().text()).toBe(200);
    const payload = ListServerAuditEventsResponseSchema.parse(await res.json());
    expect(payload).toMatchObject({
      auditEvents: [
        {
          action: 'server.config.update',
          id: 'aud_server_route_1',
          resource: 'server:runtime-config',
          workspaceId: null,
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('user_secret');
    coreDb.sqlite.close();
  });

  it('keeps workspace evidence bundle access read-only for automatically produced bundles', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-bundle-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const item = workspaceSyncReviewRouteItem();

    try {
      recordTestWorkspaceReviewMaterialization(workspaceDb, item);
      recordWorkspaceSyncReview(workspaceDb, { item });
    } finally {
      workspaceDb.sqlite.close();
    }

    const createRes = await app.request('/api/app/workspaces/ws_demo/evidence-bundles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const listRes = await app.request('/api/app/workspaces/ws_demo/evidence-bundles');

    expect(createRes.status).toBe(404);
    expect(listRes.status, await listRes.clone().text()).toBe(200);
    expect(ListWorkspaceEvidenceBundlesResponseSchema.parse(await listRes.json())).toMatchObject({
      workspaceId: 'ws_demo',
      evidenceBundles: [
        {
          id: 'evb_workspace_materialization_wmr_route_1',
          sourceKind: 'workspace-materialization',
          importStatus: 'promoted',
        },
        {
          id: 'evb_workspace_review_swr_route_1',
          sourceKind: 'workspace-sync-review',
          importStatus: 'promoted',
        },
      ],
    });
    coreDb.sqlite.close();
  });

  it('lists workspace runtime evidence through App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-runtime-evidence-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_runtime',
        turnId: 'turn_runtime',
        requestId: 'req_turn_runtime',
        requestInputHash: 'sha256:turn_runtime',
        stage: 'running_worker',
        iteration: 1,
        workerSessionId: 'session_runtime',
        now: () => '2026-07-07T00:04:00.000Z',
      });
      updateWorkerCheckpoint(workspaceDb, {
        authorityActor: { kind: 'user', id: 'user_1' },
        workspaceId: 'ws_demo',
        threadId: 'th_runtime',
        turnId: 'turn_runtime',
        stage: 'completed',
        stopReason: 'completed',
        now: () => '2026-07-07T00:05:00.000Z',
      });
      const app = createApp({ coreDb, dataRoot, store });

      const res = await app.request('/api/app/workspaces/ws_demo/runtime-evidence');

      expect(res.status, await res.clone().text()).toBe(200);
      const body = ListWorkspaceRuntimeEvidenceResponseSchema.parse(await res.json());
      expect(body).toMatchObject({
        workspaceId: 'ws_demo',
        runtimeEvidence: [
          {
            workspaceId: 'ws_demo',
            threadId: 'th_runtime',
            turnId: 'turn_runtime',
            agentSessionId: 'session_runtime',
            phase: 'checkpoint',
            outcome: 'succeeded',
            stopReason: 'completed',
            requiredFeatures: ['runtime.evidence.v1'],
          },
        ],
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('lists workspace permission decisions through App API without raw payload fields', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-permission-decisions-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      recordProductPermissionDecision({
        action: 'runtime.launch',
        contextSummary: {
          requestId: '00000000-0000-4000-8000-00000000d791',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          workspaceId: 'ws_demo',
        },
        decisionId: 'pd_route_1',
        enforcementPoint: 'runtime.worker_turn_loop.start',
        ownerScope: 'workspace',
        policyEngineVersion: 'nanocore-worker-policy:v1',
        policySnapshotId: 'worker_turn_launch_policy',
        reasonCode: 'higher_authority_required',
        resourceSummary: { kind: 'worker-turn', turnId: 'turn_demo' },
        result: 'require_escalation',
        subjectSummary: { id: 'worker-coordinator', kind: 'nanocore' },
        workspaceDb,
        workspaceId: 'ws_demo',
        now: new Date('2026-07-07T00:01:00.000Z'),
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });

    const res = await app.request('/api/app/workspaces/ws_demo/permission-decisions');

    expect(res.status, await res.clone().text()).toBe(200);
    const payload = ListWorkspacePermissionDecisionsResponseSchema.parse(await res.json());
    expect(payload).toMatchObject({
      workspaceId: 'ws_demo',
      permissionDecisions: [
        {
          action: 'runtime.launch',
          decisionId: 'pd_route_1',
          result: 'require_escalation',
          workspaceId: 'ws_demo',
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('user_secret');
    coreDb.sqlite.close();
  });

  it('lists server permission decisions through App API without raw payload fields', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-permission-decisions-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    recordProductPermissionDecision({
      action: 'llm.gateway.chat_completions',
      contextSummary: { route: '/v1/chat/completions' },
      coreDb,
      decisionId: 'pd_server_route_1',
      enforcementPoint: 'llm.gateway.policy',
      ownerScope: 'server',
      policyEngineVersion: 'nanocore-gateway-policy:v1',
      policySnapshotId: 'runtime_config_gateway_policy',
      reasonCode: 'policy_context_missing',
      resourceSummary: { kind: 'llm-provider', providerId: 'openrouter' },
      result: 'defer',
      subjectSummary: { id: 'openai-compatible', kind: 'gateway-client' },
      now: new Date('2026-07-07T00:02:00.000Z'),
    });
    const app = createApp({ coreDb, dataRoot, store });

    const res = await app.request('/api/app/permission-decisions');

    expect(res.status, await res.clone().text()).toBe(200);
    const payload = ListServerPermissionDecisionsResponseSchema.parse(await res.json());
    expect(payload).toMatchObject({
      permissionDecisions: [
        {
          action: 'llm.gateway.chat_completions',
          decisionId: 'pd_server_route_1',
          result: 'defer',
          workspaceId: null,
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('user_secret');
    coreDb.sqlite.close();
  });

  it('lists workspace vault use records through App API without secret material', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-vault-use-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      createVaultUseRecord(workspaceDb, {
        useId: 'use_route_1',
        ownerScope: 'workspace',
        workspaceId: 'ws_demo',
        vaultReferenceId: 'vault_github',
        materialVersion: 1,
        backendKind: 'encrypted-file',
        resolvingPath: 'grant',
        grantId: 'grant_github',
        agentSessionId: 'as_1',
        outcome: 'succeeded',
        auditEventId: 'aud_vault_use_route_1',
        usedAt: '2026-07-07T00:00:00.000Z',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });

    const res = await app.request('/api/app/workspaces/ws_demo/vault/use-records');

    expect(res.status, await res.clone().text()).toBe(200);
    const payload = ListWorkspaceVaultUseRecordsResponseSchema.parse(await res.json());
    expect(payload).toMatchObject({
      workspaceId: 'ws_demo',
      vaultUseRecords: [
        {
          useId: 'use_route_1',
          vaultReferenceId: 'vault_github',
          grantId: 'grant_github',
          outcome: 'succeeded',
          workspaceId: 'ws_demo',
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('ghp_secret');
    coreDb.sqlite.close();
  });

  it('lists server vault use records through App API without secret material', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-vault-use-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    createVaultUseRecord(coreDb, {
      useId: 'use_server_route_1',
      ownerScope: 'server',
      workspaceId: null,
      vaultReferenceId: 'vault_openrouter',
      materialVersion: 1,
      backendKind: 'encrypted-file',
      resolvingPath: 'provider',
      outcome: 'failed',
      failureCode: 'backend-locked',
      auditEventId: 'aud_server_vault_use_route_1',
      usedAt: '2026-07-07T00:00:00.000Z',
    });
    const app = createApp({ coreDb, dataRoot, store });

    const res = await app.request('/api/app/vault/use-records');

    expect(res.status, await res.clone().text()).toBe(200);
    const payload = ListServerVaultUseRecordsResponseSchema.parse(await res.json());
    expect(payload).toMatchObject({
      vaultUseRecords: [
        {
          useId: 'use_server_route_1',
          ownerScope: 'server',
          workspaceId: null,
          vaultReferenceId: 'vault_openrouter',
          outcome: 'failed',
          failureCode: 'backend-locked',
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('sk-provider-secret');
    coreDb.sqlite.close();
  });

  it('retries denied scheduler admissions through App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-admission-retry-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Scheduler admission retry route');
    createSchedulerAdmissionEntry(coreDb, {
      triggerActor: { kind: 'user', id: 'user_local' },
      queueEntryId: 'queue_retry_route',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: 'turn_scheduler_retry',
      turnInput: 'Retry scheduler admission.',
      requestedAgentId: 'agent_codex_host',
      profileRef: 'agent_codex_host',
      priorityClass: 'interactive',
      requiredPoolConstraints: ['openshell.local'],
    });
    denySchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_retry_route',
      denialReason: 'no-healthy-target',
    });
    const app = createApp({ coreDb, dataRoot, store });

    const retryRes = await app.request(
      ...operationRequest(
        'scheduler.retry',
        { workspaceId: 'ws_demo', queueEntryId: 'queue_retry_route' },
        { method: 'POST' }
      )
    );

    expect(retryRes.status, await retryRes.clone().text()).toBe(200);
    expect(RetrySchedulerAdmissionResponseSchema.parse(await retryRes.json())).toEqual({
      retried: true,
    });
    expect(listQueuedSchedulerAdmissionEntries(coreDb).map((entry) => entry.queueEntryId)).toEqual([
      'queue_retry_route',
    ]);
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, outcome, resource, request_id, thread_id, turn_id, summary
            FROM audit_events
            WHERE action = 'scheduler.admission.retry'`
          )
          .all()
      ).toEqual([
        {
          action: 'scheduler.admission.retry',
          outcome: 'succeeded',
          resource: 'scheduler-admission:queue_retry_route',
          request_id: null,
          thread_id: thread.id,
          turn_id: 'turn_scheduler_retry',
          summary: 'Scheduler admission retried.',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('cancels scheduler admissions through App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-admission-cancel-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Scheduler admission cancel route');
    createSchedulerAdmissionEntry(coreDb, {
      triggerActor: { kind: 'user', id: 'user_local' },
      queueEntryId: 'queue_cancel_route',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: 'turn_scheduler_cancel',
      turnInput: 'Cancel scheduler admission.',
      requestedAgentId: 'agent_codex_host',
      profileRef: 'agent_codex_host',
      priorityClass: 'interactive',
      requiredPoolConstraints: ['openshell.local'],
    });
    const app = createApp({ coreDb, dataRoot, store });

    const cancelRes = await app.request(
      ...operationRequest(
        'scheduler.cancel',
        { workspaceId: 'ws_demo', queueEntryId: 'queue_cancel_route' },
        { method: 'POST' }
      )
    );

    expect(cancelRes.status, await cancelRes.clone().text()).toBe(200);
    expect(CancelSchedulerAdmissionResponseSchema.parse(await cancelRes.json())).toEqual({
      cancelled: true,
    });
    expect(listQueuedSchedulerAdmissionEntries(coreDb)).toEqual([]);
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, outcome, resource, request_id, thread_id, turn_id, summary
            FROM audit_events
            WHERE action = 'scheduler.admission.cancel'`
          )
          .all()
      ).toEqual([
        {
          action: 'scheduler.admission.cancel',
          outcome: 'cancelled',
          resource: 'scheduler-admission:queue_cancel_route',
          request_id: null,
          thread_id: thread.id,
          turn_id: 'turn_scheduler_cancel',
          summary: 'Scheduler admission cancelled.',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('does not expose generic pending-input recovery through App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-pending-user-turn-route-absence-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const app = createApp({ coreDb, dataRoot, store: createDemoStore({ dataRoot }) });

    try {
      const routes = [
        ['POST', '/api/app/workspaces/ws_demo/threads/th_demo/recovery/interrupted-worker'],
        ['GET', '/api/app/workspaces/ws_demo/threads/th_demo/recovery/pending-user-turns'],
        [
          'POST',
          '/api/app/workspaces/ws_demo/threads/th_demo/recovery/pending-user-turns/req_demo/edit',
        ],
        [
          'POST',
          '/api/app/workspaces/ws_demo/threads/th_demo/recovery/pending-user-turns/req_demo/interrupt',
        ],
        [
          'POST',
          '/api/app/workspaces/ws_demo/threads/th_demo/recovery/pending-user-turns/req_demo/cancel',
        ],
        [
          'POST',
          '/api/app/workspaces/ws_demo/threads/th_demo/recovery/pending-user-turns/req_demo/follow-up',
        ],
        [
          'POST',
          '/api/app/workspaces/ws_demo/threads/th_demo/recovery/interrupted-worker/turn_demo/terminal',
        ],
      ];

      for (const [method, route] of routes) {
        const response = await app.request(route!, { method });
        expect(response.status, route).toBe(404);
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not expose runtime config AgentSession restart through App API', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Retire stale session');
    const session = store.createAgentSession({
      agentId: 'agent_codex_host',
      configVersion: 1,
      createdAt: '2026-07-07T00:00:00.000Z',
      id: 'as_stale_route',
      message: null,
      status: 'busy',
      threadId: thread.id,
      updatedAt: '2026-07-07T00:00:00.000Z',
      workspaceId: 'ws_demo',
      workspaceRoots: [],
    });
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-runtime-config-stale-session-'));
    const runtimeConfigManager = createRuntimeConfigManager({
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({ dataRoot, version: 2 }),
    });
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const app = createApp({ coreDb, runtimeConfigManager, store });
    const sessionBefore = store.getAgentSession(session.id);

    try {
      const res = await app.request(
        `/api/app/workspaces/ws_demo/runtime-config/stale-sessions/${session.id}/restart`,
        { method: 'POST' }
      );

      expect(res.status, await res.clone().text()).toBe(404);
      expect(store.getAgentSession(session.id)).toEqual(sessionBefore);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not expose AgentSession summaries from ordinary agent health refresh', async () => {
    const turnExecutor = Object.assign(new FakeTurnExecutor(), {
      refreshAgentSessions: () => [
        {
          id: 'as_health_private',
          status: 'busy' as const,
          message: null,
          configVersion: 1,
          workspaceRoots: [],
          stale: false,
          sandboxSummary: null,
          backend: {
            kind: 'openshell' as const,
            health: 'ready' as const,
            controlMode: 'sandbox-integration' as const,
            control: null,
            runtimeTargetId: 'nanohost-main',
            sandboxBindingRef: 'sandbox://as-health-private',
            version: '0.0.63',
          },
        },
      ],
    });
    const app = createApp({ store: createDemoStore(), turnExecutor });

    const response = await app.request('/api/app/workspaces/ws_demo/agents/health/refresh', {
      method: 'POST',
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty('sessions');
    expect(JSON.stringify(body)).not.toContain('as_health_private');
  });

  it('rejects interrupted-worker retry while exact reconnect remains pending', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-reconnect-pending-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Reconnect pending retry route');
    const turn = store.createTurn('ws_demo', thread.id, 'Reconnect original worker', {
      kind: 'user',
      id: 'user_local',
    });
    const agentSessionId = 'as_reconnect_pending';
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: turn.startedAt ?? '2026-07-17T05:00:00.000Z',
      id: agentSessionId,
      message: null,
      status: 'busy',
      threadId: thread.id,
      updatedAt: '2026-07-17T05:00:00.000Z',
      workspaceId: 'ws_demo',
    });
    store.updateTurn(turn.id, { agentSessionId });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      upsertWorkerCheckpoint(workspaceDb, {
        contextDigest: 'sha256:reconnect-pending',
        diagnosticsSummary: 'Original worker may reconnect.',
        iteration: 1,
        stage: 'running_worker',
        threadId: thread.id,
        turnId: turn.id,
        requestId: `req_${turn.id}`,
        requestInputHash: `sha256:${turn.id}`,
        workerSessionId: agentSessionId,
        workspaceId: 'ws_demo',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    recordWorkerRetryLease(coreDb, {
      agentSessionId,
      recoveryState: 'awaiting-reconnect',
      releaseReason: null,
      status: 'active',
      threadId: thread.id,
      turnId: turn.id,
    });
    const turnBefore = store.getTurnById(turn.id);
    const sessionBefore = store.getAgentSession(agentSessionId);
    const leaseBefore = requireSchedulerSessionLease(coreDb, `lease_${turn.id}`);
    const checkpointDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const checkpointBefore = getWorkerCheckpoint(checkpointDb, 'ws_demo', thread.id, turn.id);
    checkpointDb.sqlite.close();
    const app = createApp({
      coreDb,
      dataRoot,
      store,
      workerControlGateway: new WorkerControlGateway(),
    });

    const list = await app.request(...operationRequest('recovery.worker-list', {}));
    await expect(list.json()).resolves.toEqual({ items: [] });
    const retry = await app.request(
      ...operationRequest(
        'recovery.checkpoint-retry',
        { workspaceId: 'ws_demo', threadId: thread.id, turnId: turn.id },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'req_reconnect_pending_retry' }),
        }
      )
    );

    expect(retry.status).toBe(409);
    await expect(retry.json()).resolves.toMatchObject({ code: 'worker_reconnect_pending' });
    expect(store.getTurnById(turn.id)).toEqual(turnBefore);
    expect(store.getAgentSession(agentSessionId)).toEqual(sessionBefore);
    expect(requireSchedulerSessionLease(coreDb, `lease_${turn.id}`)).toEqual(leaseBefore);
    const reopenedDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    expect(getWorkerCheckpoint(reopenedDb, 'ws_demo', thread.id, turn.id)).toEqual(
      checkpointBefore
    );
    reopenedDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('exports and imports worker checkpoints as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-checkpoint-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    store.createTurn(
      'ws_demo',
      'th_demo',
      'Checkpoint worker turn',
      { kind: 'user', id: 'user_local' },
      null,
      {
        turnId: 'tu_checkpoint',
      }
    );
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      upsertWorkerCheckpoint(sourceDb, {
        contextDigest: 'sha256:checkpoint-context',
        diagnosticsSummary: 'checkpoint diagnostics',
        iteration: 3,
        now: () => '2026-07-06T00:04:00.000Z',
        requestId: 'req_checkpoint',
        requestInputHash: 'sha256:checkpoint-request',
        stage: 'running_worker',
        threadId: 'th_demo',
        turnId: 'tu_checkpoint',
        workerSessionId: 'as_checkpoint',
        workspaceId: 'ws_demo',
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/worker-turn-checkpoints.jsonl');

    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d802',
          }),
        }
      )
    );

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedThreadId = `th_imported_${body.importedWorkspaceId}_1`;
    const importedTurnId = `tu_imported_${body.importedWorkspaceId}_1`;
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      expect(
        getWorkerCheckpoint(importedDb, body.importedWorkspaceId, importedThreadId, importedTurnId)
      ).toEqual(
        expect.objectContaining({
          checkpointId: `${body.importedWorkspaceId}:${importedThreadId}:${importedTurnId}`,
          contextDigest: 'sha256:checkpoint-context',
          goalId: null,
          iteration: 3,
          requestId: 'req_checkpoint',
          requestInputHash: 'sha256:checkpoint-request',
          stage: 'running_worker',
          taskId: null,
          threadId: importedThreadId,
          turnId: importedTurnId,
          workerSessionId: 'as_checkpoint',
          workspaceId: body.importedWorkspaceId,
        })
      );
      const checkpointAuditRows = importedDb.sqlite
        .prepare('SELECT action FROM audit_events WHERE action = ?')
        .all('worker.checkpoint.terminal') as Array<Record<string, unknown>>;
      expect(checkpointAuditRows).toHaveLength(0);
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('exports and imports MCP tool schema snapshots as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-mcp-schema-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const schemaTools = [
      {
        name: 'repo_status',
        inputSchema: { type: 'object', properties: { owner: { type: 'string' } } },
      },
    ];
    const schemaDigest = mcpToolSchemaContentDigest(schemaTools);
    try {
      sourceDb.sqlite
        .prepare(
          `INSERT INTO mcp_tool_schema_snapshots (
            snapshot_id,
            workspace_id,
            catalog_entry_id,
            source_ref,
            server_version,
            content_digest,
            tools_json,
            source,
            captured_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'mcpsnap_import_1',
          'ws_demo',
          'github-mcp',
          'mcp/github',
          '1.0.0',
          schemaDigest,
          JSON.stringify(schemaTools),
          'live',
          '2026-07-06T00:07:00.000Z'
        );
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request(
      ...operationRequest('workspace.export', { workspaceId: 'ws_demo' }, { method: 'POST' })
    );
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/mcp-tool-schema-snapshots.jsonl');

    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: 'ws_demo',
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d832',
          }),
        }
      )
    );

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      const row = importedDb.sqlite
        .prepare(
          `SELECT
            snapshot_id,
            workspace_id,
            catalog_entry_id,
            source_ref,
            server_version,
            content_digest,
            tools_json,
            source,
            captured_at
          FROM mcp_tool_schema_snapshots
          WHERE snapshot_id = ?`
        )
        .get('mcpsnap_import_1') as Record<string, unknown> | undefined;

      expect(row).toMatchObject({
        captured_at: '2026-07-06T00:07:00.000Z',
        catalog_entry_id: 'github-mcp',
        content_digest: schemaDigest,
        server_version: '1.0.0',
        snapshot_id: 'mcpsnap_import_1',
        source: 'aep',
        source_ref: 'mcp/github',
        workspace_id: body.importedWorkspaceId,
      });
      expect(JSON.parse(String(row?.tools_json))).toEqual([
        {
          inputSchema: { type: 'object', properties: { owner: { type: 'string' } } },
          name: 'repo_status',
        },
      ]);
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('serves the App API OpenAPI projection', async () => {
    const app = createApp();

    const res = await app.request('/api/openapi.json');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      info: {
        version: '0.1.0',
      },
      openapi: '3.1.0',
      'x-openkit-protocol-version': PROTOCOL_VERSION,
      paths: {
        '/api/app/operations/storage.layout-report': {
          post: {
            operationId: 'storage.layout-report',
          },
        },
        '/api/app/operations/backup.create': {
          post: {
            operationId: 'backup.create',
          },
        },
        '/api/app/operations/backup.verify': {
          post: {
            operationId: 'backup.verify',
          },
        },
        '/api/app/operations/workspace.export': {
          post: {
            operationId: 'workspace.export',
          },
        },
        '/api/app/operations/workspace.import-dry-run': {
          post: {
            operationId: 'workspace.import-dry-run',
          },
        },
      },
    });
  });

  it('allows credentialed browser CORS requests for server-mode auth', async () => {
    const app = createApp({ turnExecutor: new FakeTurnExecutor() });
    const res = await app.request('/api/app/operations/workspace.create', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://127.0.0.1:4174',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4174');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('returns a thin workspace record and separate resources payload', async () => {
    const canonicalStore = createDemoStore();
    const app = createApp(
      { ...{ turnExecutor: new FakeTurnExecutor() }, store: canonicalStore },
      true
    );
    const canonicalApp = createApp(
      { ...{ turnExecutor: new FakeTurnExecutor() }, store: canonicalStore },
      true
    );

    const workspaceRes = await app.request(
      ...operationRequest('workspace.read', { workspaceId: 'ws_demo' })
    );
    const resourcesRes = await canonicalApp.request('/api/app/operations/workspace.resources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws_demo' }),
    });

    expect(workspaceRes.status).toBe(200);
    expect(resourcesRes.status).toBe(200);

    const workspace = (await workspaceRes.json()) as Record<string, unknown>;
    const resources = (await resourcesRes.json()) as Record<string, unknown>;

    expect(workspace).toMatchObject({
      id: 'ws_demo',
      kind: 'code',
    });
    expect(workspace.knowledge).toBeUndefined();
    expect(resources).toMatchObject({
      knowledge: expect.any(Array),
      agents: expect.any(Array),
      models: expect.any(Array),
      skills: expect.any(Array),
    });
  });

  it('records usage for workspace knowledge entry writes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-entry-usage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store, turnExecutor: new FakeTurnExecutor() });
    const createRes = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.create',
        { workspaceId: 'ws_demo' },
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: '0190f4c8-0000-7000-8000-000000000201',
            kind: 'preference',
            title: 'Temporary preference',
            content: 'Remove this after the test.',
          }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    const knowledge = (await createRes.json()) as { id: string };

    const updateRes = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.update',
        { workspaceId: 'ws_demo', knowledgeEntryId: knowledge.id },
        {
          method: 'PATCH',
          body: JSON.stringify({
            requestId: '0190f4c8-0000-7000-8000-000000000213',
            title: 'Updated preference',
          }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    expect(updateRes.status).toBe(200);

    const deleteRes = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.delete',
        { workspaceId: 'ws_demo', knowledgeEntryId: knowledge.id },
        {
          method: 'DELETE',
          body: JSON.stringify({
            requestId: '0190f4c8-0000-7000-8000-000000000214',
          }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    expect(deleteRes.status).toBe(200);

    const listRes = await app.request(
      ...knowledgeOperationRequest('knowledge.list', { workspaceId: 'ws_demo' })
    );
    const list = (await listRes.json()) as { items: Array<{ id: string }> };

    expect(list.items.some((entry) => entry.id === knowledge.id)).toBe(false);

    const usageRes = await app.request('/api/app/workspaces/ws_demo/capability-usage');
    expect(usageRes.status, await usageRes.clone().text()).toBe(200);
    const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
    expect(
      usage.capabilityCalls.filter((call) =>
        ['knowledge.entry.create', 'knowledge.entry.update', 'knowledge.entry.delete'].includes(
          call.capabilityId
        )
      )
    ).toEqual([
      expect.objectContaining({
        capabilityId: 'knowledge.entry.create',
        operation: 'knowledge.entry.create',
        serviceRef: 'knowledge-store',
        status: 'succeeded',
      }),
      expect.objectContaining({
        capabilityId: 'knowledge.entry.update',
        operation: 'knowledge.entry.update',
        serviceRef: 'knowledge-store',
        status: 'succeeded',
      }),
      expect.objectContaining({
        capabilityId: 'knowledge.entry.delete',
        operation: 'knowledge.entry.delete',
        serviceRef: 'knowledge-store',
        status: 'succeeded',
      }),
    ]);
    expect(
      usage.usageRecords.filter((record) =>
        ['knowledge-entry-create', 'knowledge-entry-update', 'knowledge-entry-delete'].includes(
          record.source
        )
      )
    ).toEqual([
      expect.objectContaining({ source: 'knowledge-entry-create' }),
      expect.objectContaining({ source: 'knowledge-entry-update' }),
      expect.objectContaining({ source: 'knowledge-entry-delete' }),
    ]);

    coreDb.sqlite.close();
  });

  it('canonical HTTP turn.start preserves scheduler_unavailable 503 with real admission and no effects', async () => {
    const coreDb = createCoreDb();
    try {
      ensureLocalUser(coreDb);
      recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
      const store = createDemoStore();
      const before = {
        turns: store.listThreadTurns('ws_demo', 'th_demo'),
        receipts: store.listCommandRequests(),
      };
      const app = new Hono<{ Variables: AuthVariables }>();
      app.use('*', async (c, next) => {
        c.set('actor', { kind: 'local', userId: 'user_local' });
        await next();
      });
      registerOperationJsonRoutes({
        app,
        coreDb,
        store,
        requestStore: () => store,
        inflightCommands: new WeakMap(),
        workspaceMutationAdmission: new WorkspaceMutationAdmission(),
        turnStartServices: {
          coreDb: undefined,
          inflightCommands: new WeakMap(),
          providerCredentialResolver: () => null,
          runtimeConfig: () =>
            createInMemoryRuntimeConfigSnapshot({
              agentManifests: [createTestAgentSetup().manifest],
              openKitConfig: { defaults: { defaultAgentId: 'agent_codex_host' } },
              providerRegistry: testProviderRegistry(),
            }),
          schedulerEpoch: 1,
          turnExecutor: new FakeTurnExecutor(),
          workerPlacement: 'local',
        },
      });
      const response = await app.request(
        ...operationRequest(
          'turn.start',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            body: JSON.stringify({
              input: 'Ship the update',
              requestId: '0190f4c8-0000-7000-8000-000000000202',
            }),
          }
        )
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'scheduler_unavailable' });
      expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual(before.turns);
      expect(store.listCommandRequests()).toEqual(before.receipts);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('native turn.start refuses missing durable scheduler storage before effects', async () => {
    const store = createDemoStore();
    const before = store.listCommandRequests();
    await expect(
      startNativeTurn(
        {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: '0190f4c8-0000-7000-8000-000000000202',
          input: 'Ship the update',
        },
        store,
        { kind: 'local', userId: 'user_local' },
        {
          coreDb: undefined,
          inflightCommands: new WeakMap(),
          providerCredentialResolver: () => null,
          runtimeConfig: () =>
            createInMemoryRuntimeConfigSnapshot({
              agentManifests: [createTestAgentSetup().manifest],
              openKitConfig: { defaults: { defaultAgentId: 'agent_codex_host' } },
              providerRegistry: testProviderRegistry(),
            }),
          schedulerEpoch: 1,
          turnExecutor: new FakeTurnExecutor(),
          workerPlacement: 'local',
        }
      )
    ).rejects.toMatchObject({ status: 503, code: 'scheduler_unavailable' });
    expect(store.listCommandRequests()).toEqual(before);
    expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
  });

  it('starts scheduled turns without resolving Gateway credentials in Agent composition', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const providerCredentialResolver = vi.fn((secretRef: string) =>
      secretRef === 'vault://provider_openrouter' ? 'test-key' : null
    );
    const app = createApp({
      agentManifests: [createTestAgentSetup().manifest],
      coreDb,
      providerCredentialResolver,
      providerRegistry: new ProviderRegistry([
        {
          baseUrl: 'https://openrouter.ai/api/v1',
          defaultModel: 'openai/gpt-5.2',
          displayName: 'OpenRouter',
          id: 'agent-openrouter',
          kind: 'gateway',
          models: ['openai/gpt-5.2'],
          secretRef: 'vault://provider_openrouter',
        },
      ]),
      turnExecutor: executor,
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-scheduler-turn-repository-'));

    seedWritableGitRepository(repositoryPath);

    try {
      const res = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              requestId: '0190f4c8-0000-7000-8000-000000000216',
              input: 'Run through scheduler',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const turn = (await res.json()) as { id: string };

      expect(res.status).toBe(202);
      expect(executor.startContexts[0]).toMatchObject({
        agentSessionId: expect.any(String),
        requestId: '0190f4c8-0000-7000-8000-000000000216',
        sandboxBindingRef: expect.stringMatching(/^lease-binding:/),
      });
      expect(providerCredentialResolver).not.toHaveBeenCalled();
      expect(turn.id).toMatch(/^turn_0190f4c8-0000-7000-8000-000000000216/);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('starts Task Mode through the worker coordinator and one bounded worker turn', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const knowledge = store.createKnowledgeEntry('ws_demo', {
      content: 'Implement the focused Task Mode fix with the existing worker path.',
      kind: 'project-context',
      title: 'Focused Task Mode fix',
    });
    const executor = new FakeTurnExecutor();
    let launchedContextAssembly: ReturnType<typeof parseWorkerCheckpointContextAssembly> = null;
    const startTurn = executor.startTurn.bind(executor);
    vi.spyOn(executor, 'startTurn').mockImplementation(async (...args) => {
      const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        launchedContextAssembly = parseWorkerCheckpointContextAssembly(
          getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', args[1])?.diagnosticsSummary ??
            null
        );
      } finally {
        workspaceDb.sqlite.close();
      }
      return startTurn(...args);
    });
    const opaqueAgentManifest = createTestAgentSetup({
      adapter: 'fourth-runtime',
      agentId: 'agent_fourth_runtime',
      displayName: 'Fourth Runtime Agent',
    }).manifest;
    const laterAgentManifest = createTestAgentSetup({
      adapter: 'zeta-runtime',
      agentId: 'agent_zeta_runtime',
      displayName: 'Zeta Runtime Agent',
    }).manifest;
    const app = createApp({
      agentManifests: [laterAgentManifest, opaqueAgentManifest],
      coreDb,
      store,
      turnExecutor: executor,
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-task-mode-repository-'));
    const requestId = '0190f4c8-0000-7000-8000-000000000301';
    const input = 'Implement the focused Task Mode fix.';
    const workerStorageChoice = {
      expectedRevision: 7,
      kind: 'selected' as const,
      purpose: 'work' as const,
      reuseWorkSlotRef: 'wsl_22222222222222222222222222222222',
      storageRef: 'wst_11111111111111111111111111111111',
    };

    seedWritableGitRepository(repositoryPath);

    try {
      const forgedLineageRes = await app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: '0190f4c8-0000-7000-8000-000000000300',
              input,
              workerStorageChoice: {
                ...workerStorageChoice,
                goalId: 'goal_forged',
                taskId: 'task_forged',
              },
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      expect(forgedLineageRes.status).toBe(400);
      await expect(forgedLineageRes.json()).resolves.toMatchObject({ code: 'invalid_request' });
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_demo',
          statuses: ['admitted'],
        })
      ).toEqual([]);

      const res = await app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: JSON.stringify({ requestId, input, workerStorageChoice }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      const responseBody = await res.json();
      expect(res.status, JSON.stringify(responseBody)).toBe(202);
      const parsed = StartTaskModeResponseSchema.parse(responseBody);

      expect(parsed).not.toHaveProperty('decision');
      expect(parsed.state).toBe('completed');
      expect(parsed.turn.status).toBe('completed');
      expect(parsed.turn.agentId).toBe('agent_fourth_runtime');
      expect(parsed.turn.id).toMatch(/^turn_0190f4c8-0000-7000-8000-000000000301/);
      expect(executor.startContexts[0]?.agentSetup?.manifest.id).toBe('agent_fourth_runtime');
      const admittedWorkerStorageChoice = {
        ...workerStorageChoice,
        goalId: null,
        taskId: null,
      };
      expect(executor.startContexts[0]?.workerStorageChoice).toEqual(admittedWorkerStorageChoice);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_demo',
          statuses: ['admitted'],
        })
      ).toEqual([expect.objectContaining({ workerStorageChoice: admittedWorkerStorageChoice })]);
      expect(parsed.completion).toEqual({
        itemId: `it_assistant_${parsed.turn.id}`,
        text: 'Completed by fake executor.',
      });
      expect(parsed.evidence).toEqual({
        itemIds: [`it_user_${parsed.turn.id}`, `it_assistant_${parsed.turn.id}`],
        artifactIds: [],
        reviewIds: [],
      });
      const workerInput = store
        .listThreadItems('ws_demo', 'th_demo')
        .find((item) => item.id === `it_user_${parsed.turn.id}`);
      expect(workerInput?.type).toBe('user-message');
      const expectedWorkerRequest = workerCoordinator.createWorkerCoordinatorDecision({
        prompt: input,
        readiness: [
          {
            agentId: 'agent_fourth_runtime',
            displayName: 'Fourth Runtime Agent',
            readiness: 'ready',
          },
        ],
        threadState: { status: 'idle', threadId: 'th_demo' },
        workspaceSummary: { name: 'Demo Workspace', workspaceId: 'ws_demo' },
      }).workerRequest;
      expect(expectedWorkerRequest).not.toBeNull();
      expect(
        StructuredWorkerDelegationRequestSchema.parse(
          JSON.parse(workerInput?.type === 'user-message' ? workerInput.text : '')
        )
      ).toEqual(expectedWorkerRequest);
      const month = new Date().toISOString().slice(0, 7).replace('-', '');
      const retrievalTrace = KnowledgeRetrievalResponseSchema.parse(
        JSON.parse(
          readFileSync(
            join(coreDb.dataRoot, 'workspaces', 'ws_demo', 'knowledge', 'traces', `${month}.jsonl`),
            'utf8'
          ).trim()
        )
      );

      expect(retrievalTrace).toEqual(
        expect.objectContaining({
          caller: 'task-mode',
          retrievalParameters: { limit: 5, pinnedConceptIds: [] },
          traceId: expect.stringMatching(
            /^krt_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
          ),
          selected: expect.arrayContaining([
            expect.objectContaining({ knowledgePageId: knowledge.id }),
          ]),
        })
      );
      expect(launchedContextAssembly).toMatchObject({
        knowledgeSelectionInput: { retrievalTraceId: retrievalTrace.traceId },
      });
      const replayRes = await app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: JSON.stringify({ requestId, input, workerStorageChoice }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const storageConflictRes = await app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: JSON.stringify({ requestId, input, workerStorageChoice: { kind: 'fresh' } }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const conflictRes = await app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId,
              input: 'Implement a different focused Task Mode fix.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(replayRes.status).toBe(202);
      expect(StartTaskModeResponseSchema.parse(await replayRes.json())).toEqual(parsed);
      expect(storageConflictRes.status).toBe(409);
      await expect(storageConflictRes.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });
      expect(
        readWorkspaceKnowledgeRetrievalTrace(
          join(coreDb.dataRoot, 'workspaces', 'ws_demo'),
          retrievalTrace.traceId
        )
      ).toEqual(retrievalTrace);
      expect(() => store.updateTurn(parsed.turn.id, { status: 'cancelled' })).toThrow(
        /is terminal and does not admit this write/
      );
      expect(conflictRes.status).toBe(409);
      await expect(conflictRes.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });
      expect(executor.startContexts).toHaveLength(1);
      const sandboxBindingRef = executor.startContexts[0]!.sandboxBindingRef!;
      expect(
        requireSchedulerSessionLease(coreDb, sandboxBindingRef.slice('lease-binding:'.length))
      ).toMatchObject({
        status: 'released',
        releaseReason: 'turn-completed',
        turnId: parsed.turn.id,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      entry: 'direct Task',
      path: '/api/app/operations/task.start',
      requestId: '0190f4c8-0000-7000-8000-000000000321',
      responseKind: 'task' as const,
    },
    {
      entry: 'Chat-to-Task',
      path: '/api/app/operations/conversation.submit',
      requestId: '0190f4c8-0000-7000-8000-000000000322',
      responseKind: 'chat' as const,
    },
  ])('starts $entry from one remote Git source without a WorkspaceRepository', async ({
    path,
    requestId,
    responseKind,
  }) => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const remoteCommit = '0123456789abcdef0123456789abcdef01234567';
    const remoteUrl = 'https://git.example.test/openkit/task-mode.git';
    const agentManifest = {
      ...createTestAgentSetup().manifest,
      workspace: {
        inputs: [{ access: 'read-write' as const, id: 'repo_remote', sourceRef: 'main-repo' }],
      },
    };
    const catalog = parseWorkspaceDataSourceCatalog({
      schemaVersion: 1,
      sources: [
        {
          access: 'read-write',
          allowedSlotKinds: ['worktree'],
          displayName: 'Task Mode remote repository',
          id: 'main-repo',
          kind: 'git',
          locator: { commit: remoteCommit, url: remoteUrl },
          sensitivity: 'internal',
          status: 'active',
        },
      ],
    });
    const runtimeConfigManager = createRuntimeConfigManager({
      dataRoot: coreDb.dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        agentManifests: [agentManifest],
        dataRoot: coreDb.dataRoot,
        gatewayConfig: createTestGatewayConfig(),
        providerRegistry: testProviderRegistry(),
        workspaceDataSourceCatalogs: [
          {
            catalog,
            path: join(coreDb.dataRoot, 'workspaces', 'ws_demo', 'config', 'data-sources.jsonc'),
            workspaceId: 'ws_demo',
          },
        ],
      }),
    });
    let checkpointDiagnostics: string | null = null;
    const startTurn = executor.startTurn.bind(executor);
    vi.spyOn(executor, 'startTurn').mockImplementation(async (...args) => {
      const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        checkpointDiagnostics =
          getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', args[1])?.diagnosticsSummary ??
          null;
      } finally {
        workspaceDb.sqlite.close();
      }
      return startTurn(...args);
    });
    const app = createApp({
      coreDb,
      runtimeConfigManager,
      store,
      turnExecutor: executor,
    });
    const input = 'Implement the focused Task Mode fix.';

    try {
      const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        expect(
          workspaceDb.sqlite
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_repository_resources'"
            )
            .all()
        ).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }

      const response = await app.request(
        ...operationRequest(
          path.endsWith('task.start') ? 'task.start' : 'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body:
              responseKind === 'chat'
                ? conversationRequest({ input, requestId })
                : JSON.stringify({ input, requestId }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const responseBody = await response.json();

      expect(response.status, JSON.stringify(responseBody)).toBe(202);
      if (responseKind === 'task') {
        expect(StartTaskModeResponseSchema.parse(responseBody).state).toBe('completed');
      } else {
        expect(SubmitConversationResponseSchema.parse(responseBody)).toMatchObject({
          outcome: 'task-handoff',
          handoff: { targetMode: 'task' },
        });
      }
      expect(executor.startContexts).toHaveLength(1);
      expect(executor.startContexts[0]).toMatchObject({
        workspaceCwd: '/workspace/openkit',
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo_remote',
            sourceCommit: remoteCommit,
            sourceKind: 'remote-git',
            workerPath: '/workspace/openkit',
          },
        ],
        workspaceSourceRefs: { repo_remote: 'main-repo' },
      });
      expect(executor.startContexts[0]?.workerStorageChoice).toBeUndefined();
      const checkpointPayload = JSON.parse(checkpointDiagnostics ?? 'null') as {
        contextAssembly?: Record<string, unknown>;
      };
      expect(checkpointPayload.contextAssembly).toMatchObject({
        contextDigest: expect.any(String),
        contextRefs: expect.arrayContaining([{ kind: 'workspace', id: 'ws_demo' }]),
      });
      expect(checkpointPayload.contextAssembly).not.toHaveProperty('repositoryResourceId');
      expect(
        JSON.stringify({ checkpoint: checkpointPayload, runtime: executor.startContexts[0] })
      ).not.toContain(coreDb.dataRoot);
    } finally {
      vi.restoreAllMocks();
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      entry: 'direct Task',
      path: '/api/app/operations/task.start',
      requestId: '0190f4c8-0000-7000-8000-000000000323',
    },
    {
      entry: 'Chat-to-Task',
      path: '/api/app/operations/conversation.submit',
      requestId: '0190f4c8-0000-7000-8000-000000000324',
    },
  ])('records the product-safe $entry failure in RuntimeEvidence', async ({
    entry,
    path,
    requestId,
  }) => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    vi.spyOn(executor, 'startTurn').mockImplementation(
      async (runtimeStore, turnId, input, context) => {
        executor.startContexts.push(context);
        const turn = runtimeStore.getTurnById(turnId);
        const completedAt = new Date().toISOString();
        if (!turn.agentId) {
          throw new Error('Fake worker turn requires a selected agent id.');
        }
        const agentSessionId = context.agentSessionId ?? `session_${turn.threadId}`;
        const agentSession = runtimeStore.createAgentSession({
          id: agentSessionId,
          agentId: turn.agentId,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          status: 'busy',
          message: null,
          ...(context.sessionCompatibilityKey
            ? { sessionCompatibilityKey: context.sessionCompatibilityKey }
            : {}),
          createdAt: completedAt,
          updatedAt: completedAt,
        });
        runtimeStore.createItem({
          id: `it_user_${turnId}`,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          turnId,
          type: 'user-message',
          status: 'completed',
          actor: turn.triggerActor,
          text: input,
          createdAt: turn.startedAt ?? completedAt,
          completedAt,
        });
        const failedTurn = runtimeStore.updateTurn(turnId, {
          agentSessionId: agentSession.id,
          completedAt,
          error: { code: 'worker_failed', message: 'Worker process exited with code 1.' },
          status: 'failed',
        });
        runtimeStore.updateAgentSession(agentSession.id, {
          message: 'Worker process exited with code 1.',
          status: 'failed',
          updatedAt: completedAt,
        });
        runtimeStore.emitTurnEvent(turnId, {
          event: 'turn.completed',
          requestId: context.requestId ?? null,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          turnId,
          data: { type: 'turn-completed', stopReason: 'error', turn: failedTurn },
        });
      }
    );
    const app = createApp({ coreDb, store, turnExecutor: executor });

    try {
      const response = await app.request(
        ...operationRequest(
          path.endsWith('task.start') ? 'task.start' : 'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body:
              entry === 'Chat-to-Task'
                ? conversationRequest({
                    input: 'Implement the focused Task Mode fix.',
                    requestId,
                  })
                : JSON.stringify({
                    input: 'Implement the focused Task Mode fix.',
                    requestId,
                  }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      expect(response.status, await response.clone().text()).toBe(202);
      if (entry === 'direct Task') {
        const result = StartTaskModeResponseSchema.parse(await response.clone().json());
        expect(result.state).toBe('failed');
        const checkpointDb = openTestWorkspaceDb(coreDb, 'ws_demo');
        try {
          expect(
            getWorkerCheckpoint(checkpointDb, 'ws_demo', 'th_demo', result.turn.id)
          ).toBeNull();
        } finally {
          checkpointDb.sqlite.close();
        }
      }
      const failedTurn = store
        .listThreadTurns('ws_demo', 'th_demo')
        .find((turn) => turn.status === 'failed');
      expect(failedTurn).toBeDefined();

      const evidenceResponse = await app.request('/api/app/workspaces/ws_demo/runtime-evidence');
      expect(evidenceResponse.status, await evidenceResponse.clone().text()).toBe(200);
      const evidence = ListWorkspaceRuntimeEvidenceResponseSchema.parse(
        await evidenceResponse.json()
      ).runtimeEvidence.find((record) => record.turnId === failedTurn?.id);
      expect(evidence).toMatchObject({
        outcome: 'failed',
        phase: 'checkpoint',
        redactedStderrSummary: 'Worker process exited with code 1.',
      });
    } finally {
      vi.restoreAllMocks();
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      status: 'failed' as const,
      stopReason: 'error' as const,
      error: {
        code: 'worker_failed',
        message: 'PRIVATE_WORKER_SOCKET=/var/openkit/secret.sock',
      },
      title: 'Worker Turn failed',
      explanation: 'The selected Worker failed the conversation Turn.',
      requestId: '0190f4c8-0000-7000-8000-000000000327',
    },
    {
      status: 'interrupted' as const,
      stopReason: 'aborted' as const,
      error: {
        code: 'worker_interrupted',
        message: 'PRIVATE_WORKER_SOCKET=/var/openkit/secret.sock',
      },
      title: 'Worker Turn interrupted',
      explanation: 'The selected Worker interrupted the conversation Turn.',
      requestId: '0190f4c8-0000-7000-8000-000000000328',
    },
  ])('states a $status selected Worker result Item and exact replay truthfully', async ({
    error,
    explanation,
    requestId,
    status,
    stopReason,
    title,
  }) => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    vi.spyOn(executor, 'startTurn').mockImplementation(
      async (runtimeStore, turnId, input, context) => {
        executor.startContexts.push(context);
        const turn = runtimeStore.getTurnById(turnId);
        const completedAt = new Date().toISOString();
        if (!turn.agentId) {
          throw new Error('Fake worker turn requires a selected agent id.');
        }
        const agentSessionId = context.agentSessionId ?? `session_${turn.threadId}`;
        const agentSession = runtimeStore.createAgentSession({
          id: agentSessionId,
          agentId: turn.agentId,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          status: 'busy',
          message: null,
          ...(context.sessionCompatibilityKey
            ? { sessionCompatibilityKey: context.sessionCompatibilityKey }
            : {}),
          createdAt: completedAt,
          updatedAt: completedAt,
        });
        runtimeStore.createItem({
          id: `it_user_${turnId}`,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          turnId,
          type: 'user-message',
          status: 'completed',
          actor: turn.triggerActor,
          text: input,
          createdAt: turn.startedAt ?? completedAt,
          completedAt,
        });
        const terminalTurn = runtimeStore.updateTurn(turnId, {
          agentSessionId: agentSession.id,
          completedAt,
          error,
          status,
        });
        runtimeStore.updateAgentSession(agentSession.id, {
          message: error?.message ?? 'The selected Worker was interrupted.',
          status: 'failed',
          updatedAt: completedAt,
        });
        runtimeStore.emitTurnEvent(turnId, {
          event: 'turn.completed',
          requestId: context.requestId ?? null,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          turnId,
          data: { type: 'turn-completed', stopReason, turn: terminalTurn },
        });
      }
    );
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const requestBody = JSON.stringify({
      artifactRefs: [],
      input: 'Implement the focused Task Mode fix.',
      requestId,
      targetRef: 'new-task-worker',
    });

    try {
      const response = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            body: requestBody,
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
      expect(response.status, await response.clone().text()).toBe(202);
      const result = SubmitConversationResponseSchema.parse(await response.json());
      expect(result).toMatchObject({
        explanation,
        item: {
          id: `it_worker_result_${result.turn.id}`,
          level: 'warning',
          summary: 'Worker turn ended without success.',
          title,
          type: 'status',
        },
        outcome: 'accepted',
        targetRef: 'new-task-worker',
        turn: { error, status },
      });
      expect(JSON.stringify(result.item)).not.toContain(error.message);
      expect(result.explanation).not.toContain(error.message);
      const replay = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            body: requestBody,
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
      expect(replay.status, await replay.clone().text()).toBe(202);
      expect(SubmitConversationResponseSchema.parse(await replay.json())).toEqual(result);
      expect(executor.startContexts).toHaveLength(1);
      expect(() => store.updateItem(result.item.id, { title: 'Worker Turn accepted' })).toThrow(
        /is terminal and does not admit this write/
      );
    } finally {
      vi.restoreAllMocks();
      coreDb.sqlite.close();
    }
  });

  it('recovers a direct Task receipt from its terminal checkpoint without another worker turn', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-task-receipt-recovery-'));
    const requestId = '0190f4c8-0000-7000-8000-000000000302';
    const input = 'Implement the focused Task receipt recovery fix.';

    seedWritableGitRepository(repositoryPath);

    try {
      const receiptWrite = vi.spyOn(store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('simulated Task receipt write failure');
      });
      const firstRes = await app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: JSON.stringify({ requestId, input }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      receiptWrite.mockRestore();

      expect(firstRes.status).toBe(409);
      await expect(firstRes.json()).resolves.toMatchObject({ code: 'recovery_required' });
      const turns = store.listThreadTurns('ws_demo', 'th_demo');
      expect(turns).toHaveLength(1);
      const turn = turns[0]!;
      const checkpointDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        const checkpoints = listExportableWorkerCheckpoints(checkpointDb, 'ws_demo');
        expect(checkpoints).toEqual([
          expect.objectContaining({
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: turn.id,
            goalId: null,
            taskId: null,
            requestId,
            stage: 'completed',
            stopReason: 'completed',
          }),
        ]);
        await expect(
          classifyDirectTaskCheckpointAfterSchedulerRecovery({
            coreDb,
            store,
            workspaceDb: checkpointDb,
            checkpoint: { ...checkpoints[0]!, taskId: 'contradictory-task' },
          })
        ).rejects.toMatchObject({ code: 'recovery_required' });
        await expect(
          classifyDirectTaskCheckpointAfterSchedulerRecovery({
            coreDb,
            store,
            workspaceDb: checkpointDb,
            checkpoint: checkpoints[0]!,
          })
        ).resolves.toBe('complete');
        expect(getWorkerCheckpoint(checkpointDb, 'ws_demo', 'th_demo', turn.id)).toBeNull();
      } finally {
        checkpointDb.sqlite.close();
      }

      const conflictRes = await app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: JSON.stringify({ requestId, input: 'Implement a different Task result.' }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      expect(conflictRes.status).toBe(409);
      await expect(conflictRes.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });
      expect(executor.startContexts).toHaveLength(1);

      const replayRes = await app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: JSON.stringify({ requestId, input }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(replayRes.status).toBe(202);
      expect(StartTaskModeResponseSchema.parse(await replayRes.json())).toMatchObject({
        state: 'completed',
        turn: { id: turn.id },
      });
      expect(executor.startContexts).toHaveLength(1);
      expect(
        store.getCommandRequest('task.start', requestId, {
          actorId: LOCAL_USER_ID,
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
        })
      ).not.toBeNull();
      const recoveredDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        expect(getWorkerCheckpoint(recoveredDb, 'ws_demo', 'th_demo', turn.id)).toBeNull();
      } finally {
        recoveredDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      expected: 'complete' as const,
      receipt: 'exact' as const,
      stopReason: 'completed' as const,
    },
    {
      expected: 'complete' as const,
      receipt: 'exact' as const,
      stopReason: 'error' as const,
    },
    {
      expected: 'reject' as const,
      receipt: 'missing' as const,
      stopReason: 'completed' as const,
    },
    {
      expected: 'reject' as const,
      receipt: 'chat-thread' as const,
      stopReason: 'completed' as const,
    },
  ])('classifies a conversation-owned $stopReason checkpoint from its $receipt owner receipt', async ({
    expected,
    receipt,
    stopReason,
  }) => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const chatThreadId = 'th_demo';
    const taskThreadId = 'th_task_conversation_boot';
    const turnId = 'tu_conversation_23b052e60543c617577173cc';
    const requestId = '0190f4c8-0000-7000-8000-000000000410';
    const requestInputHash = 'sha256:conversation-worker-boot';
    const agentSessionId = 'as_conversation_boot';
    const failed = stopReason === 'error';
    const completedAt = '2026-09-10T09:11:15.000Z';
    store.createThread('ws_demo', 'Conversation worker Task thread', taskThreadId);
    const turn = store.createTurn(
      'ws_demo',
      taskThreadId,
      'Conversation-owned worker Turn',
      { kind: 'user', id: LOCAL_USER_ID },
      null,
      { turnId }
    );
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: turn.startedAt ?? completedAt,
      id: agentSessionId,
      message: null,
      status: failed ? 'failed' : 'idle',
      threadId: taskThreadId,
      updatedAt: completedAt,
      workspaceId: 'ws_demo',
    });
    const closedTurn = store.updateTurn(turn.id, {
      agentId: 'agent_codex_host',
      agentSessionId,
      completedAt,
      status: failed ? 'failed' : 'completed',
    });
    store.emitTurnEvent(turn.id, {
      data: { stopReason, turn: closedTurn, type: 'turn-completed' },
      event: 'turn.completed',
      requestId,
      threadId: taskThreadId,
      turnId: turn.id,
      workspaceId: 'ws_demo',
    });
    createSchedulerAdmissionEntry(coreDb, {
      triggerActor: { kind: 'user', id: LOCAL_USER_ID },
      priorityClass: 'interactive',
      profileRef: 'agent_codex_host',
      queueEntryId: `queue_${turn.id}`,
      requestId,
      requestedAgentId: 'agent_codex_host',
      requiredPoolConstraints: ['openshell.local'],
      threadId: taskThreadId,
      turnId: turn.id,
      turnInput: 'Conversation-owned worker Turn',
      workspaceId: 'ws_demo',
    });
    createSchedulerPlacementPlan(coreDb, {
      degradedOptionalFeatures: [],
      expectedControlMode: 'poll',
      expectedDataPlaneMode: 'openshell-files',
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      planId: `plan_${turn.id}`,
      plannedLeaseDurationMs: 900_000,
      policyDecisionIds: [],
      queueEntryId: `queue_${turn.id}`,
      schedulerEpoch: 1,
      selectedPoolId: 'pool_local',
      selectedTargetId: 'target_local',
    });
    createSchedulerSessionLease(coreDb, {
      agentSessionId,
      expiresAt: '2099-01-01T01:00:00.000Z',
      heartbeatDeadline: '2099-01-01T00:10:00.000Z',
      leaseId: `lease_${turn.id}`,
      packageSnapshotId: `aepsnap_${turn.id}`,
      planId: `plan_${turn.id}`,
      sandboxTokenBindingRef: `lease-binding:lease_${turn.id}`,
      startupDeadline: '2099-01-01T00:05:00.000Z',
    });
    coreDb.sqlite
      .prepare(
        `UPDATE scheduler_session_leases
           SET status = ?, release_reason = ?, recovery_state = ?, recovery_deadline = ?
           WHERE lease_id = ?`
      )
      .run(
        failed ? 'failed' : 'released',
        failed ? 'turn-failed' : 'turn-completed',
        failed ? 'needs-evidence' : null,
        null,
        `lease_${turn.id}`
      );
    if (receipt !== 'missing') {
      store.recordCommandRequest({
        command: 'conversation.submit',
        requestId,
        scope: {
          actorId: LOCAL_USER_ID,
          threadId: chatThreadId,
          workspaceId: 'ws_demo',
        },
        inputHash: requestInputHash,
        response: {
          kind: 'turn',
          id: turn.id,
          conversationMetadata: {
            downstream: { kind: 'task', turnId: turn.id },
            targetRef: 'internal-role:assistant',
            logicalModelId: 'orcarouter',
            receivingWorkspaceId: 'ws_demo',
            receivingThreadId: receipt === 'exact' ? taskThreadId : chatThreadId,
            resultKind: 'worker-turn',
            status: 202,
          },
        },
      });
    }
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
        iteration: 0,
        requestId,
        requestInputHash,
        stage: failed ? 'failed' : 'completed',
        stopReason,
        threadId: taskThreadId,
        turnId: turn.id,
        workerSessionId: agentSessionId,
        workspaceId: 'ws_demo',
      });
      const classification = classifyDirectTaskCheckpointAfterSchedulerRecovery({
        checkpoint,
        coreDb,
        store,
        workspaceDb,
      });
      if (expected === 'complete') {
        await expect(classification).resolves.toBe('complete');
        expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', taskThreadId, turn.id)).toBeNull();
        expect(
          store.listCommandRequests().filter((record) => record.command === 'task.start')
        ).toEqual([]);
        expect(
          store.listCommandRequests().filter((record) => record.command === 'conversation.submit')
        ).toHaveLength(1);
        return;
      }
      await expect(classification).rejects.toMatchObject({ code: 'recovery_required' });
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', taskThreadId, turn.id)).toEqual(
        checkpoint
      );
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    'failed',
    'completed',
    'cancelled',
  ] as const)('clears a terminal Task checkpoint with no scheduler lease when the product Turn is %s', async (status) => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const threadId = `th_task_stale_boot_${status}`;
    const turnId = `turn_stale_boot_no_lease_${status}`;
    const requestId = `0190f4c8-0000-7000-8000-00000000048${status === 'failed' ? '9' : status === 'completed' ? 'a' : 'b'}`;
    const completedAt = '2026-09-15T13:38:10.000Z';
    store.createThread('ws_demo', 'Stale boot Task thread', threadId);
    const turn = store.createTurn(
      'ws_demo',
      threadId,
      'Stale boot Task Turn',
      { kind: 'user', id: LOCAL_USER_ID },
      null,
      { turnId }
    );
    store.updateTurn(turn.id, {
      completedAt,
      ...(status === 'failed'
        ? {
            error: {
              code: 'scheduler_admission_deferred',
              message: 'Turn was queued but not dispatched.',
            },
          }
        : {}),
      status,
    });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
        iteration: 0,
        requestId,
        requestInputHash: `sha256:stale-boot-no-lease-${status}`,
        stage: status === 'cancelled' ? 'aborted' : status === 'completed' ? 'completed' : 'failed',
        stopReason:
          status === 'cancelled' ? 'aborted' : status === 'completed' ? 'completed' : 'error',
        threadId,
        turnId: turn.id,
        workspaceId: 'ws_demo',
      });
      expect(checkpoint.workerSessionId).toBeNull();
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          checkpoint,
          coreDb,
          store,
          workspaceDb,
        })
      ).resolves.toBe('complete');
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', threadId, turn.id)).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('clears a terminal Task checkpoint whose failed lease session does not match a null worker session', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const threadId = 'th_task_stale_failed_lease';
    const turnId = 'turn_stale_boot_failed_lease';
    const requestId = '0190f4c8-0000-7000-8000-000000000490';
    const requestInputHash = 'sha256:stale-boot-failed-lease';
    const completedAt = '2026-09-15T11:29:35.000Z';
    store.createThread('ws_demo', 'Stale failed-lease Task thread', threadId);
    const turn = store.createTurn(
      'ws_demo',
      threadId,
      'Stale failed-lease Task Turn',
      { kind: 'user', id: LOCAL_USER_ID },
      null,
      { turnId }
    );
    store.updateTurn(turn.id, {
      completedAt,
      error: { code: 'turn_start_failed', message: 'Worker start failed.' },
      status: 'failed',
    });
    recordWorkerRetryLease(coreDb, {
      agentSessionId: 'as_stale_failed_lease',
      recoveryState: null,
      releaseReason: 'turn-start-failed',
      status: 'failed',
      threadId,
      turnId: turn.id,
    });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
        iteration: 0,
        requestId,
        requestInputHash,
        stage: 'failed',
        stopReason: 'error',
        threadId,
        turnId: turn.id,
        workspaceId: 'ws_demo',
      });
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          checkpoint,
          coreDb,
          store,
          workspaceDb,
        })
      ).resolves.toBe('complete');
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', threadId, turn.id)).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    'failed',
    'completed',
    'cancelled',
  ] as const)('clears a null-session turn-start-failed needs-evidence checkpoint without retained provenance when the Turn is %s', async (status) => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const threadId = `th_task_provenance_skip_${status}`;
    const turnId = `turn_provenance_skip_${status}`;
    const requestId = `0190f4c8-0000-7000-8000-0000000004c${status === 'failed' ? '1' : status === 'completed' ? '2' : '3'}`;
    const agentSessionId = `as_provenance_skip_${status}`;
    const completedAt = '2026-09-15T13:38:10.000Z';
    store.createThread('ws_demo', 'Provenance skip Task thread', threadId);
    const turn = store.createTurn(
      'ws_demo',
      threadId,
      'Provenance skip Task Turn',
      { kind: 'user', id: LOCAL_USER_ID },
      null,
      { turnId }
    );
    store.updateTurn(turn.id, {
      completedAt,
      ...(status === 'failed'
        ? { error: { code: 'turn_start_failed', message: 'Worker start failed.' } }
        : {}),
      status,
    });
    recordWorkerRetryLease(coreDb, {
      agentSessionId,
      recoveryState: 'needs-evidence',
      releaseReason: 'turn-start-failed',
      status: 'failed',
      threadId,
      turnId: turn.id,
    });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      recordProvenanceRequiredStaleBootPackage(store, workspaceDb, turn.id, agentSessionId);
      const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
        iteration: 0,
        requestId,
        requestInputHash: `sha256:provenance-skip-${status}`,
        stage: status === 'cancelled' ? 'aborted' : status === 'completed' ? 'completed' : 'failed',
        stopReason:
          status === 'cancelled' ? 'aborted' : status === 'completed' ? 'completed' : 'error',
        threadId,
        turnId: turn.id,
        workspaceId: 'ws_demo',
      });
      expect(checkpoint.workerSessionId).toBeNull();
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          checkpoint,
          coreDb,
          store,
          workspaceDb,
        })
      ).resolves.toBe('complete');
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', threadId, turn.id)).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      label: 'another release reason',
      recoveryState: 'needs-evidence' as const,
      releaseReason: 'turn-failed',
      suffix: 'release',
    },
    {
      label: 'another recovery state',
      recoveryState: null,
      releaseReason: 'turn-start-failed',
      suffix: 'recovery',
    },
  ])('keeps required provenance for a null-session leftover with $label', async ({
    recoveryState,
    releaseReason,
    suffix,
  }) => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const threadId = `th_task_provenance_keep_${suffix}`;
    const turnId = `turn_provenance_keep_${suffix}`;
    const requestId = `0190f4c8-0000-7000-8000-0000000004c${suffix === 'release' ? '4' : '5'}`;
    const agentSessionId = `as_provenance_keep_${suffix}`;
    const completedAt = '2026-09-15T13:38:10.000Z';
    store.createThread('ws_demo', 'Provenance keep Task thread', threadId);
    const turn = store.createTurn(
      'ws_demo',
      threadId,
      'Provenance keep Task Turn',
      { kind: 'user', id: LOCAL_USER_ID },
      null,
      { turnId }
    );
    store.updateTurn(turn.id, {
      completedAt,
      error: { code: 'turn_start_failed', message: 'Worker start failed.' },
      status: 'failed',
    });
    recordWorkerRetryLease(coreDb, {
      agentSessionId,
      recoveryState,
      releaseReason,
      status: 'failed',
      threadId,
      turnId: turn.id,
    });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      recordProvenanceRequiredStaleBootPackage(store, workspaceDb, turn.id, agentSessionId);
      const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
        iteration: 0,
        requestId,
        requestInputHash: `sha256:provenance-keep-${suffix}`,
        stage: 'failed',
        stopReason: 'error',
        threadId,
        turnId: turn.id,
        workspaceId: 'ws_demo',
      });
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          checkpoint,
          coreDb,
          store,
          workspaceDb,
        })
      ).rejects.toThrow('Required retained runtime provenance is missing.');
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', threadId, turn.id)).toEqual(checkpoint);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('keeps a preparing Task checkpoint without a scheduler lease fail-closed', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const threadId = 'th_task_live_boot';
    const turnId = 'turn_live_boot_no_lease';
    const requestId = '0190f4c8-0000-7000-8000-000000000491';
    store.createThread('ws_demo', 'Live boot Task thread', threadId);
    const turn = store.createTurn(
      'ws_demo',
      threadId,
      'Live boot Task Turn',
      { kind: 'user', id: LOCAL_USER_ID },
      null,
      { turnId }
    );
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
        iteration: 0,
        requestId,
        requestInputHash: 'sha256:live-boot-no-lease',
        stage: 'preparing',
        threadId,
        turnId: turn.id,
        workspaceId: 'ws_demo',
      });
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          checkpoint,
          coreDb,
          store,
          workspaceDb,
        })
      ).rejects.toMatchObject({
        code: 'recovery_required',
        message: 'The boot Task checkpoint has no exact scheduler lease.',
      });
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', threadId, turn.id)).toEqual(checkpoint);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('keeps a failed Task checkpoint fail-closed when its product Turn is interrupted', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const threadId = 'th_task_interrupted_boot';
    const turnId = 'turn_interrupted_boot_no_lease';
    const requestId = '0190f4c8-0000-7000-8000-000000000492';
    store.createThread('ws_demo', 'Interrupted boot Task thread', threadId);
    const turn = store.createTurn(
      'ws_demo',
      threadId,
      'Interrupted boot Task Turn',
      { kind: 'user', id: LOCAL_USER_ID },
      null,
      { turnId }
    );
    store.updateTurn(turn.id, { status: 'interrupted' });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
        iteration: 0,
        requestId,
        requestInputHash: 'sha256:interrupted-boot-no-lease',
        stage: 'failed',
        stopReason: 'error',
        threadId,
        turnId: turn.id,
        workspaceId: 'ws_demo',
      });
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          checkpoint,
          coreDb,
          store,
          workspaceDb,
        })
      ).rejects.toMatchObject({
        code: 'recovery_required',
        message: 'The boot Task checkpoint still has a live product Turn.',
      });
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', threadId, turn.id)).toEqual(checkpoint);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('keeps a failed Task checkpoint fail-closed when a live scheduler lease remains', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const threadId = 'th_task_live_lease_boot';
    const turnId = 'turn_live_lease_boot';
    const requestId = '0190f4c8-0000-7000-8000-000000000493';
    store.createThread('ws_demo', 'Live-lease boot Task thread', threadId);
    const turn = store.createTurn(
      'ws_demo',
      threadId,
      'Live-lease boot Task Turn',
      { kind: 'user', id: LOCAL_USER_ID },
      null,
      { turnId }
    );
    store.updateTurn(turn.id, {
      completedAt: '2026-09-15T13:38:10.000Z',
      error: { code: 'worker_failed', message: 'Worker failed.' },
      status: 'failed',
    });
    recordWorkerRetryLease(coreDb, {
      agentSessionId: 'as_live_lease_boot',
      recoveryState: null,
      releaseReason: null,
      status: 'active',
      threadId,
      turnId: turn.id,
    });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
        iteration: 0,
        requestId,
        requestInputHash: 'sha256:live-lease-boot',
        stage: 'failed',
        stopReason: 'error',
        threadId,
        turnId: turn.id,
        workspaceId: 'ws_demo',
      });
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          checkpoint,
          coreDb,
          store,
          workspaceDb,
        })
      ).rejects.toMatchObject({
        code: 'recovery_required',
        message: 'The boot Task checkpoint still has a live scheduler lease.',
      });
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', threadId, turn.id)).toEqual(checkpoint);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('keeps a failed Task checkpoint fail-closed when its product Turn is missing', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const threadId = 'th_task_missing_turn_boot';
    const turnId = 'turn_missing_turn_boot';
    store.createThread('ws_demo', 'Missing-turn boot Task thread', threadId);
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
        iteration: 0,
        requestId: '0190f4c8-0000-7000-8000-000000000494',
        requestInputHash: 'sha256:missing-turn-boot',
        stage: 'failed',
        stopReason: 'error',
        threadId,
        turnId,
        workspaceId: 'ws_demo',
      });
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          checkpoint,
          coreDb,
          store,
          workspaceDb,
        })
      ).rejects.toMatchObject({
        code: 'recovery_required',
        message: 'The Task checkpoint is missing its worker Turn.',
      });
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', threadId, turnId)).toEqual(checkpoint);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects Task Mode in the Quick Chat workspace', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const store = createDemoStore();
    const thread = store.createThread('ws_quick_chat', 'Reject Task Mode');
    const app = createApp({ coreDb, store, turnExecutor: executor });

    try {
      const res = await app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: 'ws_quick_chat', threadId: thread.id },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: '0190f4c8-0000-7000-8000-000000000319',
              input: 'Implement a focused fix.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        code: 'workspace_kind_not_supported',
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('projects Task Mode review evidence when worker output stages workspace changes', async () => {
    const coreDb = createCoreDb();
    const executor = new (class extends FakeTurnExecutor {
      public override async startTurn(
        store: FsStore,
        turnId: string,
        input: string,
        context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
      ): Promise<void> {
        const runningTurn = store.getTurnById(turnId);
        const timestamp = runningTurn.startedAt ?? new Date().toISOString();
        const patchText = 'diff --git a/docs/task.md b/docs/task.md\n';
        const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
        const artifact = store.createArtifact({
          id: `ar_task_review_${turnId}`,
          workspaceId: runningTurn.workspaceId,
          threadId: runningTurn.threadId,
          turnId,
          kind: 'diff',
          title: 'Task Mode workspace changes',
          status: 'ready',
          summary: 'Task Mode workspace changes ready for review.',
          version: 1,
          content: { format: 'text', body: patchText },
          contentDigest: artifactDigest(patchText),
          lastMutationRequestId: context.requestId!,
          origin: {
            kind: 'turn-output',
            threadId: runningTurn.threadId,
            turnId,
            requestId: context.requestId!,
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await super.startTurn(store, turnId, input, context);
        const reviewId = `swr_task_${turnId}`;
        const workspaceDb = openTestWorkspaceDb(coreDb, runningTurn.workspaceId);
        const item: Parameters<typeof recordWorkspaceSyncReview>[1]['item'] = {
          artifactId: artifact.id,
          changeSet: {
            artifactIds: [artifact.id],
            base: { commit: 'abc123', contentDigest: null },
            bundle: null,
            changedPaths: [{ binary: false, path: 'docs/task.md', status: 'modified' }],
            createdAt: timestamp,
            evidenceRefs: [{ kind: 'worker', ref: turnId }],
            head: { commit: 'def456', contentDigest: null },
            id: `wcs_${turnId}`,
            inputSnapshotId: `wis_${turnId}`,
            materializationRecordId: `wmr_${turnId}`,
            patch: {
              bytes: Buffer.byteLength(patchText, 'utf8'),
              digest: patchDigest,
              ref: `artifact://${artifact.id}`,
            },
            redaction: { notes: [], status: 'redacted' },
            resourceId: 'repo_default',
            strategy: 'git',
            workspaceId: runningTurn.workspaceId,
          },
          patchPayload: {
            bytes: Buffer.byteLength(patchText, 'utf8'),
            digest: patchDigest,
            mediaType: 'text/x-diff',
            text: patchText,
          },
          review: {
            actionCenterRowId: `workspace-review:${reviewId}`,
            changeSetId: `wcs_${turnId}`,
            createdAt: timestamp,
            diffSummary: { additions: 1, deletions: 0, filesChanged: 1 },
            id: reviewId,
            riskSummary: '1 changed path staged for human review.',
            staging: {
              branch: `openkit/review/${reviewId}`,
              ref: `staging://workspace/${turnId}`,
              strategy: 'git_worktree',
            },
            status: 'pending',
            updatedAt: timestamp,
            validation: [],
            workspaceId: runningTurn.workspaceId,
          },
        };

        try {
          recordTestWorkspaceReviewMaterialization(workspaceDb, item);
          recordWorkspaceSyncReview(workspaceDb, { item });
        } finally {
          workspaceDb.sqlite.close();
        }
      }
    })();
    const app = createApp({ coreDb, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-task-mode-review-repository-'));

    seedWritableGitRepository(repositoryPath);

    try {
      const res = await app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: '0190f4c8-0000-7000-8000-000000000311',
              input: 'Implement the focused Task Mode fix.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status, await res.clone().text()).toBe(202);
      const parsed = StartTaskModeResponseSchema.parse(await res.json());

      expect(parsed.evidence.artifactIds).toContain(`ar_task_review_${parsed.turn.id}`);
      expect(parsed.evidence.reviewIds).toEqual([`swr_task_${parsed.turn.id}`]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('starts Task Mode when Chat Mode accepts a task handoff', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-chat-task-handoff-repository-'));
    const requestId = '0190f4c8-0000-7000-8000-000000000305';
    const input = 'Implement the focused Task Mode fix.';

    seedWritableGitRepository(repositoryPath);

    try {
      const res = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: conversationRequest({ requestId, input }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status).toBe(202);
      const parsed = SubmitConversationResponseSchema.parse(await res.json());
      const acceptedTurnIds = store
        .listThreadTurns('ws_demo', 'th_demo')
        .map((turn) => turn.id)
        .sort();

      const replayRes = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: conversationRequest({ requestId, input }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const conflictRes = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: conversationRequest({
              requestId,
              input: 'Implement a different focused Task Mode fix.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const directTaskRes = await app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: JSON.stringify({ requestId, input }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(parsed).toMatchObject({
        outcome: 'task-handoff',
        handoff: { targetMode: 'task' },
        item: { type: 'status', title: 'Task Mode handoff' },
      });
      expect(replayRes.status).toBe(202);
      const replay = SubmitConversationResponseSchema.parse(await replayRes.json());
      expect(replay.turn.id).toBe(parsed.turn.id);
      expect(replay.item.id).toBe(parsed.item.id);
      expect(replay.handoff).toEqual(parsed.handoff);
      expect(conflictRes.status).toBe(409);
      await expect(conflictRes.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });
      expect(directTaskRes.status, await directTaskRes.clone().text()).toBe(202);
      const directTask = StartTaskModeResponseSchema.parse(await directTaskRes.json());
      expect(acceptedTurnIds).not.toContain(directTask.turn.id);
      expect(executor.startContexts).toHaveLength(2);
      expect(executor.startContexts[0]).toMatchObject({
        requestId,
      });
      expect(
        store
          .listThreadTurns('ws_demo', 'th_demo')
          .map((turn) => turn.id)
          .sort()
      ).toEqual([...acceptedTurnIds, directTask.turn.id].sort());
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails closed without rerouting a Chat-to-Task owner whose outer receipt was not published', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const coordinator = vi.spyOn(workerCoordinator, 'createWorkerCoordinatorDecision');
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-chat-task-receipt-gap-'));
    const requestId = '0190f4c8-0000-7000-8000-000000000307';
    const input = 'Implement the focused Task Mode fix.';

    seedWritableGitRepository(repositoryPath);

    try {
      const receiptWrite = vi.spyOn(store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('simulated Chat receipt write failure');
      });
      const first = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: conversationRequest({ requestId, input }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      receiptWrite.mockRestore();
      const firstBody = await first.json();
      const turnIdsAfterFirst = store
        .listThreadTurns('ws_demo', 'th_demo')
        .map((turn) => turn.id)
        .sort();
      const workerTurn = store
        .listThreadTurns('ws_demo', 'th_demo')
        .find((turn) => turn.id.startsWith(`turn_${requestId}_`));

      expect(workerTurn).toBeDefined();
      if (!workerTurn) {
        throw new Error('The Chat-subordinate worker Turn was not created.');
      }
      const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        expect(
          getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', workerTurn.id)
        ).not.toBeNull();
      } finally {
        workspaceDb.sqlite.close();
      }
      expect.soft(first.status, JSON.stringify(firstBody)).toBe(409);
      expect.soft(firstBody).toMatchObject({ code: 'recovery_required' });
      expect
        .soft(
          store.getCommandRequest('conversation.submit', requestId, {
            actorId: LOCAL_USER_ID,
            threadId: 'th_demo',
            workspaceId: 'ws_demo',
          })
        )
        .toBeNull();
      expect(coordinator).toHaveBeenCalledTimes(1);
      expect(executor.startContexts).toHaveLength(1);

      const retry = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: conversationRequest({ requestId, input }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const retryBody = await retry.json();

      expect.soft(retry.status, JSON.stringify(retryBody)).toBe(409);
      expect.soft(retryBody).toMatchObject({ code: 'recovery_required' });
      expect(coordinator).toHaveBeenCalledTimes(1);
      expect(executor.startContexts).toHaveLength(1);
      expect(
        store
          .listThreadTurns('ws_demo', 'th_demo')
          .map((turn) => turn.id)
          .sort()
      ).toEqual(turnIdsAfterFirst);
    } finally {
      coordinator.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      changedInput: 'help',
      name: 'clarification',
      requestId: '0190f4c8-0000-7000-8000-000000000310',
    },
    {
      changedInput: 'search the web',
      name: 'external-search refusal',
      requestId: '0190f4c8-0000-7000-8000-000000000311',
    },
  ])('rejects $name rerouting after the same Chat-to-Task request lost its outer receipt', async ({
    changedInput,
    requestId,
  }) => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const coordinator = vi.spyOn(workerCoordinator, 'createWorkerCoordinatorDecision');
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-chat-task-reroute-gap-'));
    const taskInput = 'Implement the focused Task Mode fix.';

    seedWritableGitRepository(repositoryPath);

    try {
      const receiptWrite = vi.spyOn(store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('simulated Chat receipt write failure');
      });
      await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: conversationRequest({ requestId, input: taskInput }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      receiptWrite.mockRestore();
      const workerTurn = store
        .listThreadTurns('ws_demo', 'th_demo')
        .find((turn) => turn.id.startsWith(`turn_${requestId}_`));
      expect(workerTurn).toBeDefined();
      if (!workerTurn) {
        throw new Error('The Chat-subordinate worker Turn was not created.');
      }
      const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        expect(
          getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', workerTurn.id)
        ).not.toBeNull();
      } finally {
        workspaceDb.sqlite.close();
      }
      const turnsBeforeReroute = store
        .listThreadTurns('ws_demo', 'th_demo')
        .map((turn) => turn.id)
        .sort();
      expect(coordinator).toHaveBeenCalledTimes(1);
      expect(executor.startContexts).toHaveLength(1);

      const reroute = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: conversationRequest({ requestId, input: changedInput }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const rerouteBody = await reroute.json();

      expect.soft(reroute.status, JSON.stringify(rerouteBody)).toBe(409);
      expect.soft(rerouteBody).toMatchObject({ code: 'recovery_required' });
      expect
        .soft(
          store.getCommandRequest('conversation.submit', requestId, {
            actorId: LOCAL_USER_ID,
            threadId: 'th_demo',
            workspaceId: 'ws_demo',
          })
        )
        .toBeNull();
      expect(coordinator).toHaveBeenCalledTimes(1);
      expect(executor.startContexts).toHaveLength(1);
      expect(
        store
          .listThreadTurns('ws_demo', 'th_demo')
          .map((turn) => turn.id)
          .sort()
      ).toEqual(turnsBeforeReroute);
    } finally {
      coordinator.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('rejects a forged Chat replay that points at the same-request direct Task Turn', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-chat-task-forged-replay-'));
    const forgedRequestId = '0190f4c8-0000-7000-8000-000000000309';
    const input = 'Implement the focused Task Mode fix.';

    seedWritableGitRepository(repositoryPath);

    try {
      const receiptWrite = vi.spyOn(store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('simulated Chat receipt write failure');
      });
      const gapResponse = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: conversationRequest({ requestId: forgedRequestId, input }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      receiptWrite.mockRestore();
      const gapBody = await gapResponse.json();
      expect.soft(gapResponse.status, JSON.stringify(gapBody)).toBe(409);
      expect.soft(gapBody).toMatchObject({ code: 'recovery_required' });
      const outerChatTurn = store
        .listThreadTurns('ws_demo', 'th_demo')
        .find((turn) => turn.items.some((item) => item.id === `it_chat_task_${turn.id}`));
      expect(outerChatTurn).toBeDefined();
      if (!outerChatTurn) {
        throw new Error('The exact-request outer Chat Turn was not created.');
      }
      const directTaskResponse = await app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: JSON.stringify({ requestId: forgedRequestId, input }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      expect(directTaskResponse.status, await directTaskResponse.clone().text()).toBe(202);
      const directTask = StartTaskModeResponseSchema.parse(await directTaskResponse.json());
      expect(directTask.turn.id).toMatch(new RegExp(`^turn_${forgedRequestId}_`));

      store.recordCommandRequest({
        command: 'conversation.submit',
        requestId: forgedRequestId,
        scope: {
          actorId: LOCAL_USER_ID,
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
        inputHash: commandInputHash({
          input,
          targetRef: 'internal-role:assistant',
          logicalModelId: null,
          artifactRefs: [],
        }),
        response: {
          kind: 'turn',
          id: outerChatTurn.id,
          conversationMetadata: {
            downstream: { kind: 'task', turnId: directTask.turn.id },
            targetRef: 'internal-role:assistant',
            logicalModelId: null,
            receivingWorkspaceId: 'ws_demo',
            receivingThreadId: 'th_demo',
            resultKind: 'task-handoff',
            status: 202,
          },
        },
      });
      const startsBeforeReplay = executor.startContexts.length;
      const turnsBeforeReplay = store.listThreadTurns('ws_demo', 'th_demo').map((turn) => turn.id);

      const replay = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: conversationRequest({ requestId: forgedRequestId, input }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const replayBody = await replay.json();

      expect(replay.status, JSON.stringify(replayBody)).toBe(409);
      expect(replayBody).toMatchObject({ code: 'recovery_required' });
      expect(executor.startContexts).toHaveLength(startsBeforeReplay);
      expect(store.listThreadTurns('ws_demo', 'th_demo').map((turn) => turn.id)).toEqual(
        turnsBeforeReplay
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('starts Goal Mode when Chat Mode accepts a goal handoff', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });

    try {
      const res = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: conversationRequest({
              requestId: '0190f4c8-0000-7000-8000-000000000306',
              input: 'Plan a multi-step release goal for NanoCore.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toMatchObject({
        outcome: 'goal-handoff',
        handoff: { targetMode: 'goal' },
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('asks for clarification for vague Chat Mode help prompts', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });

    try {
      for (const [index, input] of ['Can you help with this?', 'What should I do?'].entries()) {
        const res = await app.request(
          ...operationRequest(
            'conversation.submit',
            { workspaceId: 'ws_demo', threadId: 'th_demo' },
            {
              method: 'POST',
              body: conversationRequest({
                requestId: `0190f4c8-0000-7000-8000-00000000031${index}`,
                input,
              }),
              headers: { 'content-type': 'application/json' },
            }
          )
        );

        expect(res.status).toBe(202);
        const parsed = SubmitConversationResponseSchema.parse(await res.json());

        expect(parsed).toMatchObject({
          outcome: 'clarification-needed',
          item: { type: 'user-input-request' },
          turn: { status: 'completed' },
        });
      }
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('allows lightweight Chat Mode in the Quick Chat workspace without starting workers', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const thread = store.createThread('ws_quick_chat', 'Quick Chat thread');

    try {
      const res = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_quick_chat', threadId: thread.id },
          {
            method: 'POST',
            body: conversationRequest({
              requestId: '0190f4c8-0000-7000-8000-000000000321',
              input: 'Can you help with this?',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status).toBe(202);
      const parsed = SubmitConversationResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        outcome: 'clarification-needed',
        handoff: null,
        turn: { workspaceId: 'ws_quick_chat', threadId: thread.id, status: 'completed' },
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects project work prompts in Quick Chat Chat Mode without coordinator handoff', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const thread = store.createThread('ws_quick_chat', 'Quick Chat project request');

    try {
      const res = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_quick_chat', threadId: thread.id },
          {
            method: 'POST',
            body: conversationRequest({
              requestId: '0190f4c8-0000-7000-8000-000000000322',
              input: 'Implement the focused worker fix.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        code: 'workspace_kind_not_supported',
        message: expect.stringContaining('Quick Chat workspace'),
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses Chat Mode external search requests until a search capability exists', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });

    try {
      const res = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: conversationRequest({
              requestId: '0190f4c8-0000-7000-8000-000000000320',
              input: 'Search the web for NanoCore release notes.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status).toBe(200);
      const parsed = SubmitConversationResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        outcome: 'refused',
        explanation: 'External search is not enabled for Chat Mode.',
        handoff: null,
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('answers the exact live Goal Web report prompt from an attached Artifact in Quick Chat', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const prompts: string[] = [];
    const thread = store.createThread('ws_quick_chat', 'Live Goal Web report');
    const artifact = createImportedMarkdownArtifact(store, {
      id: 'ar_live_goal_web_report',
      workspaceId: 'ws_quick_chat',
      title: '维护报告',
      body: `# Maintenance report\n\n${LIVE_GOAL_WEB_REPORT_MARKER}\n`,
      requestId: 'artifact-import-live-goal-web-1',
    });
    const app = createApp({
      coreDb,
      store,
      turnExecutor: executor,
      ...chatAnsweringProvider(prompts),
    });

    try {
      const res = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_quick_chat', threadId: thread.id },
          {
            method: 'POST',
            body: conversationRequest({
              requestId: '0190f4c8-0000-7000-8000-000000000401',
              input: LIVE_GOAL_WEB_CHAT_PROMPT,
              artifactRefs: [{ artifactId: artifact.id, artifactVersion: artifact.version }],
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status, await res.clone().text()).toBe(200);
      const parsed = SubmitConversationResponseSchema.parse(await res.json());
      expect(parsed).toMatchObject({
        outcome: 'answered',
        explanation: 'The Assistant answered directly.',
        handoff: null,
      });
      expect(prompts).toEqual([expect.stringContaining(LIVE_GOAL_WEB_CHAT_PROMPT)]);
      expect(prompts[0]).toContain(LIVE_GOAL_WEB_REPORT_MARKER);
      expect(prompts[0]).toContain(
        `Artifact ${artifact.title} (${artifact.id} v${artifact.version}):`
      );
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'Count Goal Web tests in this report.',
    'Explain how the internet works.',
    'Discuss the Google product family.',
    'Explain Google services.',
    'Google is a company.',
    'Search this attached report for the acceptance marker.',
  ])('answers Chat Mode topic or local-report reading without external-search refusal: %s', async (input) => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const prompts: string[] = [];
    const thread = store.createThread('ws_quick_chat', 'Topic mention');
    const app = createApp({
      coreDb,
      store,
      turnExecutor: executor,
      ...chatAnsweringProvider(prompts),
    });

    try {
      const res = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_quick_chat', threadId: thread.id },
          {
            method: 'POST',
            body: conversationRequest({
              requestId: `0190f4c8-0000-7000-8000-0000000004${String(input.length).padStart(2, '0')}`,
              input,
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status, await res.clone().text()).toBe(200);
      const parsed = SubmitConversationResponseSchema.parse(await res.json());
      expect(parsed).toMatchObject({
        outcome: 'answered',
        explanation: 'The Assistant answered directly.',
        handoff: null,
      });
      expect(prompts).toHaveLength(1);
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'Search the web for NanoCore release notes.',
    'Browse an external URL for NanoCore docs.',
    'Google for NanoCore release notes.',
    'Google NanoCore release notes.',
    'Please Google NanoCore release notes.',
    'Can you Google NanoCore release notes.',
    'Look up NanoCore online.',
  ])('refuses explicit external search even with an attached Artifact: %s', async (input) => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const artifact = createImportedMarkdownArtifact(store, {
      id: `ar_explicit_search_${input.length}`,
      title: 'Attached notes',
      body: '# Notes\n',
      requestId: `artifact-import-explicit-search-${input.length}`,
    });
    const app = createApp({ coreDb, store, turnExecutor: executor });

    try {
      const res = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: conversationRequest({
              requestId: `0190f4c8-0000-7000-8000-0000000005${String(input.length).padStart(2, '0')}`,
              input,
              artifactRefs: [{ artifactId: artifact.id, artifactVersion: artifact.version }],
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status).toBe(200);
      const parsed = SubmitConversationResponseSchema.parse(await res.json());
      expect(parsed).toMatchObject({
        outcome: 'refused',
        explanation: 'External search is not enabled for Chat Mode.',
        handoff: null,
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses Chat Mode worker handoff when no worker candidate is ready', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const executor = new FakeTurnExecutor();
    const app = createApp({
      agentManifests: [
        {
          ...createTestAgentSetup({ provider: null }).manifest,
          readiness: { message: 'Blocked for this test.', status: 'blocked' },
        },
      ],
      coreDb,
      store,
      turnExecutor: executor,
    });

    try {
      const res = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: conversationRequest({
              requestId: '0190f4c8-0000-7000-8000-000000000316',
              input: 'Implement the focused worker fix.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status).toBe(200);
      const parsed = SubmitConversationResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        outcome: 'refused',
        explanation: 'No ready worker candidate is available.',
        handoff: null,
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses Chat Mode retry requests instead of falling back to quick chat', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });

    try {
      const res = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: conversationRequest({
              requestId: '0190f4c8-0000-7000-8000-000000000317',
              input: 'Retry the previous worker turn.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status).toBe(200);
      const parsed = SubmitConversationResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        outcome: 'refused',
        explanation: 'The request asks to retry prior worker execution.',
        handoff: null,
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      input: 'Review the previous worker output.',
      explanation: 'The request is asking to evaluate recent work rather than start new execution.',
    },
    {
      input: 'Refine the previous result.',
      explanation: 'The request appears to refine prior output in the current thread.',
    },
    {
      input: 'Hand off this work to another worker.',
      explanation: 'The request asks to hand work to another worker or phase.',
    },
  ])('refuses Chat Mode coordinator-only requests for "$input"', async ({ explanation, input }) => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });

    try {
      const res = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: conversationRequest({
              requestId: '0190f4c8-0000-7000-8000-000000000319',
              input,
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status).toBe(200);
      const parsed = SubmitConversationResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        outcome: 'refused',
        explanation,
        handoff: null,
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('retains no old Goal entry route', async () => {
    const coreDb = createCoreDb();
    const app = createApp({ coreDb, turnExecutor: new FakeTurnExecutor() });
    try {
      const response = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/goal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'retired-entry', objective: 'Plan work' }),
      });
      expect(response.status).toBe(404);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not silently run Task Mode when the coordinator selects quick chat', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });
    const res = await app.request(
      ...operationRequest(
        'task.start',
        { workspaceId: 'ws_demo', threadId: 'th_demo' },
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: '0190f4c8-0000-7000-8000-000000000302',
            input: 'What is OpenKit?',
          }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    try {
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        code: 'task_mode_not_delegated',
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not silently run Task Mode when the coordinator asks to clarify', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });
    const res = await app.request(
      ...operationRequest(
        'task.start',
        { workspaceId: 'ws_demo', threadId: 'th_demo' },
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: '0190f4c8-0000-7000-8000-000000000318',
            input: 'Help.',
          }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    try {
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        code: 'task_mode_not_delegated',
        message: 'The request needs clarification before routing.',
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('hands Goal planning from Task entry to one Goal without worker execution', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const requestId = '0190f4c8-0000-7000-8000-000000000307';
    const input = 'Plan a multi-step release goal for NanoCore.';

    try {
      const res = await app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: JSON.stringify({ requestId, input }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status).toBe(202);
      const accepted = await res.json();
      expect(accepted).toMatchObject({
        state: 'escalated-to-goal',
        escalation: { targetMode: 'goal' },
      });
      expect(executor.startContexts).toHaveLength(0);
      const replayRes = await app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            body: JSON.stringify({ requestId, input }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(replayRes.status).toBe(202);
      expect(await replayRes.json()).toEqual(accepted);

      expect(store.listCommandRequests().some((record) => record.command === 'goal.create')).toBe(
        true
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns a typed 400 error for unsupported turn model overrides', async () => {
    const coreDb = createCoreDb();
    const app = createApp({ coreDb, turnExecutor: new FakeTurnExecutor() });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-turn-model-override-'));

    seedWritableGitRepository(repositoryPath);

    try {
      const res = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              requestId: '0190f4c8-0000-7000-8000-000000000203',
              input: 'Ship the update',
              modelId: 'model_missing',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        code: 'model_not_supported_by_agent',
        message: 'Agent agent_codex_host does not support model override: model_missing.',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects direct worker turns in the Quick Chat workspace', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const store = createDemoStore();
    const thread = store.createThread('ws_quick_chat', 'Reject worker turn');
    const app = createApp({ coreDb, store, turnExecutor: executor });

    try {
      const res = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: 'ws_quick_chat',
              threadId: thread.id,
              requestId: '0190f4c8-0000-7000-8000-000000000320',
              input: 'Run a worker turn.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        code: 'workspace_kind_not_supported',
        message: expect.stringContaining('Quick Chat workspace'),
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns protocol-valid meta event families', async () => {
    const app = createApp({ turnExecutor: new FakeTurnExecutor() });
    const res = await app.request('/api/meta');

    expect(res.status).toBe(200);

    const body = await res.json();
    const parsed = MetaResponseSchema.parse(body);

    expect(parsed.eventFamilies).toContain('item.created');
    expect(parsed.eventFamilies).toContain('thread.updated');
    expect(parsed.eventFamilies).not.toContain('approval.requested');
  });

  it('reports active container worker capabilities in meta by default', async () => {
    const coreDb = createCoreDb();
    const previousSelfCheckExecutor = process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR;
    delete process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR;

    try {
      const app = createNanoCoreApp({ coreDb });
      const res = await app.request('/api/meta');

      expect(res.status).toBe(200);

      const parsed = MetaResponseSchema.parse(await res.json());

      expect(parsed.capabilities).toEqual([
        'core.interrupt',
        'core.artifacts',
        'core.agent_session.visible',
        'core.stream.replay',
      ]);
    } finally {
      if (previousSelfCheckExecutor === undefined) {
        delete process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR;
      } else {
        process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR = previousSelfCheckExecutor;
      }
      coreDb.sqlite.close();
    }
  });

  it('creates a thread from the name field used by the protocol package', async () => {
    const canonicalStore = createDemoStore();
    const canonicalApp = createApp(
      { ...{ turnExecutor: new FakeTurnExecutor() }, store: canonicalStore },
      true
    );
    const res = await ((input: Record<string, unknown>) =>
      canonicalApp.request('/api/app/operations/thread.create', {
        method: 'POST',
        headers: {
          ...{
            ...{ 'content-type': 'application/json' },
            'content-type': 'application/json',
            'x-openkit-request-id': '0190f4c8-0000-7000-8000-000000000204',
          },
          ...(typeof input.requestId === 'string'
            ? { 'x-openkit-request-id': input.requestId }
            : {}),
        },
        body: JSON.stringify(input),
      }))({
      ...{
        requestId: '0190f4c8-0000-7000-8000-000000000204',
        name: 'Follow-up thread',
      },
      workspaceId: 'ws_demo',
    });

    expect(res.status).toBe(200);

    const thread = ThreadSchema.parse(await res.json());

    expect(thread.name).toBe('Follow-up thread');
    expect(thread.preview).toBe('Follow-up thread');
  });

  it('deduplicates repeated workspace, knowledge, and thread commands', async () => {
    const store = createDemoStore();
    const app = createApp({ store, turnExecutor: new FakeTurnExecutor() }, true);
    const canonicalApp = createApp({ store, turnExecutor: new FakeTurnExecutor() }, true);

    const workspaceBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000501',
      name: 'Idempotent workspace',
    };
    const workspaceFirst = await app.request(
      ...operationRequest(
        'workspace.create',
        {},
        {
          method: 'POST',
          body: JSON.stringify(workspaceBody),
          headers: jsonHeaders(),
        }
      )
    );
    const workspaceSecond = await app.request(
      ...operationRequest(
        'workspace.create',
        {},
        {
          method: 'POST',
          body: JSON.stringify(workspaceBody),
          headers: jsonHeaders(),
        }
      )
    );
    const workspace = (await workspaceFirst.json()) as { id: string };
    const duplicateWorkspace = (await workspaceSecond.json()) as { id: string };

    expect(duplicateWorkspace.id).toBe(workspace.id);
    expect(
      store.listWorkspaces().filter((item) => item.name === 'Idempotent workspace')
    ).toHaveLength(1);

    const workspaceUpdateBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000502',
      name: 'Idempotent workspace renamed',
    };
    const workspaceUpdateFirst = await app.request(
      ...operationRequest(
        'workspace.update',
        { workspaceId: workspace.id },
        {
          method: 'PATCH',
          body: JSON.stringify(workspaceUpdateBody),
          headers: jsonHeaders(),
        }
      )
    );
    const workspaceUpdateSecond = await app.request(
      ...operationRequest(
        'workspace.update',
        { workspaceId: workspace.id },
        {
          method: 'PATCH',
          body: JSON.stringify(workspaceUpdateBody),
          headers: jsonHeaders(),
        }
      )
    );

    expect((await workspaceUpdateFirst.json()) as { id: string; name: string }).toMatchObject({
      id: workspace.id,
      name: 'Idempotent workspace renamed',
    });
    expect((await workspaceUpdateSecond.json()) as { id: string; name: string }).toMatchObject({
      id: workspace.id,
      name: 'Idempotent workspace renamed',
    });

    const knowledgeBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000503',
      kind: 'preference',
      title: 'Idempotent knowledge',
      content: 'Store this once.',
    };
    const knowledgeFirst = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.create',
        { workspaceId: 'ws_demo' },
        {
          method: 'POST',
          body: JSON.stringify(knowledgeBody),
          headers: jsonHeaders(),
        }
      )
    );
    const knowledgeSecond = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.create',
        { workspaceId: 'ws_demo' },
        {
          method: 'POST',
          body: JSON.stringify(knowledgeBody),
          headers: jsonHeaders(),
        }
      )
    );
    const knowledge = (await knowledgeFirst.json()) as { id: string };
    const duplicateKnowledge = (await knowledgeSecond.json()) as { id: string };

    expect(duplicateKnowledge.id).toBe(knowledge.id);
    expect(
      store.listKnowledge('ws_demo').filter((entry) => entry.title === 'Idempotent knowledge')
    ).toHaveLength(1);

    const knowledgeUpdateBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000504',
      title: 'Idempotent knowledge updated',
    };
    const knowledgeUpdateFirst = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.update',
        { workspaceId: 'ws_demo', knowledgeEntryId: knowledge.id },
        {
          method: 'PATCH',
          body: JSON.stringify(knowledgeUpdateBody),
          headers: jsonHeaders(),
        }
      )
    );
    const knowledgeUpdateSecond = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.update',
        { workspaceId: 'ws_demo', knowledgeEntryId: knowledge.id },
        {
          method: 'PATCH',
          body: JSON.stringify(knowledgeUpdateBody),
          headers: jsonHeaders(),
        }
      )
    );

    expect((await knowledgeUpdateFirst.json()) as { id: string; title: string }).toMatchObject({
      id: knowledge.id,
      title: 'Idempotent knowledge updated',
    });
    expect((await knowledgeUpdateSecond.json()) as { id: string; title: string }).toMatchObject({
      id: knowledge.id,
      title: 'Idempotent knowledge updated',
    });

    const knowledgeDeleteBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000514',
    };
    const knowledgeDeleteFirst = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.delete',
        { workspaceId: 'ws_demo', knowledgeEntryId: knowledge.id },
        {
          method: 'DELETE',
          body: JSON.stringify(knowledgeDeleteBody),
          headers: jsonHeaders(),
        }
      )
    );
    const knowledgeDeleteSecond = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.delete',
        { workspaceId: 'ws_demo', knowledgeEntryId: knowledge.id },
        {
          method: 'DELETE',
          body: JSON.stringify(knowledgeDeleteBody),
          headers: jsonHeaders(),
        }
      )
    );
    const knowledgeDeleteNewRequest = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.delete',
        { workspaceId: 'ws_demo', knowledgeEntryId: knowledge.id },
        {
          method: 'DELETE',
          body: JSON.stringify({
            requestId: '0190f4c8-0000-7000-8000-000000000515',
          }),
          headers: jsonHeaders(),
        }
      )
    );

    expect(knowledgeDeleteFirst.status).toBe(200);
    expect(knowledgeDeleteSecond.status).toBe(200);
    expect(knowledgeDeleteNewRequest.status).toBe(403);
    await expect(knowledgeDeleteNewRequest.json()).resolves.toMatchObject({
      code: 'workspace_access_denied',
    });

    const threadBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000505',
      name: 'Idempotent thread',
    };
    const threadFirst = await ((input: Record<string, unknown>) =>
      canonicalApp.request('/api/app/operations/thread.create', {
        method: 'POST',
        headers: {
          ...{ ...jsonHeaders(), 'content-type': 'application/json' },
          ...(typeof input.requestId === 'string'
            ? { 'x-openkit-request-id': input.requestId }
            : {}),
        },
        body: JSON.stringify(input),
      }))({ ...threadBody, workspaceId: 'ws_demo' });
    const threadSecond = await ((input: Record<string, unknown>) =>
      canonicalApp.request('/api/app/operations/thread.create', {
        method: 'POST',
        headers: {
          ...{ ...jsonHeaders(), 'content-type': 'application/json' },
          ...(typeof input.requestId === 'string'
            ? { 'x-openkit-request-id': input.requestId }
            : {}),
        },
        body: JSON.stringify(input),
      }))({ ...threadBody, workspaceId: 'ws_demo' });
    const thread = (await threadFirst.json()) as { id: string };
    const duplicateThread = (await threadSecond.json()) as { id: string };

    expect(duplicateThread.id).toBe(thread.id);
    expect(
      store.listThreads('ws_demo').filter((item) => item.name === 'Idempotent thread')
    ).toHaveLength(1);

    const threadUpdateBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000506',
      name: 'Idempotent thread updated',
    };
    const threadUpdateFirst = await app.request(
      ...operationRequest(
        'thread.update',
        { workspaceId: 'ws_demo', threadId: thread.id },
        {
          method: 'PATCH',
          body: JSON.stringify(threadUpdateBody),
          headers: jsonHeaders(),
        }
      )
    );
    const threadUpdateSecond = await app.request(
      ...operationRequest(
        'thread.update',
        { workspaceId: 'ws_demo', threadId: thread.id },
        {
          method: 'PATCH',
          body: JSON.stringify(threadUpdateBody),
          headers: jsonHeaders(),
        }
      )
    );

    expect((await threadUpdateFirst.json()) as { id: string; name: string }).toMatchObject({
      id: thread.id,
      name: 'Idempotent thread updated',
    });
    expect((await threadUpdateSecond.json()) as { id: string; name: string }).toMatchObject({
      id: thread.id,
      name: 'Idempotent thread updated',
    });

    const threadArchiveBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000507',
    };
    await app.request(
      ...operationRequest(
        'thread.archive',
        { workspaceId: 'ws_demo', threadId: thread.id },
        {
          method: 'POST',
          body: JSON.stringify(threadArchiveBody),
          headers: jsonHeaders(),
        }
      )
    );
    const threadArchiveSecond = await app.request(
      ...operationRequest(
        'thread.archive',
        { workspaceId: 'ws_demo', threadId: thread.id },
        {
          method: 'POST',
          body: JSON.stringify(threadArchiveBody),
          headers: jsonHeaders(),
        }
      )
    );

    expect((await threadArchiveSecond.json()) as { id: string; status: string }).toMatchObject({
      id: thread.id,
      status: 'archived',
    });
  });

  it('deduplicates concurrent start-turn commands by request id', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const executor = new DelayedTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-idempotent-turn-repository-'));
    const body = {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      requestId: '0190f4c8-0000-7000-8000-000000000509',
      input: 'Run the idempotent turn',
    };

    seedWritableGitRepository(repositoryPath);

    try {
      const first = app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify(body),
            headers: jsonHeaders(),
          }
        )
      );

      await executor.waitForStart();

      const second = app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify(body),
            headers: jsonHeaders(),
          }
        )
      );
      const competing = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              ...body,
              requestId: '0190f4c8-0000-7000-8000-000000000517',
            }),
            headers: jsonHeaders(),
          }
        )
      );

      await Promise.resolve();
      expect(competing.status).toBe(409);
      await expect(competing.json()).resolves.toMatchObject({ code: 'thread_busy' });
      expect(executor.starts).toBe(1);

      executor.release();
      const [firstRes, secondRes] = await Promise.all([first, second]);
      const firstTurn = (await firstRes.json()) as { id: string };
      const secondTurn = (await secondRes.json()) as { id: string };

      expect(secondTurn.id).toBe(firstTurn.id);
      expect(executor.starts).toBe(1);
      expect(
        store.listThreadTurns('ws_demo', 'th_demo').filter((turn) => turn.id === firstTurn.id)
      ).toHaveLength(1);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects implicit turn submission while active and allows the same request after terminal', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-active-turn-steering-repository-'));
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const thread = store.createThread('ws_demo', 'Active turn steering');
    const activeTurn = store.updateTurn(
      store.createTurn('ws_demo', thread.id, 'Keep this turn active', {
        kind: 'user',
        id: 'user_local',
      }).id,
      { status: 'running' }
    );
    const body = {
      workspaceId: 'ws_demo',
      threadId: thread.id,
      requestId: '0190f4c8-0000-7000-8000-000000000516',
      input: 'Apply this to the active turn.',
    };

    seedWritableGitRepository(repositoryPath);

    try {
      const first = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify(body),
            headers: jsonHeaders(),
          }
        )
      );
      const replay = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify(body),
            headers: jsonHeaders(),
          }
        )
      );
      const admissionCountWhileActive = (
        coreDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM scheduler_admission_entries WHERE request_id = ?')
          .get(body.requestId) as { readonly count: number }
      ).count;

      expect(first.status).toBe(409);
      await expect(first.json()).resolves.toMatchObject({ code: 'thread_busy' });
      expect(replay.status).toBe(409);
      await expect(replay.json()).resolves.toMatchObject({ code: 'thread_busy' });
      expect(admissionCountWhileActive).toBe(0);
      expect(executor.startContexts).toHaveLength(0);
      expect(store.listThreadItems('ws_demo', thread.id)).toEqual([]);
      expect(store.listThreadTurns('ws_demo', thread.id).map((turn) => turn.id)).toEqual([
        activeTurn.id,
      ]);

      store.updateTurn(activeTurn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      const accepted = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify(body),
            headers: jsonHeaders(),
          }
        )
      );
      const acceptedTurn = (await accepted.json()) as { id: string };

      expect(accepted.status).toBe(202);
      expect(acceptedTurn.id).not.toBe(activeTurn.id);
      expect(executor.startContexts).toHaveLength(1);
      expect(store.listThreadTurns('ws_demo', thread.id)).toHaveLength(2);
      expect(store.listThreadItems('ws_demo', thread.id)).toContainEqual(
        expect.objectContaining({
          turnId: acceptedTurn.id,
          type: 'user-message',
          text: body.input,
        })
      );
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('returns an idempotency conflict for the same request id with different input', async () => {
    const canonicalStore = createDemoStore();
    const canonicalApp = createApp(
      { ...{ turnExecutor: new FakeTurnExecutor() }, store: canonicalStore },
      true
    );
    const requestId = '0190f4c8-0000-7000-8000-000000000513';
    const first = await ((input: Record<string, unknown>) =>
      canonicalApp.request('/api/app/operations/thread.create', {
        method: 'POST',
        headers: {
          ...{ ...jsonHeaders(), 'content-type': 'application/json' },
          ...(typeof input.requestId === 'string'
            ? { 'x-openkit-request-id': input.requestId }
            : {}),
        },
        body: JSON.stringify(input),
      }))({ ...{ requestId, name: 'Conflict A' }, workspaceId: 'ws_demo' });
    const conflict = await ((input: Record<string, unknown>) =>
      canonicalApp.request('/api/app/operations/thread.create', {
        method: 'POST',
        headers: {
          ...{ ...jsonHeaders(), 'content-type': 'application/json' },
          ...(typeof input.requestId === 'string'
            ? { 'x-openkit-request-id': input.requestId }
            : {}),
        },
        body: JSON.stringify(input),
      }))({ ...{ requestId, name: 'Conflict B' }, workspaceId: 'ws_demo' });

    expect(first.status).toBe(200);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: 'idempotency_key_conflict',
    });
  });

  it('returns invalid_request for missing request ids on all protocol mutating routes', async () => {
    const store = createDemoStore();
    const app = createApp({ store, turnExecutor: new ApprovalTurnExecutor() });
    const canonicalApp = createApp({ store, turnExecutor: new ApprovalTurnExecutor() }, true);
    const turn = store.createTurn('ws_demo', 'th_demo', 'Need input', {
      kind: 'user',
      id: 'user_local',
    });
    store.createApproval({
      id: 'ap_missing_request',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: turn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Approve',
      description: 'Missing request id.',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });

    const cases = [
      app.request(
        ...operationRequest(
          'workspace.update',
          { workspaceId: 'ws_demo' },
          {
            method: 'PATCH',
            body: JSON.stringify({ name: 'Missing request id' }),
            headers: jsonHeaders(),
          }
        )
      ),
      canonicalApp.request(
        ...knowledgeOperationRequest(
          'knowledge.create',
          { workspaceId: 'ws_demo' },
          {
            method: 'POST',
            body: JSON.stringify({
              kind: 'preference',
              title: 'Missing request id',
              content: 'Should fail.',
            }),
            headers: jsonHeaders(),
          }
        )
      ),
      canonicalApp.request(
        ...knowledgeOperationRequest(
          'knowledge.update',
          { workspaceId: 'ws_demo', knowledgeEntryId: 'mem_project' },
          {
            method: 'PATCH',
            body: JSON.stringify({ title: 'Missing request id' }),
            headers: jsonHeaders(),
          }
        )
      ),
      canonicalApp.request(
        ...knowledgeOperationRequest(
          'knowledge.delete',
          { workspaceId: 'ws_demo', knowledgeEntryId: 'mem_project' },
          {
            method: 'DELETE',
            body: JSON.stringify({}),
            headers: jsonHeaders(),
          }
        )
      ),
      ((input: Record<string, unknown>) =>
        canonicalApp.request('/api/app/operations/thread.create', {
          method: 'POST',
          headers: {
            ...{ ...jsonHeaders(), 'content-type': 'application/json' },
            ...(typeof input.requestId === 'string'
              ? { 'x-openkit-request-id': input.requestId }
              : {}),
          },
          body: JSON.stringify(input),
        }))({ ...{ name: 'Missing request id' }, workspaceId: 'ws_demo' }),
      app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              input: 'Missing request id',
            }),
            headers: jsonHeaders(),
          }
        )
      ),
      app.request(
        ...operationRequest(
          'question.answer',
          { userInputRequestId: 'ui_missing_request' },
          {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              answers: { question: ['Missing request id'] },
            }),
            headers: jsonHeaders(),
          }
        )
      ),
      app.request(
        ...operationRequest(
          'pending-request.withdraw',
          { pendingRequestId: 'ui_missing_request' },
          {
            method: 'POST',
            body: JSON.stringify({ workspaceId: 'ws_demo', threadId: 'th_demo' }),
            headers: jsonHeaders(),
          }
        )
      ),
      app.request(
        ...operationRequest(
          'approval.respond',
          { approvalRequestId: 'ap_missing_request' },
          {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              turnId: turn.id,
              decision: 'granted',
            }),
            headers: jsonHeaders(),
          }
        )
      ),
    ];

    for (const responsePromise of cases) {
      const response = await responsePromise;

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: 'invalid_request',
        message: expect.stringContaining('requestId'),
      });
    }
  });

  it('updates and archives threads with request-correlated command schemas', async () => {
    const app = createApp({ turnExecutor: new FakeTurnExecutor() }, true);

    const missingRequestId = await app.request(
      ...operationRequest(
        'thread.update',
        { workspaceId: 'ws_demo', threadId: 'th_demo' },
        {
          method: 'PATCH',
          body: JSON.stringify({ name: 'Missing request id' }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    const updateRes = await app.request(
      ...operationRequest(
        'thread.update',
        { workspaceId: 'ws_demo', threadId: 'th_demo' },
        {
          method: 'PATCH',
          body: JSON.stringify({
            requestId: '0190f4c8-0000-7000-8000-000000000208',
            name: 'Protocol hardening',
          }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    const archiveRes = await app.request(
      ...operationRequest(
        'thread.archive',
        { workspaceId: 'ws_demo', threadId: 'th_demo' },
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: '0190f4c8-0000-7000-8000-000000000209',
          }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    expect(missingRequestId.status).toBe(400);
    await expect(missingRequestId.json()).resolves.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('requestId'),
    });
    expect(ThreadSchema.parse(await updateRes.json())).toMatchObject({
      name: 'Protocol hardening',
      status: 'active',
    });
    expect(ThreadSchema.parse(await archiveRes.json())).toMatchObject({
      name: 'Protocol hardening',
      status: 'archived',
    });
  });

  it('does not expose generic Artifact metadata mutation', async () => {
    const store = createDemoStore();
    const app = createApp({ store, turnExecutor: new FakeTurnExecutor() });
    const timestamp = new Date().toISOString();
    store.createArtifact({
      id: 'ar_server_test',
      workspaceId: 'ws_demo',
      threadId: null,
      turnId: null,
      kind: 'file',
      title: 'Draft summary',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'markdown', body: '# Draft' },
      contentDigest: artifactDigest('# Draft'),
      lastMutationRequestId: 'artifact-import-server-test-1',
      origin: {
        kind: 'imported',
        sourceKind: 'direct-import',
        sourceId: 'artifact-import-server-test-1',
        sourceDigest: artifactDigest('# Draft'),
        actor: { kind: 'user', id: LOCAL_USER_ID },
        requestId: 'artifact-import-server-test-1',
        recordedAt: timestamp,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const response = await app.request('/api/workspaces/ws_demo/artifacts/ar_server_test', {
      method: 'PATCH',
      body: JSON.stringify({
        requestId: '0190f4c8-0000-7000-8000-000000000210',
        title: 'Unauthorized mutation',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(response.status).toBe(404);
    expect(store.getArtifact('ws_demo', 'ar_server_test')).toMatchObject({
      title: 'Draft summary',
      status: 'ready',
      summary: null,
      version: 1,
    });
  });
  it('lists and reads workspace synchronization reviews from review artifacts', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    store.createTurn(
      'ws_demo',
      'th_demo',
      'Produce workspace review',
      { kind: 'user', id: 'user_local' },
      null,
      {
        turnId: 'turn_demo',
      }
    );
    const timestamp = new Date().toISOString();
    const patchText = 'diff --git a/docs/spec.md b/docs/spec.md\n';
    const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
    const workspaceReview = {
      changeSet: {
        id: 'wcs_1',
        materializationRecordId: 'wmr_1',
        inputSnapshotId: 'wis_1',
        workspaceId: 'ws_demo',
        resourceId: 'default',
        strategy: 'git',
        base: { commit: 'abc123', contentDigest: null },
        head: { commit: 'def456', contentDigest: null },
        changedPaths: [{ path: 'docs/spec.md', status: 'modified', binary: false }],
        patch: {
          ref: 'artifact://patch',
          digest: patchDigest,
          bytes: Buffer.byteLength(patchText, 'utf8'),
        },
        bundle: null,
        artifactIds: ['ar_workspace_changes_1'],
        evidenceRefs: [{ kind: 'worker', ref: 'turn_demo' }],
        redaction: { status: 'redacted', notes: [] },
        createdAt: timestamp,
      },
      patchPayload: {
        mediaType: 'text/x-diff',
        text: patchText,
        digest: patchDigest,
        bytes: Buffer.byteLength(patchText, 'utf8'),
      },
      review: {
        id: 'swr_1',
        changeSetId: 'wcs_1',
        workspaceId: 'ws_demo',
        status: 'pending',
        staging: {
          strategy: 'git_worktree',
          ref: 'staging://workspace/wcs_1',
          branch: 'openkit/review/swr_1',
        },
        diffSummary: { filesChanged: 1, additions: 0, deletions: 0 },
        riskSummary: '1 changed path staged for human review.',
        validation: [{ command: 'worker', status: 'passed', ref: 'turn_demo' }],
        actionCenterRowId: 'workspace-review:swr_1',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };

    store.createArtifact({
      id: 'ar_workspace_changes_1',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'turn_demo',
      kind: 'diff',
      title: 'Workspace changes ready for review',
      status: 'ready',
      summary: workspaceReview.review.riskSummary,
      version: 1,
      content: { format: 'json', body: JSON.stringify(workspaceReview) },
      contentDigest: artifactDigest(JSON.stringify(workspaceReview)),
      lastMutationRequestId: 'workspace-review-artifact-1',
      origin: {
        kind: 'turn-output',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        requestId: 'workspace-review-artifact-1',
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    store.createArtifact({
      id: 'ar_regular_report',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'turn_demo',
      kind: 'report',
      title: 'Regular report',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'markdown', body: '# Report' },
      contentDigest: artifactDigest('# Report'),
      lastMutationRequestId: 'regular-report-artifact-1',
      origin: {
        kind: 'turn-output',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        requestId: 'regular-report-artifact-1',
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      const item = { artifactId: 'ar_workspace_changes_1', ...workspaceReview };
      recordTestWorkspaceReviewMaterialization(workspaceDb, item);
      recordWorkspaceSyncReview(workspaceDb, {
        item,
      });
    } finally {
      workspaceDb.sqlite.close();
    }

    const list = await app.request(
      ...operationRequest('sync.review-list', { workspaceId: 'ws_demo' }, undefined)
    );
    const detail = await app.request(
      ...operationRequest(
        'sync.review-read',
        { workspaceId: 'ws_demo', reviewId: 'swr_1' },
        undefined
      )
    );
    const inputSnapshots = await app.request(
      ...operationRequest('sync.input-snapshot-list', { workspaceId: 'ws_demo' }, undefined)
    );
    const materializations = await app.request(
      ...operationRequest('sync.materialization-list', { workspaceId: 'ws_demo' }, undefined)
    );
    const backendHandles = await app.request(
      ...operationRequest('sync.backend-handle-list', { workspaceId: 'ws_demo' }, undefined)
    );
    const outputManifests = await app.request(
      ...operationRequest('sync.output-manifest-list', { workspaceId: 'ws_demo' }, undefined)
    );
    const changeSets = await app.request(
      ...operationRequest('sync.change-set-list', { workspaceId: 'ws_demo' }, undefined)
    );
    const stagedReviews = await app.request(
      ...operationRequest('sync.staged-review-list', { workspaceId: 'ws_demo' }, undefined)
    );
    const restartedApp = createApp({
      coreDb,
      store: createDemoStore(),
      turnExecutor: new FakeTurnExecutor(),
    });
    const persistedDetail = await restartedApp.request(
      ...operationRequest(
        'sync.review-read',
        { workspaceId: 'ws_demo', reviewId: 'swr_1' },
        undefined
      )
    );

    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      items: [{ artifactId: 'ar_workspace_changes_1', review: { id: 'swr_1' } }],
    });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      artifactId: 'ar_workspace_changes_1',
      changeSet: { changedPaths: [{ path: 'docs/spec.md' }] },
      patchPayload: {
        mediaType: 'text/x-diff',
        text: expect.stringContaining('diff --git a/docs/spec.md b/docs/spec.md'),
      },
      review: { id: 'swr_1' },
    });
    expect(inputSnapshots.status).toBe(200);
    await expect(inputSnapshots.json()).resolves.toMatchObject({
      items: [{ id: 'wis_1', resourceId: 'default', strategy: 'git' }],
    });
    expect(materializations.status).toBe(200);
    await expect(materializations.json()).resolves.toMatchObject({
      items: [{ id: 'wmr_1', inputSnapshotId: 'wis_1', strategy: 'git' }],
    });
    expect(backendHandles.status).toBe(200);
    await expect(backendHandles.json()).resolves.toMatchObject({
      items: [{ id: 'bwh_wmr_1', materializationRecordId: 'wmr_1', backendKind: 'openshell' }],
    });
    expect(outputManifests.status).toBe(200);
    await expect(outputManifests.json()).resolves.toMatchObject({
      items: [{ id: 'wom_wcs_1', materializationRecordId: 'wmr_1', strategy: 'git' }],
    });
    expect(changeSets.status).toBe(200);
    await expect(changeSets.json()).resolves.toMatchObject({
      items: [{ id: 'wcs_1', changedPaths: [{ path: 'docs/spec.md' }] }],
    });
    expect(stagedReviews.status).toBe(200);
    await expect(stagedReviews.json()).resolves.toMatchObject({
      items: [{ id: 'swr_1', changeSetId: 'wcs_1' }],
    });
    expect(persistedDetail.status).toBe(200);
    await expect(persistedDetail.json()).resolves.toMatchObject({
      artifactId: 'ar_workspace_changes_1',
      review: { id: 'swr_1' },
    });
  });

  it('keeps artifact-only workspace review reads free of durable side effects', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const item = workspaceSyncReviewRouteItem();
    store.createTurn(
      'ws_demo',
      'th_demo',
      'Produce artifact-only workspace review',
      { kind: 'user', id: 'user_local' },
      null,
      {
        turnId: 'turn_demo',
      }
    );

    store.createArtifact({
      id: item.artifactId,
      workspaceId: item.review.workspaceId,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      kind: 'diff',
      title: 'Workspace changes ready for review',
      status: 'ready',
      summary: item.review.riskSummary,
      version: 1,
      content: { format: 'json', body: JSON.stringify(item) },
      contentDigest: artifactDigest(JSON.stringify(item)),
      lastMutationRequestId: 'artifact-only-workspace-review-1',
      origin: {
        kind: 'turn-output',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        requestId: 'artifact-only-workspace-review-1',
      },
      createdAt: item.review.createdAt,
      updatedAt: item.review.updatedAt,
    });

    const observerDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const beforeDataVersion = (
      observerDb.sqlite.prepare('PRAGMA data_version').get() as { data_version: number }
    ).data_version;

    try {
      const list = await app.request(
        ...operationRequest('sync.review-list', { workspaceId: 'ws_demo' }, undefined)
      );
      const detail = await app.request(
        ...operationRequest(
          'sync.review-read',
          { workspaceId: 'ws_demo', reviewId: 'swr_route_1' },
          undefined
        )
      );
      const afterDataVersion = (
        observerDb.sqlite.prepare('PRAGMA data_version').get() as { data_version: number }
      ).data_version;

      expect(getWorkspaceSyncReview(observerDb, 'ws_demo', 'swr_route_1')).toBeNull();
      expect(afterDataVersion).toBe(beforeDataVersion);

      expect(list.status).toBe(200);
      await expect(list.json()).resolves.toMatchObject({
        items: [{ review: { id: 'swr_route_1', status: 'pending' } }],
      });
      expect(detail.status).toBe(200);
      await expect(detail.json()).resolves.toMatchObject({
        review: { id: 'swr_route_1', status: 'pending' },
      });
    } finally {
      observerDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('prefers durable workspace review decisions over older artifact snapshots', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const item = workspaceSyncReviewRouteItem();
    store.createTurn(
      'ws_demo',
      'th_demo',
      'Produce durable workspace review',
      { kind: 'user', id: 'user_local' },
      null,
      {
        turnId: 'turn_demo',
      }
    );

    store.createArtifact({
      id: item.artifactId,
      workspaceId: item.review.workspaceId,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      kind: 'diff',
      title: 'Workspace changes ready for review',
      status: 'ready',
      summary: item.review.riskSummary,
      version: 1,
      content: { format: 'json', body: JSON.stringify(item) },
      contentDigest: artifactDigest(JSON.stringify(item)),
      lastMutationRequestId: 'durable-workspace-review-artifact-1',
      origin: {
        kind: 'turn-output',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        requestId: 'durable-workspace-review-artifact-1',
      },
      createdAt: item.review.createdAt,
      updatedAt: item.review.updatedAt,
    });

    try {
      const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        recordTestWorkspaceReviewMaterialization(workspaceDb, item);
        recordWorkspaceSyncReview(workspaceDb, { item });
        updateWorkspaceSyncReviewDecision(workspaceDb, {
          requestId: 'durable-review-read-precedence',
          reviewId: item.review.id,
          status: 'needs_refinement',
          updatedAt: '2026-07-06T00:01:00.000Z',
          workspaceId: item.review.workspaceId,
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      const list = await app.request(
        ...operationRequest('sync.review-list', { workspaceId: 'ws_demo' }, undefined)
      );
      const detail = await app.request(
        ...operationRequest(
          'sync.review-read',
          { workspaceId: 'ws_demo', reviewId: 'swr_route_1' },
          undefined
        )
      );

      expect(list.status).toBe(200);
      await expect(list.json()).resolves.toMatchObject({
        items: [{ review: { id: 'swr_route_1', status: 'needs_refinement' } }],
      });
      expect(detail.status).toBe(200);
      await expect(detail.json()).resolves.toMatchObject({
        review: { id: 'swr_route_1', status: 'needs_refinement' },
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records workspace sync decisions idempotently and blocks dual-owner replay', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Durable workspace review decision');
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const timestamp = new Date().toISOString();
    const patchText = 'diff --git a/docs/decision.md b/docs/decision.md\n';
    const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
    const item: Parameters<typeof recordWorkspaceSyncReview>[1]['item'] = {
      artifactId: 'ar_missing_workspace_review_decision',
      changeSet: {
        id: 'wcs_durable_review_decision',
        materializationRecordId: 'wmr_durable_review_decision',
        inputSnapshotId: 'wis_durable_review_decision',
        workspaceId: workspace.id,
        resourceId: 'repo_default',
        strategy: 'git',
        base: { commit: 'abc123', contentDigest: null },
        head: { commit: 'def456', contentDigest: null },
        changedPaths: [{ path: 'docs/decision.md', status: 'modified', binary: false }],
        patch: {
          ref: 'artifact://patch',
          digest: patchDigest,
          bytes: Buffer.byteLength(patchText, 'utf8'),
        },
        bundle: null,
        artifactIds: ['ar_missing_workspace_review_decision'],
        evidenceRefs: [{ kind: 'worker', ref: 'turn_durable_review_decision' }],
        redaction: { status: 'redacted', notes: [] },
        createdAt: timestamp,
      },
      patchPayload: {
        mediaType: 'text/x-diff',
        text: patchText,
        digest: patchDigest,
        bytes: Buffer.byteLength(patchText, 'utf8'),
      },
      review: {
        id: 'swr_durable_review_decision',
        changeSetId: 'wcs_durable_review_decision',
        workspaceId: workspace.id,
        status: 'pending',
        staging: {
          strategy: 'git_worktree',
          ref: 'staging://workspace/wcs_durable_review_decision',
          branch: null,
        },
        diffSummary: { filesChanged: 1, additions: 0, deletions: 0 },
        riskSummary: '1 changed path staged for human review.',
        validation: [{ command: 'worker', status: 'passed', ref: 'turn_durable_review_decision' }],
        actionCenterRowId: 'workspace-review:swr_durable_review_decision',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };

    try {
      const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        recordTestWorkspaceReviewMaterialization(workspaceDb, item);
        recordWorkspaceSyncReview(workspaceDb, { item });
      } finally {
        workspaceDb.sqlite.close();
      }

      const firstRes = await app.request(
        ...operationRequest(
          'sync.review-decide',
          { workspaceId: workspace.id, reviewId: 'swr_durable_review_decision' },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: 'workspace-sync-review-request-1',
              decision: 'needs_refinement',
              message: 'Please narrow this patch.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const secondRes = await app.request(
        ...operationRequest(
          'sync.review-decide',
          { workspaceId: workspace.id, reviewId: 'swr_durable_review_decision' },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: 'workspace-sync-review-request-1',
              decision: 'needs_refinement',
              message: 'Please narrow this patch.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const actionCenterRes = await app.request(
        ...operationRequest('attention.list', { workspaceId: workspace.id }, undefined)
      );
      const persistedDb = openTestWorkspaceDb(coreDb, workspace.id);
      let persistedStatus: string;
      try {
        persistedStatus =
          getWorkspaceSyncReview(persistedDb, workspace.id, 'swr_durable_review_decision')?.review
            .status ?? 'missing';
      } finally {
        persistedDb.sqlite.close();
      }
      const authorityDb = openTestWorkspaceDb(coreDb, workspace.id);
      const pendingDualOwnerItem = {
        ...item,
        artifactId: 'ar_pending_dual_owner_review',
        changeSet: {
          ...item.changeSet,
          id: 'wcs_pending_dual_owner_review',
          artifactIds: ['ar_pending_dual_owner_review'],
          inputSnapshotId: 'wis_pending_dual_owner_review',
          materializationRecordId: 'wmr_pending_dual_owner_review',
        },
        review: {
          ...item.review,
          id: 'swr_pending_dual_owner_review',
          actionCenterRowId: 'workspace-review:swr_pending_dual_owner_review',
          changeSetId: 'wcs_pending_dual_owner_review',
          staging: {
            ...item.review.staging,
            ref: 'staging://workspace/wcs_pending_dual_owner_review',
          },
        },
      } satisfies Parameters<typeof recordWorkspaceSyncReview>[1]['item'];
      try {
        createArtifactReview(authorityDb, {
          artifactId: item.artifactId,
          artifactVersion: 1,
          contentDigest: artifactDigest(JSON.stringify(item)),
          sourceThreadId: null,
          sourceTurnId: null,
          sourceAgentId: null,
          materialProposal: null,
          createdAt: timestamp,
        });
        recordTestWorkspaceReviewMaterialization(authorityDb, pendingDualOwnerItem);
        recordWorkspaceSyncReview(authorityDb, { item: pendingDualOwnerItem });
        createArtifactReview(authorityDb, {
          artifactId: pendingDualOwnerItem.artifactId,
          artifactVersion: 1,
          contentDigest: artifactDigest(JSON.stringify(pendingDualOwnerItem)),
          sourceThreadId: null,
          sourceTurnId: null,
          sourceAgentId: null,
          materialProposal: null,
          createdAt: timestamp,
        });
      } finally {
        authorityDb.sqlite.close();
      }
      const dualOwnerReplay = await app.request(
        ...operationRequest(
          'sync.review-decide',
          { workspaceId: workspace.id, reviewId: 'swr_durable_review_decision' },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: 'workspace-sync-review-request-1',
              decision: 'needs_refinement',
              message: 'Please narrow this patch.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const dualOwnerFreshRequest = await app.request(
        ...operationRequest(
          'sync.review-decide',
          { workspaceId: workspace.id, reviewId: pendingDualOwnerItem.review.id },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: 'workspace-sync-review-request-2',
              decision: 'needs_refinement',
              message: 'Please narrow this patch.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(firstRes.status).toBe(200);
      expect(secondRes.status).toBe(200);
      expect(await secondRes.json()).toEqual(await firstRes.json());
      expect(persistedStatus).toBe('needs_refinement');
      expect(
        ListHumanAttentionResponseSchema.parse(await actionCenterRes.json()).items.some(
          (row) => row.id === 'workspace-review:swr_durable_review_decision'
        )
      ).toBe(false);
      expect(dualOwnerReplay.status).toBe(409);
      await expect(dualOwnerReplay.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(dualOwnerFreshRequest.status).toBe(409);
      await expect(dualOwnerFreshRequest.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      const pendingDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        expect(
          getWorkspaceSyncReview(pendingDb, workspace.id, pendingDualOwnerItem.review.id)?.review
            .status
        ).toBe('pending');
      } finally {
        pendingDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records workspace recovery decisions idempotently', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Workspace recovery decision');
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const timestamp = new Date().toISOString();

    try {
      const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        recordWorkspaceReconciliationRecord(workspaceDb, {
          id: 'wrr_recovery_decision',
          workspaceId: workspace.id,
          triggerReason: 'restart',
          affectedRecordIds: ['wmr_recovery_decision', 'bwh_recovery_decision'],
          backendHandleSummary: {
            backendKind: 'openshell',
            handleId: 'bwh_recovery_decision',
            workerSessionId: 'session_recovery_decision',
            cleanupStatus: 'pending',
          },
          backendReachability: { status: 'unavailable', checkedAt: timestamp, detail: null },
          collectedOutputManifestIds: ['wom_recovery_decision'],
          evidenceBundleIds: ['evb_recovery_decision'],
          stateBefore: 'ready',
          stateAfter: 'requires-human',
          quarantineRefs: [],
          requiredHumanDecision: 'inspect_recovery',
          retentionDecision: 'retain-backend',
          startedAt: timestamp,
          finishedAt: null,
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      const firstRes = await app.request(
        ...operationRequest(
          'sync.recovery-decide',
          { workspaceId: workspace.id, reconciliationRecordId: 'wrr_recovery_decision' },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: 'workspace-recovery-request-1',
              decision: 'quarantine',
              message: 'Keep unsafe recovery material isolated.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const secondRes = await app.request(
        ...operationRequest(
          'sync.recovery-decide',
          { workspaceId: workspace.id, reconciliationRecordId: 'wrr_recovery_decision' },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: 'workspace-recovery-request-1',
              decision: 'quarantine',
              message: 'Keep unsafe recovery material isolated.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const actionCenterRes = await app.request(
        ...operationRequest('attention.list', { workspaceId: workspace.id }, undefined)
      );

      const firstPayload = await firstRes.json();
      const secondPayload = await secondRes.json();

      expect(firstRes.status).toBe(200);
      expect(secondRes.status).toBe(200);
      expect(secondPayload).toEqual(firstPayload);
      expect(
        SubmitWorkspaceRecoveryDecisionResponseSchema.parse(firstPayload).reconciliationRecord
      ).toMatchObject({
        id: 'wrr_recovery_decision',
        stateBefore: 'requires-human',
        stateAfter: 'quarantined',
        requiredHumanDecision: null,
        retentionDecision: 'teardown-backend',
      });
      expect(
        ListHumanAttentionResponseSchema.parse(await actionCenterRes.json()).items.some(
          (row) => row.id === 'workspace-recovery:wrr_recovery_decision'
        )
      ).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('resumes workspace recovery collection from durable workspace sync records', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Workspace recovery resume');
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const timestamp = new Date().toISOString();
    const routeItem = workspaceSyncReviewRouteItem();
    const item: Parameters<typeof recordWorkspaceSyncReview>[1]['item'] = {
      ...routeItem,
      changeSet: {
        ...routeItem.changeSet,
        id: 'wcs_resume_route',
        inputSnapshotId: 'wis_resume_route',
        materializationRecordId: 'wmr_resume_route',
        workspaceId: workspace.id,
      },
      review: {
        ...routeItem.review,
        actionCenterRowId: 'workspace-review:swr_resume_route',
        changeSetId: 'wcs_resume_route',
        id: 'swr_resume_route',
        workspaceId: workspace.id,
      },
    };

    try {
      const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        recordTestWorkspaceReviewMaterialization(workspaceDb, item);
        recordWorkspaceSyncReview(workspaceDb, { item });
        recordWorkspaceReconciliationRecord(workspaceDb, {
          id: 'wrr_resume_route',
          workspaceId: workspace.id,
          triggerReason: 'backend_takeover',
          affectedRecordIds: ['wmr_resume_route', 'bwh_resume_route'],
          backendHandleSummary: {
            backendKind: 'openshell',
            cleanupStatus: 'pending',
            handleId: 'bwh_resume_route',
            workerSessionId: 'session_resume_route',
          },
          backendReachability: {
            status: 'unavailable',
            checkedAt: timestamp,
            detail: 'lease stale',
          },
          collectedOutputManifestIds: [],
          evidenceBundleIds: [
            'evb_workspace_materialization_wmr_resume_route',
            'evb_workspace_review_swr_resume_route',
          ],
          stateBefore: 'lease-stale',
          stateAfter: 'requires-human',
          quarantineRefs: [],
          requiredHumanDecision: 'inspect_recovery',
          retentionDecision: 'retain-backend',
          startedAt: timestamp,
          finishedAt: null,
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      const res = await app.request(
        ...operationRequest(
          'sync.recovery-decide',
          { workspaceId: workspace.id, reconciliationRecordId: 'wrr_resume_route' },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: 'workspace-recovery-resume-request-1',
              decision: 'resume_collection',
              message: 'Resume durable collection.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(res.status, await res.clone().text()).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        reconciliationRecord: {
          id: 'wrr_resume_route',
          stateBefore: 'requires-human',
          stateAfter: 'recovered',
          collectedOutputManifestIds: ['wom_wcs_resume_route'],
          evidenceBundleIds: [
            'evb_workspace_materialization_wmr_resume_route',
            'evb_workspace_review_swr_resume_route',
          ],
          requiredHumanDecision: null,
          retentionDecision: 'teardown-backend',
        },
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('reads durable Agent Environment Package snapshots through App API routes', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('AEP snapshot readback');
    const thread = store.createThread(workspace.id, 'AEP snapshot readback');
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const createdAt = '2026-07-06T00:00:01.000Z';
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: 'as_aep_readback',
        triggerActor: { kind: 'user', id: 'user_local' },
        backend: {
          kind: 'openshell',
        },
        requestId: 'req_aep_readback',
        turn: {
          id: 'turn_aep_readback',
          workspaceId: workspace.id,
          threadId: thread.id,
          items: [],
          status: 'running',
          error: null,
          configVersion: null,
          startedAt: '2026-07-06T00:00:00.000Z',
          completedAt: null,
          durationMs: null,
          triggerActor: { kind: 'user', id: 'user_local' },
        },
        turnInput: 'Run tests',
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      })
    );

    try {
      const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        recordAgentEnvironmentPackageSnapshot(workspaceDb, { createdAt, environmentPackage });
      } finally {
        workspaceDb.sqlite.close();
      }

      const list = await app.request(
        `/api/app/workspaces/${workspace.id}/agent-environment/snapshots`
      );
      const detail = await app.request(
        `/api/app/workspaces/${workspace.id}/agent-environment/snapshots/${environmentPackage.snapshotId}`
      );
      const missing = await app.request(
        `/api/app/workspaces/${workspace.id}/agent-environment/snapshots/missing`
      );

      expect(list.status).toBe(200);
      await expect(list.json()).resolves.toMatchObject({
        items: [
          {
            snapshotId: environmentPackage.snapshotId,
            workspaceId: workspace.id,
            turnId: 'turn_aep_readback',
            agentSessionId: 'as_aep_readback',
            backendKind: 'openshell',
          },
        ],
      });
      expect(detail.status).toBe(200);
      const detailJson = await detail.json();
      expect(detailJson).toMatchObject({
        snapshotId: environmentPackage.snapshotId,
        snapshot: { snapshotId: environmentPackage.snapshotId },
      });
      expect(JSON.stringify(detailJson)).not.toContain('sk-redacted-before-response');
      expect(missing.status).toBe(403);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('denies foreign and missing workspace review child lineage before reads or decisions', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const authorizedWorkspace = store
      .listWorkspaces()
      .find((workspace) => workspace.kind === 'quick-chat');
    const foreignWorkspace = store.createWorkspace('Foreign workspace review owner');
    const app = createNanoCoreApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const baseReview = workspaceSyncReviewRouteItem();
    const reviewId = 'swr_foreign_child_lineage';
    const changeSetId = 'wcs_foreign_child_lineage';
    const artifactId = 'ar_foreign_child_lineage';
    const review = {
      ...baseReview,
      artifactId,
      changeSet: {
        ...baseReview.changeSet,
        artifactIds: [artifactId],
        id: changeSetId,
        inputSnapshotId: 'wis_foreign_child_lineage',
        materializationRecordId: 'wmr_foreign_child_lineage',
        workspaceId: foreignWorkspace.id,
      },
      review: {
        ...baseReview.review,
        actionCenterRowId: `workspace-review:${reviewId}`,
        changeSetId,
        id: reviewId,
        workspaceId: foreignWorkspace.id,
      },
    } satisfies Parameters<typeof recordWorkspaceSyncReview>[1]['item'];

    if (!authorizedWorkspace) {
      throw new Error('Expected the local Quick Chat Workspace fixture.');
    }

    try {
      const foreignDb = openTestWorkspaceDb(coreDb, foreignWorkspace.id);
      try {
        recordTestWorkspaceReviewMaterialization(foreignDb, review);
        recordWorkspaceSyncReview(foreignDb, { item: review });
      } finally {
        foreignDb.sqlite.close();
      }

      const foreignRead = await app.request(
        ...operationRequest(
          'sync.review-read',
          { workspaceId: authorizedWorkspace.id, reviewId: reviewId },
          undefined
        )
      );
      const missingRead = await app.request(
        ...operationRequest(
          'sync.review-read',
          { workspaceId: authorizedWorkspace.id, reviewId: 'swr_missing_child_lineage' },
          undefined
        )
      );
      const foreignDecision = await app.request(
        ...operationRequest(
          'sync.review-decide',
          { workspaceId: authorizedWorkspace.id, reviewId: reviewId },
          {
            method: 'POST',
            body: JSON.stringify({
              decision: 'needs_refinement',
              requestId: 'foreign-review-child-lineage',
            }),
            headers: jsonHeaders(),
          }
        )
      );
      const missingDecision = await app.request(
        ...operationRequest(
          'sync.review-decide',
          { workspaceId: authorizedWorkspace.id, reviewId: 'swr_missing_child_lineage' },
          {
            method: 'POST',
            body: JSON.stringify({
              decision: 'needs_refinement',
              requestId: 'missing-review-child-lineage',
            }),
            headers: jsonHeaders(),
          }
        )
      );
      const foreignReadBody = await foreignRead.json();
      const missingReadBody = await missingRead.json();
      const foreignDecisionBody = await foreignDecision.json();
      const missingDecisionBody = await missingDecision.json();

      expect.soft(foreignRead.status).toBe(403);
      expect.soft(missingRead.status).toBe(403);
      expect.soft(foreignReadBody).toEqual(missingReadBody);
      expect.soft(foreignReadBody).toMatchObject({ code: 'workspace_access_denied' });
      expect.soft(foreignDecision.status).toBe(403);
      expect.soft(missingDecision.status).toBe(403);
      expect.soft(foreignDecisionBody).toEqual(missingDecisionBody);
      expect.soft(foreignDecisionBody).toMatchObject({ code: 'workspace_access_denied' });

      const persistedDb = openTestWorkspaceDb(coreDb, foreignWorkspace.id);
      try {
        expect(
          getWorkspaceSyncReview(persistedDb, foreignWorkspace.id, reviewId)?.review.status
        ).toBe('pending');
      } finally {
        persistedDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('denies foreign and missing workspace recovery child lineage without resolving the owner', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const authorizedWorkspace = store
      .listWorkspaces()
      .find((workspace) => workspace.kind === 'quick-chat');
    const foreignWorkspace = store.createWorkspace('Foreign workspace recovery owner');
    const app = createNanoCoreApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const reconciliationRecordId = 'wrr_foreign_child_lineage';
    const timestamp = '2026-07-19T00:00:00.000Z';

    if (!authorizedWorkspace) {
      throw new Error('Expected the local Quick Chat Workspace fixture.');
    }

    try {
      const foreignDb = openTestWorkspaceDb(coreDb, foreignWorkspace.id);
      try {
        recordWorkspaceReconciliationRecord(foreignDb, {
          id: reconciliationRecordId,
          workspaceId: foreignWorkspace.id,
          triggerReason: 'restart',
          affectedRecordIds: ['wmr_foreign_child_lineage'],
          backendHandleSummary: {
            backendKind: 'openshell',
            handleId: 'bwh_foreign_child_lineage',
            workerSessionId: 'session_foreign_child_lineage',
            cleanupStatus: 'pending',
          },
          backendReachability: { status: 'unavailable', checkedAt: timestamp, detail: null },
          collectedOutputManifestIds: [],
          evidenceBundleIds: [],
          stateBefore: 'ready',
          stateAfter: 'requires-human',
          quarantineRefs: [],
          requiredHumanDecision: 'inspect_recovery',
          retentionDecision: 'retain-backend',
          startedAt: timestamp,
          finishedAt: null,
        });
      } finally {
        foreignDb.sqlite.close();
      }

      const decide = (recordId: string, requestId: string) =>
        app.request(
          ...operationRequest(
            'sync.recovery-decide',
            { workspaceId: authorizedWorkspace.id, reconciliationRecordId: recordId },
            {
              method: 'POST',
              body: JSON.stringify({ decision: 'quarantine', requestId }),
              headers: jsonHeaders(),
            }
          )
        );
      const foreignDecision = await decide(
        reconciliationRecordId,
        'foreign-recovery-child-lineage'
      );
      const missingDecision = await decide(
        'wrr_missing_child_lineage',
        'missing-recovery-child-lineage'
      );
      const foreignBody = await foreignDecision.json();
      const missingBody = await missingDecision.json();

      expect.soft(foreignDecision.status).toBe(403);
      expect.soft(missingDecision.status).toBe(403);
      expect.soft(foreignBody).toEqual(missingBody);
      expect.soft(foreignBody).toMatchObject({ code: 'workspace_access_denied' });

      const persistedDb = openTestWorkspaceDb(coreDb, foreignWorkspace.id);
      try {
        expect(
          listWorkspaceReconciliationRecords(persistedDb, foreignWorkspace.id).find(
            (record) => record.id === reconciliationRecordId
          )?.stateAfter
        ).toBe('requires-human');
      } finally {
        persistedDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('denies foreign and missing workspace apply-result child lineage', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const authorizedWorkspace = store
      .listWorkspaces()
      .find((workspace) => workspace.kind === 'quick-chat');
    const foreignWorkspace = store.createWorkspace('Foreign workspace apply-result owner');
    const app = createNanoCoreApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const applyResultId = 'war_foreign_child_lineage';

    if (!authorizedWorkspace) {
      throw new Error('Expected the local Quick Chat Workspace fixture.');
    }

    try {
      const foreignDb = openTestWorkspaceDb(coreDb, foreignWorkspace.id);
      try {
        recordWorkspaceApplyResult(foreignDb, {
          requestId: 'record-foreign-apply-result-child-lineage',
          result: {
            appliedAt: '2026-07-19T00:00:00.000Z',
            appliedPaths: [],
            changeSetId: 'wcs_foreign_apply_result_child_lineage',
            commitIds: [],
            conflictRecords: [],
            id: applyResultId,
            reviewId: 'swr_foreign_apply_result_child_lineage',
            skippedPaths: [],
            status: 'applied',
            verification: [],
            workspaceId: foreignWorkspace.id,
          },
        });
      } finally {
        foreignDb.sqlite.close();
      }

      const foreignRead = await app.request(
        ...operationRequest(
          'sync.apply-result-read',
          { workspaceId: authorizedWorkspace.id, applyResultId: applyResultId },
          undefined
        )
      );
      const missingRead = await app.request(
        ...operationRequest(
          'sync.apply-result-read',
          { workspaceId: authorizedWorkspace.id, applyResultId: 'war_missing_child_lineage' },
          undefined
        )
      );
      const foreignBody = await foreignRead.json();
      const missingBody = await missingRead.json();

      expect.soft(foreignRead.status).toBe(403);
      expect.soft(missingRead.status).toBe(403);
      expect.soft(foreignBody).toEqual(missingBody);
      expect.soft(foreignBody).toMatchObject({ code: 'workspace_access_denied' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('denies foreign and missing Agent Environment Package snapshot child lineage', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const authorizedWorkspace = store
      .listWorkspaces()
      .find((workspace) => workspace.kind === 'quick-chat');
    const foreignWorkspace = store.createWorkspace('Foreign AEP snapshot owner');
    const app = createNanoCoreApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: 'as_foreign_aep_child_lineage',
        triggerActor: { kind: 'user', id: LOCAL_USER_ID },
        backend: {
          kind: 'openshell',
        },
        requestId: 'req_foreign_aep_child_lineage',
        turn: {
          id: 'turn_foreign_aep_child_lineage',
          workspaceId: foreignWorkspace.id,
          threadId: 'th_foreign_aep_child_lineage',
          items: [],
          status: 'running',
          error: null,
          configVersion: null,
          startedAt: '2026-07-19T00:00:00.000Z',
          completedAt: null,
          durationMs: null,
          triggerActor: { kind: 'user', id: LOCAL_USER_ID },
        },
        turnInput: 'Test child lineage',
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      })
    );

    if (!authorizedWorkspace) {
      throw new Error('Expected the local Quick Chat Workspace fixture.');
    }

    try {
      const foreignDb = openTestWorkspaceDb(coreDb, foreignWorkspace.id);
      try {
        recordAgentEnvironmentPackageSnapshot(foreignDb, {
          createdAt: '2026-07-19T00:00:01.000Z',
          environmentPackage,
        });
      } finally {
        foreignDb.sqlite.close();
      }

      const foreignRead = await app.request(
        `/api/app/workspaces/${authorizedWorkspace.id}/agent-environment/snapshots/${environmentPackage.snapshotId}`
      );
      const missingRead = await app.request(
        `/api/app/workspaces/${authorizedWorkspace.id}/agent-environment/snapshots/aep_missing_child_lineage`
      );
      const foreignBody = await foreignRead.json();
      const missingBody = await missingRead.json();

      expect.soft(foreignRead.status).toBe(403);
      expect.soft(missingRead.status).toBe(403);
      expect.soft(foreignBody).toEqual(missingBody);
      expect.soft(foreignBody).toMatchObject({ code: 'workspace_access_denied' });
      expect.soft(JSON.stringify(foreignBody)).not.toContain(environmentPackage.snapshotId);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not expose the unversioned Artifact Review command', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Unversioned Artifact Review');
    const turn = store.createTurn('ws_demo', thread.id, 'Produce artifact', {
      kind: 'user',
      id: 'user_local',
    });
    const timestamp = new Date().toISOString();
    store.createArtifact({
      id: 'artifact_unversioned_review',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      kind: 'report',
      title: 'Review target',
      status: 'ready',
      summary: 'Must use a version-owned Review.',
      version: 1,
      content: { format: 'markdown', body: '# Review target' },
      contentDigest: artifactDigest('# Review target'),
      lastMutationRequestId: 'unversioned-artifact-review-create',
      origin: {
        kind: 'turn-output',
        threadId: thread.id,
        turnId: turn.id,
        requestId: 'unversioned-artifact-review-create',
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const app = createApp({ store, turnExecutor: new FakeTurnExecutor() });

    const response = await app.request(
      '/api/app/workspaces/ws_demo/artifacts/artifact_unversioned_review/review',
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'unversioned-artifact-review-request',
          decision: 'accepted',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(response.status).toBe(404);
  });
  it('applies only accepted fixed proposals and resumes only their missing page effect', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const app = createApp({ coreDb, store });

    try {
      const accepted = await draftKnowledgeProposalFixture(app, 'accepted');
      const acceptedRequestId = knowledgeProposalRequestId('decision-accepted');
      const firstRes = await submitKnowledgeProposalDecision(
        app,
        accepted.proposalId,
        acceptedRequestId,
        'accepted'
      );
      expect(firstRes.status, await firstRes.clone().text()).toBe(200);
      const first = await firstRes.json();
      expect(first).toMatchObject({
        review: {
          reviewId: expect.stringMatching(/^kr_[a-f0-9]{64}$/),
          proposalId: accepted.proposalId,
          workspaceId: 'ws_demo',
          requestId: acceptedRequestId,
          decision: 'accepted',
          actor: { kind: 'user', id: 'user_local' },
          proposalDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          knowledgePageId: accepted.knowledgePageId,
          contentDigest: accepted.contentDigest,
          targetAbsentAtDecision: true,
          decidedAt: expect.any(String),
        },
        application: {
          knowledgePageId: accepted.knowledgePageId,
          contentDigest: accepted.contentDigest,
          present: true,
        },
      });
      const acceptedPagePath = knowledgeProposalPagePath(coreDb.dataRoot, accepted.knowledgePageId);
      expect(readFileSync(acceptedPagePath, 'utf8')).toBe(accepted.canonicalPageBytes);

      const replayRes = await submitKnowledgeProposalDecision(
        app,
        accepted.proposalId,
        acceptedRequestId,
        'accepted'
      );
      expect(replayRes.status).toBe(200);
      expect(await replayRes.json()).toEqual(first);

      const conflictRes = await submitKnowledgeProposalDecision(
        app,
        accepted.proposalId,
        acceptedRequestId,
        'rejected'
      );
      expect(conflictRes.status).toBe(409);
      await expect(conflictRes.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });

      for (const decision of ['rejected', 'deferred'] as const) {
        const fixture = await draftKnowledgeProposalFixture(app, decision);
        const response = await submitKnowledgeProposalDecision(
          app,
          fixture.proposalId,
          knowledgeProposalRequestId(`decision-${decision}`),
          decision
        );
        expect(response.status, await response.clone().text()).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          review: {
            proposalId: fixture.proposalId,
            decision,
            targetAbsentAtDecision: null,
          },
          application: null,
        });
        expect(
          existsSync(knowledgeProposalPagePath(coreDb.dataRoot, fixture.knowledgePageId))
        ).toBe(false);
      }

      const interrupted = await draftKnowledgeProposalFixture(app, 'interrupted');
      const interruptedRequestId = knowledgeProposalRequestId('decision-interrupted');
      const completed = await submitKnowledgeProposalDecision(
        app,
        interrupted.proposalId,
        interruptedRequestId,
        'accepted'
      );
      expect(completed.status, await completed.clone().text()).toBe(200);
      const interruptedPagePath = knowledgeProposalPagePath(
        coreDb.dataRoot,
        interrupted.knowledgePageId
      );
      rmSync(interruptedPagePath);
      const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      workspaceDb.sqlite
        .prepare(
          `DELETE FROM idempotency_requests
           WHERE command_name = 'knowledge.proposal.decide' AND request_id = ?`
        )
        .run(interruptedRequestId);
      workspaceDb.sqlite
        .prepare('DELETE FROM audit_events WHERE request_id = ?')
        .run(interruptedRequestId);
      workspaceDb.sqlite.close();

      const resumed = await submitKnowledgeProposalDecision(
        app,
        interrupted.proposalId,
        interruptedRequestId,
        'accepted'
      );
      expect(resumed.status, await resumed.clone().text()).toBe(200);
      expect(readFileSync(interruptedPagePath, 'utf8')).toBe(interrupted.canonicalPageBytes);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails closed when an applied proposal lacks its receipt or Audit evidence', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const app = createApp({ coreDb, store });

    try {
      for (const missingEvidence of ['receipt', 'audit'] as const) {
        const fixture = await draftKnowledgeProposalFixture(app, `missing-${missingEvidence}`);
        const requestId = knowledgeProposalRequestId(`decision-missing-${missingEvidence}`);
        const completed = await submitKnowledgeProposalDecision(
          app,
          fixture.proposalId,
          requestId,
          'accepted'
        );
        expect(completed.status, await completed.clone().text()).toBe(200);

        const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
        if (missingEvidence === 'receipt') {
          workspaceDb.sqlite
            .prepare(
              `DELETE FROM idempotency_requests
               WHERE command_name = 'knowledge.proposal.decide' AND request_id = ?`
            )
            .run(requestId);
        } else {
          workspaceDb.sqlite
            .prepare('DELETE FROM audit_events WHERE request_id = ?')
            .run(requestId);
        }
        workspaceDb.sqlite.close();

        const replay = await submitKnowledgeProposalDecision(
          app,
          fixture.proposalId,
          requestId,
          'accepted'
        );
        expect(replay.status).toBe(409);
        await expect(replay.json()).resolves.toMatchObject({ code: 'recovery_required' });
        expect(
          readFileSync(knowledgeProposalPagePath(coreDb.dataRoot, fixture.knowledgePageId), 'utf8')
        ).toBe(fixture.canonicalPageBytes);

        const evidenceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
        const remaining =
          missingEvidence === 'receipt'
            ? evidenceDb.sqlite
                .prepare(
                  `SELECT COUNT(*) AS count FROM idempotency_requests
                   WHERE command_name = 'knowledge.proposal.decide' AND request_id = ?`
                )
                .get(requestId)
            : evidenceDb.sqlite
                .prepare('SELECT COUNT(*) AS count FROM audit_events WHERE request_id = ?')
                .get(requestId);
        evidenceDb.sqlite.close();
        expect(remaining).toEqual({ count: 0 });
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects secret-bearing or host-path-bearing proposal text without durable mutation', async () => {
    const store = createDemoStore();
    const app = createApp({ store }, true);
    const sourceResponse = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.source.register',
        { workspaceId: 'ws_demo' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'knowledge-source-unsafe-proposal',
            kind: 'document',
            title: 'Unsafe proposal input source',
            uri: 'file://unsafe-proposal-source.md',
            content: 'Authoritative source without unsafe proposal text.',
          }),
        }
      )
    );
    expect(sourceResponse.status, await sourceResponse.clone().text()).toBe(200);
    const source = (await sourceResponse.json()) as {
      source: { id: string; contentDigest: string };
    };
    const sourceReference = `source:${source.source.id}@${source.source.contentDigest}`;

    for (const [index, unsafe] of [
      {
        candidateSuffix: '\nghp_openkit_candidate_route_canary',
        rationale: 'Preserve a bounded reusable lesson.',
        canary: 'ghp_openkit_candidate_route_canary',
      },
      {
        candidateSuffix: '',
        rationale: 'Preserve ghp_openkit_rationale_route_canary as a reusable lesson.',
        canary: 'ghp_openkit_rationale_route_canary',
      },
      {
        candidateSuffix: '\nHost source: /Users/example/openkit/private.md',
        rationale: 'Preserve a bounded reusable lesson.',
        canary: '/Users/example/openkit/private.md',
      },
      {
        candidateSuffix: '',
        rationale: 'Preserve the lesson from /Users/example/openkit/private.md.',
        canary: '/Users/example/openkit/private.md',
      },
    ].entries()) {
      const knowledgePageId = `unsafe-proposal-${index}`;
      const canonicalPageBytes = [
        '---',
        'type: "KnowledgePage"',
        `title: "Unsafe proposal ${index}"`,
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
        'scope: "workspace"',
        `openkit_entry_id: "${knowledgePageId}"`,
        'openkit_entry_kind: "project-context"',
        `source_refs: ${JSON.stringify([sourceReference])}`,
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        'created_at: "2026-07-19T00:00:00.000Z"',
        'updated_at: "2026-07-19T00:00:00.000Z"',
        '---',
        `Candidate lesson ${index}.${unsafe.candidateSuffix}`,
        '',
      ].join('\n');
      const response = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.proposal.draft',
          { workspaceId: 'ws_demo' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: knowledgeProposalRequestId(`unsafe-proposal-${index}`),
              knowledgePageId,
              canonicalPageBytes,
              contentDigest: artifactDigest(canonicalPageBytes),
              sourceReferences: [sourceReference],
              rationale: unsafe.rationale,
              confidence: 0.8,
            }),
          }
        )
      );
      const body = await response.text();

      expect(response.status).toBe(400);
      expect(JSON.parse(body)).toMatchObject({ code: 'invalid_request' });
      expect(body).not.toContain(unsafe.canary);
    }

    expect(store.listKnowledgeProposals('ws_demo')).toEqual([]);
  });

  it('reverses only the unchanged proposal-created page and replays without another effect', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const app = createApp({ coreDb, store });

    try {
      const accepted = await draftKnowledgeProposalFixture(app, 'reverse');
      const decisionResponse = await submitKnowledgeProposalDecision(
        app,
        accepted.proposalId,
        knowledgeProposalRequestId('decision-reverse'),
        'accepted'
      );
      expect(decisionResponse.status, await decisionResponse.clone().text()).toBe(200);
      const decision = (await decisionResponse.json()) as { review: { reviewId: string } };
      const reversalRequest = {
        requestId: knowledgeProposalRequestId('reversal-1'),
        reviewId: decision.review.reviewId,
        knowledgePageId: accepted.knowledgePageId,
        expectedContentDigest: accepted.contentDigest,
      };
      const firstRes = await submitKnowledgeProposalReversal(
        app,
        accepted.proposalId,
        reversalRequest
      );
      expect(firstRes.status, await firstRes.clone().text()).toBe(200);
      const first = await firstRes.json();
      expect(first).toEqual({
        proposalId: accepted.proposalId,
        reviewId: decision.review.reviewId,
        application: {
          knowledgePageId: accepted.knowledgePageId,
          contentDigest: accepted.contentDigest,
          present: false,
        },
      });
      expect(existsSync(knowledgeProposalPagePath(coreDb.dataRoot, accepted.knowledgePageId))).toBe(
        false
      );

      const replayRes = await submitKnowledgeProposalReversal(
        app,
        accepted.proposalId,
        reversalRequest
      );
      expect(replayRes.status).toBe(200);
      expect(await replayRes.json()).toEqual(first);

      const conflictRes = await submitKnowledgeProposalReversal(app, accepted.proposalId, {
        ...reversalRequest,
        expectedContentDigest: artifactDigest('different bytes'),
      });
      expect(conflictRes.status).toBe(409);
      await expect(conflictRes.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });

      const changed = await draftKnowledgeProposalFixture(app, 'reverse-changed');
      const changedDecision = await submitKnowledgeProposalDecision(
        app,
        changed.proposalId,
        knowledgeProposalRequestId('decision-reverse-changed'),
        'accepted'
      );
      expect(changedDecision.status, await changedDecision.clone().text()).toBe(200);
      const changedReview = (await changedDecision.json()) as { review: { reviewId: string } };
      const changedPagePath = knowledgeProposalPagePath(coreDb.dataRoot, changed.knowledgePageId);
      const changedBytes = `${changed.canonicalPageBytes}Intervening edit.\n`;
      writeFileSync(changedPagePath, changedBytes, 'utf8');
      const changedReversal = await submitKnowledgeProposalReversal(app, changed.proposalId, {
        requestId: knowledgeProposalRequestId('reversal-changed'),
        reviewId: changedReview.review.reviewId,
        knowledgePageId: changed.knowledgePageId,
        expectedContentDigest: changed.contentDigest,
      });
      expect(changedReversal.status).toBe(409);
      await expect(changedReversal.json()).resolves.toMatchObject({ code: 'conflict' });
      expect(readFileSync(changedPagePath, 'utf8')).toBe(changedBytes);

      const missing = await draftKnowledgeProposalFixture(app, 'reverse-missing');
      const missingDecision = await submitKnowledgeProposalDecision(
        app,
        missing.proposalId,
        knowledgeProposalRequestId('decision-reverse-missing'),
        'accepted'
      );
      expect(missingDecision.status, await missingDecision.clone().text()).toBe(200);
      const missingReview = (await missingDecision.json()) as { review: { reviewId: string } };
      rmSync(knowledgeProposalPagePath(coreDb.dataRoot, missing.knowledgePageId));
      const missingReversal = await submitKnowledgeProposalReversal(app, missing.proposalId, {
        requestId: knowledgeProposalRequestId('reversal-missing'),
        reviewId: missingReview.review.reviewId,
        knowledgePageId: missing.knowledgePageId,
        expectedContentDigest: missing.contentDigest,
      });
      expect(missingReversal.status).toBe(409);
      await expect(missingReversal.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects edited knowledge proposal decisions without mutation', async () => {
    const store = createDemoStore();
    const app = createApp({ store }, true);

    const res = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.proposal.decide',
        { workspaceId: 'ws_demo', proposalId: 'kp_review_edit' },
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: 'knowledge-review-edit-1',
            decision: 'edited',
            title: 'Edited proposal title',
            summary: 'Edited proposal summary.',
            message: 'Use the edited version.',
          }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    expect(res.status).toBe(400);
    expect(store.listKnowledgeProposals('ws_demo')).toEqual([]);
  });

  it('applies accepted filesystem workspace synchronization reviews through opaque staging', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Filesystem workspace sync apply');
    const thread = store.createThread(workspace.id, 'Apply filesystem workspace review');
    const turn = store.createTurn(workspace.id, thread.id, 'Produce filesystem changes', {
      kind: 'user',
      id: 'user_local',
    });
    const targetRoot = mkdtempSync(join(tmpdir(), 'openkit-filesystem-apply-target-'));
    const workerRoot = mkdtempSync(join(tmpdir(), 'openkit-filesystem-apply-worker-'));
    const stagingRoot = mkdtempSync(join(tmpdir(), 'openkit-filesystem-apply-staging-'));
    const timestamp = new Date().toISOString();

    mkdirSync(join(targetRoot, 'docs'), { recursive: true });
    mkdirSync(join(workerRoot, 'docs'), { recursive: true });
    writeFileSync(join(targetRoot, 'docs', 'guide.md'), '# Guide\n', 'utf8');
    writeFileSync(join(targetRoot, 'old.txt'), 'remove me\n', 'utf8');
    writeFileSync(join(targetRoot, 'script.sh'), '#!/bin/sh\necho demo\n', 'utf8');
    writeFileSync(join(workerRoot, 'docs', 'guide.md'), '# Guide\n\nApplied.\n', 'utf8');
    writeFileSync(join(workerRoot, 'new.txt'), 'new file\n', 'utf8');
    writeFileSync(join(workerRoot, 'script.sh'), '#!/bin/sh\necho demo\n', 'utf8');
    chmodSync(join(targetRoot, 'script.sh'), 0o644);
    chmodSync(join(workerRoot, 'script.sh'), 0o755);

    const before = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: targetRoot,
      workspaceId: workspace.id,
    });
    const after = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: workerRoot,
      workspaceId: workspace.id,
    });
    const changeSet = buildFilesystemWorkspaceChangeSet({
      after,
      before,
      changeSetId: 'wcs_filesystem_apply_1',
      createdAt: timestamp,
      inputSnapshotId: 'wis_filesystem_apply_1',
      materializationRecordId: 'wmr_filesystem_apply_1',
    });

    await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });

    const workspaceReview = {
      artifactId: 'ar_filesystem_workspace_apply_1',
      changeSet,
      patchPayload: null,
      review: {
        id: 'swr_filesystem_apply_1',
        changeSetId: changeSet.id,
        workspaceId: workspace.id,
        status: 'pending',
        staging: {
          strategy: 'filesystem_staging',
          ref: 'filesystem-staging://swr_filesystem_apply_1',
          branch: null,
        },
        diffSummary: { filesChanged: 4, additions: 0, deletions: 0 },
        riskSummary: '4 changed paths staged for human review.',
        validation: [],
        actionCenterRowId: 'workspace-review:swr_filesystem_apply_1',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };

    const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
    try {
      recordTestWorkspaceReviewMaterialization(workspaceDb, workspaceReview);
      recordWorkspaceSyncReview(workspaceDb, { item: workspaceReview });
      recordFilesystemWorkspaceStagingRoot(workspaceDb, {
        before,
        changeSetId: changeSet.id,
        createdAt: timestamp,
        reviewId: workspaceReview.review.id,
        stagingRootPath: stagingRoot,
        targetRootPath: targetRoot,
        workspaceId: workspace.id,
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    store.createArtifact({
      id: 'ar_filesystem_workspace_apply_1',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'diff',
      title: 'Filesystem workspace changes ready for review',
      status: 'ready',
      summary: workspaceReview.review.riskSummary,
      version: 1,
      content: { format: 'json', body: JSON.stringify(workspaceReview) },
      contentDigest: artifactDigest(JSON.stringify(workspaceReview)),
      lastMutationRequestId: 'filesystem-workspace-apply-artifact-1',
      origin: {
        kind: 'turn-output',
        threadId: thread.id,
        turnId: turn.id,
        requestId: 'filesystem-workspace-apply-artifact-1',
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const restartedApp = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const acceptRes = await restartedApp.request(
      ...operationRequest(
        'sync.review-decide',
        { workspaceId: workspace.id, reviewId: 'swr_filesystem_apply_1' },
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: 'filesystem-workspace-apply-request-1',
            decision: 'accepted',
          }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    expect(acceptRes.status, await acceptRes.clone().text()).toBe(200);
    await expect(acceptRes.json()).resolves.toMatchObject({
      workspaceApplyResult: {
        status: 'applied',
        appliedPaths: ['docs/guide.md', 'new.txt', 'old.txt', 'script.sh'],
        reviewId: 'swr_filesystem_apply_1',
      },
    });
    expect(readFileSync(join(targetRoot, 'docs', 'guide.md'), 'utf8')).toBe(
      '# Guide\n\nApplied.\n'
    );
    expect(readFileSync(join(targetRoot, 'new.txt'), 'utf8')).toBe('new file\n');
    expect(() => readFileSync(join(targetRoot, 'old.txt'), 'utf8')).toThrow();
    expect((statSync(join(targetRoot, 'script.sh')).mode & 0o777).toString(8)).toBe('755');

    const readApplyResult = await restartedApp.request(
      ...operationRequest(
        'sync.apply-result-read',
        { workspaceId: workspace.id, applyResultId: 'war_swr_filesystem_apply_1' },
        undefined
      )
    );
    const listApplyPlans = await restartedApp.request(
      ...operationRequest('sync.apply-plan-list', { workspaceId: workspace.id }, undefined)
    );

    const listApplyResults = await restartedApp.request(
      ...operationRequest('sync.apply-result-list', { workspaceId: workspace.id }, undefined)
    );

    expect(readApplyResult.status).toBe(200);
    await expect(readApplyResult.json()).resolves.toMatchObject({
      id: 'war_swr_filesystem_apply_1',
      changeSetId: 'wcs_filesystem_apply_1',
      appliedPaths: ['docs/guide.md', 'new.txt', 'old.txt', 'script.sh'],
      status: 'applied',
    });
    expect(listApplyPlans.status).toBe(200);
    await expect(listApplyPlans.json()).resolves.toMatchObject({
      items: [
        {
          id: 'wap_swr_filesystem_apply_1',
          reviewId: 'swr_filesystem_apply_1',
          changeSetId: 'wcs_filesystem_apply_1',
          approvalState: 'approved',
          strategy: 'filesystem',
          permissionChanges: ['script.sh'],
          plannedWrites: ['docs/guide.md', 'new.txt', 'old.txt', 'script.sh'],
        },
      ],
    });
    const reconciliationDb = openWorkspaceDb(coreDb.dataRoot, workspace.id);
    try {
      recordWorkspaceReconciliationRecord(reconciliationDb, {
        id: 'wrr_swr_filesystem_apply_1',
        workspaceId: workspace.id,
        triggerReason: 'restart',
        affectedRecordIds: ['wmr_filesystem_apply_1', 'bwh_wmr_filesystem_apply_1'],
        backendHandleSummary: {
          backendKind: 'openshell',
          handleId: 'bwh_wmr_filesystem_apply_1',
          workerSessionId: null,
          cleanupStatus: 'pending',
        },
        backendReachability: { status: 'unavailable', checkedAt: timestamp, detail: null },
        collectedOutputManifestIds: [],
        evidenceBundleIds: [],
        stateBefore: 'ready',
        stateAfter: 'requires-human',
        quarantineRefs: [],
        requiredHumanDecision: 'inspect_recovery',
        retentionDecision: 'retain-backend',
        startedAt: timestamp,
        finishedAt: null,
      });
      recordWorkspaceQuarantineRecord(reconciliationDb, {
        id: 'wqr_swr_filesystem_apply_1',
        workspaceId: workspace.id,
        lifecycleRecordIds: ['wrr_swr_filesystem_apply_1', 'wom_wcs_filesystem_apply_1'],
        failureKind: 'digest_mismatch',
        storageRef: 'quarantine/workspace-sync/wqr_swr_filesystem_apply_1',
        retentionClass: 'restricted-evidence',
        requiredHumanDecision: 'inspect_quarantined_output',
        resolution: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
        resolvedAt: null,
      });
    } finally {
      reconciliationDb.sqlite.close();
    }
    const listReconciliations = await restartedApp.request(
      ...operationRequest('sync.reconciliation-list', { workspaceId: workspace.id }, undefined)
    );
    const listQuarantines = await restartedApp.request(
      ...operationRequest('sync.quarantine-list', { workspaceId: workspace.id }, undefined)
    );
    const listSyncEvidenceBundles = await restartedApp.request(
      `/api/app/workspaces/${workspace.id}/workspace-sync/evidence-bundles`
    );
    const postApplicationApp = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const persistedApplyResult = await postApplicationApp.request(
      ...operationRequest(
        'sync.apply-result-read',
        { workspaceId: workspace.id, applyResultId: 'war_swr_filesystem_apply_1' },
        undefined
      )
    );

    expect(listApplyResults.status).toBe(200);
    await expect(listApplyResults.json()).resolves.toMatchObject({
      items: [
        {
          id: 'war_swr_filesystem_apply_1',
          reviewId: 'swr_filesystem_apply_1',
          status: 'applied',
        },
      ],
    });
    expect(listReconciliations.status).toBe(200);
    await expect(listReconciliations.json()).resolves.toMatchObject({
      items: [
        {
          id: 'wrr_swr_filesystem_apply_1',
          triggerReason: 'restart',
          stateBefore: 'ready',
          stateAfter: 'requires-human',
          retentionDecision: 'retain-backend',
        },
      ],
    });
    expect(listQuarantines.status).toBe(200);
    await expect(listQuarantines.json()).resolves.toMatchObject({
      items: [
        {
          id: 'wqr_swr_filesystem_apply_1',
          lifecycleRecordIds: ['wrr_swr_filesystem_apply_1', 'wom_wcs_filesystem_apply_1'],
          failureKind: 'digest_mismatch',
          storageRef: 'quarantine/workspace-sync/wqr_swr_filesystem_apply_1',
          resolution: 'pending',
        },
      ],
    });
    expect(listSyncEvidenceBundles.status).toBe(404);
    expect(persistedApplyResult.status).toBe(200);
    await expect(persistedApplyResult.json()).resolves.toMatchObject({
      id: 'war_swr_filesystem_apply_1',
      reviewId: 'swr_filesystem_apply_1',
    });
  });

  it('restores filesystem state when accepted review persistence fails', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Filesystem apply persistence rollback');
    const thread = store.createThread(workspace.id, 'Rollback filesystem workspace review');
    const turn = store.createTurn(workspace.id, thread.id, 'Produce filesystem changes', {
      kind: 'user',
      id: 'user_local',
    });
    const targetRoot = mkdtempSync(join(tmpdir(), 'openkit-filesystem-rollback-target-'));
    const workerRoot = mkdtempSync(join(tmpdir(), 'openkit-filesystem-rollback-worker-'));
    const stagingRoot = mkdtempSync(join(tmpdir(), 'openkit-filesystem-rollback-staging-'));
    const timestamp = new Date().toISOString();

    try {
      mkdirSync(join(targetRoot, 'docs'), { recursive: true });
      mkdirSync(join(workerRoot, 'docs'), { recursive: true });
      writeFileSync(join(targetRoot, 'docs', 'guide.md'), '# Guide\n', 'utf8');
      writeFileSync(join(targetRoot, 'old.txt'), 'restore deleted file\n', 'utf8');
      writeFileSync(join(targetRoot, 'script.sh'), '#!/bin/sh\necho demo\n', 'utf8');
      writeFileSync(join(workerRoot, 'docs', 'guide.md'), '# Guide\n\nApplied.\n', 'utf8');
      writeFileSync(join(workerRoot, 'new.txt'), 'remove added file\n', 'utf8');
      writeFileSync(join(workerRoot, 'script.sh'), '#!/bin/sh\necho demo\n', 'utf8');
      chmodSync(join(targetRoot, 'script.sh'), 0o644);
      chmodSync(join(workerRoot, 'script.sh'), 0o755);

      const before = await createFilesystemSnapshotManifest({
        createdAt: timestamp,
        resourceId: 'fs_default',
        rootPath: targetRoot,
        workspaceId: workspace.id,
      });
      const after = await createFilesystemSnapshotManifest({
        createdAt: timestamp,
        resourceId: 'fs_default',
        rootPath: workerRoot,
        workspaceId: workspace.id,
      });
      const changeSet = buildFilesystemWorkspaceChangeSet({
        after,
        before,
        changeSetId: 'wcs_filesystem_persist_rollback',
        createdAt: timestamp,
        inputSnapshotId: 'wis_filesystem_persist_rollback',
        materializationRecordId: 'wmr_filesystem_persist_rollback',
      });
      await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });

      const workspaceReview = {
        artifactId: 'ar_filesystem_persist_rollback',
        changeSet,
        patchPayload: null,
        review: {
          id: 'swr_filesystem_persist_rollback',
          changeSetId: changeSet.id,
          workspaceId: workspace.id,
          status: 'pending',
          staging: {
            strategy: 'filesystem_staging',
            ref: 'filesystem-staging://swr_filesystem_persist_rollback',
            branch: null,
          },
          diffSummary: { filesChanged: 4, additions: 0, deletions: 0 },
          riskSummary: '4 changed paths staged for human review.',
          validation: [],
          actionCenterRowId: 'workspace-review:swr_filesystem_persist_rollback',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      };
      const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        recordTestWorkspaceReviewMaterialization(workspaceDb, workspaceReview);
        recordWorkspaceSyncReview(workspaceDb, { item: workspaceReview });
        recordFilesystemWorkspaceStagingRoot(workspaceDb, {
          before,
          changeSetId: changeSet.id,
          createdAt: timestamp,
          reviewId: workspaceReview.review.id,
          stagingRootPath: stagingRoot,
          targetRootPath: targetRoot,
          workspaceId: workspace.id,
        });
        workspaceDb.sqlite.exec(`CREATE TRIGGER fail_filesystem_workspace_apply_result
          BEFORE INSERT ON workspace_apply_results
          BEGIN
            SELECT RAISE(FAIL, 'filesystem apply result persistence failed');
          END;`);
      } finally {
        workspaceDb.sqlite.close();
      }
      store.createArtifact({
        id: 'ar_filesystem_persist_rollback',
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        kind: 'diff',
        title: 'Filesystem workspace changes ready for review',
        status: 'ready',
        summary: workspaceReview.review.riskSummary,
        version: 1,
        content: { format: 'json', body: JSON.stringify(workspaceReview) },
        contentDigest: artifactDigest(JSON.stringify(workspaceReview)),
        lastMutationRequestId: 'filesystem-persist-rollback-artifact-1',
        origin: {
          kind: 'turn-output',
          threadId: thread.id,
          turnId: turn.id,
          requestId: 'filesystem-persist-rollback-artifact-1',
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
      const response = await app.request(
        ...operationRequest(
          'sync.review-decide',
          { workspaceId: workspace.id, reviewId: 'swr_filesystem_persist_rollback' },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: 'filesystem-persist-rollback-request-1',
              decision: 'accepted',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(response.status).not.toBe(200);
      expect(readFileSync(join(targetRoot, 'docs', 'guide.md'), 'utf8')).toBe('# Guide\n');
      expect(() => readFileSync(join(targetRoot, 'new.txt'), 'utf8')).toThrow();
      expect(readFileSync(join(targetRoot, 'old.txt'), 'utf8')).toBe('restore deleted file\n');
      expect(readFileSync(join(targetRoot, 'script.sh'), 'utf8')).toBe('#!/bin/sh\necho demo\n');
      expect(statSync(join(targetRoot, 'script.sh')).mode & 0o777).toBe(0o644);

      const persistedDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        expect(
          getWorkspaceSyncReview(persistedDb, workspace.id, workspaceReview.review.id)?.review
            .status
        ).toBe('pending');
        expect(listWorkspaceApplyPlans(persistedDb, workspace.id)).toHaveLength(1);
        expect(listWorkspaceApplyResults(persistedDb, workspace.id)).toEqual([]);
      } finally {
        persistedDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
      rmSync(targetRoot, { force: true, recursive: true });
      rmSync(workerRoot, { force: true, recursive: true });
      rmSync(stagingRoot, { force: true, recursive: true });
    }
  });

  it('routes interrupts through the turn executor', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Interrupt this running turn', {
      kind: 'user',
      id: 'user_local',
    });
    const app = createApp({ store, turnExecutor: new FakeTurnExecutor() }, true);
    const interruptRes = await app.request(
      ...operationRequest(
        'turn.interrupt',
        { workspaceId: 'ws_demo', threadId: 'th_demo', turnId: turn.id },
        {
          method: 'POST',
          body: JSON.stringify({
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: turn.id,
            requestId: '0190f4c8-0000-7000-8000-000000000206',
          }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    expect(interruptRes.status).toBe(200);
    expect((await interruptRes.json()) as { status: string }).toMatchObject({
      status: 'interrupted',
    });
    expect(store.getTurnEvents(turn.id).at(-1)?.requestId).toBe(
      '0190f4c8-0000-7000-8000-000000000206'
    );
  });

  it('passes the configured scheduler epoch to a worker lease', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();

    try {
      const app = createApp({ coreDb, schedulerEpoch: 12, turnExecutor: executor });
      const turnRes = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              requestId: '0190f4c8-0000-7000-8000-000000000211',
              input: 'Work in the repository',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(turnRes.status).toBe(202);
      expect(executor.startContexts).toHaveLength(1);
      expect(
        coreDb.sqlite
          .prepare('SELECT scheduler_epoch AS schedulerEpoch FROM scheduler_session_leases')
          .get()
      ).toEqual({ schedulerEpoch: 12 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('lists workspace vault grant injection metadata through App API', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Vault injection metadata route');
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_github_read',
      displayName: 'GitHub read token',
      ownerScope: 'server',
      referenceId: 'vault_github_read',
      secretKind: 'github-token',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['backend-provider'],
      grantId: 'grant_github_read_route',
      lifetime: 'turn',
      ownerScope: 'workspace',
      policyDecisionId: 'pd_grant_route',
      targetAgentSessionId: 'as_route',
      vaultReferenceId: 'vault_github_read',
      workspaceId: workspace.id,
      now: () => '2026-07-08T00:00:00.000Z',
    });
    createVaultInjectionPlan(coreDb, {
      backendCapabilityRequirement: 'OpenShell provider attachment.',
      expirationBehavior: 'Expires with turn grant.',
      grantId: 'grant_github_read_route',
      injectionVisibility: 'backend-provider',
      packageSnapshotId: 'aepsnap_route',
      planId: 'plan_github_read_route',
      redactionRule: 'Do not expose provider token.',
      revocationBehavior: 'Detach provider.',
      now: () => '2026-07-08T00:01:00.000Z',
    });
    createVaultInjectionReceipt(coreDb, {
      agentSessionId: 'as_route',
      backendSummary: 'OpenShell provider github attached.',
      grantId: 'grant_github_read_route',
      injectedAt: '2026-07-08T00:02:00.000Z',
      planId: 'plan_github_read_route',
      receiptId: 'receipt_github_read_route',
      revocationStatus: 'active',
    });
    const app = createApp({ coreDb, store });

    const grants = await app.request(`/api/app/workspaces/${workspace.id}/vault/grants`);
    const plans = await app.request(`/api/app/workspaces/${workspace.id}/vault/injection-plans`);
    const receipts = await app.request(
      `/api/app/workspaces/${workspace.id}/vault/injection-receipts`
    );

    expect(grants.status, await grants.clone().text()).toBe(200);
    expect(plans.status, await plans.clone().text()).toBe(200);
    expect(receipts.status, await receipts.clone().text()).toBe(200);
    expect(ListWorkspaceVaultGrantsResponseSchema.parse(await grants.json())).toMatchObject({
      items: [{ grantId: 'grant_github_read_route', vaultReferenceId: 'vault_github_read' }],
      workspaceId: workspace.id,
    });
    expect(ListWorkspaceVaultInjectionPlansResponseSchema.parse(await plans.json())).toMatchObject({
      items: [{ grantId: 'grant_github_read_route', planId: 'plan_github_read_route' }],
      workspaceId: workspace.id,
    });
    expect(
      ListWorkspaceVaultInjectionReceiptsResponseSchema.parse(await receipts.json())
    ).toMatchObject({
      items: [{ planId: 'plan_github_read_route', receiptId: 'receipt_github_read_route' }],
      workspaceId: workspace.id,
    });
    coreDb.sqlite.close();
  });

  it('passes authored manifest source refs from runtime config to worker turn startup', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const remoteCommit = '0123456789abcdef0123456789abcdef01234567';
    const catalog = parseWorkspaceDataSourceCatalog({
      schemaVersion: 1,
      sources: [
        {
          id: 'main-repo',
          kind: 'git',
          displayName: 'Main repository',
          locator: {
            commit: remoteCommit,
            url: 'https://git.example.test/openkit/authored-source.git',
          },
          access: 'read-write',
          sensitivity: 'internal',
          allowedSlotKinds: ['worktree'],
          status: 'active',
        },
      ],
    });
    const catalogPath = join(
      coreDb.dataRoot,
      'workspaces',
      'ws_demo',
      'config',
      'data-sources.jsonc'
    );
    const runtimeConfigManager = createRuntimeConfigManager({
      dataRoot: coreDb.dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        dataRoot: coreDb.dataRoot,
        openKitConfig: { defaults: { defaultAgentId: 'agent_codex_host' } },
        agentManifests: [
          {
            ...createTestAgentSetup().manifest,
            workspace: {
              inputs: [{ access: 'read-write', id: 'repo_root', sourceRef: 'main-repo' }],
            },
          },
        ],
        gatewayConfig: createTestGatewayConfig(),
        providerRegistry: testProviderRegistry(),
        workspaceDataSourceCatalogs: [
          {
            workspaceId: 'ws_demo',
            path: catalogPath,
            catalog,
          },
        ],
      }),
    });

    try {
      const app = createApp({
        coreDb,
        dataRoot: coreDb.dataRoot,
        store,
        runtimeConfigManager,
        schedulerEpoch: 12,
        turnExecutor: executor,
      });
      const turnRes = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              requestId: '0190f4c8-0000-7000-8000-000000000212',
              input: 'Work with the authored source',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(turnRes.status).toBe(202);
      expect(executor.startContexts[0]?.workspaceDataSourceCatalog).toMatchObject({
        sources: [expect.objectContaining({ id: 'main-repo' })],
      });
      expect(executor.startContexts[0]?.workspaceSourceRefs).toEqual({
        repo_root: 'main-repo',
      });
      expect(executor.startContexts[0]?.workspaceRoots).toEqual([
        {
          access: 'read-write',
          id: 'repo_root',
          sourceCommit: remoteCommit,
          sourceKind: 'remote-git',
          workerPath: '/workspace/openkit',
        },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('selects the Workspace MCP catalog for product-turn worker startup', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const agentManifest = createTestAgentSetup({ mcpIds: ['echo'] }).manifest;
    const catalog = parseWorkspaceMcpServerCatalog({
      schemaVersion: 1,
      servers: [
        {
          allowedTools: ['echo'],
          enabled: true,
          id: 'echo',
          schemaPolicy: 'tracking',
          transport: { command: 'node', kind: 'stdio' },
        },
      ],
    });
    const runtimeConfigManager = createRuntimeConfigManager({
      dataRoot: coreDb.dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        agentManifests: [agentManifest],
        dataRoot: coreDb.dataRoot,
        gatewayConfig: createTestGatewayConfig(),
        openKitConfig: { defaults: { defaultAgentId: agentManifest.id } },
        providerRegistry: testProviderRegistry(),
        workspaceMcpServerCatalogs: [
          {
            catalog,
            path: join(coreDb.dataRoot, 'workspaces', 'ws_demo', 'catalog', 'catalog.json'),
            workspaceId: 'ws_demo',
          },
        ],
      }),
    });

    try {
      const app = createApp({
        coreDb,
        dataRoot: coreDb.dataRoot,
        runtimeConfigManager,
        schedulerEpoch: 12,
        store,
        turnExecutor: executor,
      });
      const turnRes = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              input: 'Use the Workspace MCP server',
              requestId: '0190f4c8-0000-7000-8000-000000000214',
              threadId: 'th_demo',
              workspaceId: 'ws_demo',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(turnRes.status).toBe(202);
      expect(executor.startContexts[0]?.workspaceMcpServerCatalog).toMatchObject({
        servers: [expect.objectContaining({ id: 'echo' })],
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects authored manifest source refs with a blocked data source diagnostic', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const catalog = parseWorkspaceDataSourceCatalog({
      schemaVersion: 1,
      sources: [
        {
          id: 'disabled-repo',
          kind: 'git',
          displayName: 'Disabled repository',
          locator: {
            commit: '0123456789abcdef0123456789abcdef01234567',
            url: 'https://git.example.test/openkit/disabled-source.git',
          },
          access: 'read-write',
          sensitivity: 'internal',
          allowedSlotKinds: ['worktree'],
          status: 'disabled',
        },
      ],
    });
    const catalogPath = join(
      coreDb.dataRoot,
      'workspaces',
      'ws_demo',
      'config',
      'data-sources.jsonc'
    );
    const runtimeConfigManager = createRuntimeConfigManager({
      dataRoot: coreDb.dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        dataRoot: coreDb.dataRoot,
        openKitConfig: { defaults: { defaultAgentId: 'agent_codex_host' } },
        agentManifests: [
          {
            ...createTestAgentSetup().manifest,
            workspace: {
              inputs: [{ access: 'read-write', id: 'repo_root', sourceRef: 'disabled-repo' }],
            },
          },
        ],
        providerRegistry: testProviderRegistry(),
        workspaceDataSourceCatalogs: [
          {
            workspaceId: 'ws_demo',
            path: catalogPath,
            catalog,
          },
        ],
      }),
    });

    try {
      const app = createApp({
        coreDb,
        dataRoot: coreDb.dataRoot,
        store,
        runtimeConfigManager,
        schedulerEpoch: 12,
        turnExecutor: executor,
      });
      const turnRes = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              requestId: '0190f4c8-0000-7000-8000-000000000213',
              input: 'Work with the blocked source',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const payload = (await turnRes.json()) as Record<string, unknown>;

      expect(turnRes.status).toBe(409);
      expect(payload).toMatchObject({
        code: 'workspace_data_source_blocked',
        message: 'Workspace data source disabled: disabled-repo',
      });
      expect(executor.startContexts).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns a protocol API error when interrupting with an invalid request body', async () => {
    const app = createApp({ turnExecutor: new FakeTurnExecutor() });
    const res = await app.request(
      ...operationRequest(
        'turn.interrupt',
        { workspaceId: 'ws_demo', threadId: 'th_demo', turnId: 'tu_missing' },
        {
          method: 'POST',
          body: JSON.stringify({}),
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('requestId'),
    });
  });

  it('returns the logical-model fallback error after quick chat routes are exhausted', async () => {
    const app = createApp(
      {
        gatewayConfig: createTestGatewayConfig({
          privateRoute: {
            providerProfileId: 'openrouter',
            providerModel: 'openai/gpt-5.2',
          },
        }),
        providerCredentialResolver: () => 'test-key',
        providerRegistry: new ProviderRegistry([
          {
            baseUrl: 'https://openrouter.ai/api/v1',
            defaultModel: 'openai/gpt-5.2',
            displayName: 'OpenRouter',
            id: 'openrouter',
            kind: 'gateway',
            models: ['openai/gpt-5.2'],
            secretRef: 'env:OPENROUTER_API_KEY',
          },
        ]),
        turnExecutor: new FakeTurnExecutor(),
        llmPiAiClient: {
          createChatCompletion: async () => {
            throw attachPiAiFailure(
              new OpenAICompatibleProviderError({
                status: 429,
                code: 'rate_limit_exceeded',
                message: 'Rate limit exceeded token=tok_private_rate_limit.',
              })
            );
          },
        } as unknown as PiAiGatewayClient,
      },
      true
    );
    const res = await app.request(
      ...operationRequest(
        'chat.quick',
        {},
        {
          method: 'POST',
          body: JSON.stringify({
            input: 'hello',
          }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    const body = await res.json();

    expect(res.status, JSON.stringify(body)).toBe(503);
    expect(body).toMatchObject({
      code: 'gateway_logical_model_unavailable',
      message: 'Logical model is temporarily unavailable.',
    });
    expect(body).not.toHaveProperty('details');
  });

  it('emits SSE events that conform to the shared protocol schema', async () => {
    const store = createDemoStore();
    const app = createApp({ store, turnExecutor: new FakeTurnExecutor() });
    const res = await app.request(
      ...operationRequest(
        'turn.start',
        {},
        {
          method: 'POST',
          body: JSON.stringify({
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            requestId: '0190f4c8-0000-7000-8000-000000000207',
            input: 'Ship the update',
          }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    const turn = (await res.json()) as { id: string };

    for (const event of store.getTurnEvents(turn.id)) {
      expect(() => SseEventEnvelopeSchema.parse(event)).not.toThrow();
      expect(event.requestId).toBe('0190f4c8-0000-7000-8000-000000000207');
    }
  });

  it('binds authority generations only to native HTTP/2 accepted connections and server close', async () => {
    const coreDb = createCoreDb();
    const authority = createNanoHostTransportSessionAuthority();
    coreDb.sqlite
      .prepare(
        `INSERT INTO nanohost_integration_identities (
          identity_id, deployment_id, status, created_at
        ) VALUES ('integration_nanohost_main', 'deployment-main', 'active', ?)`
      )
      .run('2026-08-10T00:00:00.000Z');
    const issued = createNanoHostTransportTokenRecord(coreDb, {
      deploymentId: 'deployment-main',
      expiresAt: '2999-01-01T00:00:00.000Z',
      now: new Date('2026-08-10T00:00:00.000Z'),
      ownerNanoHostIdentityId: 'integration_nanohost_main',
      responsibleServerAdminActorId: 'user_admin',
    });
    const routeHandler = vi.fn(async () => ({ status: 200 }));
    const effectHandler = vi.fn(async () => ({ status: 'succeeded' }));
    const dispatch = createNanoHostSessionDispatch({
      effectHandler,
      routeHandler,
      sessionAuthority: authority,
    });
    const app = createNanoCoreApp({
      coreDb,
      mode: 'server',
      nanohostTransportSessionAuthority: authority,
      nanoHostSessionDispatch: dispatch,
      openKitConfig: {
        nanohost: {
          bind: { host: '127.0.0.1', port: 3001 },
          credentialRef: 'nanohost-transport:integration_nanohost_main',
          credentialSlots: {
            A: {
              companionPath: '/etc/openkit/nanohost-token-a.json',
              secretPath: '/etc/openkit/nanohost-token-a',
            },
            B: {
              companionPath: '/etc/openkit/nanohost-token-b.json',
              secretPath: '/etc/openkit/nanohost-token-b',
            },
          },
          deploymentId: 'deployment-main',
          identityId: 'integration_nanohost_main',
          rendezvousUrl: 'http://127.0.0.1:3000',
        },
      },
    });
    const acceptedSessions: ServerHttp2Session[] = [];
    const server = createHttp2Server(getRequestListener(app.fetch));
    server.on('session', (session) => acceptedSessions.push(session));
    let firstClient: ClientHttp2Session | undefined;
    let secondClient: ClientHttp2Session | undefined;
    let thirdClient: ClientHttp2Session | undefined;
    let fourthClient: ClientHttp2Session | undefined;

    /** Sends the exact empty-body admission request over one accepted H2 connection. */
    const admit = async (client: ClientHttp2Session) => {
      const request = client.request({
        ':method': 'POST',
        ':path': '/api/nanohost/transport/session/admit',
        authorization: `Bearer ${issued.secret}`,
        'content-type': 'application/json',
      });
      const chunks: Buffer[] = [];
      let status = 0;
      request.on('response', (headers) => {
        status = Number(headers[':status']);
      });
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.end('{}');
      await once(request, 'end');
      return {
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        status,
      };
    };

    /** Sends one private effect poll or result over the already-admitted connection. */
    const postEffect = async (
      client: ClientHttp2Session,
      path: string,
      body: string | Buffer = '{}',
      headers: Readonly<Record<string, string>> = {}
    ) => {
      const request = client.request({
        ':method': 'POST',
        ':path': path,
        'content-type': 'application/json',
        ...headers,
      });
      const chunks: Buffer[] = [];
      const chunkLengths: number[] = [];
      let responseHeaders: Readonly<Record<string, unknown>> = {};
      let status = 0;
      request.on('response', (headers) => {
        responseHeaders = headers;
        status = Number(headers[':status']);
      });
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        chunkLengths.push(chunk.byteLength);
      });
      request.end(body);
      await once(request, 'end');
      const bodyBytes = Buffer.concat(chunks);
      return {
        body: bodyBytes.toString('utf8'),
        bodyBytes,
        chunkLengths,
        headers: responseHeaders,
        status,
      };
    };

    try {
      const synthetic = await app.request('/api/nanohost/transport/session/admit', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${issued.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      expect(synthetic.status).not.toBe(200);

      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Native HTTP/2 test server did not expose a TCP address.');
      }
      const origin = `http://127.0.0.1:${address.port}`;
      firstClient = connectHttp2(origin);
      await once(firstClient, 'connect');

      await expect(admit(firstClient)).resolves.toEqual({
        body: expect.objectContaining({
          connectionGeneration: 1,
          identityId: 'integration_nanohost_main',
          mayCarryWork: true,
          role: 'authoritative',
        }),
        status: 200,
      });
      expect(getNanoHostRuntimeTarget(coreDb, 'integration_nanohost_main')).toMatchObject({
        connectionGeneration: 1,
        freshEmpty: false,
        predecessorFenced: false,
        ready: false,
      });
      const preReadyPoll = await postEffect(
        firstClient,
        '/api/nanohost/transport/effects/sandbox.create'
      );
      expect(Math.floor(preReadyPoll.status / 100)).not.toBe(2);
      const syntheticReadiness = await app.request('/api/nanohost/transport/session/readiness', {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      });
      expect(Math.floor(syntheticReadiness.status / 100)).not.toBe(2);
      const nonemptyReadiness = await postEffect(
        firstClient,
        '/api/nanohost/transport/session/readiness',
        '{"ready":true}'
      );
      expect(Math.floor(nonemptyReadiness.status / 100)).not.toBe(2);
      await expect(
        postEffect(
          firstClient,
          '/api/nanohost/transport/session/readiness',
          JSON.stringify({ physicalEpoch: 'a'.repeat(64) })
        )
      ).resolves.toMatchObject({ body: '', status: 204 });
      expect(getNanoHostRuntimeTarget(coreDb, 'integration_nanohost_main')).toMatchObject({
        connectionGeneration: 1,
        freshEmpty: true,
        physicalEpoch: 'a'.repeat(64),
        predecessorFenced: true,
        ready: true,
      });
      const dockerfile = 'é'.repeat(965_971);
      const buildRequestId = 'f'.repeat(64);
      const dockerfileDigest = `sha256:${createHash('sha256').update(dockerfile).digest('hex')}`;
      const unavailableBuildInput = await postEffect(
        firstClient,
        '/api/nanohost/transport/effects/image.build/input',
        '{}',
        { 'x-openkit-request-id': buildRequestId }
      );
      expect(unavailableBuildInput.status).toBe(409);
      const buildEffect = dispatch.effect({
        input: {
          arguments: { NODE_VERSION: '24.16.0' },
          argumentsDigest: `sha256:${'1'.repeat(64)}`,
          contextDigest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          contextRef: 'build-context://empty/v1',
          dockerfile,
          dockerfileDigest,
          egress: [{ host: 'registry.npmjs.org', port: 443 }],
          layerLimit: 128,
          outputLimitBytes: 21_474_836_480,
          timeLimitSeconds: 1800,
        },
        kind: 'image.build',
        requestId: buildRequestId,
      });
      const buildPoll = await postEffect(
        firstClient,
        '/api/nanohost/transport/effects/image.build'
      );
      expect(buildPoll.status).toBe(200);
      expect(JSON.parse(buildPoll.body)).toMatchObject({
        dockerfileByteLength: 1_931_942,
        dockerfileDigest,
        requestId: buildRequestId,
      });
      expect(JSON.parse(buildPoll.body)).not.toHaveProperty('dockerfile');
      expect(buildPoll.bodyBytes.byteLength).toBeLessThanOrEqual(512 * 1024);
      const wrongBuildInput = await postEffect(
        firstClient,
        '/api/nanohost/transport/effects/image.build/input',
        '{}',
        { 'x-openkit-request-id': '0'.repeat(64) }
      );
      expect(wrongBuildInput.status).toBe(409);
      const buildInput = await postEffect(
        firstClient,
        '/api/nanohost/transport/effects/image.build/input',
        '{}',
        { 'x-openkit-request-id': buildRequestId }
      );
      expect(buildInput.status).toBe(200);
      expect(buildInput.headers).toEqual(
        expect.objectContaining({
          'content-length': '1931942',
          'content-type': 'application/octet-stream',
          'x-openkit-byte-length': '1931942',
          'x-openkit-request-id': buildRequestId,
          'x-openkit-sha256': dockerfileDigest,
        })
      );
      expect(buildInput.bodyBytes.equals(Buffer.from(dockerfile))).toBe(true);
      expect(buildInput.chunkLengths.every((length) => length <= 65_536)).toBe(true);
      await expect(
        postEffect(firstClient, '/api/nanohost/transport/effects/image.build/input', '{}', {
          'x-openkit-request-id': buildRequestId,
        })
      ).resolves.toMatchObject({ status: 409 });
      await expect(
        postEffect(
          firstClient,
          '/api/nanohost/transport/effects/image.build/result',
          JSON.stringify({ failureCode: 'effect_failed', requestId: buildRequestId })
        )
      ).resolves.toMatchObject({ body: '', status: 204 });
      await expect(buildEffect).rejects.toThrow(/effect_failed|effect failed/i);
      await expect(
        postEffect(firstClient, '/api/nanohost/transport/effects/sandbox.create')
      ).resolves.toMatchObject({ body: '', status: 204 });
      const importBytes = Buffer.from('context-data');
      const importRequestId = 'a'.repeat(64);
      const importSha256 = `sha256:${createHash('sha256').update(importBytes).digest('hex')}`;
      let importSettled = false;
      const importEffect = dispatch
        .effect({
          input: {
            body: importBytes,
            byteLength: importBytes.byteLength,
            relativePath: 'context.json',
            sandboxId: 'sandbox-session-main',
            sha256: importSha256,
            slot: 'turn-inputs',
          },
          kind: 'reference.import',
          requestId: importRequestId,
        })
        .finally(() => {
          importSettled = true;
        });
      await Promise.resolve();
      expect(importSettled).toBe(false);
      const importPoll = await postEffect(
        firstClient,
        '/api/nanohost/transport/effects/reference.import'
      );
      expect(importPoll.status).toBe(200);
      expect(importPoll.bodyBytes).toEqual(importBytes);
      expect(importPoll.headers).toMatchObject({
        'content-length': String(importBytes.byteLength),
        'content-type': 'application/octet-stream',
        'x-openkit-byte-length': String(importBytes.byteLength),
        'x-openkit-relative-path': 'context.json',
        'x-openkit-request-id': importRequestId,
        'x-openkit-sha256': importSha256,
        'x-openkit-slot': 'turn-inputs',
      });
      expect(importSettled).toBe(false);
      const wrongImportResult = await postEffect(
        firstClient,
        '/api/nanohost/transport/effects/reference.import/result',
        JSON.stringify({ requestId: 'b'.repeat(64) })
      );
      expect(Math.floor(wrongImportResult.status / 100)).not.toBe(2);
      expect(importSettled).toBe(false);
      await expect(
        postEffect(firstClient, '/api/nanohost/transport/effects/sandbox.create')
      ).resolves.toMatchObject({ body: '', status: 204 });
      await expect(
        postEffect(
          firstClient,
          '/api/nanohost/transport/effects/reference.import/result',
          JSON.stringify({
            byteLength: importBytes.byteLength,
            reference: 'sandbox://sandbox-session-main/turn-inputs/context.json',
            requestId: importRequestId,
          })
        )
      ).resolves.toMatchObject({ body: '', status: 204 });
      await expect(importEffect).resolves.toEqual({
        byteLength: importBytes.byteLength,
        reference: 'sandbox://sandbox-session-main/turn-inputs/context.json',
      });
      const exportBytes = Buffer.from('worker-output');
      const exportRequestId = 'c'.repeat(64);
      const exportSha256 = `sha256:${createHash('sha256').update(exportBytes).digest('hex')}`;
      const exportEffect = dispatch.effect({
        input: {
          maxByteLength: 268_435_456,
          presence: 'required',
          relativePath: 'report.md',
          sandboxId: 'sandbox-session-main',
          slot: 'turn-outputs',
          terminalBarrierProved: true,
        },
        kind: 'file.export',
        requestId: exportRequestId,
      });
      const exportPoll = await postEffect(
        firstClient,
        '/api/nanohost/transport/effects/file.export'
      );
      expect(exportPoll.status).toBe(200);
      expect(JSON.parse(exportPoll.body)).toEqual({
        maxByteLength: 268_435_456,
        presence: 'required',
        relativePath: 'report.md',
        requestId: exportRequestId,
        sandboxId: 'sandbox-session-main',
        slot: 'turn-outputs',
        terminalBarrierProved: true,
      });
      const exportHeaders = {
        'content-length': String(exportBytes.byteLength),
        'content-type': 'application/octet-stream',
        'x-openkit-byte-length': String(exportBytes.byteLength),
        'x-openkit-relative-path': 'report.md',
        'x-openkit-request-id': exportRequestId,
        'x-openkit-sha256': exportSha256,
        'x-openkit-slot': 'turn-outputs',
      };
      await expect(
        postEffect(firstClient, '/api/nanohost/transport/effects/file.export/result', exportBytes, {
          ...exportHeaders,
          'x-openkit-sha256': `sha256:${'d'.repeat(64)}`,
        })
      ).resolves.toMatchObject({ status: 409 });
      await expect(
        postEffect(
          firstClient,
          '/api/nanohost/transport/effects/file.export/result',
          exportBytes,
          exportHeaders
        )
      ).resolves.toMatchObject({ body: '', status: 204 });
      await expect(exportEffect).resolves.toMatchObject({
        byteLength: exportBytes.byteLength,
        sha256: exportSha256,
      });
      const unknownResult = await postEffect(
        firstClient,
        '/api/nanohost/transport/effects/sandbox.create/result',
        JSON.stringify({ requestId: 'unknown-request' })
      );
      expect(Math.floor(unknownResult.status / 100)).not.toBe(2);
      await expect(
        postEffect(firstClient, '/api/nanohost/transport/effects/attempt-session.cleanup')
      ).resolves.toMatchObject({ status: 404 });
      secondClient = connectHttp2(origin);
      await once(secondClient, 'connect');
      await expect(admit(secondClient)).resolves.toEqual({
        body: expect.objectContaining({
          connectionGeneration: 2,
          identityId: 'integration_nanohost_main',
          mayCarryWork: false,
          role: 'candidate',
        }),
        status: 200,
      });
      expect(acceptedSessions).toHaveLength(2);
      const firstServerSession = acceptedSessions[0];
      const secondServerSession = acceptedSessions[1];
      if (!firstServerSession || !secondServerSession) {
        throw new Error('Native HTTP/2 server did not retain both accepted sessions.');
      }
      expect(authority.mayCarryWork(firstServerSession)).toBe(true);
      expect(authority.mayCarryWork(secondServerSession)).toBe(false);
      const candidatePoll = await postEffect(
        secondClient,
        '/api/nanohost/transport/effects/sandbox.create'
      );
      expect(Math.floor(candidatePoll.status / 100)).not.toBe(2);
      const candidateReadiness = await postEffect(
        secondClient,
        '/api/nanohost/transport/session/readiness',
        JSON.stringify({ physicalEpoch: 'b'.repeat(64) })
      );
      expect(Math.floor(candidateReadiness.status / 100)).not.toBe(2);
      await expect(
        dispatch.route(firstServerSession, {
          body: new Uint8Array(),
          credentialClass: 'worker-control',
          family: 'worker-control',
          path: '/worker-control/heartbeat',
        })
      ).resolves.toEqual({ status: 200 });
      await expect(
        dispatch.route(firstServerSession, {
          body: new Uint8Array(),
          credentialClass: 'capability',
          family: 'capability',
          path: '/capabilities/mcp/echo',
        })
      ).resolves.toEqual({ status: 200 });
      await expect(
        dispatch.effect(firstServerSession, {
          input: {
            backendSessionId: 'sandbox-session-main',
            requestId: 'request-sandbox-create-main',
          },
          kind: 'sandbox.create',
        })
      ).resolves.toEqual({ status: 'succeeded' });
      await expect(
        dispatch.effect(secondServerSession, {
          input: {
            backendSessionId: 'sandbox-session-candidate',
            requestId: 'request-sandbox-create-candidate',
          },
          kind: 'sandbox.create',
        })
      ).rejects.toThrow(/connection|authoritative|fenc/i);
      await expect(
        dispatch.effect(firstServerSession, {
          input: { requestId: 'request-retired-cleanup' },
          kind: 'attempt-session.cleanup',
        })
      ).rejects.toThrow(/effect|operation|enabled/i);
      expect(routeHandler).toHaveBeenCalledTimes(2);
      expect(effectHandler).toHaveBeenCalledTimes(1);

      const observedCandidateClose = new Promise<void>((resolve) => {
        secondServerSession.prependOnceListener('close', () => resolve());
      });
      secondClient.destroy();
      await observedCandidateClose;
      expect(authority.mayCarryWork(firstServerSession)).toBe(true);
      expect(authority.mayCarryWork(secondServerSession)).toBe(false);
      expect(authority.authoritativeGeneration('integration_nanohost_main')).toBe(1);
      expect(getNanoHostRuntimeTarget(coreDb, 'integration_nanohost_main')).toMatchObject({
        connectionGeneration: 2,
        freshEmpty: false,
        predecessorFenced: false,
        ready: false,
      });

      thirdClient = connectHttp2(origin);
      await once(thirdClient, 'connect');
      await expect(admit(thirdClient)).resolves.toEqual({
        body: expect.objectContaining({
          connectionGeneration: 3,
          identityId: 'integration_nanohost_main',
          mayCarryWork: false,
          role: 'candidate',
        }),
        status: 200,
      });
      expect(acceptedSessions).toHaveLength(3);
      const thirdServerSession = acceptedSessions[2];
      if (!thirdServerSession) {
        throw new Error('Native HTTP/2 server did not retain the successor session.');
      }

      const observedPredecessorClose = once(firstServerSession, 'close');
      firstClient.destroy();
      await observedPredecessorClose;
      expect(authority.mayCarryWork(firstServerSession)).toBe(false);
      expect(authority.mayCarryWork(thirdServerSession)).toBe(true);
      expect(authority.authoritativeGeneration('integration_nanohost_main')).toBe(3);
      expect(getNanoHostRuntimeTarget(coreDb, 'integration_nanohost_main')).toMatchObject({
        connectionGeneration: 3,
        predecessorFenced: true,
        ready: false,
      });
      await expect(
        postEffect(
          thirdClient,
          '/api/nanohost/transport/session/readiness',
          JSON.stringify({ physicalEpoch: 'b'.repeat(64) })
        )
      ).resolves.toMatchObject({ body: '', status: 204 });
      expect(getNanoHostRuntimeTarget(coreDb, 'integration_nanohost_main')).toMatchObject({
        connectionGeneration: 3,
        freshEmpty: true,
        physicalEpoch: 'b'.repeat(64),
        predecessorFenced: true,
        ready: true,
      });
      await expect(
        postEffect(
          thirdClient,
          '/api/nanohost/transport/effects/file.export/result',
          exportBytes,
          exportHeaders
        )
      ).resolves.toMatchObject({ body: '', status: 204 });
      await expect(
        postEffect(
          thirdClient,
          '/api/nanohost/transport/effects/file.export/result',
          Buffer.from('changed-output'),
          exportHeaders
        )
      ).resolves.toMatchObject({ status: 409 });

      const requiredRequestId = '8'.repeat(64);
      const requiredBytes = Buffer.from('required-output');
      const requiredSha256 = `sha256:${createHash('sha256').update(requiredBytes).digest('hex')}`;
      const requiredEffect = dispatch.effect({
        input: {
          maxByteLength: 268_435_456,
          presence: 'required',
          relativePath: 'required.md',
          sandboxId: 'sandbox-session-main',
          slot: 'turn-outputs',
          terminalBarrierProved: true,
        },
        kind: 'file.export',
        requestId: requiredRequestId,
      });
      await expect(
        postEffect(thirdClient, '/api/nanohost/transport/effects/file.export')
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        postEffect(
          thirdClient,
          '/api/nanohost/transport/effects/file.export/result',
          JSON.stringify({ requestId: requiredRequestId, state: 'absent' })
        )
      ).resolves.toMatchObject({ status: 409 });
      await expect(
        postEffect(
          thirdClient,
          '/api/nanohost/transport/effects/file.export/result',
          requiredBytes,
          {
            'content-length': String(requiredBytes.byteLength),
            'content-type': 'application/octet-stream',
            'x-openkit-byte-length': String(requiredBytes.byteLength),
            'x-openkit-relative-path': 'required.md',
            'x-openkit-request-id': requiredRequestId,
            'x-openkit-sha256': requiredSha256,
            'x-openkit-slot': 'turn-outputs',
          }
        )
      ).resolves.toMatchObject({ body: '', status: 204 });
      await expect(requiredEffect).resolves.toMatchObject({ sha256: requiredSha256 });

      const optionalRequestId = '7'.repeat(64);
      const optionalEffect = dispatch.effect({
        input: {
          maxByteLength: 268_435_456,
          presence: 'optional',
          relativePath: 'optional.md',
          sandboxId: 'sandbox-session-main',
          slot: 'turn-outputs',
          terminalBarrierProved: true,
        },
        kind: 'file.export',
        requestId: optionalRequestId,
      });
      const optionalPoll = await postEffect(
        thirdClient,
        '/api/nanohost/transport/effects/file.export'
      );
      expect(JSON.parse(optionalPoll.body)).toMatchObject({
        presence: 'optional',
        requestId: optionalRequestId,
      });
      const absenceBody = JSON.stringify({ requestId: optionalRequestId, state: 'absent' });
      await expect(
        postEffect(thirdClient, '/api/nanohost/transport/effects/file.export/result', absenceBody, {
          'x-openkit-slot': 'turn-outputs',
        })
      ).resolves.toMatchObject({ status: 400 });
      await expect(
        postEffect(thirdClient, '/api/nanohost/transport/effects/file.export/result', absenceBody)
      ).resolves.toMatchObject({ body: '', status: 204 });
      await expect(optionalEffect).resolves.toEqual({ state: 'absent' });
      await expect(
        postEffect(thirdClient, '/api/nanohost/transport/effects/file.export/result', absenceBody)
      ).resolves.toMatchObject({ status: 409 });

      fourthClient = connectHttp2(origin);
      await once(fourthClient, 'connect');
      await expect(admit(fourthClient)).resolves.toEqual({
        body: expect.objectContaining({
          connectionGeneration: 4,
          identityId: 'integration_nanohost_main',
          mayCarryWork: false,
          role: 'candidate',
        }),
        status: 200,
      });
      expect(acceptedSessions).toHaveLength(4);
      const fourthServerSession = acceptedSessions[3];
      if (!fourthServerSession) {
        throw new Error('Native HTTP/2 server did not retain the second successor session.');
      }
      const observedThirdClose = once(thirdServerSession, 'close');
      thirdClient.destroy();
      await observedThirdClose;
      expect(authority.mayCarryWork(thirdServerSession)).toBe(false);
      expect(authority.mayCarryWork(fourthServerSession)).toBe(true);
      await expect(
        postEffect(
          fourthClient,
          '/api/nanohost/transport/session/readiness',
          JSON.stringify({ physicalEpoch: 'c'.repeat(64) })
        )
      ).resolves.toMatchObject({ body: '', status: 204 });
      await expect(
        postEffect(fourthClient, '/api/nanohost/transport/effects/file.export/result', absenceBody)
      ).resolves.toMatchObject({ body: '', status: 204 });
      await expect(
        postEffect(fourthClient, '/api/nanohost/transport/effects/file.export/result', absenceBody)
      ).resolves.toMatchObject({ status: 409 });

      expect(() => authority.closePhysicalConnection(secondServerSession)).not.toThrow();
      expect(authority.authoritativeGeneration('integration_nanohost_main')).toBe(4);
      expect(getNanoHostRuntimeTarget(coreDb, 'integration_nanohost_main')).toMatchObject({
        connectionGeneration: 4,
        physicalEpoch: 'c'.repeat(64),
        predecessorFenced: true,
        ready: true,
      });

      const observedSoleClose = once(fourthServerSession, 'close');
      fourthClient.destroy();
      await observedSoleClose;
      expect(authority.authoritativeGeneration('integration_nanohost_main')).toBeNull();
      expect(getNanoHostRuntimeTarget(coreDb, 'integration_nanohost_main')).toMatchObject({
        connectionGeneration: 4,
        predecessorFenced: true,
        ready: false,
      });
      const productionComposition = `${readFileSync(
        new URL('./app.ts', import.meta.url),
        'utf8'
      )}\n${readFileSync(new URL('./index.ts', import.meta.url), 'utf8')}`;
      for (const bootstrapOwner of [
        'workerControlTokenHash',
        'workerInferenceTokenHash',
        'starting',
        'final_status',
      ]) {
        expect(productionComposition).toContain(bootstrapOwner);
      }
    } finally {
      firstClient?.destroy();
      secondClient?.destroy();
      thirdClient?.destroy();
      fourthClient?.destroy();
      server.close();
      coreDb.sqlite.close();
    }
  });
});

// This fixture supplies confirmed image evidence; the production resolver and subject checks still run.
vi.mock('./runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    './test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});
