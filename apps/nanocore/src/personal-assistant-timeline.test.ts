import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATION_DEFINITIONS, type OperationId } from '@openkit/app-api-schemas';
import { ThreadSchema } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { FsStore } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Keeps real public admission, file records and Core relationships in one disposable root. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'personal-assistant-timeline-'));
  const databases: ReturnType<typeof openCoreDb>[] = [];
  onTestFinished(() => {
    for (const database of databases) {
      if (database.sqlite.open) database.sqlite.close();
    }
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const open = () => {
    const coreDb = openCoreDb(dataRoot);
    databases.push(coreDb);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const app = createApp({ coreDb, store });
    return { app, coreDb, store };
  };
  return { ...open(), reopen: open };
}

/** Calls the definition-derived public binding with an explicit command identity when supplied. */
async function request(
  app: ReturnType<typeof createApp>,
  operation: OperationId,
  input: Record<string, unknown>
) {
  const response = await app.request(
    ...operationRequest(operation, {}, { body: JSON.stringify(input) })
  );
  return {
    status: response.status,
    body: response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : await response.text(),
  };
}

/** Retains ordinary user and Assistant Items without invoking an unrelated inference provider. */
function retainExchange(store: FsStore, workspaceId: string, threadId: string) {
  const turn = store.createTurn(workspaceId, threadId, 'Keep this request.', {
    kind: 'user',
    id: 'user_local',
  });
  const createdAt = '2026-10-15T00:00:00.000Z';
  for (const [type, text, actor] of [
    ['user-message', 'Keep this request.', { kind: 'user', id: 'user_local' }],
    ['assistant-message', 'Keep this response.', { kind: 'agent', id: 'assistant' }],
  ] as const) {
    store.createItem({
      id: randomUUID(),
      workspaceId,
      threadId,
      turnId: turn.id,
      type,
      actor,
      text,
      status: 'completed',
      createdAt,
      completedAt: createdAt,
    });
  }
  store.updateTurn(turn.id, { status: 'completed', completedAt: createdAt });
  return store.listThreadItems(workspaceId, threadId);
}

/** Creates a distinct canonical fixture user using the existing local fixture's email domain. */
function insertUser(coreDb: ReturnType<typeof openCoreDb>, userId: string) {
  const local = coreDb.sqlite.prepare('SELECT email FROM users WHERE id = ?').get('user_local') as {
    email: string;
  };
  const email = `${randomUUID()}${local.email.slice(local.email.indexOf('@'))}`;
  const timestamp = Date.now();
  coreDb.sqlite
    .prepare(
      `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind)
       VALUES (?, ?, ?, false, ?, ?, 'human')`
    )
    .run(userId, userId, email, timestamp, timestamp);
  return email;
}

describe('Personal Assistant Timeline admission', () => {
  it('keeps Timeline identity separate for each authenticated User and Workspace', async () => {
    const current = fixture();
    const workspace = current.store.createWorkspace('Shared project');
    const otherWorkspace = current.store.createWorkspace('Other project');
    for (const entry of [workspace, otherWorkspace]) {
      recordWorkspaceOwnerMembership({
        coreDb: current.coreDb,
        workspaceId: entry.id,
        ownerUserId: 'user_local',
      });
    }
    insertUser(current.coreDb, 'user_member');
    const timestamp = new Date().toISOString();
    current.coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, status, access_level, joined_at, revision, created_at, updated_at)
         VALUES (?, 'user_member', 'active', 'editor', ?, 1, ?, ?)`
      )
      .run(workspace.id, timestamp, timestamp, timestamp);
    let actor = 'user_local';
    const app = createApp({
      coreDb: current.coreDb,
      store: current.store,
      mode: 'server',
      auth: {
        api: { getSession: async () => ({ user: { id: actor } }) },
        handler: async () => new Response(null, { status: 404 }),
      },
    });
    const input = { workspaceId: workspace.id, name: 'Assistant', requestId: randomUUID() };
    const owner = await request(app, 'thread.create', input);
    actor = 'user_member';
    const member = await request(app, 'thread.create', input);
    expect(owner.status).toBe(200);
    expect(member.status).toBe(200);
    expect(member.body.privateOwnerUserId).toBe('user_member');
    expect(member.body.id).not.toBe(owner.body.id);
    const visible = await request(app, 'thread.list', { workspaceId: workspace.id });
    expect(visible.body.items.map((entry: { id: string }) => entry.id)).toEqual([member.body.id]);
    actor = 'user_local';
    const other = await request(app, 'thread.create', { ...input, workspaceId: otherWorkspace.id });
    expect(other.status).toBe(200);
    expect(other.body.id).not.toBe(owner.body.id);
    expect(other.body.workspaceId).toBe(otherWorkspace.id);
  });

  it('admits no second ordinary private conversation across distinct commands, concurrent delivery and restart', async () => {
    const current = fixture();
    const workspace = current.store.createWorkspace('Project Timeline');
    recordWorkspaceOwnerMembership({
      coreDb: current.coreDb,
      workspaceId: workspace.id,
      ownerUserId: 'user_local',
    });
    const input = { workspaceId: workspace.id, name: 'Assistant', requestId: randomUUID() };
    const first = await request(current.app, 'thread.create', input);
    expect(first.status).toBe(200);
    const timeline = ThreadSchema.parse(first.body);
    expect(timeline).toMatchObject({
      visibility: 'private',
      privateOwnerUserId: 'user_local',
      entryPath: 'conversation',
    });
    const history = retainExchange(current.store, workspace.id, timeline.id);
    const duplicateCommands = [
      { ...input, name: 'Another request', requestId: randomUUID() },
      { ...input, name: 'Concurrent request', requestId: randomUUID() },
    ];
    const attempts = await Promise.all(
      duplicateCommands.map((command) => request(current.app, 'thread.create', command))
    );
    const replay = await request(current.app, 'thread.create', input);
    expect(replay.status).toBe(200);
    expect(ThreadSchema.parse(replay.body).id).toBe(timeline.id);
    const conflict = await request(current.app, 'thread.create', { ...input, name: 'Changed' });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'idempotency_key_conflict' });

    current.coreDb.sqlite.close();
    const restarted = current.reopen();
    const replayAfterRestart = await request(restarted.app, 'thread.create', input);
    expect(replayAfterRestart.status).toBe(200);
    expect(ThreadSchema.parse(replayAfterRestart.body).id).toBe(timeline.id);
    const items = await request(restarted.app, 'thread.items', {
      workspaceId: workspace.id,
      threadId: timeline.id,
    });
    expect(items.status).toBe(200);
    expect(items.body.items).toEqual(history);
    for (const command of duplicateCommands) {
      attempts.push(await request(restarted.app, 'thread.create', command));
    }

    // The owner permits reuse or a typed refusal, but never another ordinary private chat.
    for (const attempt of attempts) {
      if (attempt.status === 200) {
        expect.soft(ThreadSchema.parse(attempt.body).id).toBe(timeline.id);
      } else {
        expect(attempt.status).toBe(409);
        expect(attempt.body.code).toEqual(expect.any(String));
      }
    }
    const listed = await request(restarted.app, 'thread.list', { workspaceId: workspace.id });
    expect(listed.status).toBe(200);
    expect(listed.body.items).toEqual([expect.objectContaining({ id: timeline.id })]);
    expect(restarted.store.listThreads(workspace.id)).toHaveLength(1);
  });

  it('keeps retained private history and exact create receipts readable after restart', async () => {
    const current = fixture();
    const workspace = current.store.listWorkspaces()[0]!;
    const input = {
      workspaceId: workspace.id,
      name: 'Retained Assistant',
      requestId: randomUUID(),
    };
    const created = await request(current.app, 'thread.create', input);
    expect(created.status).toBe(200);
    const thread = ThreadSchema.parse(created.body);
    const history = retainExchange(current.store, workspace.id, thread.id);
    const administration = current.store.createThread(
      workspace.id,
      'Retained administration',
      undefined,
      'administration',
      { visibility: 'private', privateOwnerUserId: 'user_local' }
    );
    const administrationHistory = retainExchange(current.store, workspace.id, administration.id);
    current.coreDb.sqlite.close();

    const restarted = current.reopen();
    expect(restarted.store.getThread(workspace.id, administration.id)).toEqual(
      current.store.getThread(workspace.id, administration.id)
    );
    for (const [threadId, expected] of [
      [thread.id, history],
      [administration.id, administrationHistory],
    ] as const) {
      const items = await request(restarted.app, 'thread.items', {
        workspaceId: workspace.id,
        threadId,
      });
      expect(items.status).toBe(200);
      expect(items.body.items).toEqual(expected);
    }
    const replay = await request(restarted.app, 'thread.create', input);
    expect(replay.status).toBe(200);
    expect(ThreadSchema.parse(replay.body).id).toBe(thread.id);
    expect(
      restarted.store
        .listThreads(workspace.id)
        .map((entry) => entry.id)
        .sort()
    ).toEqual([thread.id, administration.id].sort());
    expect(restarted.store.getWorkspace(workspace.id).kind).toBe('personal');
  });

  it('keeps retained extra private conversations readable but refuses new submissions before inference', async () => {
    const current = fixture();
    const workspace = current.store.listWorkspaces()[0]!;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T00:00:00.000Z'));
    onTestFinished(() => vi.useRealTimers());
    const timeline = current.store.createThread(
      workspace.id,
      'Timeline',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: 'user_local',
      }
    );
    vi.advanceTimersByTime(1);
    const retained = current.store.createThread(
      workspace.id,
      'Retained history',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: 'user_local',
      }
    );
    vi.useRealTimers();
    const history = retainExchange(current.store, workspace.id, retained.id);
    const before = current.store.listThreadTurns(workspace.id, retained.id);
    const submitted = await request(current.app, 'conversation.submit', {
      workspaceId: workspace.id,
      threadId: retained.id,
      requestId: randomUUID(),
      input: 'Continue here.',
      targetRef: 'internal-role:assistant',
      artifactRefs: [],
    });
    expect(submitted.status).toBe(409);
    expect(submitted.body).toMatchObject({ code: 'assistant_timeline_required' });
    expect(current.store.listThreadTurns(workspace.id, retained.id)).toEqual(before);
    const opened = await request(current.app, 'thread.create', {
      workspaceId: workspace.id,
      name: 'Assistant',
      requestId: randomUUID(),
    });
    expect(opened.body.id).toBe(timeline.id);
    const read = await request(current.app, 'thread.items', {
      workspaceId: workspace.id,
      threadId: retained.id,
    });
    expect(read.status).toBe(200);
    expect(read.body.items).toEqual(history);
  });

  it('provisions one ordinary personal Workspace and reuses its owner relationship after restart', () => {
    const current = fixture();
    const homes = current.store.listWorkspaces();
    expect(homes).toHaveLength(1);
    const home = homes[0]!;
    current.coreDb.sqlite.close();
    const restarted = current.reopen();
    expect(restarted.store.listWorkspaces()).toEqual([home]);
    expect(
      restarted.coreDb.sqlite
        .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id = ?')
        .get(home.id)
    ).toEqual({ owner_user_id: 'user_local' });
    expect(
      restarted.coreDb.sqlite
        .prepare('SELECT user_id, status FROM workspace_members WHERE workspace_id = ?')
        .all(home.id)
    ).toEqual([{ user_id: 'user_local', status: 'active' }]);
    expect(home.kind).toBe('personal');
  });

  it('admits a Goal with a shared execution Thread inside the personal Workspace', async () => {
    const current = fixture();
    const home = current.store.listWorkspaces()[0]!;
    const input = {
      workspaceId: home.id,
      intent: 'Prepare a reviewed design.',
      requestId: randomUUID(),
    };
    const created = await request(current.app, 'goal.create', input);
    expect(created.status).toBe(OPERATION_DEFINITIONS['goal.create'].successStatus);
    expect(created.body.goal).toMatchObject({ workspaceId: home.id, intent: input.intent });
    expect(current.store.getThread(home.id, created.body.goal.threadId)).toMatchObject({
      visibility: 'workspace',
      workspaceId: home.id,
    });
    const replay = await request(current.app, 'goal.create', input);
    expect(replay.status).toBe(200);
    expect(replay.body.goal.goalId).toBe(created.body.goal.goalId);
    expect(current.store.listWorkspaces()).toHaveLength(1);
    expect(current.store.listThreads(home.id)).toHaveLength(1);
  });

  it('refuses member invitation before changing owner-only membership or invitation records', async () => {
    const current = fixture();
    const home = current.store.listWorkspaces()[0]!;
    const inviteeEmail = insertUser(current.coreDb, 'user_invitee');
    const membersBefore = current.coreDb.sqlite
      .prepare('SELECT * FROM workspace_members WHERE workspace_id = ?')
      .all(home.id);
    const invitationsBefore = current.coreDb.sqlite
      .prepare('SELECT * FROM workspace_invitations WHERE workspace_id = ?')
      .all(home.id);
    const input = {
      workspaceId: home.id,
      inviteeEmail,
      proposedAccessLevel: 'editor',
      requestId: randomUUID(),
    };
    const refused = await request(current.app, 'workspace.invitation-create', input);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toEqual(expect.any(String));
    expect(await request(current.app, 'workspace.invitation-create', input)).toEqual(refused);
    expect(
      current.coreDb.sqlite
        .prepare('SELECT * FROM workspace_members WHERE workspace_id = ?')
        .all(home.id)
    ).toEqual(membersBefore);
    expect(
      current.coreDb.sqlite
        .prepare('SELECT * FROM workspace_invitations WHERE workspace_id = ?')
        .all(home.id)
    ).toEqual(invitationsBefore);
  });
});
