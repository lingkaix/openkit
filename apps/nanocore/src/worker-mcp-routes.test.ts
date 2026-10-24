import Database from 'better-sqlite3';
import { disableCanonicalUser } from './auth/user-lifecycle.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { admitTestMcpApproval } from './test-support/mcp-tool-policy.js';
// openkit-test-platform: posix

import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  ListHumanAttentionResponseSchema,
  operationToolName,
  StartTaskModeResponseSchema,
  SubmitConversationResponseSchema,
  WorkspaceExportResponseSchema,
} from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  parseWorkspaceMcpServerCatalog,
  resolveWorkspaceMcpServer,
  WORKSPACE_RESOURCE_POLICY_FEATURE,
  WorkspaceConfigSchema,
} from '@openkit/config-schema';
import { deriveEntityId, PolicyDocumentV1Schema, workspaceIdForOwner } from '@openkit/protocol';
import { buildWorkerCanonicalTerminalEventRecord } from '@openkit/worker-protocol';
import { Hono } from 'hono';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoreClient } from '../../../packages/core-client/src/index.js';
import { createDefaultWorkerControlGateway } from './app.js';
import { listWorkspaceAuditEvents } from './audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { createBetterAuth } from './auth/better-auth.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from './auth/nanohost-transport-session.js';
import { isCanonicalUserActive } from './auth/user-lifecycle.js';
import * as capabilityLedger from './capability/usage-ledger.js';
import {
  finishCapabilityCall,
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
  startCapabilityCall,
} from './capability/usage-ledger.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
  loadRuntimeConfig,
} from './config/runtime-config.js';
import { RuntimeConfigFileService } from './config/runtime-config-files.js';
import { retainWorkObservationBody } from './evidence-bundles.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { FsStore } from './lib/store.js';
import { readAdmittedPolicyDocument, recordPolicyWriteDecision } from './policy/configuration.js';
import { PolicyInterception } from './policy/interception.js';
import { listExportableWorkspacePermissionDecisions } from './policy/permission-decisions.js';
import { EMPTY_POLICY_DOCUMENT, policyDigest, preparePolicyDocument } from './policy/statements.js';
import { ProviderRegistry } from './providers/registry.js';
import * as snapshotLedger from './runtime/aep-snapshot-ledger.js';
import { recordAgentEnvironmentPackageSnapshot } from './runtime/aep-snapshot-ledger.js';
import {
  admitCapturedPendingCall,
  evaluateCapturedPendingCall,
  executeCapturedPendingCall,
  type PreparedCapturedPendingCall,
  prepareCapturedPendingCall,
} from './runtime/captured-pending-call.js';
import {
  acceptSchedulerExecutionObservation,
  closeSchedulerExecutionAttemptWithFence,
  listSchedulerExecutionAttemptsForTurn,
  markSchedulerExecutionAttemptClosing,
  schedulerExecutionCorrelation,
} from './runtime/execution-attempt-records.js';
import {
  importMcpToolSchemaSnapshots,
  listExportableMcpToolSchemaSnapshots,
  mcpToolSchemaContentDigest,
  readCurrentMcpToolSchemaSnapshot,
  readRetainedMcpToolSchemaSnapshot,
  recordMcpToolSchemaSnapshot,
} from './runtime/mcp-tool-schema-snapshots.js';
import {
  createNanoHostHarnessRuntime,
  dispatchNanoHostHarnessOperation,
  openNanoHostAgentSessionBinding,
  readNanoHostThreadAgentSessionBinding,
  settleNanoHostHarnessOperation,
} from './runtime/nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from './runtime/nanohost-runtime-target.js';
import {
  createNanoHostSessionDispatch,
  type NanoHostSessionDispatch,
  type NanoHostSessionEffectRequest,
} from './runtime/nanohost-session-dispatch.js';
import { projectApprovalEffect } from './runtime/pending-request-disclosure.js';
import {
  installPendingRequestAdmission,
  raiseRecordedPendingRequest,
  respondRecordedApproval,
} from './runtime/pending-request-flow.js';
import {
  executionCallIdForRequest,
  listThreadPendingRequests,
  pendingRequestItemId,
  readPendingRequest,
} from './runtime/pending-requests.js';
import * as productTurnStart from './runtime/product-turn-start.js';
import { createConfiguredWorkerLifecycleRuntime } from './runtime/turn-executor-factory.js';
import type { WorkerControlGateway } from './runtime/worker-control-gateway.js';
import type { WorkerMcpGateway } from './runtime/worker-mcp-gateway.js';
import {
  createDefaultWorkerMcpGateway,
  MCP_RESULT_TOO_LARGE_MESSAGE,
  WorkerMcpGatewayCallError,
} from './runtime/worker-mcp-gateway.js';
import {
  createSchedulerAdmissionEntry,
  findSchedulerAdmissionForTurn,
  listSchedulerAdmissionEntriesForWorkspace,
} from './scheduler-records.js';
import { lightAppDbPath } from './storage/app-db.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import {
  openCoreDb,
  openWorkspaceDb,
  verifyAndMigrateExistingScopedDatabases,
} from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createTestAgentSetup, createTestGatewayConfig } from './test-support/agent-environment.js';
import { createAppWithLocalIdentity as createApp } from './test-support/app.js';
import { createDemoStore, createRetainedDemoStore } from './test-support/demo-store.js';
import { testEntityId } from './test-support/entity-ids.js';
import { recordTestExecutionAttempt } from './test-support/execution-attempt.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { createMcpHttpStub } from './test-support/mcp-http-stub.js';
import {
  admitTestNativeEnvironment,
  recordTestNativeRuntimeTarget,
} from './test-support/native-environment.js';
import {
  createNativeTaskAdmissionFixture,
  observeNativeTaskStartup,
} from './test-support/native-task-admission.js';
import { operationRequest } from './test-support/operation-request.js';
import { resolveAgentEnvironmentPackage } from './test-support/prepared-agent-environment.js';
import {
  createVaultGrant,
  importWorkspaceVaultGrants,
  narrowVaultGrant,
  revokeVaultGrant,
} from './vault/vault-grants.js';
import { createVaultReference } from './vault/vault-references.js';
import { createVaultUnlockState } from './vault/vault-unlock-state.js';
import {
  reconcileWorkerMcpItems,
  registerWorkerMcpRoutes,
  reviewCapturedMcpPolicy,
} from './worker-mcp-routes.js';
import {
  recordWorkspaceOwnerMembership,
  resolveWorkspaceMembershipRelation,
} from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

/** Records the admission and lease that own a manually resolved MCP worker package. */
function recordMcpWorkerLineage(
  coreDb: ReturnType<typeof openCoreDb>,
  environmentPackage: AgentEnvironmentPackage,
  serverAdminTokenId: string | null = null
): void {
  const scope = environmentPackage.scope;
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: `queue_${scope.turnId}`,
    requestId: scope.requestId,
    triggerActor: scope.triggerActor,
    serverAdminTokenId,
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
    turnId: scope.turnId,
    turnInput: 'Call MCP tool',
    requestedAgentId: environmentPackage.agent.agentId,
  });
  const submittedAttempt = recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: testEntityId('attempt', `lease_${scope.turnId}`),
    agentSessionId: scope.agentSessionId,
    inputRef: environmentPackage.snapshotId,
    bindingRef: `binding_${scope.turnId}`,
    sessionCompatibilityKey: 'fixture-compatibility',
    now: () => new Date().toISOString(),
    operationId: `fixture-submit:${`lease_${scope.turnId}`}`,
  });
  expect(
    acceptSchedulerExecutionObservation(coreDb, {
      ...schedulerExecutionCorrelation(submittedAttempt),
      disposition: 'accepted',
      execution: 'running',
      fenceRef: null,
      outcomeRef: null,
    })?.disposition
  ).toBe('accepted');
}

