import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ListHumanAttentionResponseSchema,
  StartTaskModeResponseSchema,
  WorkspaceExportResponseSchema,
} from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  parseWorkspaceMcpServerCatalog,
  resolveWorkspaceMcpServer,
} from '@openkit/config-schema';
import { buildWorkerCanonicalTerminalEventRecord } from '@openkit/worker-protocol';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createApp, createDefaultWorkerControlGateway } from './app.js';
import { ensureLocalUser } from './auth/identity.js';
import { finishCapabilityCall, startCapabilityCall } from './capability/usage-ledger.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from './config/runtime-config.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { recordProductPermissionDecision } from './policy/permission-decisions.js';
import { ProviderRegistry } from './providers/registry.js';
import { requireAgentEnvironmentPackageSnapshot } from './runtime/aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './runtime/agent-environment.js';
import {
  importMcpToolSchemaSnapshots,
  mcpToolSchemaContentDigest,
  readCurrentMcpToolSchemaSnapshot,
  recordMcpToolSchemaSnapshot,
} from './runtime/mcp-tool-schema-snapshots.js';
import {
  dispatchNanoHostHarnessOperation,
  settleNanoHostHarnessOperation,
} from './runtime/nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from './runtime/nanohost-runtime-target.js';
import type {
  NanoHostSessionDispatch,
  NanoHostSessionEffectRequest,
} from './runtime/nanohost-session-dispatch.js';
import { createConfiguredWorkerLifecycleRuntime } from './runtime/turn-executor-factory.js';
import type { TurnStartRuntimeContext } from './runtime/types.js';
import { getWorkerCheckpoint } from './runtime/worker-checkpoints.js';
import type { WorkerControlGateway } from './runtime/worker-control-gateway.js';
import { recordWorkerControlAcceptedRecord } from './runtime/worker-control-records.js';
import type { WorkerMcpGateway } from './runtime/worker-mcp-gateway.js';
import {
  createDefaultWorkerMcpGateway,
  WorkerMcpGatewayCallError,
} from './runtime/worker-mcp-gateway.js';
import {
  openCoreDb,
  openWorkspaceDb,
  verifyAndMigrateExistingScopedDatabases,
} from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createTestAgentSetup, createTestGatewayConfig } from './test-support/agent-environment.js';
import { createDemoStore } from './test-support/demo-store.js';
import { seedWritableGitRepository } from './test-support/git-repository.js';
import { createMcpHttpStub } from './test-support/mcp-http-stub.js';
import { createVaultGrant, revokeVaultGrant } from './vault/vault-grants.js';
import { createVaultReference } from './vault/vault-references.js';
import { createVaultUnlockState } from './vault/vault-unlock-state.js';
import {
  isMcpApprovalExpiryActive,
  reconcileWorkerMcpItems,
  registerWorkerMcpRoutes,
} from './worker-mcp-routes.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

