import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type OperationId, StartTaskModeResponseSchema } from '@openkit/app-api-schemas';
import { resolveWorkspaceMcpServer } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
  setDefaultServerAdminTokenId,
} from '../auth/access-token-store.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import {
  composeWorkspaceMcpCatalog,
  createMcpConfig,
  updateMcpBinding,
} from '../catalog/resource-catalog.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
  loadRuntimeConfig,
} from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { WORKSPACE_MEMBER_OPERATIONS } from '../policy/workspace-access.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  createOpenkitGenerativeMcpSupply,
  dispatchOpenkitGenerativeTool,
} from '../runtime/openkit-generative-mcp.js';
import * as pendingRequests from '../runtime/pending-request-error.js';
import { recoverPendingRequestsAtBoot } from '../runtime/pending-request-flow.js';
import { claimCommandIntentGrant, readPendingRequest } from '../runtime/pending-requests.js';
import * as productTurnStart from '../runtime/product-turn-start.js';
import {
  getSchedulerPreparationClaims,
  runSchedulerDispatchLoop,
} from '../runtime/scheduler-dispatch-loop.js';
import { createDefaultWorkerMcpGateway } from '../runtime/worker-mcp-gateway.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { createMcpHttpStub } from '../test-support/mcp-http-stub.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { operationRequest } from '../test-support/operation-request.js';
import { managedThreadPolicy } from '../test-support/resource-policy.js';
import { createVaultInjectionPlan } from '../vault-injection-plans.js';
import { createVaultInjectionReceipt } from '../vault-injection-receipts.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { createVaultGrant, getVaultGrant, listVaultGrants } from './vault-grants.js';
import { createVaultUnlockState } from './vault-unlock-state.js';

/** Owns one isolated real App/API fixture and removes every synthetic record at closeout. */
function fixture(sessionUserId = FIXTURE_LOCAL_USER_ID) {
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
  const authenticationSessionId = allocateEntityId('auth');
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
              session: { id: authenticationSessionId },
              user: { id: sessionUserId },
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
    cleanup: async () => {
      await shutdownControlStoreWorkerClient();
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
        targetCapabilityId: 'mcp.call-tool',
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
        terms: { ...terms, targetCapabilityId: 'mcp.list-tools' },
      });
      expect(changed.status).toBe(409);
      expect(JSON.stringify(body)).not.toContain('synthetic-private-canary');
    } finally {
      await f.cleanup();
    }
  });
});

/** Creates existing native records before exercising the new command boundary. */
async function prepare(
  f: ReturnType<typeof fixture>,
  ownerScope: 'workspace' | 'server' = 'workspace',
  visibility: 'private' | 'workspace' = 'private'
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
    visibility,
    requestId: randomUUID(),
  });
  expect(thread.status).toBe(200);
  const threadId = (await thread.json()).id;
  const reference = await f.send(
    ownerScope === 'server' ? 'vault.server-mcp-secret-create' : 'vault.secret-create',
    {
      ...(ownerScope === 'server' ? { requestId: randomUUID() } : {}),
      material: 'synthetic-resolution-canary',
      ...(ownerScope === 'workspace' ? { workspaceId, secretKind: 'mcp-credential' } : {}),
    }
  );
  expect(reference.status).toBe(200);
  const referenceId = (await reference.json()).referenceId as string;
  const terms = {
    referenceId,
    ownerScope,
    lifetime: ownerScope,
    injectionPath: 'gateway-only' as const,
    targetCapabilityId: 'mcp.call-tool' as const,
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
      decidingActorId: FIXTURE_LOCAL_USER_ID,
    });
    const actual = getVaultGrant(f.coreDb, result.grantId)!;
    expect(actual).toMatchObject({
      vaultReferenceId: source.terms.referenceId,
      ownerScope: scope,
      lifetime: scope,
      allowedInjectionPaths: ['gateway-only'],
      targetCapabilityId: 'mcp.call-tool',
      expiresAt: source.terms.expiresAt,
      approvalId: request.approvalRequestId,
      status: 'active',
    });
    expect(actual.policyDecisionId).toBeTruthy();
    const db = openWorkspaceDb(f.dataRoot, source.workspaceId);
    try {
      // Policy Enforcement Mapping, Version-One Retained Projection: migrated producers use the real mediated record.
      const decisions = await readReviewedIssueDecisions(db);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        decisionId: actual.policyDecisionId,
        result: 'allow',
        approvalId: request.approvalRequestId,
        policyEngineVersion: 'nanocore-policy:v1',
        policySnapshotId: await admittedReviewedIssuePolicyDigest(f),
        reasonCode: 'granted',
        enforcementPoint: 'vault.grant-issue@decide',
        mediation: { operation: 'vault.grant-issue', stage: 'decide', role: 'final' },
      });
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
        actor_json: JSON.stringify({ kind: 'user', id: FIXTURE_LOCAL_USER_ID }),
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
    await f.cleanup();
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
    await f.cleanup();
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
      ownerUserId: FIXTURE_LOCAL_USER_ID,
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
      ).toMatchObject({ kind: 'token', tokenId: decider.tokenId, userId: FIXTURE_LOCAL_USER_ID });
    } finally {
      db.sqlite.close();
    }
    revokeOpenKitAccessTokenRecord(f.coreDb, decider.tokenId);
    const other = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: FIXTURE_LOCAL_USER_ID,
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
    await f.cleanup();
  }
});

it('refuses a revoked initiating credential without substituting current membership', async () => {
  const f = fixture();
  try {
    const source = await prepare(f);
    const requester = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: FIXTURE_LOCAL_USER_ID,
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
      ownerUserId: FIXTURE_LOCAL_USER_ID,
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
    await f.cleanup();
  }
});

