import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { OperationId } from '@openkit/app-api-schemas';
import { resolveWorkspaceMcpServer } from '@openkit/config-schema';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
  setDefaultServerAdminTokenId,
} from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import {
  composeWorkspaceMcpCatalog,
  createMcpConfig,
  updateMcpBinding,
} from '../catalog/resource-catalog.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import {
  acceptSchedulerExecutionObservation,
  closeSchedulerExecutionAttemptWithoutEffects,
  schedulerExecutionCorrelation,
} from '../runtime/execution-attempt-records.js';
import {
  createOpenkitGenerativeMcpSupply,
  dispatchOpenkitGenerativeTool,
} from '../runtime/openkit-generative-mcp.js';
import { recoverPendingRequestsAtBoot } from '../runtime/pending-request-flow.js';
import * as pendingRequests from '../runtime/pending-requests.js';
import { claimCommandIntentGrant, readPendingRequest } from '../runtime/pending-requests.js';
import type { WorkerControlGateway } from '../runtime/worker-control-gateway.js';
import { createDefaultWorkerMcpGateway } from '../runtime/worker-mcp-gateway.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { createMcpHttpStub } from '../test-support/mcp-http-stub.js';
import { operationRequest } from '../test-support/operation-request.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { createVaultInjectionPlan } from '../vault-injection-plans.js';
import { createVaultInjectionReceipt } from '../vault-injection-receipts.js';
import { registerWorkerMcpRoutes } from '../worker-mcp-routes.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { createVaultGrant, getVaultGrant } from './vault-grants.js';
import { createVaultReference } from './vault-references.js';
import { createVaultUnlockState } from './vault-unlock-state.js';

