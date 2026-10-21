import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  type AgentEnvironmentPackage,
  resolveWorkspaceMcpServer,
  type WorkspaceMcpServerCatalog,
} from '@openkit/config-schema';
import {
  allocateEntityId,
  deriveEntityId,
  type PolicyDecisionV1,
  PolicyDocumentV1Schema,
  workspaceIdForOwner,
} from '@openkit/protocol';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { readAdmittedPolicyDocument, recordPolicyWriteDecision } from '../policy/configuration.js';
import { PolicyInterception } from '../policy/interception.js';
import {
  listExportableWorkspacePermissionDecisions,
  readPolicyStatementUseCount,
  recordProductPermissionDecision,
} from '../policy/permission-decisions.js';
import {
  EMPTY_POLICY_DOCUMENT,
  policyDigest,
  preparePolicyDocument,
} from '../policy/statements.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import * as workerMcpRoutes from '../worker-mcp-routes.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import {
  admitCapturedPendingCall,
  evaluateCapturedPendingCall,
  executeCapturedPendingCall,
  type PreparedCapturedPendingCall,
  prepareCapturedPendingCall,
} from './captured-pending-call.js';
import {
  acceptSchedulerExecutionObservation,
  schedulerExecutionCorrelation,
} from './execution-attempt-records.js';
import {
  importMcpToolSchemaSnapshots,
  listExportableMcpToolSchemaSnapshots,
  mcpToolArgumentsContentDigest,
  recordMcpToolSchemaSnapshot,
} from './mcp-tool-schema-snapshots.js';
import { raiseRecordedPendingRequest, respondRecordedApproval } from './pending-request-flow.js';
import { executionCallIdForRequest, readPendingRequest } from './pending-requests.js';
import type { WorkerControlGateway } from './worker-control-gateway.js';
import type { WorkerMcpGateway } from './worker-mcp-gateway.js';

/** Upstream Tool fixture with retained input schema and independent top-level metadata. */
type Tool = { name: string; inputSchema: Record<string, unknown>; description?: string };

/** Independent effect contract: schema annotations are part of the approved input. */
function tools(): Tool[] {
  return [
    {
      name: 'echo',
      description: 'Original tool description.',
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Exact message.',
            examples: ['approved', 'second'],
          },
        },
        required: ['message'],
        additionalProperties: false,
      },
    },
    { name: 'allowed-other', inputSchema: { type: 'object', properties: {} } },
    { name: 'excluded-other', inputSchema: { type: 'object', properties: {} } },
  ];
}

const cleanups: Array<() => void> = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