it('refuses issuance after the human requester loses only request-Thread write rights', async () => {
  const f = fixture();
  try {
    const source = await prepare(f, 'workspace', 'workspace');
    const requester = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: FIXTURE_LOCAL_USER_ID,
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
    expect((await f.send('approval.respond', decision(request, 'granted'))).status).toBe(200);
    f.store.setWorkspaceResourcePolicyProjection(() =>
      managedThreadPolicy({
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        userId: FIXTURE_LOCAL_USER_ID,
        operations: WORKSPACE_MEMBER_OPERATIONS.filter((right) => right !== 'workspace.write'),
      })
    );
    expect(
      isThreadIdVisible(f.store, source.workspaceId, source.threadId, FIXTURE_LOCAL_USER_ID)
    ).toBe(true);
    expect(
      isThreadIdVisible(
        f.store,
        source.workspaceId,
        source.threadId,
        FIXTURE_LOCAL_USER_ID,
        false,
        'workspace.write'
      )
    ).toBe(false);
    const issue = await f.send('vault.grant-issue', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      approvalRequestId: request.approvalRequestId,
    });
    expect(issue.status).toBe(403);
    expect((await issue.json()).code).toBe('workspace_access_denied');
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
  } finally {
    await f.cleanup();
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
    await recoverPendingRequestsAtBoot(f.store, {
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
    await f.cleanup();
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
    await f.cleanup();
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
    const native = getControlStoreWorkerClient();
    const write = native.vault.bind(native);
    let interrupted = false;
    // Interrupt caller settlement after the real native grant stage acknowledgement.
    const settle = vi.spyOn(native, 'vault').mockImplementation((async (
      db,
      kind,
      record,
      beforeSubmit
    ) => {
      const result = await write(db, kind, record, beforeSubmit);
      if (
        db === f.coreDb &&
        kind === 'reviewed-grant-issue' &&
        !interrupted &&
        listVaultGrants(f.coreDb).some((grant) => grant.approvalId === request.approvalRequestId)
      ) {
        interrupted = true;
        throw new Error('Synthetic interruption after the Core grant commit.');
      }
      return result;
    }) as typeof native.vault);
    const command = {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      approvalRequestId: request.approvalRequestId,
    };
    expect((await f.send('vault.grant-issue', command)).status).toBe(409);
    settle.mockRestore();
    expect(interrupted).toBe(true);
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
    await f.cleanup();
  }
});

it('permits deny and withdraw when exact disclosure is unavailable and prevents approval', async () => {
  const f = fixture();
  try {
    const source = await prepare(f);
    // This is non-secret credential-scope metadata, not model-authored request input.
    const requester = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      scope: 'workspace',
      workspaceIds: [
        source.workspaceId,
        ...Array.from({ length: 16_000 }, () => allocateEntityId('ws')),
      ],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const admin = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: FIXTURE_LOCAL_USER_ID,
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
    await f.cleanup();
  }
});

it.each([
  'workspace',
  'server',
  'revoked-agent',
] as const)('binds a Worker %s request to its exact package and current canonical MCP slot', async (selection) => {
  const ownerScope = selection === 'revoked-agent' ? 'workspace' : selection;
  const f = fixture();
  let workspaceDb: ReturnType<typeof openWorkspaceDb> | undefined;
  let native: Awaited<ReturnType<typeof createNativeTaskAdmissionFixture>> | undefined;
  const admittedTurns: string[] = [];
  let successorCloseout: Promise<unknown> | undefined;
  const admissions = vi.spyOn(productTurnStart, 'observeTurnAdmission');
  try {
    const source = await prepare(f, ownerScope, 'workspace');
    const existingGrantId = allocateEntityId('grant');
    await createVaultGrant(f.coreDb, {
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
    const catalog = composeWorkspaceMcpCatalog({
      dataRoot: f.dataRoot,
      workspaceId: source.workspaceId,
    });
    const current = resolveWorkspaceMcpServer({ catalog, serverId: 'review-echo' });
    let snapshot = createInMemoryRuntimeConfigSnapshot({
      dataRoot: f.dataRoot,
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      workspaceConfigs: loadRuntimeConfig(f.dataRoot).workspaceConfigs,
      agentManifests: [
        createTestAgentSetup({
          mcpIds: ['review-echo'],
          requiredCapabilities: ['trusted-worker-inference-relay'],
        }).manifest,
      ],
      workspaceMcpServerCatalogs: [
        {
          catalog,
          path: join(f.dataRoot, 'catalog/catalog.json'),
          workspaceId: source.workspaceId,
        },
      ],
    });
    const runtimeConfigManager = createRuntimeConfigManager({
      dataRoot: null,
      initialSnapshot: snapshot,
    });
    vi.spyOn(runtimeConfigManager, 'current').mockImplementation(() => snapshot);
    native = await createNativeTaskAdmissionFixture(f.coreDb, f.store, {
      readRuntimeConfig: () => snapshot,
    });
    const commands = vi.spyOn(native.runtime, 'acceptNanoHostHarnessCommand');
    const results = vi.spyOn(native.runtime, 'acceptNanoHostHarnessResult');
    const app = createApp({
      coreDb: f.coreDb,
      store: f.store,
      vaultUnlockState: f.vaultUnlockState,
      fileAdmission: native.fileAdmission,
      turnExecutor: native.executor,
      workerControlGateway: native.workerControlGateway,
      runtimeConfigManager,
    });
    const started = await app.request(
      ...operationRequest(
        'task.start',
        { workspaceId: source.workspaceId, threadId: source.threadId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: 'Request selected credential authority',
            requestId: randomUUID(),
          }),
        }
      )
    );
    expect(started.status).toBe(202);
    const { turn } = StartTaskModeResponseSchema.parse(await started.json());
    admittedTurns.push(turn.id);
    const first = native.executionFor(turn.id);
    await first.launched.promise;
    await native.waitForStartup(turn.id);
    const pkg = native.workerControlGateway.authenticatePackageToken(
      `Bearer ${native.executor.capabilityToken}`,
      { tokenFamily: 'capability' }
    );
    const sessionId = pkg.scope.agentSessionId;
    expect(pkg.scope).toMatchObject({
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      turnId: turn.id,
    });
    expect(pkg.supply.mcpServers).toContainEqual(
      expect.objectContaining({ id: current.id, catalogDigest: current.catalogDigest })
    );
    workspaceDb = openWorkspaceDb(f.dataRoot, source.workspaceId);
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
    expect(createOpenkitGenerativeMcpSupply().allowedTools).toContain('vault_grant-request');
    const terms = { ...source.terms, mcpSource: { serverId: 'review-echo', slot: 'token' } };
    const response = await dispatchOpenkitGenerativeTool(context, 'vault_grant-request', { terms });
    expect(response.structuredContent).toMatchObject({
      requesterKind: 'worker',
      agentId: 'agent_codex_host',
      agentSessionId: sessionId,
      raisingTurnId: turn.id,
      terms,
      grantId: null,
    });
    expect(f.store.getTurnById(turn.id).status).toBe('running');
    const list = await dispatchOpenkitGenerativeTool(context, 'vault_grant-request-list', {});
    expect((list.structuredContent as { items: unknown[] }).items).toHaveLength(1);
    for (const changed of [
      { ...terms, referenceId: allocateEntityId('vault') },
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
          'vault_grant-request',
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
    if (selection === 'revoked-agent') {
      const requestingAgent = {
        kind: 'agent' as const,
        userId: FIXTURE_LOCAL_USER_ID,
        agentId: pkg.agent.agentId,
        processId: sessionId,
      };
      const policy = managedThreadPolicy({
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        userId: FIXTURE_LOCAL_USER_ID,
        operations: WORKSPACE_MEMBER_OPERATIONS,
      });
      const permission = policy.statements.find((statement) => statement.kind === 'permission')!;
      policy.statements.push({
        ...permission,
        id: `${permission.id}-agent`,
        scope: { ...permission.scope, actions: ['thread.read'] },
        grant: { kind: 'agent-process', agentId: requestingAgent.agentId },
      });
      f.store.setWorkspaceResourcePolicyProjection(() => policy);
      expect(
        isThreadIdVisible(f.store, source.workspaceId, source.threadId, FIXTURE_LOCAL_USER_ID)
      ).toBe(true);
      expect(
        isThreadIdVisible(
          f.store,
          source.workspaceId,
          source.threadId,
          FIXTURE_LOCAL_USER_ID,
          false,
          'thread.read',
          requestingAgent
        )
      ).toBe(true);
      expect(
        isThreadIdVisible(
          f.store,
          source.workspaceId,
          source.threadId,
          FIXTURE_LOCAL_USER_ID,
          false,
          'workspace.write',
          requestingAgent
        )
      ).toBe(false);
      const refused = await f.send('vault.grant-issue', {
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        approvalRequestId: request.approvalRequestId,
      });
      expect(refused.status).toBe(403);
      expect((await refused.json()).code).toBe('workspace_access_denied');
      expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(1);
      return;
    }
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
    // A native process setting requires genuine replacement without changing the MCP selection.
    const manifest = snapshot.agentManifests[0]!;
    snapshot = createInMemoryRuntimeConfigSnapshot({
      ...snapshot,
      agentManifests: [
        {
          ...manifest,
          runtime: {
            ...manifest.runtime,
            environment: { VAULT_FIXTURE_BINDING: 'successor' },
          },
        },
      ],
    });
    // The next admission must follow the actual first execution and its owning Task closeout.
    first.completion.resolve();
    await first.execution;
    await Promise.all(
      admissions.mock.results
        .filter((result) => result.type === 'return')
        .map((result) => result.value.closeout)
    );
    // The ready approval outcome owns the next Worker Turn at the terminal barrier.
    const outcome = readPendingRequest(workspaceDb.sqlite, request.approvalRequestId);
    expect(outcome?.deliveryTurnId).toEqual(expect.any(String));
    const laterTurn = f.store.getTurnById(outcome!.deliveryTurnId!);
    expect(laterTurn.triggerSource?.kind).toBe('approval-resolution');
    admittedTurns.push(laterTurn.id);
    // Boot's scheduler retries queued outcomes after the preceding native attempt releases.
    const dispatch = runSchedulerDispatchLoop({
      coreDb: f.coreDb,
      store: f.store,
      turnExecutor: native.executor,
      executionBackend: native.executor.executionBackend!,
      agentManifests: snapshot.agentManifests,
      gatewayConfig: snapshot.gatewayConfig,
      providerRegistry: snapshot.providerRegistry,
      workspaceConfigs: snapshot.workspaceConfigs,
      workspaceMcpServerCatalogs: snapshot.workspaceMcpServerCatalogs,
      maxDispatches: 1,
    });
    successorCloseout = dispatch.then((result) => {
      const entry = result.startedTurns.find(
        (started) => started.dispatch.entry.turnId === laterTurn.id
      );
      if (entry)
        return getSchedulerPreparationClaims(f.coreDb).get(entry.dispatch.entry.queueEntryId);
    });
    void successorCloseout.catch(() => undefined);
    await Promise.race([
      native.executionFor(laterTurn.id).launched.promise,
      dispatch.then((result) => {
        if (!result.startedTurns.some((started) => started.dispatch.entry.turnId === laterTurn.id))
          throw new Error(
            `Outcome dispatch did not launch its Turn: ${JSON.stringify(result.terminalResult)}`
          );
        return native!.executionFor(laterTurn.id).launched.promise;
      }),
    ]);
    await native.waitForStartup(laterTurn.id);
    const laterPackage = native.workerControlGateway.authenticatePackageToken(
      `Bearer ${native.executor.capabilityToken}`,
      { tokenFamily: 'capability' }
    );
    expect(laterTurn.id).not.toBe(turn.id);
    expect(laterPackage.scope.agentSessionId).not.toBe(sessionId);
    const closes = commands.mock.calls
      .map(([command]) => command)
      .filter(
        (command) =>
          command.operation === 'session.close' && command.body.agentSessionId === sessionId
      );
    expect(closes).toHaveLength(1);
    expect(results.mock.calls.map(([result]) => result)).toContainEqual(
      expect.objectContaining({
        harnessInstanceId: closes[0]!.harnessInstanceId,
        operationId: closes[0]!.operationId,
        sequence: closes[0]!.sequence,
        disposition: 'succeeded',
        body: expect.objectContaining({ state: 'closed', privateState: 'absent' }),
      })
    );
    expect(native.executor.launches).toBe(2);
    expect(f.store.listThreadAgentSessions(source.workspaceId, source.threadId)).toHaveLength(2);
    expect(laterPackage.scope).toMatchObject({
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      turnId: laterTurn.id,
    });
    const readback = await dispatchOpenkitGenerativeTool(
      {
        ...context,
        store: f.store,
        scope: laterPackage.scope,
        actor: laterPackage.scope.triggerActor,
        packageSnapshotId: laterPackage.snapshotId,
        protocolRequestId: randomUUID(),
      },
      'vault_grant-request-list',
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
    expect(f.store.getAgentSession(sessionId).status).toBe('closed');
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(2);
  } finally {
    try {
      native?.executor.completion.resolve();
      for (const turnId of admittedTurns) native?.executionFor(turnId).completion.resolve();
      const closeouts = [
        ...admittedTurns.map((turnId) => native!.executionFor(turnId).execution),
        successorCloseout,
      ];
      // Settle every owner before propagating an execution or dispatcher rejection.
      await Promise.allSettled(closeouts);
      await Promise.all(closeouts);
      await Promise.all(
        admissions.mock.results
          .filter((result) => result.type === 'return')
          .map((result) => result.value.closeout)
      );
    } finally {
      admissions.mockRestore();
      await native?.restore();
      vi.restoreAllMocks();
      workspaceDb?.sqlite.close();
      await f.cleanup();
    }
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
      const grantId = allocateEntityId('grant');
      const planId = `plan_${randomUUID()}`;
      const receiptId = `receipt_${randomUUID()}`;
      await createVaultGrant(f.coreDb, {
        grantId,
        vaultReferenceId: source.terms.referenceId,
        ownerScope: scope,
        ...(scope === 'workspace' ? { workspaceId: source.workspaceId } : {}),
        lifetime: scope,
        allowedInjectionPaths: ['gateway-only'],
      });
      await createVaultInjectionPlan(f.coreDb, {
        grantId,
        planId,
        injectionVisibility: 'gateway-only',
        capabilityId: 'mcp.call-tool',
        expirationBehavior: 'grant-lifetime',
        revocationBehavior: 'close-gateway-session',
        redactionRule: 'exact-resolved-material',
        backendCapabilityRequirement: 'mcp-gateway:http',
      });
      // Seed retained completion only to test the read projection; actual sink proof stays with the Gateway tests.
      await createVaultInjectionReceipt(f.coreDb, {
        grantId,
        planId,
        receiptId,
        capabilityCallId: allocateEntityId('cap'),
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
      ownerUserId: FIXTURE_LOCAL_USER_ID,
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
    await f.cleanup();
  }
});

it('releases its Core-local raising Turn when atomic request publication fails', async () => {
  const f = fixture();
  try {
    const source = await prepare(f);
    const item = vi
      .spyOn(f.store, 'applyPendingRequestCommand')
      .mockRejectedValueOnce(
        new pendingRequests.PendingRequestCommandError(
          'recovery_required',
          'Synthetic native publication refusal.',
          409
        )
      );
    const response = await f.send('vault.grant-request', { ...source, requestId: randomUUID() });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('recovery_required');
    expect(item.mock.calls[0]?.[1].action).toBe('raise');
    item.mockRestore();
    const turns = f.store.listThreadTurns(source.workspaceId, source.threadId);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe('failed');
    const observed = await f.send('vault.grant-request-list', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
    });
    // Retained partial tuples are covered by the Pending owner; live publication is atomic.
    expect(observed.status).toBe(200);
    expect((await observed.json()).items).toEqual([]);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
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
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(setDefaultServerAdminTokenId(f.coreDb, FIXTURE_LOCAL_USER_ID, first.tokenId)).toBe(true);
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
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(setDefaultServerAdminTokenId(f.coreDb, FIXTURE_LOCAL_USER_ID, replacement.tokenId)).toBe(
      true
    );
    const issue = await f.sessionSend('vault.grant-issue', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      approvalRequestId: request.approvalRequestId,
    });
    expect(issue.status).toBe(403);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

it.each([
  'workspace',
  'server',
] as const)('records exact nonmember administrator session review and provenance for %s', async (scope) => {
  const reviewerId = allocateEntityId('usr');
  const f = fixture(reviewerId);
  try {
    const source = await prepare(f, scope);
    const request = await (
      await f.send('vault.grant-request', { ...source, requestId: randomUUID() })
    ).json();
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
    expect(setDefaultServerAdminTokenId(f.coreDb, reviewerId, reviewer.tokenId)).toBe(true);
    const listed = await f.sessionSend('vault.grant-request-list', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
    });
    expect(listed.status).toBe(200);
    const observed = (await listed.json()).items[0];
    expect(observed).toMatchObject({ canApprove: true, effect: { status: 'available' } });
    expect(JSON.parse(observed.effect.detail)).toMatchObject({
      operation: 'vault.grant-issue',
      terms: source.terms,
    });
    expect((await f.sessionSend('approval.respond', decision(request, 'granted'))).status).toBe(
      200
    );
    const issued = await f.sessionSend('vault.grant-issue', {
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      approvalRequestId: request.approvalRequestId,
    });
    expect(issued.status).toBe(200);
    const result = await issued.json();
    expect(result).toMatchObject({
      responsibleUserId: FIXTURE_LOCAL_USER_ID,
      decidingActorId: reviewerId,
      disposition: 'approved-executed',
    });
    expect(
      f.coreDb.sqlite
        .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .all(source.workspaceId, reviewerId)
    ).toEqual([]);
    const grant = getVaultGrant(f.coreDb, result.grantId)!;
    expect(grant.approvalId).toBe(request.approvalRequestId);
    const db = openWorkspaceDb(f.dataRoot, source.workspaceId);
    try {
      expect(readPendingRequest(db.sqlite, request.approvalRequestId)).toMatchObject({
        decidingActor: { kind: 'user', id: reviewerId },
        decidingActorContext: {
          kind: 'session',
          userId: reviewerId,
          adminTokenId: reviewer.tokenId,
        },
      });
      // The specialized producer is migrated in place, with one final authorizer and truthful actual actor.
      const decisions = await readReviewedIssueDecisions(db);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        decisionId: grant.policyDecisionId,
        policyEngineVersion: 'nanocore-policy:v1',
        policySnapshotId: await admittedReviewedIssuePolicyDigest(f),
        result: 'allow',
        reasonCode: 'granted',
        enforcementPoint: 'vault.grant-issue@decide',
        subjectSummary: {
          principal: { kind: 'human', id: reviewerId },
          actor: { kind: 'user', id: reviewerId },
          responsibleHumanId: reviewerId,
        },
        approvalId: request.approvalRequestId,
        mediation: {
          operation: 'vault.grant-issue',
          stage: 'decide',
          role: 'final',
          subject: {
            principal: { kind: 'human', id: reviewerId },
            actor: { kind: 'user', id: reviewerId },
            responsibleHumanId: reviewerId,
          },
          kernel: { effect: 'allow' },
        },
      });
      expect(decisions[0]!.contextSummary).toMatchObject({
        requestId: request.approvalRequestId,
        threadId: source.threadId,
        turnId: request.raisingTurnId,
        issuingActorId: reviewerId,
        requesterId: FIXTURE_LOCAL_USER_ID,
        approvalRequestId: request.approvalRequestId,
      });
      expect(
        db.sqlite
          .prepare(
            'SELECT actor_json, permission_decision_id, request_id FROM audit_events WHERE audit_event_id = ?'
          )
          .get(decisions[0]!.auditEventId)
      ).toEqual({
        actor_json: JSON.stringify({ kind: 'user', id: reviewerId }),
        permission_decision_id: grant.policyDecisionId,
        request_id: request.approvalRequestId,
      });
    } finally {
      db.sqlite.close();
    }
    const audit = f.coreDb.sqlite
      .prepare("SELECT actor_json, request_id FROM audit_events WHERE action = 'vault.grant-issue'")
      .get();
    expect(audit).toEqual({
      actor_json: JSON.stringify({ kind: 'user', id: reviewerId }),
      request_id: request.approvalRequestId,
    });
  } finally {
    await f.cleanup();
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
  let native: Awaited<ReturnType<typeof createNativeTaskAdmissionFixture>> | undefined;
  const admissions = vi.spyOn(productTurnStart, 'observeTurnAdmission');
  try {
    const source = await prepare(f, ownerScope, 'workspace');
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
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      dataRoot: f.dataRoot,
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      workspaceConfigs: loadRuntimeConfig(f.dataRoot).workspaceConfigs,
      agentManifests: [
        createTestAgentSetup({
          mcpIds: ['reviewed-sink'],
          requiredCapabilities: ['trusted-worker-inference-relay'],
        }).manifest,
      ],
      workspaceMcpServerCatalogs: [
        {
          workspaceId: source.workspaceId,
          path: join(f.dataRoot, 'catalog/catalog.json'),
          catalog,
        },
      ],
    });
    native = await createNativeTaskAdmissionFixture(f.coreDb, f.store, {
      readRuntimeConfig: () => snapshot,
    });
    const app = createApp({
      coreDb: f.coreDb,
      store: f.store,
      vaultUnlockState: f.vaultUnlockState,
      workerMcpGateway: gateway,
      fileAdmission: native.fileAdmission,
      turnExecutor: native.executor,
      workerControlGateway: native.workerControlGateway,
      runtimeConfigManager: createRuntimeConfigManager({
        dataRoot: null,
        initialSnapshot: snapshot,
      }),
    });
    const started = await app.request(
      ...operationRequest(
        'task.start',
        { workspaceId: source.workspaceId, threadId: source.threadId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: 'Use the reviewed credential through the Gateway',
            requestId: randomUUID(),
          }),
        }
      )
    );
    expect(started.status).toBe(202);
    const { turn } = StartTaskModeResponseSchema.parse(await started.json());
    await native.executionFor(turn.id).launched.promise;
    await native.waitForStartup(turn.id);
    workspaceDb = openWorkspaceDb(f.dataRoot, source.workspaceId);
    const transport = new StreamableHTTPClientTransport(
      new URL('http://nanocore.test/api/worker-capabilities/mcp/reviewed-sink'),
      {
        fetch: (url, init) => app.fetch(new Request(url, init)),
        requestInit: { headers: { authorization: `Bearer ${native.executor.capabilityToken}` } },
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
    native?.executor.completion.resolve();
    await Promise.all(
      admissions.mock.results
        .filter((result) => result.type === 'return')
        .map((result) => result.value.closeout)
    );
    admissions.mockRestore();
    await native?.restore();
    await gateway.close();
    await upstream.close();
    workspaceDb?.sqlite.close();
    await shutdownControlStoreWorkerClient();
    await f.cleanup();
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
      targetAgentSessionId: allocateEntityId('as'),
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
    await f.cleanup();
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
    await f.cleanup();
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
    await f.cleanup();
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
    await f.cleanup();
  }
});

/** Establishes ordinary Users and a real active User Login before any request feature is called. */
async function loginShareFixture(quarantined = false) {
  const f = fixture();
  const { createBetterAuth } = await import('../auth/better-auth.js');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { PolicyInterception } = await import('../policy/interception.js');
  const { createVaultReference, getVaultReference } = await import('./vault-references.js');
  const auth = createBetterAuth(f.coreDb, { env: {} });
  const humans = [];
  for (const name of ['Login owner', 'Other member', 'Independent administrator']) {
    const result = await auth.api.signUpEmail({
      body: {
        name,
        email: `${randomUUID()}@example.invalid`,
        password: randomUUID(),
      },
    });
    humans.push(result.user);
  }
  const [owner, other, admin] = humans;
  const created = await f.send('workspace.create', {
    name: 'Login share destination',
    requestId: randomUUID(),
  });
  expect(created.status).toBe(201);
  const workspaceId = (await created.json()).id as string;
  mkdirSync(join(f.dataRoot, 'config'), { recursive: true });
  writeFileSync(join(f.dataRoot, 'config/server.jsonc'), JSON.stringify({ schemaVersion: 1 }));
  const manager = createRuntimeConfigManager({ dataRoot: f.dataRoot });
  const participant = vi.fn(
    async (
      _input: Parameters<
        import('../policy/interception.js').DeterministicPolicyParticipant['invoke']
      >[0]
    ): Promise<unknown> => ({ decision: 'allow' as const })
  );
  const interception = new PolicyInterception({
    id: 'login-share-test',
    version: `sha256:${'3'.repeat(64)}`,
    invoke: participant,
  });
  const apps = new Map<string, ReturnType<typeof createApp>>();
  const sendAs = (userId: string, id: string, body: Record<string, unknown>) => {
    let app = apps.get(userId);
    if (!app) {
      const sessionId = allocateEntityId('auth');
      app = createApp({
        coreDb: f.coreDb,
        dataRoot: f.dataRoot,
        store: f.store,
        vaultUnlockState: f.vaultUnlockState,
        agentManifests: [createTestAgentSetup().manifest],
        runtimeConfigManager: manager,
        policyInterception: interception,
        mode: 'server',
        auth: {
          api: { getSession: async () => ({ session: { id: sessionId }, user: { id: userId } }) },
          handler: async () => Response.json({}),
        },
      });
      apps.set(userId, app);
    }
    return app.request(
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
  };
  for (const user of [owner!, other!]) {
    const invited = await f.send('workspace.invitation-create', {
      workspaceId,
      requestId: randomUUID(),
      inviteeEmail: user.email,
    });
    expect(invited.status).toBe(201);
    const { invitation } = await invited.json();
    expect(
      (
        await sendAs(user.id, 'workspace.my-invitation-accept', {
          invitationId: invitation.invitationId,
          expectedRevision: invitation.revision,
          requestId: randomUUID(),
        })
      ).status
    ).toBe(200);
  }
  const thread = await sendAs(owner!.id, 'thread.create', {
    workspaceId,
    name: 'Exact personal Login consent',
    visibility: 'workspace',
    requestId: randomUUID(),
  });
  expect(thread.status).toBe(200);
  const threadId = (await thread.json()).id as string;
  const referenceId = allocateEntityId('vault');
  const backend = f.vaultUnlockState.backend();
  const material = backend.store({
    referenceId,
    material: 'synthetic-login-share-material',
    metadata: { ownerScope: 'user', userId: owner!.id },
  });
  const reference = await createVaultReference(f.coreDb, {
    referenceId,
    ownerScope: 'user',
    userId: owner!.id,
    displayName: 'Synthetic personal Login',
    secretKind: 'opaque',
    backendKind: 'encrypted-file',
    login: { provider: 'codex', accountId: 'synthetic-login-share-account', quarantined },
  });
  expect(
    reference,
    'Setup must retain the explicit native User Login, independently of request support'
  ).toMatchObject({
    ownerScope: 'user',
    userId: owner!.id,
    workspaceId: null,
    status: 'active',
    currentVersion: 1,
    login: { provider: 'codex', accountId: 'synthetic-login-share-account', quarantined },
  });
  expect(material).toMatchObject({
    ownerScope: 'user',
    userId: owner!.id,
    currentVersion: 1,
    revoked: false,
  });
  expect(getVaultReference(f.coreDb, referenceId)).toEqual(reference);
  const adminToken = createOpenKitAccessTokenRecord(f.coreDb, {
    ownerUserId: admin!.id,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  expect(setDefaultServerAdminTokenId(f.coreDb, admin!.id, adminToken.tokenId)).toBe(true);
  const terms = {
    referenceId,
    ownerScope: 'workspace' as const,
    lifetime: 'workspace' as const,
    injectionPath: 'runtime-token' as const,
    targetAgentId: 'agent_codex_host',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const command = { workspaceId, threadId };
  const resolve = vi.spyOn(backend, 'resolve');
  return {
    ...f,
    owner: owner!,
    other: other!,
    admin: admin!,
    adminToken,
    sendAs,
    manager,
    participant,
    interception,
    reference,
    backend,
    resolve,
    terms,
    command,
    raise: async () => {
      const response = await sendAs(owner!.id, 'vault.grant-request', {
        ...command,
        terms,
        requestId: randomUUID(),
      });
      expect(
        response.status,
        'Deciding baseline: valid native User Login setup must reach supported runtime-token request admission'
      ).toBe(200);
      return response.json();
    },
  };
}

/** Policy is admitted by the existing human configuration owner, never by a fabricated receipt. */
async function installLoginSharePolicy(
  f: Awaited<ReturnType<typeof loginShareFixture>>,
  userId = f.owner.id,
  uses?: number
) {
  const { createAdministrationConfiguration } = await import(
    '../config/administration-configuration.js'
  );
  const { RuntimeConfigFileService } = await import('../config/runtime-config-files.js');
  const { recordWorkspaceOwnerMembership } = await import('../workspace-membership.js');
  const personal = await f.store.ensureQuickChatWorkspace(FIXTURE_LOCAL_USER_ID);
  recordWorkspaceOwnerMembership({
    coreDb: f.coreDb,
    workspaceId: personal.id,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
  });
  const thread = await f.store.createThread(
    personal.id,
    'Review exact sharing Policy',
    undefined,
    'administration',
    {
      visibility: 'private',
      privateOwnerUserId: FIXTURE_LOCAL_USER_ID,
    }
  );
  const turn = await f.store.createTurn(personal.id, thread.id, 'Confirm sharing Policy', {
    kind: 'user',
    id: FIXTURE_LOCAL_USER_ID,
  });
  const resource = {
    kind: 'container' as const,
    container: { kind: 'user' as const, id: userId, owner: { kind: 'user' as const, userId } },
  };
  const scope = {
    subjects: [{ kind: 'human' as const, id: userId }],
    actions: ['vault.admin'],
    resources: [resource],
  };
  const document: import('@openkit/protocol').PolicyDocumentV1 = {
    schemaVersion: 1,
    statements: [
      {
        id: 'login-share-policy',
        kind: 'binding',
        author: { kind: 'human', id: FIXTURE_LOCAL_USER_ID },
        authority: { kind: 'human', userId: FIXTURE_LOCAL_USER_ID },
        authoredAt: new Date().toISOString(),
        state: 'active',
        scope,
        lifetime: { anchor: resource.container, ...(uses === undefined ? {} : { uses }) },
        operation: 'vault.grant-issue',
        stage: 'decide',
        mode: 'gate',
        participant: {
          kind: 'deterministic',
          id: 'login-share-test',
          version: `sha256:${'3'.repeat(64)}`,
        },
        inputDisclosure: scope,
        order: 0,
        timeoutMs: 100,
        failure: 'error',
        circuit: { failures: 1, recoveryAfterMs: 60_000 },
      },
    ],
  };
  const files = new RuntimeConfigFileService({
    dataRoot: f.dataRoot,
    userId: FIXTURE_LOCAL_USER_ID,
    workspaceIds: [f.command.workspaceId, personal.id],
    runtimeConfigManager: f.manager,
    readRuntimeConfigStatus: () => f.manager.status(),
  });
  const workspaceDbs = new Map<string, ReturnType<typeof openWorkspaceDb>>();
  const repositoryWorkspaceDb = (id: string) => {
    let db = workspaceDbs.get(id);
    if (!db) {
      db = openWorkspaceDb(f.dataRoot, id);
      workspaceDbs.set(id, db);
    }
    return db;
  };
  const configuration = createAdministrationConfiguration({
    actor: { kind: 'local', userId: FIXTURE_LOCAL_USER_ID },
    coreDb: f.coreDb,
    store: f.store,
    files,
    runtimeConfig: () => f.manager.current(),
    reload: () => f.manager.reload({ mode: 'safe', dryRun: false }),
    repositoryWorkspaceDb,
    inflightCommands: new WeakMap(),
  });
  try {
    const proposed = await configuration.propose(
      {
        targetFamily: 'policy',
        targetId: 'server',
        expectedRevision: files.readFile('server.jsonc').file.revision!,
        changes: {
          proposed: document,
          rationale: 'Exact human review of personal Login sharing Policy.',
        },
      },
      { threadId: thread.id, turnId: turn.id, requestId: randomUUID() }
    );
    expect(
      await configuration.apply({
        requestId: randomUUID(),
        candidate: proposed.candidate,
        confirmation: proposed.confirmation,
      })
    ).toMatchObject({ persisted: true, reload: 'applied' });
  } finally {
    for (const db of workspaceDbs.values()) db.sqlite.close();
  }
}

/** Share review must never imply material resolution, runtime completion, or account disclosure. */
function expectLoginShareNoDelivery(
  f: Awaited<ReturnType<typeof loginShareFixture>>,
  evidence: unknown
) {
  expect(f.resolve).not.toHaveBeenCalled();
  for (const table of ['vault_injection_plans', 'vault_injection_receipts', 'vault_use_records'])
    expect(f.coreDb.sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  const text = JSON.stringify(evidence);
  for (const excluded of [
    'synthetic-login-share-material',
    'synthetic-login-share-account',
    'backendLocator',
    'accountId',
  ])
    expect(text).not.toContain(excluded);
}

describe('governed User Login Workspace sharing', () => {
  it.each([
    false,
    true,
  ])('shares an explicit Login with exact owner session consent (quarantined=%s)', async (quarantined) => {
    const f = await loginShareFixture(quarantined);
    try {
      const request = await f.raise();
      expect(request).toMatchObject({
        requesterKind: 'person',
        responsibleUserId: f.owner.id,
        state: 'pending',
        terms: f.terms,
        grantId: null,
      });
      expect(JSON.parse(request.effect.detail).terms).toEqual(f.terms);
      const input = { ...f.command, approvalRequestId: request.approvalRequestId };
      expect((await f.sendAs(f.owner.id, 'vault.grant-issue', input)).status).toBe(409);
      expect(listVaultGrants(f.coreDb)).toEqual([]);
      expect(
        (await f.sendAs(f.owner.id, 'approval.respond', decision(request, 'granted'))).status
      ).toBe(200);
      expect(listVaultGrants(f.coreDb)).toEqual([]);
      const issued = await f.sendAs(f.owner.id, 'vault.grant-issue', input);
      expect(issued.status).toBe(200);
      const result = await issued.json();
      expect(result).toMatchObject({
        decidingActorId: f.owner.id,
        responsibleUserId: f.owner.id,
        disposition: 'approved-executed',
        terms: f.terms,
      });
      const grant = getVaultGrant(f.coreDb, result.grantId)!;
      expect(grant).toMatchObject({
        issuance: 'target',
        vaultReferenceId: f.reference.referenceId,
        ownerScope: 'workspace',
        workspaceId: f.command.workspaceId,
        lifetime: 'workspace',
        allowedInjectionPaths: ['runtime-token'],
        targetAgentId: f.terms.targetAgentId,
        targetAgentSessionId: null,
        targetCapabilityId: null,
        expiresAt: f.terms.expiresAt,
        approvalId: request.approvalRequestId,
        status: 'active',
      });
      expect(grant.policyDecisionId).toBeTruthy();
      const { getVaultReference } = await import('./vault-references.js');
      expect(getVaultReference(f.coreDb, f.reference.referenceId)).toEqual(f.reference);
      const again = await f.sendAs(f.owner.id, 'vault.grant-issue', input);
      expect(again.status).toBe(200);
      expect((await again.json()).grantId).toBe(result.grantId);
      expect(listVaultGrants(f.coreDb)).toHaveLength(1);
      const audit = f.coreDb.sqlite
        .prepare(
          "SELECT actor_json, vault_grant_id FROM audit_events WHERE action = 'vault.grant-issue'"
        )
        .all();
      expect(audit).toEqual([
        {
          actor_json: JSON.stringify({ kind: 'user', id: f.owner.id }),
          vault_grant_id: result.grantId,
        },
      ]);
      expectLoginShareNoDelivery(f, [
        request,
        result,
        audit,
        f.store.listThreadItems(f.command.workspaceId, f.command.threadId),
      ]);
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });

  it('records the actual nonmember administrator without inventing owner or membership facts', async () => {
    const f = await loginShareFixture();
    try {
      const request = await f.raise();
      expect(
        (await f.sendAs(f.admin.id, 'approval.respond', decision(request, 'granted'))).status
      ).toBe(200);
      const issued = await f.sendAs(f.admin.id, 'vault.grant-issue', {
        ...f.command,
        approvalRequestId: request.approvalRequestId,
      });
      expect(issued.status).toBe(200);
      const result = await issued.json();
      expect(result).toMatchObject({
        responsibleUserId: f.owner.id,
        decidingActorId: f.admin.id,
        disposition: 'approved-executed',
      });
      expect(
        f.coreDb.sqlite
          .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
          .all(f.command.workspaceId, f.admin.id)
      ).toEqual([]);
      const db = openWorkspaceDb(f.dataRoot, f.command.workspaceId);
      try {
        expect(readPendingRequest(db.sqlite, request.approvalRequestId)).toMatchObject({
          decidingActor: { kind: 'user', id: f.admin.id },
          decidingActorContext: {
            kind: 'session',
            userId: f.admin.id,
            adminTokenId: f.adminToken.tokenId,
          },
        });
      } finally {
        db.sqlite.close();
      }
      const { openUserDb } = await import('../storage/db.js');
      const { listUserPermissionDecisions } = await import('../policy/permission-decisions.js');
      const { listSqliteAuditEvents } = await import('../audit-events.js');
      const userDb = openUserDb(f.dataRoot, f.admin.id);
      try {
        const final = listUserPermissionDecisions(userDb).filter(
          (row) =>
            row.mediation?.operation === 'vault.grant-issue' && row.mediation.role === 'final'
        );
        expect(final).toHaveLength(1);
        expect(final[0]).toMatchObject({ ownerScope: 'user', workspaceId: null, result: 'allow' });
        expect(listSqliteAuditEvents(userDb.sqlite)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              action: 'vault.grant-issue',
              outcome: 'succeeded',
              actor: { kind: 'user', id: f.admin.id },
              permissionDecisionId: final[0]!.decisionId,
            }),
          ])
        );
      } finally {
        userDb.sqlite.close();
      }
      expect(
        f.coreDb.sqlite
          .prepare("SELECT actor_json FROM audit_events WHERE action = 'vault.grant-issue'")
          .all()
      ).toEqual([{ actor_json: JSON.stringify({ kind: 'user', id: f.admin.id }) }]);
      expectLoginShareNoDelivery(f, [request, result]);
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });

  it('refuses foreign-member requests and approval, and refuses Workspace bearer personal consent', async () => {
    const f = await loginShareFixture();
    try {
      expect(
        (
          await f.sendAs(f.other.id, 'vault.grant-request', {
            ...f.command,
            terms: f.terms,
            requestId: randomUUID(),
          })
        ).status
      ).toBe(403);
      const request = await f.raise();
      expect(
        (await f.sendAs(f.other.id, 'approval.respond', decision(request, 'granted'))).status
      ).toBe(403);
      for (const scope of ['workspace', 'workspace-readonly'] as const) {
        const token = createOpenKitAccessTokenRecord(f.coreDb, {
          ownerUserId: f.owner.id,
          scope,
          workspaceIds: [f.command.workspaceId],
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
        expect(
          (await f.serverSend('approval.respond', decision(request, 'granted'), token.secret))
            .status
        ).toBe(403);
      }
      expect(listVaultGrants(f.coreDb)).toEqual([]);
      expectLoginShareNoDelivery(f, request);
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });

  it.each([
    'denied',
    'changed-terms',
    'expired',
    'revoked-decider',
    'member-left',
  ] as const)('keeps a %s share request non-authorizing', async (reason) => {
    const f = await loginShareFixture();
    try {
      const request = await f.raise();
      const decider = reason === 'revoked-decider' ? f.admin.id : f.owner.id;
      expect(
        (
          await f.sendAs(
            decider,
            'approval.respond',
            decision(request, reason === 'denied' ? 'denied' : 'granted')
          )
        ).status
      ).toBe(200);
      const input = { ...f.command, approvalRequestId: request.approvalRequestId };
      if (reason === 'expired')
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.terms.expiresAt) + 1);
      if (reason === 'revoked-decider')
        revokeOpenKitAccessTokenRecord(f.coreDb, f.adminToken.tokenId);
      if (reason === 'member-left') {
        const { getWorkspaceMember } = await import('../workspace-sharing.js');
        const member = getWorkspaceMember(f.coreDb, f.command.workspaceId, f.owner.id)!;
        expect(
          (
            await f.sendAs(f.owner.id, 'workspace.leave', {
              workspaceId: f.command.workspaceId,
              expectedRevision: member.revision,
              requestId: randomUUID(),
            })
          ).status
        ).toBe(200);
      }
      const issued = await f.sendAs(
        reason === 'member-left' ? f.admin.id : f.owner.id,
        'vault.grant-issue',
        {
          ...input,
          ...(reason === 'changed-terms'
            ? { terms: { ...f.terms, targetAgentId: 'other-agent' } }
            : {}),
        }
      );
      expect(issued.status).toBeGreaterThanOrEqual(400);
      expect(listVaultGrants(f.coreDb)).toEqual([]);
      expectLoginShareNoDelivery(f, request);
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });

  it.each([
    'locked',
    'ordinary',
    'revoked',
    'wrong-sink',
    'material-version-mismatch',
  ] as const)('rejects %s Login selections without capture or material resolution', async (reason) => {
    const f = await loginShareFixture();
    try {
      const { createVaultReference, advanceActiveVaultReferenceVersion, revokeVaultReference } =
        await import('./vault-references.js');
      let terms = f.terms;
      if (reason === 'ordinary') {
        const referenceId = allocateEntityId('vault');
        f.backend.store({
          referenceId,
          material: 'synthetic-ordinary-user-material',
          metadata: { ownerScope: 'user', userId: f.owner.id },
        });
        await createVaultReference(f.coreDb, {
          referenceId,
          ownerScope: 'user',
          userId: f.owner.id,
          displayName: 'Ordinary User reference',
          secretKind: 'opaque',
          backendKind: 'encrypted-file',
        });
        terms = { ...terms, referenceId };
      }
      if (reason === 'locked') f.vaultUnlockState.lock();
      if (reason === 'revoked')
        await revokeVaultReference(f.coreDb, { referenceId: f.reference.referenceId });
      if (reason === 'material-version-mismatch')
        await advanceActiveVaultReferenceVersion(f.coreDb, {
          referenceId: f.reference.referenceId,
          currentVersion: 2,
        });
      const response = await f.sendAs(f.owner.id, 'vault.grant-request', {
        ...f.command,
        terms: reason === 'wrong-sink' ? { ...terms, injectionPath: 'runtime-env' } : terms,
        requestId: randomUUID(),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(listVaultGrants(f.coreDb)).toEqual([]);
      expect(f.store.listThreadTurns(f.command.workspaceId, f.command.threadId)).toEqual([]);
      expectLoginShareNoDelivery(f, await response.json());
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });

  it.each([
    'deny',
    'version',
    'revoked',
    'credential',
  ] as const)('uses real User Policy and rejects %s after awaited evaluation', async (change) => {
    const f = await loginShareFixture();
    try {
      const request = await f.raise();
      const caller = change === 'credential' ? f.admin.id : f.owner.id;
      expect(
        (await f.sendAs(caller, 'approval.respond', decision(request, 'granted'))).status
      ).toBe(200);
      await installLoginSharePolicy(f, caller);
      f.participant.mockImplementation(async () => {
        const { advanceActiveVaultReferenceVersion, revokeVaultReference } = await import(
          './vault-references.js'
        );
        if (change === 'version')
          await advanceActiveVaultReferenceVersion(f.coreDb, {
            referenceId: f.reference.referenceId,
            currentVersion: 2,
          });
        if (change === 'revoked')
          await revokeVaultReference(f.coreDb, { referenceId: f.reference.referenceId });
        if (change === 'credential') revokeOpenKitAccessTokenRecord(f.coreDb, f.adminToken.tokenId);
        return { decision: change === 'deny' ? 'deny' : 'allow' };
      });
      const issued = await f.sendAs(caller, 'vault.grant-issue', {
        ...f.command,
        approvalRequestId: request.approvalRequestId,
      });
      expect(issued.status).toBeGreaterThanOrEqual(400);
      expect(f.participant).toHaveBeenCalledOnce();
      expect(f.participant.mock.calls[0]![0].proposal).toMatchObject({
        operation: 'vault.grant-issue',
        workspaceId: null,
        subject: { actor: { kind: 'user', id: caller }, process: null },
      });
      expect(listVaultGrants(f.coreDb)).toEqual([]);
      expectLoginShareNoDelivery(f, request);
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });

  it('consumes one finite User Policy use and records actual-owner decision and Audit at the same home', async () => {
    const f = await loginShareFixture();
    try {
      const request = await f.raise();
      expect(
        (await f.sendAs(f.owner.id, 'approval.respond', decision(request, 'granted'))).status
      ).toBe(200);
      await installLoginSharePolicy(f, f.owner.id, 1);
      const input = { ...f.command, approvalRequestId: request.approvalRequestId };
      const issued = await f.sendAs(f.owner.id, 'vault.grant-issue', input);
      expect(issued.status).toBe(200);
      const result = await issued.json();
      expect(f.participant).toHaveBeenCalledOnce();
      const { openUserDb } = await import('../storage/db.js');
      const { listUserPermissionDecisions, readPolicyStatementUseCount } = await import(
        '../policy/permission-decisions.js'
      );
      const { listSqliteAuditEvents } = await import('../audit-events.js');
      const { readAdmittedPolicyDocument } = await import('../policy/configuration.js');
      const { policyDigest } = await import('../policy/statements.js');
      const userDb = openUserDb(f.dataRoot, f.owner.id);
      try {
        const finals = listUserPermissionDecisions(userDb).filter(
          (row) =>
            row.mediation?.operation === 'vault.grant-issue' && row.mediation.role === 'final'
        );
        expect(finals).toHaveLength(1);
        expect(finals[0]).toMatchObject({ ownerScope: 'user', workspaceId: null, result: 'allow' });
        const statement = readAdmittedPolicyDocument(
          f.coreDb,
          f.manager.current().openKitConfig.policy?.mediation
        ).statements.find((row) => row.id === 'login-share-policy')!;
        expect(
          readPolicyStatementUseCount(userDb, { id: statement.id, digest: policyDigest(statement) })
        ).toBe(1);
        const events = listSqliteAuditEvents(userDb.sqlite);
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: finals[0]!.auditEventId,
              action: 'permission.decision',
              permissionDecisionId: finals[0]!.decisionId,
              actor: { kind: 'user', id: f.owner.id },
            }),
            expect.objectContaining({
              action: 'vault.grant-issue',
              outcome: 'succeeded',
              permissionDecisionId: finals[0]!.decisionId,
              actor: { kind: 'user', id: f.owner.id },
            }),
          ])
        );
        expectLoginShareNoDelivery(f, [request, result, events, finals]);
      } finally {
        userDb.sqlite.close();
      }
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });
});

it.each([
  'live',
  'revoked-agent',
] as const)('keeps a %s Worker own-Login request bound to its package and human consent', async (lineage) => {
  const f = await loginShareFixture();
  let native: Awaited<ReturnType<typeof createNativeTaskAdmissionFixture>> | undefined;
  let workspaceDb: ReturnType<typeof openWorkspaceDb> | undefined;
  let turnId: string | undefined;
  const admissions = vi.spyOn(productTurnStart, 'observeTurnAdmission');
  try {
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      dataRoot: f.dataRoot,
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      workspaceConfigs: loadRuntimeConfig(f.dataRoot).workspaceConfigs,
      agentManifests: [
        createTestAgentSetup({ requiredCapabilities: ['trusted-worker-inference-relay'] }).manifest,
      ],
    });
    const runtimeConfigManager = createRuntimeConfigManager({
      dataRoot: null,
      initialSnapshot: snapshot,
    });
    native = await createNativeTaskAdmissionFixture(f.coreDb, f.store, {
      readRuntimeConfig: () => snapshot,
    });
    const app = createApp({
      coreDb: f.coreDb,
      store: f.store,
      vaultUnlockState: f.vaultUnlockState,
      fileAdmission: native.fileAdmission,
      turnExecutor: native.executor,
      workerControlGateway: native.workerControlGateway,
      runtimeConfigManager,
      mode: 'server',
      auth: {
        api: {
          getSession: async () => ({
            session: { id: allocateEntityId('auth') },
            user: { id: f.owner.id },
          }),
        },
        handler: async () => Response.json({}),
      },
    });
    const started = await app.request(
      ...operationRequest('task.start', f.command, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: 'Request my own selected personal Login share',
          requestId: randomUUID(),
        }),
      })
    );
    expect(started.status).toBe(202);
    const { turn } = StartTaskModeResponseSchema.parse(await started.json());
    turnId = turn.id;
    await native.executionFor(turn.id).launched.promise;
    await native.waitForStartup(turn.id);
    const pkg = native.workerControlGateway.authenticatePackageToken(
      `Bearer ${native.executor.capabilityToken}`,
      { tokenFamily: 'capability' }
    );
    expect(pkg.scope).toMatchObject({
      ...f.command,
      turnId: turn.id,
      triggerActor: { kind: 'user', id: f.owner.id },
    });
    workspaceDb = openWorkspaceDb(f.dataRoot, f.command.workspaceId);
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
      workspaceId: f.command.workspaceId,
      actor: pkg.scope.triggerActor,
      scope: pkg.scope,
    };
    for (const changed of [
      { ...context, packageSnapshotId: randomUUID() },
      { ...context, actor: { kind: 'user' as const, id: f.other.id } },
    ])
      await expect(
        dispatchOpenkitGenerativeTool(changed, 'vault_grant-request', { terms: f.terms })
      ).rejects.toMatchObject({ code: 'workspace_access_denied' });
    const response = await dispatchOpenkitGenerativeTool(context, 'vault_grant-request', {
      terms: f.terms,
    });
    const request = response.structuredContent as {
      workspaceId: string;
      threadId: string;
      raisingTurnId: string;
      approvalRequestId: string;
    };
    expect(request).toMatchObject({
      ...f.command,
      requesterKind: 'worker',
      responsibleUserId: f.owner.id,
      raisingTurnId: turn.id,
      agentId: pkg.agent.agentId,
      agentSessionId: pkg.scope.agentSessionId,
      state: 'pending',
      grantId: null,
      terms: f.terms,
    });
    expect(listVaultGrants(f.coreDb)).toEqual([]);
    expect(
      (await f.sendAs(f.other.id, 'approval.respond', decision(request, 'granted'))).status
    ).toBe(403);
    expect(
      (await f.sendAs(f.owner.id, 'approval.respond', decision(request, 'granted'))).status
    ).toBe(200);
    expect(listVaultGrants(f.coreDb)).toEqual([]);
    if (lineage === 'revoked-agent') {
      const requestingAgent = {
        kind: 'agent' as const,
        userId: f.owner.id,
        agentId: pkg.agent.agentId,
        processId: pkg.scope.agentSessionId,
      };
      const policy = managedThreadPolicy({
        ...f.command,
        userId: f.owner.id,
        operations: WORKSPACE_MEMBER_OPERATIONS,
      });
      const permission = policy.statements.find((statement) => statement.kind === 'permission')!;
      policy.statements.push({
        ...permission,
        id: `${permission.id}-agent`,
        scope: { ...permission.scope, actions: ['thread.read'] },
        grant: { kind: 'agent-process', agentId: requestingAgent.agentId },
      });
      f.store.setWorkspaceResourcePolicyProjection(() => policy);
      expect(
        isThreadIdVisible(
          f.store,
          f.command.workspaceId,
          f.command.threadId,
          f.owner.id,
          false,
          'thread.read',
          requestingAgent
        )
      ).toBe(true);
      expect(
        isThreadIdVisible(
          f.store,
          f.command.workspaceId,
          f.command.threadId,
          f.owner.id,
          false,
          'workspace.write',
          requestingAgent
        )
      ).toBe(false);
      const refused = await f.sendAs(f.owner.id, 'vault.grant-issue', {
        ...f.command,
        approvalRequestId: request.approvalRequestId,
      });
      expect(refused.status).toBe(403);
      expect(listVaultGrants(f.coreDb)).toEqual([]);
      expectLoginShareNoDelivery(f, request);
      return;
    }
    const issued = await f.sendAs(f.owner.id, 'vault.grant-issue', {
      ...f.command,
      approvalRequestId: request.approvalRequestId,
    });
    expect(issued.status).toBe(200);
    const result = await issued.json();
    expect(result).toMatchObject({
      requesterKind: 'worker',
      decidingActorId: f.owner.id,
      responsibleUserId: f.owner.id,
      disposition: 'approved-executed',
      terms: f.terms,
    });
    expect(getVaultGrant(f.coreDb, result.grantId)).toMatchObject({
      vaultReferenceId: f.reference.referenceId,
      ownerScope: 'workspace',
      workspaceId: f.command.workspaceId,
      allowedInjectionPaths: ['runtime-token'],
    });
    expectLoginShareNoDelivery(f, [request, result]);
  } finally {
    try {
      native?.executor.completion.resolve();
      if (turnId && native) {
        native.executionFor(turnId).completion.resolve();
        await native.executionFor(turnId).execution;
      }
      await Promise.all(
        admissions.mock.results
          .filter((result) => result.type === 'return')
          .map((result) => result.value.closeout)
      );
    } finally {
      admissions.mockRestore();
      await native?.restore();
      vi.restoreAllMocks();
      workspaceDb?.sqlite.close();
      await f.cleanup();
    }
  }
});

/** Reads both historical specialized and mediated issue records so a duplicate producer cannot hide. */
async function readReviewedIssueDecisions(db: ReturnType<typeof openWorkspaceDb>) {
  const { readPermissionDecisionRowV1 } = await import('../policy/retained-records-v1.js');
  return db.sqlite
    .prepare('SELECT * FROM permission_decisions')
    .all()
    .map(readPermissionDecisionRowV1)
    .filter(
      (row) =>
        row.enforcementPoint === 'vault.grant-issue' ||
        row.mediation?.operation === 'vault.grant-issue'
    );
}

/** Derives the actual admitted document revision through the existing Policy owner. */
async function admittedReviewedIssuePolicyDigest(f: ReturnType<typeof fixture>) {
  const { readAdmittedPolicyDocument } = await import('../policy/configuration.js');
  const { policyDigest } = await import('../policy/statements.js');
  return policyDigest(
    readAdmittedPolicyDocument(
      f.coreDb,
      loadRuntimeConfig(f.dataRoot).openKitConfig.policy?.mediation
    )
  );
}

/** Applies exact User or Workspace bindings through human proposal, confirmation and activation. */
async function installReviewedIssueMediationPolicy(
  f: Awaited<ReturnType<typeof loginShareFixture>>,
  callerId: string,
  workspaceId: string,
  home: 'user' | 'workspace'
) {
  const { createAdministrationConfiguration } = await import(
    '../config/administration-configuration.js'
  );
  const { RuntimeConfigFileService } = await import('../config/runtime-config-files.js');
  const { recordWorkspaceOwnerMembership } = await import('../workspace-membership.js');
  const personal = await f.store.ensureQuickChatWorkspace(FIXTURE_LOCAL_USER_ID);
  recordWorkspaceOwnerMembership({
    coreDb: f.coreDb,
    workspaceId: personal.id,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
  });
  const thread = await f.store.createThread(
    personal.id,
    'Confirm issue mediation',
    undefined,
    'administration',
    {
      visibility: 'private',
      privateOwnerUserId: FIXTURE_LOCAL_USER_ID,
    }
  );
  const turn = await f.store.createTurn(personal.id, thread.id, 'Approve exact issue bindings', {
    kind: 'user',
    id: FIXTURE_LOCAL_USER_ID,
  });
  const container =
    home === 'user'
      ? { kind: 'user' as const, id: callerId, owner: { kind: 'user' as const, userId: callerId } }
      : {
          kind: 'workspace' as const,
          id: workspaceId,
          owner: { kind: 'workspace' as const, workspaceId },
        };
  const resource = { kind: 'container' as const, container };
  const scope = {
    subjects: [{ kind: 'human' as const, id: callerId }],
    actions: ['vault.admin'],
    resources: [resource],
  };
  const document: import('@openkit/protocol').PolicyDocumentV1 = {
    schemaVersion: 1,
    statements: (['gate', 'observe'] as const).map((mode) => ({
      id: `reviewed-issue-${home}-${mode}`,
      kind: 'binding' as const,
      author: { kind: 'human' as const, id: FIXTURE_LOCAL_USER_ID },
      authority: { kind: 'human' as const, userId: FIXTURE_LOCAL_USER_ID },
      authoredAt: new Date().toISOString(),
      state: 'active' as const,
      scope,
      lifetime: { anchor: container },
      operation: 'vault.grant-issue',
      stage: mode === 'gate' ? ('decide' as const) : ('completed' as const),
      mode,
      participant: {
        kind: 'deterministic' as const,
        id: 'login-share-test',
        version: `sha256:${'3'.repeat(64)}`,
      },
      inputDisclosure: scope,
      order: 0,
      timeoutMs: 100,
      failure: mode === 'gate' ? ('error' as const) : ('continue' as const),
      circuit: { failures: 1, recoveryAfterMs: 60_000 },
    })),
  };
  const files = new RuntimeConfigFileService({
    dataRoot: f.dataRoot,
    userId: FIXTURE_LOCAL_USER_ID,
    workspaceIds: [workspaceId, personal.id],
    runtimeConfigManager: f.manager,
    readRuntimeConfigStatus: () => f.manager.status(),
  });
  const workspaceDbs = new Map<string, ReturnType<typeof openWorkspaceDb>>();
  const repositoryWorkspaceDb = (id: string) => {
    let db = workspaceDbs.get(id);
    if (!db) {
      db = openWorkspaceDb(f.dataRoot, id);
      workspaceDbs.set(id, db);
    }
    return db;
  };
  const configuration = createAdministrationConfiguration({
    actor: { kind: 'local', userId: FIXTURE_LOCAL_USER_ID },
    coreDb: f.coreDb,
    store: f.store,
    files,
    runtimeConfig: () => f.manager.current(),
    reload: () => f.manager.reload({ mode: 'safe', dryRun: false }),
    repositoryWorkspaceDb,
    inflightCommands: new WeakMap(),
  });
  try {
    const proposed = await configuration.propose(
      {
        targetFamily: 'policy',
        targetId: 'server',
        expectedRevision: files.readFile('server.jsonc').file.revision!,
        changes: {
          proposed: document,
          rationale:
            'Review deterministic issue gate and completed observation for the exact real owner.',
        },
      },
      { threadId: thread.id, turnId: turn.id, requestId: randomUUID() }
    );
    expect(
      await configuration.apply({
        requestId: randomUUID(),
        candidate: proposed.candidate,
        confirmation: proposed.confirmation,
      })
    ).toMatchObject({ persisted: true, reload: 'applied' });
  } finally {
    for (const db of workspaceDbs.values()) db.sqlite.close();
  }
  return resource;
}

// Core Mediation, Enforcement Points: every supported issue branch crosses the advertised gate.
describe('reviewed grant issue mediated producer migration', () => {
  it.each([
    ['workspace', 'deny'],
    ['server', 'deny'],
    ['user', 'deny'],
    ['workspace', 'allow'],
    ['server', 'allow'],
    ['user', 'allow'],
    ['workspace', 'current'],
    ['server', 'current'],
    ['user', 'current'],
    ['workspace', 'different-issuer'],
    ['server', 'different-issuer'],
    ['user', 'different-issuer'],
  ] as const)('uses the real %s home for %s and retains one final issue authorizer', async (referenceOwner, outcome) => {
    const f = await loginShareFixture();
    try {
      const source =
        referenceOwner === 'user'
          ? { ...f.command, terms: f.terms }
          : await prepare(f, referenceOwner);
      const callerId =
        referenceOwner === 'user' || outcome === 'different-issuer' ? f.owner.id : f.admin.id;
      if (referenceOwner !== 'user' && outcome === 'different-issuer') {
        const issuerToken = createOpenKitAccessTokenRecord(f.coreDb, {
          ownerUserId: callerId,
          scope: 'server-admin',
          workspaceIds: [],
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
        expect(setDefaultServerAdminTokenId(f.coreDb, callerId, issuerToken.tokenId)).toBe(true);
      }
      const deciderId = outcome === 'different-issuer' ? f.admin.id : callerId;
      const home = referenceOwner === 'user' ? 'user' : 'workspace';
      const requestInput = { ...source, requestId: randomUUID() };
      const raised =
        referenceOwner === 'user'
          ? await f.sendAs(f.owner.id, 'vault.grant-request', requestInput)
          : await f.send('vault.grant-request', requestInput);
      expect(raised.status).toBe(200);
      const request = await raised.json();
      expect(
        (await f.sendAs(deciderId, 'approval.respond', decision(request, 'granted'))).status
      ).toBe(200);
      const resource = await installReviewedIssueMediationPolicy(
        f,
        callerId,
        source.workspaceId,
        home
      );
      f.participant.mockImplementation(async (input) => {
        if (input.binding.mode === 'observe') return { observed: true };
        await Promise.resolve();
        if (outcome === 'current') {
          if (referenceOwner === 'user') {
            const { advanceActiveVaultReferenceVersion } = await import('./vault-references.js');
            await advanceActiveVaultReferenceVersion(f.coreDb, {
              referenceId: f.reference.referenceId,
              currentVersion: 2,
            });
          } else revokeOpenKitAccessTokenRecord(f.coreDb, f.adminToken.tokenId);
        }
        return { decision: outcome === 'deny' ? 'deny' : 'allow' };
      });
      const input = {
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        approvalRequestId: request.approvalRequestId,
      };
      const issued = await f.sendAs(callerId, 'vault.grant-issue', input);
      const calls = f.participant.mock.calls.map(([call]) => call);
      expect(calls.filter((call) => call.binding.mode === 'gate')).toHaveLength(1);
      expect(calls[0]!.proposal).toMatchObject({
        operation: 'vault.grant-issue',
        workspaceId: home === 'user' ? null : source.workspaceId,
        resource,
        subject: {
          principal: { kind: 'human', id: callerId },
          actor: { kind: 'user', id: callerId },
          responsibleHumanId: callerId,
        },
      });
      const { openUserDb } = await import('../storage/db.js');
      const db =
        home === 'user'
          ? openUserDb(f.dataRoot, callerId)
          : openWorkspaceDb(f.dataRoot, source.workspaceId);
      try {
        const { readPermissionDecisionRowV1 } = await import('../policy/retained-records-v1.js');
        const rows = db.sqlite
          .prepare('SELECT * FROM permission_decisions')
          .all()
          .map(readPermissionDecisionRowV1)
          .filter(
            (row) =>
              row.enforcementPoint === 'vault.grant-issue' ||
              row.mediation?.operation === 'vault.grant-issue'
          );
        expect(rows.every((row) => row.mediation?.operation === 'vault.grant-issue')).toBe(true);
        const finals = rows.filter((row) => row.mediation?.role === 'final');
        expect(finals).toHaveLength(1);
        expect(finals[0]).toMatchObject({
          ownerScope: home,
          workspaceId: home === 'user' ? null : source.workspaceId,
          policyEngineVersion: 'nanocore-policy:v1',
          policySnapshotId: await admittedReviewedIssuePolicyDigest(f),
          enforcementPoint: 'vault.grant-issue@decide',
          approvalId: request.approvalRequestId,
          mediation: {
            stage: 'decide',
            role: 'final',
            subject: { actor: { kind: 'user', id: callerId }, responsibleHumanId: callerId },
          },
          contextSummary: {
            requestId: request.approvalRequestId,
            approvalRequestId: request.approvalRequestId,
            threadId: source.threadId,
            turnId: request.raisingTurnId,
            issuingActorId: callerId,
            requesterId: referenceOwner === 'user' ? f.owner.id : FIXTURE_LOCAL_USER_ID,
          },
        });
        const { listSqliteAuditEvents } = await import('../audit-events.js');
        const events = listSqliteAuditEvents(db.sqlite);
        expect(events.find((event) => event.id === finals[0]!.auditEventId)).toMatchObject({
          action: 'permission.decision',
          actor: { kind: 'user', id: callerId },
          permissionDecisionId: finals[0]!.decisionId,
          requestId: request.approvalRequestId,
          threadId: source.threadId,
          turnId: request.raisingTurnId,
        });
        if (outcome === 'allow' || outcome === 'different-issuer') {
          expect(issued.status).toBe(200);
          const result = await issued.json();
          const grant = getVaultGrant(f.coreDb, result.grantId)!;
          expect(grant).toMatchObject({
            policyDecisionId: finals[0]!.decisionId,
            approvalId: request.approvalRequestId,
          });
          expect(finals[0]).toMatchObject({
            result: 'allow',
            reasonCode: 'granted',
            mediation: { kernel: { effect: 'allow' } },
          });
          expect(rows.filter((row) => row.mediation?.role === 'gate')).toHaveLength(1);
          expect(calls.filter((call) => call.binding.mode === 'observe')).toHaveLength(1);
          expect(events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                policyInvocation: expect.objectContaining({
                  operation: 'vault.grant-issue',
                  stage: 'completed',
                  mode: 'observe',
                  outcome: 'completed',
                }),
              }),
            ])
          );
          expect(
            f.coreDb.sqlite
              .prepare(
                "SELECT actor_json, request_id FROM audit_events WHERE action = 'vault.grant-issue'"
              )
              .all()
          ).toEqual([
            {
              actor_json: JSON.stringify({ kind: 'user', id: callerId }),
              request_id: request.approvalRequestId,
            },
          ]);
          expect((await f.sendAs(callerId, 'vault.grant-issue', input)).status).toBe(200);
          expect(listVaultGrants(f.coreDb)).toHaveLength(1);
          const after = db.sqlite
            .prepare('SELECT * FROM permission_decisions')
            .all()
            .map(readPermissionDecisionRowV1)
            .filter(
              (row) =>
                row.mediation?.operation === 'vault.grant-issue' && row.mediation.role === 'final'
            );
          expect(after).toEqual(finals);
        } else {
          expect(issued.status).toBeGreaterThanOrEqual(400);
          expect(listVaultGrants(f.coreDb)).toEqual([]);
          expect(calls.filter((call) => call.binding.mode === 'observe')).toEqual([]);
          if (outcome === 'deny')
            expect(finals[0]).toMatchObject({
              result: 'deny',
              mediation: { kernel: { effect: 'allow' } },
            });
          else expect(finals[0]!.result).not.toBe('allow');
        }
      } finally {
        db.sqlite.close();
      }
      const requestDb = openWorkspaceDb(f.dataRoot, source.workspaceId);
      try {
        expect(readPendingRequest(requestDb.sqlite, request.approvalRequestId)).toMatchObject({
          requestId: request.approvalRequestId,
          responsibleUserId: referenceOwner === 'user' ? f.owner.id : FIXTURE_LOCAL_USER_ID,
          decidingActor: { kind: 'user', id: deciderId },
          decidingActorContext: { kind: 'session', userId: deciderId },
        });
      } finally {
        requestDb.sqlite.close();
      }
      if (home === 'user') {
        const workspaceDb = openWorkspaceDb(f.dataRoot, source.workspaceId);
        try {
          expect(await readReviewedIssueDecisions(workspaceDb)).toEqual([]);
        } finally {
          workspaceDb.sqlite.close();
        }
      }
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });
});

// Vault Secret Injection, Reviewed User Login Sharing and Supported Grant Request And Review:
// one approved exact intent has one final issue authorizer, including during concurrent calls.
describe('reviewed grant issue concurrent approved-intent consumption', () => {
  it.each([
    'user',
    'workspace',
  ] as const)('retains one final allow for competing issues in the %s decision home', async (home) => {
    const f = await loginShareFixture();
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    const issues: Promise<Response>[] = [];
    try {
      const source =
        home === 'user' ? { ...f.command, terms: f.terms } : await prepare(f, 'workspace');
      const callerId = home === 'user' ? f.owner.id : f.admin.id;
      const raised =
        home === 'user'
          ? await f.sendAs(f.owner.id, 'vault.grant-request', {
              ...source,
              requestId: randomUUID(),
            })
          : await f.send('vault.grant-request', { ...source, requestId: randomUUID() });
      expect(raised.status).toBe(200);
      const request = await raised.json();
      expect(
        (await f.sendAs(callerId, 'approval.respond', decision(request, 'granted'))).status
      ).toBe(200);
      if (home === 'user') {
        // Two available uses keep a duplicate authorizer observable as consumption of two.
        await installLoginSharePolicy(f, callerId, 2);
      } else {
        await installReviewedIssueMediationPolicy(f, callerId, source.workspaceId, home);
      }
      f.participant.mockImplementation(async (input) => {
        if (input.binding.mode === 'observe') return { observed: true };
        return { decision: 'allow' };
      });
      const decide = f.interception.decide.bind(f.interception);
      let issueDecisions = 0;
      // Pause before real Policy evaluation. Do not spend its participant deadline
      // waiting for the competing public command and native acknowledgement.
      vi.spyOn(f.interception, 'decide').mockImplementation(async (policyInput) => {
        if (policyInput.proposal.operation === 'vault.grant-issue') {
          issueDecisions += 1;
          if (issueDecisions === 1) {
            signalFirstEntered();
            await firstHeld;
          }
        }
        return decide(policyInput);
      });
      const input = {
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        approvalRequestId: request.approvalRequestId,
      };
      const firstIssue = Promise.resolve(f.sendAs(callerId, 'vault.grant-issue', input));
      issues.push(firstIssue);
      await Promise.race([
        firstEntered,
        firstIssue.then(() => {
          throw new Error('The first issue completed before entering its required Policy gate.');
        }),
      ]);
      // Vault Secret Injection, Supported Grant Request And Review: the winning
      // single-use reservation precedes actual Policy interception and final authorization.
      const reservationDb = openWorkspaceDb(f.dataRoot, source.workspaceId);
      try {
        expect(readPendingRequest(reservationDb.sqlite, request.approvalRequestId)).toMatchObject({
          requestId: request.approvalRequestId,
          state: 'resolved',
          resolution: 'granted',
          claim: 'claimed',
          disposition: null,
        });
      } finally {
        reservationDb.sqlite.close();
      }
      const secondIssue = Promise.resolve(f.sendAs(callerId, 'vault.grant-issue', input));
      issues.push(secondIssue);
      const second = await secondIssue;
      releaseFirst();
      const first = await firstIssue;
      const succeeded = first.status === 200 ? first : second;
      expect(succeeded.status).toBe(200);
      const result = await succeeded.json();
      const grants = listVaultGrants(f.coreDb);
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        grantId: result.grantId,
        approvalId: request.approvalRequestId,
      });
      const { openUserDb } = await import('../storage/db.js');
      const { listUserPermissionDecisions, readPolicyStatementUseCount } = await import(
        '../policy/permission-decisions.js'
      );
      const db =
        home === 'user'
          ? openUserDb(f.dataRoot, callerId)
          : openWorkspaceDb(f.dataRoot, source.workspaceId);
      try {
        const rows =
          'userId' in db ? listUserPermissionDecisions(db) : await readReviewedIssueDecisions(db);
        const finalAllows = rows.filter(
          (row) =>
            row.approvalId === request.approvalRequestId &&
            row.mediation?.operation === 'vault.grant-issue' &&
            row.mediation.role === 'final' &&
            row.result === 'allow'
        );
        expect(finalAllows).toHaveLength(1);
        expect(grants[0]!.policyDecisionId).toBe(finalAllows[0]!.decisionId);
        if ('userId' in db) {
          const { readAdmittedPolicyDocument } = await import('../policy/configuration.js');
          const { policyDigest } = await import('../policy/statements.js');
          const statement = readAdmittedPolicyDocument(
            f.coreDb,
            f.manager.current().openKitConfig.policy?.mediation
          ).statements.find((row) => row.id === 'login-share-policy')!;
          // Core Policy, Delegated Goal Domain And Statement Lifetime: an allowing
          // decision consumes its finite use atomically; the losing issue adds none.
          expect(
            readPolicyStatementUseCount(db, { id: statement.id, digest: policyDigest(statement) })
          ).toBe(1);
        }
        expectLoginShareNoDelivery(f, [request, result, grants, finalAllows]);
      } finally {
        db.sqlite.close();
      }
      expect(first.status).toBe(200);
      expect(second.status).toBeGreaterThanOrEqual(400);
    } finally {
      releaseFirst();
      await Promise.allSettled(issues);
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });
});

