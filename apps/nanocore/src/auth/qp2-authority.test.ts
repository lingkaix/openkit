import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as policyKernel from '@openkit/policy-kernel';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { closeTestCoreDb, createTestCoreDb, createTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './access-token-store.js';
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

/** Creates real identity, membership and history owners without direct storage setup. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-qp2-authority-'));
  const db = createTestCoreDb(root);
  fixtures.push({ root, db });
  ensureLocalUser(db);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Export authority');
  recordWorkspaceOwnerMembership({
    coreDb: db,
    workspaceId: workspace.id,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
  });
  await store.createThread(workspace.id, 'Shared history');
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
        name: 'Member',
        email: 'qp2-member@example.invalid',
        password: 'qp2-fixture-password-12345',
      }),
    })
  );
  expect(signup.status).toBe(200);
  const memberId: string = (await signup.json()).user.id;
  const member = session(memberId);
  const invitationResponse = await local.request(
    ...operationRequest(
      'workspace.invitation-create',
      {
        workspaceId: workspace.id,
        inviteeEmail: 'qp2-member@example.invalid',
      },
      { headers: { 'x-openkit-request-id': randomUUID() } }
    )
  );
  expect(invitationResponse.status).toBe(201);
  const { invitation } = await invitationResponse.json();
  const accepted = await member.request(
    ...operationRequest(
      'workspace.my-invitation-accept',
      {
        invitationId: invitation.invitationId,
        expectedRevision: invitation.revision,
      },
      { headers: { 'x-openkit-request-id': randomUUID() } }
    )
  );
  expect(accepted.status).toBe(200);
  return { root, db, store, workspace, local, session, member, memberId };
}

/** Reads exact exported row bytes, which are the analytical export's public content contract. */
function exportedRecords(root: string, workspaceId: string, exportId: string, name: string) {
  return readFileSync(
    join(root, 'server/exports/workspaces', workspaceId, exportId, 'records', name),
    'utf8'
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('QP-2a current authority', () => {
  it.each([
    'owner',
    'member',
  ] as const)('refuses an ordinary %s export even when all history is shared', async (role) => {
    const f = await fixture();
    const app = role === 'owner' ? f.session(FIXTURE_LOCAL_USER_ID) : f.member;
    const admitted = await app.request(
      ...operationRequest('workspace.dashboard', { workspaceId: f.workspace.id })
    );
    expect(admitted.status).toBe(200);
    expect(
      f.store.listThreads(f.workspace.id).every((thread) => thread.visibility === 'workspace')
    ).toBe(true);
    // Accepted QP-2 addendum: Workspace ownership and membership supply no export grant.
    const exported = await app.request(
      ...operationRequest('workspace.export', { workspaceId: f.workspace.id })
    );
    expect(exported.status).toBe(403);
  });

  it('requires the shared-only handle creator to remain an administrator at download', async () => {
    const f = await fixture();
    const token = createOpenKitAccessTokenRecord(f.db, {
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const creator = f.session(FIXTURE_LOCAL_USER_ID);
    const exported = await creator.request(
      ...operationRequest('workspace.export', { workspaceId: f.workspace.id })
    );
    expect(exported.status).toBe(200);
    const { exportId } = await exported.json();
    const archive = `/api/app/workspaces/${f.workspace.id}/exports/${exportId}/archive`;
    const before = await creator.request(archive);
    expect(before.status).toBe(200);
    expect((await before.arrayBuffer()).byteLength).toBeGreaterThan(0);
    createOpenKitAccessTokenRecord(f.db, {
      ownerUserId: f.memberId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    // Administrator eligibility does not replace the existing recorded-creator requirement.
    expect((await f.member.request(archive)).status).toBe(403);
    revokeOpenKitAccessTokenRecord(f.db, token.record.tokenId);
    const ownerStillEligible = await creator.request(
      ...operationRequest('workspace.dashboard', { workspaceId: f.workspace.id })
    );
    expect(ownerStillEligible.status).toBe(200);
    const after = await creator.request(archive);
    expect(after.status).toBe(403);
  });

  it('exports complete foreign private Item history under current administrator authority', async () => {
    const f = await fixture();
    const thread = await f.store.createThread(
      f.workspace.id,
      'Foreign private history',
      undefined,
      undefined,
      {
        visibility: 'private',
        privateOwnerUserId: f.memberId,
      }
    );
    const turn = await f.store.createTurn(f.workspace.id, thread.id, 'Private export source', {
      kind: 'user',
      id: f.memberId,
    });
    const instant = '2026-10-27T00:00:00.000Z';
    const item = await f.store.createItem({
      id: allocateEntityId('it'),
      type: 'assistant-message',
      owner: { kind: 'workspace', workspaceId: f.workspace.id },
      threadId: thread.id,
      turnId: turn.id,
      text: 'Private original café',
      status: 'completed',
      createdAt: instant,
      completedAt: instant,
    });
    await f.store.updateItem(item.id, { text: 'Private revised café' });
    const exported = await f.local.request(
      ...operationRequest('workspace.export', { workspaceId: f.workspace.id })
    );
    expect(exported.status).toBe(200);
    const { exportId } = await exported.json();
    const threads = exportedRecords(f.root, f.workspace.id, exportId, 'threads.jsonl');
    expect(threads).toContainEqual(
      expect.objectContaining({
        id: thread.id,
        visibility: 'private',
        privateOwnerUserId: f.memberId,
      })
    );
    const revisions = exportedRecords(f.root, f.workspace.id, exportId, 'item-revisions.jsonl');
    expect(revisions.filter((row) => row.id === item.id).map((row) => row.text)).toEqual([
      'Private original café',
      'Private revised café',
    ]);
    const downloaded = await f.local.request(
      `/api/app/workspaces/${f.workspace.id}/exports/${exportId}/archive`
    );
    expect(downloaded.status).toBe(200);
    expect((await downloaded.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('projects the real current User into the Workspace Kernel decision', async () => {
    const f = await fixture();
    // The existing public Kernel call is the observation channel; its real implementation stays active.
    const captured = vi.spyOn(policyKernel, 'evaluateAccess');
    const response = await f.member.request(
      ...operationRequest('workspace.dashboard', { workspaceId: f.workspace.id })
    );
    expect(response.status).toBe(200);
    const decisions = captured.mock.calls.filter(
      ([, request]) => request.operation === 'workspace.read'
    );
    expect(decisions.length).toBeGreaterThan(0);
    // Core Policy Subject requires the actual principal for this direct human call.
    expect(decisions.every(([, request]) => request.user.includes(f.memberId))).toBe(true);
  });
});