/** Owns one isolated real App/API fixture and removes every synthetic record at closeout. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'vault-grant-request-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const vaultUnlockState = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(dataRoot, 'server', 'vault'),
  });
  vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 19) });
  const store = new FsStore({ dataRoot });
  const agentManifests = [createTestAgentSetup().manifest];
  const app = createApp({ coreDb, dataRoot, vaultUnlockState, store, agentManifests });
  let server: ReturnType<typeof createApp> | undefined;
  let sessionServer: ReturnType<typeof createApp> | undefined;
  return {
    coreDb,
    dataRoot,
    store,
    sessionSend: (id: string, body: Record<string, unknown>) => {
      sessionServer ??= createApp({
        coreDb,
        dataRoot,
        vaultUnlockState,
        store,
        agentManifests,
        mode: 'server',
        auth: {
          api: {
            getSession: async () => ({
              session: { id: 'synthetic-session' },
              user: { id: 'user_local' },
            }),
          },
          handler: async () => Response.json({}),
        },
      });
      return sessionServer.request(
        ...operationRequest(
          id as OperationId,
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        )
      );
    },
    serverSend: (id: string, body: Record<string, unknown>, secret: string) => {
      server ??= createApp({
        coreDb,
        dataRoot,
        vaultUnlockState,
        store,
        agentManifests,
        mode: 'server',
        auth: { api: { getSession: async () => null }, handler: async () => Response.json({}) },
      });
      return server.request(
        ...operationRequest(
          id as OperationId,
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
            body: JSON.stringify(body),
          }
        )
      );
    },
    vaultUnlockState,
    send: (id: string, body: Record<string, unknown>) =>
      app.request(
        ...operationRequest(
          id as OperationId,
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        )
      ),
    cleanup: () => {
      vaultUnlockState.lock();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

describe('supported Vault grant request and review', () => {
  it('records exact requested terms without granting secret-use authority', async () => {
    const f = fixture();
    try {
      const workspace = await f.send('workspace.create', {
        name: 'Request review',
        requestId: randomUUID(),
      });
      expect(workspace.status).toBe(201);
      const workspaceId = (await workspace.json()).id;
      const thread = await f.send('thread.create', {
        workspaceId,
        name: 'Credential request',
        requestId: randomUUID(),
      });
      expect(thread.status).toBe(200);
      const threadId = (await thread.json()).id;
      const reference = await f.send('vault.secret-create', {
        workspaceId,
        secretKind: 'mcp-credential',
        material: 'synthetic-private-canary',
      });
      expect(reference.status).toBe(200);
      const referenceId = (await reference.json()).referenceId;
      const terms = {
        referenceId,
        ownerScope: 'workspace',
        lifetime: 'workspace',
        injectionPath: 'gateway-only',
        targetCapabilityId: 'mcp.call_tool',
      };
      const raised = await f.send('vault.grant-request', {
        workspaceId,
        threadId,
        requestId: randomUUID(),
        terms,
      });
      expect(raised.status).toBe(200);
      const body = await raised.json();
      expect(body).toMatchObject({ workspaceId, threadId, state: 'pending', terms, grantId: null });
      expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
      const same = await f.send('vault.grant-request', {
        workspaceId,
        threadId,
        requestId: randomUUID(),
        terms,
      });
      expect((await same.json()).approvalRequestId).toBe(body.approvalRequestId);
      expect(f.store.listThreadTurns(workspaceId, threadId)).toHaveLength(1);
      const changed = await f.send('vault.grant-request', {
        workspaceId,
        threadId,
        requestId: body.approvalRequestId,
        terms: { ...terms, targetCapabilityId: 'mcp.list_tools' },
      });
      expect(changed.status).toBe(409);
      expect(JSON.stringify(body)).not.toContain('synthetic-private-canary');
    } finally {
      f.cleanup();
    }
  });
});

/** Creates existing native records before exercising the new command boundary. */
async function prepare(
  f: ReturnType<typeof fixture>,
  ownerScope: 'workspace' | 'server' = 'workspace'
) {
  const workspace = await f.send('workspace.create', {
    name: 'Grant authority',
    requestId: randomUUID(),
  });
  expect(workspace.status).toBe(201);
  const workspaceId = (await workspace.json()).id;
  const thread = await f.send('thread.create', {
    workspaceId,
    name: 'Exact grant review',
    requestId: randomUUID(),
  });
  expect(thread.status).toBe(200);
  const threadId = (await thread.json()).id;
  const referenceId = `vault_${randomUUID()}`;
  f.vaultUnlockState.backend().store({
    referenceId,
    material: 'synthetic-resolution-canary',
    metadata: ownerScope === 'server' ? { ownerScope } : { ownerScope, workspaceId },
  });
  createVaultReference(f.coreDb, {
    referenceId,
    ownerScope,
    ...(ownerScope === 'workspace' ? { workspaceId } : {}),
    secretKind: 'mcp-credential',
    displayName: 'Synthetic shared credential',
    backendKind: 'encrypted-file',
    backendLocator:
      ownerScope === 'server'
        ? `encrypted-file://server/vault/${referenceId}`
        : `encrypted-file://workspace/${workspaceId}/vault/${referenceId}`,
  });
  const terms = {
    referenceId,
    ownerScope,
    lifetime: ownerScope,
    injectionPath: 'gateway-only' as const,
    targetCapabilityId: 'mcp.call_tool' as const,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  return { workspaceId, threadId, terms };
}

/** Resolve the existing approval owner after the raising Turn has completed. */
function decision(
  request: {
    workspaceId: string;
    threadId: string;
    raisingTurnId: string;
    approvalRequestId: string;
  },
  value: 'granted' | 'denied'
) {
  return {
    workspaceId: request.workspaceId,
    threadId: request.threadId,
    turnId: request.raisingTurnId,
    approvalRequestId: request.approvalRequestId,
    decision: value,
    requestId: randomUUID(),
  };
}

it.each([
  'workspace',
  'server',
] as const)('issues one reviewed %s grant with exact lineage and preserves the original after narrowing', async (scope) => {
  const f = fixture();
  try {
    const source = await prepare(f, scope);
    const raised = await f.send('vault.grant-request', { ...source, requestId: randomUUID() });
    expect(raised.status).toBe(200);
    const request = await raised.json();
    expect(f.store.getTurnById(request.raisingTurnId).status).toBe('completed');
    expect(JSON.parse(request.effect.detail)).toMatchObject({
      operation: 'vault.grant-issue',
      terms: source.terms,
    });
    const unapproved = await f.send('vault.grant-issue', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      approvalRequestId: request.approvalRequestId,
    });
    expect(unapproved.status).toBe(409);
    const approved = await f.send('approval.respond', decision(request, 'granted'));
    expect(approved.status).toBe(200);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
    const input = {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      approvalRequestId: request.approvalRequestId,
    };
    const issued = await f.send('vault.grant-issue', input);
    expect(issued.status).toBe(200);
    const result = await issued.json();
    expect(result).toMatchObject({
      state: 'resolved',
      resolution: 'granted',
      claim: 'finished',
      disposition: 'approved-executed',
      terms: source.terms,
      decidingActorId: 'user_local',
    });
    const actual = getVaultGrant(f.coreDb, result.grantId)!;
    expect(actual).toMatchObject({
      vaultReferenceId: source.terms.referenceId,
      ownerScope: scope,
      lifetime: scope,
      allowedInjectionPaths: ['gateway-only'],
      targetCapabilityId: 'mcp.call_tool',
      expiresAt: source.terms.expiresAt,
      approvalId: request.approvalRequestId,
      status: 'active',
    });
    expect(actual.policyDecisionId).toBeTruthy();
    const db = openWorkspaceDb(f.dataRoot, source.workspaceId);
    try {
      expect(
        db.sqlite
          .prepare('SELECT result, approval_id FROM permission_decisions WHERE decision_id = ?')
          .get(actual.policyDecisionId)
      ).toEqual({ result: 'allow', approval_id: request.approvalRequestId });
    } finally {
      db.sqlite.close();
    }
    const again = await f.send('vault.grant-issue', input);
    expect(again.status).toBe(200);
    expect((await again.json()).grantId).toBe(result.grantId);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(1);
    const audit = f.coreDb.sqlite
      .prepare(
        "SELECT actor_json, vault_grant_id, resource FROM audit_events WHERE action = 'vault.grant-issue'"
      )
      .all();
    expect(audit).toEqual([
      {
        actor_json: JSON.stringify({ kind: 'user', id: 'user_local' }),
        vault_grant_id: result.grantId,
        resource: `approval:${request.approvalRequestId}`,
      },
    ]);
    const narrower = await f.send(
      scope === 'workspace' ? 'vault.grant-narrow' : 'vault.server-mcp-grant-narrow',
      {
        ...(scope === 'workspace'
          ? { workspaceId: source.workspaceId }
          : { requestId: randomUUID() }),
        grantId: result.grantId,
        constraints: { targetAgentId: randomUUID() },
      }
    );
    expect(narrower.status).toBe(200);
    const replacement = await narrower.json();
    expect(replacement.grant.grantId).not.toBe(result.grantId);
    expect(getVaultGrant(f.coreDb, result.grantId)?.status).toBe('revoked');
    const observed = await f.send('vault.grant-request-list', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
    });
    expect(observed.status).toBe(200);
    expect((await observed.json()).items[0].grantId).toBe(result.grantId);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_injection_plans').all()).toHaveLength(0);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_injection_receipts').all()).toHaveLength(0);
    expect(JSON.stringify([result, actual, audit])).not.toContain('synthetic-resolution-canary');
  } finally {
    f.cleanup();
  }
});

it.each([
  'denied',
  'withdrawn',
] as const)('keeps a %s request non-authorizing after late review', async (ending) => {
  const f = fixture();
  try {
    const source = await prepare(f);
    const raised = await f.send('vault.grant-request', { ...source, requestId: randomUUID() });
    expect(raised.status).toBe(200);
    const request = await raised.json();
    const resolved =
      ending === 'denied'
        ? await f.send('approval.respond', decision(request, 'denied'))
        : await f.send('pending-request.withdraw', {
            workspaceId: source.workspaceId,
            threadId: source.threadId,
            pendingRequestId: request.approvalRequestId,
            requestId: randomUUID(),
          });
    expect(resolved.status).toBe(200);
    const issue = await f.send('vault.grant-issue', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      approvalRequestId: request.approvalRequestId,
    });
    expect(issue.status).toBe(409);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
    const list = await f.send('vault.grant-request-list', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
    });
    const record = (await list.json()).items[0];
    expect(record.grantId).toBeNull();
    expect(record.resolution ?? record.ending).toBe(ending);
    expect(record.delivery).toBe('delivered');
  } finally {
    f.cleanup();
  }
});

