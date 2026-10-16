import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JsonOperationId, OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoreClient } from '../../../packages/core-client/src/index.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { createBetterAuth } from './auth/better-auth.js';
import { ensureLocalUser } from './auth/identity.js';
import { disableCanonicalUser } from './auth/user-lifecycle.js';
import { FsStore } from './lib/store.js';
import { createOperationInvocation } from './operation-composition.js';
import { OperationError } from './operation-error.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

const fixtures: Array<{ coreDb: ReturnType<typeof openCoreDb>; dataRoot: string }> = [];
const timestamp = '2026-10-15T00:00:00.000Z';
const operationId = 'caller.read' as JsonOperationId;

afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    f.coreDb.sqlite.close();
    rmSync(f.dataRoot, { recursive: true, force: true });
  }
});

/** Makes an absent baseline definition an intended assertion failure instead of an import error. */
function requireCallerDefinition() {
  expect(
    Reflect.get(OPERATION_DEFINITIONS, 'caller.read'),
    'caller.read must be defined.'
  ).toBeDefined();
}

/** Creates a real server session, canonical owners and isolated retained records without launching work. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'caller-projection-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  fixtures.push({ coreDb, dataRoot });
  const store = new FsStore({ dataRoot });
  const auth = createBetterAuth(coreDb);
  const makeApp = (ownerStore = store, mode: 'local' | 'server' = 'server') =>
    createApp({ auth, coreDb, dataRoot, mode, store: ownerStore });
  const app = makeApp();
  const signup = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'caller@example.invalid',
      name: 'Caller',
      password: 'fixture-password-123456',
    }),
  });
  expect(signup.status, await signup.clone().text()).toBe(200);
  const cookie = signup.headers.get('set-cookie')!.split(';')[0]!;
  const userId = (await signup.json()).user.id as string;
  const owned = store.createWorkspace('Owned content must not enter caller output.');
  const foreign = store.createWorkspace('Other owner private content.');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: owned.id, ownerUserId: userId });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: foreign.id, ownerUserId: 'user_local' });
  const post = (
    id: string,
    input: unknown = {},
    headers: Record<string, string> = { cookie },
    target = app
  ) =>
    target.request(`/api/app/operations/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(input),
    });
  const token = (
    scope: 'server-admin' | 'workspace' | 'workspace-readonly' = 'server-admin',
    expiresAt = '2099-01-01T00:00:00.000Z'
  ) =>
    createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: userId,
      scope,
      workspaceIds: scope === 'server-admin' ? [] : [owned.id],
      expiresAt,
    });
  return {
    app,
    auth,
    cookie,
    coreDb,
    dataRoot,
    foreign,
    makeApp,
    owned,
    post,
    store,
    token,
    userId,
  };
}

/** Seeds distinct shared, caller-private and other-private canonical records; Artifact references are real Items. */
function seedRetainedWork(f: Awaited<ReturnType<typeof fixture>>) {
  const threads = [
    f.store.createThread(f.owned.id, 'Shared secret text', 'th_shared'),
    f.store.createThread(f.owned.id, 'Caller private text', 'th_own', 'conversation', {
      visibility: 'private',
      privateOwnerUserId: f.userId,
    }),
    f.store.createThread(f.owned.id, 'Other private text', 'th_other', 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'user_local',
    }),
  ];
  const turns = threads.map((thread, index) => {
    const turn = f.store.createTurn(f.owned.id, thread.id, 'Retained input', {
      kind: 'user',
      id: f.userId,
    });
    f.store.createItem({
      id: `it_caller_${index}`,
      workspaceId: f.owned.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-message',
      actor: { kind: 'user', id: f.userId },
      status: 'completed',
      text: `private-content-${index}`,
      createdAt: timestamp,
      completedAt: timestamp,
    });
    return turn;
  });
  for (const [index, turn] of [turns[0]!, turns[2]!].entries()) {
    const body = `Artifact private-content-${index}`;
    f.store.createArtifact({
      id: `ar_turn_${index}`,
      workspaceId: f.owned.id,
      threadId: turn.threadId,
      turnId: turn.id,
      kind: 'file',
      title: body,
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'markdown', body },
      contentDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      lastMutationRequestId: `artifact_${index}`,
      origin: {
        kind: 'turn-output',
        threadId: turn.threadId,
        turnId: turn.id,
        requestId: `artifact_${index}`,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  const body = 'Imported private-content';
  const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  f.store.createArtifact({
    id: 'ar_imported',
    workspaceId: f.owned.id,
    threadId: null,
    turnId: null,
    kind: 'file',
    title: body,
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'markdown', body },
    contentDigest: digest,
    lastMutationRequestId: 'imported',
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: 'imported',
      sourceDigest: digest,
      actor: { kind: 'user', id: f.userId },
      requestId: 'imported',
      recordedAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  // A later revision changes bytes but not the number of current canonical Items.
  f.store.updateItem('it_caller_0', { text: 'Revised private-content' });
}

/** Returns a real Core Client over the App's actual JSON and authentication boundaries. */
function clientFor(f: Awaited<ReturnType<typeof fixture>>, headers: Record<string, string>) {
  return createCoreClient({
    baseUrl: 'http://127.0.0.1',
    fetch: (input, init) => {
      const request = new Request(input, init);
      for (const [key, value] of Object.entries(headers)) request.headers.set(key, value);
      return f.app.fetch(request);
    },
  });
}

/** Calls the actual remote MCP projection with its static bearer admission. */
async function mcpRead(f: Awaited<ReturnType<typeof fixture>>, secret: string, input: unknown) {
  return f.app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'call', arguments: { operation: 'caller.read', input } },
    }),
  });
}

