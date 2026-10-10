import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BootReadinessSnapshot,
  CreateOpenKitAccessTokenResponseSchema,
  OPERATION_DEFINITIONS,
  operationMcpEligible,
  RotateOpenKitAccessTokenResponseSchema,
} from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listServerAuditEvents } from './audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { computeBootReadinessSnapshot } from './bootstrap/readiness.js';
import { createLightApp, getLightApp, listRecords } from './generative-kernel/commands.js';
import { KnowledgePageValidationError } from './knowledge/okf.js';
import { AutomationStore } from './lib/automation-store.js';
import * as invocation from './operation-composition.js';
import { feedbackFilePath } from './runtime/feedback.js';
import * as goalCoordinator from './runtime/goal-coordinator.js';
import {
  createSchedulerAdmissionEntry,
  denySchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from './scheduler-records.js';
import { openExistingAppDb } from './storage/app-db.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { users } from './storage/schema/index.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
import * as materialOwners from './workspace-materials.js';
import { createWorkspaceMaterial, saveWorkspaceMaterialRevision } from './workspace-materials.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Real isolated credential, membership and Kernel owners behind the App listener. */
async function fixture(
  mode: 'local' | 'server' = 'server',
  getBootReadiness?: () => BootReadinessSnapshot
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-remote-mcp-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  coreDb.db
    .insert(users)
    .values({
      id: 'user_remote_mcp',
      kind: 'human',
      displayName: 'Remote User',
      email: 'remote@example.test',
      emailVerified: false,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSeenAt: new Date().toISOString(),
    })
    .run();
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'user_remote_mcp',
    workspaceId: 'ws_demo',
  });
  const command = {
    store,
    dataRoot,
    workspaceId: 'ws_demo',
    actor: { kind: 'user' as const, id: 'user_remote_mcp' },
    requestId: randomUUID(),
    inflightCommands: new WeakMap(),
  };
  const appRecord = await createLightApp(command, {
    format: 'openkit.light-app',
    schemaVersion: 1,
    title: 'Remote MCP',
    purpose: 'Regression',
    collections: [
      {
        name: 'entries',
        type: 'base',
        description: 'Entries',
        indexes: [],
        fields: [{ name: 'note', type: 'text', required: true, description: 'Note' }],
      },
    ],
  });
  const token = (scope: 'workspace' | 'workspace-readonly' = 'workspace') =>
    createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_remote_mcp',
      scope,
      workspaceIds: ['ws_demo'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
  const automationStore = new AutomationStore();
  const app = createApp({
    automationStore,
    coreDb,
    dataRoot,
    store,
    mode,
    ...(getBootReadiness ? { getBootReadiness } : {}),
  });
  const selectors = { workspaceId: 'ws_demo', appId: appRecord.appId };
  const message = async (
    method: string,
    params: unknown,
    secret?: string,
    path = '/mcp',
    headers = {}
  ) =>
    app.request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  const call = async (
    name: string,
    args: unknown,
    secret: string,
    headers: Record<string, string> = {}
  ) => {
    const response = await message(
      'tools/call',
      { name, arguments: args },
      secret,
      '/mcp',
      headers
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.error).toBeUndefined();
    return body.result;
  };
  return {
    app,
    coreDb,
    dataRoot,
    store,
    command,
    appRecord,
    token,
    selectors,
    message,
    call,
    automationStore,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('remote MCP App endpoint', () => {
  it('refuses all retained archive streams before processing and omits support discovery', async () => {
    const f = await fixture();
    const admin = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const before = f.store.listWorkspaces();
    const registryBefore = f.coreDb.sqlite
      .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
      .all();
    const exportDirectories = readdirSync(join(f.dataRoot, 'server', 'exports'), {
      recursive: true,
    }).sort();
    const workspaceDirectories = readdirSync(join(f.dataRoot, 'workspaces')).sort();
    const native = vi.spyOn(invocation, 'createOperationInvocation');
    try {
      for (const operation of [
        'workspace.archive-download',
        'workspace.archive-import-dry-run',
        'workspace.archive-import',
      ]) {
        const search = await f.call('search', { query: operation }, admin.secret);
        expect(
          JSON.parse(search.content[0].text).items.some(
            (item: { id: string }) => item.id === operation
          )
        ).toBe(false);
        for (const tool of ['describe', 'call']) {
          const result = await f.call(
            tool,
            {
              operation,
              ...(tool === 'call'
                ? { input: { workspaceId: 'ws_demo', exportId: 'absent', requestId: randomUUID() } }
                : {}),
            },
            admin.secret
          );
          expect(result.isError).toBe(true);
          expect(JSON.parse(result.content[0].text)).toEqual({
            code: 'mcp_streaming_operation',
            message:
              'Streaming operations are unavailable over MCP. Use the retained archive transfer interface.',
            status: 400,
          });
        }
      }
      expect(native).not.toHaveBeenCalled();
      expect(existsSync(join(f.dataRoot, 'server', 'files', 'workspace-archive-requests'))).toBe(
        false
      );
      expect(
        readdirSync(join(f.dataRoot, 'server', 'exports'), { recursive: true }).sort()
      ).toEqual(exportDirectories);
      expect(readdirSync(join(f.dataRoot, 'workspaces')).sort()).toEqual(workspaceDirectories);
      expect(f.store.listWorkspaces()).toEqual(before);
      expect(
        f.coreDb.sqlite.prepare('SELECT * FROM workspace_registry ORDER BY workspace_id').all()
      ).toEqual(registryBefore);
      for (const operation of ['connection.meta', 'health', 'diagnostics', 'openapi']) {
        const result = await f.call('describe', { operation }, admin.secret);
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          code: 'unsupported_operation',
          status: 400,
        });
      }
      const guide = await f.call('guide', {}, admin.secret);
      expect(guide.content[0].text).toContain('ordinary users use Web Portability');
      expect(guide.content[0].text).toContain('administrator CLI');
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('serves both named diagnostics only to current administrators through real MCP', async () => {
    const f = await fixture();
    const admin = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const member = f.token();
    try {
      for (const operation of ['diagnostics.app', 'diagnostics.setup']) {
        const permitted = await f.call('call', { operation, input: {} }, admin.secret);
        expect(permitted.isError).not.toBe(true);
        expect(JSON.parse(permitted.content[0].text)).toMatchObject({ service: 'nanocore' });
        const denied = await f.call('call', { operation, input: {} }, member.secret);
        expect(denied.isError).toBe(true);
        expect(JSON.parse(denied.content[0].text)).toMatchObject({
          code: 'deployment_admin_required',
          status: 403,
        });
      }
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    ['omitted query', {}],
    ['empty query', { query: '' }],
    ['whitespace query', { query: ' \t\n ' }],
  ] as const)('returns the exact empty search result for %s through authorized HTTP and remote MCP', async (_label, input) => {
    const f = await fixture();
    const bearer = f.token('workspace-readonly');
    try {
      const http = await f.app.request('/api/app/operations/app.search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer.secret}` },
        body: JSON.stringify(input),
      });
      expect(http.status).toBe(200);
      expect(await http.json()).toEqual({ items: [] });

      const mcp = await f.call('call', { operation: 'app.search', input }, bearer.secret);
      expect(mcp.isError).not.toBe(true);
      expect(JSON.parse(mcp.content[0].text)).toEqual({ items: [] });
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    'missing',
    'private',
    'foreign',
  ] as const)('preserves the known %s scheduler refusal through HTTP and MCP without changing queue rows', async (target) => {
    const f = await fixture();
    const bearer = f.token();
    const thread = f.store.createThread('ws_demo', 'Private queue', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'user_other',
    });
    for (const [queueEntryId, workspaceId] of [
      ['queue_private', 'ws_demo'],
      ['queue_foreign', 'ws_foreign'],
    ] as const) {
      createSchedulerAdmissionEntry(f.coreDb, {
        backendId: 'nanohost',
        queueEntryId,
        workspaceId,
        threadId: thread.id,
        turnId: `turn_${queueEntryId}`,
        triggerActor: { kind: 'user', id: 'user_remote_mcp' },
        turnInput: 'Protected work',
        requestedAgentId: 'agent_codex_host',
      });
      denySchedulerAdmissionEntry(f.coreDb, { queueEntryId, denialReason: 'authority-denied' });
    }
    const before = ['queue_private', 'queue_foreign'].map((id) =>
      requireSchedulerAdmissionEntry(f.coreDb, id)
    );
    try {
      for (const operation of ['scheduler.retry', 'scheduler.cancel'] as const) {
        const input = { workspaceId: 'ws_demo', queueEntryId: `queue_${target}` };
        const http = await f.app.request(`/api/app/operations/${operation}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer.secret}` },
          body: JSON.stringify(input),
        });
        expect(http.status).toBe(404);
        expect(await http.json()).toEqual({
          protocolVersion: '0.5.0',
          code: 'not_found',
          message: 'Thread not found.',
        });
        expect(
          ['queue_private', 'queue_foreign'].map((id) =>
            requireSchedulerAdmissionEntry(f.coreDb, id)
          )
        ).toEqual(before);
        const mcp = await f.call('call', { operation, input }, bearer.secret);
        expect(mcp.isError).toBe(true);
        expect(JSON.parse(mcp.content[0].text)).toEqual({
          code: 'not_found',
          message: 'Thread not found.',
          status: 404,
        });
        expect(
          ['queue_private', 'queue_foreign'].map((id) =>
            requireSchedulerAdmissionEntry(f.coreDb, id)
          )
        ).toEqual(before);
      }
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('creates a Goal through remote MCP and wakes its existing coordinator owner', async () => {
    const createCoordinator = goalCoordinator.createGoalCoordinator;
    const wake = vi.fn();
    vi.spyOn(goalCoordinator, 'createGoalCoordinator').mockImplementation((options) => ({
      ...createCoordinator(options),
      wake,
    }));
    const f = await fixture();
    try {
      const result = await f.call(
        'call',
        {
          operation: 'goal.create',
          input: {
            workspaceId: 'ws_demo',
            requestId: randomUUID(),
            intent: 'Prepare a reviewed design',
          },
        },
        f.token().secret
      );
      expect(result.isError).not.toBe(true);
      const created = JSON.parse(result.content[0].text);
      expect(created.goal).toMatchObject({
        workspaceId: 'ws_demo',
        responsibleUserId: 'user_remote_mcp',
        intent: 'Prepare a reviewed design',
      });
      expect(f.store.getThread('ws_demo', created.goal.threadId).visibility).toBe('workspace');
      expect(wake).toHaveBeenCalledExactlyOnceWith('ws_demo', created.goal.goalId);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('refuses mutating calls while product admission is closed and keeps non-mutating calls available', async () => {
    let readiness = computeBootReadinessSnapshot({ bootId: 'boot_mcp_admission' });
    const f = await fixture('server', () => readiness);
    const token = f.token();
    readiness = computeBootReadinessSnapshot({
      bootId: readiness.bootId,
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
    });
    const threadCount = f.store.listThreads('ws_demo').length;
    const mutation = await f.call(
      'call',
      {
        operation: 'thread.create',
        input: { workspaceId: 'ws_demo', name: 'Blocked MCP Thread', requestId: randomUUID() },
      },
      token.secret
    );
    expect(f.store.listThreads('ws_demo')).toHaveLength(threadCount);
    expect(mutation.isError).toBe(true);
    expect(JSON.parse(mutation.content[0].text)).toEqual({
      code: 'product_work_unavailable',
      message: 'NanoCore is not accepting product work during the current boot readiness state.',
      status: 503,
    });
    const read = await f.call('call', { operation: 'workspace.list', input: {} }, token.secret);
    expect(read.isError).not.toBe(true);
    expect(JSON.parse(read.content[0].text).items).toEqual([
      expect.objectContaining({ workspace: expect.objectContaining({ id: 'ws_demo' }) }),
    ]);
  });

  it('gates all B6 Vault mutations on HTTP and MCP readiness without changing Vault rows', async () => {
    let readiness = computeBootReadinessSnapshot({ bootId: 'boot_b6_admission' });
    const f = await fixture('server', () => readiness);
    const token = f.token();
    const rows = () => ({
      references: f.coreDb.sqlite.prepare('SELECT * FROM vault_references').all(),
      grants: f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all(),
      audit: f.coreDb.sqlite.prepare('SELECT * FROM vault_admin_audit_events').all(),
    });
    const before = rows();
    readiness = { ...readiness, acceptingProductWork: false };
    try {
      for (const [operation, input] of [
        ['vault.unlock', { masterKeyBase64: Buffer.alloc(32, 9).toString('base64') }],
        ['vault.lock', {}],
        ['vault.bootstrap-codex-auth', { authJsonBase64: 'e30=' }],
        ['vault.provider-api-key-set', { providerId: 'provider-b6', apiKey: 'synthetic-b6-key' }],
        [
          'vault.secret-create',
          { workspaceId: 'ws_demo', secretKind: 'github-token', material: 'synthetic-b6-material' },
        ],
        [
          'vault.secret-rotate',
          { workspaceId: 'ws_demo', referenceId: 'vault_b6', material: 'synthetic-b6-next' },
        ],
        ['vault.secret-revoke', { workspaceId: 'ws_demo', referenceId: 'vault_b6' }],
        ['vault.grant-create', { workspaceId: 'ws_demo', referenceId: 'vault_b6' }],
        ['vault.grant-revoke', { workspaceId: 'ws_demo', grantId: 'grant_b6' }],
        [
          'vault.reference-rebind',
          { workspaceId: 'ws_demo', referenceId: 'vault_b6', materialBase64: 'e30=' },
        ],
      ] as const) {
        expect(OPERATION_DEFINITIONS[operation].mutating).toBe(true);
        expect(OPERATION_DEFINITIONS[operation].returnsOneTimeSecret).toBe(false);
        OPERATION_DEFINITIONS[operation].inputSchema.parse(input);
        const http = await f.app.request(`/api/app/operations/${operation}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token.secret}`, 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        expect(http.status).toBe(503);
        await expect(http.json()).resolves.toMatchObject({ code: 'product_work_unavailable' });
        const mcp = await f.call('call', { operation, input }, token.secret);
        expect(mcp.isError).toBe(true);
        expect(JSON.parse(mcp.content[0].text)).toMatchObject({ code: 'product_work_unavailable' });
        expect(rows()).toEqual(before);
      }
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('gates every migrated mutation on HTTP and MCP readiness before the protected owner changes', async () => {
    let readiness = computeBootReadinessSnapshot({ bootId: 'boot_b9_admission' });
    const f = await fixture('server', () => readiness);
    const token = f.token();
    const automation = f.automationStore.createAutomation('user_remote_mcp', {
      workspaceId: 'ws_demo',
      name: 'Existing',
      cron: '*',
      prompt: 'Work',
    });
    const thread = f.store.createThread('ws_demo', 'Recovery admission');
    const turn = f.store.createTurn('ws_demo', thread.id, 'Interrupted work', {
      kind: 'user',
      id: 'user_remote_mcp',
    });
    f.store.updateTurn(turn.id, { status: 'interrupted', completedAt: new Date().toISOString() });
    for (const queueEntryId of ['queue_b9_retry', 'queue_b9_cancel'])
      createSchedulerAdmissionEntry(f.coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'user_remote_mcp' },
        queueEntryId,
        requestId: `request_${queueEntryId}`,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: `turn_${queueEntryId}`,
        turnInput: 'Work',
        requestedAgentId: 'agent_codex_host',
      });
    denySchedulerAdmissionEntry(f.coreDb, {
      queueEntryId: 'queue_b9_retry',
      denialReason: 'authority-denied',
    });
    const workspaceDb = openWorkspaceDb(f.dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    const beforeTurn = { ...f.store.getTurnById(turn.id) };
    const beforeRetry = requireSchedulerAdmissionEntry(f.coreDb, 'queue_b9_retry');
    const beforeCancel = requireSchedulerAdmissionEntry(f.coreDb, 'queue_b9_cancel');
    readiness = { ...readiness, acceptingProductWork: false };
    try {
      for (const [operation, input] of [
        [
          'automation.create',
          { workspaceId: 'ws_demo', name: 'Blocked', cron: '*', prompt: 'Work' },
        ],
        ['automation.update', { automationId: automation.id, status: 'enabled' }],
        ['automation.delete', { automationId: automation.id }],
        ['scheduler.retry', { workspaceId: 'ws_demo', queueEntryId: 'queue_b9_retry' }],
        ['scheduler.cancel', { workspaceId: 'ws_demo', queueEntryId: 'queue_b9_cancel' }],
        [
          'recovery.checkpoint-retry',
          {
            workspaceId: 'ws_demo',
            threadId: thread.id,
            turnId: turn.id,
            requestId: 'req_b9_closed',
          },
        ],
      ] as const) {
        const http = await f.app.request(`/api/app/operations/${operation}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token.secret}`,
            'content-type': 'application/json',
            'x-openkit-request-id': 'req_b9_closed',
          },
          body: JSON.stringify(input),
        });
        expect(http.status).toBe(503);
        await expect(http.json()).resolves.toMatchObject({ code: 'product_work_unavailable' });
        const mcp = await f.call('call', { operation, input }, token.secret);
        expect(mcp.isError).toBe(true);
        expect(JSON.parse(mcp.content[0].text)).toMatchObject({ code: 'product_work_unavailable' });
        expect(f.automationStore.listAutomations('user_remote_mcp')).toEqual([automation]);
        expect(requireSchedulerAdmissionEntry(f.coreDb, 'queue_b9_retry')).toEqual(beforeRetry);
        expect(requireSchedulerAdmissionEntry(f.coreDb, 'queue_b9_cancel')).toEqual(beforeCancel);
        expect(f.store.getTurnById(turn.id)).toEqual(beforeTurn);
        expect(
          f.store.getCommandRequest(
            'worker.recovery.retry',
            'req_b9_closed',
            { workspaceId: 'ws_demo', threadId: thread.id, turnId: turn.id },
            workspaceDb
          )
        ).toBeNull();
      }
    } finally {
      workspaceDb.sqlite.close();
      f.coreDb.sqlite.close();
    }
  });

  it('projects automation deletion as logical null through MCP and refuses readonly or revoked mutations before changing the record', async () => {
    const f = await fixture();
    const token = f.token();
    const readonly = f.token('workspace-readonly');
    const automation = f.automationStore.createAutomation('user_remote_mcp', {
      workspaceId: 'ws_demo',
      name: 'Existing',
      cron: '*',
      prompt: 'Work',
    });
    try {
      for (const [operation, input] of [
        ['automation.update', { automationId: automation.id, status: 'enabled' }],
        ['automation.delete', { automationId: automation.id }],
      ] as const) {
        const denied = await f.call('call', { operation, input }, readonly.secret);
        expect(denied.isError).toBe(true);
        expect(f.automationStore.getAutomation('user_remote_mcp', automation.id)).toEqual(
          automation
        );
      }
      const deleted = await f.call(
        'call',
        { operation: 'automation.delete', input: { automationId: automation.id } },
        token.secret
      );
      expect(deleted.isError).not.toBe(true);
      expect(JSON.parse(deleted.content[0].text)).toBeNull();
      expect(f.automationStore.listAutomations('user_remote_mcp')).toEqual([]);
      const retained = f.automationStore.createAutomation('user_remote_mcp', {
        workspaceId: 'ws_demo',
        name: 'Retained',
        cron: '*',
        prompt: 'Work',
      });
      revokeOpenKitAccessTokenRecord(f.coreDb, token.record.tokenId);
      const revoked = await f.message(
        'tools/call',
        {
          name: 'call',
          arguments: { operation: 'automation.delete', input: { automationId: retained.id } },
        },
        token.secret
      );
      expect(revoked.status).toBe(401);
      expect(f.automationStore.getAutomation('user_remote_mcp', retained.id)).toEqual(retained);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('gates every newly migrated command before MCP effects during closed boot admission', async () => {
    let readiness = computeBootReadinessSnapshot({ bootId: 'boot_core_command_mcp' });
    const f = await fixture('server', () => readiness);
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_remote_mcp',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const turn = f.store.createTurn('ws_demo', 'th_demo', 'Preserve this Turn', {
      kind: 'user',
      id: 'user_remote_mcp',
    });
    const workspaces = f.store.listWorkspaces();
    const threads = f.store.listThreads('ws_demo');
    const receipts = f.store.listCommandRequests();
    const feedbackPath = feedbackFilePath(f.store, turn);
    expect(existsSync(feedbackPath)).toBe(false);
    readiness = computeBootReadinessSnapshot({
      bootId: readiness.bootId,
      subsystems: {
        storage: {
          state: 'failed',
          reasons: [{ code: 'storage.failed', message: 'Unavailable.', blocks: ['product_work'] }],
        },
      },
    });
    for (const [operation, input] of [
      ['workspace.create', { name: 'Blocked' }],
      ['workspace.update', { workspaceId: 'ws_demo', name: 'Blocked' }],
      ['thread.update', { workspaceId: 'ws_demo', threadId: 'th_demo', name: 'Blocked' }],
      ['thread.archive', { workspaceId: 'ws_demo', threadId: 'th_demo' }],
      ['turn.start', { workspaceId: 'ws_demo', threadId: 'th_demo', input: 'Blocked' }],
      ['turn.interrupt', { workspaceId: 'ws_demo', threadId: 'th_demo', turnId: turn.id }],
      ['turn.feedback', { turnId: turn.id, rating: 'good', note: 'Blocked' }],
      ['chat.quick', { input: 'Blocked' }],
    ] as const) {
      const result = await f.call(
        'call',
        {
          operation,
          input: {
            ...input,
            ...(['turn.feedback', 'chat.quick'].includes(operation)
              ? {}
              : { requestId: randomUUID() }),
          },
        },
        token.secret
      );
      expect(result.isError, operation).toBe(true);
      expect(JSON.parse(result.content[0].text), operation).toEqual({
        code: 'product_work_unavailable',
        message: 'NanoCore is not accepting product work during the current boot readiness state.',
        status: 503,
      });
      expect(f.store.listWorkspaces()).toEqual(workspaces);
      expect(f.store.listThreads('ws_demo')).toEqual(threads);
      expect(f.store.getTurnById(turn.id)).toEqual(turn);
      expect(existsSync(feedbackPath)).toBe(false);
      expect(f.store.listCommandRequests()).toEqual(receipts);
    }
  });

  it('preserves the native interrupt refusal through MCP without a receipt or Turn write', async () => {
    const f = await fixture();
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_remote_mcp',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const turn = f.store.createTurn('ws_demo', 'th_demo', 'No assigned session', {
      kind: 'user',
      id: 'user_remote_mcp',
    });
    const receipts = f.store.listCommandRequests();
    const result = await f.call(
      'call',
      {
        operation: 'turn.interrupt',
        input: {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: turn.id,
          requestId: randomUUID(),
        },
      },
      token.secret
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'recovery_required' });
    expect(f.store.getTurnById(turn.id)).toEqual(turn);
    expect(f.store.listCommandRequests()).toEqual(receipts);
  });

  it('preserves a typed owner validation refusal through MCP without a Workspace or receipt write', async () => {
    const f = await fixture();
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_remote_mcp',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const workspace = f.store.getWorkspace('ws_demo');
    const receipts = f.store.listCommandRequests();
    vi.spyOn(f.store, 'updateWorkspace').mockImplementation(() => {
      throw new KnowledgePageValidationError();
    });
    const result = await f.call(
      'call',
      {
        operation: 'workspace.update',
        input: { workspaceId: 'ws_demo', name: 'Refused', requestId: randomUUID() },
      },
      token.secret
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      code: 'invalid_request',
      message: 'Knowledge Page validation failed.',
      status: 400,
    });
    expect(f.store.getWorkspace('ws_demo')).toEqual(workspace);
    expect(f.store.listCommandRequests()).toEqual(receipts);
  });

  it('challenges missing, unknown, malformed, expired and revoked credentials uniformly before dispatch', async () => {
    const f = await fixture();
    const expired = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_remote_mcp',
      scope: 'workspace',
      workspaceIds: ['ws_demo'],
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const revoked = f.token();
    revokeOpenKitAccessTokenRecord(f.coreDb, revoked.record.tokenId);
    const invoke = vi.spyOn(invocation, 'createOperationInvocation');
    const bodies: string[] = [];
    for (const secret of [
      undefined,
      'okt_unknown_fake',
      'malformed',
      expired.secret,
      revoked.secret,
    ]) {
      const response = await f.message(
        'tools/call',
        { name: 'call', arguments: { operation: 'kernel.records.create' } },
        secret
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      const body = await response.text();
      if (secret) expect(body).not.toContain(secret);
      bodies.push(body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('requires the bearer header even in local mode and ignores cookie, body and query credentials', async () => {
    const f = await fixture('local');
    const token = f.token();
    for (const [path, params, headers] of [
      [`/mcp?token=${token.secret}`, {}, {}],
      ['/mcp', { token: token.secret }, {}],
      ['/mcp', {}, { cookie: `token=${token.secret}; session=browser` }],
    ] as const) {
      expect((await f.message('tools/list', params, undefined, path, headers)).status).toBe(401);
    }
    expect(
      (
        await f.message('tools/list', {}, token.secret, `/mcp?token=malformed`, {
          cookie: 'token=malformed',
        })
      ).status
    ).toBe(200);
  });

  it('refuses real non-loopback plaintext before verification even with a loopback Host', async () => {
    const f = await fixture();
    const token = f.token();
    const response = await f.app.fetch(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token.secret}` },
        body: '{}',
      }),
      { incoming: { socket: { remoteAddress: '192.0.2.1', encrypted: false } } }
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('core.auth.insecure_transport');
    expect(
      f.coreDb.sqlite
        .prepare('SELECT last_used_at FROM openkit_access_tokens WHERE token_id = ?')
        .get(token.record.tokenId)
    ).toEqual({ last_used_at: null });
  });

  it('derives exactly four tools and per-operation annotations and bounded ranked search from all definitions', async () => {
    const f = await fixture();
    const token = f.token();
    // Metadata discovery keeps real Token and audit writes in one rolled-back fixture transaction.
    f.coreDb.sqlite.exec('BEGIN');
    try {
      const listed = await (await f.message('tools/list', {}, token.secret)).json();
      expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        'search',
        'describe',
        'guide',
        'call',
      ]);
      expect(
        listed.result.tools
          .slice(0, 3)
          .every(
            (tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint
          )
      ).toBe(true);
      expect(listed.result.tools[3].annotations.readOnlyHint).toBe(false);
      for (const [id, definition] of Object.entries(OPERATION_DEFINITIONS).filter(
        ([, definition]) => operationMcpEligible(definition)
      )) {
        const result = await f.call('describe', { operation: id }, token.secret);
        const data = JSON.parse(result.content[0].text);
        expect(data.id).toBe(id);
        expect(data.annotations.readOnlyHint).toBe(!definition.mutating);
        expect(data.inputSchema.type).toBe('object');
      }
      const a = JSON.parse(
        (await f.call('search', { query: 'kernel record create' }, token.secret)).content[0].text
      );
      const b = JSON.parse(
        (await f.call('search', { query: 'create record kernel' }, token.secret)).content[0].text
      );
      expect(a).toEqual(b);
      expect(a.items[0].id).toBe('kernel.records.create');
      const additions = Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [
          `test.record.${i}`,
          OPERATION_DEFINITIONS['kernel.records.create'],
        ])
      );
      Object.assign(OPERATION_DEFINITIONS, additions);
      try {
        const page = JSON.parse(
          (await f.call('search', { query: 'record' }, token.secret)).content[0].text
        );
        expect(page.items.length).toBeLessThan(page.total);
        expect(page.hasMore).toBe(true);
      } finally {
        for (const id of Object.keys(additions))
          delete (OPERATION_DEFINITIONS as unknown as Record<string, unknown>)[id];
      }
    } finally {
      f.coreDb.sqlite.exec('ROLLBACK');
      f.coreDb.sqlite.close();
    }
  });

  it('reaches every eligible definition through search, describe and native call with the exact Token actor', async () => {
    const f = await fixture();
    const token = f.token();
    const native = vi.fn(async () => ({ reached: true }));
    vi.spyOn(invocation, 'createOperationInvocation').mockReturnValue(native);
    // This dispatch probe keeps real bearer verification and audit writes, but batches
    // their fixture-local commits instead of fsyncing three requests per definition.
    f.coreDb.sqlite.exec('BEGIN');
    try {
      const excluded = Object.entries(OPERATION_DEFINITIONS)
        .filter(([, definition]) => !operationMcpEligible(definition))
        .map(([id]) => id)
        .sort();
      expect(excluded).toEqual([
        'bootstrap.consume',
        'token.create',
        'token.rotate',
        'workspace.archive-download',
        'workspace.archive-import',
        'workspace.archive-import-dry-run',
      ]);
      for (const [operation, definition] of Object.entries(OPERATION_DEFINITIONS)) {
        const search = JSON.parse(
          (await f.call('search', { query: operation }, token.secret)).content[0].text
        );
        const described = await f.call('describe', { operation }, token.secret);
        const input = { requestId: randomUUID(), reachProbe: operation };
        const before = native.mock.calls.length;
        const called = await f.call('call', { operation, input }, token.secret);
        if (operationMcpEligible(definition)) {
          expect(search.items.map((item: { id: string }) => item.id)).toContain(operation);
          expect(JSON.parse(described.content[0].text).id).toBe(operation);
          expect(called.isError).not.toBe(true);
          expect(native).toHaveBeenLastCalledWith(
            operation,
            input,
            expect.objectContaining({
              kind: 'public',
              delivery: 'model',
              actor: expect.objectContaining({
                userId: 'user_remote_mcp',
                tokenId: token.record.tokenId,
              }),
            })
          );
          expect(native.mock.calls.length).toBe(before + 1);
        } else {
          expect(search.items.map((item: { id: string }) => item.id)).not.toContain(operation);
          for (const result of [described, called]) {
            expect(result.isError).toBe(true);
            expect(JSON.parse(result.content[0].text).code).toBe(
              definition.returnsOneTimeSecret
                ? 'mcp_secret_returning_operation'
                : 'mcp_streaming_operation'
            );
          }
          expect(native.mock.calls.length).toBe(before);
        }
      }
    } finally {
      f.coreDb.sqlite.exec('ROLLBACK');
      f.coreDb.sqlite.close();
    }
  });

  it('serves progressive product guidance and never issues OAuth metadata or a refresh token', async () => {
    const f = await fixture();
    const token = f.token();
    const guide = await f.call('guide', {}, token.secret);
    expect(guide.content[0].text.split('\n\n')[2]).toBe(
      'Follow the product loop: select a Workspace, inspect authorized resources and data sources, select or create a Thread, and read its durable state. Inspect repositories only when a Git source or code host is selected. Use Chat for a lightweight answer, Task for bounded delegated work, or Goal for a continuous outcome with immutable Plan approval and completion acceptance. Describe Goal operations before use; card and intent edits do not steer running workers, and there is no Goal step, pause or resume. Formal Task/Goal Threads use workspace visibility explicitly. Read Action Center, the exact receiving Thread and Turn, artifacts, evidence, audit and usage before reporting completion. Command acceptance and configured Worker health do not prove Worker success. Private audiences and credential limits remain enforced even when operation metadata is visible.'
    );
    expect(guide.content[0].text.split('\n\n')[3]).toBe(
      'Read durable state after a mutation. A transport failure does not prove that an effect did not happen. Inspect the owner outcome before retrying; reuse the exact requestId only for an exact replay with unchanged input. Never claim cancellation from a disconnected client. Follow long work through bounded reads with a deadline. For recovery_required, stale lineage, denied admission or contradictory evidence, retain the typed refusal and inspect the owning records; do not manufacture receipts, edit storage, silently substitute Worker storage or automatically rerun work. Worker storage selection is an eligibility preview, not attachment or retained work-slot recovery. Preserve exact storage revisions and predecessor work-slot lineage. Administrator-originated Tasks retain the presented credential for later effect revalidation.'
    );
    expect(guide.content[0].text).toContain('Ask the user');
    expect(guide.content[0].text).toContain('default_tools_approval_mode');
    expect(guide.content[0].text).not.toMatch(
      /OpenKit Skill|not yet migrated|Goal execution remains unavailable/
    );
    for (const criterion of [
      'Chat',
      'Task',
      'Goal',
      'Action Center',
      'exact proposal',
      'requestId',
      'Web Portability',
      'openkit-ops',
      'bootstrap',
      'knowledge',
      'acceptance',
    ]) {
      expect(guide.content[0].text).toContain(criterion);
    }
    const init = await (
      await f.message(
        'initialize',
        {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'regression', version: '1' },
        },
        token.secret
      )
    ).json();
    expect(init.result.protocolVersion).toBe('2025-11-25');
    expect(JSON.stringify(init)).not.toMatch(/refresh_token|resource_metadata/);
    expect(
      (await f.app.request('http://127.0.0.1/.well-known/oauth-protected-resource')).status
    ).toBe(404);
  });

  it('invokes natively as the Token user and records server-owned channel and credential attribution', async () => {
    const f = await fixture();
    const token = f.token();
    const invoke = vi.spyOn(invocation, 'createOperationInvocation');
    const requestId = randomUUID();
    const result = await f.call(
      'call',
      {
        operation: 'kernel.records.create',
        input: {
          ...f.selectors,
          collection: 'entries',
          schemaRevision: 1,
          requestId,
          data: { note: 'MCP attribution' },
        },
      },
      token.secret,
      {
        'x-openkit-client-channel': 'caller-channel',
        'x-openkit-client-source': 'caller-source',
      }
    );
    expect(result.isError).not.toBe(true);
    expect(invoke).toHaveBeenCalled();
    const records = listRecords(f.dataRoot, 'ws_demo', f.appRecord.appId, 'entries', {
      schemaRevision: 1,
    });
    expect(records.items).toHaveLength(1);
    const appDb = openExistingAppDb(f.dataRoot, 'ws_demo', f.appRecord.appId);
    try {
      expect(
        appDb.sqlite
          .prepare("SELECT actor_json FROM audit_events WHERE action = 'kernel.records.create'")
          .get()
      ).toEqual({ actor_json: JSON.stringify({ kind: 'user', id: 'user_remote_mcp' }) });
    } finally {
      appDb.sqlite.close();
    }
    const row = f.coreDb.sqlite
      .prepare(
        'SELECT owner_user_id, last_used_channel, last_used_source FROM openkit_access_tokens WHERE token_id = ?'
      )
      .get(token.record.tokenId);
    expect(row).toEqual({
      owner_user_id: 'user_remote_mcp',
      last_used_channel: 'remote-mcp',
      last_used_source: 'remote-mcp',
    });
    const audit = listServerAuditEvents(f.coreDb).find(
      (event) => event.action === 'remote-mcp.request'
    );
    expect(audit?.actor).toEqual({ kind: 'user', id: 'user_remote_mcp' });
    expect(audit?.summary).toContain(token.record.tokenId);
    expect(audit?.summary).toContain('remote-mcp');
    expect(audit?.requestId).toBe(requestId);
    expect(audit?.resource).toBe('operation:kernel.records.create');
    expect(JSON.stringify(audit)).not.toContain(token.secret);
    const read = await f.call(
      'call',
      { operation: 'kernel.apps.get', input: f.selectors },
      token.secret
    );
    expect(JSON.parse(read.content[0].text)).toEqual(
      getLightApp(f.dataRoot, 'ws_demo', f.appRecord.appId)
    );
  });

  it('keeps read-only reads, mutation refusals as tool results and next-request revocation', async () => {
    const f = await fixture();
    const token = f.token('workspace-readonly');
    expect(
      (await f.call('call', { operation: 'kernel.apps.get', input: f.selectors }, token.secret))
        .isError
    ).not.toBe(true);
    const refused = await f.call(
      'call',
      {
        operation: 'kernel.records.create',
        input: {
          ...f.selectors,
          collection: 'entries',
          schemaRevision: 1,
          requestId: randomUUID(),
          data: { note: 'forbidden' },
        },
      },
      token.secret
    );
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0].text).code).toBe('workspace_access_denied');
    expect(
      listRecords(f.dataRoot, 'ws_demo', f.appRecord.appId, 'entries', { schemaRevision: 1 }).items
    ).toHaveLength(0);
    revokeOpenKitAccessTokenRecord(f.coreDb, token.record.tokenId);
    expect((await f.message('tools/list', {}, token.secret)).status).toBe(401);
  });

  it('preserves an owner bearer refusal with its exact native outcome and actor', async () => {
    const f = await fixture();
    const token = f.token();
    const actor = {
      kind: 'token' as const,
      userId: 'user_remote_mcp',
      tokenId: token.record.tokenId,
      tokenScope: 'workspace' as const,
      tokenWorkspaceIds: ['ws_demo'],
    };
    const expected = await invocation
      .createOperationInvocation({ coreDb: f.coreDb })(
        'nanohost.runtime-target',
        {},
        { kind: 'public', actor }
      )
      .catch((error: Error & { code: string; status: number }) => ({
        code: error.code,
        message: error.message,
        status: error.status,
      }));
    const result = await f.call(
      'call',
      { operation: 'nanohost.runtime-target', input: {} },
      token.secret
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual(expected);
  });

  it.each([
    'token.create',
    'token.rotate',
    'bootstrap.consume',
  ] as const)('omits and refuses %s over remote MCP before token writes', async (id) => {
    const f = await fixture();
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_remote_mcp',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const input =
      id === 'token.create'
        ? { scope: 'server-admin', expiresAt: '2099-01-01T00:00:00.000Z' }
        : id === 'token.rotate'
          ? { tokenId: token.record.tokenId }
          : {
              token: 'okt_bootstrap_fixture',
              ownerUserId: 'user_bootstrap',
              displayName: 'Owner',
              email: 'owner@example.test',
              password: 'fixture-password',
              tokenExpiresAt: '2099-01-01T00:00:00.000Z',
            };
    const before = f.coreDb.sqlite
      .prepare(
        'SELECT token_id, token_hash, status, revoked_at, predecessor_token_id, rotated_grace_expires_at FROM openkit_access_tokens ORDER BY token_id'
      )
      .all();
    // Collect every projection and row boundary so one missing declaration cannot mask later evidence.
    for (const name of ['search', 'describe', 'call']) {
      const result = await f.call(
        name,
        name === 'search'
          ? { query: id }
          : name === 'describe'
            ? { operation: id }
            : { operation: id, input },
        token.secret
      );
      if (name === 'search') {
        expect.soft(result.isError).not.toBe(true);
        expect
          .soft(JSON.parse(result.content[0].text).items)
          .not.toContainEqual(expect.objectContaining({ id }));
      } else {
        expect.soft(result.isError).toBe(true);
        expect.soft(JSON.parse(result.content[0].text).code).toBe('mcp_secret_returning_operation');
      }
      expect.soft(JSON.stringify(result)).not.toContain(token.secret);
      expect.soft(JSON.stringify(result)).not.toMatch(/okt_|token_hash/);
      expect
        .soft(
          f.coreDb.sqlite
            .prepare(
              'SELECT token_id, token_hash, status, revoked_at, predecessor_token_id, rotated_grace_expires_at FROM openkit_access_tokens ORDER BY token_id'
            )
            .all()
        )
        .toEqual(before);
    }
  });

  it('refuses declared one-time-secret results before dispatch when a credential definition is added', async () => {
    const f = await fixture();
    const token = f.token();
    const invoke = vi.spyOn(invocation, 'createOperationInvocation');
    for (const outputSchema of [
      CreateOpenKitAccessTokenResponseSchema,
      RotateOpenKitAccessTokenResponseSchema,
    ]) {
      Object.assign(OPERATION_DEFINITIONS, {
        'test.secret': {
          ...OPERATION_DEFINITIONS['kernel.apps.get'],
          outputSchema,
          returnsOneTimeSecret: true,
        },
      });
      try {
        const result = await f.call('call', { operation: 'test.secret', input: {} }, token.secret);
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text).code).toBe('mcp_secret_returning_operation');
        const search = await f.call('search', { query: 'test.secret' }, token.secret);
        expect(search.isError).not.toBe(true);
        expect(JSON.parse(search.content[0].text).items).not.toContainEqual(
          expect.objectContaining({ id: 'test.secret' })
        );
        const described = await f.call('describe', { operation: 'test.secret' }, token.secret);
        expect(described.isError).toBe(true);
        expect(described.content).toEqual(result.content);
        expect(described.content[0].text).not.toMatch(
          /"inputSchema"|"outputSchema"|"properties"|"token"|"record"/
        );
        expect(invoke).not.toHaveBeenCalled();
      } finally {
        delete (OPERATION_DEFINITIONS as unknown as Record<string, unknown>)['test.secret'];
      }
    }
  });

  it('returns MCP protocol errors without effects for malformed messages and unknown methods', async () => {
    const f = await fixture();
    const token = f.token();
    const response = await f.message('unknown/method', {}, token.secret);
    expect((await response.json()).error.code).toBe(-32601);
    const malformed = await f.app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.secret}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{',
    });
    expect((await malformed.json()).error).toBeDefined();
    expect(
      listRecords(f.dataRoot, 'ws_demo', f.appRecord.appId, 'entries', { schemaRevision: 1 }).items
    ).toHaveLength(0);
  });
});

it('preserves Workspace sharing HTTP/MCP conflict status and safe details without changing the target row or receipt', async () => {
  const f = await fixture('server', () => computeBootReadinessSnapshot({ bootId: 'boot_b23_mcp' }));
  try {
    const timestamp = new Date().toISOString();
    f.coreDb.sqlite
      .prepare(
        "INSERT INTO workspace_members (workspace_id,user_id,status,access_level,joined_at,revision,created_at,updated_at) VALUES ('ws_demo','user_local','active','editor',?,1,?,?)"
      )
      .run(timestamp, timestamp, timestamp);
    const token = f.token();
    const before = f.coreDb.sqlite
      .prepare(
        "SELECT * FROM workspace_members WHERE workspace_id = 'ws_demo' AND user_id = 'user_local'"
      )
      .get();
    for (const transport of ['http', 'mcp']) {
      const requestId = randomUUID();
      const input = {
        workspaceId: 'ws_demo',
        targetUserId: 'user_local',
        accessLevel: 'viewer',
        expectedRevision: 2,
        requestId,
      };
      let error: { code: string; status?: number; details?: unknown };
      if (transport === 'mcp') {
        const result = await f.call(
          'call',
          { operation: 'workspace.member-access-change', input },
          token.secret
        );
        expect(result.isError).toBe(true);
        error = JSON.parse(result.content[0].text);
        expect(error.status).toBe(409);
      } else {
        const { requestId: identity, ...body } = input;
        const response = await f.app.request('/api/app/operations/workspace.member-access-change', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token.secret}`,
            'content-type': 'application/json',
            'x-openkit-request-id': identity,
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(409);
        error = await response.json();
      }
      expect(error).toMatchObject({
        code: 'revision_conflict',
        details: {
          resource: 'membership',
          current: { userId: 'user_local', revision: 1, accessLevel: 'editor' },
        },
      });
      expect(
        f.coreDb.sqlite
          .prepare(
            "SELECT * FROM workspace_members WHERE workspace_id = 'ws_demo' AND user_id = 'user_local'"
          )
          .get()
      ).toEqual(before);
      expect(
        f.coreDb.sqlite
          .prepare('SELECT * FROM idempotency_requests WHERE request_id = ?')
          .all(requestId)
      ).toEqual([]);
    }
    const requestId = randomUUID();
    const input = {
      workspaceId: 'ws_demo',
      targetUserId: 'user_local',
      accessLevel: 'viewer',
      expectedRevision: 1,
      requestId,
    };
    const accepted = await f.call(
      'call',
      { operation: 'workspace.member-access-change', input },
      token.secret
    );
    expect(accepted.isError).not.toBe(true);
    const committedMember = f.coreDb.sqlite
      .prepare(
        "SELECT * FROM workspace_members WHERE workspace_id='ws_demo' AND user_id='user_local'"
      )
      .get();
    const committedReceipt = f.coreDb.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id = ?')
      .all(requestId);
    expect(committedReceipt).toHaveLength(1);
    const conflict = await f.call(
      'call',
      { operation: 'workspace.member-access-change', input: { ...input, accessLevel: 'editor' } },
      token.secret
    );
    expect(conflict.isError).toBe(true);
    expect(JSON.parse(conflict.content[0].text)).toMatchObject({
      code: 'idempotency_key_conflict',
      status: 409,
    });
    expect(
      f.coreDb.sqlite
        .prepare(
          "SELECT * FROM workspace_members WHERE workspace_id='ws_demo' AND user_id='user_local'"
        )
        .get()
    ).toEqual(committedMember);
    expect(
      f.coreDb.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id = ?')
        .all(requestId)
    ).toEqual(committedReceipt);
  } finally {
    f.coreDb.sqlite.close();
  }
});

it('refuses user.disable through MCP closed product admission without changing the target or a receipt', async () => {
  let readiness = computeBootReadinessSnapshot({ bootId: 'boot_b23_disable_mcp' });
  const f = await fixture('server', () => readiness);
  try {
    const admin = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_remote_mcp',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    readiness = computeBootReadinessSnapshot({
      bootId: readiness.bootId,
      subsystems: {
        storage: {
          state: 'failed',
          reasons: [{ code: 'storage.failed', message: 'Unavailable', blocks: ['product_work'] }],
        },
      },
    });
    const before = f.coreDb.sqlite.prepare("SELECT * FROM users WHERE id = 'user_local'").get();
    const requestId = randomUUID();
    const result = await f.call(
      'call',
      { operation: 'user.disable', input: { targetUserId: 'user_local', requestId } },
      admin.secret
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'product_work_unavailable' });
    expect(f.coreDb.sqlite.prepare("SELECT * FROM users WHERE id = 'user_local'").get()).toEqual(
      before
    );
    expect(
      f.coreDb.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id = ?')
        .all(requestId)
    ).toEqual([]);
  } finally {
    f.coreDb.sqlite.close();
  }
});
for (const projection of ['HTTP', 'MCP'] as const) {
  it(`keeps turn.interrupt cross-Workspace lineage refusal typed through ${projection} without effects`, async () => {
    const f = await fixture();
    try {
      const foreignWorkspace = f.store.createWorkspace('Foreign');
      const foreignThread = f.store.createThread(foreignWorkspace.id, 'Foreign Thread');
      const addressed = f.store.createTurn('ws_demo', 'th_demo', 'Addressed', {
        kind: 'user',
        id: 'user_remote_mcp',
      });
      const foreign = f.store.createTurn(foreignWorkspace.id, foreignThread.id, 'Foreign', {
        kind: 'user',
        id: 'user_remote_mcp',
      });
      const before = {
        addressed: f.store.getTurnById(addressed.id),
        foreign: f.store.getTurnById(foreign.id),
        receipts: f.store.listCommandRequests(),
      };
      const input = {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: foreign.id,
        requestId: randomUUID(),
      };
      const secret = f.token().secret;
      if (projection === 'HTTP') {
        const response = await f.app.request(
          ...operationRequest(
            'turn.interrupt',
            {},
            { body: JSON.stringify(input), headers: { authorization: `Bearer ${secret}` } }
          )
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'workspace_access_denied' });
      } else {
        const result = await f.call('call', { operation: 'turn.interrupt', input }, secret);
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          code: 'workspace_access_denied',
          message: 'Workspace access denied.',
        });
      }
      expect(f.store.getTurnById(addressed.id)).toEqual(before.addressed);
      expect(f.store.getTurnById(foreign.id)).toEqual(before.foreign);
      expect(f.store.listCommandRequests()).toEqual(before.receipts);
    } finally {
      f.coreDb.sqlite.close();
    }
  });
}

/** Exact Material bytes used by the channel regressions. */
function materialDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

for (const sensitivity of ['restricted', 'public', 'internal'] as const) {
  it(`keeps ${sensitivity} Material content at its trusted delivery boundary with no refused writes`, async () => {
    const f = await fixture();
    const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      const token = f.token();
      const content = `Exact ${sensitivity} Material bytes`;
      const { materialId } = createWorkspaceMaterial(db, {
        title: 'Channel boundary',
        kind: 'text',
        sensitivity,
        requestId: randomUUID(),
        actorId: 'user_remote_mcp',
        acceptedAt: new Date().toISOString(),
      });
      const { revisionId } = saveWorkspaceMaterialRevision(db, {
        materialId,
        content,
        contentDigest: materialDigest(content),
        expectedRevisionId: null,
        requestId: randomUUID(),
        actorId: 'user_remote_mcp',
        acceptedAt: new Date().toISOString(),
      });
      const selectors = { workspaceId: 'ws_demo', materialId };
      const counts = () => ({
        materials: db.sqlite.prepare('SELECT count(*) AS n FROM workspace_materials').get(),
        revisions: db.sqlite
          .prepare('SELECT count(*) AS n FROM workspace_material_revisions')
          .get(),
        receipts: f.store.listCommandRequests(),
      });
      const before = counts();
      const contentRead = vi.spyOn(materialOwners, 'getWorkspaceMaterialRevision');
      const contentSave = vi.spyOn(materialOwners, 'saveWorkspaceMaterialRevision');
      const materialCreate = vi.spyOn(materialOwners, 'createWorkspaceMaterial');
      const readInput = { ...selectors, revisionId };
      const saveInput = {
        ...selectors,
        requestId: randomUUID(),
        expectedRevisionId: revisionId,
        content: 'New exact bytes',
        contentDigest: materialDigest('New exact bytes'),
      };
      const read = await f.call(
        'call',
        { operation: 'material.revision-read', input: readInput },
        token.secret
      );
      const save = await f.call(
        'call',
        { operation: 'material.revision-save', input: saveInput },
        token.secret
      );
      const create = await f.call(
        'call',
        {
          operation: 'material.create',
          input: {
            workspaceId: 'ws_demo',
            requestId: randomUUID(),
            title: 'MCP create',
            kind: 'text',
            sensitivity,
          },
        },
        token.secret
      );
      if (sensitivity === 'restricted') {
        for (const result of [read, save, create]) {
          expect(result.isError).toBe(true);
          expect(JSON.parse(result.content[0].text)).toMatchObject({
            code: 'sensitive_content',
            status: 409,
          });
          expect(JSON.stringify(result)).not.toContain(content);
          expect(JSON.stringify(result)).not.toContain(saveInput.content);
        }
        expect(counts()).toEqual(before);
        expect(contentRead).not.toHaveBeenCalled();
        expect(contentSave).not.toHaveBeenCalled();
        expect(materialCreate).not.toHaveBeenCalled();
        const metadata = await f.call(
          'call',
          { operation: 'material.read', input: selectors },
          token.secret
        );
        expect(metadata.isError).not.toBe(true);
        expect(JSON.parse(metadata.content[0].text).material.sensitivity).toBe('restricted');
        const admin = createOpenKitAccessTokenRecord(f.coreDb, {
          ownerUserId: 'user_remote_mcp',
          scope: 'server-admin',
          workspaceIds: [],
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
        const adminRead = await f.call(
          'call',
          { operation: 'material.revision-read', input: readInput },
          admin.secret
        );
        expect(JSON.parse(adminRead.content[0].text)).toMatchObject({
          code: 'sensitive_content',
          status: 409,
        });
        expect(counts()).toEqual(before);
        const injected = await f.call(
          'call',
          { operation: 'material.revision-read', input: { ...readInput, delivery: 'human' } },
          token.secret
        );
        expect(JSON.parse(injected.content[0].text)).toMatchObject({
          code: 'invalid_request',
          status: 400,
        });
        expect(counts()).toEqual(before);
        const humanRead = await f.app.request(
          ...operationRequest('material.revision-read', readInput, {
            headers: { authorization: `Bearer ${token.secret}` },
          })
        );
        expect(humanRead.status).toBe(200);
        expect((await humanRead.json()).revision.content).toBe(content);
        const humanSave = await f.app.request(
          ...operationRequest(
            'material.revision-save',
            {},
            {
              headers: { authorization: `Bearer ${token.secret}` },
              body: JSON.stringify(saveInput),
            }
          )
        );
        expect(humanSave.status).toBe(201);
        expect((await humanSave.json()).revisionId).toBeTruthy();
      } else {
        for (const result of [read, save, create]) expect(result.isError).not.toBe(true);
        expect(contentRead).toHaveBeenCalledWith(expect.anything(), materialId, revisionId);
        expect(contentSave).toHaveBeenCalledOnce();
        expect(materialCreate).toHaveBeenCalledOnce();
        expect(JSON.parse(read.content[0].text).revision.content).toBe(content);
        expect(counts().receipts).toHaveLength(before.receipts.length + 2);
        const savedId = JSON.parse(save.content[0].text).revisionId;
        const saved = await f.call(
          'call',
          { operation: 'material.revision-read', input: { ...selectors, revisionId: savedId } },
          token.secret
        );
        expect(JSON.parse(saved.content[0].text).revision.content).toBe(saveInput.content);
      }
    } finally {
      db.sqlite.close();
      f.coreDb.sqlite.close();
    }
  });
}

for (const projection of ['HTTP', 'MCP'] as const) {
  it(`fences Material mutation through ${projection} when product work is unavailable without a row or receipt`, async () => {
    const readiness = computeBootReadinessSnapshot({
      bootId: 'material-closed',
      subsystems: {
        storage: {
          state: 'failed',
          reasons: [{ code: 'storage.failed', message: 'Unavailable', blocks: ['product_work'] }],
        },
      },
    });
    const f = await fixture('server', () => readiness);
    const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      const token = f.token();
      const rows = () => ({
        materials: db.sqlite.prepare('SELECT * FROM workspace_materials').all(),
        revisions: db.sqlite.prepare('SELECT * FROM workspace_material_revisions').all(),
        receipts: f.store.listCommandRequests(),
      });
      const before = rows();
      const input = {
        workspaceId: 'ws_demo',
        requestId: randomUUID(),
        title: 'Closed',
        kind: 'text',
        sensitivity: 'internal',
      };
      if (projection === 'HTTP') {
        const response = await f.app.request(
          ...operationRequest(
            'material.create',
            {},
            {
              headers: { authorization: `Bearer ${token.secret}` },
              body: JSON.stringify(input),
            }
          )
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: 'product_work_unavailable' });
      } else {
        const result = await f.call('call', { operation: 'material.create', input }, token.secret);
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          code: 'product_work_unavailable',
        });
      }
      expect(rows()).toEqual(before);
    } finally {
      db.sqlite.close();
      f.coreDb.sqlite.close();
    }
  });
}
