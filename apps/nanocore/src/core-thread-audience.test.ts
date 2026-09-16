import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { FsStore } from './lib/store.js';
import { createPolicyApprovalGate } from './policy/approval-gates.js';
import { feedbackFilePath, readTurnFeedback } from './runtime/feedback.js';
import { listGitPushRecords } from './runtime/git-push-records.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const STAMP = '2026-09-14T00:00:00.000Z';
const TOKEN_EXPIRY = '2999-01-01T00:00:00.000Z';

type MemberActor = {
  readonly scope: 'workspace' | 'workspace-readonly' | 'server-admin';
  readonly userId: 'user_local' | 'user_other';
};

const READ_ACTORS: readonly MemberActor[] = [
  { scope: 'workspace-readonly', userId: 'user_local' },
  { scope: 'workspace-readonly', userId: 'user_other' },
  { scope: 'server-admin', userId: 'user_local' },
];

/**
 * Builds the dashboard CoreDb fixture with two active members, including the owner as server-admin.
 *
 * @returns Server-mode app, own/other private Threads, shared Thread, and mutation owners.
 */
function createCoreAudienceFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-audience-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Team');
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'user_local',
    workspaceId: workspace.id,
  });
  const now = Date.now();
  coreDb.sqlite
    .prepare(
      `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at) VALUES ('user_other', 'Other', 'other@example.invalid', false, ?, ?, 'human', 'active', NULL)`
    )
    .run(now, now);
  coreDb.sqlite
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, status, access_level, invitation_id, joined_at, removed_at, revision, created_at, updated_at) VALUES (?, 'user_other', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
    )
    .run(workspace.id, STAMP, STAMP, STAMP);
  const own = assignAudience(
    store.createThread(workspace.id, 'local-private needle'),
    'private',
    'user_local'
  );
  const denied = assignAudience(
    store.createThread(workspace.id, 'other-private needle'),
    'private',
    'user_other'
  );
  const shared = assignAudience(store.createThread(workspace.id, 'shared needle'), 'workspace');
  const ownTurn = seedCompletedSurface(store, workspace.id, own, 'local-private');
  const deniedTurn = seedCompletedSurface(store, workspace.id, denied, 'other-private');
  const sharedTurn = seedCompletedSurface(store, workspace.id, shared, 'shared');
  const approvalTurn = store.createTurn(workspace.id, own.id, 'Approve private push', {
    kind: 'user',
    id: 'user_local',
  });
  const deniedApprovalTurn = store.createTurn(
    workspace.id,
    denied.id,
    'Approve other private push',
    {
      kind: 'user',
      id: 'user_other',
    }
  );
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  const gate = createPolicyApprovalGate({
    action: 'repo.push',
    approvalId: 'ap_local_private',
    approvalItemId: 'it_ap_local_private',
    decisionId: 'pd_local_private',
    description: 'Approve a private-thread push.',
    reasonCode: 'repo_push_approval_required',
    resourceSummary: { action: 'repo.push' },
    store,
    subjectSummary: { kind: 'test' },
    title: 'Approve private push',
    turnId: approvalTurn.id,
    workspaceDb,
    workspaceId: workspace.id,
  });
  const deniedGate = createPolicyApprovalGate({
    action: 'repo.push',
    approvalId: 'ap_other_private',
    approvalItemId: 'it_ap_other_private',
    decisionId: 'pd_other_private',
    description: 'Approve the other private-thread push.',
    reasonCode: 'repo_push_approval_required',
    resourceSummary: { action: 'repo.push' },
    store,
    subjectSummary: { kind: 'test' },
    title: 'Approve other private push',
    turnId: deniedApprovalTurn.id,
    workspaceDb,
    workspaceId: workspace.id,
  });
  workspaceDb.sqlite.close();
  coreDb.sqlite
    .prepare(
      `INSERT INTO scheduler_session_leases (
         lease_id, plan_id, workspace_id, thread_id, turn_id, agent_session_id,
         package_snapshot_id, pool_id, target_id, status, acquired_at, expires_at,
         heartbeat_deadline, startup_deadline, renewal_count, scheduler_epoch,
         sandbox_binding_ref, backend_anchor_state
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'acquired', ?, ?, ?, ?, 0, 1, ?, 'unanchored')`
    )
    .run(
      `lease_${approvalTurn.id}`,
      `plan_${approvalTurn.id}`,
      workspace.id,
      own.id,
      approvalTurn.id,
      `as_${approvalTurn.id}`,
      `pkg_${approvalTurn.id}`,
      `pool_${approvalTurn.id}`,
      `target_${approvalTurn.id}`,
      STAMP,
      TOKEN_EXPIRY,
      TOKEN_EXPIRY,
      TOKEN_EXPIRY,
      `binding_${approvalTurn.id}`
    );
  const app = createApp({
    auth: {
      api: { getSession: async () => null },
      handler: async () => new Response(null, { status: 404 }),
    },
    coreDb,
    dataRoot,
    mode: 'server',
    store,
  });
  return {
    app,
    approvalTurn,
    close: () => {
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    },
    coreDb,
    denied,
    deniedApprovalTurn,
    deniedGate,
    deniedTurn,
    gate,
    own,
    ownTurn,
    shared,
    sharedTurn,
    store,
    workspace,
  };
}

