import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AutomationStore } from '../lib/automation-store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { type Actor, ensureLocalUser } from './identity.js';
import type { AuthVariables } from './middleware.js';
import { PUBLIC_OPERATION_ACCESS } from './operation-access.js';
import {
  assertAuthorizedWorkspaceLineage,
  currentWorkspaceAuthority,
  registerOperationAccessGuards,
} from './operation-authorizer.js';

/** Creates one real Core membership fixture behind a tiny guarded Hono app. */
function createFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-operation-authorizer-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);

  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  coreDb.sqlite
    .prepare(
      `INSERT INTO users (
        id, display_name, email, email_verified, created_at, updated_at, kind, status
      ) VALUES
        ('user_missing', 'Missing Member', 'missing-member@example.com', false, ?, ?, 'human', 'active'),
        ('user_removed', 'Removed Member', 'removed-member@example.com', false, ?, ?, 'human', 'active'),
        ('user_viewer', 'Viewer Member', 'viewer-member@example.com', false, ?, ?, 'human', 'active'),
        ('user_disabled', 'Disabled Member', 'disabled-member@example.com', false, ?, ?, 'human', 'disabled')`
    )
    .run(now, now, now, now, now, now, now, now);

  const store = createDemoStore({ dataRoot });
  const quickChatWorkspace = store
    .listWorkspaces()
    .find((workspace) => workspace.kind === 'quick-chat');
  const workspace = store.listWorkspaces().find((item) => item.kind === 'code');
  if (!quickChatWorkspace || !workspace) {
    throw new Error('Expected Quick Chat and Demo Workspace fixtures.');
  }

  const foreignWorkspace = store.createWorkspace('Foreign Workspace');
  const filesystemOnlyWorkspace = store.createWorkspace('Filesystem Only Workspace');
  for (const ownedWorkspace of [quickChatWorkspace, workspace, foreignWorkspace]) {
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: ownedWorkspace.id,
    });
  }
  coreDb.sqlite
    .prepare(
      `INSERT INTO workspace_members (
        workspace_id, user_id, status, access_level, invitation_id,
        joined_at, removed_at, revision, created_at, updated_at
      ) VALUES
        (?, 'user_removed', 'removed', 'viewer', NULL, ?, ?, 2, ?, ?),
        (?, 'user_viewer', 'active', 'viewer', NULL, ?, NULL, 1, ?, ?),
        (?, 'user_disabled', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
    )
    .run(
      workspace.id,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
      workspace.id,
      timestamp,
      timestamp,
      timestamp,
      workspace.id,
      timestamp,
      timestamp,
      timestamp
    );

  const demoThread = store.listThreads(workspace.id)[0];
  if (!demoThread) {
    throw new Error('Expected the Demo Workspace thread fixture.');
  }
  const turn = store.createTurn(workspace.id, demoThread.id, 'Feedback target', {
    kind: 'user',
    id: 'user_local',
  });
  const foreignThread = store.createThread(foreignWorkspace.id, 'Foreign thread');
  const automationStore = new AutomationStore();
  const actorState: { current: Actor } = {
    current: { kind: 'session', userId: 'user_local' },
  };
  const app = new Hono<{ Variables: AuthVariables }>();
  let threadDashboardHandlerReads = 0;

  app.use('*', async (c, next) => {
    c.set('actor', actorState.current);
    await next();
  });
  registerOperationAccessGuards({
    app,
    automationStore,
    coreDb,
    quickChatWorkspaceIdForUser: (userId) =>
      userId === 'user_local' ? quickChatWorkspace.id : 'ws_missing_quick_chat',
    store,
  });

  app.post('/api/app/quick-chat', (c) => c.json(c.get('workspaceAccess') ?? null));
  app.get('/api/app/automations', (c) => c.json(c.get('workspaceAccess') ?? null));
  app.post('/api/app/automations', async (c) =>
    c.json({
      body: await c.req.json(),
      workspaceAccess: c.get('workspaceAccess') ?? null,
    })
  );
  app.post('/api/app/workspace-imports/dry-run', (c) => c.json(c.get('actor')));
  app.post('/v1/responses', (c) => c.json(c.get('workspaceAccess') ?? null));
  app.post('/api/turns/:turnId/feedback', (c) => c.json(c.get('workspaceAccess') ?? null));
  app.get('/api/app/workspaces/:workspaceId/dashboard', (c) =>
    c.json(c.get('workspaceAccess') ?? null)
  );
  app.get('/api/app/workspaces/:workspaceId/threads/:threadId/dashboard', (c) => {
    threadDashboardHandlerReads += 1;
    const actualWorkspaceId =
      c.req.param('threadId') === foreignThread.id ? foreignThread.workspaceId : workspace.id;
    assertAuthorizedWorkspaceLineage(c.get('workspaceAccess'), actualWorkspaceId);
    return c.json(c.get('workspaceAccess'));
  });

  return {
    actorState,
    app,
    coreDb,
    filesystemOnlyWorkspace,
    foreignThread,
    foreignWorkspace,
    quickChatWorkspace,
    threadDashboardHandlerReads: () => threadDashboardHandlerReads,
    turn,
    workspace,
  };
}

let fixture: ReturnType<typeof createFixture>;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.coreDb.sqlite.close();
});

describe('central Workspace operation authorizer', () => {
  it.each([
    {
      actor: { kind: 'user', id: 'user_local' } as const,
      effectAuthority: true,
      expectedRole: 'owner',
      name: 'active human owner',
      operation: 'runtime.launch',
    },
    {
      actor: {
        kind: 'agent',
        id: 'agent_worker',
        responsibleUserId: 'user_local',
      } as const,
      effectAuthority: true,
      expectedRole: 'owner',
      name: 'responsible non-human actor',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'system', id: 'system_worker', responsibleUserId: null } as const,
      effectAuthority: true,
      expectedRole: null,
      name: 'actor without a responsible user',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'user', id: 'user_missing' } as const,
      effectAuthority: true,
      expectedRole: null,
      name: 'missing membership',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'user', id: 'user_removed' } as const,
      effectAuthority: true,
      expectedRole: null,
      name: 'removed membership',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'user', id: 'user_disabled' } as const,
      effectAuthority: true,
      expectedRole: null,
      name: 'disabled responsible user',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'user', id: 'user_viewer' } as const,
      effectAuthority: true,
      expectedRole: null,
      name: 'insufficient fixed role',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'user', id: 'user_local' } as const,
      effectAuthority: true,
      expectedRole: null,
      name: 'unknown policy operation',
      operation: 'runtime.unregistered',
    },
    {
      actor: { kind: 'user', id: 'user_local' } as const,
      effectAuthority: false,
      expectedRole: null,
      name: 'missing effect authority',
      operation: 'runtime.launch',
    },
  ])('composes current authority for $name', ({
    actor,
    effectAuthority,
    expectedRole,
    operation,
  }) => {
    expect(
      currentWorkspaceAuthority(
        fixture.coreDb,
        fixture.workspace.id,
        actor,
        operation,
        effectAuthority
      )
    ).toBe(expectedRole);
  });

  it('derives the Quick Chat Workspace from the authenticated actor', async () => {
    const response = await fixture.app.request('/api/app/quick-chat', {
      body: JSON.stringify({ input: 'Hello' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toEqual({
      effectiveRole: 'owner',
      kind: 'workspace',
      policyOperation: 'turn.run',
      workspaceId: fixture.quickChatWorkspace.id,
    });
  });

  it('derives collection candidates from active Core memberships before loading content', async () => {
    const response = await fixture.app.request('/api/app/automations');
    const access = (await response.json()) as {
      kind: string;
      policyOperation: string;
      workspaceIds: string[];
    };

    expect(response.status).toBe(200);
    expect({ ...access, workspaceIds: [...access.workspaceIds].sort() }).toEqual({
      kind: 'workspace-set',
      policyOperation: 'workspace.read',
      workspaceIds: [
        fixture.foreignWorkspace.id,
        fixture.quickChatWorkspace.id,
        fixture.workspace.id,
      ].sort(),
    });
    expect(access.workspaceIds).not.toContain(fixture.filesystemOnlyWorkspace.id);
  });

  it('resolves the exact route-owned body Workspace without consuming the request', async () => {
    const body = {
      cron: '0 9 * * *',
      name: 'Morning status',
      prompt: 'Summarize current work.',
      workspaceId: fixture.workspace.id,
    };
    const response = await fixture.app.request('/api/app/automations', {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toEqual({
      body,
      workspaceAccess: {
        effectiveRole: 'owner',
        kind: 'workspace',
        policyOperation: 'workspace.write',
        workspaceId: fixture.workspace.id,
      },
    });
  });

  it('treats Gateway metadata as optional session attribution but mandatory token scope', async () => {
    const unattributed = await fixture.app.request('/v1/responses', {
      body: JSON.stringify({ input: 'Hello', model: 'test' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const attributed = await fixture.app.request('/v1/responses', {
      body: JSON.stringify({
        input: 'Hello',
        metadata: { openkit: { workspaceId: fixture.workspace.id } },
        model: 'test',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const malformedAttribution = await fixture.app.request('/v1/responses', {
      body: JSON.stringify({
        input: 'Hello',
        metadata: { openkit: { workspaceId: '' } },
        model: 'test',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_workspace',
      tokenScope: 'workspace',
      tokenWorkspaceIds: [fixture.workspace.id],
      userId: 'user_local',
    };
    const tokenWithoutAttribution = await fixture.app.request('/v1/responses', {
      body: JSON.stringify({ input: 'Hello', model: 'test' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin',
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'user_local',
    };
    const adminAttributed = await fixture.app.request('/v1/responses', {
      body: JSON.stringify({
        input: 'Hello',
        metadata: { openkit: { workspaceId: fixture.workspace.id } },
        model: 'test',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const adminUnattributed = await fixture.app.request('/v1/responses', {
      body: JSON.stringify({ input: 'Hello', model: 'test' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(unattributed.status).toBe(200);
    await expect(unattributed.json()).resolves.toBeNull();
    expect(attributed.status).toBe(200);
    await expect(attributed.json()).resolves.toEqual({
      effectiveRole: 'owner',
      kind: 'workspace',
      policyOperation: 'llm.gateway.use',
      workspaceId: fixture.workspace.id,
    });
    expect(malformedAttribution.status).toBe(403);
    await expect(malformedAttribution.json()).resolves.toMatchObject({
      code: 'workspace_access_denied',
    });
    expect(tokenWithoutAttribution.status).toBe(403);
    await expect(tokenWithoutAttribution.json()).resolves.toMatchObject({
      code: 'workspace_access_denied',
    });
    expect(adminAttributed.status).toBe(403);
    await expect(adminAttributed.json()).resolves.toMatchObject({
      code: 'workspace_access_denied',
    });
    expect(adminUnattributed.status).toBe(200);
    await expect(adminUnattributed.json()).resolves.toBeNull();
  });

  it('resolves an opaque Turn to its Workspace before exposing handler access', async () => {
    const response = await fixture.app.request(`/api/turns/${fixture.turn.id}/feedback`, {
      body: JSON.stringify({ note: null, rating: 'good' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toEqual({
      effectiveRole: 'owner',
      kind: 'workspace',
      policyOperation: 'workspace.write',
      workspaceId: fixture.workspace.id,
    });
  });

  it('authorizes a route-declared Workspace from Core facts', async () => {
    const response = await fixture.app.request(
      `/api/app/workspaces/${fixture.workspace.id}/dashboard`
    );

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toEqual({
      effectiveRole: 'owner',
      kind: 'workspace',
      policyOperation: 'workspace.read',
      workspaceId: fixture.workspace.id,
    });
  });

  it('authorizes the Workspace before reading child lineage and denies a mismatched child', async () => {
    fixture.actorState.current = { kind: 'session', userId: 'user_missing' };
    const deniedBeforeHandler = await fixture.app.request(
      `/api/app/workspaces/${fixture.workspace.id}/threads/${fixture.foreignThread.id}/dashboard`
    );

    expect(deniedBeforeHandler.status).toBe(403);
    expect(fixture.threadDashboardHandlerReads()).toBe(0);

    fixture.actorState.current = { kind: 'session', userId: 'user_local' };
    const deniedAfterAuthorization = await fixture.app.request(
      `/api/app/workspaces/${fixture.workspace.id}/threads/${fixture.foreignThread.id}/dashboard`
    );
    const deniedBeforeHandlerBody = await deniedBeforeHandler.json();
    const deniedAfterAuthorizationBody = await deniedAfterAuthorization.json();

    expect(deniedAfterAuthorization.status).toBe(403);
    expect(fixture.threadDashboardHandlerReads()).toBe(1);
    expect(deniedAfterAuthorizationBody).toEqual(deniedBeforeHandlerBody);
    expect(deniedAfterAuthorizationBody).toMatchObject({ code: 'workspace_access_denied' });
  });

  it('returns one non-enumerating denial for missing and removed membership', async () => {
    fixture.actorState.current = { kind: 'session', userId: 'user_missing' };
    const missing = await fixture.app.request(
      `/api/app/workspaces/${fixture.workspace.id}/dashboard`
    );
    fixture.actorState.current = { kind: 'session', userId: 'user_removed' };
    const removed = await fixture.app.request(
      `/api/app/workspaces/${fixture.workspace.id}/dashboard`
    );
    const missingBody = await missing.json();
    const removedBody = await removed.json();

    expect(missing.status).toBe(403);
    expect(removed.status).toBe(403);
    expect(missingBody).toEqual(removedBody);
    expect(missingBody).toMatchObject({ code: 'workspace_access_denied' });
  });

  it('uses catalog mutation posture to cap readonly tokens', async () => {
    expect(PUBLIC_OPERATION_ACCESS.createAutomation).toMatchObject({ mutating: true });
    expect(PUBLIC_OPERATION_ACCESS.getWorkspaceDashboard).toMatchObject({ mutating: false });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_readonly',
      tokenScope: 'workspace-readonly',
      tokenWorkspaceIds: [fixture.workspace.id],
      userId: 'user_local',
    };

    const read = await fixture.app.request(`/api/app/workspaces/${fixture.workspace.id}/dashboard`);
    const mutation = await fixture.app.request('/api/app/automations', {
      body: JSON.stringify({
        cron: '0 9 * * *',
        name: 'Denied mutation',
        prompt: 'Do not create this.',
        workspaceId: fixture.workspace.id,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(read.status).toBe(200);
    expect(mutation.status).toBe(403);
    await expect(mutation.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
  });

  it('does not let server-admin credentials become Workspace content authority', async () => {
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin',
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'user_local',
    };

    const response = await fixture.app.request(
      `/api/app/workspaces/${fixture.workspace.id}/dashboard`
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
  });

  it('intersects Workspace token bindings with current membership', async () => {
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_workspace',
      tokenScope: 'workspace',
      tokenWorkspaceIds: [fixture.foreignWorkspace.id],
      userId: 'user_local',
    };
    const unbound = await fixture.app.request(
      `/api/app/workspaces/${fixture.workspace.id}/dashboard`
    );

    fixture.actorState.current = {
      ...fixture.actorState.current,
      tokenWorkspaceIds: [fixture.workspace.id],
    };
    const bound = await fixture.app.request(
      `/api/app/workspaces/${fixture.workspace.id}/dashboard`
    );

    expect(unbound.status).toBe(403);
    await expect(unbound.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    expect(bound.status).toBe(200);
    await expect(bound.json()).resolves.toMatchObject({
      effectiveRole: 'owner',
      workspaceId: fixture.workspace.id,
    });
  });

  it('limits canonical-user operations to local and session actors', async () => {
    const session = await fixture.app.request('/api/app/workspace-imports/dry-run', {
      method: 'POST',
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_workspace',
      tokenScope: 'workspace',
      tokenWorkspaceIds: [fixture.workspace.id],
      userId: 'user_local',
    };
    const token = await fixture.app.request('/api/app/workspace-imports/dry-run', {
      method: 'POST',
    });

    expect(session.status).toBe(200);
    expect(token.status).toBe(403);
    await expect(token.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
  });
});
