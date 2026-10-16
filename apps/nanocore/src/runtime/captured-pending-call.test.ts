import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  resolveWorkspaceMcpServer,
  type WorkspaceMcpServerCatalog,
} from '@openkit/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import {
  admitCapturedPendingCall,
  evaluateCapturedPendingCall,
  executeCapturedPendingCall,
  type PreparedCapturedPendingCall,
  prepareCapturedPendingCall,
} from './captured-pending-call.js';
import {
  importMcpToolSchemaSnapshots,
  listExportableMcpToolSchemaSnapshots,
  mcpToolArgumentsContentDigest,
  recordMcpToolSchemaSnapshot,
} from './mcp-tool-schema-snapshots.js';
import { raiseRecordedPendingRequest, respondRecordedApproval } from './pending-request-flow.js';
import { readPendingRequest } from './pending-requests.js';
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
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Composes retained snapshots, current grant evaluation, and the real synchronous claim owner. */
function fixture(schemaPolicy: 'tracking' | 'pinned' = 'tracking', credentialRequired = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-captured-schema-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
  const db = openWorkspaceDb(dataRoot, 'ws_demo');
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
        deniedTools: ['excluded-other'],
        approvalRequiredTools: ['echo'],
        credentialBindings: credentialRequired
          ? [
              {
                sink: { kind: 'env', name: 'ECHO_AUTH' },
                slot: 'auth',
                vaultGrantId: 'grant_missing',
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
  const turn = store.createTurn(
    'ws_demo',
    'th_demo',
    'Capture an exact effect',
    { kind: 'user', id: 'user_local' },
    null,
    { agentId: 'agent_demo' }
  );
  const environmentPackage: AgentEnvironmentPackage = resolveAgentEnvironmentPackage({
    coreDb,
    captureCoverage: { scope: 'server', value: 'off' },
    agentSessionId: 'as_captured',
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
      workspaceId: 'ws_demo',
    });
  const capturedId = retain(tools(), 'schema_captured');
  const resolved = resolveWorkspaceMcpServer({ catalog, serverId: 'echo-server' });
  store.createItem({
    id: 'it_captured',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
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
  const record = raiseRecordedPendingRequest(store, db.sqlite, {
    requestId: 'ap_captured',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    raisingTurnId: turn.id,
    requestItemId: 'it_captured',
    kind: 'approval',
    requesterKind: 'worker',
    agentId: 'agent_demo',
    responsibleUserId: 'user_local',
    call: {
      serverId: 'echo-server',
      catalogRevision: resolved.catalogDigest,
      schemaSnapshotId: capturedId,
      toolName: 'echo',
      canonicalArgumentsJson: JSON.stringify({ message: 'approved' }),
      argumentsDigest: mcpToolArgumentsContentDigest({ message: 'approved' }),
      packageDigest: null,
      policyDecisionId: null,
      authorizationContext: {
        threadId: 'th_demo',
        turnId: turn.id,
        agentSessionId: null,
        agentId: 'agent_demo',
        responsibleUserId: 'user_local',
        packageDigest: null,
        policyDecisionId: null,
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
  const grant = (afterPreparation?: () => void | Promise<void>) => {
    let prepared: PreparedCapturedPendingCall | undefined;
    let executionCall: ReturnType<typeof admitCapturedPendingCall> | undefined;
    return respondRecordedApproval({
      store,
      sqlite: db.sqlite,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      approvalRequestId: record.requestId,
      decision: 'granted',
      actorId: 'user_local',
      coreDb,
      requestActor: { kind: 'local', userId: 'user_local' },
      dependencies: { coreDb, openWorkspace: (id) => openWorkspaceDb(dataRoot, id) },
      prepare: async () => {
        prepared = await prepareCapturedPendingCall({
          actor: { userId: 'user_local' },
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
          '00000000-0000-4000-8000-000000000117'
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
    db,
    coreDb,
    record,
    retain,
    grant,
    callTool,
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
  it.each([
    'unchanged',
    'allowed-other',
    'excluded-other',
    'top-level-description',
    'key-order',
  ])('tracking executes the captured call once after %s changes', async (change) => {
    const f = fixture();
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
        workspaceId: 'ws_demo',
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
    'type',
    'nested-description',
    'nested-annotation',
    'array-order',
    'renamed',
    'removed',
  ])('tracking refuses a requested-tool %s change before claim', async (change) => {
    const f = fixture();
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
    const f = fixture();
    f.db.sqlite
      .prepare('DELETE FROM mcp_tool_schema_snapshots WHERE snapshot_id = ?')
      .run(f.record.schemaSnapshotId);
    f.retain(tools());
    expect(await f.grant()).toMatchObject({ disposition: 'denied-not-executed' });
    expectNoExecution(f);
  });

  it('uses imported retained captured evidence without making it current live authority', async () => {
    const f = fixture();
    const captured = listExportableMcpToolSchemaSnapshots(f.db, 'ws_demo');
    f.db.sqlite.prepare('DELETE FROM mcp_tool_schema_snapshots').run();
    importMcpToolSchemaSnapshots(f.db, captured);
    const current = tools();
    current[1]!.inputSchema = { type: 'object', description: 'Unrelated drift.' };
    f.retain(current);
    expect(await f.grant()).toMatchObject({ disposition: 'approved-executed', claim: 'finished' });
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });

  it('refuses imported-only history when no current live schema exists', async () => {
    const f = fixture();
    const captured = listExportableMcpToolSchemaSnapshots(f.db, 'ws_demo');
    f.db.sqlite.prepare('DELETE FROM mcp_tool_schema_snapshots').run();
    importMcpToolSchemaSnapshots(f.db, captured);
    expect(await f.grant()).toMatchObject({ disposition: 'denied-not-executed' });
    expectNoExecution(f);
  });

  it('pinned executes an unchanged captured call exactly once', async () => {
    const f = fixture('pinned');
    expect(await f.grant()).toMatchObject({
      resolution: 'granted',
      claim: 'finished',
      disposition: 'approved-executed',
    });
    expect(f.callTool).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        toolName: 'echo',
        arguments: { message: 'approved' },
        workspaceId: 'ws_demo',
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
    const f = fixture('pinned');
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
    const f = fixture('tracking', guard === 'credentials');
    const result = await f.grant(() => {
      if (guard === 'selection') f.removeSelection();
      if (guard === 'agent') f.removeAgent();
      if (guard === 'user-authority')
        f.coreDb.sqlite
          .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = 'user_local'")
          .run(new Date().toISOString());
      if (guard === 'catalog' || guard === 'eligibility' || guard === 'policy') {
        const catalog = f.catalog();
        f.setCatalog({
          ...catalog,
          servers: catalog.servers.map((server) => ({
            ...server,
            ...(guard === 'catalog' ? { timeoutMs: server.timeoutMs + 1 } : {}),
            ...(guard === 'eligibility' ? { allowedTools: ['allowed-other'] } : {}),
            ...(guard === 'policy' ? { approvalRequiredTools: [] } : {}),
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