type AudienceFixture = ReturnType<typeof createCoreAudienceFixture>;

/**
 * Overwrites durable audience fields the same way the dashboard visibility fixture does.
 *
 * @param thread Thread record already inserted by the store.
 * @param visibility Requested audience.
 * @param privateOwnerUserId Private owner when visibility is private.
 * @returns The mutated Thread record.
 */
function assignAudience(
  thread: ReturnType<FsStore['createThread']>,
  visibility: 'private' | 'workspace',
  privateOwnerUserId?: string
): ReturnType<FsStore['createThread']> {
  const raw = thread as unknown as Record<string, unknown>;
  delete raw.privateOwnerUserId;
  if (visibility === 'private') {
    Object.assign(raw, { privateOwnerUserId, visibility: 'private' });
  } else {
    Object.assign(raw, { visibility: 'workspace' });
  }
  return thread;
}

/**
 * Creates one completed Turn, Item, and retained event stream for HTTP read surfaces.
 *
 * @param store Product store receiving the surface.
 * @param workspaceId Workspace that owns the Thread.
 * @param thread Thread that should receive the completed work.
 * @param label Unique needle used in names and payloads.
 * @returns The completed Turn.
 */
function seedCompletedSurface(
  store: FsStore,
  workspaceId: string,
  thread: ReturnType<FsStore['createThread']>,
  label: string
): ReturnType<FsStore['createTurn']> {
  const turn = store.createTurn(workspaceId, thread.id, `${label} needle`, {
    kind: 'user',
    id: 'user_local',
  });
  store.createItem({
    completedAt: STAMP,
    createdAt: STAMP,
    id: `it_${label}`,
    status: 'completed',
    text: `${label} needle content`,
    threadId: thread.id,
    turnId: turn.id,
    type: 'assistant-message',
    workspaceId,
  });
  store.emitTurnEvent(turn.id, {
    data: { status: 'running', turnId: turn.id, type: 'turn-started' },
    event: 'turn.started',
    threadId: thread.id,
    turnId: turn.id,
    workspaceId,
  });
  store.emitTurnEvent(turn.id, {
    data: {
      delta: `${label} needle content`,
      deltaKind: 'text-delta',
      itemId: `it_${label}`,
      itemType: 'assistant-message',
      type: 'item-delta',
    },
    event: 'item.delta',
    threadId: thread.id,
    turnId: turn.id,
    workspaceId,
  });
  const completed = store.updateTurn(turn.id, { completedAt: STAMP, status: 'completed' });
  store.emitTurnEvent(turn.id, {
    data: { stopReason: 'completed', turn: completed, type: 'turn-completed' },
    event: 'turn.completed',
    threadId: thread.id,
    turnId: turn.id,
    workspaceId,
  });
  return completed;
}

/**
 * Issues a Bearer header for one CoreDb access token.
 *
 * @param coreDb Core database that owns the token record.
 * @param actor Authenticated member actor.
 * @param workspaceId Workspace bound to workspace-scoped tokens.
 * @returns Authorization header map.
 */