// Reviewed User Login Sharing: preserve actual browser Session provenance through capture and native issue.
it('retains the real signup Session identity through Login request, approval and native grant authority', async () => {
  const f = await loginShareFixture();
  try {
    const { eq } = await import('drizzle-orm');
    const { actorFromSession } = await import('../auth/identity.js');
    const { session } = await import('../storage/schema/better-auth/index.js');
    const { openUserDb } = await import('../storage/db.js');
    const { createOperationInvocation } = await import('../operation-composition.js');
    // Select only the non-secret identity of the Session produced by real signup.
    const retainedSessions = f.coreDb.db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, f.owner.id))
      .all();
    expect(retainedSessions).toHaveLength(1);
    const sessionId = retainedSessions[0]!.id;
    const actor = actorFromSession({ session: { id: sessionId }, user: { id: f.owner.id } });
    expect(actor).toEqual({ kind: 'session', userId: f.owner.id, sessionId });
    const repositoryWorkspaceDb = (workspaceId: string) => openWorkspaceDb(f.dataRoot, workspaceId);
    const inflightCommands = new WeakMap();
    const invoke = createOperationInvocation({
      coreDb: f.coreDb,
      store: f.store,
      dataRoot: f.dataRoot,
      mode: 'server',
      vaultUnlockState: f.vaultUnlockState,
      runtimeConfigManager: f.manager,
      policyInterception: f.interception,
      repositoryWorkspaceDb,
      repositoryUserDb: (userId) => openUserDb(f.dataRoot, userId),
      inflightCommands,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      pendingRequestServices: {
        coreDb: f.coreDb,
        repositoryWorkspaceDb,
        inflightCommands,
      },
    });
    const context = { kind: 'public' as const, actor };
    // A real Session must cross request capture with its identity intact; no Session-free retry.
    const request = await invoke(
      'vault.grant-request',
      { ...f.command, terms: f.terms, requestId: randomUUID() },
      context
    );
    const readRecorded = () => {
      const db = repositoryWorkspaceDb(f.command.workspaceId);
      try {
        return readPendingRequest(db.sqlite, request.approvalRequestId);
      } finally {
        db.sqlite.close();
      }
    };
    expect(readRecorded()).toMatchObject({
      governedIntent: { origin: { kind: 'public', actor } },
      decidingActorContext: null,
    });
    await invoke('approval.respond', decision(request, 'granted'), context);
    expect(readRecorded()).toMatchObject({
      governedIntent: { origin: { kind: 'public', actor } },
      decidingActorContext: actor,
      decidingActor: { kind: 'user', id: f.owner.id },
    });
    // Observe the existing native boundary without replacing its implementation or acknowledgement.
    const native = vi.spyOn(getControlStoreWorkerClient(), 'vault');
    const issued = await invoke(
      'vault.grant-issue',
      { ...f.command, approvalRequestId: request.approvalRequestId },
      context
    );
    expect(issued).toMatchObject({ disposition: 'approved-executed', decidingActorId: f.owner.id });
    const submissions = native.mock.calls.filter(
      ([db, kind]) => db === f.coreDb && kind === 'reviewed-grant-issue'
    );
    expect(submissions).toHaveLength(1);
    expect(submissions[0]![2]).toMatchObject({
      authority: { issuer: actor, decider: actor, requester: { kind: 'public', actor } },
    });
    expect(readRecorded()).toMatchObject({
      governedIntent: { origin: { kind: 'public', actor } },
      decidingActorContext: actor,
      disposition: 'approved-executed',
    });
    expect(listVaultGrants(f.coreDb)).toHaveLength(1);
    expectLoginShareNoDelivery(f, [request, issued]);
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});