it('refuses a revoked deciding credential even when another administrator consumes the request', async () => {
  const f = fixture();
  try {
    const source = await prepare(f);
    const request = await (
      await f.send('vault.grant-request', { ...source, requestId: randomUUID() })
    ).json();
    const decider = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const approved = await f.serverSend(
      'approval.respond',
      decision(request, 'granted'),
      decider.secret
    );
    expect(approved.status).toBe(200);
    const db = openWorkspaceDb(f.dataRoot, source.workspaceId);
    try {
      expect(
        readPendingRequest(db.sqlite, request.approvalRequestId)?.decidingActorContext
      ).toMatchObject({ kind: 'token', tokenId: decider.tokenId, userId: 'user_local' });
    } finally {
      db.sqlite.close();
    }
    revokeOpenKitAccessTokenRecord(f.coreDb, decider.tokenId);
    const other = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const issue = await f.serverSend(
      'vault.grant-issue',
      {
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        approvalRequestId: request.approvalRequestId,
      },
      other.secret
    );
    expect(issue.status).toBe(403);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
    const list = await f.serverSend(
      'vault.grant-request-list',
      { workspaceId: source.workspaceId, threadId: source.threadId },
      other.secret
    );
    expect((await list.json()).items[0]).toMatchObject({
      resolution: 'granted',
      disposition: 'denied-not-executed',
      grantId: null,
    });
  } finally {
    f.cleanup();
  }
});

it('refuses a revoked initiating credential without substituting current membership', async () => {
  const f = fixture();
  try {
    const source = await prepare(f);
    const requester = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: [source.workspaceId],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const response = await f.serverSend(
      'vault.grant-request',
      { ...source, requestId: randomUUID() },
      requester.secret
    );
    expect(response.status).toBe(200);
    const request = await response.json();
    const admin = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(
      (await f.serverSend('approval.respond', decision(request, 'granted'), admin.secret)).status
    ).toBe(200);
    revokeOpenKitAccessTokenRecord(f.coreDb, requester.tokenId);
    const issue = await f.serverSend(
      'vault.grant-issue',
      {
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        approvalRequestId: request.approvalRequestId,
      },
      admin.secret
    );
    expect(issue.status).toBe(403);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});

it('retains an interrupted claim as unknown after restart and never issues again', async () => {
  const f = fixture();
  try {
    const source = await prepare(f);
    const request = await (
      await f.send('vault.grant-request', { ...source, requestId: randomUUID() })
    ).json();
    expect((await f.send('approval.respond', decision(request, 'granted'))).status).toBe(200);
    const db = openWorkspaceDb(f.dataRoot, source.workspaceId);
    try {
      expect(
        claimCommandIntentGrant(db.sqlite, request.approvalRequestId, new Date().toISOString())
      ).not.toBeNull();
    } finally {
      db.sqlite.close();
    }
    recoverPendingRequestsAtBoot(f.store, {
      coreDb: f.coreDb,
      openWorkspace: (workspaceId) => openWorkspaceDb(f.dataRoot, workspaceId),
    });
    const issue = await f.send('vault.grant-issue', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      approvalRequestId: request.approvalRequestId,
    });
    expect(issue.status).toBe(409);
    const observed = await f.send('vault.grant-request-list', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
    });
    expect((await observed.json()).items[0]).toMatchObject({
      claim: 'finished',
      disposition: 'outcome-unknown',
      grantId: null,
    });
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});