describe('caller operation projections', () => {
  it('returns only current local, session and bearer metadata without provisioning or enumerating work', async () => {
    requireCallerDefinition();
    const f = await fixture();
    const admin = f.token();
    const localApp = f.makeApp(f.store, 'local');
    const list = vi.spyOn(f.store, 'listWorkspaces');
    const threads = vi.spyOn(f.store, 'listThreads');
    const turns = vi.spyOn(f.store, 'listThreadTurns');
    const items = vi.spyOn(f.store, 'listThreadItems');
    const artifacts = vi.spyOn(f.store, 'listArtifacts');
    const provision = vi.spyOn(f.store, 'ensureQuickChatWorkspace');
    const create = vi.spyOn(f.store, 'createWorkspace');
    for (const [headers, target, expected] of [
      [{}, localApp, { userId: 'user_local', credential: { kind: 'local', scope: null } }],
      [
        { cookie: f.cookie },
        f.app,
        { userId: f.userId, credential: { kind: 'session', scope: null } },
      ],
      [
        { authorization: `Bearer ${admin.secret}` },
        f.app,
        { userId: f.userId, credential: { kind: 'token', scope: 'server-admin' } },
      ],
    ] as const) {
      const response = await f.post('caller.read', {}, headers, target);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual(expected);
    }
    expect(list).not.toHaveBeenCalled();
    expect(threads).not.toHaveBeenCalled();
    expect(turns).not.toHaveBeenCalled();
    expect(items).not.toHaveBeenCalled();
    expect(artifacts).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('counts only readable current records and preserves the same observation through native, HTTP, Core Client and CLI', async () => {
    requireCallerDefinition();
    const f = await fixture();
    seedRetainedWork(f);
    const input = { workspaceId: f.owned.id };
    const itemReads = vi.spyOn(f.store, 'listThreadItems');
    const response = await f.post('caller.read', input);
    expect(response.status, await response.clone().text()).toBe(200);
    const session = await response.json();
    expect(session).toMatchObject({
      userId: f.userId,
      credential: { kind: 'session', scope: null },
      workspace: {
        workspaceId: f.owned.id,
        ownerUserId: f.userId,
        membershipStatus: 'active',
        accessCause: 'membership',
        counts: { threads: 2, turns: 2, items: 3, artifacts: 2 },
      },
    });
    expect(Number.isFinite(Date.parse(session.workspace.observedAt))).toBe(true);
    expect(JSON.stringify(session)).not.toMatch(/private-content|Other private|caller@example/);
    expect(itemReads.mock.calls.map(([, threadId]) => threadId)).not.toContain('th_other');
    const admin = f.token();
    const client = clientFor(f, { authorization: `Bearer ${admin.secret}` });
    const read = Reflect.get(client.operations, 'caller.read');
    expect(read).toBeTypeOf('function');
    const clientResult = await read(input);
    const invoke = createOperationInvocation({
      coreDb: f.coreDb,
      store: f.store,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    const native = await invoke(operationId, input as never, {
      kind: 'public',
      delivery: 'human',
      actor: {
        kind: 'token',
        userId: f.userId,
        tokenId: admin.tokenId,
        tokenScope: 'server-admin',
        tokenWorkspaceIds: [],
      },
    });
    const { operationCatalog } = await import(
      new URL('../../../skills/openkit-operations.mjs', import.meta.url).href
    );
    const entry = operationCatalog.find(
      (candidate: { id: string }) => candidate.id === 'caller.read'
    );
    expect(entry).toBeDefined();
    const cli = await entry.handler({ client }, entry.inputSchema.parse(input));
    const remote = await mcpRead(f, admin.secret, input);
    expect(remote.status).toBe(200);
    const envelope = await remote.json();
    expect(envelope.error).toBeUndefined();
    expect(envelope.result.isError).not.toBe(true);
    const mcp = JSON.parse(envelope.result.content[0].text);
    for (const result of [clientResult, native, cli, mcp]) {
      expect(result).toMatchObject({
        userId: f.userId,
        credential: { kind: 'token', scope: 'server-admin' },
        workspace: {
          workspaceId: f.owned.id,
          ownerUserId: f.userId,
          membershipStatus: 'active',
          accessCause: 'administrator',
          counts: { threads: 3, turns: 3, items: 5, artifacts: 3 },
        },
      });
      expect(JSON.stringify(result)).not.toContain(admin.secret);
    }
    const reloaded = new FsStore({ dataRoot: f.dataRoot });
    reloaded.createThread(f.owned.id, 'New canonical record', 'th_restart');
    const restarted = f.makeApp(new FsStore({ dataRoot: f.dataRoot }));
    const afterRestart = await f.post(
      'caller.read',
      input,
      { authorization: `Bearer ${admin.secret}` },
      restarted
    );
    expect(afterRestart.status).toBe(200);
    expect((await afterRestart.json()).workspace.counts).toEqual({
      threads: 4,
      turns: 3,
      items: 5,
      artifacts: 3,
    });
  });

  it('observes only the exact selected owned Workspace and refuses selectors before source access', async () => {
    requireCallerDefinition();
    const f = await fixture();
    seedRetainedWork(f);
    const second = f.store.createWorkspace('Second owned Workspace');
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: second.id,
      ownerUserId: f.userId,
    });
    const threads = vi.spyOn(f.store, 'listThreads');
    const response = await f.post('caller.read', { workspaceId: second.id });
    expect(response.status).toBe(200);
    expect((await response.json()).workspace).toMatchObject({
      workspaceId: second.id,
      counts: { threads: 0, turns: 0, items: 0, artifacts: 0 },
    });
    expect(threads.mock.calls.every(([workspaceId]) => workspaceId === second.id)).toBe(true);
    threads.mockClear();
    for (const [invalid, status] of [
      [{ userId: f.userId }, 403],
      [{ workspaceId: '' }, 400],
      [{ workspaceId: f.owned.id, userId: f.userId }, 403],
    ] as const) {
      const rejected = await f.post('caller.read', invalid);
      expect(rejected.status, `${JSON.stringify(invalid)}: ${await rejected.clone().text()}`).toBe(
        status
      );
      if (status === 403)
        expect(await rejected.clone().json()).toMatchObject({ code: 'bound_input_conflict' });
      expect(await rejected.text()).not.toContain('private-content');
    }
    expect(threads).not.toHaveBeenCalled();
  });

  it('recomputes source audiences when administrator eligibility is revoked between reads', async () => {
    requireCallerDefinition();
    const f = await fixture();
    seedRetainedWork(f);
    const admin = f.token();
    const before = await f.post('caller.read', { workspaceId: f.owned.id });
    expect(before.status).toBe(200);
    expect((await before.json()).workspace.counts).toEqual({
      threads: 3,
      turns: 3,
      items: 5,
      artifacts: 3,
    });
    revokeOpenKitAccessTokenRecord(f.coreDb, admin.tokenId);
    const after = await f.post('caller.read', { workspaceId: f.owned.id });
    expect(after.status).toBe(200);
    expect((await after.json()).workspace.counts).toEqual({
      threads: 2,
      turns: 2,
      items: 3,
      artifacts: 2,
    });
    const remote = await mcpRead(f, admin.secret, { workspaceId: f.owned.id });
    expect(remote.status).toBe(401);
    expect(await remote.text()).not.toMatch(/private-content|caller@example/);
  });

  it.each([
    'revocation',
    'session administrator revocation',
    'Workspace closure',
  ] as const)('refuses publication after %s during count acquisition', async (fault) => {
    requireCallerDefinition();
    const f = await fixture();
    seedRetainedWork(f);
    const admin = f.token();
    const listItems = f.store.listThreadItems.bind(f.store);
    const crossing = vi.spyOn(f.store, 'listThreadItems').mockImplementationOnce((...args) => {
      const records = listItems(...args);
      if (fault !== 'Workspace closure') revokeOpenKitAccessTokenRecord(f.coreDb, admin.tokenId);
      else
        f.coreDb.sqlite
          .prepare("UPDATE workspace_registry SET status='deleting' WHERE workspace_id=?")
          .run(f.owned.id);
      return records;
    });
    const response = await f.post(
      'caller.read',
      { workspaceId: f.owned.id },
      fault === 'session administrator revocation'
        ? { cookie: f.cookie }
        : { authorization: `Bearer ${admin.secret}` }
    );
    expect(crossing).toHaveBeenCalled();
    expect(crossing).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toMatch(/"counts"|private-content|caller@example/);
  });

  it('denies caller metadata and selected counts after the canonical User is disabled', async () => {
    requireCallerDefinition();
    const f = await fixture();
    const admin = f.token();
    expect((await f.post('caller.read')).status).toBe(200);
    f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.userId))();
    const source = vi.spyOn(f.store, 'listThreads');
    for (const headers of [{ cookie: f.cookie }, { authorization: `Bearer ${admin.secret}` }]) {
      for (const input of [{}, { workspaceId: f.owned.id }]) {
        const response = await f.post('caller.read', input, headers);
        expect(response.status).toBe(401);
        expect(await response.text()).not.toMatch(/"counts"|caller@example/);
      }
    }
    expect(source).not.toHaveBeenCalled();
  });

  it('keeps administrator eligibility separate from active, removed and absent membership in caller and Workspace reads', async () => {
    requireCallerDefinition();
    const f = await fixture();
    const admin = f.token();
    const headers = { authorization: `Bearer ${admin.secret}` };
    const caller = await f.post('caller.read', { workspaceId: f.owned.id }, headers);
    expect(caller.status).toBe(200);
    expect((await caller.json()).workspace).toMatchObject({
      ownerUserId: f.userId,
      membershipStatus: 'active',
      accessCause: 'administrator',
    });
    f.coreDb.sqlite
      .prepare(`INSERT INTO workspace_members (
      workspace_id, user_id, status, invitation_id, joined_at,
      removed_at, revision, created_at, updated_at
    ) VALUES (?, ?, 'active', NULL, ?, NULL, 1, ?, ?)`)
      .run(f.foreign.id, f.userId, timestamp, timestamp, timestamp);
    for (const membershipStatus of ['active', 'removed', null]) {
      if (membershipStatus === 'removed')
        f.coreDb.sqlite
          .prepare(
            "UPDATE workspace_members SET status='removed', removed_at=?, revision=7 WHERE workspace_id=? AND user_id=?"
          )
          .run(timestamp, f.foreign.id, f.userId);
      if (membershipStatus === null)
        f.coreDb.sqlite
          .prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?')
          .run(f.foreign.id, f.userId);
      const response = await f.post('caller.read', { workspaceId: f.foreign.id }, headers);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('"counts"');
      const read = await f.post('workspace.read', { workspaceId: f.foreign.id }, headers);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({
        id: f.foreign.id,
        ownerUserId: 'user_local',
        membershipStatus,
        accessCause: 'administrator',
      });
      const listed = await f.post('workspace.list', {}, headers);
      expect(listed.status).toBe(200);
      const entry = (await listed.json()).items.find(
        (item: { workspace: { id: string } }) => item.workspace.id === f.foreign.id
      );
      expect(entry).toMatchObject({
        ownerUserId: 'user_local',
        membershipStatus,
        accessCause: 'administrator',
        isOwner: false,
        membershipRevision:
          membershipStatus === 'active' ? 1 : membershipStatus === 'removed' ? 7 : null,
      });
    }
    const foreign = await f.post('workspace.read', { workspaceId: f.foreign.id }, headers);
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toMatchObject({
      id: f.foreign.id,
      ownerUserId: 'user_local',
      membershipStatus: null,
      accessCause: 'administrator',
    });
  });

  it('uniformly refuses missing, other-owned and inaccessible selection before reading count sources', async () => {
    requireCallerDefinition();
    const f = await fixture();
    const admin = f.token();
    const threads = vi.spyOn(f.store, 'listThreads');
    const artifacts = vi.spyOn(f.store, 'listArtifacts');
    const bodies = [];
    for (const id of ['ws_absent', f.foreign.id]) {
      const response = await f.post(
        'caller.read',
        { workspaceId: id },
        { authorization: `Bearer ${admin.secret}` }
      );
      expect(response.status).toBe(403);
      bodies.push(await response.json());
    }
    f.coreDb.sqlite
      .prepare("UPDATE workspace_registry SET status='deleting' WHERE workspace_id=?")
      .run(f.owned.id);
    revokeOpenKitAccessTokenRecord(f.coreDb, admin.tokenId);
    const inaccessible = await f.post('caller.read', { workspaceId: f.owned.id });
    expect(inaccessible.status).toBe(403);
    bodies.push(await inaccessible.json());
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(threads).not.toHaveBeenCalled();
    expect(artifacts).not.toHaveBeenCalled();
  });

  it('returns a typed failure when a count owner is unavailable, without inventing zero evidence', async () => {
    requireCallerDefinition();
    const f = await fixture();
    seedRetainedWork(f);
    const failure = vi.spyOn(f.store, 'listThreadItems').mockImplementation(() => {
      throw new Error('private-count-storage-failure');
    });
    const invoke = createOperationInvocation({
      coreDb: f.coreDb,
      store: f.store,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    const admin = f.token();
    const actor = {
      kind: 'token' as const,
      userId: f.userId,
      tokenId: admin.tokenId,
      tokenScope: 'server-admin' as const,
      tokenWorkspaceIds: [],
    };
    const error = await invoke(operationId, { workspaceId: f.owned.id } as never, {
      kind: 'public',
      actor,
    }).catch((reason: unknown) => reason);
    expect(failure).toHaveBeenCalled();
    expect(error).toBeInstanceOf(OperationError);
    const typed = error as OperationError;
    expect(typed.status).toBeGreaterThanOrEqual(400);
    const response = await f.post(
      'caller.read',
      { workspaceId: f.owned.id },
      { authorization: `Bearer ${admin.secret}` }
    );
    expect(response.status).toBe(typed.status);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ code: typed.code });
    expect(body).not.toContain('private-count-storage-failure');
    expect(body).not.toContain('"counts"');
  });

  it('rechecks bearer expiry and revocation and keeps Workspace bearer limits on canonical-user reads', async () => {
    requireCallerDefinition();
    const f = await fixture();
    const admin = f.token();
    expect(
      (await f.post('caller.read', {}, { authorization: `Bearer ${admin.secret}` })).status
    ).toBe(200);
    revokeOpenKitAccessTokenRecord(f.coreDb, admin.tokenId);
    expect(
      (await f.post('caller.read', {}, { authorization: `Bearer ${admin.secret}` })).status
    ).toBe(401);
    const invoke = createOperationInvocation({
      coreDb: f.coreDb,
      store: f.store,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    await expect(
      invoke(operationId, {} as never, {
        kind: 'public',
        actor: {
          kind: 'token',
          userId: f.userId,
          tokenId: admin.tokenId,
          tokenScope: 'server-admin',
          tokenWorkspaceIds: [],
        },
      })
    ).rejects.toMatchObject({ status: 403 });
    const expired = f.token('server-admin', '2000-01-01T00:00:00.000Z');
    expect(
      (await f.post('caller.read', {}, { authorization: `Bearer ${expired.secret}` })).status
    ).toBe(401);
    for (const scope of ['workspace', 'workspace-readonly'] as const) {
      const ordinary = f.token(scope);
      expect(
        (await f.post('caller.read', {}, { authorization: `Bearer ${ordinary.secret}` })).status
      ).toBe(403);
    }
  });
});