function bearer(
  coreDb: ReturnType<typeof openCoreDb>,
  actor: MemberActor,
  workspaceId: string
): { authorization: string } {
  const token = createOpenKitAccessTokenRecord(coreDb, {
    expiresAt: TOKEN_EXPIRY,
    ownerUserId: actor.userId,
    scope: actor.scope,
    workspaceIds: actor.scope === 'server-admin' ? [] : [workspaceId],
  });
  return { authorization: `Bearer ${token.secret}` };
}

/**
 * Resolves the actor's own private Thread and the other member's private Thread.
 *
 * @param fixture Active audience fixture.
 * @param userId Current member.
 * @returns Own and other-private Thread/Turn pair.
 */
function audienceFor(fixture: AudienceFixture, userId: MemberActor['userId']) {
  return userId === 'user_local'
    ? {
        denied: fixture.denied,
        deniedTurn: fixture.deniedTurn,
        own: fixture.own,
        ownTurn: fixture.ownTurn,
      }
    : {
        denied: fixture.own,
        deniedTurn: fixture.ownTurn,
        own: fixture.denied,
        ownTurn: fixture.deniedTurn,
      };
}

/**
 * Asserts the central hidden-or-missing Thread guard: 404 `not_found` with no private needles.
 *
 * @param response HTTP response under test.
 * @param secrets Private strings that must stay absent from the error body.
 */
async function expectNondisclosing404(
  response: Response,
  secrets: readonly string[]
): Promise<void> {
  const text = await response.text();
  expect(response.status, text).toBe(404);
  expect(JSON.parse(text)).toMatchObject({ code: 'not_found', message: 'Thread not found.' });
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
}