it('rejects unsupported lifetime, visibility, raw fields and a changed scope before recording a request', async () => {
  const f = fixture();
  try {
    const source = await prepare(f);
    for (const terms of [
      { ...source.terms, lifetime: 'capability-call' },
      { ...source.terms, ownerScope: 'server', lifetime: 'server' },
      { ...source.terms, injectionPath: 'runtime-file' },
      { ...source.terms, injectionPath: 'runtime-env' },
      { ...source.terms, material: 'synthetic-private-canary' },
      { ...source.terms, targetAgentId: 'ghp_private_canary' },
    ]) {
      const response = await f.send('vault.grant-request', {
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        requestId: randomUUID(),
        terms,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(await response.json())).not.toContain('synthetic-private-canary');
    }
    const db = openWorkspaceDb(f.dataRoot, source.workspaceId);
    try {
      expect(db.sqlite.prepare('SELECT * FROM pending_requests').all()).toHaveLength(0);
    } finally {
      db.sqlite.close();
    }
    expect(f.store.listThreadTurns(source.workspaceId, source.threadId)).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});

it('records a committed grant with uncertain request settlement without retrying or fabricating injection completion', async () => {
  const f = fixture();
  try {
    const source = await prepare(f);
    const request = await (
      await f.send('vault.grant-request', { ...source, requestId: randomUUID() })
    ).json();
    expect((await f.send('approval.respond', decision(request, 'granted'))).status).toBe(200);
    const settle = vi
      .spyOn(pendingRequests, 'finishPendingExecution')
      .mockImplementationOnce(() => {
        throw new Error('Synthetic interruption after the Core grant commit.');
      });
    const command = {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      approvalRequestId: request.approvalRequestId,
    };
    expect((await f.send('vault.grant-issue', command)).status).toBe(409);
    settle.mockRestore();
    const observed = await f.send('vault.grant-request-list', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
    });
    const record = (await observed.json()).items[0];
    expect(record).toMatchObject({ claim: 'finished', disposition: 'outcome-unknown' });
    expect(getVaultGrant(f.coreDb, record.grantId)?.status).toBe('active');
    expect((await f.send('vault.grant-issue', command)).status).toBe(409);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(1);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_injection_receipts').all()).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
    f.cleanup();
  }
});

it('permits deny and withdraw when exact disclosure is unavailable and prevents approval', async () => {
  const f = fixture();
  try {
    const source = await prepare(f);
    // This is non-secret credential-scope metadata, not model-authored request input.
    const requester = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: [source.workspaceId, ...Array.from({ length: 16_000 }, () => randomUUID())],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const admin = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const raised = await f.serverSend(
      'vault.grant-request',
      { ...source, requestId: randomUUID() },
      requester.secret
    );
    expect(raised.status).toBe(200);
    const request = await raised.json();
    expect(request.effect.status).toBe('unavailable');
    const approve = await f.serverSend(
      'approval.respond',
      decision(request, 'granted'),
      admin.secret
    );
    expect(approve.status).toBe(409);
    expect((await approve.json()).code).toBe('approval_preview_unavailable');
    expect(
      (await f.serverSend('approval.respond', decision(request, 'denied'), admin.secret)).status
    ).toBe(200);
    const another = await (
      await f.serverSend(
        'vault.grant-request',
        { ...source, requestId: randomUUID() },
        requester.secret
      )
    ).json();
    expect(
      (
        await f.serverSend(
          'pending-request.withdraw',
          {
            workspaceId: source.workspaceId,
            threadId: source.threadId,
            pendingRequestId: another.approvalRequestId,
            requestId: randomUUID(),
          },
          admin.secret
        )
      ).status
    ).toBe(200);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});

it.each([
  'workspace',
  'server',
] as const)('binds a Worker %s request to its exact package and current canonical MCP slot', async (ownerScope) => {
  const f = fixture();
  let workspaceDb: ReturnType<typeof openWorkspaceDb> | undefined;
  try {
    const source = await prepare(f, ownerScope);
    const existingGrantId = `grant_${randomUUID()}`;
    createVaultGrant(f.coreDb, {
      grantId: existingGrantId,
      vaultReferenceId: source.terms.referenceId,
      ownerScope,
      ...(ownerScope === 'workspace' ? { workspaceId: source.workspaceId } : {}),
      lifetime: ownerScope,
      allowedInjectionPaths: ['gateway-only'],
    });
    const owner =
      ownerScope === 'server'
        ? { kind: 'server' as const }
        : { kind: 'workspace' as const, workspaceId: source.workspaceId };
    const server = createMcpConfig({
      dataRoot: f.dataRoot,
      owner,
      expectedRevision: 0,
      id: 'review-echo',
      displayName: 'Synthetic MCP',
      declaration: { kind: 'http', endpoint: 'https://example.invalid/mcp', headers: {} },
      allowedTools: ['echo'],
      selectCurrent: true,
      createdAt: new Date().toISOString(),
    });
    updateMcpBinding({
      dataRoot: f.dataRoot,
      owner,
      entryId: 'review-echo',
      expectedRevision: server.catalog.revision,
      binding: {
        ...server.catalog.mcp.bindings[0]!,
        enabled: true,
        credentialBindings: [
          {
            slot: 'token',
            vaultGrantId: existingGrantId,
            sink: { kind: 'header', name: 'Authorization' },
          },
        ],
      },
    });
    const current = resolveWorkspaceMcpServer({
      catalog: composeWorkspaceMcpCatalog({
        dataRoot: f.dataRoot,
        workspaceId: source.workspaceId,
      }),
      serverId: 'review-echo',
    });
    const turn = f.store.createTurn(
      source.workspaceId,
      source.threadId,
      'Request selected credential authority',
      { kind: 'user', id: 'user_local' }
    );
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    f.store.createAgentSession({
      id: sessionId,
      agentId: 'agent_codex_host',
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      status: 'busy',
      message: null,
      createdAt: now,
      updatedAt: now,
    });
    f.store.updateTurn(turn.id, {
      status: 'running',
      agentId: 'agent_codex_host',
      agentSessionId: sessionId,
    });
    const pkg = resolveAgentEnvironmentPackage({
      coreDb: f.coreDb,
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId: sessionId,
      agentSetup: createTestAgentSetup(),
      triggerActor: turn.triggerActor,
      turn: f.store.getTurnById(turn.id),
      workspaceCwd: '/workspace',
      workspaceRoots: [],
      backend: { kind: 'openshell' },
    });
    pkg.supply.mcpServers.push({
      id: current.id,
      catalogDigest: current.catalogDigest,
      allowedTools: ['echo'],
      deniedTools: [],
      approvalRequiredTools: [],
      schemaPolicy: 'tracking',
      pinnedSchemaSnapshotId: null,
    });
    workspaceDb = openWorkspaceDb(f.dataRoot, source.workspaceId);
    recordAgentEnvironmentPackageSnapshot(workspaceDb, { environmentPackage: pkg, createdAt: now });
    const entry = createSchedulerAdmissionEntry(f.coreDb, {
      backendId: 'nanohost',
      queueEntryId: randomUUID(),
      requestId: randomUUID(),
      triggerActor: pkg.scope.triggerActor,
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      turnId: turn.id,
      turnInput: 'Synthetic metadata request',
      requestedAgentId: pkg.agent.agentId,
    });
    const originalAttempt = recordTestExecutionAttempt(f.coreDb, {
      entry,
      attemptId: randomUUID(),
      agentSessionId: sessionId,
      inputRef: pkg.snapshotId,
      bindingRef: 'synthetic-binding',
      sessionCompatibilityKey: 'synthetic-request',
      now: () => now,
    });
    const context = {
      coreDb: f.coreDb,
      store: f.store,
      workspaceDb,
      dataRoot: f.dataRoot,
      vaultUnlockState: f.vaultUnlockState,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      packageSnapshotId: pkg.snapshotId,
      protocolRequestId: randomUUID(),
      inflightCommands: new WeakMap(),
      workspaceId: source.workspaceId,
      actor: pkg.scope.triggerActor,
      scope: pkg.scope,
    };
    expect(createOpenkitGenerativeMcpSupply().allowedTools).toContain('vault_grant_request');
    const terms = { ...source.terms, mcpSource: { serverId: 'review-echo', slot: 'token' } };
    const response = await dispatchOpenkitGenerativeTool(context, 'vault_grant_request', { terms });
    expect(response.structuredContent).toMatchObject({
      requesterKind: 'worker',
      agentId: 'agent_codex_host',
      agentSessionId: sessionId,
      raisingTurnId: turn.id,
      terms,
      grantId: null,
    });
    expect(f.store.getTurnById(turn.id).status).toBe('running');
    const list = await dispatchOpenkitGenerativeTool(context, 'vault_grant_request_list', {});
    expect((list.structuredContent as { items: unknown[] }).items).toHaveLength(1);
    for (const changed of [
      { ...terms, referenceId: `vault_${randomUUID()}` },
      { ...terms, mcpSource: { serverId: 'review-echo', slot: 'unselected' } },
      {
        ...terms,
        ownerScope: ownerScope === 'server' ? 'workspace' : 'server',
        lifetime: ownerScope === 'server' ? 'workspace' : 'server',
      },
    ]) {
      await expect(
        dispatchOpenkitGenerativeTool(
          { ...context, protocolRequestId: randomUUID() },
          'vault_grant_request',
          { terms: changed }
        )
      ).rejects.toMatchObject({ code: 'workspace_access_denied' });
    }
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(1);
    const request = response.structuredContent as {
      workspaceId: string;
      threadId: string;
      raisingTurnId: string;
      approvalRequestId: string;
    };
    expect((await f.send('approval.respond', decision(request, 'granted'))).status).toBe(200);
    const issue = await f.send('vault.grant-issue', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      approvalRequestId: request.approvalRequestId,
    });
    expect(issue.status).toBe(200);
    const issued = await issue.json();
    expect(getVaultGrant(f.coreDb, issued.grantId)).toMatchObject({
      ownerScope,
      approvalId: request.approvalRequestId,
      lifetime: ownerScope,
      allowedInjectionPaths: ['gateway-only'],
    });
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(2);
    expect(f.store.getTurnById(turn.id).status).toBe('running');
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_injection_plans').all()).toHaveLength(0);
    expect(JSON.stringify(response)).not.toContain('synthetic-resolution-canary');
    // Reopen product state without live admission hooks; this fixture submitted no backend operation.
    closeSchedulerExecutionAttemptWithoutEffects(f.coreDb, {
      attemptId: originalAttempt.attemptId,
      noOutstandingEffects: true,
      cause: 'synthetic-preparation-ended',
    });
    const laterStore = new FsStore({ dataRoot: f.dataRoot });
    laterStore.updateTurn(turn.id, { status: 'completed', completedAt: now });
    laterStore.updateAgentSession(sessionId, { status: 'closed', updatedAt: now });
    const laterTurn = laterStore.createTurn(
      source.workspaceId,
      source.threadId,
      'Inspect the recorded grant outcome',
      { kind: 'user', id: 'user_local' }
    );
    const laterSessionId = randomUUID();
    laterStore.createAgentSession({
      id: laterSessionId,
      agentId: pkg.agent.agentId,
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      status: 'busy',
      message: null,
      createdAt: now,
      updatedAt: now,
    });
    laterStore.updateTurn(laterTurn.id, {
      status: 'running',
      agentId: pkg.agent.agentId,
      agentSessionId: laterSessionId,
    });
    const laterPackage = resolveAgentEnvironmentPackage({
      coreDb: f.coreDb,
      agentSessionId: laterSessionId,
      agentSetup: createTestAgentSetup(),
      triggerActor: laterTurn.triggerActor,
      turn: laterStore.getTurnById(laterTurn.id),
      workspaceCwd: '/workspace',
      workspaceRoots: [],
      backend: { kind: 'openshell' },
    });
    recordAgentEnvironmentPackageSnapshot(workspaceDb, {
      environmentPackage: laterPackage,
      createdAt: now,
    });
    const laterEntry = createSchedulerAdmissionEntry(f.coreDb, {
      backendId: 'nanohost',
      queueEntryId: randomUUID(),
      requestId: randomUUID(),
      triggerActor: laterPackage.scope.triggerActor,
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      turnId: laterTurn.id,
      turnInput: 'Synthetic outcome read',
      requestedAgentId: laterPackage.agent.agentId,
    });
    recordTestExecutionAttempt(f.coreDb, {
      entry: laterEntry,
      attemptId: randomUUID(),
      agentSessionId: laterSessionId,
      inputRef: laterPackage.snapshotId,
      bindingRef: 'synthetic-later-binding',
      sessionCompatibilityKey: 'synthetic-later-request',
      now: () => now,
    });
    const readback = await dispatchOpenkitGenerativeTool(
      {
        ...context,
        store: laterStore,
        scope: laterPackage.scope,
        actor: laterPackage.scope.triggerActor,
        packageSnapshotId: laterPackage.snapshotId,
        protocolRequestId: randomUUID(),
      },
      'vault_grant_request_list',
      {}
    );
    expect(readback.structuredContent).toMatchObject({
      items: [
        {
          approvalRequestId: request.approvalRequestId,
          grantId: issued.grantId,
          agentSessionId: sessionId,
          raisingTurnId: turn.id,
        },
      ],
    });
    expect(laterStore.getAgentSession(sessionId).status).toBe('closed');
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(2);
  } finally {
    workspaceDb?.sqlite.close();
    f.cleanup();
  }
});

it('reads only retained Server shared-MCP delivery lineage, separately from request/grant metadata', async () => {
  const f = fixture();
  try {
    const shared = await prepare(f, 'server');
    const workspace = await prepare(f, 'workspace');
    const seeded: { scope: string; planId: string; receiptId: string; grantId: string }[] = [];
    for (const source of [shared, workspace]) {
      const scope = source.terms.ownerScope;
      const grantId = `grant_${randomUUID()}`;
      const planId = `plan_${randomUUID()}`;
      const receiptId = `receipt_${randomUUID()}`;
      createVaultGrant(f.coreDb, {
        grantId,
        vaultReferenceId: source.terms.referenceId,
        ownerScope: scope,
        ...(scope === 'workspace' ? { workspaceId: source.workspaceId } : {}),
        lifetime: scope,
        allowedInjectionPaths: ['gateway-only'],
      });
      createVaultInjectionPlan(f.coreDb, {
        grantId,
        planId,
        injectionVisibility: 'gateway-only',
        capabilityId: 'mcp.call_tool',
        expirationBehavior: 'grant-lifetime',
        revocationBehavior: 'close-gateway-session',
        redactionRule: 'exact-resolved-material',
        backendCapabilityRequirement: 'mcp-gateway:http',
      });
      // Seed retained completion only to test the read projection; actual sink proof stays with the Gateway tests.
      createVaultInjectionReceipt(f.coreDb, {
        grantId,
        planId,
        receiptId,
        capabilityCallId: `cap_${randomUUID()}`,
        backendSummary: 'Synthetic retained Gateway completion',
        injectedAt: new Date().toISOString(),
        revocationStatus: 'active',
      });
      seeded.push({ scope, planId, receiptId, grantId });
    }
    const plans = await f.send('vault.server-mcp-injection-plan-list', {});
    const receipts = await f.send('vault.server-mcp-injection-receipt-list', {});
    expect(plans.status).toBe(200);
    expect(receipts.status).toBe(200);
    expect((await plans.json()).items).toMatchObject([
      { planId: seeded[0]!.planId, grantId: seeded[0]!.grantId },
    ]);
    expect((await receipts.json()).items).toMatchObject([
      {
        receiptId: seeded[0]!.receiptId,
        planId: seeded[0]!.planId,
        grantId: seeded[0]!.grantId,
        revocationStatus: 'active',
      },
    ]);
    const member = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: [shared.workspaceId],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    for (const operation of [
      'vault.server-mcp-injection-plan-list',
      'vault.server-mcp-injection-receipt-list',
    ])
      expect((await f.serverSend(operation, {}, member.secret)).status).toBe(403);
    const revoke = await f.send('vault.server-mcp-grant-revoke', {
      grantId: seeded[0]!.grantId,
      requestId: randomUUID(),
    });
    expect(revoke.status).toBe(200);
    const after = await f.send('vault.server-mcp-injection-receipt-list', {});
    expect((await after.json()).items[0]).toMatchObject({
      receiptId: seeded[0]!.receiptId,
      revocationStatus: 'revoked',
    });
  } finally {
    f.cleanup();
  }
});

it('preserves a partial request as inspect-only and releases its Core-local raising Turn', async () => {
  const f = fixture();
  try {
    const source = await prepare(f);
    const item = vi.spyOn(f.store, 'createItem').mockImplementationOnce(() => {
      throw new Error('Synthetic Item publication interruption.');
    });
    const response = await f.send('vault.grant-request', { ...source, requestId: randomUUID() });
    expect(response.status).toBe(409);
    item.mockRestore();
    const turns = f.store.listThreadTurns(source.workspaceId, source.threadId);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe('failed');
    const observed = await f.send('vault.grant-request-list', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
    });
    expect(observed.status).toBe(409);
    expect((await observed.json()).code).toBe('recovery_required');
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
    f.cleanup();
  }
});

