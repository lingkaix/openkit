import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as policyKernel from '@openkit/policy-kernel';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkspaceResourceCatalog } from '../catalog/resource-catalog.js';
import * as productAccess from '../policy/workspace-access.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { createApp, createTestSessionActor } from '../test-support/app.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createPendingRequestFixture } from '../test-support/pending-request.js';
import { closeTestCoreDb, createTestCoreDb, createTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import * as tokenStore from './access-token-store.js';
import { createBetterAuth } from './better-auth.js';

const fixtures: Array<{ root: string; db: ReturnType<typeof createTestCoreDb> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const { root, db } of fixtures.splice(0)) {
    closeTestCoreDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

/** Builds current identities through their owners, with an invitee who has no Workspace membership. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-qp2-inline-'));
  const db = createTestCoreDb(root);
  fixtures.push({ root, db });
  ensureLocalUser(db);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Inline authority');
  recordWorkspaceOwnerMembership({
    coreDb: db,
    workspaceId: workspace.id,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
  });
  const local = createApp({ dataRoot: root, coreDb: db, store });
  const session = (userId: string) =>
    createApp({
      dataRoot: root,
      coreDb: db,
      store,
      mode: 'server',
      auth: {
        api: { getSession: async () => ({ user: { id: userId } }) },
        handler: async () => Response.json({ status: 'auth-ok' }),
      },
    });
  const auth = createBetterAuth(db, { env: { PORT: '3000' } });
  const signup = await auth.handler(
    new Request('http://127.0.0.1:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Invitee',
        email: 'inline-invitee@example.invalid',
        password: 'inline-fixture-password-12345',
      }),
    })
  );
  expect(signup.status).toBe(200);
  const inviteeId: string = (await signup.json()).user.id;
  const admin = tokenStore.createOpenKitAccessTokenRecord(db, {
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const invite = async () => {
    const response = await local.request(
      ...operationRequest(
        'workspace.invitation-create',
        {
          workspaceId: workspace.id,
          inviteeEmail: 'inline-invitee@example.invalid',
        },
        { headers: { 'x-openkit-request-id': randomUUID() } }
      )
    );
    expect(response.status).toBe(201);
    return (await response.json()).invitation as { invitationId: string; revision: number };
  };
  return { root, db, store, workspace, local, session, inviteeId, admin, invite };
}

/** Removes only the concrete operation's required grants while keeping the real Kernel evaluator active. */
function removeOperationGrants(operation: string, serverOnly = false) {
  const actualEvaluate = policyKernel.evaluateAccess;
  const actualProduct = productAccess.evaluateProductAccess;
  let serverTarget = false;
  if (serverOnly)
    vi.spyOn(productAccess, 'evaluateProductAccess').mockImplementation((input) => {
      const previous = serverTarget;
      serverTarget = input.target.kind === 'server';
      try {
        return actualProduct(input);
      } finally {
        serverTarget = previous;
      }
    });
  return vi.spyOn(policyKernel, 'evaluateAccess').mockImplementation((policy, request) => {
    if (request.operation !== operation || (serverOnly && !serverTarget))
      return actualEvaluate(policy, request);
    const rights = new Set(policy.operations.find((entry) => entry.id === operation)?.accessRights);
    return actualEvaluate(
      {
        ...policy,
        associations: policy.associations.map((association) => ({
          ...association,
          accessRights: association.accessRights.filter((right) => !rights.has(right)),
        })),
      },
      request
    );
  });
}

describe('QP-2c remaining inline authority', () => {
  it('rechecks the authenticated diagnostics administrator after selected Token revocation', async () => {
    const f = await fixture();
    const app = f.session(FIXTURE_LOCAL_USER_ID);
    expect((await app.request('/api/diagnostics')).status).toBe(200);
    const actualResolve = tokenStore.resolveSessionDeploymentAdminTokenId;
    vi.spyOn(tokenStore, 'resolveSessionDeploymentAdminTokenId').mockImplementation((...args) => {
      const selected = actualResolve(...args);
      if (selected) tokenStore.revokeOpenKitAccessTokenRecord(f.db, selected);
      return selected;
    });
    // Core Policy: revocation blocks release even after authentication produced an administrator projection.
    const denied = await app.request('/api/diagnostics');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'diagnostics_admin_forbidden' });
  });

  it.each([
    'invitee',
    'administrator',
  ] as const)('requires invitation.respond for a valid %s without adding membership', async (actor) => {
    const f = await fixture();
    const app = f.session(actor === 'invitee' ? f.inviteeId : FIXTURE_LOCAL_USER_ID);
    const first = await f.invite();
    const declined = await app.request(
      ...operationRequest(
        'workspace.my-invitation-decline',
        {
          invitationId: first.invitationId,
          expectedRevision: first.revision,
        },
        { headers: { 'x-openkit-request-id': randomUUID() } }
      )
    );
    expect(declined.status).toBe(200);
    const pending = await f.invite();
    const fault = removeOperationGrants('invitation.respond');
    const denied = await app.request(
      ...operationRequest(
        'workspace.my-invitation-accept',
        {
          invitationId: pending.invitationId,
          expectedRevision: pending.revision,
        },
        { headers: { 'x-openkit-request-id': randomUUID() } }
      )
    );
    // Multi-user Workspace: identity eligibility does not bypass the concrete invitation Kernel decision.
    expect(denied.status).toBe(403);
    fault.mockRestore();
    const accepted = await app.request(
      ...operationRequest(
        'workspace.my-invitation-accept',
        {
          invitationId: pending.invitationId,
          expectedRevision: pending.revision,
        },
        { headers: { 'x-openkit-request-id': randomUUID() } }
      )
    );
    expect(accepted.status).toBe(200);
  });

  it('requires approval.respond before a current administrator can resolve another human request', async () => {
    const f = await fixture();
    const thread = await f.store.createThread(f.workspace.id, 'Human approval');
    const turn = await f.store.createTurn(f.workspace.id, thread.id, 'Human decision', {
      kind: 'user',
      id: f.inviteeId,
    });
    const pendingRequests = createPendingRequestFixture({
      coreDb: f.db,
      store: f.store,
      workspaceId: f.workspace.id,
    });
    try {
      const raise = async () => {
        const requestId = randomUUID();
        const requestItemId = allocateEntityId('it');
        const now = new Date().toISOString();
        await f.store.createItem({
          id: requestItemId,
          owner: turn.owner,
          threadId: thread.id,
          turnId: turn.id,
          type: 'approval-request',
          approvalRequestId: requestId,
          kind: 'permission',
          title: 'Human decision',
          description: 'Decide this exact request.',
          status: 'completed',
          createdAt: now,
          completedAt: now,
        });
        return pendingRequests.raise({
          requestId,
          requestItemId,
          workspaceId: f.workspace.id,
          threadId: thread.id,
          raisingTurnId: turn.id,
          kind: 'approval',
          requesterKind: 'person',
          responsibleUserId: f.inviteeId,
          governedIntent: { operation: 'fixture' },
          approval: {
            kind: 'permission',
            title: 'Human decision',
            description: 'Decide this exact request.',
          },
          now,
        });
      };
      const respond = (record: Awaited<ReturnType<typeof raise>>) =>
        pendingRequests.resolveCommandIntentApproval({
          record,
          decision: 'denied',
          actor: createTestSessionActor(f.db, FIXTURE_LOCAL_USER_ID),
        });
      expect(await respond(await raise())).toMatchObject({ resolution: 'denied' });
      const pending = await raise();
      removeOperationGrants('approval.respond');
      // Core Policy: administrator eligibility still requires the primary Kernel decision; human workflow stays owned here.
      await expect(respond(pending)).rejects.toMatchObject({
        code: 'workspace_access_denied',
        status: 403,
      });
      expect(pendingRequests.read(pending.requestId)).toMatchObject({
        state: 'pending',
        claim: 'unclaimed',
        resolution: null,
      });
    } finally {
      pendingRequests.close();
    }
  });

  it('requires Server workspace.configure for stdio activation while Workspace configuration remains allowed', async () => {
    const f = await fixture();
    const app = f.session(FIXTURE_LOCAL_USER_ID);
    const createRequestId = randomUUID();
    const created = await app.request(
      ...operationRequest(
        'catalog.mcp-create',
        {
          workspaceId: f.workspace.id,
          id: 'host',
          displayName: 'Host',
          allowedTools: ['echo'],
          declaration: { kind: 'stdio', command: '/usr/bin/true', args: [] },
          expectedRevision: 0,
          requestId: createRequestId,
        },
        { headers: { 'x-openkit-request-id': createRequestId } }
      )
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const binding = async (enabled: boolean) => {
      const catalog = loadWorkspaceResourceCatalog(f.root, f.workspace.id);
      const requestId = randomUUID();
      return app.request(
        ...operationRequest(
          'catalog.mcp-binding',
          {
            workspaceId: f.workspace.id,
            mcpId: 'host',
            enabled,
            allowedTools: ['echo'],
            bindingRevision: catalog.mcp.bindings[0]!.revision,
            schemaPolicy: 'tracking',
            expectedRevision: catalog.revision,
            requestId,
          },
          { headers: { 'x-openkit-request-id': requestId } }
        )
      );
    };
    expect((await binding(true)).status).toBe(200);
    removeOperationGrants('workspace.configure', true);
    // Ordinary Workspace mutation remains eligible; disabling does not activate host code.
    expect((await binding(false)).status).toBe(200);
    const before = loadWorkspaceResourceCatalog(f.root, f.workspace.id);
    const denied = await binding(true);
    // Core Policy Technical Administration: Workspace configuration cannot grant Server host-code activation.
    expect(denied.status).toBe(403);
    expect(loadWorkspaceResourceCatalog(f.root, f.workspace.id)).toEqual(before);
  });
});