describe('core Thread audience', () => {
  it('requires CoreDb server auth instead of the local implicit actor', async () => {
    const fixture = createCoreAudienceFixture();
    try {
      const response = await fixture.app.request(
        `/api/workspaces/${fixture.workspace.id}/threads/${fixture.own.id}`
      );
      expect(response.status).toBe(401);
    } finally {
      fixture.close();
    }
  });

  it('admits own and shared Thread GET and list while denying the other member private Thread', async () => {
    const fixture = createCoreAudienceFixture();
    try {
      for (const actor of READ_ACTORS) {
        const headers = bearer(fixture.coreDb, actor, fixture.workspace.id);
        const { denied, own } = audienceFor(fixture, actor.userId);
        const ownRes = await fixture.app.request(
          `/api/workspaces/${fixture.workspace.id}/threads/${own.id}`,
          { headers }
        );
        expect(ownRes.status, await ownRes.clone().text()).toBe(200);
        expect(await ownRes.json()).toMatchObject({ id: own.id, name: own.name });
        const sharedRes = await fixture.app.request(
          `/api/workspaces/${fixture.workspace.id}/threads/${fixture.shared.id}`,
          { headers }
        );
        expect(sharedRes.status, await sharedRes.clone().text()).toBe(200);
        expect(await sharedRes.json()).toMatchObject({ id: fixture.shared.id });
        await expectNondisclosing404(
          await fixture.app.request(
            `/api/workspaces/${fixture.workspace.id}/threads/${denied.id}`,
            {
              headers,
            }
          ),
          [denied.name as string]
        );
        const listRes = await fixture.app.request(
          `/api/workspaces/${fixture.workspace.id}/threads`,
          {
            headers,
          }
        );
        const listText = await listRes.text();
        expect(listRes.status, listText).toBe(200);
        const list = JSON.parse(listText) as { items: Array<{ id: string }> };
        expect(list.items.map((thread) => thread.id).sort()).toEqual(
          [own.id, fixture.shared.id].sort()
        );
        expect(listText).not.toContain(denied.name);
      }
    } finally {
      fixture.close();
    }
  });

  it('admits own and shared Turn, items, and conversation.targets for current members', async () => {
    const fixture = createCoreAudienceFixture();
    try {
      for (const actor of READ_ACTORS) {
        const headers = bearer(fixture.coreDb, actor, fixture.workspace.id);
        const { own, ownTurn } = audienceFor(fixture, actor.userId);
        const rows = [
          [own, ownTurn],
          [fixture.shared, fixture.sharedTurn],
        ] as const;
        for (const [thread, turn] of rows) {
          const paths = [
            `/api/workspaces/${fixture.workspace.id}/threads/${thread.id}/turns/${turn.id}`,
            `/api/app/workspaces/${fixture.workspace.id}/threads/${thread.id}/items`,
            `/api/app/workspaces/${fixture.workspace.id}/conversation-targets?threadId=${thread.id}`,
          ];
          for (const path of paths) {
            const response = await fixture.app.request(path, { headers });
            expect(response.status, await response.clone().text()).toBe(200);
          }
        }
      }
    } finally {
      fixture.close();
    }
  });

  it('refuses another member private Turn, items, and conversation.targets without disclosing titles', async () => {
    const fixture = createCoreAudienceFixture();
    try {
      for (const actor of READ_ACTORS) {
        const headers = bearer(fixture.coreDb, actor, fixture.workspace.id);
        const { denied, deniedTurn } = audienceFor(fixture, actor.userId);
        const secrets = [denied.name as string, `${denied.name?.slice(0, -7)} needle content`];
        const paths = [
          `/api/workspaces/${fixture.workspace.id}/threads/${denied.id}/turns/${deniedTurn.id}`,
          `/api/app/workspaces/${fixture.workspace.id}/threads/${denied.id}/items`,
          `/api/app/workspaces/${fixture.workspace.id}/conversation-targets?threadId=${denied.id}`,
        ];
        for (const path of paths) {
          await expectNondisclosing404(await fixture.app.request(path, { headers }), secrets);
        }
      }
    } finally {
      fixture.close();
    }
  });

  it('rejects submitTurnInput, feedback, and approval on another private Thread without effects', async () => {
    const fixture = createCoreAudienceFixture();
    try {
      const member = bearer(
        fixture.coreDb,
        { scope: 'workspace', userId: 'user_other' },
        fixture.workspace.id
      );
      const admin = bearer(
        fixture.coreDb,
        { scope: 'server-admin', userId: 'user_local' },
        fixture.workspace.id
      );
      const memberTurnsBefore = fixture.store.listThreadTurns(
        fixture.workspace.id,
        fixture.own.id
      ).length;
      const adminTurnsBefore = fixture.store.listThreadTurns(
        fixture.workspace.id,
        fixture.denied.id
      ).length;
      const mutations = [
        {
          after: () =>
            expect(
              fixture.store.listThreadTurns(fixture.workspace.id, fixture.own.id)
            ).toHaveLength(memberTurnsBefore),
          headers: member,
          init: {
            body: JSON.stringify({
              input: 'start-turn-secret',
              requestId: '11111111-1111-4111-8111-111111111202',
              threadId: fixture.own.id,
              workspaceId: fixture.workspace.id,
            }),
            method: 'POST' as const,
          },
          path: '/api/turns',
          secrets: ['start-turn-secret', 'local-private needle'],
        },
        {
          after: () =>
            expect(
              fixture.store.listThreadTurns(fixture.workspace.id, fixture.denied.id)
            ).toHaveLength(adminTurnsBefore),
          headers: admin,
          init: {
            body: JSON.stringify({
              input: 'start-turn-secret',
              requestId: '11111111-1111-4111-8111-111111111203',
              threadId: fixture.denied.id,
              workspaceId: fixture.workspace.id,
            }),
            method: 'POST' as const,
          },
          path: '/api/turns',
          secrets: ['start-turn-secret', 'other-private needle'],
        },
        {
          after: () => {
            if (existsSync(feedbackFilePath(fixture.store, fixture.ownTurn))) {
              expect(readTurnFeedback(fixture.store, fixture.ownTurn.id)).toMatchObject({
                note: null,
                rating: null,
              });
            }
          },
          headers: member,
          init: {
            body: JSON.stringify({ note: 'feedback-secret', rating: 'good' }),
            method: 'POST' as const,
          },
          path: `/api/turns/${fixture.ownTurn.id}/feedback`,
          secrets: ['feedback-secret', 'local-private needle'],
        },
        {
          after: () => {
            if (existsSync(feedbackFilePath(fixture.store, fixture.deniedTurn))) {
              expect(readTurnFeedback(fixture.store, fixture.deniedTurn.id)).toMatchObject({
                note: null,
                rating: null,
              });
            }
          },
          headers: admin,
          init: {
            body: JSON.stringify({ note: 'feedback-secret', rating: 'good' }),
            method: 'POST' as const,
          },
          path: `/api/turns/${fixture.deniedTurn.id}/feedback`,
          secrets: ['feedback-secret', 'other-private needle'],
        },
        {
          after: () => {
            expect(fixture.store.getApproval(fixture.gate.approvalId).status).toBe('pending');
            expect(fixture.store.getTurnById(fixture.approvalTurn.id).status).toBe(
              'awaiting_human'
            );
          },
          headers: member,
          init: {
            body: JSON.stringify({
              decision: 'granted',
              requestId: '11111111-1111-4111-8111-111111111204',
              threadId: fixture.own.id,
              turnId: fixture.approvalTurn.id,
              workspaceId: fixture.workspace.id,
            }),
            method: 'POST' as const,
          },
          path: `/api/approvals/${fixture.gate.approvalId}/respond`,
          secrets: ['local-private needle', 'Approve private push'],
        },
      ];
      for (const row of mutations) {
        await expectNondisclosing404(
          await fixture.app.request(row.path, {
            ...row.init,
            headers: { ...row.headers, 'content-type': 'application/json' },
          }),
          row.secrets
        );
        row.after();
      }
    } finally {
      fixture.close();
    }
  });

  it('refuses git-push approval body Turn and execute approvalId Thread as missing or hidden without effects', async () => {
    const fixture = createCoreAudienceFixture();
    try {
      const member = bearer(
        fixture.coreDb,
        { scope: 'workspace', userId: 'user_other' },
        fixture.workspace.id
      );
      const admin = bearer(
        fixture.coreDb,
        { scope: 'server-admin', userId: 'user_local' },
        fixture.workspace.id
      );
      const approvalPath = `/api/app/workspaces/${fixture.workspace.id}/repositories/repo_audience/git-push/approval`;
      const executePath = `/api/app/workspaces/${fixture.workspace.id}/repositories/repo_audience/git-push`;
      const approvalItemCount = (threadId: string) =>
        fixture.store
          .listThreadItems(fixture.workspace.id, threadId)
          .filter((item) => item.type === 'approval-request').length;
      const foreignWorkspace = fixture.store.createWorkspace('Foreign approval Workspace');
      const foreignApproval = fixture.store.createApproval({
        ...fixture.store.getApproval(fixture.gate.approvalId),
        id: 'ap_foreign_workspace_visible_thread',
        workspaceId: foreignWorkspace.id,
        threadId: fixture.shared.id,
        turnId: fixture.sharedTurn.id,
      });
      const ownApprovalItems = approvalItemCount(fixture.own.id);
      const deniedApprovalItems = approvalItemCount(fixture.denied.id);
      const rows = [
        {
          after: () => expect(approvalItemCount(fixture.own.id)).toBe(ownApprovalItems),
          headers: member,
          init: {
            body: JSON.stringify({
              commitIds: ['deadbeef'],
              requestId: '11111111-1111-4111-8111-111111111301',
              sourceRef: 'HEAD',
              targetBranch: 'main',
              threadId: fixture.own.id,
              turnId: fixture.ownTurn.id,
            }),
            method: 'POST' as const,
          },
          path: approvalPath,
          secrets: ['local-private needle'],
        },
        {
          after: () => expect(approvalItemCount(fixture.denied.id)).toBe(deniedApprovalItems),
          headers: admin,
          init: {
            body: JSON.stringify({
              commitIds: ['deadbeef'],
              requestId: '11111111-1111-4111-8111-111111111302',
              sourceRef: 'HEAD',
              targetBranch: 'main',
              threadId: fixture.denied.id,
              turnId: fixture.deniedTurn.id,
            }),
            method: 'POST' as const,
          },
          path: approvalPath,
          secrets: ['other-private needle'],
        },
        {
          after: () => expect(approvalItemCount(fixture.own.id)).toBe(ownApprovalItems),
          headers: member,
          init: {
            body: JSON.stringify({
              commitIds: ['deadbeef'],
              requestId: '11111111-1111-4111-8111-111111111303',
              sourceRef: 'HEAD',
              targetBranch: 'main',
              threadId: 'th_missing_audience',
              turnId: 'tu_missing_audience',
            }),
            method: 'POST' as const,
          },
          path: approvalPath,
          secrets: ['local-private needle', 'other-private needle'],
        },
        {
          after: () => {
            expect(fixture.store.getApproval(fixture.gate.approvalId).status).toBe('pending');
            expect(fixture.store.getTurnById(fixture.approvalTurn.id).status).toBe(
              'awaiting_human'
            );
          },
          headers: member,
          init: {
            body: JSON.stringify({
              approvalRequestId: fixture.gate.approvalId,
              requestId: '11111111-1111-4111-8111-111111111304',
            }),
            method: 'POST' as const,
          },
          path: executePath,
          secrets: ['local-private needle', 'Approve private push'],
        },
        {
          after: () => {
            expect(fixture.store.getApproval(fixture.deniedGate.approvalId).status).toBe('pending');
            expect(fixture.store.getTurnById(fixture.deniedApprovalTurn.id).status).toBe(
              'awaiting_human'
            );
          },
          headers: admin,
          init: {
            body: JSON.stringify({
              approvalRequestId: fixture.deniedGate.approvalId,
              requestId: '11111111-1111-4111-8111-111111111305',
            }),
            method: 'POST' as const,
          },
          path: executePath,
          secrets: ['other-private needle', 'Approve other private push'],
        },
        {
          after: () =>
            expect(fixture.store.getApproval(fixture.gate.approvalId).status).toBe('pending'),
          headers: admin,
          init: {
            body: JSON.stringify({
              approvalRequestId: 'ap_missing_audience',
              requestId: '11111111-1111-4111-8111-111111111306',
            }),
            method: 'POST' as const,
          },
          path: executePath,
          secrets: ['local-private needle', 'other-private needle'],
        },
      ];
      for (const row of rows) {
        await expectNondisclosing404(
          await fixture.app.request(row.path, {
            ...row.init,
            headers: { ...row.headers, 'content-type': 'application/json' },
          }),
          row.secrets
        );
        row.after();
      }
      for (const headers of [member, admin]) {
        await expectNondisclosing404(
          await fixture.app.request(executePath, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
              approvalRequestId: foreignApproval.id,
              requestId: '11111111-1111-4111-8111-111111111307',
            }),
          }),
          ['Foreign approval Workspace', 'Approve private push']
        );
        expect(fixture.store.getApproval(foreignApproval.id).status).toBe('pending');
      }
      const workspaceDb = openWorkspaceDb(fixture.store.getDataRoot() ?? '', fixture.workspace.id);
      try {
        expect(listGitPushRecords(workspaceDb, fixture.workspace.id)).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      fixture.close();
    }
  });

  it('replays own thread.create requestId and does not return another actor private Thread', async () => {
    const fixture = createCoreAudienceFixture();
    try {
      const owner = bearer(
        fixture.coreDb,
        { scope: 'workspace', userId: 'user_local' },
        fixture.workspace.id
      );
      const other = bearer(
        fixture.coreDb,
        { scope: 'workspace', userId: 'user_other' },
        fixture.workspace.id
      );
      const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const created = await fixture.app.request(`/api/workspaces/${fixture.workspace.id}/threads`, {
        body: JSON.stringify({ name: 'Owner private create', requestId, visibility: 'private' }),
        headers: { ...owner, 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(created.status, await created.clone().text()).toBe(201);
      const createdThread = (await created.json()) as { id: string; name: string | null };
      const replay = await fixture.app.request(`/api/workspaces/${fixture.workspace.id}/threads`, {
        body: JSON.stringify({ name: 'Owner private create', requestId, visibility: 'private' }),
        headers: { ...owner, 'content-type': 'application/json' },
        method: 'POST',
      });
      expect([200, 201]).toContain(replay.status);
      expect(await replay.json()).toMatchObject({
        id: createdThread.id,
        name: 'Owner private create',
      });
      const crossed = await fixture.app.request(`/api/workspaces/${fixture.workspace.id}/threads`, {
        body: JSON.stringify({ name: 'Other create attempt', requestId, visibility: 'private' }),
        headers: { ...other, 'content-type': 'application/json' },
        method: 'POST',
      });
      const crossedText = await crossed.text();
      expect(crossedText).not.toContain(createdThread.id);
      expect(crossedText).not.toContain('Owner private create');
      if (crossed.status < 300) {
        const body = JSON.parse(crossedText) as { id: string; name: string | null };
        expect(body.id).not.toBe(createdThread.id);
        expect(body.name).not.toBe('Owner private create');
      }
    } finally {
      fixture.close();
    }
  });
});