it('does not substitute a session replacement Token for the credential that decided', async () => {
  const f = fixture();
  try {
    const source = await prepare(f);
    const request = await (
      await f.send('vault.grant-request', { ...source, requestId: randomUUID() })
    ).json();
    const first = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(setDefaultServerAdminTokenId(f.coreDb, 'user_local', first.tokenId)).toBe(true);
    expect((await f.sessionSend('approval.respond', decision(request, 'granted'))).status).toBe(
      200
    );
    const db = openWorkspaceDb(f.dataRoot, source.workspaceId);
    try {
      expect(
        readPendingRequest(db.sqlite, request.approvalRequestId)?.decidingActorContext
      ).toMatchObject({ kind: 'session', adminTokenId: first.tokenId });
    } finally {
      db.sqlite.close();
    }
    revokeOpenKitAccessTokenRecord(f.coreDb, first.tokenId);
    const replacement = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(setDefaultServerAdminTokenId(f.coreDb, 'user_local', replacement.tokenId)).toBe(true);
    const issue = await f.sessionSend('vault.grant-issue', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      approvalRequestId: request.approvalRequestId,
    });
    expect(issue.status).toBe(403);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});

it('records the actual administrator decision without changing the responsible requester', async () => {
  const f = fixture();
  try {
    const source = await prepare(f);
    const request = await (
      await f.send('vault.grant-request', { ...source, requestId: randomUUID() })
    ).json();
    const reviewerId = `user_${randomUUID()}`;
    f.coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, display_name, email, email_verified, kind, created_at, updated_at, status) VALUES (?, 'Synthetic reviewer', ?, 0, 'human', ?, ?, 'active')"
      )
      .run(reviewerId, randomUUID(), Date.now(), Date.now());
    const reviewer = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: reviewerId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(
      (await f.serverSend('approval.respond', decision(request, 'granted'), reviewer.secret)).status
    ).toBe(200);
    const issued = await f.serverSend(
      'vault.grant-issue',
      {
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        approvalRequestId: request.approvalRequestId,
      },
      reviewer.secret
    );
    expect(issued.status).toBe(200);
    expect(await issued.json()).toMatchObject({
      responsibleUserId: 'user_local',
      decidingActorId: reviewerId,
      disposition: 'approved-executed',
    });
    const audit = f.coreDb.sqlite
      .prepare("SELECT actor_json, request_id FROM audit_events WHERE action = 'vault.grant-issue'")
      .get();
    expect(audit).toEqual({
      actor_json: JSON.stringify({ kind: 'user', id: reviewerId }),
      request_id: request.approvalRequestId,
    });
  } finally {
    f.cleanup();
  }
});