describe('worker MCP routes', () => {
  it('executes an approved stdio call once through a fresh Turn', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Call the echo tool', {
      id: 'user_local',
      kind: 'user',
    });
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-09-03T00:00:00.000Z',
      id: 'as_mcp_route',
      message: null,
      status: 'busy',
      threadId: turn.threadId,
      updatedAt: '2026-09-03T00:00:00.000Z',
      workspaceId: turn.workspaceId,
    });
    store.updateTurn(turn.id, { agentSessionId: 'as_mcp_route' });
    const catalog = {
      schemaVersion: 1 as const,
      servers: [
        {
          allowedTools: ['echo'],
          approvalRequiredTools: ['echo'],
          credentialBindings: [],
          deniedTools: [],
          enabled: true,
          id: 'echo',
          pinnedSchemaSnapshotId: null,
          schemaPolicy: 'tracking' as const,
          timeoutMs: 2_000,
          transport: {
            args: [fileURLToPath(new URL('./test-support/mcp-stdio-stub.mjs', import.meta.url))],
            command: process.execPath,
            environment: { OPENKIT_MCP_CALL_DELAY_MS: '200' },
            kind: 'stdio' as const,
          },
        },
      ],
    };
    let environmentPackage = resolveAgentEnvironmentPackage({
      agentSessionId: 'as_mcp_route',
      agentSetup: createTestAgentSetup({ mcpIds: ['echo'] }),
      backend: { kind: 'openshell' },
      createdAt: '2026-09-03T00:00:00.000Z',
      requestId: 'req_mcp_route',
      triggerActor: turn.triggerActor,
      turn,
      workspaceCwd: '/workspace',
      workspaceMcpServerCatalog: catalog,
      workspaceRoots: [],
    });
    const workerControlGateway = {
      authenticatePackageToken: vi.fn(() => environmentPackage),
    } as unknown as WorkerControlGateway;
    const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
    const callTool = vi.spyOn(workerMcpGateway, 'callTool');
    const listTools = vi.spyOn(workerMcpGateway, 'listTools');
    const requestHumanGateStop = vi.fn();
    const app = new Hono();
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      dataRoot,
      agentManifests: [],
      workspaceMcpServerCatalogs: [
        { catalog, path: join(dataRoot, 'mcp-servers.jsonc'), workspaceId: 'ws_demo' },
      ],
    });
    registerWorkerMcpRoutes({
      app,
      coreDb,
      runtimeConfig: () => snapshot,
      requestHumanGateStop,
      store,
      workerControlGateway,
      workerMcpGateway,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    const client = new Client({ name: 'route-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL('http://nanocore.test/api/worker-capabilities/mcp/echo'),
      {
        fetch: (input, init) => app.fetch(new Request(input, init)),
        requestInit: { headers: { authorization: 'Bearer capability-token' } },
      }
    );
    const lifecycleAuditDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(lifecycleAuditDb);
    lifecycleAuditDb.sqlite.exec(`
      CREATE TRIGGER reject_mcp_lifecycle_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action LIKE 'mcp.server.lifecycle.%'
      BEGIN
        SELECT RAISE(ABORT, 'injected lifecycle audit failure');
      END
    `);
    lifecycleAuditDb.sqlite.close();

    try {
      const inactiveServers = await app.request('/api/worker-capabilities/mcp/_list-servers', {
        body: '{}',
        headers: {
          authorization: 'Bearer capability-token',
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      expect({ body: await inactiveServers.json(), status: inactiveServers.status }).toEqual({
        body: {
          servers: [{ health: 'inactive', id: 'echo', toolNames: [], transport: 'stdio' }],
        },
        status: 200,
      });
      await client.connect(transport);
      const firstTools = await client.listTools();
      const secondTools = await client.listTools();
      expect(firstTools).toEqual(secondTools);
      expect(firstTools).toEqual({
        tools: [expect.objectContaining({ inputSchema: expect.any(Object), name: 'echo' })],
      });
      expect(JSON.stringify(firstTools)).not.toContain('Echoes one message.');
      expect(listTools).toHaveBeenCalledTimes(1);
      const listedServers = await app.request('/api/worker-capabilities/mcp/_list-servers', {
        body: '{}',
        headers: {
          authorization: 'Bearer capability-token',
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const listedServersBody = await listedServers.json();
      expect({ body: listedServersBody, status: listedServers.status }).toEqual({
        body: {
          servers: [{ health: 'ready', id: 'echo', toolNames: ['echo'], transport: 'stdio' }],
        },
        status: 200,
      });
      await expect(
        client.callTool({ arguments: { message: 'hello' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
      expect(requestHumanGateStop).toHaveBeenCalledWith(environmentPackage.snapshotId);
      expect(listTools).toHaveBeenCalledTimes(1);
      const approvalItem = store
        .listThreadItems(turn.workspaceId, turn.threadId)
        .find((item) => item.type === 'approval-request');
      expect(approvalItem).toMatchObject({ approvalRequestId: expect.stringMatching(/^ap_mcp_/) });
      const approvalId = approvalItem?.approvalRequestId;
      if (!approvalId) throw new Error('Expected the MCP Approval request.');
      const approvalApp = createApp({
        coreDb,
        store,
        turnExecutor: new SimulatedTurnExecutor(),
        workerMcpGateway,
      });
      const approvalResponse = await approvalApp.request(`/api/approvals/${approvalId}/respond`, {
        body: JSON.stringify({
          decision: 'granted',
          requestId: '00000000-0000-4000-8000-000000000115',
          threadId: turn.threadId,
          turnId: turn.id,
          workspaceId: turn.workspaceId,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(approvalResponse.status).toBe(409);
      await expect(approvalResponse.json()).resolves.toMatchObject({ code: 'recovery_required' });
      const approvalRequestId = '00000000-0000-4000-8000-000000000115';
      const closedAt = '2026-09-03T00:04:00.000Z';
      const approvalWorkspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
      applyScopedMigrations(approvalWorkspaceDb);
      try {
        const source = approvalWorkspaceDb.sqlite
          .prepare(
            `SELECT
               context_summary_json AS contextSummary,
               resource_summary_json AS resourceSummary,
               subject_summary_json AS subjectSummary
             FROM permission_decisions
             WHERE approval_id = ? AND action = 'tool.use' AND result = 'require_approval'`
          )
          .get(approvalId) as {
          readonly contextSummary: string;
          readonly resourceSummary: string;
          readonly subjectSummary: string;
        };
        recordProductPermissionDecision({
          action: 'tool.use',
          approvalId,
          auditActor: { id: 'user_local', kind: 'user' },
          contextSummary: {
            ...JSON.parse(source.contextSummary),
            requestId: approvalRequestId,
          },
          decisionId: `pd_tool_use_granted_${approvalId}`,
          enforcementPoint: 'test.accepted_worker_gate_closeout',
          now: new Date(closedAt),
          ownerScope: 'workspace',
          policyEngineVersion: 'test:v1',
          policySnapshotId: environmentPackage.policy.snapshotId,
          reasonCode: 'mcp_tool_approved',
          requiredApprovalKind: 'permission',
          resourceSummary: JSON.parse(source.resourceSummary),
          result: 'allow',
          subjectSummary: JSON.parse(source.subjectSummary),
          workspaceDb: approvalWorkspaceDb,
          workspaceId: 'ws_demo',
        });
      } finally {
        approvalWorkspaceDb.sqlite.close();
      }
      store.createItem({
        actor: { id: 'user_local', kind: 'user' },
        approvalRequestId: approvalId,
        causationId: approvalRequestId,
        completedAt: closedAt,
        createdAt: closedAt,
        decision: 'granted',
        id: `it_approval_decision_${turn.id}`,
        status: 'completed',
        threadId: turn.threadId,
        turnId: turn.id,
        type: 'approval-decision',
        workspaceId: turn.workspaceId,
      });
      store.updateApproval(approvalId, { resolvedAt: closedAt, status: 'granted' });
      store.updateAgentSession('as_mcp_route', { status: 'closed', updatedAt: closedAt });
      const closedTurn = store.updateTurn(turn.id, {
        completedAt: closedAt,
        humanGate: null,
        status: 'completed',
      });
      store.emitTurnEvent(turn.id, {
        data: { stopReason: 'completed', turn: closedTurn, type: 'turn-completed' },
        event: 'turn.completed',
        requestId: approvalRequestId,
        threadId: turn.threadId,
        turnId: turn.id,
        workspaceId: turn.workspaceId,
      });
      const approvedTurn = store.createTurn(
        'ws_demo',
        'th_demo',
        'Call the approved echo tool',
        turn.triggerActor
      );
      environmentPackage = resolveAgentEnvironmentPackage({
        agentSessionId: 'as_mcp_route_approved',
        agentSetup: createTestAgentSetup({ mcpIds: ['echo'] }),
        backend: { kind: 'openshell' },
        createdAt: '2026-09-03T00:05:00.000Z',
        requestId: 'req_mcp_route_approved',
        triggerActor: approvedTurn.triggerActor,
        turn: approvedTurn,
        workspaceCwd: '/workspace',
        workspaceMcpServerCatalog: catalog,
        workspaceRoots: [],
      });
      const winner = client.callTool({ arguments: { message: 'hello' }, name: 'echo' });
      await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
      const loserCancellation = new AbortController();
      const loser = client.callTool({ arguments: { message: 'hello' }, name: 'echo' }, undefined, {
        signal: loserCancellation.signal,
      });
      const loserOutcome = loser.then(
        () => null,
        (error: unknown) => error
      );
      loserCancellation.abort();
      await expect(winner).resolves.toMatchObject({
        content: [{ text: 'hello', type: 'text' }],
        structuredContent: { message: 'hello' },
      });
      expect(String(await loserOutcome)).toMatch(/AbortError/);
      await vi.waitFor(() => expect(requestHumanGateStop).toHaveBeenCalledTimes(2));
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(listTools).toHaveBeenCalledTimes(2);

      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
      applyScopedMigrations(workspaceDb);
      try {
        expect(
          workspaceDb.sqlite
            .prepare(
              'SELECT family, operation, status, item_id, schema_snapshot_id FROM capability_calls ORDER BY rowid'
            )
            .all()
        ).toEqual([
          expect.objectContaining({
            family: 'mcp',
            operation: 'mcp.list_servers',
            schema_snapshot_id: null,
            status: 'succeeded',
          }),
          expect.objectContaining({
            family: 'mcp',
            operation: 'mcp.list_tools',
            schema_snapshot_id: null,
            status: 'succeeded',
          }),
          expect.objectContaining({
            family: 'mcp',
            operation: 'mcp.list_tools',
            schema_snapshot_id: null,
            status: 'succeeded',
          }),
          expect.objectContaining({
            family: 'mcp',
            operation: 'mcp.list_servers',
            schema_snapshot_id: null,
            status: 'succeeded',
          }),
          expect.objectContaining({
            family: 'mcp',
            item_id: expect.stringMatching(/^it_mcp_/),
            operation: 'mcp.call_tool',
            schema_snapshot_id: expect.stringMatching(/^mcpsnap_echo_/),
            status: 'denied',
          }),
          expect.objectContaining({
            family: 'mcp',
            item_id: expect.stringMatching(/^it_mcp_/),
            operation: 'mcp.call_tool',
            schema_snapshot_id: expect.stringMatching(/^mcpsnap_echo_/),
            status: 'succeeded',
          }),
          expect.objectContaining({
            family: 'mcp',
            item_id: expect.stringMatching(/^it_mcp_/),
            operation: 'mcp.call_tool',
            schema_snapshot_id: expect.stringMatching(/^mcpsnap_echo_/),
            status: 'denied',
          }),
        ]);
        expect(
          workspaceDb.sqlite.prepare('SELECT category, unit, quantity FROM usage_records').all()
        ).toEqual([{ category: 'tool', quantity: 1, unit: 'tool_calls' }]);
        expect(
          workspaceDb.sqlite
            .prepare('SELECT source, catalog_entry_id FROM mcp_tool_schema_snapshots')
            .all()
        ).toEqual([{ catalog_entry_id: 'echo', source: 'live' }]);
        const fixedNow = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-03T01:00:00Z'));
        try {
          for (const label of ['a', 'b', 'a']) {
            const tools = [{ inputSchema: { const: label }, name: 'echo' }];
            recordMcpToolSchemaSnapshot({
              environmentPackage,
              schemaSnapshotId: `mcpsnap_${label}`,
              serverId: 'echo',
              source: 'live',
              tools,
              workspaceDb,
              workspaceId: 'ws_demo',
            });
          }
        } finally {
          fixedNow.mockRestore();
        }
        expect(
          readCurrentMcpToolSchemaSnapshot({
            catalogEntryId: 'echo',
            pinnedSchemaSnapshotId: null,
            workspaceDb,
            workspaceId: 'ws_demo',
          })
        ).toMatchObject({ schemaSnapshotId: 'mcpsnap_a' });
        const importedTools = [{ inputSchema: { type: 'object' }, name: 'imported' }];
        const crossCatalogTools = [{ inputSchema: { const: 'cross' }, name: 'cross' }];
        importMcpToolSchemaSnapshots(workspaceDb, [
          {
            capturedAt: '2099-01-01T00:00:00.000Z',
            catalogEntryId: 'echo',
            contentDigest: mcpToolSchemaContentDigest(importedTools),
            schemaSnapshotId: 'mcpsnap_imported_history',
            serverVersion: '1.0.0',
            source: 'live',
            sourceRef: null,
            tools: importedTools,
            workspaceId: 'ws_demo',
          },
        ]);
        expect(
          readCurrentMcpToolSchemaSnapshot({
            catalogEntryId: 'echo',
            pinnedSchemaSnapshotId: null,
            workspaceDb,
            workspaceId: 'ws_demo',
          })
        ).not.toMatchObject({ schemaSnapshotId: 'mcpsnap_imported_history' });
        const captureCountBeforePromotion = workspaceDb.sqlite
          .prepare(
            `SELECT COUNT(*) AS count FROM audit_events
             WHERE action = 'mcp.schema.capture' AND resource = ?`
          )
          .get('mcp-schema:mcpsnap_imported_history');
        recordMcpToolSchemaSnapshot({
          environmentPackage,
          schemaSnapshotId: 'mcpsnap_imported_history',
          serverId: 'echo',
          source: 'live',
          tools: importedTools,
          workspaceDb,
          workspaceId: 'ws_demo',
        });
        recordMcpToolSchemaSnapshot({
          environmentPackage,
          schemaSnapshotId: 'mcpsnap_imported_history',
          serverId: 'echo',
          source: 'live',
          tools: importedTools,
          workspaceDb,
          workspaceId: 'ws_demo',
        });
        expect(
          workspaceDb.sqlite
            .prepare(
              `SELECT COUNT(*) AS count FROM audit_events
               WHERE action = 'mcp.schema.capture' AND resource = ?`
            )
            .get('mcp-schema:mcpsnap_imported_history')
        ).toEqual({
          count: (captureCountBeforePromotion as { count: number }).count + 1,
        });
        expect(
          readCurrentMcpToolSchemaSnapshot({
            catalogEntryId: 'echo',
            pinnedSchemaSnapshotId: null,
            workspaceDb,
            workspaceId: 'ws_demo',
          })
        ).toMatchObject({ schemaSnapshotId: 'mcpsnap_imported_history' });
        importMcpToolSchemaSnapshots(workspaceDb, [
          {
            capturedAt: '2099-01-02T00:00:00.000Z',
            catalogEntryId: 'other',
            contentDigest: mcpToolSchemaContentDigest(crossCatalogTools),
            schemaSnapshotId: 'mcpsnap_cross_catalog',
            serverVersion: '1.0.0',
            source: 'aep',
            sourceRef: 'aep_history',
            tools: crossCatalogTools,
            workspaceId: 'ws_demo',
          },
        ]);
        expect(() =>
          recordMcpToolSchemaSnapshot({
            environmentPackage,
            schemaSnapshotId: 'mcpsnap_cross_catalog',
            serverId: 'echo',
            source: 'live',
            tools: importedTools,
            workspaceDb,
            workspaceId: 'ws_demo',
          })
        ).toThrow('MCP schema snapshot identity conflicts');
        expect(
          workspaceDb.sqlite
            .prepare(
              `SELECT catalog_entry_id, source
               FROM mcp_tool_schema_snapshots
               WHERE snapshot_id = 'mcpsnap_cross_catalog'`
            )
            .get()
        ).toEqual({ catalog_entry_id: 'other', source: 'aep' });
        workspaceDb.sqlite
          .prepare(
            "DELETE FROM mcp_tool_schema_snapshots WHERE snapshot_id = 'mcpsnap_cross_catalog'"
          )
          .run();
        for (let index = 0; index < 10; index += 1) {
          recordMcpToolSchemaSnapshot({
            environmentPackage,
            schemaSnapshotId: `mcpsnap_retention_${String(index).padStart(2, '0')}`,
            serverId: 'echo',
            source: 'live',
            tools: [{ inputSchema: { const: index }, name: 'echo' }],
            workspaceDb,
            workspaceId: 'ws_demo',
          });
        }
        expect(
          workspaceDb.sqlite
            .prepare('SELECT COUNT(*) AS count FROM mcp_tool_schema_snapshots')
            .get()
        ).toEqual({ count: 9 });
        const decisions = workspaceDb.sqlite
          .prepare(
            `SELECT approval_id, context_summary_json, result
             FROM permission_decisions
             WHERE action = 'tool.use'
             ORDER BY rowid`
          )
          .all() as Array<{
          approval_id: string | null;
          context_summary_json: string;
          result: string;
        }>;
        expect(decisions.map(({ approval_id, result }) => ({ approval_id, result }))).toEqual([
          { approval_id: approvalId, result: 'require_approval' },
          { approval_id: approvalId, result: 'allow' },
          { approval_id: null, result: 'allow' },
          { approval_id: expect.stringMatching(/^ap_mcp_/), result: 'require_approval' },
        ]);
        expect(JSON.parse(decisions[2]!.context_summary_json)).toMatchObject({
          capabilityCallId: expect.stringMatching(/^cap_mcp_approval_/),
          grantedPermissionDecisionId: `pd_tool_use_granted_${approvalId}`,
        });
      } finally {
        workspaceDb.sqlite.close();
      }
      expect(store.getTurnById(approvedTurn.id).items).toContainEqual(
        expect.objectContaining({
          arguments: null,
          error: null,
          result: null,
          server: 'echo',
          status: 'completed',
          tool: 'echo',
          type: 'tool-call',
        })
      );
      expect(workerControlGateway.authenticatePackageToken).toHaveBeenCalledWith(
        'Bearer capability-token',
        { tokenFamily: 'capability' }
      );
    } finally {
      await client.close();
      await workerMcpGateway.close();
      coreDb.sqlite.close();
    }
  });

  it('runs a public Task Gate and one approved successor call through the real worker lifecycle', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-lifecycle-'));
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-lifecycle-repository-'));
    const exportRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-lifecycle-export-'));
    const callFile = join(dataRoot, 'mcp-calls.txt');
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    seedWritableGitRepository(repositoryPath);
    const agentSetup = createTestAgentSetup({ mcpIds: ['echo'] });
    const catalog = parseWorkspaceMcpServerCatalog({
      schemaVersion: 1,
      servers: [
        {
          allowedTools: ['echo'],
          approvalRequiredTools: ['echo'],
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
    const runtimeConfigManager = createRuntimeConfigManager({
      dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        agentManifests: [agentSetup.manifest],
        dataRoot,
        gatewayConfig: createTestGatewayConfig(),
        openKitConfig: { defaults: { defaultAgentId: agentSetup.manifest.id } },
        providerRegistry: new ProviderRegistry([
          {
            displayName: 'Agent OpenRouter',
            id: 'agent-openrouter',
            kind: 'local',
            models: ['openai/gpt-5.2'],
          },
        ]),
        workspaceMcpServerCatalogs: [
          {
            catalog,
            path: join(dataRoot, 'workspaces', 'ws_demo', 'config', 'mcp-servers.jsonc'),
            workspaceId: 'ws_demo',
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
      predecessorFenced: true,
      ready: true,
    });
    const terminalEvents = new Map<string, Buffer>();
    const nanoHostSessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        if (request.kind === 'image.acquire') return { digest: `sha256:${'a'.repeat(64)}` };
        if (request.kind === 'sandbox.create') {
          return { sandboxId: request.input.sandboxId, state: 'created' };
        }
        if (request.kind === 'reference.import') return { state: 'imported' };
        if (request.kind === 'bridge.open') {
          return { accepted: true, integrationReady: true, state: 'open' };
        }
        if (request.kind === 'file.export') {
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
    const workerLifecycleRuntime = createConfiguredWorkerLifecycleRuntime({
      coreDb,
      env: {},
      nanoHostSessionDispatch,
      store,
      workerControlGateway,
      workspaceMutationAdmission,
    });
    const app = createApp({
      coreDb,
      dataRoot,
      nanoHostSessionDispatch,
      runtimeConfigManager,
      schedulerEpoch: 12,
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
        const binding = coreDb.sqlite
          .prepare(
            `SELECT sandbox_integration_binding_ref AS integrationRef
             FROM sandbox_runtime_records
             LIMIT 1`
          )
          .get() as { integrationRef: string } | undefined;
        const command = binding
          ? dispatchNanoHostHarnessOperation(coreDb, {
              sandboxIntegrationBindingRef: binding.integrationRef,
            })
          : null;
        if (command) {
          expect(command.operation).toBe(operation);
          workerLifecycleRuntime.acceptNanoHostHarnessCommand(command);
          return { command, integrationRef: binding!.integrationRef };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      throw new Error(`Expected queued NanoHost Harness operation: ${operation}`);
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
        schemaVersion: 1 as const,
        sequence: dispatched.command.sequence,
      };
      settleNanoHostHarnessOperation(coreDb, {
        result,
        sandboxIntegrationBindingRef: dispatched.integrationRef,
        timestamp: new Date().toISOString(),
      });
      workerLifecycleRuntime.acceptNanoHostHarnessResult(result);
    };
    const driveTask = async (blocked: boolean, taskSettled: () => boolean) => {
      const opened = await dispatchNext('session.open');
      settle(opened, {
        maxActiveTurns: 1,
        nativeHandleDigest: null,
        nativeHandleState: 'pending',
        state: 'open',
      });
      const started = await dispatchNext('turn.start');
      settle(started, {
        nativeHandleDigest: null,
        nativeHandleState: 'pending',
        state: 'started',
      });
      const commandBody = started.command.body as Record<string, unknown>;
      const capabilityToken = String(commandBody.capabilityToken);
      const workerControlToken = String(commandBody.workerControlToken);
      const environmentPackage = workerControlGateway.authenticatePackageToken(
        `Bearer ${capabilityToken}`,
        { tokenFamily: 'capability' }
      );
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
          schemaVersion: 1,
          sequence: 0,
        }),
        headers: {
          authorization: `Bearer ${workerControlToken}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      expect(heartbeat.status, await heartbeat.clone().text()).toBe(200);

      const client = new Client({ name: 'public-task-lifecycle-test', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL('http://nanocore.test/api/worker-capabilities/mcp/echo'),
          {
            fetch: (request, init) => app.fetch(new Request(request, init)),
            requestInit: { headers: { authorization: `Bearer ${capabilityToken}` } },
          }
        )
      );
      await client.listTools();
      const toolCall = await Promise.allSettled([
        client.callTool({ arguments: { message: 'public-task' }, name: 'echo' }),
      ]);
      await client.close();
      expect(toolCall[0]?.status).toBe(blocked ? 'rejected' : 'fulfilled');
      if (blocked) {
        expect(toolCall[0]).toMatchObject({
          reason: expect.objectContaining({ data: { code: 'mcp-denied' } }),
          status: 'rejected',
        });
        expect(existsSync(callFile)).toBe(false);
      }

      const terminalBody = {
        evidenceManifestDigests: {},
        status: blocked ? ('blocked' as const) : ('completed' as const),
        stopReason: blocked ? 'ask_user' : 'completed',
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
      const interrupt = blocked ? await dispatchNext('turn.interrupt') : null;
      if (interrupt) {
        expect(interrupt.command.body).toMatchObject({ purpose: 'human-gate' });
      }
      const finalStatus = await app.request('/api/worker-control/final-status', {
        body: JSON.stringify({
          body: terminalBody,
          lineage,
          operation: 'final_status',
          schemaVersion: 1,
          sequence: 1,
        }),
        headers: {
          authorization: `Bearer ${workerControlToken}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      expect(finalStatus.status, await finalStatus.clone().text()).toBe(200);
      if (interrupt) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(taskSettled()).toBe(false);
        expect(
          coreDb.sqlite
            .prepare(
              `SELECT operation, operation_state AS operationState
               FROM harness_instance_records
               WHERE harness_instance_id = ?`
            )
            .get(interrupt.command.harnessInstanceId)
        ).toEqual({ operation: 'turn.interrupt', operationState: 'dispatched' });
        expect(
          dispatchNanoHostHarnessOperation(coreDb, {
            sandboxIntegrationBindingRef: interrupt.integrationRef,
          })
        ).toBeNull();
        settle(interrupt, { childState: 'absent', state: 'interrupted' });
      }
      const inspected = await dispatchNext('session.inspect');
      settle(inspected, {
        childState: 'absent',
        cleanupState: 'clean',
        nativeHandleDigest: blocked ? null : 'b'.repeat(64),
        nativeHandleState: blocked ? 'pending' : 'ready',
        state: 'open',
      });
      if (blocked) {
        const closed = await dispatchNext('session.close');
        settle(closed, { childState: 'absent', privateState: 'absent', state: 'closed' });
      }
      return { agentSessionId: environmentPackage.scope.agentSessionId, toolCall };
    };

    try {
      const repositoryResponse = await app.request(
        '/api/app/workspaces/ws_demo/repositories/default',
        {
          body: JSON.stringify({ displayName: 'MCP Task repository', localPath: repositoryPath }),
          headers: { 'content-type': 'application/json' },
          method: 'PUT',
        }
      );
      expect(repositoryResponse.status).toBe(200);

      let firstSettled = false;
      const firstRequest = app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        body: JSON.stringify({
          input: 'Implement the bounded MCP Task fix.',
          requestId: '0190f4c8-0000-7000-8000-000000000501',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      void firstRequest.then(
        () => {
          firstSettled = true;
        },
        () => {
          firstSettled = true;
        }
      );
      const [firstResponse, firstRun] = await Promise.all([
        firstRequest,
        driveTask(true, () => firstSettled),
      ]);
      expect(firstResponse.status, await firstResponse.clone().text()).toBe(202);
      const firstTask = StartTaskModeResponseSchema.parse(await firstResponse.json());
      expect(firstTask).toMatchObject({
        state: 'awaiting-human',
        turn: { humanGate: { kind: 'approval' }, status: 'awaiting_human' },
      });
      expect(store.getAgentSession(firstRun.agentSessionId).status).toBe('suspended');
      const firstBackend = coreDb.sqlite
        .prepare(
          `SELECT state, workspace_handoff_state AS workspaceHandoffState
           FROM worker_backend_sessions
           WHERE turn_id = ?`
        )
        .get(firstTask.turn.id);
      expect(firstBackend).toEqual({ state: 'cleaned', workspaceHandoffState: 'complete' });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT status
             FROM scheduler_session_leases
             WHERE turn_id = ?`
          )
          .get(firstTask.turn.id)
      ).toEqual({ status: 'releasing' });
      const firstWorkspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(
        getWorkerCheckpoint(firstWorkspaceDb, 'ws_demo', 'th_demo', firstTask.turn.id)
      ).toMatchObject({
        stage: 'waiting_for_user',
        stopReason: 'ask_user',
      });
      firstWorkspaceDb.sqlite.close();

      const firstGate = firstTask.turn.humanGate;
      if (firstGate?.kind !== 'approval') throw new Error('Expected the public Task MCP Gate.');
      const approvalResponse = await app.request(
        `/api/approvals/${firstGate.approvalRequestId}/respond`,
        {
          body: JSON.stringify({
            decision: 'granted',
            requestId: '0190f4c8-0000-7000-8000-000000000502',
            threadId: firstTask.turn.threadId,
            turnId: firstTask.turn.id,
            workspaceId: firstTask.turn.workspaceId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(approvalResponse.status, await approvalResponse.clone().text()).toBe(200);
      expect(store.getTurnById(firstTask.turn.id).status).toBe('completed');
      expect(store.getAgentSession(firstRun.agentSessionId).status).toBe('closed');
      const approvedWorkspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(
        getWorkerCheckpoint(approvedWorkspaceDb, 'ws_demo', 'th_demo', firstTask.turn.id)
      ).toBeNull();
      approvedWorkspaceDb.sqlite.close();
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE turn_id = ?')
          .get(firstTask.turn.id)
      ).toEqual({ status: 'released' });

      let secondSettled = false;
      const secondRequest = app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        body: JSON.stringify({
          input: 'Use the approved MCP call.',
          requestId: '0190f4c8-0000-7000-8000-000000000503',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      void secondRequest.then(
        () => {
          secondSettled = true;
        },
        () => {
          secondSettled = true;
        }
      );
      const [secondResponse, secondRun] = await Promise.all([
        secondRequest,
        driveTask(false, () => secondSettled),
      ]);
      expect(secondResponse.status, await secondResponse.clone().text()).toBe(202);
      const secondTask = StartTaskModeResponseSchema.parse(await secondResponse.json());
      expect(secondTask).toMatchObject({ state: 'completed', turn: { status: 'completed' } });
      expect(secondRun.agentSessionId).not.toBe(firstRun.agentSessionId);
      expect(secondRun.toolCall[0]).toMatchObject({ status: 'fulfilled' });
      expect(readFileSync(callFile, 'utf8').trim().split('\n')).toEqual(['public-task']);
      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT status
             FROM capability_calls
             WHERE operation = 'mcp.call_tool'
             ORDER BY rowid`
          )
          .all()
      ).toEqual([{ status: 'denied' }, { status: 'succeeded' }]);
      expect(
        workspaceDb.sqlite
          .prepare(
            "SELECT quantity, unit FROM usage_records WHERE unit = 'tool_calls' ORDER BY rowid"
          )
          .all()
      ).toEqual([{ quantity: 1, unit: 'tool_calls' }]);
      workspaceDb.sqlite.close();
    } finally {
      await workerMcpGateway.close();
      coreDb.sqlite.close();
      rmSync(exportRoot, { force: true, recursive: true });
      rmSync(repositoryPath, { force: true, recursive: true });
      rmSync(dataRoot, { force: true, recursive: true });
    }
  }, 30_000);

  it('keeps corrupted public Task MCP Approval sources fail-closed', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-public-task-'));
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-task-repository-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    seedWritableGitRepository(repositoryPath);
    const agentSetup = createTestAgentSetup({ mcpIds: ['echo'] });
    const catalog = parseWorkspaceMcpServerCatalog({
      schemaVersion: 1,
      servers: [
        {
          allowedTools: ['echo'],
          approvalRequiredTools: ['echo'],
          enabled: true,
          id: 'echo',
          schemaPolicy: 'tracking',
          timeoutMs: 2_000,
          transport: {
            args: [fileURLToPath(new URL('./test-support/mcp-stdio-stub.mjs', import.meta.url))],
            command: process.execPath,
            kind: 'stdio',
          },
        },
      ],
    });
    const providerRegistry = new ProviderRegistry([
      {
        displayName: 'Agent OpenRouter',
        id: 'agent-openrouter',
        kind: 'local',
        models: ['openai/gpt-5.2'],
      },
    ]);
    const runtimeConfigManager = createRuntimeConfigManager({
      dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        agentManifests: [agentSetup.manifest],
        dataRoot,
        gatewayConfig: createTestGatewayConfig(),
        openKitConfig: { defaults: { defaultAgentId: agentSetup.manifest.id } },
        providerRegistry,
        workspaceMcpServerCatalogs: [
          {
            catalog,
            path: join(dataRoot, 'workspaces', 'ws_demo', 'config', 'mcp-servers.jsonc'),
            workspaceId: 'ws_demo',
          },
        ],
      }),
    });
    let activePackage: AgentEnvironmentPackage | null = null;
    let gateStopCount = 0;
    const workerControlGateway = {
      authenticatePackageToken: vi.fn(() => {
        if (!activePackage) throw new Error('The public Task AEP is unavailable.');
        return activePackage;
      }),
    } as unknown as WorkerControlGateway;
    const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
    const mcpApp = new Hono();
    registerWorkerMcpRoutes({
      app: mcpApp,
      coreDb,
      requestHumanGateStop: (packageSnapshotId) => {
        if (!activePackage || activePackage.snapshotId !== packageSnapshotId) {
          throw new Error('The MCP Gate stop has no exact public Task AEP.');
        }
        const turn = store.getTurnById(activePackage.scope.turnId);
        if (!turn.agentSessionId) throw new Error('The MCP Gate stop has no AgentSession.');
        store.updateAgentSession(turn.agentSessionId, { status: 'suspended' });
        gateStopCount += 1;
      },
      runtimeConfig: runtimeConfigManager.current,
      store,
      workerControlGateway,
      workerMcpGateway,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    const executor = new (class extends SimulatedTurnExecutor {
      public readonly outcomes: Array<PromiseSettledResult<unknown>[]> = [];

      public override async startTurn(
        requestStore: typeof store,
        turnId: string,
        input: string,
        context: TurnStartRuntimeContext
      ): Promise<void> {
        await super.startTurn(requestStore, turnId, input, context);
        const turn = requestStore.getTurnById(turnId);
        if (!turn.agentSessionId) throw new Error('The public Task has no AgentSession.');
        const agentSession = requestStore.getAgentSession(turn.agentSessionId);
        if (!agentSession.environmentPackageSnapshotId) {
          throw new Error('The public Task has no AEP snapshot.');
        }
        const workspaceDb = openWorkspaceDb(dataRoot, turn.workspaceId);
        try {
          applyScopedMigrations(workspaceDb);
          activePackage = requireAgentEnvironmentPackageSnapshot(
            workspaceDb,
            turn.workspaceId,
            agentSession.environmentPackageSnapshotId
          ).snapshot;
        } finally {
          workspaceDb.sqlite.close();
        }
        requestStore.updateTurn(turnId, { humanGate: null, status: 'running' });
        requestStore.updateAgentSession(turn.agentSessionId, { status: 'busy' });

        const client = new Client({ name: 'public-task-route-test', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(
          new URL('http://nanocore.test/api/worker-capabilities/mcp/echo'),
          {
            fetch: (requestInput, init) => mcpApp.fetch(new Request(requestInput, init)),
            requestInit: { headers: { authorization: 'Bearer capability-token' } },
          }
        );
        try {
          await client.connect(transport);
          await client.listTools();
          const calls = [client.callTool({ arguments: { message: 'public-task' }, name: 'echo' })];
          if (this.outcomes.length === 1) {
            calls.push(client.callTool({ arguments: { message: 'public-task' }, name: 'echo' }));
          }
          this.outcomes.push(await Promise.allSettled(calls));
        } finally {
          await client.close();
        }
        const lease = coreDb.sqlite
          .prepare(
            `SELECT lease_id AS leaseId, sandbox_binding_ref AS sandboxBindingRef
             FROM scheduler_session_leases
             WHERE turn_id = ?`
          )
          .get(turnId) as { leaseId: string; sandboxBindingRef: string };
        recordWorkerControlAcceptedRecord(coreDb, {
          acceptedAt: new Date().toISOString(),
          lineage: {
            agentSessionId: activePackage.scope.agentSessionId,
            packageSnapshotId: activePackage.snapshotId,
            requestId: activePackage.scope.requestId,
            threadId: activePackage.scope.threadId,
            turnId: activePackage.scope.turnId,
            workspaceId: activePackage.scope.workspaceId,
          },
          operation: 'final_status',
          record: { sequence: 1, status: 'blocked', stopReason: 'ask_user' },
          recordKey: '1',
          sandboxBindingRef: lease.sandboxBindingRef,
          sequence: 1,
        });
      }
    })({ coreDb });
    const app = createApp({
      coreDb,
      dataRoot,
      runtimeConfigManager,
      schedulerEpoch: 12,
      store,
      turnExecutor: executor,
      workerMcpGateway,
    });

    try {
      const repositoryResponse = await app.request(
        '/api/app/workspaces/ws_demo/repositories/default',
        {
          body: JSON.stringify({ displayName: 'MCP Task repository', localPath: repositoryPath }),
          headers: { 'content-type': 'application/json' },
          method: 'PUT',
        }
      );
      expect(repositoryResponse.status).toBe(200);
      const firstResponse = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        body: JSON.stringify({
          input: 'Implement the bounded MCP Task fix.',
          requestId: '0190f4c8-0000-7000-8000-000000000401',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(firstResponse.status, await firstResponse.clone().text()).toBe(202);
      const firstTask = StartTaskModeResponseSchema.parse(await firstResponse.json());
      expect(firstTask).toMatchObject({
        state: 'awaiting-human',
        turn: { humanGate: { kind: 'approval' }, status: 'awaiting_human' },
      });
      expect(executor.outcomes[0]).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({ data: { code: 'mcp-denied' } }),
          status: 'rejected',
        }),
      ]);
      const firstGate = firstTask.turn.humanGate;
      if (firstGate?.kind !== 'approval') throw new Error('Expected the public Task MCP Gate.');

      const approvalResponse = await app.request(
        `/api/approvals/${firstGate.approvalRequestId}/respond`,
        {
          body: JSON.stringify({
            decision: 'granted',
            requestId: '0190f4c8-0000-7000-8000-000000000402',
            threadId: firstTask.turn.threadId,
            turnId: firstTask.turn.id,
            workspaceId: firstTask.turn.workspaceId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(approvalResponse.status, await approvalResponse.clone().text()).toBe(200);
      await expect(approvalResponse.json()).resolves.toMatchObject({ status: 'granted' });

      const secondResponse = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        body: JSON.stringify({
          input: 'Implement the next bounded MCP Task fix.',
          requestId: '0190f4c8-0000-7000-8000-000000000403',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(secondResponse.status, await secondResponse.clone().text()).toBe(202);
      const secondTask = StartTaskModeResponseSchema.parse(await secondResponse.json());
      expect(secondTask).toMatchObject({
        state: 'awaiting-human',
        turn: { humanGate: { kind: 'approval' }, status: 'awaiting_human' },
      });
      expect(
        executor.outcomes[1]?.filter((outcome) => outcome.status === 'fulfilled')
      ).toHaveLength(1);
      expect(executor.outcomes[1]?.filter((outcome) => outcome.status === 'rejected')).toHaveLength(
        1
      );
      expect(gateStopCount).toBe(2);
      const secondGate = secondTask.turn.humanGate;
      if (secondGate?.kind !== 'approval') throw new Error('Expected the second public Task Gate.');
      const actionableBeforeSourceLoss = ListHumanAttentionResponseSchema.parse(
        await (await app.request('/api/app/workspaces/ws_demo/action-center')).json()
      );
      expect(actionableBeforeSourceLoss.items.map((item) => item.id)).toContain(
        `approval:${secondGate.approvalRequestId}`
      );
      const actionCenterIds = async () =>
        ListHumanAttentionResponseSchema.parse(
          await (await app.request('/api/app/workspaces/ws_demo/action-center')).json()
        ).items.map((item) => item.id);
      const rejectCorruptApproval = async (requestId: string) => {
        const response = await app.request(
          `/api/approvals/${secondGate.approvalRequestId}/respond`,
          {
            body: JSON.stringify({
              decision: 'granted',
              requestId,
              threadId: secondTask.turn.threadId,
              turnId: secondTask.turn.id,
              workspaceId: secondTask.turn.workspaceId,
            }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        );
        expect(response.status, await response.clone().text()).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ code: 'recovery_required' });
      };

      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
      try {
        applyScopedMigrations(workspaceDb);
        expect(
          workspaceDb.sqlite
            .prepare(
              `SELECT COUNT(*) AS count
               FROM permission_decisions
               WHERE action = 'tool.use' AND reason_code = 'mcp_approval_grant_reauthorized'`
            )
            .get()
        ).toEqual({ count: 1 });
        expect(
          getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', firstTask.turn.id)
        ).toBeNull();
        expect(
          getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', secondTask.turn.id)
        ).toMatchObject({ stage: 'waiting_for_user', stopReason: 'ask_user' });
        expect(
          store.getCommandRequest(
            'task.start',
            '0190f4c8-0000-7000-8000-000000000401',
            { actorId: 'user_local', threadId: 'th_demo', workspaceId: 'ws_demo' },
            workspaceDb
          )
        ).not.toBeNull();
        const source = workspaceDb.sqlite
          .prepare(
            `SELECT decision_id, context_summary_json, resource_summary_json
             FROM permission_decisions
             WHERE approval_id = ? AND action = 'tool.use' AND result = 'require_approval'`
          )
          .get(secondGate.approvalRequestId) as {
          context_summary_json: string;
          decision_id: string;
          resource_summary_json: string;
        };
        const context = JSON.parse(source.context_summary_json) as Record<string, unknown>;
        const resource = JSON.parse(source.resource_summary_json) as Record<string, unknown>;
        const capabilityCallId = String(context.capabilityCallId);

        const { packageSnapshotId: _packageSnapshotId, ...incompleteContext } = context;
        workspaceDb.sqlite
          .prepare('UPDATE permission_decisions SET context_summary_json = ? WHERE decision_id = ?')
          .run(JSON.stringify(incompleteContext), source.decision_id);
        expect(await actionCenterIds()).not.toContain(`approval:${secondGate.approvalRequestId}`);
        workspaceDb.sqlite
          .prepare('UPDATE permission_decisions SET context_summary_json = ? WHERE decision_id = ?')
          .run(source.context_summary_json, source.decision_id);

        workspaceDb.sqlite
          .prepare('UPDATE capability_calls SET status = ? WHERE call_id = ?')
          .run('failed', capabilityCallId);
        expect(await actionCenterIds()).not.toContain(`approval:${secondGate.approvalRequestId}`);
        await rejectCorruptApproval('0190f4c8-0000-7000-8000-000000000405');
        workspaceDb.sqlite
          .prepare('UPDATE capability_calls SET status = ? WHERE call_id = ?')
          .run('denied', capabilityCallId);

        workspaceDb.sqlite
          .prepare(
            `UPDATE audit_events SET outcome = ?
             WHERE capability_call_id = ? AND action = 'capability.finish'`
          )
          .run('failed', capabilityCallId);
        expect(await actionCenterIds()).not.toContain(`approval:${secondGate.approvalRequestId}`);
        await rejectCorruptApproval('0190f4c8-0000-7000-8000-000000000406');
        workspaceDb.sqlite
          .prepare(
            `UPDATE audit_events SET outcome = ?
             WHERE capability_call_id = ? AND action = 'capability.finish'`
          )
          .run('denied', capabilityCallId);

        workspaceDb.sqlite
          .prepare(
            'UPDATE permission_decisions SET resource_summary_json = ? WHERE decision_id = ?'
          )
          .run(
            JSON.stringify({ ...resource, expiresAt: '2999-01-01T00:00:00.000Z' }),
            source.decision_id
          );
        expect(await actionCenterIds()).not.toContain(`approval:${secondGate.approvalRequestId}`);
        await rejectCorruptApproval('0190f4c8-0000-7000-8000-000000000407');
        workspaceDb.sqlite
          .prepare(
            'UPDATE permission_decisions SET resource_summary_json = ? WHERE decision_id = ?'
          )
          .run(
            JSON.stringify({ ...resource, expiresAt: '1970-01-01T00:00:00.000Z' }),
            source.decision_id
          );
        expect(await actionCenterIds()).not.toContain(`approval:${secondGate.approvalRequestId}`);
        await rejectCorruptApproval('0190f4c8-0000-7000-8000-000000000408');
        workspaceDb.sqlite
          .prepare('DELETE FROM permission_decisions WHERE approval_id = ?')
          .run(secondGate.approvalRequestId);
      } finally {
        workspaceDb.sqlite.close();
      }
      const actionableAfterSourceLoss = ListHumanAttentionResponseSchema.parse(
        await (await app.request('/api/app/workspaces/ws_demo/action-center')).json()
      );
      expect(actionableAfterSourceLoss.items.map((item) => item.id)).not.toContain(
        `approval:${secondGate.approvalRequestId}`
      );
    } finally {
      await workerMcpGateway.close();
      coreDb.sqlite.close();
    }
  });

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
        ) VALUES ('user_backup_owner', 'Backup owner', 'backup@example.com', false, ?, ?, 'human', 'active', NULL)`
      )
      .run(ownerCreatedAt, ownerCreatedAt);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_backup_owner',
      workspaceId: 'ws_demo',
    });
    const memberCreatedAt = new Date().toISOString();
    coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, access_level, invitation_id, joined_at,
          removed_at, revision, created_at, updated_at
        ) VALUES ('ws_demo', 'user_local', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
      )
      .run(memberCreatedAt, memberCreatedAt, memberCreatedAt);
    const turn = store.createTurn('ws_demo', 'th_demo', 'Classify MCP failures', {
      id: 'user_local',
      kind: 'user',
    });
    const server = (id: string, schemaPolicy: 'pinned' | 'tracking' = 'tracking') => ({
      allowedTools: ['echo'],
      approvalRequiredTools: [],
      credentialBindings: [],
      deniedTools: [],
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
      ],
    };
    let environmentPackage = resolveAgentEnvironmentPackage({
      agentSessionId: 'as_mcp_failures',
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
          'MCP tool result exceeds the capability response limit.',
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
    const listTools = vi.fn(async (request: Parameters<WorkerMcpGateway['listTools']>[0]) => {
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
            { catalog, path: join(dataRoot, 'mcp-servers.jsonc'), workspaceId: 'ws_demo' },
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
      const typedIdDb = openWorkspaceDb(dataRoot, 'ws_demo');
      const typedIdRows = typedIdDb.sqlite
        .prepare(
          `SELECT call_id, item_id
           FROM capability_calls
           WHERE operation = 'mcp.call_tool'
           ORDER BY rowid`
        )
        .all() as Array<{ call_id: string; item_id: string }>;
      expect(typedIdRows).toEqual([
        { call_id: expect.stringMatching(/^cap_mcp_/), item_id: expect.stringMatching(/^it_mcp_/) },
        { call_id: expect.stringMatching(/^cap_mcp_/), item_id: expect.stringMatching(/^it_mcp_/) },
      ]);
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
        ).rejects.toMatchObject({ data: { code: failure.code } });
        expect(callTool.mock.calls.length - before).toBe(
          ['mcp-timeout', 'mcp-call-failed', 'mcp-result-too-large'].includes(failure.code) ? 1 : 0
        );
      }
      const cancellation = new AbortController();
      const callsBeforeCancellation = callTool.mock.calls.length;
      const cancelled = echo.callTool(
        { arguments: { message: 'cancelled' }, name: 'echo' },
        undefined,
        { signal: cancellation.signal }
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      cancellation.abort();
      await expect(cancelled).rejects.toThrow(/AbortError/);
      expect(callTool.mock.calls.length).toBe(callsBeforeCancellation + 1);
      const callsBeforePreCancellation = callTool.mock.calls.length;
      await expect(
        echo.callTool({ arguments: { message: 'pre-cancelled' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-call-failed' } });
      expect(callTool.mock.calls.length).toBe(callsBeforePreCancellation + 1);
      const schemaDbBefore = openWorkspaceDb(dataRoot, 'ws_demo');
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
      const schemaDb = openWorkspaceDb(dataRoot, 'ws_demo');
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
      const schemaCancellationDb = openWorkspaceDb(dataRoot, 'ws_demo');
      const usageBeforeSchemaCancellation = schemaCancellationDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM usage_records')
        .get();
      schemaCancellationDb.sqlite.close();
      const schemaCancelledCall = schemaCancel.callTool(
        { arguments: { message: 'schema-cancel' }, name: 'echo' },
        undefined,
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
      await vi.waitFor(() => {
        const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
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
      const afterSchemaCancellationDb = openWorkspaceDb(dataRoot, 'ws_demo');
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
           WHERE workspace_id = 'ws_demo' AND user_id = 'user_local'`
        )
        .run(new Date().toISOString(), new Date().toISOString());
      authorityBarrier.release();
      await expect(authorityRaceCall).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
      expect(callTool).toHaveBeenCalledTimes(upstreamCallsBeforeAuthorityRace);
      coreDb.sqlite
        .prepare(
          `UPDATE workspace_members
           SET status = 'active', removed_at = NULL, revision = revision + 1, updated_at = ?
           WHERE workspace_id = 'ws_demo' AND user_id = 'user_local'`
        )
        .run(new Date().toISOString());

      const gateRace = await connect('gate-race');
      const gateBarrier = createListBarrier('gate-race');
      const upstreamCallsBeforeGateRace = callTool.mock.calls.length;
      const gateRaceCall = gateRace.callTool({
        arguments: { message: 'gate-race' },
        name: 'echo',
      });
      await gateBarrier.entered;
      store.updateTurn(turn.id, {
        humanGate: {
          approvalRequestId: 'ap_concurrent_gate',
          itemId: 'it_concurrent_gate',
          kind: 'approval',
        },
        status: 'awaiting_human',
      });
      gateBarrier.release();
      await expect(gateRaceCall).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
      expect(callTool).toHaveBeenCalledTimes(upstreamCallsBeforeGateRace);
      store.updateTurn(turn.id, { humanGate: null, status: 'running' });
      listBarrier = undefined;

      const itemCountBeforeAuditFailure = store.listAllItems().length;
      const auditFailureDb = openWorkspaceDb(dataRoot, 'ws_demo');
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
      const usageFailureDb = openWorkspaceDb(dataRoot, 'ws_demo');
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
      const terminalDb = openWorkspaceDb(dataRoot, 'ws_demo');
      const successfulUnpublished = terminalDb.sqlite
        .prepare(
          `SELECT call_id, item_id, status
           FROM capability_calls
           WHERE operation = 'mcp.call_tool'
           ORDER BY rowid DESC
           LIMIT 1`
        )
        .get() as { call_id: string; item_id: string; status: string };
      terminalDb.sqlite.close();
      expect(successfulUnpublished.status).toBe('succeeded');
      verifyAndMigrateExistingScopedDatabases(dataRoot);
      expect(reconcileWorkerMcpItems(dataRoot, store)).toBeGreaterThan(0);
      expect(store.listAllItems()).toContainEqual(
        expect.objectContaining({
          causationId: successfulUnpublished.call_id,
          id: successfulUnpublished.item_id,
          status: 'completed',
        })
      );

      const deniedTurn = store.createTurn('ws_demo', 'th_demo', 'Reject unauthorized MCP use', {
        id: 'user_outsider',
        kind: 'user',
      });
      environmentPackage = resolveAgentEnvironmentPackage({
        agentSessionId: 'as_mcp_denied',
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
      const beforeDeniedDb = openWorkspaceDb(dataRoot, 'ws_demo');
      const beforeDenied = mcpEffectCounts(beforeDeniedDb);
      beforeDeniedDb.sqlite.close();
      const itemsBeforeDenied = store.listAllItems().length;
      const upstreamCallsBeforeDenied = callTool.mock.calls.length;
      await expect(
        echo.callTool({ arguments: { message: 'denied' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
      const afterDeniedDb = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(mcpEffectCounts(afterDeniedDb)).toEqual(beforeDenied);
      afterDeniedDb.sqlite.close();
      expect(store.listAllItems()).toHaveLength(itemsBeforeDenied);
      expect(callTool).toHaveBeenCalledTimes(upstreamCallsBeforeDenied);
      expect(reconcileWorkerMcpItems(dataRoot, store)).toBe(0);

      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
      applyScopedMigrations(workspaceDb);
      try {
        expect(
          workspaceDb.sqlite
            .prepare(
              `SELECT error_code, status FROM capability_calls
               WHERE operation = 'mcp.call_tool'
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
      const nearLimitSchemaDb = openWorkspaceDb(dataRoot, 'ws_demo');
      recordMcpToolSchemaSnapshot({
        environmentPackage,
        schemaSnapshotId: 'mcpschema_near_limit',
        serverId: 'echo',
        source: 'live',
        tools: nearLimitTools,
        workspaceDb: nearLimitSchemaDb,
        workspaceId: 'ws_demo',
      });
      nearLimitSchemaDb.sqlite.close();
      expect(Buffer.byteLength(JSON.stringify(nearLimitTools), 'utf8')).toBe(512 * 1024);
      const nearLimitList = await echo.listTools();
      expect(Buffer.byteLength(JSON.stringify(nearLimitList.tools), 'utf8')).toBe(512 * 1024);
      const nearLimitListDb = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(
        nearLimitListDb.sqlite
          .prepare(
            `SELECT error_code, status
             FROM capability_calls
             WHERE operation = 'mcp.list_tools'
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
      const nearLimitDb = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(
        nearLimitDb.sqlite
          .prepare(
            `SELECT error_code, status
             FROM capability_calls
             WHERE operation = 'mcp.call_tool'
             ORDER BY rowid DESC
             LIMIT 1`
          )
          .get()
      ).toEqual({ error_code: null, status: 'succeeded' });
      nearLimitDb.sqlite.close();
      await workspaceMutationAdmission.close('ws_demo');
      const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
      rmSync(workspaceRoot, { recursive: true });
      const staleRequest = await rawCall('stale-after-delete');
      expect(staleRequest.status).toBe(200);
      await expect(staleRequest.json()).resolves.toMatchObject({
        error: { data: { code: 'mcp-denied' } },
        id: 'stale-after-delete',
      });
      expect(existsSync(workspaceRoot)).toBe(false);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      coreDb.sqlite.close();
    }
  });

  it('rejects malformed and expired Approval timestamps', () => {
    const now = Date.parse('2026-09-03T01:00:00.000Z');

    expect(isMcpApprovalExpiryActive('not-a-date', now)).toBe(false);
    expect(isMcpApprovalExpiryActive('2026-09-03T01:00:00.000Z', now)).toBe(false);
    expect(isMcpApprovalExpiryActive('2026-09-03T01:00:00.001Z', now)).toBe(true);
  });

  it('recreates a missing terminal Item without changing its successful call', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-item-recovery-'));
    const store = createDemoStore({ dataRoot });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Recover the MCP Item', {
      id: 'user_local',
      kind: 'user',
    });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    try {
      const call = startCapabilityCall({
        agentId: 'agent_codex',
        agentSessionId: 'as_recovery',
        authorityActor: turn.triggerActor,
        callId: 'cap_mcp_recovery',
        capabilityId: 'mcp.call_tool',
        family: 'mcp',
        itemId: 'it_mcp_recovery',
        operation: 'mcp.call_tool',
        packageSnapshotId: 'aepsnap_recovery',
        providerRef: 'echo',
        redactionClass: 'metadata-only',
        serviceRef: 'mcp-tool:echo',
        threadId: turn.threadId,
        turnId: turn.id,
        workspaceDb,
        workspaceId: turn.workspaceId,
      });
      finishCapabilityCall({ callId: call.id, status: 'succeeded', workspaceDb });
    } finally {
      workspaceDb.sqlite.close();
    }

    verifyAndMigrateExistingScopedDatabases(dataRoot);
    expect(reconcileWorkerMcpItems(dataRoot, store)).toBe(1);
    expect(reconcileWorkerMcpItems(dataRoot, store)).toBe(0);
    expect(store.getTurnById(turn.id).items).toContainEqual(
      expect.objectContaining({
        causationId: 'cap_mcp_recovery',
        id: 'it_mcp_recovery',
        server: 'echo',
        status: 'completed',
        tool: 'echo',
      })
    );
    const recoveredWorkspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    try {
      expect(
        recoveredWorkspaceDb.sqlite
          .prepare('SELECT status FROM capability_calls WHERE call_id = ?')
          .get('cap_mcp_recovery')
      ).toEqual({ status: 'succeeded' });
    } finally {
      recoveredWorkspaceDb.sqlite.close();
    }
  });

  it('injects an HTTP Vault grant at the gateway and rejects the next call after revoke', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-vault-'));
    const upstreamOptions: { credentialListEcho?: string } = {};
    const upstream = await createMcpHttpStub(upstreamOptions);
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Call HTTP MCP', {
      id: 'user_local',
      kind: 'user',
    });
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 7) });
    const vaultCanary = 'Bearer vault-"quoted\\slash';
    vaultUnlockState.backend().store({
      material: vaultCanary,
      metadata: { ownerScope: 'workspace', workspaceId: 'ws_demo' },
      referenceId: 'vault_mcp_http',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://workspace/vault_mcp_http',
      displayName: 'HTTP MCP token',
      ownerScope: 'workspace',
      referenceId: 'vault_mcp_http',
      secretKind: 'http-bearer',
      workspaceId: 'ws_demo',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['gateway-only'],
      grantId: 'grant_mcp_http',
      lifetime: 'agent-session',
      ownerScope: 'workspace',
      targetAgentSessionId: 'as_mcp_vault',
      targetCapabilityId: 'mcp',
      vaultReferenceId: 'vault_mcp_http',
      workspaceId: 'ws_demo',
    });
    const catalog = {
      schemaVersion: 1 as const,
      servers: [
        {
          allowedTools: ['echo'],
          approvalRequiredTools: [],
          credentialBindings: [
            {
              sink: { kind: 'header' as const, name: 'authorization' },
              slot: 'auth',
              vaultGrantId: 'grant_mcp_http',
            },
          ],
          deniedTools: [],
          enabled: true,
          id: 'http-echo',
          pinnedSchemaSnapshotId: null,
          schemaPolicy: 'tracking' as const,
          timeoutMs: 2_000,
          transport: { endpoint: upstream.url, kind: 'http' as const },
        },
      ],
    };
    let activeCatalog = catalog;
    let environmentPackage = resolveAgentEnvironmentPackage({
      agentSessionId: 'as_mcp_vault',
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
              path: join(dataRoot, 'mcp-servers.jsonc'),
              workspaceId: 'ws_demo',
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
      expect(upstream.observed.some((request) => request.startsWith(`${vaultCanary}||`))).toBe(
        true
      );
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_injection_plans').get()
      ).toEqual({ count: 1 });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts').get()
      ).toEqual({ count: 1 });
      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
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
        const exportResponse = await exportApp.request('/api/app/workspaces/ws_demo/export', {
          method: 'POST',
        });
        expect(exportResponse.status).toBe(200);
        const exported = WorkspaceExportResponseSchema.parse(await exportResponse.json());
        const exportRoot = join(
          dataRoot,
          'server',
          'exports',
          'workspaces',
          'ws_demo',
          exported.exportId
        );
        const publicAndDurableValues = [
          environmentPackage,
          result,
          store.listAllItems(),
          store.listThreadTurns('ws_demo', 'th_demo'),
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

      const schemaDb = openWorkspaceDb(dataRoot, 'ws_demo');
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
      const rejectedSchemaDb = openWorkspaceDb(dataRoot, 'ws_demo');
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
        workerMcpGateway.getServerHealth({ server: oldResolved, workspaceId: 'ws_demo' })
      ).toBe('inactive');

      const toolCallsBeforeMalformedExpiry = upstream.observed.filter((request) =>
        request.endsWith('|tools/call')
      ).length;
      const receiptsBeforeMalformedExpiry = coreDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts')
        .get();
      const useDb = openWorkspaceDb(dataRoot, 'ws_demo');
      const usesBeforeMalformedExpiry = useDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM vault_use_records')
        .get();
      useDb.sqlite.close();
      coreDb.sqlite
        .prepare('UPDATE vault_grants SET expires_at = ? WHERE grant_id = ?')
        .run('not-a-date', 'grant_mcp_http');
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
      const rejectedUseDb = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(
        rejectedUseDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_use_records').get()
      ).toEqual(usesBeforeMalformedExpiry);
      rejectedUseDb.sqlite.close();
      coreDb.sqlite
        .prepare('UPDATE vault_grants SET expires_at = NULL WHERE grant_id = ?')
        .run('grant_mcp_http');

      const toolCallsBeforeRevoke = upstream.observed.filter((request) =>
        request.endsWith('|tools/call')
      ).length;
      revokeVaultGrant(coreDb, { grantId: 'grant_mcp_http' });
      activeCatalog = {
        ...catalog,
        servers: [{ ...catalog.servers[0], timeoutMs: 2_001 }],
      };
      environmentPackage = resolveAgentEnvironmentPackage({
        agentSessionId: 'as_mcp_vault',
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
        workerMcpGateway.getServerHealth({ server: oldResolved, workspaceId: 'ws_demo' })
      ).toBe('inactive');
    } finally {
      await client.close();
      await workerMcpGateway.close();
      await upstream.close();
      vaultUnlockState.lock();
      coreDb.sqlite.close();
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
