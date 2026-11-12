import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspaceMcpServer } from '@openkit/config-schema';
import { allocateEntityId, type PolicyDecisionV1 } from '@openkit/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import { recordProductPermissionDecision } from '../policy/permission-decisions.js';
import { resolveAgentEnvironmentPackage } from '../runtime/agent-environment.js';
import {
  admitCapturedPendingCall,
  evaluateCapturedPendingCall,
  executeCapturedPendingCall,
  type PreparedCapturedPendingCall,
  prepareCapturedPendingCall,
} from '../runtime/captured-pending-call.js';
import {
  mcpToolArgumentsContentDigest,
  recordMcpToolSchemaSnapshot,
} from '../runtime/mcp-tool-schema-snapshots.js';
import {
  raiseRecordedPendingRequest,
  respondRecordedApproval,
} from '../runtime/pending-request-flow.js';
import { executionCallIdForRequest, readPendingRequest } from '../runtime/pending-requests.js';
import type { WorkerMcpGateway } from '../runtime/worker-mcp-gateway.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openWorkspaceDb } from './db.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// G12/TB7: this is a source-gap witness, not proof of positive approvedBy support.
// The real approval execution owns no tool Item. Never invent one to make the join work.
it('keeps a genuine granted MCP execution without an Item out of timeline approval badges', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timeline-approved-gap-'));
  const coreDb = createTestCoreDb(root);
  const userId = ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot: root });
  const db = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
  cleanups.push(() => disposeTestStore(root, db, coreDb));
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  const setup = createTestAgentSetup({ agentId: 'agent_demo', mcpIds: ['echo-server'] });
  admitTestNativeEnvironment(coreDb, setup.manifest);
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Genuine captured approval');
  const turn = await store.createTurn(
    DEMO_WORKSPACE_ID,
    thread.id,
    'Approve the exact call',
    { kind: 'user', id: userId },
    null,
    { agentId: 'agent_demo' }
  );
  const catalog = {
    schemaVersion: 1 as const,
    servers: [
      {
        id: 'echo-server',
        enabled: true,
        allowedTools: ['echo'],
        credentialBindings: [],
        pinnedSchemaSnapshotId: null,
        schemaPolicy: 'tracking' as const,
        timeoutMs: 2000,
        transport: { kind: 'stdio' as const, command: process.execPath, args: [], environment: {} },
      },
    ],
  };
  const environmentPackage = await resolveAgentEnvironmentPackage({
    coreDb,
    captureCoverage: { scope: 'server', value: 'off' },
    agentSessionId: allocateEntityId('as'),
    agentSetup: setup,
    backend: { kind: 'openshell' },
    createdAt: turn.startedAt,
    requestId: 'capture-timeline-gap',
    triggerActor: turn.triggerActor,
    turn,
    workspaceCwd: '/workspace',
    workspaceMcpServerCatalog: catalog,
    workspaceRoots: [],
  });
  const schemaSnapshotId = await recordMcpToolSchemaSnapshot({
    workspaceDb: db,
    workspaceId: DEMO_WORKSPACE_ID,
    environmentPackage,
    schemaSnapshotId: 'schema_timeline_gap',
    serverId: 'echo-server',
    source: 'live',
    tools: [
      {
        name: 'echo',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
          additionalProperties: false,
        },
      },
    ],
  });
  const requestId = 'ap_timeline_gap';
  const requestItemId = allocateEntityId('it');
  await store.createItem({
    id: requestItemId,
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    type: 'approval-request',
    status: 'completed',
    approvalRequestId: requestId,
    title: 'Approve echo',
    description: 'Execute exactly this message.',
    kind: 'permission',
    createdAt: turn.startedAt,
    completedAt: turn.startedAt,
  });
  const digest = `sha256:${'a'.repeat(64)}`;
  const mediation: PolicyDecisionV1 = {
    operation: 'mcp.call-tool',
    stage: 'decide',
    authorizationRevision: digest,
    proposalDigest: digest,
    role: 'final',
    kernel: { effect: 'allow', reason: 'granted' },
    subject: {
      principal: { kind: 'human', id: userId },
      onBehalfOf: null,
      actor: { kind: 'agent', id: 'agent_demo', responsibleUserId: userId },
      process: { workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id, turnId: turn.id },
      credentialKind: 'worker-package',
      responsibleHumanId: userId,
    },
    invocations: [],
    consumedStatements: [],
  };
  const sourceDecisionId = allocateEntityId('pd');
  const decisionBase = {
    workspaceDb: db,
    workspaceId: DEMO_WORKSPACE_ID,
    ownerScope: 'workspace' as const,
    policyEngineVersion: 'fixture:v1',
    policySnapshotId: digest,
    subjectSummary: {},
    resourceSummary: { serverId: 'echo-server', toolName: 'echo' },
    action: 'tool.use',
    reasonCode: 'granted',
    enforcementPoint: 'mcp.call-tool@decide',
    auditActor: { kind: 'user' as const, id: userId },
    mediation,
  };
  await recordProductPermissionDecision({
    ...decisionBase,
    decisionId: sourceDecisionId,
    result: 'require_approval',
    requiredApprovalKind: 'permission',
    contextSummary: { threadId: thread.id, turnId: turn.id },
  });
  const record = await raiseRecordedPendingRequest(store, db.sqlite, {
    requestId,
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: thread.id,
    raisingTurnId: turn.id,
    requestItemId,
    kind: 'approval',
    requesterKind: 'worker',
    agentId: 'agent_demo',
    responsibleUserId: userId,
    call: {
      serverId: 'echo-server',
      catalogRevision: resolveWorkspaceMcpServer({ catalog, serverId: 'echo-server' })
        .catalogDigest,
      schemaSnapshotId,
      toolName: 'echo',
      canonicalArgumentsJson: JSON.stringify({ message: 'approved' }),
      argumentsDigest: mcpToolArgumentsContentDigest({ message: 'approved' }),
      packageDigest: null,
      policyDecisionId: sourceDecisionId,
      authorizationContext: {
        threadId: thread.id,
        turnId: turn.id,
        agentSessionId: null,
        agentId: 'agent_demo',
        responsibleUserId: userId,
        packageDigest: null,
        policyDecisionId: sourceDecisionId,
      },
    },
    approval: {
      kind: 'permission',
      title: 'Approve echo',
      description: 'Execute exactly this message.',
    },
    now: turn.startedAt,
  });
  // Only the upstream effect is doubled; Pending, execution admission and ledger are real owners.
  const callTool = vi.fn<WorkerMcpGateway['callTool']>().mockResolvedValue({
    content: [{ type: 'text', text: 'approved result' }],
    isError: false,
  });
  const gateway: WorkerMcpGateway = {
    callTool,
    listTools: vi.fn().mockRejectedValue(new Error('Use retained schema only.')),
    close: vi.fn().mockResolvedValue(undefined),
    closeServer: vi.fn().mockResolvedValue(undefined),
    closeServerIfIdle: vi.fn().mockResolvedValue(undefined),
    closeWorkspace: vi.fn().mockResolvedValue(undefined),
    getServerHealth: () => 'ready',
  };
  let prepared: PreparedCapturedPendingCall | undefined;
  let executionCall: Awaited<ReturnType<typeof admitCapturedPendingCall>> | undefined;
  await respondRecordedApproval({
    store,
    sqlite: db.sqlite,
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: thread.id,
    approvalRequestId: requestId,
    decision: 'granted',
    actorId: userId,
    coreDb,
    requestActor: { kind: 'local', userId },
    dependencies: { coreDb, openWorkspace: (id) => openWorkspaceDb(root, id) },
    prepare: async () => {
      prepared = await prepareCapturedPendingCall({
        actor: { userId },
        record,
        catalog,
        coreDb,
        workerMcpGateway: gateway,
        workspaceDb: db,
        reviewPolicy: async () => {
          const decisionId = allocateEntityId('pd');
          await recordProductPermissionDecision({
            ...decisionBase,
            decisionId,
            result: 'allow',
            contextSummary: {
              humanApprovalRequestId: requestId,
              approvalSourceDecisionId: sourceDecisionId,
              humanApprovalDeciderId: userId,
              capabilityCallId: executionCallIdForRequest(requestId),
              threadId: thread.id,
              turnId: turn.id,
            },
          });
          return { decisionId, current: () => true };
        },
      });
    },
    evaluate: () =>
      evaluateCapturedPendingCall({
        manifest: setup.manifest,
        catalog,
        coreDb,
        record,
        sqlite: db.sqlite,
        prepared,
      }),
    admitExecution: async (failure) => {
      executionCall = await admitCapturedPendingCall(
        record,
        db,
        '00000000-0000-4000-8000-000000000117',
        prepared,
        failure
      );
      return executionCall.refusal;
    },
    execute: (claimed) =>
      executeCapturedPendingCall({
        catalog,
        coreDb,
        record: claimed,
        workerMcpGateway: gateway,
        workspaceDb: db,
        prepared,
        executionCall,
      }),
  });
  expect(callTool).toHaveBeenCalledTimes(1);
  const retained = readPendingRequest(db.sqlite, requestId);
  expect(retained).toMatchObject({
    state: 'resolved',
    resolution: 'granted',
    decidingActor: { kind: 'user', id: userId },
    disposition: 'approved-executed',
    executionCallId: executionCallIdForRequest(requestId),
  });
  const call = listWorkspaceCapabilityCalls(db, DEMO_WORKSPACE_ID).find(
    (candidate) => candidate.id === retained!.executionCallId
  );
  expect(call).toMatchObject({
    status: 'succeeded',
    itemId: null,
    threadId: thread.id,
    turnId: turn.id,
  });
  const app = createAppWithWorkspaceAuthority({
    store,
    coreDb,
    dataRoot: root,
    agentManifests: [setup.manifest],
  });
  const response = await app.request('/api/app/operations/thread.timeline', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: thread.id,
      view: 'items',
      turnId: turn.id,
      placement: 'all',
    }),
  });
  const body = (await response.json()) as {
    items: Array<{ id: string; policy?: unknown; approvedBy?: unknown }>;
  };
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.items.some((item) => item.id === requestItemId)).toBe(true);
  expect(body.items.length).toBeLessThanOrEqual(50);
  for (const item of body.items) {
    expect(item.policy ?? null).toBeNull();
    expect(item.approvedBy ?? null).toBeNull();
  }
});