it.each([
  'workspace',
  'server',
] as const)('delivers an actually reviewed %s grant through the real Gateway sink and retains truthful completion lineage', async (ownerScope) => {
  const f = fixture();
  const upstream = await createMcpHttpStub();
  const gateway = createDefaultWorkerMcpGateway(f.coreDb);
  const client = new Client({ name: 'reviewed-grant-sink-fixture', version: '1.0.0' });
  let workspaceDb: ReturnType<typeof openWorkspaceDb> | undefined;
  try {
    const source = await prepare(f, ownerScope);
    const { targetCapabilityId: _capability, ...terms } = source.terms;
    const raised = await f.send('vault.grant-request', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      requestId: randomUUID(),
      terms,
    });
    expect(raised.status).toBe(200);
    const request = await raised.json();
    expect((await f.send('approval.respond', decision(request, 'granted'))).status).toBe(200);
    const issue = await f.send('vault.grant-issue', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      approvalRequestId: request.approvalRequestId,
    });
    expect(issue.status).toBe(200);
    const issued = await issue.json();
    const owner =
      ownerScope === 'server'
        ? { kind: 'server' as const }
        : { kind: 'workspace' as const, workspaceId: source.workspaceId };
    const configured = createMcpConfig({
      dataRoot: f.dataRoot,
      owner,
      expectedRevision: 0,
      id: 'reviewed-sink',
      displayName: 'Synthetic reviewed sink',
      declaration: { kind: 'http', endpoint: upstream.url, headers: {} },
      allowedTools: ['echo'],
      selectCurrent: true,
      createdAt: new Date().toISOString(),
    });
    updateMcpBinding({
      dataRoot: f.dataRoot,
      owner,
      expectedRevision: configured.catalog.revision,
      entryId: 'reviewed-sink',
      binding: {
        ...configured.catalog.mcp.bindings[0]!,
        enabled: true,
        credentialBindings: [
          {
            slot: 'token',
            vaultGrantId: issued.grantId,
            sink: { kind: 'header', name: 'Authorization' },
          },
        ],
      },
    });
    const catalog = composeWorkspaceMcpCatalog({
      dataRoot: f.dataRoot,
      workspaceId: source.workspaceId,
    });
    const setup = createTestAgentSetup({ mcpIds: ['reviewed-sink'] });
    const turn = f.store.createTurn(
      source.workspaceId,
      source.threadId,
      'Use the reviewed credential through the Gateway',
      { kind: 'user', id: 'user_local' }
    );
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    f.store.createAgentSession({
      id: sessionId,
      agentId: setup.manifest.id,
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      status: 'busy',
      message: null,
      createdAt: now,
      updatedAt: now,
    });
    f.store.updateTurn(turn.id, {
      status: 'running',
      agentId: setup.manifest.id,
      agentSessionId: sessionId,
    });
    const pkg = resolveAgentEnvironmentPackage({
      coreDb: f.coreDb,
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId: sessionId,
      agentSetup: setup,
      triggerActor: turn.triggerActor,
      turn: f.store.getTurnById(turn.id),
      workspaceCwd: '/workspace',
      workspaceRoots: [],
      workspaceMcpServerCatalog: catalog,
      backend: { kind: 'openshell' },
    });
    workspaceDb = openWorkspaceDb(f.dataRoot, source.workspaceId);
    recordAgentEnvironmentPackageSnapshot(workspaceDb, { environmentPackage: pkg, createdAt: now });
    const entry = createSchedulerAdmissionEntry(f.coreDb, {
      backendId: 'nanohost',
      queueEntryId: randomUUID(),
      requestId: randomUUID(),
      triggerActor: pkg.scope.triggerActor,
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      turnId: turn.id,
      turnInput: 'Synthetic reviewed sink proof',
      requestedAgentId: pkg.agent.agentId,
    });
    const attempt = recordTestExecutionAttempt(f.coreDb, {
      entry,
      attemptId: randomUUID(),
      agentSessionId: sessionId,
      inputRef: pkg.snapshotId,
      bindingRef: 'synthetic-reviewed-binding',
      sessionCompatibilityKey: 'synthetic-reviewed-sink',
      now: () => now,
      operationId: `fixture-submit:${randomUUID()}`,
    });
    expect(
      acceptSchedulerExecutionObservation(f.coreDb, {
        ...schedulerExecutionCorrelation(attempt),
        disposition: 'accepted',
        execution: 'running',
        fenceRef: null,
        outcomeRef: null,
      })?.disposition
    ).toBe('accepted');
    const app = new Hono();
    registerWorkerMcpRoutes({
      app,
      coreDb: f.coreDb,
      store: f.store,
      vaultUnlockState: f.vaultUnlockState,
      workerMcpGateway: gateway,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      workerControlGateway: {
        authenticatePackageToken: () => pkg,
      } as unknown as WorkerControlGateway,
      runtimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          dataRoot: f.dataRoot,
          agentManifests: [setup.manifest],
          workspaceMcpServerCatalogs: [
            {
              workspaceId: source.workspaceId,
              path: join(f.dataRoot, 'catalog/catalog.json'),
              catalog,
            },
          ],
        }),
    });
    const transport = new StreamableHTTPClientTransport(
      new URL('http://nanocore.test/api/worker-capabilities/mcp/reviewed-sink'),
      {
        fetch: (url, init) => app.fetch(new Request(url, init)),
        requestInit: { headers: { authorization: 'Bearer synthetic-capability-fixture' } },
      }
    );
    await client.connect(transport);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_injection_receipts').all()).toHaveLength(0);
    const result = await client.callTool({
      name: 'echo',
      arguments: { message: 'Safe reviewed result' },
    });
    expect(result).toMatchObject({ content: [{ text: 'Safe reviewed result' }] });
    expect(
      upstream.observedHeaders.some(
        (headers) => headers.get('authorization') === 'synthetic-resolution-canary'
      )
    ).toBe(true);
    const receipts = f.coreDb.sqlite
      .prepare(
        'SELECT plan_id, grant_id, capability_call_id, revocation_status FROM vault_injection_receipts'
      )
      .all() as {
      plan_id: string;
      grant_id: string;
      capability_call_id: string;
      revocation_status: string;
    }[];
    expect(receipts.length).toBeGreaterThan(0);
    const useDb = ownerScope === 'server' ? f.coreDb : workspaceDb;
    for (const receipt of receipts) {
      expect(receipt.grant_id).toBe(issued.grantId);
      expect(receipt.revocation_status).toBe('active');
      expect(
        useDb.sqlite
          .prepare(
            'SELECT grant_id, outcome FROM vault_use_records WHERE plan_id = ? AND capability_call_id = ?'
          )
          .get(receipt.plan_id, receipt.capability_call_id)
      ).toEqual({ grant_id: issued.grantId, outcome: 'succeeded' });
      expect(
        workspaceDb.sqlite
          .prepare('SELECT status FROM capability_calls WHERE call_id = ?')
          .get(receipt.capability_call_id)
      ).toEqual({ status: 'succeeded' });
    }
    const durable = [
      f.coreDb.sqlite.prepare('SELECT * FROM audit_events').all(),
      f.coreDb.sqlite.prepare('SELECT * FROM vault_injection_plans').all(),
      f.coreDb.sqlite.prepare('SELECT * FROM vault_injection_receipts').all(),
      useDb.sqlite.prepare('SELECT * FROM vault_use_records').all(),
      f.store.listThreadItems(source.workspaceId, source.threadId),
      issued,
      result,
    ];
    expect(JSON.stringify(durable)).not.toContain('synthetic-resolution-canary');
    const revoke = await f.send(
      ownerScope === 'server' ? 'vault.server-mcp-grant-revoke' : 'vault.grant-revoke',
      {
        ...(ownerScope === 'server'
          ? { requestId: randomUUID() }
          : { workspaceId: source.workspaceId }),
        grantId: issued.grantId,
      }
    );
    expect(revoke.status).toBe(200);
    const toolContacts = () =>
      upstream.observed.filter((entry) => entry.endsWith('|tools/call')).length;
    const contacts = toolContacts();
    await expect(
      client.callTool({ name: 'echo', arguments: { message: 'Must not reach the sink' } })
    ).rejects.toThrow();
    expect(toolContacts()).toBe(contacts);
    expect(
      f.coreDb.sqlite
        .prepare('SELECT DISTINCT revocation_status FROM vault_injection_receipts')
        .all()
    ).toEqual([{ revocation_status: 'revoked' }]);
  } finally {
    await client.close();
    await gateway.close();
    await upstream.close();
    workspaceDb?.sqlite.close();
    f.cleanup();
  }
});