/** Composes retained snapshots, current grant evaluation, and the real synchronous claim owner. */
async function fixture(
  schemaPolicy: 'tracking' | 'pinned' = 'tracking',
  credentialRequired = false,
  mediated?: boolean,
  sourceResult: 'require_approval' | 'require_escalation' = 'require_escalation'
) {
  const reviewByDefault = mediated === undefined;
  mediated ??= true;
  let policyCurrent = true;
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-captured-schema-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
  applyScopedMigrations(db);
  cleanups.push(() => {
    db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const setup = createTestAgentSetup({ agentId: 'agent_demo', mcpIds: ['echo-server'] });
  admitTestNativeEnvironment(coreDb, setup.manifest);
  let manifest: typeof setup.manifest | null = setup.manifest;
  let catalog: WorkspaceMcpServerCatalog = {
    schemaVersion: 1,
    servers: [
      {
        id: 'echo-server',
        enabled: true,
        allowedTools: ['echo', 'allowed-other'],
        credentialBindings: credentialRequired
          ? [
              {
                sink: { kind: 'env', name: 'ECHO_AUTH' },
                slot: 'auth',
                vaultGrantId: 'grant_00000000-0000-7278-b714-46e2d53cb316',
              },
            ]
          : [],
        pinnedSchemaSnapshotId: schemaPolicy === 'pinned' ? 'schema_captured' : null,
        schemaPolicy,
        timeoutMs: 2000,
        transport: { kind: 'stdio', command: process.execPath, args: [], environment: {} },
      },
    ],
  };
  const turn = await store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    'th_00000000-0000-7000-8000-000000000001',
    'Capture an exact effect',
    { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    null,
    { agentId: 'agent_demo' }
  );
  const environmentPackage: AgentEnvironmentPackage = resolveAgentEnvironmentPackage({
    coreDb,
    captureCoverage: { scope: 'server', value: 'off' },
    agentSessionId: 'as_00000000-0000-7be5-8407-bc63f27c8ec0',
    agentSetup: setup,
    backend: { kind: 'openshell' },
    createdAt: '2026-10-15T00:00:00.000Z',
    requestId: 'request_capture',
    triggerActor: turn.triggerActor,
    turn,
    workspaceCwd: '/workspace',
    workspaceMcpServerCatalog: catalog,
    workspaceRoots: [],
  });
  const retain = (nextTools: Tool[], schemaSnapshotId = 'schema_current') =>
    recordMcpToolSchemaSnapshot({
      environmentPackage,
      schemaSnapshotId,
      serverId: 'echo-server',
      source: 'live',
      tools: nextTools,
      workspaceDb: db,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
  const capturedId = retain(tools(), 'schema_captured');
  const resolved = resolveWorkspaceMcpServer({ catalog, serverId: 'echo-server' });
  await store.createItem({
    id: 'it_00000000-0000-74e7-bec8-70d5a20db395',
    owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId: turn.id,
    type: 'approval-request',
    status: 'completed',
    approvalRequestId: 'ap_captured',
    title: 'Approve echo',
    description: 'Execute the captured message.',
    kind: 'permission',
    createdAt: turn.startedAt,
    completedAt: turn.startedAt,
  });
  const digest = `sha256:${'a'.repeat(64)}`;
  const sourceMediation: PolicyDecisionV1 = {
    operation: 'mcp.call-tool',
    stage: 'decide',
    authorizationRevision: digest,
    proposalDigest: digest,
    role: 'final',
    kernel: { effect: 'allow', reason: 'granted' },
    subject: {
      principal: { kind: 'human', id: 'usr_00000000-0000-7000-8000-000000000001' },
      onBehalfOf: null,
      actor: {
        kind: 'agent',
        id: 'agent_demo',
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
      },
      process: {
        workspaceId: workspaceIdForOwner(turn.owner),
        threadId: turn.threadId,
        turnId: turn.id,
      },
      credentialKind: 'worker-package',
      responsibleHumanId: 'usr_00000000-0000-7000-8000-000000000001',
    },
    invocations: [],
    consumedStatements: [],
  };
  const sourceDecisionId = mediated ? allocateEntityId('pd') : null;
  const decisionBase = {
    workspaceDb: db,
    workspaceId: workspaceIdForOwner(turn.owner),
    ownerScope: 'workspace' as const,
    policyEngineVersion: 'fixture:v1',
    policySnapshotId: digest,
    subjectSummary: {},
    resourceSummary: { serverId: 'echo-server', toolName: 'echo' },
    action: 'tool.use',
    reasonCode: 'granted',
    enforcementPoint: 'mcp.call-tool@decide',
    auditActor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
  };
  if (sourceDecisionId)
    recordProductPermissionDecision({
      ...decisionBase,
      decisionId: sourceDecisionId,
      result: sourceResult,
      ...(sourceResult === 'require_approval' ? { requiredApprovalKind: 'permission' } : {}),
      mediation: sourceMediation,
      contextSummary: { threadId: turn.threadId, turnId: turn.id },
    });
  const record = raiseRecordedPendingRequest(store, db.sqlite, {
    requestId: 'ap_captured',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    raisingTurnId: turn.id,
    requestItemId: 'it_00000000-0000-74e7-bec8-70d5a20db395',
    kind: 'approval',
    requesterKind: 'worker',
    agentId: 'agent_demo',
    responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
    call: {
      serverId: 'echo-server',
      catalogRevision: resolved.catalogDigest,
      schemaSnapshotId: capturedId,
      toolName: 'echo',
      canonicalArgumentsJson: JSON.stringify({ message: 'approved' }),
      argumentsDigest: mcpToolArgumentsContentDigest({ message: 'approved' }),
      packageDigest: null,
      policyDecisionId: sourceDecisionId,
      authorizationContext: {
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        agentSessionId: null,
        agentId: 'agent_demo',
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
        packageDigest: null,
        policyDecisionId: sourceDecisionId,
      },
    },
    approval: {
      kind: 'permission',
      title: 'Approve echo',
      description: 'Execute the captured message.',
    },
    now: turn.startedAt,
  });
  // Only the external upstream is doubled. No real subprocess or network is required by this seam.
  const callTool = vi.fn<WorkerMcpGateway['callTool']>().mockResolvedValue({
    content: [{ type: 'text', text: 'approved result' }],
    isError: false,
  });
  const gateway: WorkerMcpGateway = {
    callTool,
    listTools: vi.fn().mockRejectedValue(new Error('Grant must use retained evidence.')),
    close: vi.fn().mockResolvedValue(undefined),
    closeServer: vi.fn().mockResolvedValue(undefined),
    closeServerIfIdle: vi.fn().mockResolvedValue(undefined),
    closeWorkspace: vi.fn().mockResolvedValue(undefined),
    getServerHealth: () => 'ready',
  };
  const fixtureReview =
    (current: () => boolean = () => policyCurrent, changes: Partial<PolicyDecisionV1> = {}) =>
    async () => {
      const decisionId = allocateEntityId('pd');
      const mediation = { ...sourceMediation, ...changes };
      recordProductPermissionDecision({
        ...decisionBase,
        policySnapshotId: digest,
        decisionId,
        result: 'allow',
        mediation,
        contextSummary: {
          humanApprovalRequestId: record.requestId,
          approvalSourceDecisionId: sourceDecisionId,
          humanApprovalDeciderId: 'usr_00000000-0000-7000-8000-000000000001',
          capabilityCallId: executionCallIdForRequest(record.requestId),
          threadId: record.threadId,
          turnId: record.raisingTurnId,
        },
        ...(mediation.consumedStatements.length
          ? { uses: mediation.consumedStatements.map((statement) => ({ statement, limit: 1 })) }
          : {}),
      });
      return { decisionId, current };
    };

  const grant = (
    afterPreparation?: () => void | Promise<void>,
    reviewPolicy?: Parameters<typeof prepareCapturedPendingCall>[0]['reviewPolicy']
  ) => {
    let prepared: PreparedCapturedPendingCall | undefined;
    let executionCall: ReturnType<typeof admitCapturedPendingCall> | undefined;
    return respondRecordedApproval({
      store,
      sqlite: db.sqlite,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      approvalRequestId: record.requestId,
      decision: 'granted',
      actorId: 'usr_00000000-0000-7000-8000-000000000001',
      coreDb,
      requestActor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
      dependencies: { coreDb, openWorkspace: (id) => openWorkspaceDb(dataRoot, id) },
      prepare: async () => {
        prepared = await prepareCapturedPendingCall({
          actor: { userId: 'usr_00000000-0000-7000-8000-000000000001' },
          ...(reviewPolicy
            ? { reviewPolicy }
            : reviewByDefault
              ? { reviewPolicy: fixtureReview() }
              : {}),
          record,
          catalog,
          coreDb,
          vaultBackend: undefined,
          workerMcpGateway: gateway,
          workspaceDb: db,
        });
        await afterPreparation?.();
      },
      evaluate: () =>
        evaluateCapturedPendingCall({
          manifest,
          catalog,
          coreDb,
          record,
          sqlite: db.sqlite,
          prepared,
        }),
      admitExecution: () => {
        executionCall = admitCapturedPendingCall(
          record,
          db,
          '00000000-0000-4000-8000-000000000117',
          prepared
        );
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
  };
  return {
    store,
    environmentPackage,
    gateway,
    setup,
    db,
    coreDb,
    record,
    retain,
    grant,
    callTool,
    sourceDecisionId,
    sourceMediation,
    reviewPolicy: fixtureReview,
    invalidatePolicy: () => {
      policyCurrent = false;
    },
    setCatalog: (next: WorkspaceMcpServerCatalog) => {
      catalog = next;
    },
    catalog: () => catalog,
    removeAgent: () => {
      manifest = null;
    },
    removeSelection: () => {
      manifest = { ...setup.manifest, mcp: [] };
    },
  };
}

/** Refusal must not create an execution admission, claim, usage row, or upstream contact. */
function expectNoExecution(f: ReturnType<typeof fixture>) {
  expect(f.callTool).not.toHaveBeenCalled();
  expect(readPendingRequest(f.db.sqlite, f.record.requestId)).toMatchObject({
    claim: 'unclaimed',
    executionCallId: null,
  });
  expect(f.db.sqlite.prepare('SELECT count(*) AS count FROM capability_calls').get()).toEqual({
    count: 0,
  });
  expect(f.db.sqlite.prepare('SELECT count(*) AS count FROM usage_records').get()).toEqual({
    count: 0,
  });
}

describe('captured pending MCP schema identity at grant', () => {
  it('blocks a captured human grant when current Policy prohibits an otherwise supplied Tool', async () => {
    const f = await fixture('tracking', false, true);
    const scope = f.environmentPackage.scope;
    const userId = f.record.responsibleUserId;
    const principal = { kind: 'human' as const, id: userId };
    const resource = {
      kind: 'mcp-tool' as const,
      workspaceId: scope.workspaceId,
      serverId: 'echo-server',
      toolName: 'echo',
    };
    const policyScope = { subjects: [principal], actions: ['tool.use'], resources: [resource] };
    const lifetime = {
      anchor: {
        owner: { kind: 'workspace' as const, workspaceId: scope.workspaceId },
        kind: 'workspace',
        id: scope.workspaceId,
      },
    };
    let document = EMPTY_POLICY_DOCUMENT;
    const admit = (prohibited = false) => {
      const prepared = preparePolicyDocument({
        current: document,
        userId,
        now: new Date().toISOString(),
        proposed: PolicyDocumentV1Schema.parse({
          schemaVersion: 1,
          statements: [
            {
              id: 'capture-gate',
              kind: 'binding',
              author: principal,
              authority: { kind: 'human', userId },
              authoredAt: new Date().toISOString(),
              scope: policyScope,
              lifetime,
              state: 'active',
              operation: 'mcp.call-tool',
              stage: 'decide',
              mode: 'gate',
              participant: {
                kind: 'deterministic',
                id: 'captured-current-policy',
                version: `sha256:${'c'.repeat(64)}`,
              },
              inputDisclosure: policyScope,
              order: 0,
              timeoutMs: 10000,
              circuit: { failures: 1, recoveryAfterMs: 1 },
            },
            ...(prohibited
              ? [
                  {
                    id: 'human-prohibition',
                    kind: 'permission',
                    effect: 'prohibit',
                    grant: { kind: 'ordinary' },
                    author: principal,
                    authority: { kind: 'human', userId },
                    authoredAt: new Date().toISOString(),
                    scope: policyScope,
                    lifetime,
                    state: 'active',
                  },
                ]
              : []),
          ],
        }),
      });
      recordPolicyWriteDecision({
        coreDb: f.coreDb,
        actor: { kind: 'local', userId },
        candidate: {
          artifactId: allocateEntityId('ar'),
          contentDigest: policyDigest(prepared.document),
        },
        proposal: {
          schemaVersion: 1,
          proposer: principal,
          rationale: 'Govern the captured exact Tool.',
          baseRevision: policyDigest(document),
          proposed: prepared.document,
          diff: prepared.diff,
          classification: prepared.classification,
          validation: 'valid',
        },
        requestId: 'captured-policy-write',
        threadId: scope.threadId,
        turnId: scope.turnId,
      });
      document = prepared.document;
      expect(readAdmittedPolicyDocument(f.coreDb, document)).toEqual(document);
    };
    admit();
    await f.store.createAgentSession({
      id: scope.agentSessionId,
      agentId: f.environmentPackage.agent.agentId,
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
      status: 'busy',
      message: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await f.store.updateTurn(scope.turnId, {
      agentSessionId: scope.agentSessionId,
      agentId: f.environmentPackage.agent.agentId,
      status: 'running',
    });
    const entry = createSchedulerAdmissionEntry(f.coreDb, {
      backendId: 'nanohost',
      queueEntryId: 'capture-policy-queue',
      requestId: scope.requestId,
      triggerActor: scope.triggerActor,
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
      turnId: scope.turnId,
      turnInput: 'Capture echo',
      requestedAgentId: f.environmentPackage.agent.agentId,
    });
    const attempt = recordTestExecutionAttempt(f.coreDb, {
      entry,
      attemptId: testEntityId('attempt', 'captured-current-policy'),
      agentSessionId: scope.agentSessionId,
      inputRef: f.environmentPackage.snapshotId,
      bindingRef: 'captured-policy-binding',
      sessionCompatibilityKey: 'captured-policy',
      now: () => new Date().toISOString(),
      operationId: 'captured-policy-submit',
    });
    expect(
      acceptSchedulerExecutionObservation(f.coreDb, {
        ...schedulerExecutionCorrelation(attempt),
        disposition: 'accepted',
        execution: 'running',
        fenceRef: null,
        outcomeRef: null,
      })
    ).not.toBeNull();
    recordAgentEnvironmentPackageSnapshot(f.db, {
      environmentPackage: f.environmentPackage,
      createdAt: new Date().toISOString(),
    });
    vi.mocked(f.gateway.listTools).mockResolvedValue({
      serverVersion: 'captured-policy',
      tools: tools(),
    });
    let gate: 'escalate' | 'allow' = 'escalate';
    const interception = new PolicyInterception({
      id: 'captured-current-policy',
      version: `sha256:${'c'.repeat(64)}`,
      invoke: async () => ({ decision: gate }),
    });
    const baseConfig = createInMemoryRuntimeConfigSnapshot({
      dataRoot: f.store.getDataRoot()!,
      agentManifests: [f.setup.manifest],
    });
    const app = new Hono();
    const routes = {
      app,
      coreDb: f.coreDb,
      store: f.store,
      interception,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      workerMcpGateway: f.gateway,
      workerControlGateway: {
        authenticatePackageToken: () => f.environmentPackage,
      } as unknown as WorkerControlGateway,
      runtimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          dataRoot: f.store.getDataRoot()!,
          agentManifests: [f.setup.manifest],
          openKitConfig: {
            ...baseConfig.openKitConfig,
            policy: { ...baseConfig.openKitConfig.policy, mediation: document },
          },
          workspaceMcpServerCatalogs: [
            { workspaceId: scope.workspaceId, path: 'fixture-catalog', catalog: f.catalog() },
          ],
        }),
    };
    workerMcpRoutes.registerWorkerMcpRoutes(routes);
    const client = new Client({ name: 'captured-current-policy', version: '1.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL('http://nanocore.test/api/worker-capabilities/mcp/echo-server'),
          {
            fetch: (request, init) => app.fetch(new Request(request, init)),
            requestInit: { headers: { authorization: 'Bearer captured-package' } },
          }
        )
      );
      await client.listTools();
      const pending = await client.callTool({
        name: 'echo',
        arguments: { message: 'current-policy-captured' },
      });
      expect(pending).toMatchObject({
        isError: true,
        structuredContent: { status: 'pending-approval' },
      });
      const record = readPendingRequest(f.db.sqlite, String(pending.structuredContent!.requestId))!;
      expect(record).toMatchObject({
        claim: 'unclaimed',
        policyDecisionId: expect.any(String),
        canonicalArgumentsJson: JSON.stringify({ message: 'current-policy-captured' }),
      });
      const review = () =>
        workerMcpRoutes.reviewCapturedMcpPolicy({
          record,
          actor: { userId },
          workspaceDb: f.db,
          routes,
          catalog: f.catalog(),
          interception,
        });
      gate = 'allow';
      // A current real review succeeds before the human adds the prohibition.
      expect(await review()).not.toBeNull();
      const catalogRevision = resolveWorkspaceMcpServer({
        catalog: f.catalog(),
        serverId: 'echo-server',
      }).catalogDigest;
      expect(
        resolveWorkspaceMcpServer({ catalog: f.catalog(), serverId: 'echo-server' }).catalogDigest
      ).toBe(catalogRevision);
      expect(
        evaluateCapturedPendingCall({
          manifest: f.setup.manifest,
          catalog: f.catalog(),
          coreDb: f.coreDb,
          record,
          sqlite: f.db.sqlite,
        })
      ).toMatchObject({ toolInSupply: true, schemaCurrent: true });
      const credentials = vi.spyOn(workerMcpRoutes, 'resolveWorkerMcpCredentials');
      let prepared: PreparedCapturedPendingCall | undefined;
      let executionCall: ReturnType<typeof admitCapturedPendingCall> | undefined;
      const result = await respondRecordedApproval({
        store: f.store,
        sqlite: f.db.sqlite,
        workspaceId: scope.workspaceId,
        threadId: scope.threadId,
        approvalRequestId: record.requestId,
        decision: 'granted',
        actorId: userId,
        coreDb: f.coreDb,
        requestActor: { kind: 'local', userId },
        dependencies: { coreDb: f.coreDb, openWorkspace: () => f.db },
        prepare: async () => {
          prepared = await prepareCapturedPendingCall({
            actor: { userId },
            record,
            catalog: f.catalog(),
            coreDb: f.coreDb,
            vaultBackend: undefined,
            workerMcpGateway: f.gateway,
            workspaceDb: f.db,
            reviewPolicy: review,
          });
          expect(prepared.failed).toBe(false);
          // Change current Policy after a real review and credential preparation.
          // The unchanged supply and captured source cannot authorize the later claim.
          admit(true);
          expect(
            resolveWorkspaceMcpServer({ catalog: f.catalog(), serverId: 'echo-server' })
              .catalogDigest
          ).toBe(catalogRevision);
        },
        evaluate: () =>
          evaluateCapturedPendingCall({
            manifest: f.setup.manifest,
            catalog: f.catalog(),
            coreDb: f.coreDb,
            record,
            sqlite: f.db.sqlite,
            prepared,
          }),
        admitExecution: () => {
          executionCall = admitCapturedPendingCall(
            record,
            f.db,
            '00000000-0000-4000-8000-000000000118',
            prepared
          );
        },
        execute: (claimed) =>
          executeCapturedPendingCall({
            catalog: f.catalog(),
            coreDb: f.coreDb,
            record: claimed,
            workerMcpGateway: f.gateway,
            workspaceDb: f.db,
            prepared,
            executionCall,
          }),
      });
      expect(result).toMatchObject({
        disposition: 'denied-not-executed',
        dispositionReason: 'policy-changed',
      });
      expect(credentials).toHaveBeenCalledTimes(1);
      expect(f.callTool).not.toHaveBeenCalled();
      expect(readPendingRequest(f.db.sqlite, record.requestId)).toMatchObject({
        claim: 'unclaimed',
        executionCallId: null,
      });
      expect(
        f.db.sqlite
          .prepare('SELECT call_id FROM capability_calls WHERE call_id = ?')
          .get(executionCallIdForRequest(record.requestId))
      ).toBeUndefined();
      expect(f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM usage_records').get()).toEqual({
        count: 0,
      });
    } finally {
      await client.close();
    }
  });

  it('blocks a mediated source without a reviewer before credential resolution', async () => {
    const f = await fixture('tracking', true, true);
    const credentials = vi.spyOn(workerMcpRoutes, 'resolveWorkerMcpCredentials');
    expect(await f.grant()).toMatchObject({
      disposition: 'denied-not-executed',
      dispositionReason: 'policy-changed',
    });
    expect(credentials).not.toHaveBeenCalled();
    expectNoExecution(f);
  });

  it('requires exact mediated review for a catalog approval and keeps its once-only claim', async () => {
    const refused = await fixture('tracking', true, true, 'require_approval');
    const credentials = vi.spyOn(workerMcpRoutes, 'resolveWorkerMcpCredentials');
    expect(await refused.grant()).toMatchObject({
      disposition: 'denied-not-executed',
      dispositionReason: 'policy-changed',
    });
    expect(credentials).not.toHaveBeenCalled();
    expectNoExecution(refused);

    const admitted = await fixture('tracking', false, true, 'require_approval');
    const source = listExportableWorkspacePermissionDecisions(
      admitted.db,
      admitted.record.workspaceId
    );
    expect(source).toEqual([
      expect.objectContaining({
        decisionId: admitted.record.policyDecisionId,
        result: 'require_approval',
        requiredApprovalKind: 'permission',
        mediation: admitted.sourceMediation,
      }),
    ]);
    const statement = { id: 'catalog-once', digest: `sha256:${'d'.repeat(64)}` };
    expect(
      await admitted.grant(
        undefined,
        admitted.reviewPolicy(() => true, { consumedStatements: [statement] })
      )
    ).toMatchObject({ disposition: 'approved-executed', claim: 'finished' });
    expect(admitted.callTool).toHaveBeenCalledTimes(1);
    const decisions = listExportableWorkspacePermissionDecisions(
      admitted.db,
      admitted.record.workspaceId
    );
    expect(decisions).toHaveLength(3);
    const derivedId = deriveEntityId('pd', ['pending_execution', admitted.record.requestId]);
    const preparation = decisions.find(
      ({ decisionId }) => decisionId !== admitted.sourceDecisionId && decisionId !== derivedId
    );
    expect(decisions.find(({ decisionId }) => decisionId === derivedId)).toMatchObject({
      approvalId: admitted.record.requestId,
      contextSummary: { originEvaluationDecisionId: preparation?.decisionId },
      mediation: { ...admitted.sourceMediation, consumedStatements: [] },
    });
    expect(readPolicyStatementUseCount(admitted.db, statement)).toBe(1);
  });

  it('rejects changed mediation pins before credentials or execution', async () => {
    const f = await fixture('tracking', false, true);
    const credentials = vi.spyOn(workerMcpRoutes, 'resolveWorkerMcpCredentials');
    expect(
      await f.grant(
        undefined,
        f.reviewPolicy(() => true, { proposalDigest: `sha256:${'b'.repeat(64)}` })
      )
    ).toMatchObject({ disposition: 'denied-not-executed', dispositionReason: 'policy-changed' });
    expect(credentials).not.toHaveBeenCalled();
    expectNoExecution(f);
  });

  it('checks the source marker before decoded mediation and reviewer contact', async () => {
    const f = await fixture('tracking', false, true);
    const review = vi.fn(f.reviewPolicy());
    f.db.sqlite
      .prepare(
        "UPDATE permission_decisions SET schema_version = 2, mediation_json = 'not JSON' WHERE decision_id = ?"
      )
      .run(f.sourceDecisionId);
    await expect(f.grant(undefined, review)).rejects.toThrow('Unsupported retained record format.');
    expect(review).not.toHaveBeenCalled();
    expectNoExecution(f);
  });

  it('rechecks current mediation inside the claim before starting a CapabilityCall', async () => {
    const f = await fixture('tracking', false, true);
    const current = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    await expect(f.grant(undefined, f.reviewPolicy(current))).rejects.toMatchObject({
      code: 'policy-changed',
    });
    expect(current).toHaveBeenCalledTimes(3);
    expectNoExecution(f);
  });

  it('preserves a settled Tool success when completed Policy observation fails', async () => {
    const f = await fixture('tracking', false, true);
    const review = f.reviewPolicy();
    let observedCall: unknown;
    const observe = vi.fn(async () => {
      observedCall = f.db.sqlite
        .prepare('SELECT status, completed_at FROM capability_calls WHERE call_id = ?')
        .get(executionCallIdForRequest(f.record.requestId));
      throw new Error('Required observation evidence is unavailable.');
    });
    const result = await f.grant(undefined, async () => ({ ...(await review()), observe }));
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observedCall).toEqual({ status: 'succeeded', completed_at: expect.any(String) });
    expect(result).toMatchObject({
      disposition: 'approved-executed',
      dispositionReason: 'policy-observation-unavailable',
      claim: 'finished',
      heldResult: { content: [{ type: 'text', text: 'approved result' }], isError: false },
    });
    expect(f.callTool).toHaveBeenCalledTimes(1);
    expect(f.db.sqlite.prepare('SELECT status FROM capability_calls').all()).toEqual([
      { status: 'succeeded' },
    ]);
  });

  it('keeps the derived execution decision and consumes finite uses only on preparation', async () => {
    const f = await fixture('tracking', false, true);
    const statement = { id: 'once-review', digest: `sha256:${'c'.repeat(64)}` };
    expect(
      await f.grant(
        undefined,
        f.reviewPolicy(() => true, { consumedStatements: [statement] })
      )
    ).toMatchObject({ disposition: 'approved-executed', claim: 'finished' });
    expect(f.callTool).toHaveBeenCalledTimes(1);
    const decisions = listExportableWorkspacePermissionDecisions(f.db, f.record.workspaceId);
    expect(decisions).toHaveLength(3);
    const execution = decisions.find(
      ({ decisionId }) =>
        decisionId === deriveEntityId('pd', ['pending_execution', f.record.requestId])
    );
    const preparation = decisions.find(
      ({ decisionId }) => decisionId !== f.sourceDecisionId && decisionId !== execution?.decisionId
    );
    expect(execution).toMatchObject({
      approvalId: f.record.requestId,
      mediation: { ...f.sourceMediation, consumedStatements: [] },
      contextSummary: {
        originEvaluationDecisionId: preparation?.decisionId,
        capabilityCallId: executionCallIdForRequest(f.record.requestId),
      },
    });
    expect(readPolicyStatementUseCount(f.db, statement)).toBe(1);
  });

  it.each([
    'unchanged',
    'allowed-other',
    'excluded-other',
    'top-level-description',
    'key-order',
  ])('tracking executes the captured call once after %s changes', async (change) => {
    const f = await fixture();
    const current = tools();
    if (change === 'allowed-other' || change === 'excluded-other') {
      current.find((tool) => tool.name === change)!.inputSchema = {
        type: 'object',
        properties: { unrelated: { type: 'number' } },
      };
    }
    if (change === 'top-level-description') current[0]!.description = 'Changed top-level metadata.';
    if (change === 'key-order')
      current[0]!.inputSchema = {
        additionalProperties: false,
        required: ['message'],
        properties: {
          message: {
            examples: ['approved', 'second'],
            description: 'Exact message.',
            type: 'string',
          },
        },
        type: 'object',
      };
    f.retain(current);
    expect(await f.grant()).toMatchObject({
      resolution: 'granted',
      claim: 'finished',
      disposition: 'approved-executed',
    });
    expect(f.callTool).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        toolName: 'echo',
        arguments: { message: 'approved' },
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    );
    await expect(f.grant()).rejects.toMatchObject({ code: 'request_not_pending' });
    expect(f.callTool).toHaveBeenCalledTimes(1);
    expect(
      f.db.sqlite.prepare('SELECT status,operation,capability_id FROM capability_calls').all()
    ).toEqual([
      { status: 'succeeded', operation: 'mcp.call-tool', capability_id: 'mcp.call-tool' },
    ]);
    expect(f.db.sqlite.prepare('SELECT quantity FROM usage_records').all()).toEqual([
      { quantity: 1 },
    ]);
  });

  it.each([
    'type',
    'nested-description',
    'nested-annotation',
    'array-order',
    'renamed',
    'removed',
  ])('tracking refuses a requested-tool %s change before claim', async (change) => {
    const f = await fixture();
    const current = tools();
    const property = (current[0]!.inputSchema.properties as Record<string, Record<string, unknown>>)
      .message!;
    if (change === 'type') property.type = 'number';
    if (change === 'nested-description') property.description = 'A changed effect description.';
    if (change === 'nested-annotation') property.examples = ['different'];
    if (change === 'array-order') property.examples = ['second', 'approved'];
    if (change === 'renamed') current[0]!.name = 'renamed-echo';
    if (change === 'removed') current.shift();
    f.retain(current);
    expect(await f.grant()).toMatchObject({ disposition: 'denied-not-executed' });
    expectNoExecution(f);
  });

  it('refuses missing captured evidence even when the current requested schema is unchanged', async () => {
    const f = await fixture();
    f.db.sqlite
      .prepare('DELETE FROM mcp_tool_schema_snapshots WHERE snapshot_id = ?')
      .run(f.record.schemaSnapshotId);
    f.retain(tools());
    expect(await f.grant()).toMatchObject({ disposition: 'denied-not-executed' });
    expectNoExecution(f);
  });

  it('uses imported retained captured evidence without making it current live authority', async () => {
    const f = await fixture();
    const captured = listExportableMcpToolSchemaSnapshots(
      f.db,
      'ws_00000000-0000-7000-8000-000000000001'
    );
    f.db.sqlite.prepare('DELETE FROM mcp_tool_schema_snapshots').run();
    importMcpToolSchemaSnapshots(f.db, captured);
    const current = tools();
    current[1]!.inputSchema = { type: 'object', description: 'Unrelated drift.' };
    f.retain(current);
    expect(await f.grant()).toMatchObject({ disposition: 'approved-executed', claim: 'finished' });
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });

  it('refuses imported-only history when no current live schema exists', async () => {
    const f = await fixture();
    const captured = listExportableMcpToolSchemaSnapshots(
      f.db,
      'ws_00000000-0000-7000-8000-000000000001'
    );
    f.db.sqlite.prepare('DELETE FROM mcp_tool_schema_snapshots').run();
    importMcpToolSchemaSnapshots(f.db, captured);
    expect(await f.grant()).toMatchObject({ disposition: 'denied-not-executed' });
    expectNoExecution(f);
  });

  it('pinned executes an unchanged captured call exactly once', async () => {
    const f = await fixture('pinned');
    expect(await f.grant()).toMatchObject({
      resolution: 'granted',
      claim: 'finished',
      disposition: 'approved-executed',
    });
    expect(f.callTool).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        toolName: 'echo',
        arguments: { message: 'approved' },
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    );
    await expect(f.grant()).rejects.toMatchObject({ code: 'request_not_pending' });
    expect(f.callTool).toHaveBeenCalledTimes(1);
    expect(f.db.sqlite.prepare('SELECT status FROM capability_calls').all()).toEqual([
      { status: 'succeeded' },
    ]);
    expect(f.db.sqlite.prepare('SELECT quantity FROM usage_records').all()).toEqual([
      { quantity: 1 },
    ]);
  });

  it.each([
    'allowed-other',
    'excluded-other',
  ])('pinned refuses whole-snapshot drift in %s before claim', async (name) => {
    const f = await fixture('pinned');
    const current = tools();
    current.find((tool) => tool.name === name)!.inputSchema.description = 'Unrelated drift.';
    f.retain(current);
    expect(await f.grant()).toMatchObject({ disposition: 'denied-not-executed' });
    expectNoExecution(f);
  });

  it.each([
    'catalog',
    'selection',
    'eligibility',
    'policy',
    'credentials',
    'agent',
    'user-authority',
  ])('an unchanged requested schema does not bypass current %s checks', async (guard) => {
    const f = await fixture('tracking', guard === 'credentials');
    const result = await f.grant(() => {
      if (guard === 'selection') f.removeSelection();
      if (guard === 'agent') f.removeAgent();
      if (guard === 'user-authority')
        f.coreDb.sqlite
          .prepare(
            "UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = 'usr_00000000-0000-7000-8000-000000000001'"
          )
          .run(new Date().toISOString());
      if (guard === 'policy') f.invalidatePolicy();
      if (guard === 'catalog' || guard === 'eligibility') {
        const catalog = f.catalog();
        f.setCatalog({
          ...catalog,
          servers: catalog.servers.map((server) => ({
            ...server,
            ...(guard === 'catalog' ? { timeoutMs: server.timeoutMs + 1 } : {}),
            ...(guard === 'eligibility' ? { allowedTools: ['allowed-other'] } : {}),
          })),
        });
      }
    });
    if (guard === 'agent' || guard === 'user-authority')
      expect(result).toMatchObject({ state: 'ended', ending: 'invalidated' });
    else expect(result).toMatchObject({ disposition: 'denied-not-executed' });
    expectNoExecution(f);
  });
});