describe('worker MCP routes', () => {
  it('mediates seeded I16 calls through admitted Policy before credentials and upstream effects', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-i16-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const userId = 'usr_00000000-0000-7000-8000-000000000001';
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: userId, workspaceId });
    const turn = await store.createTurn(
      workspaceId,
      'th_00000000-0000-7000-8000-000000000001',
      'Call mediated echo',
      { kind: 'user', id: userId }
    );
    const agentSessionId = testEntityId('as', 'i16_route');
    await store.createAgentSession({
      id: agentSessionId,
      agentId: 'agent_codex_host',
      workspaceId,
      threadId: turn.threadId,
      status: 'busy',
      message: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await store.updateTurn(turn.id, {
      agentSessionId,
      agentId: 'agent_codex_host',
      status: 'running',
    });
    const token = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    }).record;
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server/vault'),
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 7) });
    const referenceId = testEntityId('vault', 'i16_route');
    vaultUnlockState.backend().store({
      material: 'synthetic-i16-fixture-credential',
      metadata: { ownerScope: 'workspace', workspaceId },
      referenceId,
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: `encrypted-file://workspace/${referenceId}`,
      displayName: 'I16 fixture',
      ownerScope: 'workspace',
      referenceId,
      secretKind: 'http-bearer',
      workspaceId,
    });
    const grant = createVaultGrant(coreDb, {
      allowedInjectionPaths: ['gateway-only'],
      grantId: testEntityId('grant', 'i16_route'),
      lifetime: 'workspace',
      ownerScope: 'workspace',
      targetCapabilityId: null,
      vaultReferenceId: referenceId,
      workspaceId,
    });
    const catalog = parseWorkspaceMcpServerCatalog({
      schemaVersion: 1 as const,
      servers: [
        {
          id: 'echo',
          enabled: true,
          allowedTools: ['echo'],
          credentialBindings: [
            {
              presentation: 'bearer' as const,
              sink: { kind: 'header' as const, name: 'authorization' },
              slot: 'auth',
              vaultGrantId: grant.grantId,
            },
          ],
          schemaPolicy: 'tracking' as const,
          pinnedSchemaSnapshotId: null,
          timeoutMs: 2000,
          transport: { kind: 'http' as const, endpoint: 'https://i16.invalid/mcp' },
        },
      ],
    });
    catalog.servers.push({
      ...catalog.servers[0]!,
      id: 'echo-approval',
    });
    const environmentPackage = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId,
      agentSetup: createTestAgentSetup({ mcpIds: ['echo', 'echo-approval'] }),
      backend: { kind: 'openshell' },
      createdAt: new Date().toISOString(),
      requestId: 'req_i16_route',
      triggerActor: turn.triggerActor,
      turn,
      workspaceCwd: '/workspace',
      workspaceMcpServerCatalog: catalog,
      workspaceRoots: [],
    });
    recordMcpWorkerLineage(coreDb, environmentPackage, token.tokenId);
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(workspaceDb);
    const tools = [
      {
        name: 'echo',
        inputSchema: {
          type: 'object' as const,
          properties: { message: { type: 'string' } },
          required: ['message'],
          additionalProperties: false,
        },
      },
    ];
    const gateway: WorkerMcpGateway = {
      listTools: vi.fn(async () => ({ serverVersion: 'i16-fixture', tools })),
      callTool: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'completed' }] })),
      close: vi.fn(async () => {}),
      closeServer: vi.fn(async () => {}),
      closeServerIfIdle: vi.fn(async () => {}),
      closeWorkspace: vi.fn(async () => {}),
      getServerHealth: () => 'ready',
    };
    const participantVersion = `sha256:${'1'.repeat(64)}`;
    let gate: 'allow' | 'deny' = 'allow';
    let hold: Promise<void> | undefined;
    let entered = () => {};
    const invoke = vi.fn(
      async ({
        proposal,
      }: Parameters<
        NonNullable<ConstructorParameters<typeof PolicyInterception>[0]>['invoke']
      >[0]) => {
        expect(proposal).not.toHaveProperty('arguments');
        entered();
        if (hold) await hold;
        return { decision: gate };
      }
    );
    const interception = new PolicyInterception({
      id: 'i16-fixture',
      version: participantVersion,
      invoke,
    });
    const principal = { kind: 'human' as const, id: userId };
    const scope = {
      subjects: [principal],
      actions: ['tool.use'],
      resources: ['echo', 'echo-approval'].map((serverId) => ({
        kind: 'mcp-tool' as const,
        workspaceId,
        serverId,
        toolName: 'echo',
      })),
    };
    let document = EMPTY_POLICY_DOCUMENT;
    let conditions: typeof document.statements = [];
    const admit = (version = participantVersion, failure?: 'error') => {
      const prepared = preparePolicyDocument({
        current: document,
        userId,
        now: new Date().toISOString(),
        proposed: PolicyDocumentV1Schema.parse({
          schemaVersion: 1,
          statements: [
            ...conditions,
            {
              id: 'i16-gate',
              kind: 'binding',
              author: principal,
              authority: { kind: 'human', userId },
              authoredAt: new Date().toISOString(),
              scope,
              lifetime: {
                anchor: {
                  owner: { kind: 'workspace', workspaceId },
                  kind: 'workspace',
                  id: workspaceId,
                },
              },
              state: 'active',
              operation: 'mcp.call-tool',
              stage: 'decide',

              mode: 'gate',
              participant: { kind: 'deterministic', id: 'i16-fixture', version },

              inputDisclosure: scope,

              order: 0,
              timeoutMs: 10000,
              ...(failure ? { failure } : {}),
              circuit: { failures: 1, recoveryAfterMs: 1 },
            },
          ],
        }),
      });
      recordPolicyWriteDecision({
        coreDb,
        actor: { kind: 'local', userId },
        candidate: {
          artifactId: testEntityId('ar', 'i16_policy'),
          contentDigest: policyDigest(prepared.document),
        },
        proposal: {
          schemaVersion: 1,
          proposer: principal,
          rationale: 'Exercise admitted native I16 mediation.',
          baseRevision: policyDigest(document),
          proposed: prepared.document,
          diff: prepared.diff,
          classification: prepared.classification,
          validation: 'valid',
        },
        requestId: 'req_i16_policy',
        threadId: turn.threadId,
        turnId: turn.id,
      });
      document = prepared.document;
      expect(readAdmittedPolicyDocument(coreDb, document)).toEqual(document);
    };
    const condition = (effect: 'prohibit' | 'require_approval', serverId = 'echo') => {
      conditions = [
        {
          id: 'human-mcp-condition',
          kind: 'permission',
          effect,
          grant: { kind: 'ordinary' },
          author: principal,
          authority: { kind: 'human', userId },
          authoredAt: new Date().toISOString(),
          state: 'active',
          scope: {
            subjects: [principal],
            actions: ['tool.use'],
            resources: [{ kind: 'mcp-tool', workspaceId, serverId, toolName: 'echo' }],
          },
          lifetime: {
            anchor: {
              owner: { kind: 'workspace', workspaceId },
              kind: 'workspace',
              id: workspaceId,
            },
          },
        },
      ];
      admit();
    };
    admit();
    const baseConfig = createInMemoryRuntimeConfigSnapshot({ dataRoot, agentManifests: [] });
    const app = new Hono();
    registerWorkerMcpRoutes({
      app,
      coreDb,
      store,
      interception,
      vaultUnlockState,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      workerControlGateway: {
        authenticatePackageToken: vi.fn(() => environmentPackage),
      } as unknown as WorkerControlGateway,
      workerMcpGateway: gateway,
      runtimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          dataRoot,
          agentManifests: [],
          openKitConfig: {
            ...baseConfig.openKitConfig,
            policy: { ...baseConfig.openKitConfig.policy, mediation: document },
          },
          workspaceMcpServerCatalogs: [
            { catalog, path: join(dataRoot, 'catalog.json'), workspaceId },
          ],
        }),
    });
    const client = new Client({ name: 'i16-route', version: '1.0.0' });
    const approvalClient = new Client({ name: 'i16-approval-route', version: '1.0.0' });
    const transport = (serverId: string) =>
      new StreamableHTTPClientTransport(
        new URL(`http://nanocore.test/api/worker-capabilities/mcp/${serverId}`),
        {
          fetch: (request, init) => app.fetch(new Request(request, init)),
          requestInit: { headers: { authorization: 'Bearer fixture-package' } },
        }
      );
    const credentialRead = vi.spyOn(vaultUnlockState.backend(), 'resolve');
    const canary = 'I16_ARGUMENT_BODY_CANARY';
    const call = () => client.callTool({ name: 'echo', arguments: { message: canary } });
    const approvalCall = () =>
      approvalClient.callTool({ name: 'echo', arguments: { message: canary } });
    const decisions = () =>
      listExportableWorkspacePermissionDecisions(workspaceDb, workspaceId).filter(
        (row) => row.mediation?.operation === 'mcp.call-tool'
      );
    const boundaryCounts = () => ({
      list: vi.mocked(gateway.listTools).mock.calls.length,
      call: vi.mocked(gateway.callTool).mock.calls.length,
      credential: credentialRead.mock.calls.length,
      plans: coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_injection_plans').get(),
      receipts: coreDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts')
        .get(),
    });
    const assertRecords = (
      start: number,
      result: string,
      outcome: string,
      options: { kernel?: 'allow' | null; serverId?: string; gateResult?: string } = {}
    ) => {
      const kernel = options.kernel === undefined ? 'allow' : options.kernel;
      const serverId = options.serverId ?? 'echo';
      const rows = decisions().slice(start);
      expect(rows).toHaveLength(2);
      const binding = document.statements.find((statement) => statement.kind === 'binding');
      expect(binding).toBeDefined();
      const bindingRef = { id: binding!.id, digest: policyDigest(binding) };
      const gateRow = rows.find((row) => row.mediation?.role === 'gate')!;
      const final = rows.find((row) => row.mediation?.role === 'final')!;
      expect(gateRow.result).toBe(options.gateResult ?? result);
      const context = final.contextSummary as { capabilityCallId: string };
      const expectedSubject = {
        principal,
        onBehalfOf: null,
        actor: { kind: 'agent', id: environmentPackage.agent.agentId, responsibleUserId: userId },
        process: { workspaceId, threadId: turn.threadId, turnId: turn.id },
        credentialKind: 'worker-package',
        responsibleHumanId: userId,
      };
      expect(final).toMatchObject({
        result,
        enforcementPoint: 'mcp.call-tool@decide',
        policySnapshotId: policyDigest(document),
        contextSummary: {
          capabilityCallId: context.capabilityCallId,
          packageSnapshotId: environmentPackage.snapshotId,
          catalogRevision: resolveWorkspaceMcpServer({ catalog, serverId }).catalogDigest,
        },
        mediation: {
          subject: expectedSubject,
          kernel: kernel ? { effect: kernel } : null,
          invocations: [{ kind: 'decision', id: gateRow.decisionId }],
        },
      });
      expect(final.mediation?.proposalDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(final.mediation?.authorizationRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(gateRow.mediation).toMatchObject({
        binding: bindingRef,

        subject: expectedSubject,
        proposalDigest: final.mediation?.proposalDigest,
        authorizationRevision: final.mediation?.authorizationRevision,
      });
      const audits = listWorkspaceAuditEvents(workspaceDb, workspaceId);
      expect(audits.find((event) => event.id === gateRow.auditEventId)).toMatchObject({
        permissionDecisionId: gateRow.decisionId,
        capabilityCallId: context.capabilityCallId,
        policyInvocation: {
          mode: 'gate',
          outcome,
          binding: bindingRef,
          participant: { id: binding!.participant.id, version: binding!.participant.version },
          subject: expectedSubject,
          capabilityCallId: context.capabilityCallId,
          proposalDigest: final.mediation?.proposalDigest,
          authorizationRevision: final.mediation?.authorizationRevision,
        },
      });
      expect(audits.find((event) => event.id === final.auditEventId)).toMatchObject({
        permissionDecisionId: final.decisionId,
        capabilityCallId: context.capabilityCallId,
      });
      expect(
        workspaceDb.sqlite
          .prepare(
            'SELECT package_snapshot_id, provider_ref, service_ref FROM capability_calls WHERE call_id = ?'
          )
          .get(context.capabilityCallId)
      ).toEqual({
        package_snapshot_id: environmentPackage.snapshotId,
        provider_ref: serverId,
        service_ref: 'mcp-tool:echo',
      });
      return final;
    };
    try {
      await client.connect(transport('echo'));
      await approvalClient.connect(transport('echo-approval'));
      await client.listTools();
      const beforeDiscoveryPolicy = document;
      let enteredCleanup!: () => void;
      let releaseCleanup!: () => void;
      const cleanupEntered = new Promise<void>((resolve) => {
        enteredCleanup = resolve;
      });
      const cleanupHold = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      vi.mocked(gateway.closeServerIfIdle).mockImplementationOnce(async () => {
        enteredCleanup();
        await cleanupHold;
      });
      const firstApprovalDiscovery = approvalClient.listTools();
      try {
        await cleanupEntered;
        condition('prohibit', 'echo-approval');
        releaseCleanup();
        const currentDiscovery = await firstApprovalDiscovery;
        expect.soft(currentDiscovery.tools).toEqual([]);
      } finally {
        releaseCleanup();
        conditions = [];
        admit();
      }
      expect(document).toEqual(beforeDiscoveryPolicy);
      const seeded = workspaceDb.sqlite
        .prepare(
          "SELECT schema_snapshot_id FROM capability_calls WHERE operation = 'mcp.list-tools' AND turn_id = ? AND package_snapshot_id = ? AND provider_ref = 'echo'"
        )
        .get(turn.id, environmentPackage.snapshotId) as { schema_snapshot_id: string };
      expect(seeded.schema_snapshot_id).toEqual(expect.any(String));
      const approvalSchema = workspaceDb.sqlite
        .prepare(
          "SELECT schema_snapshot_id FROM capability_calls WHERE operation = 'mcp.list-tools' AND turn_id = ? AND package_snapshot_id = ? AND provider_ref = 'echo-approval'"
        )
        .get(turn.id, environmentPackage.snapshotId) as { schema_snapshot_id: string };
      expect(approvalSchema.schema_snapshot_id).toEqual(expect.any(String));
      expect(invoke).not.toHaveBeenCalled();
      expect(await call()).toMatchObject({ content: [{ text: 'completed' }] });
      assertRecords(0, 'allow', 'completed');
      expect(gateway.callTool).toHaveBeenCalledTimes(1);
      expect(credentialRead).toHaveBeenCalled();
      // Baseline supply stays usable without an explicit allow statement.
      condition('prohibit');
      expect((await client.listTools()).tools).toEqual([]);
      const prohibitedBoundary = boundaryCounts();
      await expect(call()).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
      expect(boundaryCounts()).toEqual(prohibitedBoundary);
      expect(decisions().findLast((row) => row.mediation?.role === 'final')).toMatchObject({
        result: 'deny',
        mediation: { kernel: { effect: 'deny' } },
      });
      conditions = [];
      admit();
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo']);
      const allowedBoundary = boundaryCounts();
      gate = 'deny';
      let start = decisions().length;
      await expect(call()).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
      assertRecords(start, 'deny', 'completed');
      expect(boundaryCounts()).toEqual(allowedBoundary);
      const absentVersion = `sha256:${'2'.repeat(64)}`;
      admit(absentVersion, 'error');
      start = decisions().length;
      await expect(call()).rejects.toMatchObject({ data: { code: 'mcp-policy-unavailable' } });
      const unavailable = assertRecords(start, 'error', 'unavailable');
      expect(boundaryCounts()).toEqual(allowedBoundary);
      admit(absentVersion);
      start = decisions().length;
      const pendingResult = await call();
      expect(pendingResult).toMatchObject({
        isError: true,
        structuredContent: { status: 'pending-approval' },
      });
      const escalation = assertRecords(start, 'require_escalation', 'unavailable');
      expect(escalation.decisionId).not.toBe(unavailable.decisionId);
      const pending = listThreadPendingRequests(workspaceDb.sqlite, workspaceId, turn.threadId);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        state: 'pending',
        kind: 'approval',
        requesterKind: 'worker',
        responsibleUserId: userId,
        schemaSnapshotId: seeded.schema_snapshot_id,
        policyDecisionId: escalation.decisionId,
        canonicalArgumentsJson: JSON.stringify({ message: canary }),
        packageDigest: environmentPackage.snapshotId,
      });
      expect(store.getTurnById(turn.id).items).toContainEqual(
        expect.objectContaining({
          type: 'approval-request',
          approvalRequestId: pending[0]!.requestId,
        })
      );
      expect(boundaryCounts()).toEqual(allowedBoundary);
      admit();
      gate = 'allow';
      start = decisions().length;
      const invokedBeforeEvidenceFailure = invoke.mock.calls.length;
      workspaceDb.sqlite.exec(
        "CREATE TRIGGER fail_i16_evidence BEFORE INSERT ON audit_events WHEN NEW.policy_invocation_json IS NOT NULL BEGIN SELECT RAISE(ABORT, 'I16 required Audit unavailable'); END"
      );
      try {
        await expect(call()).rejects.toMatchObject({ data: { code: 'mcp-call-failed' } });
      } finally {
        workspaceDb.sqlite.exec('DROP TRIGGER fail_i16_evidence');
      }
      expect(invoke).toHaveBeenCalledTimes(invokedBeforeEvidenceFailure + 1);
      expect(decisions()).toHaveLength(start);
      expect(boundaryCounts()).toEqual(allowedBoundary);
      condition('require_approval', 'echo-approval');
      gate = 'deny';
      start = decisions().length;
      await expect(approvalCall()).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
      assertRecords(start, 'deny', 'completed', { serverId: 'echo-approval' });
      expect(
        listThreadPendingRequests(workspaceDb.sqlite, workspaceId, turn.threadId)
      ).toHaveLength(1);
      expect(boundaryCounts()).toEqual(allowedBoundary);
      gate = 'allow';
      start = decisions().length;
      expect(await approvalCall()).toMatchObject({
        isError: true,
        structuredContent: { status: 'pending-approval' },
      });
      const policyApproval = assertRecords(start, 'require_approval', 'completed', {
        serverId: 'echo-approval',
        gateResult: 'allow',
      });
      expect(policyApproval.requiredApprovalKind).toBe('permission');
      const afterPolicyApproval = listThreadPendingRequests(
        workspaceDb.sqlite,
        workspaceId,
        turn.threadId
      );
      expect(afterPolicyApproval).toHaveLength(2);
      expect(
        afterPolicyApproval.find((request) => request.serverId === 'echo-approval')
      ).toMatchObject({
        state: 'pending',
        policyDecisionId: policyApproval.decisionId,
        schemaSnapshotId: approvalSchema.schema_snapshot_id,
        packageDigest: environmentPackage.snapshotId,
      });
      expect(boundaryCounts()).toEqual(allowedBoundary);
      const originalApprovalPolicy = document;
      const approvalOnlyConditions = conditions;
      const originalPending = afterPolicyApproval.find(
        (request) => request.serverId === 'echo-approval'
      )!;
      expect(await approvalCall()).toMatchObject({
        isError: true,
        structuredContent: { status: 'pending-approval', requestId: originalPending.requestId },
      });
      expect(listThreadPendingRequests(workspaceDb.sqlite, workspaceId, turn.threadId)).toEqual(
        afterPolicyApproval
      );
      const approvalCondition = approvalOnlyConditions.find(
        (statement) => statement.kind === 'permission'
      );
      if (!approvalCondition) throw new Error('Expected the admitted approval condition.');
      conditions = [
        ...approvalOnlyConditions,
        { ...approvalCondition, id: 'prohibit-existing-approval', effect: 'prohibit' },
      ];
      admit();
      const beforeProhibitedDuplicate = boundaryCounts();
      const beforeDuplicateDecisions = decisions().length;
      // The SDK allocates a fresh protocol request id for identical qualified Tool arguments.
      const prohibitedDuplicate = await approvalCall().then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );
      expect.soft(prohibitedDuplicate).toMatchObject({ error: { data: { code: 'mcp-denied' } } });
      expect
        .soft(
          decisions()
            .slice(beforeDuplicateDecisions)
            .find((row) => row.mediation?.role === 'final')
        )
        .toMatchObject({
          result: 'deny',
          mediation: { kernel: { effect: 'deny' } },
        });
      expect(boundaryCounts()).toEqual(beforeProhibitedDuplicate);
      expect(listThreadPendingRequests(workspaceDb.sqlite, workspaceId, turn.threadId)).toEqual(
        afterPolicyApproval
      );
      conditions = approvalOnlyConditions;
      admit();
      expect(document).toEqual(originalApprovalPolicy);
      expect(await approvalCall()).toMatchObject({
        isError: true,
        structuredContent: { status: 'pending-approval', requestId: originalPending.requestId },
      });
      expect(boundaryCounts()).toEqual(allowedBoundary);
      expect(listThreadPendingRequests(workspaceDb.sqlite, workspaceId, turn.threadId)).toEqual(
        afterPolicyApproval
      );
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const participantEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      start = decisions().length;
      const held = call();
      const refused = expect(held).rejects.toMatchObject({
        data: { code: 'mcp-policy-unavailable' },
      });
      await participantEntered;
      revokeOpenKitAccessTokenRecord(coreDb, token.tokenId);
      release();
      await refused;
      assertRecords(start, 'error', 'error', { kernel: null, gateResult: 'require_escalation' });
      expect(boundaryCounts()).toEqual(allowedBoundary);
      expect(JSON.stringify(invoke.mock.calls)).not.toContain(canary);
      expect(
        JSON.stringify(workspaceDb.sqlite.prepare('SELECT * FROM audit_events').all())
      ).not.toContain(canary);
      expect(
        JSON.stringify(coreDb.sqlite.prepare('SELECT * FROM audit_events').all())
      ).not.toContain(canary);
    } finally {
      credentialRead.mockRestore();
      await client.close();
      await approvalClient.close();
      await gateway.close();
      vaultUnlockState.lock();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'abort',
    'expiry',
  ] as const)('releases the Tool handler and Workspace admission after accepted unresolved capture %s', async (ending) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capture-wait-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Submit one file',
      {
        id: 'usr_00000000-0000-7000-8000-000000000001',
        kind: 'user',
      }
    );
    await store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-10-05T00:00:00.000Z',
      id: testEntityId('as', 'as_capture_wait'),
      message: null,
      status: 'busy',
      threadId: turn.threadId,
      updatedAt: '2026-10-05T00:00:00.000Z',
      workspaceId: workspaceIdForOwner(turn.owner),
    });
    await store.updateTurn(turn.id, {
      agentSessionId: testEntityId('as', 'as_capture_wait'),
      agentId: 'agent_codex_host',
      status: 'running',
    });
    const pkg = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId: testEntityId('as', 'as_capture_wait'),
      agentSetup: createTestAgentSetup(),
      backend: { kind: 'openshell' },
      createdAt: '2026-10-05T00:00:00.000Z',
      requestId: 'req_capture_wait',
      triggerActor: turn.triggerActor,
      turn,
      workspaceCwd: '/workspace',
      workspaceRoots: [],
    });
    pkg.workspace.outputs = [
      {
        id: 'output',
        path: '/workspace/output',
        registerAsArtifacts: true,
        retention: 'sync-on-turn-end',
      },
    ];
    recordMcpWorkerLineage(coreDb, pkg);
    const authority = createNanoHostTransportSessionAuthority();
    const target = {
      deploymentId: 'capture-wait',
      identityId: 'capture-wait',
      targetId: 'capture-wait',
    };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      observedAt: '2026-10-05T00:00:00.000Z',
    });
    let admit!: (physical: object) => void;
    const physicalReady = new Promise<object>((resolve) => {
      admit = resolve;
    });
    const server = createHttp2Server((request, response) => {
      admit(readNanoHostPhysicalConnectionContext(request)!);
      response.writeHead(204).end();
    });
    const fileAdmission = new FileStorageAdmission(dataRoot, () => 0n);
    const dispatch = createNanoHostSessionDispatch({
      coreDb,
      sessionAuthority: authority,
      fileAdmission,
    });
    const admission = new WorkspaceMutationAdmission();
    const gateway = createDefaultWorkerMcpGateway(coreDb);
    const client = new Client({ name: 'capture-wait', version: '1.0.0' });
    let nativeClient: ReturnType<typeof connectHttp2> | undefined;
    let physical: object | undefined;
    let entered!: () => void;
    const captureEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let captureCount = 0;
    const effectRequest = {
      kind: 'file.export',
      requestId: 'b'.repeat(64),
      input: {
        purpose: 'artifact-submission',
        submissionRequestId: 'capture-wait',
        turnId: turn.id,
        agentSessionId: pkg.scope.agentSessionId,
        packageSnapshotId: pkg.snapshotId,
        leaseId: `lease_${turn.id}`,
        backendSessionId: 'backend_capture_wait',
        sandboxId: 'sandbox_capture_wait',
        maxByteLength: 1024,
        presence: 'optional',
        relativePath: 'report.md',
        slot: 'output',
      },
    };
    const app = new Hono();
    registerWorkerMcpRoutes({
      app,
      coreDb,
      store,
      workspaceMutationAdmission: admission,
      runtimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          dataRoot,
          agentManifests: [],
          workspaceMcpServerCatalogs: [],
        }),
      workerControlGateway: {
        authenticatePackageToken: vi.fn(() => pkg),
      } as unknown as WorkerControlGateway,
      workerMcpGateway: gateway,
      fileAdmission,
      captureArtifact: async (input) => {
        captureCount += 1;
        const result = dispatch.effect({ ...effectRequest, signal: input.signal });
        entered();
        await result;
        throw new Error('An abandoned capture must never return bytes to publication.');
      },
    });
    let closed = false;
    let closing: Promise<void> | undefined;
    let call: Promise<unknown> | undefined;
    let accepted = false;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing capture address.');
      nativeClient = connectHttp2(`http://127.0.0.1:${address.port}`);
      nativeClient
        .request({ ':method': 'POST', ':path': '/' })
        .on('data', () => {})
        .end();
      physical = await physicalReady;
      authority.admit({
        connectionGeneration: 1,
        identityId: target.identityId,
        physicalConnection: physical,
      });
      await dispatch.readiness!(
        physical,
        Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        { ...target, coreDb }
      );
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL('http://nanocore.test/api/worker-capabilities/mcp/openkit-work'),
          {
            fetch: (input, init) => app.fetch(new Request(input, init)),
            requestInit: { headers: { authorization: 'Bearer capability-token' } },
          }
        )
      );
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const abort = new AbortController();
      call = client.callTool(
        {
          name: 'work_artifact_submit',
          arguments: {
            requestId: 'capture-wait',
            path: '/workspace/output/report.md',
            title: 'Report',
            kind: 'file',
            mediaType: 'text/markdown',
          },
        },
        { signal: abort.signal, timeout: 400_000 }
      );
      void call.catch(() => undefined);
      await Promise.race([
        captureEntered,
        call.then(() => {
          throw new Error('Capture was not entered.');
        }),
      ]);
      expect(await dispatch.poll(physical, 'file.export')).toMatchObject({
        requestId: effectRequest.requestId,
      });
      accepted = true;
      closing = admission.close('ws_00000000-0000-7000-8000-000000000001').then(() => {
        closed = true;
      });
      expect(closed).toBe(false);
      if (ending === 'abort') abort.abort();
      else await vi.advanceTimersByTimeAsync(300_000);
      vi.useRealTimers();
      // Closing cannot finish until the actual route's finally closes its database and releases its permit.
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000, interval: 10 });
      if (ending === 'expiry')
        await expect(call).rejects.toMatchObject({ data: { code: 'recovery_required' } });
      else await expect(call).rejects.toThrow(/abort/i);
      expect(captureCount).toBe(1);
      await expect(
        dispatch.effect({ ...effectRequest, requestId: 'c'.repeat(64) })
      ).rejects.toMatchObject({ code: 'artifact_capture_busy' });
      const bytes = Buffer.from('# Late result');
      await dispatch.fileExportResult!(
        physical,
        new Request('http://nanocore.test/file', {
          method: 'POST',
          body: bytes,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(bytes.length),
            'x-openkit-request-id': effectRequest.requestId,
            'x-openkit-relative-path': 'report.md',
            'x-openkit-slot': 'output',
            'x-openkit-byte-length': String(bytes.length),
            'x-openkit-sha256': `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          },
        })
      );
      accepted = false;
      const next = dispatch.effect({ ...effectRequest, requestId: 'c'.repeat(64) });
      expect(await dispatch.poll(physical, 'file.export')).toMatchObject({
        requestId: 'c'.repeat(64),
      });
      await dispatch.result(physical, 'file.export', {
        requestId: 'c'.repeat(64),
        state: 'absent',
      });
      await expect(next).resolves.toMatchObject({ state: 'absent' });
      expect(store.listArtifacts('ws_00000000-0000-7000-8000-000000000001')).toEqual([]);
      expect(
        store
          .listThreadItems(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          )
          .filter((item) => item.type === 'artifact-reference')
      ).toEqual([]);
      const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      try {
        expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM artifact_reviews').get()).toEqual({
          count: 0,
        });
        expect(store.listCommandRequests()).toEqual([]);
      } finally {
        db.sqlite.close();
      }
      admission.reopen('ws_00000000-0000-7000-8000-000000000001');
      expect(
        (await client.listTools()).tools.some((tool) => tool.name === 'work_artifact_submit')
      ).toBe(true);
    } finally {
      vi.useRealTimers();
      if (accepted && physical)
        await dispatch.result(physical, 'file.export', {
          requestId: effectRequest.requestId,
          state: 'absent',
        });
      await call?.catch(() => undefined);
      await closing;
      await client.close().catch(() => undefined);
      await gateway.close();
      nativeClient?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      coreDb.sqlite.close();
    }
  });

  it('serves one stateless-era client and one session-era client on the worker MCP route', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-era-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'List generative MCP tools',
      {
        id: 'usr_00000000-0000-7000-8000-000000000001',
        kind: 'user',
      }
    );
    await store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-09-03T00:00:00.000Z',
      id: testEntityId('as', 'as_mcp_era'),
      message: null,
      status: 'busy',
      threadId: turn.threadId,
      updatedAt: '2026-09-03T00:00:00.000Z',
      workspaceId: workspaceIdForOwner(turn.owner),
    });
    await store.updateTurn(turn.id, {
      agentId: 'agent_codex_host',
      agentSessionId: testEntityId('as', 'as_mcp_era'),
    });
    const environmentPackage = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId: testEntityId('as', 'as_mcp_era'),
      agentSetup: createTestAgentSetup(),
      backend: { kind: 'openshell' },
      createdAt: '2026-09-03T00:00:00.000Z',
      requestId: 'req_mcp_era',
      triggerActor: turn.triggerActor,
      turn,
      workspaceCwd: '/workspace',
      workspaceRoots: [],
    });
    recordMcpWorkerLineage(coreDb, environmentPackage);
    const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
    const app = new Hono();
    const knowledgeAnswer = {
      threadId: testEntityId('th', 'km-query'),
      turnId: testEntityId('tu', 'km-query'),
      answer: 'The cited answer has exact bytes: é.',
      citations: [],
      uncertainty: 'Fixture delivery only.',
    };
    const askKnowledge = vi.fn(async () => knowledgeAnswer);
    let builtinPolicy = EMPTY_POLICY_DOCUMENT;
    const builtinBaseConfig = createInMemoryRuntimeConfigSnapshot({ dataRoot, agentManifests: [] });
    const publishBuiltinCondition = (effect: 'prohibit' | 'require_approval' | null) => {
      const userId = 'usr_00000000-0000-7000-8000-000000000001';
      const principal = { kind: 'human' as const, id: userId };
      const prepared = preparePolicyDocument({
        current: builtinPolicy,
        userId,
        now: new Date().toISOString(),
        proposed: PolicyDocumentV1Schema.parse({
          schemaVersion: 1,
          statements: effect
            ? [
                {
                  id: 'builtin-human-condition',
                  kind: 'permission',
                  effect,
                  grant: { kind: 'ordinary' },
                  author: principal,
                  authority: { kind: 'human', userId },
                  authoredAt: new Date().toISOString(),
                  state: 'active',
                  scope: {
                    subjects: [principal],
                    actions: ['tool.use'],
                    resources: [
                      {
                        kind: 'mcp-tool',
                        workspaceId: workspaceIdForOwner(turn.owner),
                        serverId: 'openkit-work',
                        toolName: operationToolName('knowledge.ask'),
                      },
                      {
                        kind: 'mcp-tool',
                        workspaceId: workspaceIdForOwner(turn.owner),
                        serverId: 'openkit-generative',
                        toolName: 'kernel_apps_list',
                      },
                    ],
                  },
                  lifetime: {
                    anchor: {
                      owner: { kind: 'workspace', workspaceId: workspaceIdForOwner(turn.owner) },
                      kind: 'workspace',
                      id: workspaceIdForOwner(turn.owner),
                    },
                  },
                },
              ]
            : [],
        }),
      });
      recordPolicyWriteDecision({
        coreDb,
        actor: { kind: 'local', userId },
        candidate: {
          artifactId: testEntityId('ar', 'builtin-human-condition'),
          contentDigest: policyDigest(prepared.document),
        },
        proposal: {
          schemaVersion: 1,
          proposer: principal,
          rationale: 'Govern exact built-in Tools.',
          baseRevision: policyDigest(builtinPolicy),
          proposed: prepared.document,
          validation: 'valid',
        },
        requestId: randomUUID(),
        threadId: turn.threadId,
        turnId: turn.id,
      });
      builtinPolicy = prepared.document;
      expect(readAdmittedPolicyDocument(coreDb, builtinPolicy)).toEqual(builtinPolicy);
    };
    registerWorkerMcpRoutes({
      app,
      coreDb,
      knowledgeAgent: { ask: askKnowledge, maintain: vi.fn() },
      runtimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          dataRoot,
          agentManifests: [],
          openKitConfig: {
            ...builtinBaseConfig.openKitConfig,
            policy: { ...builtinBaseConfig.openKitConfig.policy, mediation: builtinPolicy },
          },
          workspaceMcpServerCatalogs: [],
        }),
      store,
      workerControlGateway: {
        authenticatePackageToken: vi.fn(() => environmentPackage),
      } as unknown as WorkerControlGateway,
      workerMcpGateway,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    const rpcErrors: unknown[] = [];
    const nativeRequests: { update?: Request } = {};
    const fetchMcp = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'POST') {
        const body = await request.clone().json();
        if (body.method === 'tools/call' && body.params?.name === 'kernel_records_update')
          nativeRequests.update = request.clone();
      }
      const response = await app.fetch(request);
      if (response.headers.get('content-type')?.includes('application/json')) {
        const payload = (await response.clone().json()) as { error?: unknown };
        if (payload.error) rpcErrors.push(payload.error);
      }
      return response;
    };
    const sessionClient = new Client(
      { name: 'session-era', version: '1.0.0' },
      { versionNegotiation: { mode: 'legacy' } }
    );
    const statelessClient = new Client(
      { name: 'stateless-era', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    const endpoint = new URL('http://nanocore.test/api/worker-capabilities/mcp/openkit-generative');
    const sessionTransport = new StreamableHTTPClientTransport(endpoint, {
      fetch: fetchMcp,
      requestInit: { headers: { authorization: 'Bearer capability-token' } },
    });
    const statelessTransport = new StreamableHTTPClientTransport(endpoint, {
      fetch: fetchMcp,
      requestInit: { headers: { authorization: 'Bearer capability-token' } },
    });
    const workClient = new Client({ name: 'work-input', version: '1.0.0' });
    const workTransport = new StreamableHTTPClientTransport(
      new URL('http://nanocore.test/api/worker-capabilities/mcp/openkit-work'),
      {
        fetch: fetchMcp,
        requestInit: { headers: { authorization: 'Bearer capability-token' } },
      }
    );
    try {
      await sessionClient.connect(sessionTransport);
      await statelessClient.connect(statelessTransport);
      await workClient.connect(workTransport);
      expect(sessionClient.getProtocolEra()).toBe('legacy');
      expect(statelessClient.getProtocolEra()).toBe('modern');
      const sessionTools = await sessionClient.listTools();
      const statelessTools = await statelessClient.listTools();
      expect(sessionTools.tools.map((tool) => tool.name)).toContain('kernel_apps_list');
      expect(statelessTools.tools.map((tool) => tool.name)).toContain('kernel_apps_list');
      expect((await workClient.listTools()).tools.map((tool) => tool.name)).toEqual([
        operationToolName('automation.event-admit'),
        operationToolName('knowledge.ask'),
        operationToolName('knowledge.tell'),
        'work_input_request',
        'work_peer_list',
        'work_peer_read',
        'work_source_read',
        'work_source_search',
        'work_source_view',
        'work_artifact_submit',
      ]);
      const delivered = await workClient.callTool({
        name: operationToolName('knowledge.ask'),
        arguments: { question: 'What is known?' },
      });
      expect(askKnowledge).toHaveBeenCalledWith(
        expect.objectContaining({
          caller: 'worker',
          workspaceId: workspaceIdForOwner(turn.owner),
          question: 'What is known?',
          access: expect.objectContaining({ outputThreadId: turn.threadId, outputTurnId: turn.id }),
        })
      );
      const knowledgeDb = openWorkspaceDb(dataRoot, workspaceIdForOwner(turn.owner));
      try {
        const retained = listWorkspaceCapabilityCalls(
          knowledgeDb,
          workspaceIdForOwner(turn.owner)
        ).find((call) => call.extensions?.['openkit.knowledge/delivery']);
        expect(retained?.status).toBe('succeeded');
        expect(JSON.parse(retained!.extensions!['openkit.knowledge/delivery']!.answer)).toEqual(
          delivered
        );
        expect(delivered.content).toEqual([
          { type: 'text', text: JSON.stringify(knowledgeAnswer) },
        ]);
      } finally {
        knowledgeDb.sqlite.close();
      }
      const conditionDb = openWorkspaceDb(dataRoot, workspaceIdForOwner(turn.owner));
      try {
        const pendingBefore = conditionDb.sqlite.prepare('SELECT * FROM pending_requests').all();
        const selectedCalls = () =>
          conditionDb.sqlite
            .prepare(
              'SELECT * FROM capability_calls WHERE capability_id IN (?, ?) ORDER BY call_id'
            )
            .all(
              `mcp.call-tool.${operationToolName('knowledge.ask')}`,
              'mcp.call-tool.kernel_apps_list'
            );
        const callsBefore = selectedCalls();
        publishBuiltinCondition('prohibit');
        expect((await workClient.listTools()).tools.map((tool) => tool.name)).not.toContain(
          operationToolName('knowledge.ask')
        );
        expect((await statelessClient.listTools()).tools.map((tool) => tool.name)).not.toContain(
          'kernel_apps_list'
        );
        await expect(
          workClient.callTool({
            name: operationToolName('knowledge.ask'),
            arguments: { question: 'Prohibited question' },
          })
        ).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
        await expect(
          statelessClient.callTool({ name: 'kernel_apps_list', arguments: {} })
        ).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
        expect(askKnowledge).toHaveBeenCalledTimes(1);
        expect(selectedCalls()).toEqual(callsBefore);
        publishBuiltinCondition('require_approval');
        expect((await workClient.listTools()).tools.map((tool) => tool.name)).toContain(
          operationToolName('knowledge.ask')
        );
        expect((await sessionClient.listTools()).tools.map((tool) => tool.name)).toContain(
          'kernel_apps_list'
        );
        // Built-in human capture is unavailable, so approval requirements refuse before dispatch.
        await expect(
          workClient.callTool({
            name: operationToolName('knowledge.ask'),
            arguments: { question: 'Needs human approval' },
          })
        ).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
        await expect(
          sessionClient.callTool({ name: 'kernel_apps_list', arguments: {} })
        ).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
        expect(askKnowledge).toHaveBeenCalledTimes(1);
        expect(selectedCalls()).toEqual(callsBefore);
        expect(conditionDb.sqlite.prepare('SELECT * FROM pending_requests').all()).toEqual(
          pendingBefore
        );
        publishBuiltinCondition(null);
        const ledgerBeforeHeldAsk = listWorkspaceCapabilityCalls(
          conditionDb,
          workspaceIdForOwner(turn.owner)
        );
        const previousCallIds = new Set(ledgerBeforeHeldAsk.map((call) => call.id));
        const withheldAnswer = 'BUILTIN_POST_AWAIT_WITHHELD_ANSWER';
        let releaseAsk!: () => void;
        let enteredAsk!: () => void;
        const askEntered = new Promise<void>((resolve) => {
          enteredAsk = resolve;
        });
        const askHold = new Promise<void>((resolve) => {
          releaseAsk = resolve;
        });
        askKnowledge.mockImplementationOnce(async () => {
          enteredAsk();
          await askHold;
          return { ...knowledgeAnswer, answer: withheldAnswer };
        });
        const heldAsk = workClient.callTool({
          name: operationToolName('knowledge.ask'),
          arguments: { question: 'Hold this answer until current Policy is checked.' },
        });
        const withheld = expect(heldAsk).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
        try {
          await askEntered;
          publishBuiltinCondition('prohibit');
          releaseAsk();
          await withheld;
          expect(askKnowledge).toHaveBeenCalledTimes(2);
          const ledgerAfterHeldAsk = listWorkspaceCapabilityCalls(
            conditionDb,
            workspaceIdForOwner(turn.owner)
          );
          expect(ledgerAfterHeldAsk.filter((call) => previousCallIds.has(call.id))).toEqual(
            ledgerBeforeHeldAsk
          );
          const heldCalls = ledgerAfterHeldAsk.filter((call) => !previousCallIds.has(call.id));
          expect(heldCalls).toHaveLength(1);
          expect(heldCalls[0]).toMatchObject({
            capabilityId: `mcp.call-tool.${operationToolName('knowledge.ask')}`,
            completedAt: expect.any(String),
          });
          expect(heldCalls[0]!.extensions?.['openkit.knowledge/delivery']).toBeUndefined();
          expect(
            JSON.stringify(store.listThreadItems(workspaceIdForOwner(turn.owner), turn.threadId))
          ).not.toContain(withheldAnswer);
          expect(conditionDb.sqlite.prepare('SELECT * FROM pending_requests').all()).toEqual(
            pendingBefore
          );
        } finally {
          releaseAsk();
          publishBuiltinCondition(null);
        }
      } finally {
        conditionDb.sqlite.close();
      }
      // Owner refusals cross the selected HTTP relay and retain their established JSON-RPC envelope.
      const refusalDb = openWorkspaceDb(dataRoot, workspaceIdForOwner(turn.owner));
      try {
        applyScopedMigrations(refusalDb);
        const errorsBefore = rpcErrors.length;
        const itemsBefore = store.listThreadItems(workspaceIdForOwner(turn.owner), turn.threadId);
        const turnBefore = store.getTurnById(turn.id);
        const presentationsBefore = refusalDb.sqlite
          .prepare('SELECT * FROM generative_presentations')
          .all();
        const receiptsBefore = refusalDb.sqlite.prepare('SELECT * FROM idempotency_requests').all();
        const missingAppId = '00000000-0000-4000-8000-000000000701';
        const missingPresentationId = 'pres_00000000-0000-70d7-8dd6-8e00b4b4b40e';
        expect(
          existsSync(lightAppDbPath(dataRoot, workspaceIdForOwner(turn.owner), missingAppId))
        ).toBe(false);
        await expect(
          sessionClient.callTool({
            name: 'kernel_apps_retire',
            arguments: { appId: missingAppId, expectedAppRevision: 1 },
          })
        ).rejects.toMatchObject({
          code: -32600,
          message: expect.stringContaining('App authority is missing.'),
          data: { code: 'unavailable' },
        });
        await expect(
          statelessClient.callTool({
            name: 'generative-ui_action',
            arguments: {
              presentationId: missingPresentationId,
              version: 'v0.9',
              action: {
                name: 'update',
                surfaceId: 'missing-surface',
                sourceComponentId: 'missing-button',
                timestamp: '2026-09-03T00:00:00.000Z',
              },
            },
          })
        ).rejects.toMatchObject({
          code: -32600,
          message: expect.stringContaining('Presentation was not found.'),
          data: { code: 'not_found' },
        });
        expect(rpcErrors.slice(errorsBefore)).toEqual([
          {
            code: -32600,
            message: 'App authority is missing.',
            data: { code: 'unavailable', message: 'App authority is missing.', status: 503 },
          },
          {
            code: -32600,
            message: 'Presentation was not found.',
            data: { code: 'not_found', message: 'Presentation was not found.', status: 404 },
          },
        ]);
        expect(
          refusalDb.sqlite
            .prepare(`
          SELECT capability_id, status, error_code, turn_id, package_snapshot_id
          FROM capability_calls WHERE capability_id IN (?, ?) ORDER BY capability_id
        `)
            .all('mcp.call-tool.generative-ui_action', 'mcp.call-tool.kernel_apps_retire')
        ).toEqual([
          {
            capability_id: 'mcp.call-tool.generative-ui_action',
            status: 'failed',
            error_code: 'not_found',
            turn_id: turn.id,
            package_snapshot_id: environmentPackage.snapshotId,
          },
          {
            capability_id: 'mcp.call-tool.kernel_apps_retire',
            status: 'failed',
            error_code: 'unavailable',
            turn_id: turn.id,
            package_snapshot_id: environmentPackage.snapshotId,
          },
        ]);
        expect(refusalDb.sqlite.prepare('SELECT * FROM generative_presentations').all()).toEqual(
          presentationsBefore
        );
        expect(refusalDb.sqlite.prepare('SELECT * FROM idempotency_requests').all()).toEqual(
          receiptsBefore
        );
        expect(store.listThreadItems(workspaceIdForOwner(turn.owner), turn.threadId)).toEqual(
          itemsBefore
        );
        expect(store.getTurnById(turn.id)).toEqual(turnBefore);
        expect(
          existsSync(lightAppDbPath(dataRoot, workspaceIdForOwner(turn.owner), missingAppId))
        ).toBe(false);
      } finally {
        refusalDb.sqlite.close();
      }
      // This selected package reaches real native commands through the authenticated MCP relay.
      const created = await sessionClient.callTool({
        name: 'kernel_apps_create',
        arguments: {
          format: 'openkit.light-app',
          schemaVersion: 1,
          title: 'Worker native relay proof',
          purpose: 'Preserve local-only membership annotations.',
          collections: [
            {
              name: 'notes',
              type: 'base',
              description: 'Worker-owned local notes.',
              indexes: [],
              fields: [
                { name: 'note', type: 'text', required: true, description: 'A local note.' },
              ],
            },
          ],
        },
      });
      const appProof = created.structuredContent as { appId: string; schemaRevision: number };
      const createdRecord = await sessionClient.callTool({
        name: 'kernel_records_create',
        arguments: {
          appId: appProof.appId,
          collection: 'notes',
          schemaRevision: appProof.schemaRevision,
          data: { note: 'Before Worker update' },
        },
      });
      const recordProof = createdRecord.structuredContent as { id: string; revision: number };
      const mutation = {
        appId: appProof.appId,
        collection: 'notes',
        recordId: recordProof.id,
        schemaRevision: appProof.schemaRevision,
        expectedRecordRevision: recordProof.revision,
        data: { note: 'After Worker update' },
      };
      const updated = await sessionClient.callTool({
        name: 'kernel_records_update',
        arguments: mutation,
      });
      expect(updated.structuredContent).toMatchObject({
        id: recordProof.id,
        revision: 2,
        data: { note: 'After Worker update' },
      });
      expect(nativeRequests.update).toBeDefined();
      const replayResponse = await fetchMcp(nativeRequests.update!.clone());
      expect(replayResponse.status).toBe(200);
      expect((await replayResponse.json()).result).toEqual(updated);
      await expect(
        sessionClient.callTool({ name: 'kernel_records_update', arguments: mutation })
      ).rejects.toMatchObject({ code: -32600, data: { code: 'conflict' } });
      coreDb.sqlite
        .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?")
        .run(new Date().toISOString(), 'usr_00000000-0000-7000-8000-000000000001');
      try {
        await expect(
          sessionClient.callTool({
            name: 'kernel_records_update',
            arguments: {
              ...mutation,
              expectedRecordRevision: 2,
              data: { note: 'Denied Worker overwrite' },
            },
          })
        ).rejects.toMatchObject({ code: -32600, data: { code: 'mcp-denied' } });
      } finally {
        coreDb.sqlite
          .prepare("UPDATE users SET status = 'active', disabled_at = NULL WHERE id = ?")
          .run('usr_00000000-0000-7000-8000-000000000001');
      }
      const readProof = await sessionClient.callTool({
        name: 'kernel_records_get',
        arguments: {
          appId: appProof.appId,
          collection: 'notes',
          recordId: recordProof.id,
          schemaRevision: appProof.schemaRevision,
        },
      });
      expect(readProof.structuredContent).toMatchObject({
        id: recordProof.id,
        revision: 2,
        schemaRevision: appProof.schemaRevision,
        data: { note: 'After Worker update' },
      });
      const pending = await workClient.callTool({
        name: 'work_input_request',
        arguments: {
          requestId: '00000000-0000-4000-8000-000000000144',
          prompt: 'Choose a direction.',
          futureSafeField: 'ignored-metadata',
          questions: [
            {
              id: 'direction',
              header: 'Direction',
              question: 'Which direction should the worker take?',
              options: null,
              isOther: false,
              isSecret: false,
            },
          ],
        },
      });
      expect(pending.isError).toBe(false);
      expect(pending.structuredContent).toMatchObject({
        status: 'pending-input',
        requestId: '00000000-0000-4000-8000-000000000144',
      });
      const questionArgs = (index: number) => ({
        requestId: `00000000-0000-4000-8000-${String(144 + index).padStart(12, '0')}`,
        prompt: `Choose direction ${index}.`,
        questions: [
          {
            id: `direction_${index}`,
            header: 'Direction',
            question: `Which direction ${index}?`,
            options: null,
            isOther: false,
            isSecret: false,
          },
        ],
      });
      for (let index = 1; index < 16; index += 1) {
        expect(
          (
            await workClient.callTool({
              name: 'work_input_request',
              arguments: questionArgs(index),
            })
          ).isError
        ).toBe(false);
      }
      const countDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      const beforeCalls = (
        countDb.sqlite.prepare('SELECT COUNT(*) AS count FROM capability_calls').get() as {
          count: number;
        }
      ).count;
      await expect(
        workClient.callTool({ name: 'work_input_request', arguments: questionArgs(16) })
      ).rejects.toMatchObject({ data: { code: 'request_limit_reached' } });
      expect(
        (
          countDb.sqlite.prepare('SELECT COUNT(*) AS count FROM capability_calls').get() as {
            count: number;
          }
        ).count
      ).toBe(beforeCalls);
      const duplicate = await workClient.callTool({
        name: 'work_input_request',
        arguments: questionArgs(15),
      });
      expect(duplicate.structuredContent).toMatchObject({ requestId: questionArgs(15).requestId });
      expect(
        (
          countDb.sqlite.prepare('SELECT COUNT(*) AS count FROM capability_calls').get() as {
            count: number;
          }
        ).count
      ).toBe(beforeCalls);
      expect(
        JSON.stringify(countDb.sqlite.prepare('SELECT * FROM pending_requests').all())
      ).not.toContain('ignored-metadata');
      countDb.sqlite.close();
      expect(store.getTurnById(turn.id).status).toBe('running');
      expect(
        store
          .listThreadItems(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          )
          .filter((item) => item.type === 'user-input-request')
      ).toHaveLength(16);
    } finally {
      await workClient.close().catch(() => undefined);
      await sessionClient.close().catch(() => undefined);
      await statelessClient.close().catch(() => undefined);
      await workerMcpGateway.close();
      coreDb.sqlite.close();
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'Workspace member',
    'nonmember administrator',
  ] as const)('reads only current same-Sandbox peers through Turn-scoped handles without changing their records: %s', async (audience) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-work-peers-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const threadId = 'th_00000000-0000-7000-8000-000000000001';
    const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: actor.id, workspaceId });
    const timestamp = '2026-09-30T00:00:00.000Z';
    const setup = createTestAgentSetup({
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      dataRoot,
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Peer fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      workspaceConfigs: loadRuntimeConfig(dataRoot).workspaceConfigs,
      agentManifests: [setup.manifest],
    });
    const manager = createRuntimeConfigManager({ dataRoot, initialSnapshot: snapshot });
    const native = createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig: () => snapshot,
    });
    admitTestNativeEnvironment(coreDb, setup.manifest);
    const commands = vi.spyOn(native.runtime, 'acceptNanoHostHarnessCommand');
    const taskAdmissions = vi.spyOn(productTurnStart, 'observeTurnAdmission');
    const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
    const auth = createBetterAuth(coreDb, {
      mode: 'server',
      env: { BETTER_AUTH_URL: 'http://nanocore.test', BETTER_AUTH_SECRET: randomUUID() },
    });
    const taskApp = createApp({
      mode: 'server',
      auth,
      coreDb,
      store,
      workerMcpGateway,
      fileAdmission: native.fileAdmission,
      turnExecutor: native.executor,
      workerControlGateway: native.workerControlGateway,
      runtimeConfigManager: manager,
    });
    const app = new Hono();
    registerWorkerMcpRoutes({
      app,
      coreDb,
      store,
      workerMcpGateway,
      workerControlGateway: native.workerControlGateway,
      runtimeConfig: () => snapshot,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    const client = new Client({ name: 'work-peers', version: '1.0.0' });
    const laterClient = new Client({ name: 'later-work-peers', version: '1.0.0' });
    const task = (requestId: string, secret: string) =>
      taskApp.request(
        ...operationRequest(
          'task.start',
          { workspaceId, threadId },
          {
            method: 'POST',
            headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
            body: JSON.stringify({ input: 'Read peers', requestId }),
          }
        )
      );
    const transport = () =>
      new StreamableHTTPClientTransport(
        new URL('http://nanocore.test/api/worker-capabilities/mcp/openkit-work'),
        {
          fetch: (input, init) => app.fetch(new Request(input, init)),
          requestInit: { headers: { authorization: `Bearer ${native.executor.capabilityToken}` } },
        }
      );
    try {
      let callerUserId = actor.id as string;
      if (audience === 'nonmember administrator') {
        const registered = await auth.handler(
          new Request('http://nanocore.test/api/auth/sign-up/email', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: 'Peer administrator',
              email: 'peer-admin@example.invalid',
              password: randomUUID(),
            }),
          })
        );
        expect(registered.status).toBe(200);
        const { user } = (await registered.json()) as { user: { id: string } };
        callerUserId = user.id;
        expect(isCanonicalUserActive(coreDb, callerUserId)).toBe(true);
        expect(resolveWorkspaceMembershipRelation(coreDb, workspaceId, callerUserId)).toBeNull();
      }
      const issued = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: callerUserId,
        scope: audience === 'nonmember administrator' ? 'server-admin' : 'workspace',
        workspaceIds: audience === 'nonmember administrator' ? [] : [workspaceId],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const firstRequestId = '0190f4c8-0000-7000-8000-000000000751';
      const started = await task(firstRequestId, issued.secret);
      expect(started.status).toBe(202);
      const caller = StartTaskModeResponseSchema.parse(await started.json()).turn;
      const first = native.executionFor(caller.id);
      await first.launched.promise;
      await native.waitForStartup(native.executor.nativeLineage!.turnId);
      const firstPackage = native.workerControlGateway.authenticatePackageToken(
        `Bearer ${native.executor.capabilityToken}`,
        { tokenFamily: 'capability' }
      );
      expect(firstPackage.scope).toMatchObject({
        workspaceId,
        threadId,
        turnId: caller.id,
        triggerActor: { kind: 'user', id: callerUserId },
      });
      expect(
        findSchedulerAdmissionForTurn(coreDb, { workspaceId, threadId, turnId: caller.id })
          ?.serverAdminTokenId
      ).toBe(audience === 'nonmember administrator' ? issued.tokenId : null);
      const callerCommand = commands.mock.calls.find(
        ([command]) => command.operation === 'turn.start'
      )![0];
      const threads = await Promise.all(
        ['peer', 'restricted', 'withdrawn', 'foreign'].map((name) =>
          store.createThread(workspaceId, name, undefined, 'conversation', {
            visibility: 'workspace',
          })
        )
      );
      // These peer bindings are unstarted Core inputs. No private history or native execution is admitted.
      const sessions: ReturnType<typeof store.getAgentSession>[] = [];
      for (const thread of threads) {
        const session = await store.createAgentSession({
          id: testEntityId('as', `as_native_${thread.name}`),
          agentId: 'agent_codex_host',
          workspaceId,
          threadId: thread.id,
          status: 'initializing',
          message: 'native-state-canary credential-canary',
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        sessions.push(session);
      }
      const bindingInputs = sessions.map((session, index) => ({
        agentSessionCompatibilityKey: 'c'.repeat(64),
        agentSessionId: session.id,
        agentSessionRuntimeBindingId: `binding_${threads[index]!.name}`,
        effectiveSetupGeneration: 1,
        harnessInstanceId: index === 3 ? 'harness_foreign' : callerCommand.harnessInstanceId,
        workspaceId,
        threadId: threads[index]!.id,
        timestamp,
      }));
      for (const binding of bindingInputs.slice(0, 3))
        openNanoHostAgentSessionBinding(coreDb, binding);
      const [peerSession, , withdrawnSession, foreignSession] = sessions as [
        (typeof sessions)[number],
        (typeof sessions)[number],
        (typeof sessions)[number],
        (typeof sessions)[number],
      ];
      for (let index = 0; index < 3; index += 1) {
        const history = await store.createTurn(
          workspaceId,
          threads[0]!.id,
          'Earlier work',
          actor,
          null,
          {
            startedAt: `2026-09-29T00:00:0${index}.000Z`,
            triggerSource: { kind: 'user-input', summary: 'Earlier work' },
          }
        );
        await store.completeTurn(history.id, { status: 'completed', completedAt: timestamp });
      }
      const peer = await store.createTurn(workspaceId, threads[0]!.id, 'Read peers', actor, null, {
        startedAt: timestamp,
        triggerSource: { kind: 'user-input', summary: 'Read peers' },
      });
      // Preparing Core correlation is real; no native start or ready proof is supplied for this peer.
      await store.updateTurn(peer.id, {
        agentId: 'agent_codex_host',
        agentSessionId: peerSession.id,
      });
      expect(store.getTurnById(peer.id).agentSessionId).toBe(peerSession.id);
      const itemFields = {
        owner: peer.owner,
        threadId: peer.threadId,
        turnId: peer.id,
        status: 'completed' as const,
        createdAt: timestamp,
        completedAt: timestamp,
      };
      await store.createItem({
        ...itemFields,
        id: testEntityId('it', 'it_peer_plan'),
        type: 'plan',
        title: 'Product plan',
        summary: null,
        steps: [],
      });
      await store.createItem({
        ...itemFields,
        id: testEntityId('it', 'it_peer_tool'),
        type: 'tool-call',
        tool: 'test',
        server: null,
        arguments: null,
        result: 'Product tool summary',
        error: null,
        durationMs: 1,
      });
      await store.createItem({
        ...itemFields,
        id: testEntityId('it', 'it_peer_status'),
        type: 'status',
        title: 'Product status',
        summary: null,
        level: 'info',
      });
      for (let index = 0; index < 23; index += 1) {
        await store.createItem({
          ...itemFields,
          id: testEntityId('it', `it_peer_${String(index).padStart(2, '0')}`),
          createdAt: `2026-09-30T00:00:${String(index).padStart(2, '0')}.000Z`,
          type: 'assistant-message',
          text: `Product message ${index}`,
        });
      }
      await store.createItem({
        ...itemFields,
        id: testEntityId('it', 'it_peer_reasoning'),
        type: 'reasoning',
        summary: [],
        content: ['restricted-evidence-canary'],
      });
      const protectedTurn = await store.createTurn(
        workspaceId,
        threads[1]!.id,
        'Protected current source',
        actor,
        null,
        { startedAt: timestamp }
      );
      await store.createItem({
        ...itemFields,
        id: testEntityId('it', 'restricted_peer_source'),
        threadId: protectedTurn.threadId,
        turnId: protectedTurn.id,
        type: 'assistant-message',
        text: 'current-audience-content-canary',
      });
      const queued = await store.createTurn(
        workspaceId,
        threads[2]!.id,
        'Queued work',
        actor,
        null,
        { status: 'pending' }
      );
      const rawEvidence = Buffer.from('restricted-raw-canary credential-canary');
      retainWorkObservationBody(workspaceDb, {
        bundleId: 'evidence_peer_private',
        threadId: peer.threadId,
        turnId: peer.id,
        createdAt: timestamp,
        sha256: createHash('sha256').update(rawEvidence).digest('hex'),
        bytes: rawEvidence,
      });
      const questions = [
        {
          id: 'peer_question',
          header: 'Peer',
          question: 'Which next step?',
          options: null,
          isOther: false,
          isSecret: false,
        },
      ];
      const requestId = '00000000-0000-4000-8000-000000000255';
      const requestItemId = testEntityId('it', 'peer_pending');
      await raiseRecordedPendingRequest(
        store,
        workspaceDb.sqlite,
        {
          requestId,
          workspaceId,
          threadId: peer.threadId,
          raisingTurnId: peer.id,
          requestItemId,
          kind: 'user-input',
          requesterKind: 'person',
          responsibleUserId: actor.id,
          questions,
          now: timestamp,
        },
        {
          ...itemFields,
          id: requestItemId,
          type: 'user-input-request',
          responsibleUserId: actor.id,
          userInputRequestId: requestId,
          prompt: 'Keep this pending.',
          questions,
        }
      );
      await client.connect(transport());
      // Core product and binding readers own this read-only predicate; no layout file is canonical.
      const before = {
        turns: threads.flatMap((thread) => store.listThreadTurns(workspaceId, thread.id)),
        threads: threads.map((thread) => store.getThread(workspaceId, thread.id)),
        revisions: store
          .listWorkspaceItemRevisions(workspaceId)
          .filter((item) => threads.some((thread) => thread.id === item.threadId)),
        events: threads.flatMap((thread) =>
          store
            .listThreadTurns(workspaceId, thread.id)
            .map((turn) => store.getTurnEventsForExport(turn.id))
        ),
        requests: listThreadPendingRequests(workspaceDb.sqlite, workspaceId, peer.threadId),
        sessions: sessions.map((session) => store.getAgentSession(session.id)),
        bindings: threads.map((thread) =>
          readNanoHostThreadAgentSessionBinding(coreDb, { workspaceId, threadId: thread.id })
        ),
        commands: commands.mock.calls.length,
        effects: native.effects.length,
      };
      expect(before.requests).toHaveLength(1);
      expect(before.bindings).toEqual(
        sessions.map((session, index) => (index === 3 ? null : { agentSessionId: session.id }))
      );
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual([
        operationToolName('automation.event-admit'),
        operationToolName('knowledge.ask'),
        operationToolName('knowledge.tell'),
        'work_input_request',
        'work_peer_list',
        'work_peer_read',
        'work_source_read',
        'work_source_search',
        'work_source_view',
        'work_artifact_submit',
      ]);
      const sourceSchema = tools.find((tool) => tool.name === 'work_source_read')!.inputSchema;
      expect(sourceSchema.required).toEqual(['path']);
      expect(sourceSchema.additionalProperties).not.toBe(false);
      const searchSchema = tools.find((tool) => tool.name === 'work_source_search')!.inputSchema;
      expect(searchSchema.required).toEqual(['path', 'query']);
      expect(searchSchema.additionalProperties).not.toBe(false);
      const viewSchema = tools.find((tool) => tool.name === 'work_source_view')!.inputSchema;
      expect(viewSchema.required).toEqual(['path']);
      expect(viewSchema.additionalProperties).not.toBe(false);
      const readSchema = tools.find((tool) => tool.name === 'work_peer_read')!.inputSchema;
      expect(readSchema.required).toEqual(['handle']);
      expect(readSchema.additionalProperties).not.toBe(false);
      const listed = await client.callTool({
        name: 'work_peer_list',
        arguments: {
          future: 'additive-canary',
          agentSessionId: foreignSession.id,
          requestId: '00000000-0000-4000-8000-000000000256',
          prompt: 'additive-canary',
          questions: [
            {
              id: 'ignored',
              header: 'Ignored',
              question: 'additive-canary',
              options: null,
              isOther: false,
              isSecret: true,
            },
          ],
        },
      });
      expect(listed.isError).toBe(false);
      const peers = listed.structuredContent!.peers as Array<Record<string, unknown>>;
      expect(peers).toHaveLength(3);
      const readable = peers.find((entry) => entry.title === 'peer')!;
      expect(readable).toMatchObject({
        agentId: 'agent_codex_host',
        runtime: 'codex',
        activeTurn: true,
      });
      expect(peers.find((entry) => entry.title === 'withdrawn')).toMatchObject({
        activeTurn: true,
      });
      expect(store.getTurnById(queued.id).status).toBe('pending');
      expect(peers.map((entry) => entry.title).sort()).toEqual(['peer', 'restricted', 'withdrawn']);
      expect(JSON.stringify(listed)).not.toMatch(/as_native_|binding_|additive-canary/);
      expect(JSON.stringify(listed)).not.toContain(firstPackage.scope.agentSessionId);
      const callsBefore = new Set(
        listWorkspaceCapabilityCalls(workspaceDb, workspaceId).map((call) => call.id)
      );
      const defaultRead = await client.callTool({
        name: 'work_peer_read',
        arguments: { handle: readable.handle },
      });
      expect(defaultRead.structuredContent!.items).toHaveLength(20);
      const read = await client.callTool({
        name: 'work_peer_read',
        arguments: { handle: readable.handle, limit: 2, future: 'additive-canary' },
      });
      expect(read.structuredContent).toMatchObject({
        turns: [
          { id: peer.id, status: 'running', triggerSource: { kind: 'user-input' } },
          { status: 'completed' },
        ],
        items: [{ id: testEntityId('it', 'it_peer_22') }, { id: testEntityId('it', 'it_peer_21') }],
        nextCursor: '2',
      });
      expect(
        (read.structuredContent!.turns as Array<Record<string, unknown>>).every(
          (turn) => !('items' in turn)
        )
      ).toBe(true);
      const next = await client.callTool({
        name: 'work_peer_read',
        arguments: { handle: readable.handle, cursor: '2', limit: 50 },
      });
      expect(
        (next.structuredContent!.items as Array<{ type: string }>).map((item) => item.type)
      ).toEqual(expect.arrayContaining(['assistant-message', 'plan', 'tool-call', 'status']));
      expect(next.structuredContent!.nextCursor).toBeNull();
      expect(JSON.stringify([read, next])).not.toMatch(
        /agentSessionId|as_native_|native-state-canary|restricted-evidence-canary|restricted-raw-canary|additive-canary|credential/
      );
      for (const session of sessions)
        expect(JSON.stringify([listed, read, next])).not.toContain(session.id);
      expect(JSON.stringify([listed, read, next])).not.toContain(callerCommand.harnessInstanceId);
      for (const handle of [peerSession.id, 'fabricated-peer-handle']) {
        await expect(
          client.callTool({ name: 'work_peer_read', arguments: { handle } })
        ).rejects.toMatchObject({ data: { code: 'peer_not_found' } });
      }
      const readCalls = listWorkspaceCapabilityCalls(workspaceDb, workspaceId).filter(
        (call) => !callsBefore.has(call.id)
      );
      expect(readCalls).toHaveLength(5);
      expect(readCalls.filter((call) => call.status === 'succeeded')).toHaveLength(3);
      expect(readCalls.filter((call) => call.status === 'failed')).toHaveLength(2);
      expect(
        readCalls.every(
          (call) =>
            call.turnId === caller.id &&
            call.agentSessionId === firstPackage.scope.agentSessionId &&
            call.packageSnapshotId === firstPackage.snapshotId
        )
      ).toBe(true);
      for (const argumentsOverride of [
        { handle: '' },
        { handle: 1 },
        { cursor: '-1' },
        { cursor: '01' },
        { cursor: 'not-a-cursor' },
        { limit: 0 },
        { limit: 51 },
        { limit: 1.5 },
      ]) {
        await expect(
          client.callTool({
            name: 'work_peer_read',
            arguments: { handle: readable.handle, ...argumentsOverride },
          })
        ).rejects.toMatchObject({ data: { code: 'mcp-call-failed' } });
      }
      expect(JSON.stringify(listWorkspaceCapabilityCalls(workspaceDb, workspaceId))).not.toContain(
        'additive-canary'
      );
      const after = {
        turns: threads.flatMap((thread) => store.listThreadTurns(workspaceId, thread.id)),
        threads: threads.map((thread) => store.getThread(workspaceId, thread.id)),
        revisions: store
          .listWorkspaceItemRevisions(workspaceId)
          .filter((item) => threads.some((thread) => thread.id === item.threadId)),
        events: threads.flatMap((thread) =>
          store
            .listThreadTurns(workspaceId, thread.id)
            .map((turn) => store.getTurnEventsForExport(turn.id))
        ),
        requests: listThreadPendingRequests(workspaceDb.sqlite, workspaceId, peer.threadId),
        sessions: sessions.map((session) => store.getAgentSession(session.id)),
        bindings: threads.map((thread) =>
          readNanoHostThreadAgentSessionBinding(coreDb, { workspaceId, threadId: thread.id })
        ),
        commands: commands.mock.calls.length,
        effects: native.effects.length,
      };
      expect(after).toEqual(before);
      first.completion.resolve();
      await first.execution;
      const replay = await task(firstRequestId, issued.secret);
      expect(replay.status).toBe(202);
      expect(StartTaskModeResponseSchema.parse(await replay.json()).turn.id).toBe(caller.id);
      expect(store.getTurnById(caller.id).status).toBe('completed');
      const later = await task('0190f4c8-0000-7000-8000-000000000752', issued.secret);
      expect(later.status).toBe(202);
      const successor = StartTaskModeResponseSchema.parse(await later.json()).turn;
      expect(successor.id).not.toBe(caller.id);
      const second = native.executionFor(successor.id);
      await second.launched.promise;
      await native.waitForStartup(native.executor.nativeLineage!.turnId);
      const target = recordTestNativeRuntimeTarget(coreDb);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: 'test',
        harnessBindingRef: 'harness_binding_foreign',
        harnessCompatibilityKey: 'b'.repeat(64),
        harnessInstanceId: 'harness_foreign',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: target.physicalEpoch!,
        sandboxBindingRef: 'sandbox_binding_foreign',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration_foreign',
        sandboxRuntimeId: 'sandbox_foreign',
        runtimeTargetId: target.targetId,
        timestamp,
      });
      openNanoHostAgentSessionBinding(coreDb, bindingInputs[3]!);
      expect(
        readNanoHostThreadAgentSessionBinding(coreDb, {
          workspaceId,
          threadId: threads[3]!.id,
        })
      ).toEqual({ agentSessionId: foreignSession.id });
      const beforeAudience = {
        ...before,
        bindings: threads.map((thread) =>
          readNanoHostThreadAgentSessionBinding(coreDb, { workspaceId, threadId: thread.id })
        ),
        commands: commands.mock.calls.length,
        effects: native.effects.length,
      };
      expect(native.executor.launches).toBe(2);
      await laterClient.connect(transport());
      await expect(
        laterClient.callTool({ name: 'work_peer_read', arguments: { handle: readable.handle } })
      ).rejects.toMatchObject({ data: { code: 'peer_not_found' } });
      const laterPeers = (await laterClient.callTool({ name: 'work_peer_list', arguments: {} }))
        .structuredContent!.peers as Array<Record<string, unknown>>;
      const laterPeer = laterPeers.find((entry) => entry.title === 'peer')!;
      expect(laterPeer).toMatchObject({
        agentId: 'agent_codex_host',
        runtime: 'codex',
        activeTurn: true,
      });
      expect(laterPeer.handle).not.toBe(readable.handle);
      const currentPackage = native.workerControlGateway.authenticatePackageToken(
        `Bearer ${native.executor.capabilityToken}`,
        { tokenFamily: 'capability' }
      );
      expect(currentPackage.scope.agentSessionId).toBe(firstPackage.scope.agentSessionId);
      expect(currentPackage.scope.turnId).toBe(successor.id);
      expect(currentPackage.snapshotId).not.toBe(firstPackage.snapshotId);
      expect(
        findSchedulerAdmissionForTurn(coreDb, { workspaceId, threadId, turnId: successor.id })
          ?.serverAdminTokenId
      ).toBe(audience === 'nonmember administrator' ? issued.tokenId : null);
      expect(laterPeers).toHaveLength(3);
      expect(laterPeers.some((entry) => entry.title === 'foreign')).toBe(false);
      await expect(
        laterClient.callTool({ name: 'work_peer_read', arguments: { handle: foreignSession.id } })
      ).rejects.toMatchObject({ data: { code: 'peer_not_found' } });
      expect(laterPeers.filter((entry) => !('title' in entry))).toHaveLength(0);
      expect(JSON.stringify(laterPeers)).not.toContain(firstPackage.scope.agentSessionId);
      expect(
        (
          await laterClient.callTool({
            name: 'work_peer_read',
            arguments: { handle: laterPeer.handle, cursor: '1', limit: 1 },
          })
        ).structuredContent!.items
      ).toHaveLength(1);
      const boundary = {
        id: 'peer-current-boundary',
        kind: 'managed-boundary' as const,
        author: { kind: 'human' as const, id: actor.id },
        authority: { kind: 'human' as const, userId: actor.id },
        authoredAt: timestamp,
        state: 'active' as const,
        scope: {
          subjects: [],
          actions: [],
          resources: [
            {
              kind: 'container' as const,
              container: { owner: peer.owner, kind: 'thread' as const, id: threads[1]!.id },
            },
          ],
        },
        lifetime: { anchor: { owner: peer.owner, kind: 'workspace' as const, id: workspaceId } },
      };
      const replacement = { schemaVersion: 1 as const, statements: [boundary] };
      expect(
        (
          await laterClient.callTool({
            name: 'work_peer_read',
            arguments: { handle: laterPeers.find((entry) => entry.title === 'restricted')!.handle },
          })
        ).structuredContent!.items
      ).toEqual([expect.objectContaining({ text: 'current-audience-content-canary' })]);
      // Authored Policy is a prepared reader input, not an administrative command under test.
      const files = new RuntimeConfigFileService({
        dataRoot,
        workspaceIds: [workspaceId],
        userId: actor.id,
        runtimeConfigManager: manager,
        readRuntimeConfigStatus: () => manager.status(),
      });
      const configId = `workspaces/${workspaceId}/workspace.jsonc`;
      const configFile = files.readFile(configId);
      const config = WorkspaceConfigSchema.parse(parse(configFile.content));
      const mediation = {
        ...replacement,
        statements: [...(config.workspace.policy?.mediation.statements ?? []), boundary],
      };
      let content = applyEdits(
        configFile.content,
        modify(configFile.content, ['workspace', 'policy', 'mediation'], mediation, {})
      );
      content = applyEdits(
        content,
        modify(
          content,
          ['requiredFeatures'],
          [...new Set([...(config.requiredFeatures ?? []), WORKSPACE_RESOURCE_POLICY_FEATURE])],
          {}
        )
      );
      files.updateFile({
        id: configId,
        kind: 'workspace',
        content,
        expectedRevision: configFile.file.revision,
      });
      expect(manager.reload({ dryRun: false, mode: 'safe' }).status).toBe('applied');
      const restricted = (await laterClient.callTool({ name: 'work_peer_list', arguments: {} }))
        .structuredContent!.peers as Array<Record<string, unknown>>;
      const restrictedHandle = laterPeers.find((entry) => entry.title === 'restricted')!.handle;
      expect(
        Object.keys(restricted.find((entry) => entry.handle === restrictedHandle)!).sort()
      ).toEqual(['agentId', 'handle', 'runtime']);
      const refusal = await laterClient
        .callTool({ name: 'work_peer_read', arguments: { handle: restrictedHandle } })
        .catch((error: unknown) => error);
      expect(refusal).toMatchObject({ data: { code: 'peer_not_found' } });
      expect(String(refusal)).not.toContain(threads[1]!.id);
      expect(String(refusal)).not.toContain('current-audience-content-canary');
      expect(
        JSON.stringify(restricted.find((entry) => entry.handle === restrictedHandle))
      ).not.toContain(threads[1]!.id);
      expect(
        JSON.stringify(restricted.find((entry) => entry.handle === restrictedHandle))
      ).not.toContain('current-audience-content-canary');
      expect({
        turns: threads.flatMap((thread) => store.listThreadTurns(workspaceId, thread.id)),
        threads: threads.map((thread) => store.getThread(workspaceId, thread.id)),
        revisions: store
          .listWorkspaceItemRevisions(workspaceId)
          .filter((item) => threads.some((thread) => thread.id === item.threadId)),
        events: threads.flatMap((thread) =>
          store
            .listThreadTurns(workspaceId, thread.id)
            .map((turn) => store.getTurnEventsForExport(turn.id))
        ),
        requests: listThreadPendingRequests(workspaceDb.sqlite, workspaceId, peer.threadId),
        sessions: sessions.map((session) => store.getAgentSession(session.id)),
        bindings: threads.map((thread) =>
          readNanoHostThreadAgentSessionBinding(coreDb, { workspaceId, threadId: thread.id })
        ),
        commands: commands.mock.calls.length,
        effects: native.effects.length,
      }).toEqual(beforeAudience);
      const withdrawnHandle = laterPeers.find((entry) => entry.title === 'withdrawn')!.handle;
      expect(
        (
          await laterClient.callTool({
            name: 'work_peer_read',
            arguments: { handle: withdrawnHandle },
          })
        ).structuredContent!.turns
      ).toEqual([expect.objectContaining({ id: queued.id, status: 'pending' })]);
      // Deliberately lose only this valid, unstarted Core binding; no physical close is claimed.
      coreDb.sqlite.transaction(() => {
        const { changes } = coreDb.sqlite
          .prepare(`DELETE FROM agent_session_runtime_bindings
            WHERE agent_session_runtime_binding_id = ? AND agent_session_id = ?
              AND workspace_id = ? AND thread_id = ?
              AND lifecycle_state = 'opening' AND native_environment_applied = 0
              AND current_turn_id IS NULL AND current_attempt_id IS NULL`)
          .run('binding_withdrawn', withdrawnSession.id, workspaceId, threads[2]!.id);
        expect(changes).toBe(1);
      })();
      expect(
        readNanoHostThreadAgentSessionBinding(coreDb, { workspaceId, threadId: threads[2]!.id })
      ).toBeNull();
      await expect(
        laterClient.callTool({ name: 'work_peer_read', arguments: { handle: withdrawnHandle } })
      ).rejects.toMatchObject({ data: { code: 'peer_not_found' } });
      expect(
        (
          await laterClient.callTool({
            name: 'work_peer_read',
            arguments: { handle: laterPeer.handle, limit: 1 },
          })
        ).structuredContent!.items
      ).toHaveLength(1);
      expect(store.getTurnById(successor.id).status).toBe('running');
      await store.createItem({
        ...itemFields,
        id: testEntityId('it', 'it_peer_oversized'),
        createdAt: '2026-09-30T01:00:00.000Z',
        type: 'assistant-message',
        text: 'x'.repeat(524_288),
      });
      await expect(
        laterClient.callTool({ name: 'work_peer_read', arguments: { handle: laterPeer.handle } })
      ).rejects.toMatchObject({
        data: { code: 'mcp-result-too-large' },
        message: expect.stringContaining('Route bulk output through artifacts or the data plane.'),
      });
    } finally {
      await Promise.allSettled([client.close(), laterClient.close()]);
      native.executor.completion.resolve();
      for (const turn of store.listThreadTurns(workspaceId, threadId))
        native.executionFor(turn.id).completion.resolve();
      const closeouts = await Promise.allSettled(
        taskAdmissions.mock.results
          .filter((result) => result.type === 'return')
          .map((result) => result.value.closeout)
      );
      commands.mockRestore();
      taskAdmissions.mockRestore();
      await native.restore();
      await workerMcpGateway.close();
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
      expect.soft(closeouts.filter((result) => result.status === 'rejected')).toEqual([]);
    }
  });

  it('keeps a tracking server schema fixed within a Turn and refreshes it on the next Turn', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-mcp-turn-schema-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const threadId = 'th_00000000-0000-7000-8000-000000000001';
    const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: actor.id, workspaceId });
    const catalog = {
      schemaVersion: 1 as const,
      servers: [
        {
          id: 'echo',
          enabled: true,
          allowedTools: ['echo', 'review-echo'],
          credentialBindings: [],
          pinnedSchemaSnapshotId: null,
          schemaPolicy: 'tracking' as const,
          timeoutMs: 2_000,
          transport: {
            kind: 'stdio' as const,
            command: process.execPath,
            args: [],
            environment: {},
          },
        },
      ],
    };
    const setup = createTestAgentSetup({
      mcpIds: ['echo'],
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    const original = [mcpEchoTool(), { ...mcpEchoTool(), name: 'review-echo' }];
    const changed = [
      {
        name: 'echo',
        inputSchema: {
          type: 'object',
          properties: { count: { type: 'integer' } },
          required: ['count'],
          additionalProperties: false,
        },
      },
    ];
    let tools: Array<{ inputSchema: Record<string, unknown>; name: string }> = original;
    const workerMcpGateway = {
      callTool: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'called' }] })),
      listTools: vi.fn(async () => ({ tools, serverVersion: '1' })),
      close: vi.fn(async () => undefined),
      closeServer: vi.fn(async () => undefined),
      closeServerIfIdle: vi.fn(async () => undefined),
      closeWorkspace: vi.fn(async () => undefined),
      getServerHealth: vi.fn(() => 'inactive' as const),
    } satisfies WorkerMcpGateway;
    const runtimeConfig = createInMemoryRuntimeConfigSnapshot({
      dataRoot,
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Schema fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      workspaceConfigs: loadRuntimeConfig(dataRoot).workspaceConfigs,
      agentManifests: [setup.manifest],
      workspaceMcpServerCatalogs: [
        {
          catalog,
          path: join(dataRoot, 'catalog.json'),
          workspaceId,
        },
      ],
    });
    runtimeConfig.openKitConfig.policy = {
      ...runtimeConfig.openKitConfig.policy,
      mediation: admitTestMcpApproval({
        coreDb,
        workspaceId,
        serverId: 'echo',
        toolName: 'review-echo',
        userId: actor.id,
        threadId,
        turnId: testEntityId('tu', 'schema-mcp-policy'),
      }),
    };
    const native = createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig: () => runtimeConfig,
    });
    admitTestNativeEnvironment(coreDb, setup.manifest);
    const taskApp = createApp({
      coreDb,
      store,
      workerMcpGateway,
      fileAdmission: native.fileAdmission,
      turnExecutor: native.executor,
      workerControlGateway: native.workerControlGateway,
      runtimeConfigManager: createRuntimeConfigManager({
        dataRoot: null,
        initialSnapshot: runtimeConfig,
      }),
    });
    const task = (requestId: string) =>
      taskApp.request(
        ...operationRequest(
          'task.start',
          { workspaceId, threadId },
          {
            body: JSON.stringify({ input: 'Use current MCP schema', requestId }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
    const taskAdmissions = vi.spyOn(productTurnStart, 'observeTurnAdmission');
    let capabilityToken = '';
    const register = () => {
      const app = new Hono();
      registerWorkerMcpRoutes({
        app,
        coreDb,
        runtimeConfig: () => runtimeConfig,
        store,
        workerMcpGateway,
        workerControlGateway: native.workerControlGateway,
        workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      });
      return app;
    };
    let app = register();
    let requestId = 0;
    const request = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await app.request('/api/worker-capabilities/mcp/echo', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${capabilityToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    try {
      const firstRequestId = '0190f4c8-0000-7000-8000-000000000731';
      const started = await task(firstRequestId);
      expect(started.status, await started.clone().text()).toBe(202);
      const firstTurn = StartTaskModeResponseSchema.parse(await started.json()).turn;
      const first = native.executionFor(firstTurn.id);
      await first.launched.promise;
      await native.waitForStartup(native.executor.nativeLineage!.turnId);
      capabilityToken = native.executor.capabilityToken;
      let environmentPackage = native.workerControlGateway.authenticatePackageToken(
        `Bearer ${capabilityToken}`,
        { tokenFamily: 'capability' }
      );
      const firstTurnId = firstTurn.id;
      expect(environmentPackage.scope).toMatchObject({
        workspaceId,
        threadId,
        turnId: firstTurnId,
      });
      expect(await request('tools/list')).toMatchObject({ result: { tools: original } });
      const pending = await request('tools/call', {
        name: 'review-echo',
        arguments: { message: 'captured approval' },
      });
      expect(pending).toMatchObject({
        result: { isError: true, structuredContent: { status: 'pending-approval' } },
      });
      expect(workerMcpGateway.callTool).not.toHaveBeenCalled();
      const currentSchemaDb = openWorkspaceDb(dataRoot, workspaceId);
      try {
        const record = readPendingRequest(
          currentSchemaDb.sqlite,
          pending.result.structuredContent.requestId
        )!;
        expect(
          evaluateCapturedPendingCall({
            manifest: setup.manifest,
            catalog,
            coreDb,
            record,
            sqlite: currentSchemaDb.sqlite,
          }).schemaCurrent
        ).toBe(true);
        tools = changed;
        expect(
          await request('tools/call', { name: 'echo', arguments: { message: 'original' } })
        ).toMatchObject({ result: { content: [{ text: 'called' }] } });
        expect(
          readCurrentMcpToolSchemaSnapshot({
            catalogEntryId: 'echo',
            pinnedSchemaSnapshotId: null,
            workspaceDb: currentSchemaDb,
            workspaceId,
          })?.tools
        ).toEqual(changed);
        expect(
          evaluateCapturedPendingCall({
            manifest: setup.manifest,
            catalog,
            coreDb,
            record,
            sqlite: currentSchemaDb.sqlite,
          }).schemaCurrent
        ).toBe(false);
      } finally {
        currentSchemaDb.sqlite.close();
      }
      expect(await request('tools/call', { name: 'echo', arguments: { count: 1 } })).toMatchObject({
        error: { data: { code: 'mcp-invalid-arguments' } },
      });
      expect(workerMcpGateway.callTool).toHaveBeenCalledTimes(1);
      // Route reconstruction loses process-local state but must keep the Turn selection.
      app = register();
      expect(await request('tools/list')).toMatchObject({ result: { tools: original } });
      first.completion.resolve();
      await first.execution;
      expect(store.getTurnById(firstTurnId).status).toBe('completed');
      const replay = await task(firstRequestId);
      expect(replay.status, await replay.clone().text()).toBe(202);
      expect(StartTaskModeResponseSchema.parse(await replay.json()).turn.id).toBe(firstTurnId);
      expect(native.executor.launches).toBe(1);
      const next = await task('0190f4c8-0000-7000-8000-000000000732');
      expect(next.status, await next.clone().text()).toBe(202);
      const secondTurn = StartTaskModeResponseSchema.parse(await next.json()).turn;
      expect(secondTurn.id).not.toBe(firstTurnId);
      const second = native.executionFor(secondTurn.id);
      await second.launched.promise;
      await native.waitForStartup(native.executor.nativeLineage!.turnId);
      capabilityToken = native.executor.capabilityToken;
      environmentPackage = native.workerControlGateway.authenticatePackageToken(
        `Bearer ${capabilityToken}`,
        { tokenFamily: 'capability' }
      );
      expect(environmentPackage.scope).toMatchObject({
        workspaceId,
        threadId,
        turnId: secondTurn.id,
      });
      expect(native.executor.launches).toBe(2);
      expect(await request('tools/list')).toMatchObject({ result: { tools: changed } });
      expect(await request('tools/call', { name: 'echo', arguments: { count: 1 } })).toMatchObject({
        result: { content: [{ text: 'called' }] },
      });
      expect(
        await request('tools/call', { name: 'echo', arguments: { message: 'obsolete' } })
      ).toMatchObject({ error: { data: { code: 'mcp-invalid-arguments' } } });
      expect(workerMcpGateway.callTool).toHaveBeenCalledTimes(2);
      const db = openWorkspaceDb(dataRoot, workspaceId);
      try {
        const bindings = listWorkspaceCapabilityCalls(db, workspaceId).filter(
          (call) => call.family === 'mcp' && call.providerRef === 'echo'
        );
        const references: string[] = [];
        for (const [turnId, expected] of [
          [firstTurnId, original],
          [environmentPackage.scope.turnId, changed],
        ] as const) {
          const ids = bindings
            .filter((row) => row.turnId === turnId)
            .map((row) => row.schemaSnapshotId);
          expect(ids.length).toBeGreaterThan(0);
          expect(new Set(ids).size).toBe(1);
          const schemaSnapshotId = ids[0]!;
          expect(schemaSnapshotId).toEqual(expect.any(String));
          references.push(schemaSnapshotId);
          expect(
            readRetainedMcpToolSchemaSnapshot({
              workspaceDb: db,
              workspaceId,
              catalogEntryId: 'echo',
              schemaSnapshotId,
            })
          ).toEqual({ schemaSnapshotId, tools: expected });
        }
        expect(new Set(references).size).toBe(2);
        const prior = bindings.find(
          (row) => row.turnId === environmentPackage.scope.turnId && row.schemaSnapshotId !== null
        )!;
        // Corrupt only an owner-created retained header after both live schema checks pass.
        db.sqlite
          .prepare(
            'UPDATE capability_calls SET schema_version = 2, extensions_json = ? WHERE call_id = ?'
          )
          .run('{', prior.id);
        const retainedCall = db.sqlite
          .prepare('SELECT * FROM capability_calls WHERE call_id = ?')
          .get(prior.id);
        const retainedSchemas = listExportableMcpToolSchemaSnapshots(db, workspaceId);
        const contacts = vi.mocked(workerMcpGateway.listTools).mock.calls.length;
        expect(await request('tools/list')).toHaveProperty('error');
        expect(workerMcpGateway.listTools).toHaveBeenCalledTimes(contacts);
        expect(
          db.sqlite.prepare('SELECT * FROM capability_calls WHERE call_id = ?').get(prior.id)
        ).toEqual(retainedCall);
        expect(listExportableMcpToolSchemaSnapshots(db, workspaceId)).toEqual(retainedSchemas);
      } finally {
        db.sqlite.close();
      }
    } finally {
      for (const turn of store.listThreadTurns(workspaceId, threadId))
        native.executionFor(turn.id).completion.resolve();
      await Promise.allSettled(
        taskAdmissions.mock.results
          .filter((result) => result.type === 'return')
          .map((result) => result.value.closeout)
      );
      taskAdmissions.mockRestore();
      await native.restore();
      await workerMcpGateway.close();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'revocation',
    'lineage',
  ] as const)('uses the admitted admin bearer for nonmember tool calls and denies revocation or lineage drift: %s', async (fault) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-admin-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const threadId = 'th_00000000-0000-7000-8000-000000000001';
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId,
    });
    const baseUrl = 'http://127.0.0.1:3000';
    const auth = createBetterAuth(coreDb, {
      mode: 'server',
      env: {
        BETTER_AUTH_URL: baseUrl,
        BETTER_AUTH_SECRET: randomUUID(),
      },
    });
    const catalog = {
      schemaVersion: 1 as const,
      servers: [
        {
          allowedTools: ['echo'],
          credentialBindings: [],
          enabled: true,
          id: 'echo',
          pinnedSchemaSnapshotId: null,
          schemaPolicy: 'tracking' as const,
          timeoutMs: 2_000,
          transport: {
            args: [fileURLToPath(new URL('./test-support/mcp-stdio-stub.mjs', import.meta.url))],
            command: process.execPath,
            environment: {},
            kind: 'stdio' as const,
          },
        },
      ],
    };
    const setup = createTestAgentSetup({
      mcpIds: ['echo'],
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    const runtimeConfig = createInMemoryRuntimeConfigSnapshot({
      dataRoot,
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Admin fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      workspaceConfigs: loadRuntimeConfig(dataRoot).workspaceConfigs,
      agentManifests: [setup.manifest],
      workspaceMcpServerCatalogs: [
        { catalog, path: join(dataRoot, 'catalog/catalog.json'), workspaceId },
      ],
    });
    const native = createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig: () => runtimeConfig,
    });
    admitTestNativeEnvironment(coreDb, setup.manifest);
    const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
    const callTool = vi.spyOn(workerMcpGateway, 'callTool');
    const app = createApp({
      auth,
      coreDb,
      store,
      mode: 'server',
      workerMcpGateway,
      fileAdmission: native.fileAdmission,
      turnExecutor: native.executor,
      workerControlGateway: native.workerControlGateway,
      runtimeConfigManager: createRuntimeConfigManager({
        dataRoot: null,
        initialSnapshot: runtimeConfig,
      }),
    });
    const task = (secret: string, requestId: string) => {
      const [path, init] = operationRequest(
        'task.start',
        { workspaceId, threadId },
        {
          headers: { authorization: `Bearer ${secret}` },
          body: JSON.stringify({ input: 'Call MCP as admin', requestId }),
        }
      );
      return app.request(new URL(path, baseUrl).toString(), init);
    };
    const transport = (serverId: string) =>
      new StreamableHTTPClientTransport(
        new URL(`/api/worker-capabilities/mcp/${serverId}`, baseUrl),
        {
          fetch: (input, init) => app.fetch(new Request(input, init)),
          requestInit: { headers: { authorization: `Bearer ${native.executor.capabilityToken}` } },
        }
      );
    const client = new Client({ name: 'admin-route-test', version: '1.0.0' });
    const generativeClient = new Client({ name: 'admin-generative-route-test', version: '1.0.0' });
    const lineageClient = new Client({ name: 'admin-lineage-route-test', version: '1.0.0' });
    const taskAdmissions = vi.spyOn(productTurnStart, 'observeTurnAdmission');
    const submitObservation = vi.spyOn(native.executor.executionBackend!, 'submit');
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    try {
      const registered = await auth.handler(
        new Request(`${baseUrl}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'MCP Admin',
            email: 'mcp-admin@example.invalid',
            password: randomUUID(),
          }),
        })
      );
      expect(registered.status).toBe(200);
      const { user } = (await registered.json()) as { user: { id: string } };
      expect(isCanonicalUserActive(coreDb, user.id)).toBe(true);
      expect(resolveWorkspaceMembershipRelation(coreDb, workspaceId, user.id)).toBeNull();
      const issued = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2099-01-01T00:00:00.000Z',
        ownerUserId: user.id,
        scope: 'server-admin',
        workspaceIds: [],
      });
      const started = await task(issued.secret, '0190f4c8-0000-7000-8000-000000000741');
      expect(started.status).toBe(202);
      const turn = StartTaskModeResponseSchema.parse(await started.json()).turn;
      const first = native.executionFor(turn.id);
      await first.launched.promise;
      await native.waitForStartup(native.executor.nativeLineage!.turnId);
      const environmentPackage = native.workerControlGateway.authenticatePackageToken(
        `Bearer ${native.executor.capabilityToken}`,
        { tokenFamily: 'capability' }
      );
      expect(environmentPackage.scope).toMatchObject({ workspaceId, threadId, turnId: turn.id });
      const firstAdmission = findSchedulerAdmissionForTurn(coreDb, environmentPackage.scope);
      expect(firstAdmission?.serverAdminTokenId === issued.tokenId).toBe(true);
      expect(firstAdmission?.triggerActor).toEqual({ kind: 'user', id: user.id });
      expect(resolveWorkspaceMembershipRelation(coreDb, workspaceId, user.id)).toBeNull();
      // Start this authority scenario after its own original native submit completes.
      const firstAttempt = listSchedulerExecutionAttemptsForTurn(
        coreDb,
        environmentPackage.scope
      ).find((row) => row.inputRef === environmentPackage.snapshotId && row.phase === 'open');
      expect(firstAttempt).toBeDefined();
      const submissions = submitObservation.mock.calls.flatMap(([input], index) =>
        input.attemptId === firstAttempt!.attemptId &&
        input.inputRef === environmentPackage.snapshotId
          ? [submitObservation.mock.results[index]]
          : []
      );
      expect(submissions).toHaveLength(1);
      expect(submissions[0]?.type).toBe('return');
      await submissions[0]!.value;
      await client.connect(transport('echo'));
      await generativeClient.connect(transport('openkit-generative'));
      await expect(
        client.callTool({ arguments: { message: 'admin allowed' }, name: 'echo' })
      ).resolves.toMatchObject({ content: [{ text: 'admin allowed' }] });
      await expect(
        generativeClient.callTool({ arguments: {}, name: 'kernel_apps_list' })
      ).resolves.toMatchObject({ structuredContent: { items: [] } });
      expect(callTool).toHaveBeenCalledTimes(1);
      if (fault === 'revocation') {
        const blocker = openWorkspaceDb(dataRoot, workspaceId);
        const submissions = callTool.mock.calls.length;
        try {
          // Control-store owner: genuine post-setup Main writer contention must stay a safe refusal.
          blocker.sqlite.exec('BEGIN IMMEDIATE');
          const refusal: unknown = await client
            .callTool({
              arguments: { message: 'contended admission must not reach echo' },
              name: 'echo',
            })
            .then(
              () => undefined,
              (error: unknown) => error
            );
          expect(refusal).toMatchObject({
            data: {
              code: 'operation_storage_unavailable',
              status: 503,
              message: expect.stringMatching(/inspect.*(original|request|outcome)/i),
            },
          });
          const received = refusal as { message: string; data: { message: string } };
          expect(received.message).toContain(received.data.message);
          const publicText = JSON.stringify({ message: received.message, data: received.data });
          expect(publicText).not.toContain(dataRoot);
          expect(publicText).not.toMatch(
            /SQLITE|database is locked|capability_calls|permission_decisions|audit_events|INSERT|DELETE|SELECT|not.?committed|roll.?back|safe.{0,12}retry|automatic.{0,12}retry|retry.{0,12}automatic/i
          );
          expect(callTool).toHaveBeenCalledTimes(submissions);
        } finally {
          if (blocker.sqlite.inTransaction) blocker.sqlite.exec('ROLLBACK');
          blocker.sqlite.close();
        }
        // A fresh real read observes progress after release without replaying the refused echo.
        await expect(
          generativeClient.callTool({ arguments: {}, name: 'kernel_apps_list' })
        ).resolves.toMatchObject({ structuredContent: { items: [] } });
        expect(callTool).toHaveBeenCalledTimes(submissions);
      }
      const allowed = listWorkspaceCapabilityCalls(workspaceDb, workspaceId).filter(
        (call) =>
          call.turnId === turn.id &&
          call.providerRef === 'echo' &&
          call.capabilityId === 'mcp.call-tool'
      );
      expect(allowed).toHaveLength(1);
      expect(allowed[0]).toMatchObject({
        status: 'succeeded',
        agentSessionId: environmentPackage.scope.agentSessionId,
        packageSnapshotId: environmentPackage.snapshotId,
      });
      const echoUsage = () =>
        listWorkspaceUsageRecords(workspaceDb, workspaceId).filter(
          (row) => row.providerRef === 'echo'
        );
      const usage = echoUsage();
      expect(usage.map((row) => row.responsibleUserId)).toEqual([user.id]);
      expect(usage[0]?.capabilityCallId === allowed[0]!.id).toBe(true);
      if (fault === 'revocation') {
        expect(revokeOpenKitAccessTokenRecord(coreDb, issued.tokenId)?.status).toBe('revoked');
        await expect(
          client.callTool({ arguments: { message: 'revoked' }, name: 'echo' })
        ).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
        expect(callTool).toHaveBeenCalledTimes(1);
        expect(echoUsage()).toEqual(usage);
      }
      first.completion.resolve();
      const closeouts = await Promise.allSettled(
        taskAdmissions.mock.results
          .filter((result) => result.type === 'return')
          .map((result) => result.value.closeout)
      );
      if (fault === 'revocation') {
        expect(['pending', 'running']).not.toContain(store.getTurnById(turn.id).status);
        return;
      }
      expect(closeouts.every((result) => result.status === 'fulfilled')).toBe(true);
      expect(store.getTurnById(turn.id).status).toBe('completed');
      expect(
        listSchedulerExecutionAttemptsForTurn(coreDb, environmentPackage.scope)
      ).toContainEqual(
        expect.objectContaining({
          inputRef: environmentPackage.snapshotId,
          phase: 'closed',
          disposition: 'accepted',
          fenceRef: expect.stringMatching(/\S/),
        })
      );
      const fresh = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2099-01-01T00:00:00.000Z',
        ownerUserId: user.id,
        scope: 'server-admin',
        workspaceIds: [],
      });
      const next = await task(fresh.secret, '0190f4c8-0000-7000-8000-000000000742');
      expect(next.status).toBe(202);
      const secondTurn = StartTaskModeResponseSchema.parse(await next.json()).turn;
      expect(secondTurn.id).not.toBe(turn.id);
      const second = native.executionFor(secondTurn.id);
      await second.launched.promise;
      await native.waitForStartup(native.executor.nativeLineage!.turnId);
      const secondPackage = native.workerControlGateway.authenticatePackageToken(
        `Bearer ${native.executor.capabilityToken}`,
        { tokenFamily: 'capability' }
      );
      expect(secondPackage.scope).toMatchObject({ workspaceId, threadId, turnId: secondTurn.id });
      const secondAdmission = findSchedulerAdmissionForTurn(coreDb, secondPackage.scope);
      expect(secondAdmission?.serverAdminTokenId === fresh.tokenId).toBe(true);
      expect(secondAdmission?.triggerActor).toEqual({ kind: 'user', id: user.id });
      expect(resolveWorkspaceMembershipRelation(coreDb, workspaceId, user.id)).toBeNull();
      await lineageClient.connect(transport('echo'));
      expect((await lineageClient.listTools()).tools.map((tool) => tool.name)).toContain('echo');
      const attempt = listSchedulerExecutionAttemptsForTurn(coreDb, secondPackage.scope).find(
        (row) => row.inputRef === secondPackage.snapshotId && row.phase === 'open'
      );
      expect(attempt).toBeDefined();
      // Contradict only the valid second admission's package after current discovery succeeds.
      try {
        coreDb.sqlite
          .prepare('UPDATE scheduler_execution_attempts SET input_ref = ? WHERE attempt_id = ?')
          .run(environmentPackage.snapshotId, attempt!.attemptId);
        await expect(
          lineageClient.callTool({ arguments: { message: 'mismatched' }, name: 'echo' })
        ).rejects.toSatisfy((error: unknown) => {
          expect(error).toMatchObject({ data: { status: 403 } });
          expect(JSON.parse((error as { data: { text: string } }).data.text)).toMatchObject({
            error: { data: { code: 'worker_control_lineage_mismatch' } },
          });
          return true;
        });
        expect(callTool).toHaveBeenCalledTimes(1);
        expect(echoUsage()).toEqual(usage);
      } finally {
        coreDb.sqlite
          .prepare('UPDATE scheduler_execution_attempts SET input_ref = ? WHERE attempt_id = ?')
          .run(attempt!.inputRef, attempt!.attemptId);
      }
    } finally {
      await Promise.allSettled([client.close(), generativeClient.close(), lineageClient.close()]);
      for (const turn of store.listThreadTurns(workspaceId, threadId))
        native.executionFor(turn.id).completion.resolve();
      await Promise.allSettled(
        taskAdmissions.mock.results
          .filter((result) => result.type === 'return')
          .map((result) => result.value.closeout)
      );
      taskAdmissions.mockRestore();
      submitObservation.mockRestore();
      await native.restore();
      await workerMcpGateway.close();
      workspaceDb.sqlite.close();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'unchanged',
    'deny',
    'revoke',
    'known-error',
    'unknown-effect',
    'no-contact',
    'credential-after-claim',
  ] as const)('re-evaluates current authority before granting a captured MCP call: %s', async (change) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-pending-mcp-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    let store = await createDemoStore({ dataRoot });
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const threadId = 'th_00000000-0000-7000-8000-000000000001';
    const userId = 'usr_00000000-0000-7000-8000-000000000001';
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: userId, workspaceId });
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 7) });
    vaultUnlockState.backend().store({
      material: 'pending-secret-canary',
      metadata: { ownerScope: 'workspace', workspaceId },
      referenceId: 'vault_00000000-0000-7ca0-a71c-0b929d838497',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator:
        'encrypted-file://workspace/ws_00000000-0000-7000-8000-000000000001/vault/vault_00000000-0000-7ca0-a71c-0b929d838497',
      displayName: 'Pending echo credential',
      ownerScope: 'workspace',
      referenceId: 'vault_00000000-0000-7ca0-a71c-0b929d838497',
      secretKind: 'api-key',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const publicGrant = createVaultGrant(coreDb, {
      grantId: testEntityId('grant', 'pending_echo'),
      vaultReferenceId: 'vault_00000000-0000-7ca0-a71c-0b929d838497',
      ownerScope: 'workspace',
      workspaceId,
      lifetime: 'workspace',
      allowedInjectionPaths: ['gateway-only'],
    });
    expect(publicGrant.allowedInjectionPaths).toEqual(['gateway-only']);
    expect(JSON.stringify(publicGrant)).not.toContain('pending-secret-canary');
    const catalog = {
      schemaVersion: 1 as const,
      servers: [
        {
          id: 'echo',
          enabled: true,
          allowedTools: ['echo'],
          credentialBindings: [
            {
              sink: { kind: 'env' as const, name: 'PENDING_ECHO_SECRET' },
              slot: 'auth',
              vaultGrantId: publicGrant.grantId,
            },
          ],
          pinnedSchemaSnapshotId: null,
          schemaPolicy: 'tracking' as const,
          timeoutMs: 2_000,
          transport: {
            kind: 'stdio' as const,
            command: process.execPath,
            args: [fileURLToPath(new URL('./test-support/mcp-stdio-stub.mjs', import.meta.url))],
            environment: {},
          },
        },
      ],
    };
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Agent OpenRouter',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      dataRoot,
      workspaceConfigs: loadRuntimeConfig(dataRoot).workspaceConfigs,
      agentManifests: [
        createTestAgentSetup({
          mcpIds: ['echo'],
          requiredCapabilities: ['trusted-worker-inference-relay'],
        }).manifest,
      ],
      workspaceMcpServerCatalogs: [
        {
          catalog,
          path: join(dataRoot, 'catalog.json'),
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        },
      ],
    });
    snapshot.openKitConfig.policy = {
      ...snapshot.openKitConfig.policy,
      mediation: admitTestMcpApproval({
        coreDb,
        workspaceId,
        serverId: 'echo',
        toolName: 'echo',
        userId: 'usr_00000000-0000-7000-8000-000000000001',
        threadId,
        turnId: testEntityId('tu', 'pending-mcp-policy'),
      }),
    };
    const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
    const originalCallTool = workerMcpGateway.callTool.bind(workerMcpGateway);
    const upstream = vi.spyOn(workerMcpGateway, 'callTool');
    const native = createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig: () => snapshot,
    });
    admitTestNativeEnvironment(coreDb, snapshot.agentManifests[0]!);
    const captureApp = createApp({
      coreDb,
      store,
      workerMcpGateway,
      vaultUnlockState,
      fileAdmission: native.fileAdmission,
      turnExecutor: native.executor,
      workerControlGateway: native.workerControlGateway,
      runtimeConfigManager: createRuntimeConfigManager({
        dataRoot: null,
        initialSnapshot: snapshot,
      }),
    });
    const taskRequest = operationRequest(
      'task.start',
      { workspaceId, threadId },
      {
        body: JSON.stringify({
          input: 'Call echo',
          requestId: '0190f4c8-0000-7000-8000-000000000701',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    const taskAdmissions = vi.spyOn(productTurnStart, 'observeTurnAdmission');
    const client = new Client({ name: 'pending-echo', version: '1' });
    try {
      const started = await captureApp.request(...taskRequest);
      expect(started.status, await started.clone().text()).toBe(202);
      const { turn } = StartTaskModeResponseSchema.parse(await started.json());
      await native.executor.launched.promise;
      await native.waitForStartup(native.executor.nativeLineage!.turnId);
      const environmentPackage = native.workerControlGateway.authenticatePackageToken(
        `Bearer ${native.executor.capabilityToken}`,
        { tokenFamily: 'capability' }
      );
      expect(JSON.stringify(environmentPackage)).not.toContain('pending-secret-canary');
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL('http://nanocore.test/api/worker-capabilities/mcp/echo'),
          {
            fetch: (input, init) => captureApp.fetch(new Request(input, init)),
            requestInit: {
              headers: { authorization: `Bearer ${native.executor.capabilityToken}` },
            },
          }
        )
      );
      if (change === 'unchanged') {
        const db = openWorkspaceDb(dataRoot, workspaceId);
        recordMcpToolSchemaSnapshot({
          environmentPackage,
          serverId: 'echo',
          source: 'live',
          tools: [mcpEchoTool()],
          schemaSnapshotId: 'nested-lock-schema',
          workspaceDb: db,
          workspaceId,
        });
        const before = new Set(
          listWorkspaceCapabilityCalls(db, workspaceId).map((call) => call.id)
        );
        const start = capabilityLedger.startCapabilityCall;
        let nativeFailure: unknown;
        const discoveries = vi.spyOn(workerMcpGateway, 'listTools');
        const admission = vi
          .spyOn(capabilityLedger, 'startCapabilityCall')
          .mockImplementation((input) => {
            if (input.operation !== 'mcp.list-tools') return start(input);
            expect(
              listWorkspaceCapabilityCalls(db, workspaceId).filter((call) => !before.has(call.id))
            ).toMatchObject([{ operation: 'mcp.call-tool', status: 'running' }]);
            db.sqlite.exec('BEGIN IMMEDIATE');
            try {
              return start(input);
            } catch (error) {
              nativeFailure = error;
              throw error;
            } finally {
              db.sqlite.exec('ROLLBACK');
            }
          });
        try {
          const refusal: unknown = await client
            .callTool({
              name: 'echo',
              arguments: { message: 'nested storage refusal' },
            })
            .then(
              () => undefined,
              (error: unknown) => error
            );
          expect(nativeFailure).toMatchObject({ code: 'SQLITE_BUSY' });
          expect(discoveries).not.toHaveBeenCalled();
          expect(upstream).not.toHaveBeenCalled();
          expect(
            listWorkspaceCapabilityCalls(db, workspaceId).filter((call) => !before.has(call.id))
          ).toMatchObject([
            {
              operation: 'mcp.call-tool',
              status: 'failed',
              errorCode: 'operation_storage_unavailable',
            },
          ]);
          expect(refusal).toMatchObject({
            data: {
              code: 'operation_storage_unavailable',
              status: 503,
              message: expect.stringMatching(/inspect.*(original|request|outcome)/i),
            },
          });
          const received = refusal as { message: string; data: { message: string } };
          expect(received.message).toContain(received.data.message);
          const publicText = JSON.stringify({ message: received.message, data: received.data });
          expect(publicText).not.toContain(dataRoot);
          expect(publicText).not.toMatch(
            /SQLITE|database is locked|capability_calls|INSERT|SELECT|roll.?back|not.?committed/i
          );
        } finally {
          admission.mockRestore();
          discoveries.mockRestore();
          if (db.sqlite.inTransaction) db.sqlite.exec('ROLLBACK');
          db.sqlite.close();
        }
      }
      await client.listTools();
      const pending = await client.callTool({
        name: 'echo',
        arguments: { message: 'captured effect' },
      });
      expect(pending.isError).toBe(true);
      expect(pending.structuredContent).toMatchObject({ status: 'pending-approval' });
      expect(upstream).not.toHaveBeenCalled();
      if (change === 'unchanged') {
        const boundDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
        const countCalls = () => listWorkspaceCapabilityCalls(boundDb, workspaceId).length;
        const beforeDuplicate = countCalls();
        const duplicate = await client.callTool({
          name: 'echo',
          arguments: { message: 'captured effect' },
        });
        expect(duplicate.structuredContent).toEqual(pending.structuredContent);
        expect(countCalls()).toBe(beforeDuplicate);
        for (let index = 1; index < 16; index += 1)
          expect(
            (
              await client.callTool({
                name: 'echo',
                arguments: { message: `different captured ${index}` },
              })
            ).isError
          ).toBe(true);
        const beforeLimit = countCalls();
        await expect(
          client.callTool({ name: 'echo', arguments: { message: 'seventeenth captured' } })
        ).rejects.toMatchObject({ data: { code: 'request_limit_reached' } });
        expect(countCalls()).toBe(beforeLimit);
        boundDb.sqlite.close();
      }
      if (change === 'unchanged') {
        const evidenceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
        const captured = listThreadPendingRequests(evidenceDb.sqlite, workspaceId, threadId);
        const project = (id: string, userId = 'usr_00000000-0000-7000-8000-000000000001') =>
          projectApprovalEffect({
            record: readPendingRequest(evidenceDb.sqlite, id)!,
            store,
            coreDb,
            actor: { kind: 'local', userId },
          });
        const details = captured.map((row) => project(row.requestId));
        expect(details.every((detail) => detail.status === 'available')).toBe(true);
        expect(
          new Set(details.map((detail) => detail.status === 'available' && detail.detail)).size
        ).toBe(16);
        const beforeRead = listThreadPendingRequests(evidenceDb.sqlite, workspaceId, threadId);
        project(captured[0]!.requestId);
        expect(listThreadPendingRequests(evidenceDb.sqlite, workspaceId, threadId)).toEqual(
          beforeRead
        );
        expect(JSON.stringify(details)).not.toContain('pending-secret-canary');
        expect(JSON.stringify(store.listAllItems())).not.toContain('captured effect');
        evidenceDb.sqlite.close();
      }
      expect(store.getTurnById(turn.id).status).toBe('running');
      const approvalItem = store
        .listThreadItems(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001'
        )
        .find((item) => item.type === 'approval-request');
      if (!approvalItem || approvalItem.type !== 'approval-request')
        throw new Error('Missing approval request.');
      await client.close();
      native.executor.completion.resolve();
      await native.executor.execution;
      expect(store.getTurnById(turn.id).status).toBe('completed');
      const replay = await captureApp.request(...taskRequest);
      expect(replay.status, await replay.clone().text()).toBe(202);
      expect(StartTaskModeResponseSchema.parse(await replay.json()).turn.id).toBe(turn.id);
      expect(native.executor.launches).toBe(1);
      expect(upstream).not.toHaveBeenCalled();
      await shutdownControlStoreWorkerClient();
      // Reopen real products for the response module; delivery is a separate covered owner.
      store = new FsStore({ dataRoot });
      const dependencies = { coreDb, openWorkspace: (id: string) => openWorkspaceDb(dataRoot, id) };
      installPendingRequestAdmission(store, dependencies);
      if (change === 'revoke') revokeVaultGrant(coreDb, { grantId: publicGrant.grantId });
      const resolved = vi.spyOn(vaultUnlockState.backend(), 'resolve');
      if (change === 'credential-after-claim') {
        const callTool = originalCallTool;
        upstream.mockImplementationOnce(async (input) => {
          expect(resolved).toHaveBeenCalled();
          const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
          try {
            expect(readPendingRequest(db.sqlite, approvalItem.approvalRequestId)).toMatchObject({
              claim: 'claimed',
            });
          } finally {
            db.sqlite.close();
          }
          snapshot.agentManifests.splice(0);
          return callTool(input);
        });
      }
      if (change === 'known-error' || change === 'unknown-effect' || change === 'no-contact') {
        upstream.mockRejectedValueOnce(
          new WorkerMcpGatewayCallError(
            'mcp-call-failed',
            'Synthetic captured failure.',
            502,
            change === 'known-error'
              ? 'contacted'
              : change === 'no-contact'
                ? 'not-contacted'
                : 'unknown'
          )
        );
      }
      const executed = change !== 'deny' && change !== 'revoke';
      const disposition =
        change === 'deny'
          ? 'denied-not-executed'
          : change === 'unknown-effect'
            ? 'outcome-unknown'
            : ['known-error', 'no-contact', 'revoke'].includes(change)
              ? 'execution-error'
              : 'approved-executed';
      const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
      const captured = readPendingRequest(workspaceDb.sqlite, approvalItem.approvalRequestId)!;
      let prepared: PreparedCapturedPendingCall | undefined;
      let executionCall: ReturnType<typeof admitCapturedPendingCall> | undefined;
      const context = { catalog, coreDb, workspaceDb, workerMcpGateway, record: captured };
      const respond = () =>
        respondRecordedApproval({
          store,
          sqlite: workspaceDb.sqlite,
          workspaceId,
          threadId,
          coreDb,
          approvalRequestId: captured.requestId,
          decision: change === 'deny' ? 'denied' : 'granted',
          actorId: userId,
          requestActor: { kind: 'local', userId },
          dependencies,
          prepare: async () => {
            prepared = await prepareCapturedPendingCall({
              actor: { userId },
              ...context,
              vaultBackend: () => vaultUnlockState.backend(),
              reviewPolicy: (record, actor) =>
                reviewCapturedMcpPolicy({
                  record,
                  actor,
                  workspaceDb,
                  catalog,
                  interception: new PolicyInterception(),
                  routes: {
                    coreDb,
                    store,
                    workerMcpGateway,
                    vaultUnlockState,
                    workerControlGateway: native.workerControlGateway,
                    runtimeConfig: () => snapshot,
                    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
                  },
                }),
            });
          },
          evaluate: () =>
            evaluateCapturedPendingCall({
              manifest: snapshot.agentManifests.find((row) => row.id === captured.agentId) ?? null,
              ...context,
              sqlite: workspaceDb.sqlite,
              prepared,
            }),
          admitExecution: (failure) => {
            executionCall = admitCapturedPendingCall(
              captured,
              workspaceDb,
              '00000000-0000-4000-8000-000000000117',
              prepared,
              failure
            );
            return executionCall.refusal;
          },
          execute: (record) =>
            executeCapturedPendingCall({
              ...context,
              record,
              prepared,
              executionCall,
            }),
        });
      const response = await respond();
      resolved.mockRestore();
      expect(upstream).toHaveBeenCalledTimes(executed ? 1 : 0);
      if (change === 'unchanged') {
        expect(upstream.mock.calls[0]?.[0]).toMatchObject({
          toolName: 'echo',
          arguments: { message: 'captured effect' },
          credentials: { environment: { PENDING_ECHO_SECRET: 'pending-secret-canary' } },
        });
      }
      try {
        expect(response).toMatchObject({
          state: 'resolved',
          resolution: change === 'deny' ? 'denied' : 'granted',
          disposition,
          claim: change === 'deny' ? 'unclaimed' : 'finished',
          executionCallId: change === 'deny' ? null : executionCallIdForRequest(captured.requestId),
        });
        const callId = executionCallIdForRequest(captured.requestId);
        const calls = listWorkspaceCapabilityCalls(workspaceDb, workspaceId);
        expect(calls.filter((call) => call.id === callId)).toEqual(
          change === 'deny'
            ? []
            : [
                expect.objectContaining({
                  status:
                    disposition === 'approved-executed'
                      ? 'succeeded'
                      : disposition === 'outcome-unknown'
                        ? 'unknown'
                        : 'failed',
                  ...(change === 'revoke' ? { upstreamContacted: false } : {}),
                }),
              ]
        );
        const usage = listWorkspaceUsageRecords(workspaceDb, workspaceId);
        expect(usage.filter((row) => row.capabilityCallId === callId)).toHaveLength(
          executed && change !== 'no-contact' ? 1 : 0
        );
        if (change !== 'deny')
          expect(
            listExportableWorkspacePermissionDecisions(workspaceDb, workspaceId)
          ).toContainEqual(
            expect.objectContaining({
              approvalId: captured.requestId,
              result: change === 'revoke' ? 'deny' : 'allow',
              contextSummary: expect.objectContaining({ capabilityCallId: callId }),
            })
          );
        expect(JSON.stringify(response)).not.toContain('pending-secret-canary');
        await expect(respond()).rejects.toMatchObject({ code: 'request_not_pending' });
        expect(listWorkspaceCapabilityCalls(workspaceDb, workspaceId)).toEqual(calls);
        expect(listWorkspaceUsageRecords(workspaceDb, workspaceId)).toEqual(usage);
        expect(upstream).toHaveBeenCalledTimes(executed ? 1 : 0);
        if (change === 'unchanged') {
          const scope = { workspaceDb, workspaceId, catalogEntryId: 'echo' };
          const currentId = () =>
            readCurrentMcpToolSchemaSnapshot({ ...scope, pinnedSchemaSnapshotId: null })
              ?.schemaSnapshotId;
          type Tool = { name: string; inputSchema: Record<string, unknown> };
          const tool = (v: string | number) => ({ inputSchema: { const: v }, name: 'echo' });
          const record = (id: string, tools: Tool[]) =>
            recordMcpToolSchemaSnapshot({
              environmentPackage,
              serverId: 'echo',
              source: 'live',
              schemaSnapshotId: id,
              tools,
              workspaceDb,
              workspaceId,
            });
          const retained = (id: string) =>
            readRetainedMcpToolSchemaSnapshot({ ...scope, schemaSnapshotId: id });
          const referencedId = captured.schemaSnapshotId!;
          const referenced = retained(referencedId);
          expect(referenced).not.toBeNull();
          expect(
            listExportableMcpToolSchemaSnapshots(workspaceDb, workspaceId).find(
              (row) => row.schemaSnapshotId === referencedId
            )?.source
          ).toBe('live');
          const fixedNow = vi
            .spyOn(Date, 'now')
            .mockReturnValue(Date.parse('2026-09-03T01:00:00Z'));
          try {
            for (const label of ['a', 'b', 'a']) record(`mcpsnap_${label}`, [tool(label)]);
          } finally {
            fixedNow.mockRestore();
          }
          expect(currentId()).toBe('mcpsnap_a');
          const tools = [{ inputSchema: { type: 'object' }, name: 'imported' }];
          const history = (id: string, catalogEntryId: string) => ({
            capturedAt: '2099-01-01T00:00:00.000Z',
            catalogEntryId,
            contentDigest: mcpToolSchemaContentDigest(tools),
            schemaSnapshotId: id,
            serverVersion: '1.0.0',
            source: 'aep' as const,
            sourceRef: 'aep_history',
            tools,
            workspaceId,
          });
          importMcpToolSchemaSnapshots(workspaceDb, [history('mcpsnap_imported_history', 'echo')]);
          expect(currentId()).toBe('mcpsnap_a');
          const captures = () =>
            listWorkspaceAuditEvents(workspaceDb, workspaceId).filter(
              (event) =>
                event.action === 'mcp.schema.capture' &&
                event.resource === 'mcp-schema:mcpsnap_imported_history'
            );
          const beforePromotion = captures().length;
          record('mcpsnap_imported_history', tools);
          record('mcpsnap_imported_history', tools);
          expect(captures()).toHaveLength(beforePromotion + 1);
          expect(currentId()).toBe('mcpsnap_imported_history');
          importMcpToolSchemaSnapshots(workspaceDb, [history('mcpsnap_cross_catalog', 'other')]);
          const beforeConflict = listExportableMcpToolSchemaSnapshots(workspaceDb, workspaceId);
          expect(() => record('mcpsnap_cross_catalog', tools)).toThrow(Error);
          expect(listExportableMcpToolSchemaSnapshots(workspaceDb, workspaceId)).toEqual(
            beforeConflict
          );
          const churn = Array.from({ length: 10 }, (_, index) => `mcpsnap_retention_${index}`);
          churn.forEach((id, index) => {
            record(id, [tool(index)]);
          });
          expect(churn.some((id) => retained(id) === null)).toBe(true);
          expect(retained(referencedId)).toEqual(referenced);
          expect(currentId()).toBe(churn.at(-1));
        }
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      await client.close().catch(() => undefined);
      native.executor.completion.resolve();
      if (native.executor.launches) await native.executor.execution.catch(() => undefined);
      await Promise.allSettled(
        taskAdmissions.mock.results
          .filter((result) => result.type === 'return')
          .map((result) => result.value.closeout)
      );
      taskAdmissions.mockRestore();
      await native.restore();
      await workerMcpGateway.close();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      transientPreparation: false,
      entry: 'direct Task',
      refuseFirst: false,

      decision: 'granted' as const,
      ownerCommand: 'task.start',
    },
    {
      transientPreparation: false,
      entry: 'refused warm Worker conversation',
      refuseFirst: true,

      decision: 'granted' as const,
      ownerCommand: 'conversation.submit',
    },
    {
      transientPreparation: false,
      entry: 'selected warm Worker conversation',
      refuseFirst: false,

      decision: 'granted' as const,
      ownerCommand: 'conversation.submit',
    },
    {
      transientPreparation: true,
      entry: 'transient preparation refused Worker conversation',
      refuseFirst: true,

      decision: 'granted' as const,
      ownerCommand: 'conversation.submit',
    },
  ])('starts a definition-derived $entry, observes attention, responds and delivers the captured outcome once', async ({
    transientPreparation,
    ownerCommand,
    refuseFirst,
    decision,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-lifecycle-'));
    const exportRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-lifecycle-export-'));
    const callFile = join(dataRoot, 'mcp-calls.txt');
    const coreDb = openCoreDb(dataRoot);
    const fileAdmission = new FileStorageAdmission(dataRoot, () => 1_000_000n);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const agentSetup = createTestAgentSetup({
      requiredCapabilities: ['trusted-worker-inference-relay'],
      mcpIds: ['echo'],
    });
    admitTestNativeEnvironment(coreDb, agentSetup.manifest);
    let repositoryApprovalId: string | null = null;
    const catalog = parseWorkspaceMcpServerCatalog({
      schemaVersion: 1,
      servers: [
        {
          allowedTools: ['echo'],
          enabled: true,
          id: 'echo',
          schemaPolicy: 'tracking',
          timeoutMs: 2_000,
          transport: {
            args: [
              fileURLToPath(new URL('./test-support/mcp-stdio-stub.mjs', import.meta.url)),
              callFile,
            ],
            command: process.execPath,
            kind: 'stdio',
          },
        },
      ],
    });
    const lifecyclePolicy = admitTestMcpApproval({
      coreDb,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      serverId: 'echo',
      toolName: 'echo',
      userId: 'usr_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: testEntityId('tu', 'lifecycle-policy'),
    });
    const runtimeConfigManager = createRuntimeConfigManager({
      dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        agentManifests: [agentSetup.manifest],
        dataRoot,
        gatewayConfig: createTestGatewayConfig(),
        openKitConfig: {
          defaults: { defaultAgentId: agentSetup.manifest.id },
          policy: { mediation: lifecyclePolicy },
        },
        providerRegistry: new ProviderRegistry([
          {
            displayName: 'Agent OpenRouter',
            id: 'agent-openrouter',
            kind: 'local',
            models: ['openai/gpt-5.2'],
          },
        ]),
        workspaceConfigs: [
          {
            config: {
              schemaVersion: 1,
              workspace: {
                agents: [{ agentId: agentSetup.manifest.id, profileId: 'default' }],
                defaultAgentId: agentSetup.manifest.id,
                name: 'Demo Workspace',
              },
            },
            path: join(
              dataRoot,
              'workspaces',
              'ws_00000000-0000-7000-8000-000000000001',
              'config',
              'workspace.jsonc'
            ),
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          },
        ],
        workspaceMcpServerCatalogs: [
          {
            catalog,
            path: join(
              dataRoot,
              'workspaces',
              'ws_00000000-0000-7000-8000-000000000001',
              'config',
              'catalog/catalog.json'
            ),
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          },
        ],
      }),
    });
    const target = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment_mcp_lifecycle',
      identityId: 'identity_mcp_lifecycle',
      observedAt: '2026-09-03T00:00:00.000Z',
      targetId: 'target_local',
    });
    upsertNanoHostRuntimeTarget(coreDb, {
      ...target,
      freshEmpty: true,
      observedAt: '2026-09-03T00:00:01.000Z',
      physicalEpoch: 'a'.repeat(64),
      predecessorFenced: true,
      ready: true,
    });
    const terminalEvents = new Map<string, Buffer>();
    let liveCaptureCount = 0;
    const sandboxSessionRoot = join(dataRoot, 'sandbox-sessions');
    let liveFilePath = '';
    const nanoHostSessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        if (request.kind === 'image.acquire') return { digest: `sha256:${'a'.repeat(64)}` };
        if (request.kind === 'image.inspect') {
          return {
            digest: request.input.imageDigest,
            environmentDefaults: {
              defaultsDigest:
                'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
              values: {},
            },
            platform: { architecture: 'arm64', os: 'linux' },
            storageLayout: {
              family: 'openkit-worker',
              gid: 1000,
              targets: [{ target: '/openkit/threads' }, { target: '/workspace' }],
              uid: 1000,
              version: '1',
              workingDirectory: '/workspace',
            },
          };
        }
        if (request.kind === 'sandbox.create') {
          return {
            sandboxId: request.input.sandboxId,
            state: 'created',
            storage: {
              ...request.input.storage,
              targets: request.input.storage.targets.map((target) => ({
                ...target,
                initialized: true,
              })),
            },
          };
        }
        if (request.kind === 'workspace.collect') {
          // This source-less fixture accepts the real empty baseline before native Turn admission.
          return request.input.mode === 'baseline'
            ? {
                requestId: request.requestId,
                outcome: 'baseline',
                head: {
                  tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                  manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
                },
              }
            : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
        }
        if (request.kind === 'reference.import') return { state: 'imported' };
        if (request.kind === 'bridge.open') {
          return { accepted: true, integrationReady: true, state: 'open' };
        }
        if (request.kind === 'file.export') {
          if (request.input.purpose === 'artifact-submission') {
            expect(request.signal).toBeInstanceOf(AbortSignal);
            liveCaptureCount += 1;
            expect(request.input.maxByteLength).toBe(1_000_000_001);
            const directory = mkdtempSync(join(exportRoot, 'live-'));
            const stagingPath = join(directory, 'body');
            expect(request.input.slot).toBe('turn-output');
            expect(request.input.relativePath).toMatch(/^[A-Za-z0-9_-]+\/outputs\/submitted\.md$/);
            expect(join(sandboxSessionRoot, request.input.relativePath)).toBe(liveFilePath);
            const liveFileBytes = readFileSync(liveFilePath);
            writeFileSync(stagingPath, liveFileBytes);
            return {
              stagingPath,
              byteLength: liveFileBytes.length,
              sha256: `sha256:${createHash('sha256').update(liveFileBytes).digest('hex')}`,
            };
          }
          if (request.input.presence === 'optional') return { state: 'absent' };
          const relativePath = String(request.input.relativePath);
          const packageSnapshotId = String(request.input.packageSnapshotId);
          const bytes = relativePath.endsWith('events.jsonl')
            ? terminalEvents.get(packageSnapshotId)
            : Buffer.alloc(0);
          if (!bytes) throw new Error('The terminal transcript is unavailable.');
          const directory = mkdtempSync(join(exportRoot, 'result-'));
          const stagingPath = join(directory, 'payload');
          writeFileSync(stagingPath, bytes);
          return {
            byteLength: bytes.byteLength,
            sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
            stagingPath,
          };
        }
        if (request.kind === 'bridge.close' || request.kind === 'sandbox.delete') {
          return { state: 'deleted' };
        }
        throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };
    const workerControlGateway = createDefaultWorkerControlGateway(coreDb);
    const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
    const workspaceMutationAdmission = new WorkspaceMutationAdmission();
    const startup = observeNativeTaskStartup(store);
    const workerLifecycleRuntime = createConfiguredWorkerLifecycleRuntime({
      fileAdmission,
      coreDb,
      readRuntimeConfig: () => runtimeConfigManager.current(),
      env: {},
      nanoHostSessionDispatch,
      store,
      workerControlGateway,
      workspaceMutationAdmission,
    });
    const execution = vi.spyOn(workerLifecycleRuntime.turnExecutor, 'startTurn');
    let firstTurnId: string | undefined;
    const firstResult = Promise.withResolvers<void>();
    void firstResult.promise.catch(() => undefined);
    const updateItem = store.updateItem.bind(store);
    const resultPublication = vi
      .spyOn(store, 'updateItem')
      .mockImplementation((id, input, admission) => {
        const publication = updateItem(id, input, admission);
        if (
          firstTurnId &&
          id === deriveEntityId('it', ['worker-result', firstTurnId]) &&
          'level' in input &&
          input.level === 'info'
        ) {
          void publication.then(() => firstResult.resolve(), firstResult.reject);
        }
        return publication;
      });
    const app = createApp({
      fileAdmission,
      coreDb,
      dataRoot,
      nanoHostSessionDispatch,
      runtimeConfigManager,
      store,
      workerControlGateway,
      workerLifecycleRuntime,
      workerMcpGateway,
      workspaceMutationAdmission,
    });

    const dispatchNext = async (
      operation:
        | 'session.open'
        | 'turn.start'
        | 'turn.interrupt'
        | 'session.inspect'
        | 'session.close'
    ) => {
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const bindings = coreDb.sqlite
          .prepare(`SELECT sandbox_integration_binding_ref AS integrationRef
            FROM sandbox_runtime_records`)
          .all() as { integrationRef: string }[];
        let binding: { integrationRef: string } | undefined;
        let command: ReturnType<typeof dispatchNanoHostHarnessOperation> = null;
        for (const candidate of bindings) {
          command = dispatchNanoHostHarnessOperation(coreDb, {
            sandboxIntegrationBindingRef: candidate.integrationRef,
          });
          if (command) {
            binding = candidate;
            break;
          }
        }
        if (command) {
          if (operation === 'turn.start' && command.operation === 'session.inspect') {
            workerLifecycleRuntime.acceptNanoHostHarnessCommand(command);
            settle(
              { command, integrationRef: binding!.integrationRef },
              {
                childState: 'absent',
                cleanupState: 'clean',
                nativeHandleDigest: 'b'.repeat(64),
                nativeHandleState: 'ready',
                state: 'open',
              }
            );
            continue;
          }
          expect(command.operation).toBe(operation);
          workerLifecycleRuntime.acceptNanoHostHarnessCommand(command);
          return { command, integrationRef: binding!.integrationRef };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      throw new Error(
        `Expected queued NanoHost Harness operation: ${operation}; Turns: ${JSON.stringify(
          store
            .listThreads('ws_00000000-0000-7000-8000-000000000001')
            .flatMap((thread) =>
              store.listThreadTurns(workspaceIdForOwner(thread.owner), thread.id)
            )
            .map((turn) => ({ id: turn.id, status: turn.status, error: turn.error }))
        )}; Queue: ${JSON.stringify(coreDb.sqlite.prepare('SELECT status, denial_reason FROM scheduler_admission_entries').all())}`
      );
    };
    const settle = (
      dispatched: Awaited<ReturnType<typeof dispatchNext>>,
      body: Readonly<Record<string, unknown>>
    ) => {
      const result = {
        body,
        disposition: 'succeeded' as const,
        harnessInstanceId: dispatched.command.harnessInstanceId,
        operationId: dispatched.command.operationId,
        schemaVersion: 2 as const,
        sequence: dispatched.command.sequence,
      };
      settleNanoHostHarnessOperation(coreDb, {
        result,
        sandboxIntegrationBindingRef: dispatched.integrationRef,
        timestamp: new Date().toISOString(),
      });
      workerLifecycleRuntime.acceptNanoHostHarnessResult(result);
    };
    const driveTask = async (blocked: boolean) => {
      if (blocked) {
        const opened = await dispatchNext('session.open');
        settle(opened, {
          maxActiveTurns: opened.command.body.maxActiveTurns,
          nativeHandleDigest: null,
          nativeHandleState: 'pending',
          state: 'open',
        });
      }
      const started = await dispatchNext('turn.start');
      settle(started, {
        nativeHandleDigest: blocked ? null : 'b'.repeat(64),
        nativeHandleState: blocked ? 'pending' : 'ready',
        state: 'started',
      });
      const commandBody = started.command.body as Record<string, unknown>;
      const capabilityToken = String(commandBody.capabilityToken);
      const workerControlToken = String(commandBody.workerControlToken);
      const environmentPackage = workerControlGateway.authenticatePackageToken(
        `Bearer ${capabilityToken}`,
        { tokenFamily: 'capability' }
      );
      await startup.waitFor(environmentPackage.scope.turnId);
      expect(environmentPackage.workspace.inputs.every((input) => input.kind === 'generated')).toBe(
        true
      );
      expect(environmentPackage.workspace.outputs).toEqual([
        {
          id: 'turn-output-root',
          path: `/openkit/sessions/${environmentPackage.scope.agentSessionId}/outputs`,
          registerAsArtifacts: true,
          retention: 'sync-on-turn-end',
        },
      ]);
      const localOutputRoot = join(
        sandboxSessionRoot,
        environmentPackage.scope.agentSessionId,
        'outputs'
      );
      mkdirSync(localOutputRoot, { recursive: true });
      liveFilePath = join(localOutputRoot, 'submitted.md');
      writeFileSync(liveFilePath, 'Captured by the existing configured runtime.\n');
      const lineage = {
        agentSessionId: environmentPackage.scope.agentSessionId,
        packageSnapshotId: environmentPackage.snapshotId,
        requestId: environmentPackage.scope.requestId,
        threadId: environmentPackage.scope.threadId,
        turnId: environmentPackage.scope.turnId,
        workspaceId: environmentPackage.scope.workspaceId,
      };
      const processKey = createHash('sha256')
        .update(`process:${environmentPackage.snapshotId}`)
        .digest('base64url');
      const heartbeat = await app.request('/api/worker-control/heartbeat', {
        body: JSON.stringify({
          body: {
            message: null,
            processKeyHash: createHash('sha256')
              .update(Buffer.from(processKey, 'base64url'))
              .digest('base64url'),
            status: 'starting',
          },
          lineage,
          operation: 'heartbeat',
          schemaVersion: 2,
          sequence: 0,
        }),
        headers: {
          authorization: `Bearer ${workerControlToken}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      expect(heartbeat.status, await heartbeat.clone().text()).toBe(200);

      const work = new Client({ name: 'submission-composition-test', version: '1.0.0' });
      await work.connect(
        new StreamableHTTPClientTransport(
          new URL('http://nanocore.test/api/worker-capabilities/mcp/openkit-work'),
          {
            fetch: (request, init) => app.fetch(new Request(request, init)),
            requestInit: { headers: { authorization: `Bearer ${capabilityToken}` } },
          }
        )
      );
      const discovery = await work.listTools();
      expect(
        discovery.tools.find((tool) => tool.name === 'work_artifact_submit')?.description
      ).toContain(environmentPackage.workspace.outputs[0]!.path);
      const submission = {
        requestId: `capture-${environmentPackage.scope.turnId}`,
        path: `${environmentPackage.workspace.outputs[0]!.path}/submitted.md`,
        kind: 'report',
        title: 'Captured report',
        mediaType: 'text/markdown',
      };
      const beforeRefusal = liveCaptureCount;
      await expect(
        work.callTool({
          name: 'work_artifact_submit',
          arguments: {
            ...submission,
            requestId: `path-refusal-${environmentPackage.scope.turnId}`,
            path: '/workspace/.openkit/cache/escape.md',
          },
        })
      ).rejects.toMatchObject({ data: { code: 'invalid_request' } });
      expect(liveCaptureCount).toBe(beforeRefusal);
      const originalBytes = readFileSync(liveFilePath);
      writeFileSync(liveFilePath, capabilityToken);
      await expect(
        work.callTool({
          name: 'work_artifact_submit',
          arguments: {
            ...submission,
            requestId: `credential-refusal-${environmentPackage.scope.turnId}`,
          },
        })
      ).rejects.toMatchObject({ data: { code: 'invalid_request' } });
      expect(
        store
          .listArtifacts('ws_00000000-0000-7000-8000-000000000001')
          .filter((artifact) => artifact.turnId === environmentPackage.scope.turnId)
      ).toHaveLength(0);
      expect(store.getTurnById(environmentPackage.scope.turnId).status).toBe('running');
      writeFileSync(liveFilePath, originalBytes);
      const capturesBefore = liveCaptureCount;
      const submitted = await work.callTool({
        name: 'work_artifact_submit',
        arguments: submission,
      });
      expect(submitted.isError).toBe(false);
      const artifactId = String(submitted.structuredContent!.artifactId);
      const readback = await app.request(
        ...operationRequest('artifact.read', {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          artifactId,
        })
      );
      expect(readback.status).toBe(200);
      expect(await readback.json()).toMatchObject({
        id: artifactId,
        content: {
          format: 'file',
          mediaType: 'text/markdown',
          byteLength: originalBytes.byteLength,
        },
      });
      // The public descriptor is not a byte oracle; read the exact immutable original.
      const downloadOriginal = async () => {
        const downloaded = await app.request(
          `/api/app/operations/artifact.download?${new URLSearchParams({
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            artifactId,
            artifactVersion: '1',
          })}`
        );
        expect(downloaded.status).toBe(200);
        expect(downloaded.headers.get('x-openkit-content-digest')).toBe(
          `sha256:${createHash('sha256').update(originalBytes).digest('hex')}`
        );
        return Buffer.from(await downloaded.arrayBuffer());
      };
      expect(await downloadOriginal()).toEqual(originalBytes);
      const publishedBytes = readFileSync(liveFilePath);
      writeFileSync(liveFilePath, 'A later edit cannot mutate the committed output.');
      expect(
        (await work.callTool({ name: 'work_artifact_submit', arguments: submission }))
          .structuredContent!.artifactId
      ).toBe(artifactId);
      expect(liveCaptureCount).toBe(capturesBefore + 1);
      expect(await downloadOriginal()).toEqual(publishedBytes);
      await work.close();
      const client = new Client({ name: 'public-task-lifecycle-test', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://nanocore.test/api/worker-capabilities/mcp/${'echo'}`),
          {
            fetch: (request, init) => app.fetch(new Request(request, init)),
            requestInit: { headers: { authorization: `Bearer ${capabilityToken}` } },
          }
        )
      );
      await client.listTools();
      let toolCall: unknown = null;
      if (blocked) {
        const result = await client.callTool({
          name: 'echo',
          arguments: { message: 'public-task' },
        });
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { status: 'pending-approval' },
        });
        repositoryApprovalId = String(result.structuredContent!.requestId);
        toolCall = result;
        expect(existsSync(callFile)).toBe(false);
      } else {
        const deliveryDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
        try {
          expect(readPendingRequest(deliveryDb.sqlite, repositoryApprovalId!)?.delivery).toBe(
            'delivered'
          );
          const inputText = JSON.stringify(environmentPackage);
          expect(inputText).toContain(repositoryApprovalId);
          if (refuseFirst) expect(inputText).toContain('Continue after refused admission.');
        } finally {
          deliveryDb.sqlite.close();
        }
      }
      await client.close();
      const terminalBody = {
        evidenceManifestDigests: {},
        status: 'completed' as const,
        stopReason: 'completed',
      };
      terminalEvents.set(
        environmentPackage.snapshotId,
        Buffer.from(
          `${JSON.stringify(
            buildWorkerCanonicalTerminalEventRecord({
              data: terminalBody,
              lineage,
              sequence: 1,
            })
          )}\n`
        )
      );
      const finalStatus = await app.request('/api/worker-control/final-status', {
        body: JSON.stringify({
          body: terminalBody,
          lineage,
          operation: 'final_status',
          schemaVersion: 2,
          sequence: 1,
        }),
        headers: {
          authorization: `Bearer ${workerControlToken}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      expect(finalStatus.status, await finalStatus.clone().text()).toBe(200);
      const inspected = await dispatchNext('session.inspect');
      settle(inspected, {
        childState: 'absent',
        cleanupState: 'clean',
        nativeHandleDigest: 'b'.repeat(64),
        nativeHandleState: 'ready',
        state: 'open',
      });
      // The inspection result releases the executor; join its publication before fixture teardown.
      const running = execution.mock.calls.findIndex(
        ([, turnId]) => turnId === environmentPackage.scope.turnId
      );
      if (running < 0) throw new Error('Expected the admitted Task execution.');
      await execution.mock.results[running]!.value;
      return { agentSessionId: environmentPackage.scope.agentSessionId, toolCall };
    };

    try {
      const firstRequest = app.request(
        ...operationRequest(
          ownerCommand,
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            body: JSON.stringify({
              input: 'Implement the bounded MCP Task fix.',
              requestId: '0190f4c8-0000-7000-8000-000000000501',
              ...(ownerCommand === 'conversation.submit'
                ? {
                    artifactRefs: [],
                    targetRef: `warm-worker:${agentSetup.manifest.id}:default`,
                  }
                : {}),
            }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
      const admittedFirstRequest = firstRequest.then(async (response) => {
        expect(response.status, await response.clone().text()).toBe(202);
        return response;
      });
      // Start the Harness dispatch budget after durable admission, not during request preparation.
      const firstResponse = await admittedFirstRequest;
      expect(firstResponse.status, await firstResponse.clone().text()).toBe(202);
      const firstTask =
        ownerCommand === 'conversation.submit'
          ? SubmitConversationResponseSchema.parse(await firstResponse.json())
          : StartTaskModeResponseSchema.parse(await firstResponse.json());
      firstTurnId = firstTask.turn.id;
      const firstRun = await driveTask(true);
      // Task closeout includes native release and the conversation's final display publication.
      const started = execution.mock.calls.findIndex(([, turnId]) => turnId === firstTask.turn.id);
      expect(started).toBeGreaterThanOrEqual(0);
      await execution.mock.results[started]!.value;
      if (ownerCommand === 'conversation.submit') await firstResult.promise;
      expect(
        listSchedulerExecutionAttemptsForTurn(coreDb, {
          workspaceId: workspaceIdForOwner(firstTask.turn.owner),
          threadId: firstTask.turn.threadId,
          turnId: firstTask.turn.id,
        }).every((attempt) => attempt.phase === 'closed')
      ).toBe(true);
      const durableTurn = store.getTurnById(firstTask.turn.id);
      if (ownerCommand === 'conversation.submit') {
        expect(durableTurn.threadId).not.toBe('th_00000000-0000-7000-8000-000000000001');
        expect(
          store.getThread(workspaceIdForOwner(durableTurn.owner), durableTurn.threadId)
            .parentThreadId
        ).toBe('th_00000000-0000-7000-8000-000000000001');
      }
      expect(durableTurn.status).toBe('completed');
      if ('outcome' in firstTask) expect(firstTask.outcome).toBe('accepted');
      expect(store.getAgentSession(firstRun.agentSessionId).status).toBe('idle');
      expect(
        store
          .listCommandRequests()
          .filter(
            (receipt) =>
              receipt.response.kind === 'turn' && receipt.response.id === firstTask.turn.id
          )
          .map((receipt) => receipt.command)
      ).toEqual([ownerCommand]);
      // Settled owner replay is compared across all three projections without another Worker launch.
      const replayInput = {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        input: 'Implement the bounded MCP Task fix.',
        requestId: '0190f4c8-0000-7000-8000-000000000501',
        ...(ownerCommand === 'conversation.submit'
          ? { artifactRefs: [], targetRef: `warm-worker:${agentSetup.manifest.id}:default` }
          : {}),
      };
      const nativeClient = createCoreClient({
        baseUrl: 'http://nanocore.test',
        fetch: (input, init) => app.fetch(new Request(input, init)),
      });
      const replayResponse = await app.request(
        ...operationRequest(ownerCommand, {}, { body: JSON.stringify(replayInput) })
      );
      expect(replayResponse.status, await replayResponse.clone().text()).toBe(202);
      const replayResult = await replayResponse.json();
      expect(await nativeClient.operations[ownerCommand](replayInput as never)).toEqual(
        replayResult
      );
      const { operationCatalog } = await import(
        new URL('../../../skills/openkit-operations.mjs', import.meta.url).href
      );
      const cliOperation = operationCatalog.find(
        (entry: { id: string }) => entry.id === ownerCommand
      )!;
      expect(
        await cliOperation.handler(
          { client: nativeClient },
          cliOperation.inputSchema.parse(replayInput)
        )
      ).toEqual(replayResult);
      expect(repositoryApprovalId).not.toBeNull();
      const attentionResponse = await app.request(
        ...operationRequest(
          'attention.list',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          undefined
        )
      );
      expect(
        ListHumanAttentionResponseSchema.parse(await attentionResponse.json()).items
      ).toContainEqual(
        expect.objectContaining({
          id: `approval:${repositoryApprovalId}`,
          actions: expect.arrayContaining([expect.objectContaining({ kind: 'grant_approval' })]),
        })
      );
      const originalSnapshot = runtimeConfigManager.current();
      const preparationFailure = new Error('Transient pending outcome preparation failure');
      const preparationFault = transientPreparation
        ? vi
            .spyOn(workerLifecycleRuntime.turnExecutor, 'prepareAgentSessionForTurn')
            .mockRejectedValue(preparationFailure)
        : undefined;
      const providerFault =
        refuseFirst && !transientPreparation
          ? vi
              .spyOn(runtimeConfigManager, 'current')
              .mockReturnValue({ ...originalSnapshot, providerRegistry: new ProviderRegistry([]) })
          : undefined;
      const detailResponse = await app.request('/api/app/operations/thread.dashboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: firstTask.turn.threadId,
        }),
      });
      expect(detailResponse.status, await detailResponse.clone().text()).toBe(200);
      const detailDashboard = await detailResponse.json();
      expect(
        detailDashboard.pendingRequests.find(
          (row: { requestId: string }) => row.requestId === repositoryApprovalId
        )
      ).toMatchObject({ approvalEffect: { status: 'available' }, canRespond: true });
      const responseInput = {
        decision,
        requestId: '0190f4c8-0000-7000-8000-000000000502',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: firstTask.turn.threadId,
        turnId: firstTask.turn.id,
      };
      const approvalResponse = app.request(
        ...operationRequest(
          'approval.respond',
          { approvalRequestId: repositoryApprovalId },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(responseInput),
          }
        )
      );
      let responded: Response;
      let refusedExecutionCalls: ReturnType<typeof listWorkspaceCapabilityCalls> | undefined;
      let callsBeforeReplay: ReturnType<typeof listWorkspaceCapabilityCalls> | undefined;
      let continuation: Awaited<ReturnType<typeof driveTask>>;
      if (refuseFirst) {
        responded = await approvalResponse;
        const reviewDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
        for (let n = 0; n < 2000; n++) {
          const record = readPendingRequest(reviewDb.sqlite, repositoryApprovalId!);
          if (record?.delivery === 'undelivered' && record.publicationTurnId) {
            const publication = store.getTurnById(record.publicationTurnId);
            if (publication.status !== 'pending' && publication.status !== 'running') break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        const refused = readPendingRequest(reviewDb.sqlite, repositoryApprovalId!)!;
        if (transientPreparation) {
          expect(responded.status, await responded.clone().text()).toBe(200);
          // Preparation refuses before any effect-capable operation, so delivery is definitely absent.
          expect(refused.delivery).toBe('undelivered');
          expect(store.getTurnById(refused.publicationTurnId!)).toMatchObject({
            status: 'failed',
            error: { code: 'worker_preparation_failed' },
          });
          expect(preparationFault).toHaveBeenCalledTimes(1);
          expect(
            listSchedulerAdmissionEntriesForWorkspace(coreDb, {
              workspaceId: refused.workspaceId,
              statuses: ['admitted'],
            })
          ).toContainEqual(expect.objectContaining({ turnId: refused.publicationTurnId }));
          expect(
            listSchedulerExecutionAttemptsForTurn(coreDb, {
              workspaceId: refused.workspaceId,
              threadId: refused.threadId,
              turnId: refused.publicationTurnId!,
            })
          ).toContainEqual(
            expect.objectContaining({
              phase: 'closed',
              disposition: 'not_accepted',
              operationId: null,
            })
          );
          const count = store.listThreadTurns(
            'ws_00000000-0000-7000-8000-000000000001',
            firstTask.turn.threadId
          ).length;
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(
            store.listThreadTurns(
              'ws_00000000-0000-7000-8000-000000000001',
              firstTask.turn.threadId
            )
          ).toHaveLength(count);
          preparationFault!.mockRestore();
          reviewDb.sqlite.close();
          return;
        }
        // Pending Requests: Main refusal after the native claim is a known execution error.
        expect(refused).toMatchObject({
          state: 'resolved',
          resolution: 'granted',
          claim: 'finished',
          disposition: 'execution-error',
          delivery: 'undelivered',
          executionCallId: executionCallIdForRequest(repositoryApprovalId!),
        });
        refusedExecutionCalls = listWorkspaceCapabilityCalls(reviewDb, refused.workspaceId).filter(
          (call) => call.family === 'mcp'
        );
        expect(refusedExecutionCalls.filter((call) => call.id === refused.executionCallId)).toEqual(
          [
            expect.objectContaining({
              requestId: responseInput.requestId,
              status: 'failed',
              upstreamContacted: false,
            }),
          ]
        );
        expect(
          listWorkspaceUsageRecords(reviewDb, refused.workspaceId).filter(
            (usage) => usage.capabilityCallId === refused.executionCallId
          )
        ).toEqual([]);
        expect(existsSync(callFile)).toBe(false);
        const publication = store.getTurnById(refused.publicationTurnId!);
        expect(publication.status).toBe('failed');
        expect(publication.items).toContainEqual(
          expect.objectContaining({
            id: pendingRequestItemId(repositoryApprovalId!, 'disposition'),
            type: 'tool-call',
            result: 'execution-error',
          })
        );
        expect(
          listThreadPendingRequests(reviewDb.sqlite, refused.workspaceId, refused.threadId).filter(
            (record) => record.delivery === 'frozen'
          )
        ).toEqual([]);
        expect(
          listSchedulerAdmissionEntriesForWorkspace(coreDb, {
            workspaceId: refused.workspaceId,
            statuses: ['queued'],
          }).filter((entry) => entry.turnId === refused.publicationTurnId)
        ).toEqual([]);
        const count = store.listThreadTurns(
          'ws_00000000-0000-7000-8000-000000000001',
          firstTask.turn.threadId
        ).length;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(
          store.listThreadTurns('ws_00000000-0000-7000-8000-000000000001', firstTask.turn.threadId)
        ).toHaveLength(count);
        providerFault!.mockRestore();
        const user = app.request(
          ...operationRequest(
            'conversation.submit',
            {
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              threadId: firstTask.turn.threadId,
            },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                input: 'Continue after refused admission.',
                requestId: '0190f4c8-0000-7000-8000-000000000599',
                artifactRefs: [],
                targetRef: `running-worker:${encodeURIComponent(firstTask.turn.threadId)}:${encodeURIComponent(agentSetup.manifest.id)}`,
              }),
            }
          )
        );
        const [userResponse, resumed] = await Promise.all([user, driveTask(false)]);
        expect(userResponse.status, await userResponse.clone().text()).toBe(202);
        continuation = resumed;
        const delivered = readPendingRequest(reviewDb.sqlite, repositoryApprovalId!)!;
        expect(delivered.delivery).toBe('delivered');
        expect(delivered).toMatchObject({
          executionCallId: refused.executionCallId,
          claim: 'finished',
          disposition: 'execution-error',
        });
        expect(delivered.publicationTurnId).toBe(refused.publicationTurnId);
        expect(delivered.deliveryTurnId).not.toBe(refused.publicationTurnId);
        expect(store.getTurnById(delivered.deliveryTurnId!).items).toContainEqual(
          expect.objectContaining({
            type: 'user-message',
            text: expect.stringContaining('Continue after refused admission.'),
          })
        );
        expect(store.getTurnById(refused.publicationTurnId!).items).toEqual(publication.items);
        expect(store.getTurnById(delivered.deliveryTurnId!).items).not.toContainEqual(
          expect.objectContaining({
            id: pendingRequestItemId(repositoryApprovalId!, 'disposition'),
          })
        );
        callsBeforeReplay = listWorkspaceCapabilityCalls(reviewDb, refused.workspaceId).filter(
          (call) => call.family === 'mcp'
        );
        // Later user work owns its calls; carrying the outcome preserves the original execution.
        expect(
          callsBeforeReplay.filter((call) => call.turnId !== delivered.deliveryTurnId)
        ).toEqual(refusedExecutionCalls);
        expect(
          callsBeforeReplay.filter((call) => call.requestId === responseInput.requestId)
        ).toEqual(
          refusedExecutionCalls.filter((call) => call.requestId === responseInput.requestId)
        );
        reviewDb.sqlite.close();
      } else {
        [responded, continuation] = await Promise.all([approvalResponse, driveTask(false)]);
      }
      expect(responded.status, await responded.clone().text()).toBe(200);
      expect(store.getTurnById(firstTask.turn.id).status).toBe('completed');
      expect(continuation.agentSessionId).toBe(firstRun.agentSessionId);
      const replay = await app.request(
        ...operationRequest(
          'approval.respond',
          { approvalRequestId: repositoryApprovalId },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(responseInput),
          }
        )
      );
      expect(replay.status).toBe(200);
      if (refuseFirst) expect(await replay.json()).toEqual(await responded.clone().json());
      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      try {
        if (refuseFirst) {
          expect(
            listWorkspaceCapabilityCalls(workspaceDb, responseInput.workspaceId).filter(
              (call) => call.family === 'mcp'
            )
          ).toEqual(callsBeforeReplay);
          expect(
            listWorkspaceUsageRecords(workspaceDb, responseInput.workspaceId).filter(
              (usage) => usage.capabilityCallId === executionCallIdForRequest(repositoryApprovalId!)
            )
          ).toEqual([]);
        }
        expect(readPendingRequest(workspaceDb.sqlite, repositoryApprovalId!)?.delivery).toBe(
          'delivered'
        );
        expect(
          store
            .listThreadItems('ws_00000000-0000-7000-8000-000000000001', firstTask.turn.threadId)
            .filter(
              (item) =>
                item.type === 'approval-decision' && item.approvalRequestId === repositoryApprovalId
            )
        ).toHaveLength(1);
        expect(
          store
            .listThreadTurns('ws_00000000-0000-7000-8000-000000000001', firstTask.turn.threadId)
            .filter((turn) => turn.triggerSource?.kind === 'approval-resolution')
        ).toHaveLength(1);
      } finally {
        workspaceDb.sqlite.close();
      }
      if (!refuseFirst)
        expect(readFileSync(callFile, 'utf8').trim().split('\n')).toEqual(['public-task']);
      else expect(existsSync(callFile)).toBe(false);
    } finally {
      resultPublication.mockRestore();
      startup.restore();
      execution.mockRestore();
      await workerMcpGateway.close();
      coreDb.sqlite.close();
      await shutdownControlStoreWorkerClient();
      rmSync(exportRoot, { force: true, recursive: true });
      rmSync(dataRoot, { force: true, recursive: true });
    }
  }, 60_000);

  it('maps the bounded MCP failure table without extra tool effects', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-failures-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const ownerCreatedAt = Date.now();
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (
          id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at
        ) VALUES ('usr_00000000-0000-780b-b93c-e2479beb99f1', 'Backup owner', 'backup@example.com', false, ?, ?, 'human', 'active', NULL)`
      )
      .run(ownerCreatedAt, ownerCreatedAt);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-780b-b93c-e2479beb99f1',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const memberCreatedAt = new Date().toISOString();
    coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, invitation_id, joined_at,
          removed_at, revision, created_at, updated_at
        ) VALUES ('ws_00000000-0000-7000-8000-000000000001', 'usr_00000000-0000-7000-8000-000000000001', 'active', NULL, ?, NULL, 1, ?, ?)`
      )
      .run(memberCreatedAt, memberCreatedAt, memberCreatedAt);
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Classify MCP failures',
      {
        id: 'usr_00000000-0000-7000-8000-000000000001',
        kind: 'user',
      }
    );
    const server = (id: string, schemaPolicy: 'pinned' | 'tracking' = 'tracking') => ({
      allowedTools: ['echo'],
      credentialBindings: [],
      enabled: true,
      id,
      pinnedSchemaSnapshotId: schemaPolicy === 'pinned' ? 'mcpsnap_expected' : null,
      schemaPolicy,
      timeoutMs: 100,
      transport: { args: [], command: process.execPath, environment: {}, kind: 'stdio' as const },
    });
    const catalog = {
      schemaVersion: 1 as const,
      servers: [
        server('echo'),
        server('duplicate'),
        server('pinned', 'pinned'),
        server('unavailable'),
        server('whitespace'),
        server('authority-race'),
        server('gate-race'),
        server('schema-cancel'),
        server('near-limit'),
      ],
    };
    let environmentPackage = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId: testEntityId('as', 'as_mcp_failures'),
      agentSetup: createTestAgentSetup({
        mcpIds: [
          'echo',
          'duplicate',
          'pinned',
          'unavailable',
          'whitespace',
          'authority-race',
          'gate-race',
          'schema-cancel',
          'near-limit',
        ],
      }),
      backend: { kind: 'openshell' },
      createdAt: '2026-09-03T00:00:00.000Z',
      requestId: 'req_mcp_failures',
      triggerActor: turn.triggerActor,
      turn,
      workspaceCwd: '/workspace',
      workspaceMcpServerCatalog: catalog,
      workspaceRoots: [],
    });
    const authorizedEnvironmentPackage = environmentPackage;
    recordMcpWorkerLineage(coreDb, environmentPackage);
    // Retain the canonical AgentSession and named AEP for publication repair.
    await store.createAgentSession({
      agentId: environmentPackage.agent.agentId,
      createdAt: '2026-09-03T00:00:00.000Z',
      id: environmentPackage.scope.agentSessionId,
      message: null,
      status: 'busy',
      threadId: turn.threadId,
      updatedAt: '2026-09-03T00:00:00.000Z',
      workspaceId: workspaceIdForOwner(turn.owner),
    });
    const snapshotDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(snapshotDb);
    try {
      recordAgentEnvironmentPackageSnapshot(snapshotDb, {
        createdAt: '2026-09-03T00:00:00.000Z',
        environmentPackage,
      });
    } finally {
      snapshotDb.sqlite.close();
    }
    const emptyNearLimitResult = { content: [{ text: '', type: 'text' as const }] };
    const nearLimitResult = {
      content: [
        {
          text: 'x'.repeat(
            512 * 1024 - Buffer.byteLength(JSON.stringify(emptyNearLimitResult), 'utf8')
          ),
          type: 'text' as const,
        },
      ],
    };
    const callTool = vi.fn(async (request: Parameters<WorkerMcpGateway['callTool']>[0]) => {
      const message = request.arguments.message;
      if (message === 'near-limit') return nearLimitResult;
      if (message === 'timeout') {
        throw new WorkerMcpGatewayCallError(
          'mcp-timeout',
          'MCP request timed out.',
          504,
          'unknown'
        );
      }
      if (message === 'crash') {
        throw new WorkerMcpGatewayCallError(
          'mcp-call-failed',
          'MCP tool call failed.',
          503,
          'unknown'
        );
      }
      if (message === 'oversize') {
        throw new WorkerMcpGatewayCallError(
          'mcp-result-too-large',
          MCP_RESULT_TOO_LARGE_MESSAGE,
          413,
          'contacted'
        );
      }
      if (message === 'tool-error') {
        throw new WorkerMcpGatewayCallError(
          'mcp-call-failed',
          'MCP tool call failed.',
          502,
          'contacted'
        );
      }
      if (message === 'cancelled') {
        await new Promise<void>((_resolve, reject) => {
          const fail = () =>
            reject(
              new WorkerMcpGatewayCallError(
                'mcp-call-failed',
                'MCP tool call was cancelled.',
                499,
                'unknown',
                true
              )
            );
          if (request.signal?.aborted) fail();
          else request.signal?.addEventListener('abort', fail, { once: true });
        });
      }
      if (message === 'pre-cancelled') {
        throw new WorkerMcpGatewayCallError(
          'mcp-call-failed',
          'MCP tool call was cancelled.',
          503,
          'not-contacted',
          true
        );
      }
      return { content: [{ text: String(message), type: 'text' as const }] };
    });
    let listBarrier:
      | {
          readonly entered: (signal: AbortSignal | undefined) => void;
          readonly released: Promise<void>;
          readonly serverId: string;
        }
      | undefined;
    const createListBarrier = (serverId: string) => {
      let markEntered!: (signal: AbortSignal | undefined) => void;
      let release!: () => void;
      const entered = new Promise<AbortSignal | undefined>((resolve) => {
        markEntered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      listBarrier = { entered: markEntered, released, serverId };
      return { entered, release };
    };
    let nearLimitListing: Awaited<ReturnType<WorkerMcpGateway['listTools']>>['tools'] = [];
    const listTools = vi.fn(async (request: Parameters<WorkerMcpGateway['listTools']>[0]) => {
      if (request.server.id === 'near-limit') {
        return { serverVersion: '1.0.0', tools: nearLimitListing };
      }
      if (listBarrier?.serverId === request.server.id) {
        listBarrier.entered(request.signal);
        await listBarrier.released;
      }
      if (request.signal?.aborted) {
        throw new WorkerMcpGatewayCallError(
          'mcp-server-unavailable',
          'MCP server is unavailable.',
          503,
          'unknown',
          true
        );
      }
      if (request.server.id === 'unavailable') {
        throw new WorkerMcpGatewayCallError(
          'mcp-server-unavailable',
          'MCP server is unavailable.',
          503,
          'not-contacted'
        );
      }
      if (request.server.id === 'duplicate') {
        return {
          serverVersion: '1.0.0',
          tools: [mcpEchoTool(), mcpEchoTool()],
        };
      }
      if (request.server.id === 'whitespace') {
        return {
          serverVersion: '1.0.0',
          tools: [{ ...mcpEchoTool(), name: ' echo ' }],
        };
      }
      return {
        serverVersion: '1.0.0',
        tools: [mcpEchoTool()],
      };
    });
    const workerMcpGateway = {
      callTool,
      close: vi.fn(async () => undefined),
      closeServer: vi.fn(async () => undefined),
      closeServerIfIdle: vi.fn(async () => undefined),
      closeWorkspace: vi.fn(async () => undefined),
      getServerHealth: vi.fn(() => 'inactive' as const),
      listTools,
    } satisfies WorkerMcpGateway;
    const app = new Hono();
    const workspaceMutationAdmission = new WorkspaceMutationAdmission();
    registerWorkerMcpRoutes({
      app,
      coreDb,
      runtimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          agentManifests: [],
          dataRoot,
          workspaceMcpServerCatalogs: [
            {
              catalog,
              path: join(dataRoot, 'catalog/catalog.json'),
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            },
          ],
        }),
      store,
      workerControlGateway: {
        authenticatePackageToken: vi.fn(() => environmentPackage),
      } as unknown as WorkerControlGateway,
      workerMcpGateway,
      workspaceMutationAdmission,
    });
    const clients: Client[] = [];
    const connect = async (serverId: string) => {
      const client = new Client({ name: `failure-${serverId}`, version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://nanocore.test/api/worker-capabilities/mcp/${serverId}`),
          {
            fetch: (request, init) => app.fetch(new Request(request, init)),
            requestInit: { headers: { authorization: 'Bearer capability-token' } },
          }
        )
      );
      clients.push(client);
      return client;
    };

    try {
      const echo = await connect('echo');
      const rawCall = (id: string | number, message = 'typed-id') =>
        app.request('/api/worker-capabilities/mcp/echo', {
          body: JSON.stringify({
            id,
            jsonrpc: '2.0',
            method: 'tools/call',
            params: { arguments: { message }, name: 'echo' },
          }),
          headers: {
            accept: 'application/json, text/event-stream',
            authorization: 'Bearer capability-token',
            'content-type': 'application/json',
          },
          method: 'POST',
        });
      const typedIdCallsBefore = callTool.mock.calls.length;
      for (const id of [424_242, '424242'] as const) {
        const response = await rawCall(id);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ id, result: expect.any(Object) });
      }
      const replay = await rawCall(424_242);
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({
        error: { data: { code: 'mcp-denied' } },
        id: 424_242,
      });
      expect(callTool.mock.calls.length).toBe(typedIdCallsBefore + 2);
      const typedIdDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      const typedIdRows = typedIdDb.sqlite
        .prepare(
          `SELECT call_id, item_id
           FROM capability_calls
           WHERE operation = 'mcp.call-tool'
           ORDER BY rowid`
        )
        .all() as Array<{ call_id: string; item_id: string }>;
      expect(typedIdRows).toEqual(
        [424_242, '424242'].map((requestId) => ({
          call_id: deriveEntityId('cap', [
            'mcp',
            environmentPackage.snapshotId,
            'echo',
            'mcp.call-tool',
            requestId,
          ]),
          item_id: deriveEntityId('it', [
            'mcp',
            environmentPackage.snapshotId,
            'echo',
            'echo',
            requestId,
          ]),
        }))
      );
      expect(new Set(typedIdRows.map((row) => row.call_id)).size).toBe(2);
      expect(new Set(typedIdRows.map((row) => row.item_id)).size).toBe(2);
      typedIdDb.sqlite.close();
      const failures = [
        { arguments: { message: 'blocked' }, code: 'mcp-tool-not-found', name: 'missing' },
        { arguments: { message: 'blocked' }, code: 'mcp-tool-not-found', name: 'x'.repeat(257) },
        { arguments: {}, code: 'mcp-invalid-arguments', name: 'echo' },
        { arguments: { message: 'timeout' }, code: 'mcp-timeout', name: 'echo' },
        { arguments: { message: 'crash' }, code: 'mcp-call-failed', name: 'echo' },
        { arguments: { message: 'oversize' }, code: 'mcp-result-too-large', name: 'echo' },
        { arguments: { message: 'tool-error' }, code: 'mcp-call-failed', name: 'echo' },
      ] as const;
      for (const failure of failures) {
        const before = callTool.mock.calls.length;
        await expect(
          echo.callTool({ arguments: failure.arguments, name: failure.name })
        ).rejects.toMatchObject({
          data: { code: failure.code },
          ...(failure.code === 'mcp-result-too-large'
            ? {
                message: expect.stringContaining(
                  'MCP tool result exceeds the capability response limit. Route bulk output through artifacts or the data plane.'
                ),
              }
            : {}),
        });
        expect(callTool.mock.calls.length - before).toBe(
          ['mcp-timeout', 'mcp-call-failed', 'mcp-result-too-large'].includes(failure.code) ? 1 : 0
        );
      }
      const cancellation = new AbortController();
      const callsBeforeCancellation = callTool.mock.calls.length;
      const cancelled = echo.callTool(
        { arguments: { message: 'cancelled' }, name: 'echo' },
        { signal: cancellation.signal }
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      cancellation.abort();
      await expect(cancelled).rejects.toThrow(/AbortError/);
      expect(callTool.mock.calls.length).toBe(callsBeforeCancellation + 1);
      // Client cancellation precedes server publication; drain its existing admission before the next call.
      await workspaceMutationAdmission.close('ws_00000000-0000-7000-8000-000000000001');
      workspaceMutationAdmission.reopen('ws_00000000-0000-7000-8000-000000000001');
      const callsBeforePreCancellation = callTool.mock.calls.length;
      await expect(
        echo.callTool({ arguments: { message: 'pre-cancelled' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-call-failed' } });
      expect(callTool.mock.calls.length).toBe(callsBeforePreCancellation + 1);
      const schemaDbBefore = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      const schemaCountBefore = schemaDbBefore.sqlite
        .prepare('SELECT COUNT(*) AS count FROM mcp_tool_schema_snapshots')
        .get();
      schemaDbBefore.sqlite.close();
      const duplicate = await connect('duplicate');
      await expect(duplicate.listTools()).rejects.toMatchObject({
        data: { code: 'mcp-server-unavailable' },
      });
      const whitespace = await connect('whitespace');
      await expect(whitespace.listTools()).rejects.toMatchObject({
        data: { code: 'mcp-server-unavailable' },
      });
      const schemaDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      try {
        expect(
          schemaDb.sqlite.prepare('SELECT COUNT(*) AS count FROM mcp_tool_schema_snapshots').get()
        ).toEqual(schemaCountBefore);
      } finally {
        schemaDb.sqlite.close();
      }
      const pinned = await connect('pinned');
      await expect(
        pinned.callTool({ arguments: { message: 'drift' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-schema-drift' } });
      const unavailable = await connect('unavailable');
      await expect(
        unavailable.callTool({ arguments: { message: 'offline' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-server-unavailable' } });

      const schemaCancel = await connect('schema-cancel');
      const schemaCancelBarrier = createListBarrier('schema-cancel');
      const schemaCancellation = new AbortController();
      const upstreamCallsBeforeSchemaCancellation = callTool.mock.calls.length;
      const schemaCancellationDb = openWorkspaceDb(
        dataRoot,
        'ws_00000000-0000-7000-8000-000000000001'
      );
      const usageBeforeSchemaCancellation = schemaCancellationDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM usage_records')
        .get();
      schemaCancellationDb.sqlite.close();
      const schemaCancelledCall = schemaCancel.callTool(
        { arguments: { message: 'schema-cancel' }, name: 'echo' },
        { signal: schemaCancellation.signal }
      );
      const schemaCancelledOutcome = schemaCancelledCall.then(
        () => null,
        (error: unknown) => error
      );
      const schemaCancellationSignal = await schemaCancelBarrier.entered;
      if (!schemaCancellationSignal) throw new Error('Expected a gateway cancellation signal.');
      const schemaCancellationObserved = new Promise<void>((resolve) => {
        if (schemaCancellationSignal.aborted) resolve();
        else schemaCancellationSignal.addEventListener('abort', () => resolve(), { once: true });
      });
      schemaCancellation.abort();
      await schemaCancellationObserved;
      schemaCancelBarrier.release();
      expect(String(await schemaCancelledOutcome)).toMatch(/AbortError/);
      // Client cancellation precedes server publication; drain its existing admission before the next call.
      await workspaceMutationAdmission.close('ws_00000000-0000-7000-8000-000000000001');
      workspaceMutationAdmission.reopen('ws_00000000-0000-7000-8000-000000000001');
      await vi.waitFor(() => {
        const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
        try {
          expect(
            workspaceDb.sqlite
              .prepare(
                `SELECT status
                 FROM capability_calls
                 WHERE provider_ref = 'schema-cancel'
                 ORDER BY rowid DESC
                 LIMIT 1`
              )
              .get()
          ).toEqual({ status: 'aborted' });
        } finally {
          workspaceDb.sqlite.close();
        }
      });
      expect(callTool).toHaveBeenCalledTimes(upstreamCallsBeforeSchemaCancellation);
      const afterSchemaCancellationDb = openWorkspaceDb(
        dataRoot,
        'ws_00000000-0000-7000-8000-000000000001'
      );
      expect(
        afterSchemaCancellationDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM usage_records')
          .get()
      ).toEqual(usageBeforeSchemaCancellation);
      afterSchemaCancellationDb.sqlite.close();

      const authorityRace = await connect('authority-race');
      const authorityBarrier = createListBarrier('authority-race');
      const upstreamCallsBeforeAuthorityRace = callTool.mock.calls.length;
      const authorityRaceCall = authorityRace.callTool({
        arguments: { message: 'authority-race' },
        name: 'echo',
      });
      await authorityBarrier.entered;
      coreDb.sqlite
        .prepare(
          `UPDATE workspace_members
           SET status = 'removed', removed_at = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = 'ws_00000000-0000-7000-8000-000000000001' AND user_id = 'usr_00000000-0000-7000-8000-000000000001'`
        )
        .run(new Date().toISOString(), new Date().toISOString());
      authorityBarrier.release();
      await expect(authorityRaceCall).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
      expect(callTool).toHaveBeenCalledTimes(upstreamCallsBeforeAuthorityRace);
      coreDb.sqlite
        .prepare(
          `UPDATE workspace_members
           SET status = 'active', removed_at = NULL, revision = revision + 1, updated_at = ?
           WHERE workspace_id = 'ws_00000000-0000-7000-8000-000000000001' AND user_id = 'usr_00000000-0000-7000-8000-000000000001'`
        )
        .run(new Date().toISOString());

      const itemCountBeforeAuditFailure = store.listAllItems().length;
      const auditFailureDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      try {
        auditFailureDb.sqlite.exec(`
          CREATE TRIGGER reject_mcp_finish_audit
          BEFORE INSERT ON audit_events
          WHEN NEW.action = 'capability.finish'
          BEGIN
            SELECT RAISE(ABORT, 'injected capability finish audit failure');
          END;
        `);
        const listServersFailure = await app.request('/api/worker-capabilities/mcp/_list-servers', {
          body: '{}',
          headers: {
            authorization: 'Bearer capability-token',
            'content-type': 'application/json',
          },
          method: 'POST',
        });
        const listServersFailureBody = await listServersFailure.json();
        expect(listServersFailureBody).toMatchObject({
          error: { data: { code: 'recovery_required' } },
        });
        expect(JSON.stringify(listServersFailureBody)).not.toContain(
          'injected capability finish audit failure'
        );
        await expect(echo.listTools()).rejects.toMatchObject({
          data: { code: 'recovery_required' },
        });
        await expect(
          echo.callTool({ arguments: { message: 'finish-audit-failure' }, name: 'echo' })
        ).rejects.toMatchObject({ data: { code: 'recovery_required' } });
        expect(store.listAllItems()).toHaveLength(itemCountBeforeAuditFailure);
      } finally {
        auditFailureDb.sqlite.exec('DROP TRIGGER IF EXISTS reject_mcp_finish_audit');
        auditFailureDb.sqlite.close();
      }

      const itemCountBeforeUsageFailure = store.listAllItems().length;
      const usageFailureDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      try {
        usageFailureDb.sqlite.exec(`
          CREATE TRIGGER reject_mcp_usage
          BEFORE INSERT ON usage_records
          BEGIN
            SELECT RAISE(ABORT, 'injected MCP usage failure');
          END;
        `);
        await expect(
          echo.callTool({ arguments: { message: 'usage-failure' }, name: 'echo' })
        ).rejects.toMatchObject({ data: { code: 'recovery_required' } });
        expect(store.listAllItems()).toHaveLength(itemCountBeforeUsageFailure);
      } finally {
        usageFailureDb.sqlite.exec('DROP TRIGGER IF EXISTS reject_mcp_usage');
        usageFailureDb.sqlite.close();
      }

      const itemCountBeforePublicationFailure = store.listAllItems().length;
      const createItem = vi.spyOn(store, 'createItem').mockImplementationOnce(() => {
        throw new Error('injected MCP Item publication failure');
      });
      await expect(
        echo.callTool({ arguments: { message: 'item-publication-failure' }, name: 'echo' })
      ).resolves.toMatchObject({ content: [{ text: 'item-publication-failure' }] });
      createItem.mockRestore();
      expect(store.listAllItems()).toHaveLength(itemCountBeforePublicationFailure);
      const terminalDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      const successfulUnpublished = terminalDb.sqlite
        .prepare(
          `SELECT call_id, item_id, status
           FROM capability_calls
           WHERE operation = 'mcp.call-tool'
           ORDER BY rowid DESC
           LIMIT 1`
        )
        .get() as { call_id: string; item_id: string; status: string };
      terminalDb.sqlite.close();
      expect(successfulUnpublished.status).toBe('succeeded');
      // Keep interrupted-call ledger recovery; Item repair has its own retained-history test.
      verifyAndMigrateExistingScopedDatabases(dataRoot);

      // Keep the active Tool Turn; the independent denial needs its own Thread.
      const deniedThread = await store.createThread(workspaceIdForOwner(turn.owner), 'MCP denial');
      const deniedTurn = await store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        deniedThread.id,
        'Reject unauthorized MCP use',
        {
          id: 'usr_00000000-0000-76a2-91eb-629d90835e80',
          kind: 'user',
        }
      );
      environmentPackage = resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSessionId: testEntityId('as', 'as_mcp_denied'),
        agentSetup: createTestAgentSetup({ mcpIds: ['echo'] }),
        backend: { kind: 'openshell' },
        createdAt: '2026-09-03T00:01:00.000Z',
        requestId: 'req_mcp_denied',
        triggerActor: deniedTurn.triggerActor,
        turn: deniedTurn,
        workspaceCwd: '/workspace',
        workspaceMcpServerCatalog: catalog,
        workspaceRoots: [],
      });
      const beforeDeniedDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      const beforeDenied = mcpEffectCounts(beforeDeniedDb);
      beforeDeniedDb.sqlite.close();
      const itemsBeforeDenied = store.listAllItems().length;
      const upstreamCallsBeforeDenied = callTool.mock.calls.length;
      await expect(
        echo.callTool({ arguments: { message: 'denied' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
      const afterDeniedDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      expect(mcpEffectCounts(afterDeniedDb)).toEqual(beforeDenied);
      afterDeniedDb.sqlite.close();
      expect(store.listAllItems()).toHaveLength(itemsBeforeDenied);
      expect(callTool).toHaveBeenCalledTimes(upstreamCallsBeforeDenied);
      expect(store.getTurnById(turn.id).status).toBe('running');

      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      applyScopedMigrations(workspaceDb);
      try {
        expect(
          workspaceDb.sqlite
            .prepare(
              `SELECT error_code, status FROM capability_calls
               WHERE operation = 'mcp.call-tool'
               ORDER BY rowid`
            )
            .all()
        ).toEqual([
          { error_code: null, status: 'succeeded' },
          { error_code: null, status: 'succeeded' },
          { error_code: 'mcp-tool-not-found', status: 'failed' },
          { error_code: 'mcp-invalid-arguments', status: 'failed' },
          { error_code: 'mcp-timeout', status: 'timed-out' },
          { error_code: 'mcp-call-failed', status: 'unknown' },
          { error_code: 'mcp-result-too-large', status: 'failed' },
          { error_code: 'mcp-call-failed', status: 'failed' },
          { error_code: 'mcp-call-failed', status: 'aborted' },
          { error_code: 'mcp-call-failed', status: 'aborted' },
          { error_code: 'mcp-schema-drift', status: 'failed' },
          { error_code: 'mcp-server-unavailable', status: 'failed' },
          { error_code: 'mcp-server-unavailable', status: 'aborted' },
          { error_code: 'mcp-denied', status: 'denied' },
          { error_code: 'capability_call_recovered_after_restart', status: 'unknown' },
          { error_code: 'usage_record_failed', status: 'failed' },
          { error_code: null, status: 'succeeded' },
        ]);
        expect(
          workspaceDb.sqlite.prepare('SELECT quantity, unit FROM usage_records').all()
        ).toEqual([
          { quantity: 1, unit: 'tool_calls' },
          { quantity: 1, unit: 'tool_calls' },
          { quantity: 1, unit: 'tool_calls' },
          { quantity: 1, unit: 'tool_calls' },
          { quantity: 1, unit: 'tool_calls' },
          { quantity: 1, unit: 'tool_calls' },
          { quantity: 1, unit: 'tool_calls' },
          { quantity: 1, unit: 'tool_calls' },
          { quantity: 1, unit: 'tool_calls' },
        ]);
      } finally {
        workspaceDb.sqlite.close();
      }
      environmentPackage = authorizedEnvironmentPackage;
      const emptyNearLimitTools = [
        { inputSchema: { description: '', type: 'object' as const }, name: 'echo' },
      ];
      const nearLimitTools = [
        {
          inputSchema: {
            description: 'x'.repeat(
              512 * 1024 - Buffer.byteLength(JSON.stringify(emptyNearLimitTools), 'utf8')
            ),
            type: 'object' as const,
          },
          name: 'echo',
        },
      ];
      nearLimitListing = nearLimitTools;
      const nearLimit = await connect('near-limit');
      expect(Buffer.byteLength(JSON.stringify(nearLimitTools), 'utf8')).toBe(512 * 1024);
      const nearLimitList = await nearLimit.listTools();
      expect(Buffer.byteLength(JSON.stringify(nearLimitList.tools), 'utf8')).toBe(512 * 1024);
      const nearLimitListDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      expect(
        nearLimitListDb.sqlite
          .prepare(
            `SELECT error_code, status
             FROM capability_calls
             WHERE operation = 'mcp.list-tools'
             ORDER BY rowid DESC
             LIMIT 1`
          )
          .get()
      ).toEqual({ error_code: null, status: 'succeeded' });
      nearLimitListDb.sqlite.close();
      expect(Buffer.byteLength(JSON.stringify(nearLimitResult), 'utf8')).toBe(512 * 1024);
      expect(
        Buffer.byteLength(
          JSON.stringify({ id: 'near-limit-id', jsonrpc: '2.0', result: nearLimitResult }),
          'utf8'
        )
      ).toBeGreaterThan(512 * 1024);
      const nearLimitResponse = await rawCall('near-limit-id', 'near-limit');
      expect(nearLimitResponse.status).toBe(200);
      await expect(nearLimitResponse.json()).resolves.toMatchObject({
        id: 'near-limit-id',
        result: nearLimitResult,
      });
      const nearLimitDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      expect(
        nearLimitDb.sqlite
          .prepare(
            `SELECT error_code, status
             FROM capability_calls
             WHERE operation = 'mcp.call-tool'
             ORDER BY rowid DESC
             LIMIT 1`
          )
          .get()
      ).toEqual({ error_code: null, status: 'succeeded' });
      nearLimitDb.sqlite.close();
      await workspaceMutationAdmission.close('ws_00000000-0000-7000-8000-000000000001');
      const workspaceRoot = join(dataRoot, 'workspaces', 'ws_00000000-0000-7000-8000-000000000001');
      await shutdownControlStoreWorkerClient();
      rmSync(workspaceRoot, { recursive: true });
      const staleRequest = await rawCall('stale-after-delete');
      expect(staleRequest.status).toBe(200);
      await expect(staleRequest.json()).resolves.toMatchObject({
        error: { data: { code: 'mcp-denied' } },
        id: 'stale-after-delete',
      });
      expect(existsSync(workspaceRoot)).toBe(false);
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it.each([
    'permission',
    'EPERM',
    'EIO',
    'EMFILE',
    'malformed-json',
    'schema',
    'digest',
    'lineage',
    'noncanonical',
    'programming',
    'coded-programming',
  ] as const)('defers only unavailable named snapshot storage during real MCP boot reconciliation: %s', async (failure) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-mcp-backfill-unavailable-'));
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const store = await createRetainedDemoStore(
      { dataRoot },
      ['0_unavailable', '1_healthy'].map((suffix, index) => ({
        name: `MCP backfill ${suffix}`,
        input: 'Recover decided MCP publication',
        agentId: 'agent_codex_host',
        timestamp: `2026-09-22T00:00:0${index}.000Z`,
      }))
    );
    const coreDb = openCoreDb(dataRoot);
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    const packages: AgentEnvironmentPackage[] = [];
    const calls: ReturnType<typeof startCapabilityCall>[] = [];
    let restoreRead: (() => void) | undefined;
    let unavailableDirectory: string | undefined;
    try {
      for (const suffix of ['0_unavailable', '1_healthy']) {
        const thread = store
          .listThreads(workspaceId)
          .find((row) => row.name === `MCP backfill ${suffix}`)!;
        const turn = store.listThreadTurns(workspaceId, thread.id)[0]!;
        const session = store.getAgentSession(turn.agentSessionId!);
        expect(turn).toMatchObject({
          status: 'completed',
          agentId: session.agentId,
          agentSessionId: session.id,
        });
        expect(session).toMatchObject({ workspaceId, threadId: turn.threadId, status: 'idle' });
        const environmentPackage = resolveAgentEnvironmentPackage({
          coreDb,
          agentSetup: createTestAgentSetup(),
          agentSessionId: session.id,
          backend: { kind: 'openshell' },
          requestId: `req_mcp_${suffix}`,
          createdAt: turn.startedAt!,
          triggerActor: turn.triggerActor,
          turn,
          turnInput: 'Recover decided MCP publication',
          workspaceCwd: null,
          workspaceRoots: [],
        });
        recordAgentEnvironmentPackageSnapshot(workspaceDb, {
          environmentPackage,
          createdAt: turn.startedAt!,
        });
        expect(
          snapshotLedger.findNamedAgentEnvironmentPackageSnapshot(
            workspaceDb,
            workspaceId,
            session.id,
            environmentPackage.snapshotId
          )
        ).toMatchObject({
          workspaceId,
          threadId: thread.id,
          turnId: turn.id,
          agentSessionId: session.id,
          snapshotId: environmentPackage.snapshotId,
        });
        packages.push(environmentPackage);
        const call = startCapabilityCall({
          workspaceDb,
          workspaceId,
          authorityActor: turn.triggerActor,
          agentId: session.agentId,
          agentSessionId: session.id,
          callId: testEntityId('cap', `cap_mcp_${suffix}`),
          itemId: testEntityId('it', `it_mcp_${suffix}`),
          capabilityId: 'mcp.call-tool',
          family: 'mcp',
          operation: 'mcp.call-tool',
          packageSnapshotId: environmentPackage.snapshotId,
          providerRef: 'echo',
          serviceRef: 'mcp-tool:echo',
          redactionClass: 'metadata-only',
          threadId: thread.id,
          turnId: turn.id,
          now: new Date(turn.startedAt!),
        });
        finishCapabilityCall({
          callId: call.id,
          status: 'succeeded',
          workspaceDb,
          now: new Date(turn.completedAt!),
        });
        calls.push(call);
      }
      verifyAndMigrateExistingScopedDatabases(dataRoot);
      const selected = packages[0]!;
      // Observe the real named reader's file effect; do not duplicate another owner's path layout.
      let snapshotPath = '';
      const originalRead = fs.readFileSync;
      const locate = vi.spyOn(fs, 'readFileSync').mockImplementation(((
        ...args: Parameters<typeof fs.readFileSync>
      ) => {
        if (typeof args[0] === 'string') snapshotPath = args[0];
        return originalRead(...args);
      }) as typeof fs.readFileSync);
      syncBuiltinESMExports();
      try {
        expect(
          snapshotLedger.findNamedAgentEnvironmentPackageSnapshot(
            workspaceDb,
            workspaceId,
            selected.scope.agentSessionId,
            selected.snapshotId
          )
        ).toMatchObject({ snapshotId: selected.snapshotId, turnId: selected.scope.turnId });
      } finally {
        locate.mockRestore();
        syncBuiltinESMExports();
      }
      expect(snapshotPath).not.toBe('');
      const snapshotsRoot = dirname(snapshotPath);
      const originalBytes = readFileSync(snapshotPath, 'utf8');
      const beforeItems = store.listAllItems();
      const beforeEvents = packages.map((pkg) => store.getTurnEvents(pkg.scope.turnId));
      const beforeCalls = listWorkspaceCapabilityCalls(workspaceDb, workspaceId);
      const beforeUsage = listWorkspaceUsageRecords(workspaceDb, workspaceId);
      // Capability Usage lifecycle: one retained successful call for each of the two source requests.
      expect(beforeCalls).toHaveLength(2);
      expect(beforeCalls).toEqual(
        expect.arrayContaining(
          packages.map((pkg, index) =>
            expect.objectContaining({
              id: calls[index]!.id,
              status: 'succeeded',
              agentSessionId: pkg.scope.agentSessionId,
              threadId: pkg.scope.threadId,
              turnId: pkg.scope.turnId,
              packageSnapshotId: pkg.snapshotId,
            })
          )
        )
      );
      expect(
        beforeItems.some((item) => calls.some((call) => call.context.itemId === item.id))
      ).toBe(false);
      let injections = 0;
      let fault: Error | undefined;
      if (failure === 'permission') {
        chmodSync(snapshotsRoot, 0);
        unavailableDirectory = snapshotsRoot;
        expect(() => lstatSync(snapshotPath)).toThrow(expect.objectContaining({ code: 'EACCES' }));
      } else if (failure === 'noncanonical') {
        rmSync(snapshotPath);
        symlinkSync(join(snapshotsRoot, 'missing-target'), snapshotPath);
      } else if (['malformed-json', 'schema', 'digest', 'lineage'].includes(failure)) {
        const record = JSON.parse(originalBytes);
        if (failure === 'digest') record.contentDigest = '0'.repeat(64);
        if (failure === 'lineage') record.threadId = testEntityId('th', 'th_contradictory');
        writeFileSync(
          snapshotPath,
          failure === 'malformed-json' ? '{' : failure === 'schema' ? '{}' : JSON.stringify(record)
        );
      } else {
        fault =
          failure === 'programming'
            ? new TypeError('Unexpected named-file read failure.')
            : Object.assign(new Error('Named-file read fault.'), {
                code: failure === 'coded-programming' ? 'EIO' : failure,
                ...(failure === 'coded-programming'
                  ? {}
                  : {
                      syscall: 'read',
                      errno: failure === 'EIO' ? -5 : failure === 'EMFILE' ? -24 : -1,
                      path: snapshotPath,
                    }),
              });
      }
      let inspections = 0;
      const originalLstat = fs.lstatSync;
      const inspect = vi.spyOn(fs, 'lstatSync').mockImplementation(((
        ...args: Parameters<typeof fs.lstatSync>
      ) => {
        if (args[0] === snapshotPath) inspections += 1;
        return originalLstat(...args);
      }) as typeof fs.lstatSync);
      const readFault = vi.spyOn(fs, 'readFileSync').mockImplementation(((
        ...args: Parameters<typeof fs.readFileSync>
      ) => {
        if (args[0] === snapshotPath && fault) {
          injections += 1;
          throw fault;
        }
        return originalRead(...args);
      }) as typeof fs.readFileSync);
      syncBuiltinESMExports();
      restoreRead = () => {
        inspect.mockRestore();
        readFault.mockRestore();
        syncBuiltinESMExports();
      };
      // Core Protocol Turn Lifecycle permits only the exact already-decided missing Item.
      const unavailable = ['permission', 'EPERM', 'EIO', 'EMFILE'].includes(failure);
      if (unavailable) {
        expect(await reconcileWorkerMcpItems(dataRoot, store)).toBe(1);
        expect(await reconcileWorkerMcpItems(dataRoot, store)).toBe(0);
        expect(
          store.listAllItems().filter((item) => !beforeItems.some((prior) => prior.id === item.id))
        ).toEqual([
          expect.objectContaining({
            id: calls[1]!.context.itemId,
            causationId: calls[1]!.id,
            status: 'completed',
          }),
        ]);
        expect(
          store.listAllItems().find((item) => item.id === calls[0]!.context.itemId)
        ).toBeUndefined();
        expect(store.getTurnEvents(selected.scope.turnId)).toEqual(beforeEvents[0]);
        if (unavailableDirectory) {
          chmodSync(unavailableDirectory, 0o700);
          unavailableDirectory = undefined;
        }
        restoreRead?.();
        restoreRead = undefined;
        expect(await reconcileWorkerMcpItems(dataRoot, store)).toBe(1);
        expect(await reconcileWorkerMcpItems(dataRoot, store)).toBe(0);
        expect(
          store.listAllItems().find((item) => item.id === calls[0]!.context.itemId)
        ).toMatchObject({
          causationId: calls[0]!.id,
          status: 'completed',
        });
      } else {
        await expect(reconcileWorkerMcpItems(dataRoot, store)).rejects.toBeInstanceOf(Error);
        expect(store.listAllItems()).toEqual(beforeItems);
        packages.forEach((pkg, index) => {
          expect(store.getTurnEvents(pkg.scope.turnId)).toEqual(beforeEvents[index]);
        });
      }
      expect(inspections).toBeGreaterThan(0);
      if (
        !['permission', 'noncanonical', 'malformed-json', 'schema', 'digest', 'lineage'].includes(
          failure
        )
      ) {
        expect(injections).toBeGreaterThan(0);
      }
      restoreRead?.();
      restoreRead = undefined;
      await shutdownControlStoreWorkerClient();
      const reopened = openWorkspaceDb(dataRoot, workspaceId);
      try {
        expect(listWorkspaceCapabilityCalls(reopened, workspaceId)).toEqual(beforeCalls);
        expect(listWorkspaceUsageRecords(reopened, workspaceId)).toEqual(beforeUsage);
      } finally {
        reopened.sqlite.close();
      }
    } finally {
      if (unavailableDirectory) chmodSync(unavailableDirectory, 0o700);
      restoreRead?.();
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('recreates a missing terminal Item without changing its successful call', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-item-recovery-'));
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const store = await createRetainedDemoStore({ dataRoot }, [
      {
        name: 'MCP terminal Item recovery',
        input: 'Recover the MCP Item',
        agentId: 'agent_codex_host',
        timestamp: '2026-09-22T00:00:00.000Z',
      },
    ]);
    const thread = store
      .listThreads(workspaceId)
      .find((row) => row.name === 'MCP terminal Item recovery')!;
    const turn = store.listThreadTurns(workspaceId, thread.id)[0]!;
    const session = store.getAgentSession(turn.agentSessionId!);
    const coreDb = openCoreDb(dataRoot);
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    let beforeCalls: ReturnType<typeof listWorkspaceCapabilityCalls> = [];
    let beforeUsage: ReturnType<typeof listWorkspaceUsageRecords> = [];
    try {
      expect(turn).toMatchObject({
        status: 'completed',
        agentId: session.agentId,
        agentSessionId: session.id,
      });
      const environmentPackage = resolveAgentEnvironmentPackage({
        coreDb,
        agentSetup: createTestAgentSetup(),
        agentSessionId: session.id,
        backend: { kind: 'openshell' },
        requestId: 'req_mcp_recovery',
        createdAt: turn.startedAt!,
        triggerActor: turn.triggerActor,
        turn,
        turnInput: 'Recover the MCP Item',
        workspaceCwd: null,
        workspaceRoots: [],
      });
      recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        environmentPackage,
        createdAt: turn.startedAt!,
      });
      expect(environmentPackage.scope).toMatchObject({
        workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        agentSessionId: session.id,
      });
      const call = startCapabilityCall({
        agentId: session.agentId,
        agentSessionId: session.id,
        authorityActor: turn.triggerActor,
        callId: testEntityId('cap', 'cap_mcp_recovery'),
        capabilityId: 'mcp.call-tool',
        family: 'mcp',
        itemId: testEntityId('it', 'it_mcp_recovery'),
        operation: 'mcp.call-tool',
        now: new Date(turn.startedAt!),
        packageSnapshotId: environmentPackage.snapshotId,
        providerRef: 'echo',
        redactionClass: 'metadata-only',
        serviceRef: 'mcp-tool:echo',
        threadId: turn.threadId,
        turnId: turn.id,
        workspaceDb,
        workspaceId: workspaceIdForOwner(turn.owner),
      });
      finishCapabilityCall({
        callId: call.id,
        status: 'succeeded',
        workspaceDb,
        now: new Date(turn.completedAt!),
      });
      beforeCalls = listWorkspaceCapabilityCalls(workspaceDb, workspaceId);
      beforeUsage = listWorkspaceUsageRecords(workspaceDb, workspaceId);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }

    await shutdownControlStoreWorkerClient();
    verifyAndMigrateExistingScopedDatabases(dataRoot);
    const coldStore = new FsStore({ dataRoot });
    expect(coldStore.getTurnById(turn.id).items).not.toContainEqual(
      expect.objectContaining({ id: testEntityId('it', 'it_mcp_recovery') })
    );
    expect(await reconcileWorkerMcpItems(dataRoot, coldStore)).toBe(1);
    expect(await reconcileWorkerMcpItems(dataRoot, coldStore)).toBe(0);
    expect(coldStore.getTurnById(turn.id).items).toContainEqual(
      expect.objectContaining({
        causationId: testEntityId('cap', 'cap_mcp_recovery'),
        id: testEntityId('it', 'it_mcp_recovery'),
        server: 'echo',
        status: 'completed',
        tool: 'echo',
      })
    );
    const recoveredWorkspaceDb = openWorkspaceDb(
      dataRoot,
      'ws_00000000-0000-7000-8000-000000000001'
    );
    try {
      expect(listWorkspaceCapabilityCalls(recoveredWorkspaceDb, workspaceId)).toEqual(beforeCalls);
      expect(listWorkspaceCapabilityCalls(recoveredWorkspaceDb, workspaceId)).toContainEqual(
        expect.objectContaining({
          id: testEntityId('cap', 'cap_mcp_recovery'),
          status: 'succeeded',
        })
      );
      expect(listWorkspaceUsageRecords(recoveredWorkspaceDb, workspaceId)).toEqual(beforeUsage);
    } finally {
      recoveredWorkspaceDb.sqlite.close();
    }
  });

  it.each([
    ['raw', 'target'],
    ['bearer', 'target'],
    ['raw', 'imported-history'],
    ['bearer', 'imported-history'],
  ] as const)('enforces HTTP %s grant issuance %s and explicit replacement binding', async (presentation, issuance) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-vault-'));
    const upstreamOptions: { credentialListEcho?: string } = {};
    const upstream = await createMcpHttpStub(upstreamOptions);
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Call HTTP MCP',
      {
        id: 'usr_00000000-0000-7000-8000-000000000001',
        kind: 'user',
      }
    );
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 7) });
    const vaultCanary = 'vault-"quoted\\slash';
    vaultUnlockState.backend().store({
      material: vaultCanary,
      metadata: { ownerScope: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      referenceId: 'vault_00000000-0000-7e35-8665-00e561f3dbc4',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://workspace/vault_00000000-0000-7e35-8665-00e561f3dbc4',
      displayName: 'HTTP MCP token',
      ownerScope: 'workspace',
      referenceId: 'vault_00000000-0000-7e35-8665-00e561f3dbc4',
      secretKind: 'http-bearer',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const grant = createVaultGrant(coreDb, {
      allowedInjectionPaths: ['gateway-only'],
      grantId: 'grant_00000000-0000-7018-b534-d496e34b4c6a',
      lifetime: 'workspace',
      ownerScope: 'workspace',
      targetCapabilityId: null,
      vaultReferenceId: 'vault_00000000-0000-7e35-8665-00e561f3dbc4',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const catalog = {
      schemaVersion: 1 as const,
      servers: [
        {
          allowedTools: ['echo'],
          credentialBindings: [
            {
              presentation,
              sink: { kind: 'header' as const, name: 'authorization' },
              slot: 'auth',
              vaultGrantId: 'grant_00000000-0000-7018-b534-d496e34b4c6a',
            },
          ],
          enabled: true,
          id: 'http-echo',
          pinnedSchemaSnapshotId: null,
          schemaPolicy: 'tracking' as const,
          // This fixture proves Vault admission and secrecy; no assertion needs a timeout.
          timeoutMs: 10_000,
          transport: { endpoint: upstream.url, kind: 'http' as const },
        },
      ],
    };
    let activeCatalog = catalog;
    let environmentPackage = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId: testEntityId('as', 'as_mcp_vault'),
      agentSetup: createTestAgentSetup({ mcpIds: ['http-echo'] }),
      backend: { kind: 'openshell' },
      createdAt: '2026-09-03T00:00:00.000Z',
      requestId: 'req_mcp_vault',
      triggerActor: turn.triggerActor,
      turn,
      workspaceCwd: '/workspace',
      workspaceMcpServerCatalog: catalog,
      workspaceRoots: [],
    });
    recordMcpWorkerLineage(coreDb, environmentPackage);
    const workerControlGateway = {
      authenticatePackageToken: vi.fn(() => environmentPackage),
    } as unknown as WorkerControlGateway;
    const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
    const app = new Hono();
    registerWorkerMcpRoutes({
      app,
      coreDb,
      runtimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          dataRoot,
          agentManifests: [],
          workspaceMcpServerCatalogs: [
            {
              catalog: activeCatalog,
              path: join(dataRoot, 'catalog/catalog.json'),
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            },
          ],
        }),
      store,
      vaultUnlockState,
      workerControlGateway,
      workerMcpGateway,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    const client = new Client({ name: 'vault-route-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL('http://nanocore.test/api/worker-capabilities/mcp/http-echo'),
      {
        fetch: (request, init) => app.fetch(new Request(request, init)),
        requestInit: { headers: { authorization: 'Bearer capability-token' } },
      }
    );

    try {
      await client.connect(transport);
      if (issuance === 'imported-history') {
        coreDb.sqlite.prepare('DELETE FROM vault_grants WHERE grant_id = ?').run(grant.grantId);
        importWorkspaceVaultGrants(coreDb, [grant]);
        const resolve = vi.spyOn(vaultUnlockState.backend(), 'resolve');
        const upstreamBefore = upstream.observed.length;
        const plansBefore = coreDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM vault_injection_plans')
          .get();
        const receiptsBefore = coreDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts')
          .get();
        await expect(
          client.callTool({ arguments: { message: 'blocked history' }, name: 'echo' })
        ).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
        expect(resolve).not.toHaveBeenCalled();
        expect(upstream.observed).toHaveLength(upstreamBefore);
        expect(
          coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_injection_plans').get()
        ).toEqual(plansBefore);
        expect(
          coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts').get()
        ).toEqual(receiptsBefore);
        resolve.mockRestore();
        return;
      }
      const initializationsBeforeCall = upstream.observed.filter((request) =>
        request.endsWith('|initialize')
      ).length;
      const terminationsBeforeCall = upstream.observed.filter((request) =>
        request.endsWith('|DELETE|')
      ).length;
      const result = await client.callTool({ arguments: { message: 'safe' }, name: 'echo' });
      expect(result).toMatchObject({ content: [{ text: 'safe' }] });
      expect(upstream.observed.filter((request) => request.endsWith('|initialize'))).toHaveLength(
        initializationsBeforeCall + 1
      );
      expect(upstream.observed.filter((request) => request.endsWith('|DELETE|'))).toHaveLength(
        terminationsBeforeCall + 1
      );
      expect(
        upstream.observed.some((request) =>
          request.startsWith(`${presentation === 'bearer' ? 'Bearer ' : ''}${vaultCanary}||`)
        )
      ).toBe(true);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_injection_plans').get()
      ).toEqual({ count: 1 });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts').get()
      ).toEqual({ count: 1 });
      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      applyScopedMigrations(workspaceDb);
      try {
        expect(workspaceDb.sqlite.prepare('SELECT outcome FROM vault_use_records').all()).toEqual([
          { outcome: 'succeeded' },
        ]);
        expect(
          workspaceDb.sqlite.prepare('SELECT category, unit, quantity FROM usage_records').all()
        ).toEqual([{ category: 'tool', quantity: 1, unit: 'tool_calls' }]);
        const exportApp = createApp({
          coreDb,
          dataRoot,
          store,
          turnExecutor: new SimulatedTurnExecutor(),
          workerMcpGateway,
        });
        const exportResponse = await exportApp.request(
          ...operationRequest(
            'workspace.export',
            { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
            {
              method: 'POST',
            }
          )
        );
        expect(exportResponse.status).toBe(200);
        const exported = WorkspaceExportResponseSchema.parse(await exportResponse.json());
        const exportRoot = join(
          dataRoot,
          'server',
          'exports',
          'workspaces',
          'ws_00000000-0000-7000-8000-000000000001',
          exported.exportId
        );
        const publicAndDurableValues = [
          environmentPackage,
          result,
          store.listAllItems(),
          store.listThreadTurns(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          ),
          store.listCommandRequests(),
          readDatabaseRows(coreDb.sqlite),
          readDatabaseRows(workspaceDb.sqlite),
          exported,
        ];
        expect(
          publicAndDurableValues.every((value) => !containsExactString(value, vaultCanary))
        ).toBe(true);
        const encodedCanary = JSON.stringify(vaultCanary).slice(1, -1);
        const publicAndDurableBytes = [
          ...publicAndDurableValues.map((value) => JSON.stringify(value)),
          ...exported.checkedFiles.map((path) => readFileSync(join(exportRoot, path), 'utf8')),
        ];
        expect(
          publicAndDurableBytes.every(
            (bytes) => !bytes.includes(vaultCanary) && !bytes.includes(encodedCanary)
          )
        ).toBe(true);
      } finally {
        workspaceDb.sqlite.close();
      }

      const schemaDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      const snapshotCount = schemaDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM mcp_tool_schema_snapshots')
        .get();
      schemaDb.sqlite.close();
      const receiptsBeforeMetadataLeak = coreDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts')
        .get() as { count: number };
      upstreamOptions.credentialListEcho = vaultCanary;
      await expect(
        client.callTool({ arguments: { message: 'metadata-leak' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-server-unavailable' } });
      delete upstreamOptions.credentialListEcho;
      const rejectedSchemaDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      expect(
        rejectedSchemaDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM mcp_tool_schema_snapshots')
          .get()
      ).toEqual(snapshotCount);
      rejectedSchemaDb.sqlite.close();
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts').get()
      ).toEqual({ count: receiptsBeforeMetadataLeak.count + 1 });

      const toolCallsBeforeReceiptFailure = upstream.observed.filter((request) =>
        request.endsWith('|tools/call')
      ).length;
      coreDb.sqlite.exec(`
        CREATE TRIGGER reject_mcp_receipt
        BEFORE INSERT ON vault_injection_receipts
        BEGIN
          SELECT RAISE(ABORT, 'injected MCP receipt failure');
        END
      `);
      try {
        await expect(
          client.callTool({ arguments: { message: 'receipt-failure' }, name: 'echo' })
        ).rejects.toMatchObject({ data: { code: 'recovery_required' } });
      } finally {
        coreDb.sqlite.exec('DROP TRIGGER IF EXISTS reject_mcp_receipt');
      }
      expect(upstream.observed.filter((request) => request.endsWith('|tools/call'))).toHaveLength(
        toolCallsBeforeReceiptFailure
      );
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts').get()
      ).toEqual({ count: receiptsBeforeMetadataLeak.count + 1 });

      await expect(
        client.callTool({ arguments: { message: 'reestablish' }, name: 'echo' })
      ).resolves.toMatchObject({ content: [{ text: 'reestablish' }] });
      const oldResolved = resolveWorkspaceMcpServer({ catalog, serverId: 'http-echo' });
      expect(
        workerMcpGateway.getServerHealth({
          server: oldResolved,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        })
      ).toBe('inactive');

      const toolCallsBeforeMalformedExpiry = upstream.observed.filter((request) =>
        request.endsWith('|tools/call')
      ).length;
      const receiptsBeforeMalformedExpiry = coreDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts')
        .get();
      const useDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      const usesBeforeMalformedExpiry = useDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM vault_use_records')
        .get();
      useDb.sqlite.close();
      coreDb.sqlite
        .prepare('UPDATE vault_grants SET expires_at = ? WHERE grant_id = ?')
        .run('not-a-date', 'grant_00000000-0000-7018-b534-d496e34b4c6a');
      const closeFailure = vi
        .spyOn(workerMcpGateway, 'closeServer')
        .mockRejectedValueOnce(new Error('injected credential cleanup failure'));
      await expect(
        client.callTool({ arguments: { message: 'malformed-expiry' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'recovery_required' } });
      closeFailure.mockRestore();
      expect(upstream.observed.filter((request) => request.endsWith('|tools/call'))).toHaveLength(
        toolCallsBeforeMalformedExpiry
      );
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts').get()
      ).toEqual(receiptsBeforeMalformedExpiry);
      const rejectedUseDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      expect(
        rejectedUseDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_use_records').get()
      ).toEqual(usesBeforeMalformedExpiry);
      rejectedUseDb.sqlite.close();
      coreDb.sqlite
        .prepare('UPDATE vault_grants SET expires_at = NULL WHERE grant_id = ?')
        .run('grant_00000000-0000-7018-b534-d496e34b4c6a');

      const toolCallsBeforeRevoke = upstream.observed.filter((request) =>
        request.endsWith('|tools/call')
      ).length;
      const replacement = narrowVaultGrant(coreDb, {
        grantId: 'grant_00000000-0000-7018-b534-d496e34b4c6a',
        replacementGrantId: testEntityId('grant', 'grant_mcp_http_narrowed'),
        constraints: {
          targetAgentId: environmentPackage.agent.agentId,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
      activeCatalog = {
        ...catalog,
        servers: [{ ...catalog.servers[0], timeoutMs: catalog.servers[0]!.timeoutMs + 1 }],
      };
      environmentPackage = resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSessionId: testEntityId('as', 'as_mcp_vault'),
        agentSetup: createTestAgentSetup({ mcpIds: ['http-echo'] }),
        backend: { kind: 'openshell' },
        createdAt: '2026-09-03T00:01:00.000Z',
        requestId: 'req_mcp_vault_reconfigured',
        triggerActor: turn.triggerActor,
        turn,
        workspaceCwd: '/workspace',
        workspaceMcpServerCatalog: activeCatalog,
        workspaceRoots: [],
      });
      await expect(
        client.callTool({ arguments: { message: 'blocked' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
      expect(upstream.observed.filter((request) => request.endsWith('|tools/call'))).toHaveLength(
        toolCallsBeforeRevoke
      );
      expect(
        workerMcpGateway.getServerHealth({
          server: oldResolved,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        })
      ).toBe('inactive');
      activeCatalog = {
        ...catalog,
        servers: [
          {
            ...catalog.servers[0]!,
            credentialBindings: [
              {
                ...catalog.servers[0]!.credentialBindings[0]!,
                vaultGrantId: replacement.grant.grantId,
              },
            ],
          },
        ],
      };
      await store.updateTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      const closing = markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: testEntityId('attempt', `lease_${turn.id}`),
        cause: 'worker-final-status',
        outcomeRef: `turn:${turn.id}:completed`,
      });
      // This fixture submits no Worker. All fake upstream exchanges completed and the old route is inactive.
      const proof = {
        terminalHandoff: true,
        output: true,
        evidence: true,
        outsideWorkspaceCollection: true,
        integrationDrain: true,
        routesRevoked: true,
      } as const;
      const correlation = schedulerExecutionCorrelation(closing);
      const release = await new SimulatedTurnExecutor({ coreDb }).release({
        ...correlation,
        proof,
      });
      closeSchedulerExecutionAttemptWithFence(coreDb, {
        correlation,
        proof,
        fenceRef: release.fenceRef!,
      });
      const replacementTurn = await store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Use the explicitly rebound grant',
        turn.triggerActor
      );
      environmentPackage = resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSessionId: testEntityId('as', 'as_mcp_rebound'),
        agentSetup: createTestAgentSetup({ mcpIds: ['http-echo'] }),
        backend: { kind: 'openshell' },
        createdAt: new Date().toISOString(),
        requestId: randomUUID(),
        triggerActor: turn.triggerActor,
        turn: replacementTurn,
        workspaceCwd: '/workspace',
        workspaceMcpServerCatalog: activeCatalog,
        workspaceRoots: [],
      });
      recordMcpWorkerLineage(coreDb, environmentPackage);
      await expect(
        client.callTool({ arguments: { message: 'explicit replacement' }, name: 'echo' })
      ).resolves.toMatchObject({ content: [{ text: 'explicit replacement' }] });
      expect(upstream.observed.filter((request) => request.endsWith('|tools/call'))).toHaveLength(
        toolCallsBeforeRevoke + 1
      );
    } finally {
      await client.close();
      await workerMcpGateway.close();
      await upstream.close();
      vaultUnlockState.lock();
      coreDb.sqlite.close();
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

/** Reads every durable row in a test database for credential-canary assertions. */
function readDatabaseRows(
  sqlite: ReturnType<typeof openCoreDb>['sqlite']
): Record<string, unknown> {
  const tables = sqlite
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all() as Array<{ readonly name: string }>;
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    ])
  );
}

/** Returns whether an object tree contains an exact string in a key or value. */
function containsExactString(value: unknown, expected: string): boolean {
  if (typeof value === 'string') return value.includes(expected);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, child]) => key.includes(expected) || containsExactString(child, expected)
  );
}

/** Reads the Workspace effect counts that an unauthorized MCP request must not change. */
function mcpEffectCounts(workspaceDb: ReturnType<typeof openWorkspaceDb>) {
  return Object.fromEntries(
    ['audit_events', 'capability_calls', 'permission_decisions', 'usage_records'].map((table) => [
      table,
      workspaceDb.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
    ])
  );
}

/** Returns one valid tool declaration for MCP route fixtures. */
function mcpEchoTool() {
  return {
    inputSchema: {
      additionalProperties: false,
      properties: { message: { type: 'string' } },
      required: ['message'],
      type: 'object',
    },
    name: 'echo',
  };
}

// This fixture supplies confirmed image evidence; the production resolver and subject checks still run.
vi.mock('./runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    './test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});

/** Observes actual successful SQLite commit boundaries, including native transaction statements. */
function observeMcpPhysicalCommits(workspacePath: string) {
  type Statement = ReturnType<Database.Database['prepare']>;
  const sample = new Database(':memory:');
  const statementPrototype = Object.getPrototypeOf(sample.prepare('SELECT 1'));
  sample.close();
  const pending = new Map<Database.Database, string[]>();
  const savepoints = new Map<Database.Database, number[]>();
  const commits: string[][] = [];
  let active = true;
  let stopped = false;
  let beforeCommit: (() => void) | undefined;
  let afterCommit: ((writes: string[]) => void) | undefined;
  const spies = (['run', 'get', 'all'] as const).map((method) => {
    const original = statementPrototype[method];
    return vi.spyOn(statementPrototype, method).mockImplementation(function (
      this: Statement,
      ...args: unknown[]
    ) {
      const db = this.database;
      if (!active || db.name !== workspacePath) return original.apply(this, args);
      const sql = this.source.trim();
      const commit = /^COMMIT\b/i.test(sql);
      const rollback = /^ROLLBACK\b/i.test(sql);
      const control = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql);
      const write = !this.readonly && !control && /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
      if (stopped && !rollback && (write || commit || /^BEGIN\b/i.test(sql))) {
        throw new Error('Injected process cut: no later write is admitted.');
      }
      if (commit) beforeCommit?.();
      const inTransaction = db.inTransaction;
      const result = original.apply(this, args);
      // Native nested transactions share one savepoint name; their stack keeps only surviving writes.
      if (/^SAVEPOINT\b/i.test(sql)) {
        const lengths = savepoints.get(db) ?? [];
        lengths.push(pending.get(db)?.length ?? 0);
        savepoints.set(db, lengths);
      }
      if (/^ROLLBACK\s+TO\b/i.test(sql)) {
        const length = savepoints.get(db)?.at(-1);
        if (length !== undefined) pending.get(db)?.splice(length);
      }
      if (/^RELEASE\b/i.test(sql)) savepoints.get(db)?.pop();
      if (rollback && !db.inTransaction) {
        pending.delete(db);
        savepoints.delete(db);
      }
      if (write) {
        const changes = (result as { changes?: number } | undefined)?.changes;
        if (changes === undefined || changes > 0) {
          const writes = pending.get(db) ?? [];
          writes.push(sql.replace(/\s+/g, ' '));
          pending.set(db, writes);
          if (!inTransaction && !db.inTransaction) {
            commits.push(writes);
            pending.delete(db);
            afterCommit?.(writes);
          }
        }
      }
      if (commit) {
        savepoints.delete(db);
        const writes = pending.get(db);
        if (writes?.length) {
          commits.push(writes);
          pending.delete(db);
          afterCommit?.(writes);
        }
      }
      return result;
    });
  });
  return {
    commits,
    inTransaction() {
      return [...pending.keys()].some((db) => db.inTransaction);
    },
    stop() {
      stopped = true;
    },
    beforeCommit(callback: () => void) {
      beforeCommit = callback;
    },
    afterCommit(callback: (writes: string[]) => void) {
      afterCommit = callback;
    },
    reset() {
      commits.length = 0;
      pending.clear();
      savepoints.clear();
    },
    restore() {
      active = false;
      spies.forEach((spy) => {
        spy.mockRestore();
      });
    },
  };
}

/** Composes the public Worker MCP route with its actual Workspace ledger and Policy owners. */
async function createMcpCommitFixture(interception = new PolicyInterception()) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-mcp-commit-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const actor = { kind: 'user' as const, id: ensureLocalUser(coreDb) };
  const store = await createDemoStore({ dataRoot });
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const threadId = 'th_00000000-0000-7000-8000-000000000001';
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: actor.id, workspaceId });
  const turn = await store.createTurn(workspaceId, threadId, 'Count MCP commits', actor);
  const catalog = {
    schemaVersion: 1 as const,
    servers: [
      {
        id: 'echo',
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
  const environmentPackage = resolveAgentEnvironmentPackage({
    captureCoverage: { scope: 'server', value: 'off' },
    agentSessionId: testEntityId('as', 'mcp-commit'),
    agentSetup: createTestAgentSetup({ mcpIds: ['echo'] }),
    backend: { kind: 'openshell' },
    createdAt: '2026-10-24T00:00:00.000Z',
    requestId: 'req_mcp_commit',
    triggerActor: actor,
    turn,
    workspaceCwd: '/workspace',
    workspaceMcpServerCatalog: catalog,
    workspaceRoots: [],
  });
  recordMcpWorkerLineage(coreDb, environmentPackage);
  const db = openWorkspaceDb(dataRoot, workspaceId);
  applyScopedMigrations(db);
  recordAgentEnvironmentPackageSnapshot(db, {
    environmentPackage,
    createdAt: '2026-10-24T00:00:00.000Z',
  });
  let tools = [mcpEchoTool()];
  let serverVersion = '1';
  const observations: Array<{
    stage: string;
    calls: ReturnType<typeof listWorkspaceCapabilityCalls>;
    audits: ReturnType<typeof listWorkspaceAuditEvents>;
    decisions: ReturnType<typeof listExportableWorkspacePermissionDecisions>;
    commits: number;
    inTransaction: boolean;
  }> = [];
  let onDiscovery: (() => Promise<void> | void) | undefined;
  let onTool: (() => Promise<void> | void) | undefined;
  let toolContacts = 0;
  const observe = (stage: string) => {
    const reader = openWorkspaceDb(dataRoot, workspaceId);
    try {
      observations.push({
        stage,
        calls: listWorkspaceCapabilityCalls(reader, workspaceId),
        audits: listWorkspaceAuditEvents(reader, workspaceId),
        decisions: listExportableWorkspacePermissionDecisions(reader, workspaceId),
        commits: trace.commits.length,
        inTransaction: trace.inTransaction(),
      });
    } finally {
      reader.sqlite.close();
    }
  };
  const gateway = {
    listTools: vi.fn(async () => {
      observe('discovery');
      await onDiscovery?.();
      return { tools, serverVersion };
    }),
    callTool: vi.fn(async () => {
      observe('tool');
      await onTool?.();
      toolContacts += 1;
      return { content: [{ type: 'text' as const, text: 'called' }] };
    }),
    close: vi.fn(async () => undefined),
    closeServer: vi.fn(async () => undefined),
    closeServerIfIdle: vi.fn(async () => undefined),
    closeWorkspace: vi.fn(async () => undefined),
    getServerHealth: vi.fn(() => 'inactive' as const),
  } satisfies WorkerMcpGateway;
  const runtimeConfig = createInMemoryRuntimeConfigSnapshot({
    dataRoot,
    workspaceMcpServerCatalogs: [{ catalog, path: join(dataRoot, 'catalog.json'), workspaceId }],
  });
  const register = () => {
    const app = new Hono();
    registerWorkerMcpRoutes({
      app,
      coreDb,
      runtimeConfig: () => runtimeConfig,
      store,
      interception,
      workerMcpGateway: gateway,
      workerControlGateway: {
        authenticatePackageToken: vi.fn(() => environmentPackage),
      } as unknown as WorkerControlGateway,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    return app;
  };
  let app = register();
  let requestId = 0;
  const trace = observeMcpPhysicalCommits(db.sqlite.name);
  return {
    dataRoot,
    coreDb,
    store,
    workspaceId,
    environmentPackage,
    db,
    trace,
    gateway,
    observations,
    runtimeConfig,
    contacts() {
      return toolContacts;
    },
    discovery(callback: () => Promise<void> | void) {
      onDiscovery = callback;
    },
    tool(callback: () => Promise<void> | void) {
      onTool = callback;
    },
    version(value: string) {
      serverVersion = value;
    },
    tools(value: typeof tools) {
      tools = value;
    },
    async call(id = ++requestId) {
      const response = await app.request('/api/worker-capabilities/mcp/echo', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer fixture-package',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'echo',
            arguments: { message: 'commit observation' },
          },
        }),
      });
      return response.json();
    },
    reopen() {
      app = register();
      return openWorkspaceDb(dataRoot, workspaceId);
    },
    async close() {
      trace.restore();
      db.sqlite.close();
      coreDb.sqlite.close();
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

/** Checks the three durable tuples whose physical commit grouping is the accepted warm/cold target. */
function expectMcpCommittedTuples(fixture: Awaited<ReturnType<typeof createMcpCommitFixture>>) {
  const calls = listWorkspaceCapabilityCalls(fixture.db, fixture.workspaceId);
  const call = calls.at(-1)!;
  expect(call.status).toBe('succeeded');
  const usage = listWorkspaceUsageRecords(fixture.db, fixture.workspaceId).filter(
    (row) => row.capabilityCallId === call.id
  );
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({
    quantity: 1,
    unit: 'tool_calls',
    responsibleUserId: fixture.environmentPackage.scope.triggerActor.id,
  });
  const audit = listWorkspaceAuditEvents(fixture.db, fixture.workspaceId);
  for (const action of ['capability.admit', 'capability.finish']) {
    expect(
      audit.filter((row) => row.capabilityCallId === call.id && row.action === action)
    ).toHaveLength(1);
  }
  expect(
    readRetainedMcpToolSchemaSnapshot({
      workspaceDb: fixture.db,
      workspaceId: fixture.workspaceId,
      catalogEntryId: 'echo',
      schemaSnapshotId: call.schemaSnapshotId!,
    })?.tools
  ).toEqual([mcpEchoTool()]);
  expect(fixture.store.listAllItems().filter((item) => item.id === call.itemId)).toHaveLength(1);
}

describe('MCP physical commit contract', () => {
  it.each([
    { warm: false, count: 3 },
    { warm: true, count: 2 },
  ])('uses exactly $count physical ledger commits for warm=$warm without hiding discovery', async ({
    warm,
    count,
  }) => {
    const f = await createMcpCommitFixture();
    try {
      if (warm) expect(await f.call()).toMatchObject({ result: { content: [{ text: 'called' }] } });
      const snapshots = listExportableMcpToolSchemaSnapshots(f.db, f.workspaceId);
      const contacts = f.gateway.callTool.mock.calls.length;
      const discovery = f.gateway.listTools.mock.calls.length;
      f.trace.reset();
      f.observations.length = 0;
      expect(await f.call()).toMatchObject({ result: { content: [{ text: 'called' }] } });
      expect(f.gateway.callTool).toHaveBeenCalledTimes(contacts + 1);
      expect(f.gateway.listTools).toHaveBeenCalledTimes(discovery + 1);
      expectMcpCommittedTuples(f);
      if (warm)
        expect.soft(listExportableMcpToolSchemaSnapshots(f.db, f.workspaceId)).toEqual(snapshots);
      // Engineer COORD05:4x accepts r1825 W1/W2 and C1/C2/C3; count native COMMIT and autocommit, not JS calls.
      expect.soft(f.trace.commits, JSON.stringify(f.trace.commits)).toHaveLength(count);
      const groups = f.trace.commits;
      expect
        .soft(
          groups.findIndex((writes) => writes.some((sql) => /INSERT.*capability_calls/i.test(sql)))
        )
        .toBe(
          groups.findIndex((writes) =>
            writes.some((sql) => /INSERT.*permission_decisions/i.test(sql))
          )
        );
      expect
        .soft(
          groups.findIndex((writes) => writes.some((sql) => /INSERT.*usage_records/i.test(sql)))
        )
        .toBe(
          groups.findIndex((writes) =>
            writes.some((sql) => /UPDATE capability_calls SET status/i.test(sql))
          )
        );
      if (!warm) {
        expect
          .soft(
            groups.findIndex((writes) =>
              writes.some((sql) => /INSERT.*mcp_tool_schema_snapshots/i.test(sql))
            )
          )
          .toBe(
            groups.findIndex((writes) =>
              writes.some((sql) => /UPDATE capability_calls SET schema_snapshot_id/i.test(sql))
            )
          );
      }
      expect.soft(f.observations.map((row) => [row.stage, row.commits])).toEqual([
        ['discovery', 1],
        ['tool', warm ? 1 : 2],
      ]);
      expect(f.observations.map((row) => [row.stage, row.inTransaction])).toEqual([
        ['discovery', false],
        ['tool', false],
      ]);
    } finally {
      await f.close();
    }
  });
});

describe('MCP commit crash boundaries', () => {
  it.each([
    'before-intent-commit',
    'after-intent-before-discovery',
    'after-discovery-before-schema',
    'after-schema-before-tool',
    'after-tool-before-outcome',
    'after-outcome-commit-before-ack',
  ] as const)('keeps original durable evidence at %s', async (cut) => {
    const f = await createMcpCommitFixture();
    let reached = false;
    const stop = () => {
      reached = true;
      f.trace.stop();
      throw new Error(`Injected ${cut}`);
    };
    try {
      if (cut === 'before-intent-commit') f.trace.beforeCommit(stop);
      if (cut === 'after-intent-before-discovery') f.discovery(stop);
      if (cut === 'after-discovery-before-schema')
        f.discovery(() => {
          reached = true;
          f.trace.stop();
        });
      if (cut === 'after-schema-before-tool') f.tool(stop);
      if (cut === 'after-tool-before-outcome')
        f.tool(() => {
          reached = true;
          f.trace.stop();
        });
      if (cut === 'after-outcome-commit-before-ack') {
        f.trace.afterCommit((writes) => {
          if (writes.some((sql) => /UPDATE capability_calls SET status/i.test(sql))) stop();
        });
      }
      const response = await f.call(9001);
      expect(reached).toBe(true);
      expect(response).toHaveProperty('error');
      const physicalCommits = f.trace.commits.length;
      f.trace.restore();
      const reopened = f.reopen();
      try {
        const calls = listWorkspaceCapabilityCalls(reopened, f.workspaceId);
        const expectedPresent = cut !== 'before-intent-commit';
        expect(calls).toHaveLength(expectedPresent ? 1 : 0);
        const original = calls[0];
        if (original) {
          expect(original).toMatchObject({
            packageSnapshotId: f.environmentPackage.snapshotId,
            agentSessionId: f.environmentPackage.scope.agentSessionId,
            turnId: f.environmentPackage.scope.turnId,
            id: deriveEntityId('cap', [
              'mcp',
              f.environmentPackage.snapshotId,
              'echo',
              'mcp.call-tool',
              9001,
            ]),
          });
          const audit = listWorkspaceAuditEvents(reopened, f.workspaceId);
          expect(
            audit.filter(
              (event) =>
                event.action === 'capability.admit' && event.capabilityCallId === original.id
            )
          ).toHaveLength(1);
          expect(
            listExportableWorkspacePermissionDecisions(reopened, f.workspaceId)
          ).toContainEqual(expect.objectContaining({ result: 'allow' }));
          const dispatched = [
            'after-tool-before-outcome',
            'after-outcome-commit-before-ack',
          ].includes(cut);
          if (dispatched || cut === 'after-schema-before-tool') {
            expect(
              readRetainedMcpToolSchemaSnapshot({
                workspaceDb: reopened,
                workspaceId: f.workspaceId,
                catalogEntryId: 'echo',
                schemaSnapshotId: original.schemaSnapshotId!,
              })?.tools
            ).toEqual([mcpEchoTool()]);
          }
          if (cut === 'after-outcome-commit-before-ack') {
            expect(original.status).toBe('succeeded');
            expect(
              listWorkspaceUsageRecords(reopened, f.workspaceId).filter(
                (row) => row.capabilityCallId === original.id
              )
            ).toEqual([expect.objectContaining({ quantity: 1, unit: 'tool_calls' })]);
            expect(
              audit.filter(
                (event) =>
                  event.action === 'capability.finish' && event.capabilityCallId === original.id
              )
            ).toHaveLength(1);
          } else {
            expect(original.status).toBe('running');
            capabilityLedger.recoverRunningCapabilityCalls({ workspaceDb: reopened });
            expect(listWorkspaceCapabilityCalls(reopened, f.workspaceId)).toEqual([
              expect.objectContaining({
                id: original.id,
                status: 'unknown',
                errorCode: 'capability_call_recovered_after_restart',
              }),
            ]);
          }
          const beforeReplay = {
            calls: listWorkspaceCapabilityCalls(reopened, f.workspaceId),
            usage: listWorkspaceUsageRecords(reopened, f.workspaceId),
            audit: listWorkspaceAuditEvents(reopened, f.workspaceId),
          };
          expect(await f.call(9001)).toHaveProperty('error');
          expect({
            calls: listWorkspaceCapabilityCalls(reopened, f.workspaceId),
            usage: listWorkspaceUsageRecords(reopened, f.workspaceId),
            audit: listWorkspaceAuditEvents(reopened, f.workspaceId),
          }).toEqual(beforeReplay);
          expect(f.contacts()).toBe(dispatched ? 1 : 0);
        }
        // Accepted r1825 causal barriers: C1 before discovery, C2 before Tool, C3 after result.
        expect(physicalCommits).toBe(
          cut === 'before-intent-commit'
            ? 0
            : ['after-intent-before-discovery', 'after-discovery-before-schema'].includes(cut)
              ? 1
              : cut === 'after-outcome-commit-before-ack'
                ? 3
                : 2
        );
      } finally {
        reopened.sqlite.close();
      }
    } finally {
      await f.close();
    }
  });

  it.each([
    'capability.admit',
    'permission',
    'mcp.schema.capture',
  ] as const)('refuses contact beyond unavailable required %s Audit', async (action) => {
    const f = await createMcpCommitFixture();
    try {
      // Fault injection follows valid owner-created state; this trigger never manufactures an accepted record.
      f.db.sqlite.exec(`CREATE TRIGGER reject_required_mcp_audit BEFORE INSERT ON audit_events
          WHEN ${action === 'permission' ? 'NEW.permission_decision_id IS NOT NULL' : `NEW.action = '${action}'`}
          BEGIN SELECT RAISE(ABORT, 'injected required MCP Audit failure'); END;`);
      expect(await f.call()).toHaveProperty('error');
      expect(f.gateway.callTool).not.toHaveBeenCalled();
      expect(f.gateway.listTools).toHaveBeenCalledTimes(action === 'mcp.schema.capture' ? 1 : 0);
      expect(listWorkspaceUsageRecords(f.db, f.workspaceId)).toEqual([]);
      const calls = listWorkspaceCapabilityCalls(f.db, f.workspaceId);
      if (action === 'capability.admit') expect(calls).toEqual([]);
      else {
        // L: failed Policy/schema evidence must retain the original diagnostic call when its own writes remain available.
        expect(calls).toEqual([expect.objectContaining({ status: 'failed' })]);
        const audit = listWorkspaceAuditEvents(f.db, f.workspaceId);
        for (const required of ['capability.admit', 'capability.finish']) {
          expect(
            audit.filter(
              (event) => event.action === required && event.capabilityCallId === calls[0]!.id
            )
          ).toHaveLength(1);
        }
      }
    } finally {
      await f.close();
    }
  });

  it('selects one durable Turn schema when different first discoveries overlap', async () => {
    const f = await createMcpCommitFixture();
    let release!: () => void;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const changed = [
      {
        ...mcpEchoTool(),
        inputSchema: {
          ...mcpEchoTool().inputSchema,
          properties: { message: { type: 'string', minLength: 1 } },
        },
      },
    ];
    try {
      f.gateway.listTools.mockImplementationOnce(async () => {
        enter();
        await held;
        return { tools: changed, serverVersion: '2' };
      });
      const first = f.call(101);
      await entered;
      expect(await f.call(102)).toMatchObject({ result: { content: [{ text: 'called' }] } });
      release();
      expect(await first).toMatchObject({ result: { content: [{ text: 'called' }] } });
      const calls = listWorkspaceCapabilityCalls(f.db, f.workspaceId);
      expect(calls).toHaveLength(2);
      expect(new Set(calls.map((row) => row.schemaSnapshotId)).size).toBe(1);
      for (const call of calls) {
        expect(
          readRetainedMcpToolSchemaSnapshot({
            workspaceDb: f.db,
            workspaceId: f.workspaceId,
            catalogEntryId: 'echo',
            schemaSnapshotId: call.schemaSnapshotId!,
          })?.tools
        ).toEqual([mcpEchoTool()]);
      }
      expect(
        readCurrentMcpToolSchemaSnapshot({
          workspaceDb: f.db,
          workspaceId: f.workspaceId,
          catalogEntryId: 'echo',
          pinnedSchemaSnapshotId: null,
        })?.tools
      ).toEqual(changed);
    } finally {
      release?.();
      await f.close();
    }
  });

  it('retains a server version change even when tool schemas are identical', async () => {
    const f = await createMcpCommitFixture();
    try {
      expect(await f.call()).toHaveProperty('result');
      const first = listExportableMcpToolSchemaSnapshots(f.db, f.workspaceId);
      f.version('2');
      expect(await f.call()).toHaveProperty('result');
      const changed = listExportableMcpToolSchemaSnapshots(f.db, f.workspaceId);
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        serverVersion: '2',
        source: 'live',
        tools: first[0]!.tools,
      });
      expect(changed[0]!.capturedAt > first[0]!.capturedAt).toBe(true);
    } finally {
      await f.close();
    }
  });
});

it('observes native outer commits and implicit commits without counting savepoints or rollback', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-mcp-commit-observer-'));
  const db = new Database(join(root, 'observer.sqlite'));
  db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)');
  const trace = observeMcpPhysicalCommits(db.name);
  try {
    db.prepare('INSERT INTO sample VALUES (?, ?)').run(1, 'implicit');
    db.transaction(() => {
      db.prepare('INSERT INTO sample VALUES (?, ?)').run(2, 'outer');
      db.transaction(() => {
        db.prepare('INSERT INTO sample VALUES (?, ?)').run(3, 'savepoint');
      })();
    }).immediate();
    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO sample VALUES (?, ?)').run(4, 'rolled-back');
        throw new Error('rollback');
      })()
    ).toThrow('rollback');
    db.prepare('INSERT INTO sample VALUES (?, ?) RETURNING id').get(5, 'returning');
    db.prepare('SELECT * FROM sample').all();
    db.pragma('synchronous = FULL');
    expect(trace.commits.map((group) => group.length)).toEqual([1, 2, 1]);
    expect(db.prepare('SELECT id FROM sample ORDER BY id').all()).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
      { id: 5 },
    ]);
    const published: string[][] = [];
    trace.afterCommit((writes) => {
      published.push([...writes]);
    });
    db.transaction(() => {
      db.prepare('INSERT INTO sample VALUES (?, ?)').run(6, 'before-savepoint');
      expect(() =>
        db.transaction(() => {
          db.prepare('UPDATE sample SET value = ? WHERE id = ?').run('discarded', 1);
          db.prepare('INSERT INTO sample VALUES (?, ?)').run(7, 'discarded');
          throw new Error('caught nested rollback');
        })()
      ).toThrow('caught nested rollback');
      db.prepare('INSERT INTO sample VALUES (?, ?)').run(8, 'after-savepoint');
    }).immediate();
    expect(trace.commits.slice(3).map((group) => group.length)).toEqual([2]);
    expect(published).toEqual(trace.commits.slice(3));
    expect(published.flat().some((sql) => /^UPDATE sample/i.test(sql))).toBe(false);
    expect(db.prepare('SELECT id, value FROM sample ORDER BY id').all()).toEqual([
      { id: 1, value: 'implicit' },
      { id: 2, value: 'outer' },
      { id: 3, value: 'savepoint' },
      { id: 5, value: 'returning' },
      { id: 6, value: 'before-savepoint' },
      { id: 8, value: 'after-savepoint' },
    ]);
  } finally {
    trace.restore();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe('MCP current permission at commit acknowledgement', () => {
  for (const { change, label } of [
    {
      change: 'user',
      label: 'refuses discovery when authority is revoked after the permitting commit',
    },
    {
      change: 'policy',
      label: 'refuses discovery when admitted Policy changes after the permitting commit',
    },
  ] as const) {
    it(label, async () => {
      const f = await createMcpCommitFixture();
      let revoked = false;
      try {
        f.trace.afterCommit((writes) => {
          if (!revoked && writes.some((sql) => /INSERT.*permission_decisions/i.test(sql))) {
            revoked = true;
            const userId = f.environmentPackage.scope.triggerActor.id;
            if (change === 'user') {
              f.coreDb.sqlite
                .transaction(() => {
                  expect(disableCanonicalUser(f.coreDb, userId)?.changed).toBe(true);
                })
                .immediate();
            } else {
              const principal = { kind: 'human' as const, id: userId };
              const prepared = preparePolicyDocument({
                current: EMPTY_POLICY_DOCUMENT,
                userId,
                now: new Date().toISOString(),
                proposed: PolicyDocumentV1Schema.parse({
                  schemaVersion: 1,
                  statements: [
                    {
                      id: 'prohibit-after-permitting-commit',
                      kind: 'permission',
                      effect: 'prohibit',
                      grant: { kind: 'ordinary' },
                      author: principal,
                      authority: { kind: 'human', userId },
                      authoredAt: new Date().toISOString(),
                      state: 'active',
                      scope: {
                        subjects: [principal],
                        actions: ['tool.use'],
                        resources: [
                          {
                            kind: 'mcp-tool',
                            workspaceId: f.workspaceId,
                            serverId: 'echo',
                            toolName: 'echo',
                          },
                        ],
                      },
                      lifetime: {
                        anchor: {
                          owner: { kind: 'workspace', workspaceId: f.workspaceId },
                          kind: 'workspace',
                          id: f.workspaceId,
                        },
                      },
                    },
                  ],
                }),
              });
              recordPolicyWriteDecision({
                coreDb: f.coreDb,
                actor: { kind: 'local', userId },
                candidate: {
                  artifactId: testEntityId('ar', 'policy-after-commit'),
                  contentDigest: policyDigest(prepared.document),
                },
                proposal: {
                  schemaVersion: 1,
                  proposer: principal,
                  rationale: 'Revoke Tool authority after the original permitting commit.',
                  baseRevision: policyDigest(EMPTY_POLICY_DOCUMENT),
                  proposed: prepared.document,
                  diff: prepared.diff,
                  classification: prepared.classification,
                  validation: 'valid',
                },
                requestId: 'req_policy_after_commit',
                threadId: f.environmentPackage.scope.threadId,
                turnId: f.environmentPackage.scope.turnId,
              });
              f.runtimeConfig.openKitConfig.policy = {
                ...f.runtimeConfig.openKitConfig.policy,
                mediation: prepared.document,
              };
              expect(readAdmittedPolicyDocument(f.coreDb, prepared.document)).toEqual(
                prepared.document
              );
            }
          }
        });
        const response = await f.call();
        // L:143 and M:205 require a typed, durable denial before upstream contact.
        if (change === 'policy')
          expect(response).toMatchObject({ error: { data: { code: 'mcp-denied' } } });
        else expect(response).toHaveProperty('error');
        expect(revoked).toBe(true);
        const calls = listWorkspaceCapabilityCalls(f.db, f.workspaceId);
        expect(calls).toEqual([
          expect.objectContaining({
            id: deriveEntityId('cap', [
              'mcp',
              f.environmentPackage.snapshotId,
              'echo',
              'mcp.call-tool',
              1,
            ]),
            packageSnapshotId: f.environmentPackage.snapshotId,
          }),
        ]);
        if (change === 'policy') expect(calls[0]!.status).toBe('denied');
        else expect(['failed', 'denied']).toContain(calls[0]!.status);
        const audit = listWorkspaceAuditEvents(f.db, f.workspaceId);
        for (const action of ['capability.admit', 'capability.finish']) {
          expect(
            audit.filter((row) => row.action === action && row.capabilityCallId === calls[0]!.id)
          ).toHaveLength(1);
        }
        expect(f.gateway.listTools).not.toHaveBeenCalled();
        expect(f.contacts()).toBe(0);
        expect(listWorkspaceUsageRecords(f.db, f.workspaceId)).toEqual([]);
      } finally {
        await f.close();
      }
    });
  }

  it('allows only one overlapping call to consume the last finite Policy use', async () => {
    let entered = 0;
    let ready!: () => void;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const version = `sha256:${'7'.repeat(64)}`;
    const interception = new PolicyInterception({
      id: 'commit-finite-gate',
      version,
      async invoke() {
        if (++entered === 2) ready();
        await held;
        return { decision: 'allow' };
      },
    });
    const f = await createMcpCommitFixture(interception);
    try {
      const userId = f.environmentPackage.scope.triggerActor.id;
      const principal = { kind: 'human' as const, id: userId };
      const scope = {
        subjects: [principal],
        actions: ['tool.use'],
        resources: [
          {
            kind: 'mcp-tool' as const,
            workspaceId: f.workspaceId,
            serverId: 'echo',
            toolName: 'echo',
          },
        ],
      };
      const prepared = preparePolicyDocument({
        current: EMPTY_POLICY_DOCUMENT,
        userId,
        now: new Date().toISOString(),
        proposed: PolicyDocumentV1Schema.parse({
          schemaVersion: 1,
          statements: [
            {
              id: 'finite-commit-gate',
              kind: 'binding',
              author: principal,
              authority: { kind: 'human', userId },
              authoredAt: new Date().toISOString(),
              scope,
              lifetime: {
                anchor: {
                  owner: { kind: 'workspace', workspaceId: f.workspaceId },
                  kind: 'workspace',
                  id: f.workspaceId,
                },
                uses: 1,
              },
              state: 'active',
              operation: 'mcp.call-tool',
              stage: 'decide',
              mode: 'gate',
              participant: { kind: 'deterministic', id: 'commit-finite-gate', version },
              inputDisclosure: scope,
              order: 0,
              timeoutMs: 10000,
              circuit: { failures: 1, recoveryAfterMs: 1 },
            },
          ],
        }),
      });
      recordPolicyWriteDecision({
        coreDb: f.coreDb,
        actor: { kind: 'local', userId },
        candidate: {
          artifactId: testEntityId('ar', 'finite-commit-policy'),
          contentDigest: policyDigest(prepared.document),
        },
        proposal: {
          schemaVersion: 1,
          proposer: principal,
          rationale: 'Race one admitted finite Policy use.',
          baseRevision: policyDigest(EMPTY_POLICY_DOCUMENT),
          proposed: prepared.document,
          diff: prepared.diff,
          classification: prepared.classification,
          validation: 'valid',
        },
        requestId: 'req_finite_commit_policy',
        threadId: f.environmentPackage.scope.threadId,
        turnId: f.environmentPackage.scope.turnId,
      });
      f.runtimeConfig.openKitConfig.policy = {
        ...f.runtimeConfig.openKitConfig.policy,
        mediation: prepared.document,
      };
      const calls = [f.call(501), f.call(502)];
      await bothEntered;
      release();
      const results = await Promise.all(calls);
      expect(results.filter((result) => result.result && !result.result.isError)).toHaveLength(1);
      expect(f.contacts()).toBe(1);
      const decisions = listExportableWorkspacePermissionDecisions(f.db, f.workspaceId);
      expect(
        decisions.filter(
          (decision) => decision.result === 'allow' && decision.mediation?.role === 'final'
        )
      ).toHaveLength(1);
      expect(decisions.flatMap((decision) => decision.mediation?.consumedStatements ?? [])).toEqual(
        [{ id: 'finite-commit-gate', digest: policyDigest(prepared.document.statements[0]) }]
      );
    } finally {
      release?.();
      await f.close();
    }
  });
});

it('withholds a completed Tool result after authority loss without reopening its durable outcome', async () => {
  const f = await createMcpCommitFixture();
  let revoked = false;
  try {
    f.trace.afterCommit((writes) => {
      if (!revoked && writes.some((sql) => /UPDATE capability_calls SET status/i.test(sql))) {
        revoked = true;
        f.coreDb.sqlite
          .transaction(() => {
            expect(
              disableCanonicalUser(f.coreDb, f.environmentPackage.scope.triggerActor.id)?.changed
            ).toBe(true);
          })
          .immediate();
      }
    });
    const response = await f.call(6001);
    expect(revoked).toBe(true);
    expect(response).toMatchObject({ error: { data: { code: 'mcp-policy-stale' } } });
    expect(response).not.toHaveProperty('result');
    expect(f.contacts()).toBe(1);
    expectMcpCommittedTuples(f);
    const original = listWorkspaceCapabilityCalls(f.db, f.workspaceId);
    expect(await f.call(6001)).toHaveProperty('error');
    expect(f.contacts()).toBe(1);
    expect(listWorkspaceCapabilityCalls(f.db, f.workspaceId)).toEqual(original);
  } finally {
    await f.close();
  }
});