it('issues an explicitly Worker-visible GitHub grant with exact Agent and AgentSession bounds', async () => {
  const f = fixture();
  try {
    const source = await prepare(f);
    const secret = await f.send('vault.secret-create', {
      workspaceId: source.workspaceId,
      secretKind: 'github-token',
      material: 'synthetic-worker-environment-canary',
    });
    expect(secret.status).toBe(200);
    const terms = {
      referenceId: (await secret.json()).referenceId,
      ownerScope: 'workspace',
      lifetime: 'workspace',
      injectionPath: 'runtime-env',
      targetAgentId: 'agent_codex_host',
      targetAgentSessionId: randomUUID(),
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const raised = await f.send('vault.grant-request', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      requestId: randomUUID(),
      terms,
    });
    expect(raised.status).toBe(200);
    const request = await raised.json();
    expect(JSON.parse(request.effect.detail).terms).toEqual(terms);
    expect((await f.send('approval.respond', decision(request, 'granted'))).status).toBe(200);
    const issue = await f.send('vault.grant-issue', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      approvalRequestId: request.approvalRequestId,
    });
    expect(issue.status).toBe(200);
    const result = await issue.json();
    expect(getVaultGrant(f.coreDb, result.grantId)).toMatchObject({
      allowedInjectionPaths: ['runtime-env'],
      targetAgentId: terms.targetAgentId,
      targetAgentSessionId: terms.targetAgentSessionId,
      targetCapabilityId: null,
      expiresAt: terms.expiresAt,
    });
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_injection_receipts').all()).toHaveLength(0);
    expect(
      JSON.stringify([
        request,
        result,
        f.store.listThreadItems(source.workspaceId, source.threadId),
      ])
    ).not.toContain('synthetic-worker-environment-canary');
  } finally {
    f.cleanup();
  }
});

it.each([
  'pending',
  'approved',
] as const)('cannot issue a %s request after Thread archival', async (state) => {
  const f = fixture();
  try {
    const source = await prepare(f);
    const request = await (
      await f.send('vault.grant-request', { ...source, requestId: randomUUID() })
    ).json();
    if (state === 'approved')
      expect((await f.send('approval.respond', decision(request, 'granted'))).status).toBe(200);
    expect(
      (
        await f.send('thread.archive', {
          workspaceId: source.workspaceId,
          threadId: source.threadId,
          requestId: randomUUID(),
        })
      ).status
    ).toBe(200);
    const issue = await f.send('vault.grant-issue', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      approvalRequestId: request.approvalRequestId,
    });
    expect(issue.status).toBeGreaterThanOrEqual(400);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_injection_receipts').all()).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});

it('refuses a now-expired approved request without issuing or resolving material', async () => {
  const f = fixture();
  try {
    const source = await prepare(f);
    const expiry = Date.now() + 60_000;
    const terms = { ...source.terms, expiresAt: new Date(expiry).toISOString() };
    const request = await (
      await f.send('vault.grant-request', { ...source, terms, requestId: randomUUID() })
    ).json();
    expect((await f.send('approval.respond', decision(request, 'granted'))).status).toBe(200);
    vi.spyOn(Date, 'now').mockReturnValue(expiry + 1);
    const issue = await f.send('vault.grant-issue', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      approvalRequestId: request.approvalRequestId,
    });
    expect(issue.status).toBe(409);
    expect((await issue.json()).code).toBe('vault_request_stale');
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_injection_receipts').all()).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
    f.cleanup();
  }
});

it.each([
  'workspace',
  'server',
] as const)('refuses an approved %s request after reference revocation', async (ownerScope) => {
  const f = fixture();
  try {
    const source = await prepare(f, ownerScope);
    const request = await (
      await f.send('vault.grant-request', { ...source, requestId: randomUUID() })
    ).json();
    expect((await f.send('approval.respond', decision(request, 'granted'))).status).toBe(200);
    const revoked = await f.send(
      ownerScope === 'server' ? 'vault.server-mcp-secret-revoke' : 'vault.secret-revoke',
      {
        ...(ownerScope === 'server'
          ? { requestId: randomUUID() }
          : { workspaceId: source.workspaceId }),
        referenceId: source.terms.referenceId,
      }
    );
    expect(revoked.status).toBe(200);
    const issue = await f.send('vault.grant-issue', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      approvalRequestId: request.approvalRequestId,
    });
    expect(issue.status).toBe(409);
    expect((await issue.json()).code).toBe('vault_reference_not_active');
    const observed = await f.send('vault.grant-request-list', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
    });
    expect((await observed.json()).items[0]).toMatchObject({
      disposition: 'denied-not-executed',
      grantId: null,
    });
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_injection_receipts').all()).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});
