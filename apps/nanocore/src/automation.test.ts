import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { createAutomationOperationImplementations } from './automation-operations.js';
import { AutomationStore } from './lib/automation-store.js';
import { FsStore } from './lib/store.js';
import { type CoreDb, openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { initializeRecurringScheduleStorage } from './storage/recurring-schema.js';
import { createApp } from './test-support/app.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

const owned: { root: string; db: CoreDb }[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'automation-api-'));
  const db = openCoreDb(root);
  applyMigrations(db);
  initializeRecurringScheduleStorage(db.sqlite);
  ensureLocalUser(db);
  const store = new FsStore({ dataRoot: root });
  const workspace = store.createWorkspace('Recurring');
  const thread = store.createThread(workspace.id, 'Target');
  recordWorkspaceOwnerMembership({
    coreDb: db,
    workspaceId: workspace.id,
    ownerUserId: 'user_local',
  });
  let instant = '2026-10-16T00:00:00.000Z';
  const automationStore = new AutomationStore(db, new WorkspaceMutationAdmission(), () => instant);
  const app = createApp({ store, coreDb: db, dataRoot: root, automationStore });
  owned.push({ root, db });
  const request = (id: string, input: unknown) =>
    app.request(`/api/app/operations/automation.${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  const input = {
    workspaceId: workspace.id,
    threadId: thread.id,
    name: 'Poll',
    intervalSeconds: 60,
    prompt: 'Inspect status',
  };
  return {
    db,
    store,
    workspace,
    thread,
    automationStore,
    app,
    request,
    input,
    setTime: (value: string) => {
      instant = value;
    },
  };
}
afterEach(() => {
  for (const { root, db } of owned.splice(0)) {
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe('fixed-interval automation operations', () => {
  it('creates paused, resumes with exact time, pauses, edits, and retains a deleted tombstone', async () => {
    const { request, input, automationStore } = fixture();
    const created = await request('create', input);
    expect(created.status).toBe(201);
    const schedule = await created.json();
    expect(schedule).toMatchObject({
      status: 'paused',
      revision: 1,
      responsibleUserId: 'user_local',
    });
    const active = await request('update', {
      automationId: schedule.id,
      expectedRevision: 1,
      status: 'active',
      scheduledAt: '2999-01-01T00:00:00.000Z',
    });
    expect(active.status).toBe(200);
    const paused = await request('update', {
      automationId: schedule.id,
      expectedRevision: 2,
      status: 'paused',
    });
    expect(paused.status).toBe(200);
    const edited = await request('update', {
      automationId: schedule.id,
      expectedRevision: 3,
      prompt: 'Updated input',
    });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ revision: 4, prompt: 'Updated input' });
    expect((await request('delete', { automationId: schedule.id })).status).toBe(204);
    expect(await (await request('list', {})).json()).toEqual({ items: [] });
    expect(automationStore.getAutomation(schedule.id).status).toBe('deleted');
  });

  it('rejects cron, short cadence, actor substitution, missing target, stale revision and invalid resume', async () => {
    const { request, input } = fixture();
    for (const invalid of [
      { ...input, cron: '* * * * *' },
      { ...input, intervalSeconds: 4 },
      { ...input, responsibleUserId: 'user_substitute' },
    ])
      expect((await request('create', invalid)).status).toBe(400);
    expect((await request('create', { ...input, threadId: 'th_missing' })).status).toBe(404);
    const schedule = await (await request('create', input)).json();
    expect(
      (
        await request('update', {
          automationId: schedule.id,
          expectedRevision: 99,
          status: 'paused',
        })
      ).status
    ).toBe(409);
    expect(
      (
        await request('update', {
          automationId: schedule.id,
          expectedRevision: 1,
          status: 'active',
        })
      ).status
    ).toBe(409);
  });

  it('lists admitted Workspace definitions without treating the responsible user as a privilege tier', async () => {
    const { db, store, input, automationStore } = fixture();
    const created = automationStore.createAutomation('user_creator', input);
    const operations = createAutomationOperationImplementations({
      coreDb: db,
      store,
      automationStore,
    });
    const context = {
      kind: 'public',
      actor: { kind: 'session', userId: 'user_member' },
      actorRef: { kind: 'user', id: 'user_member' },
      scope: { kind: 'authorized-workspace-set', workspaceIds: [input.workspaceId] },
    } as const;
    expect(await operations['automation.list']({}, context)).toEqual({ items: [created] });
    expect(
      await operations['automation.list'](
        {},
        { ...context, scope: { ...context.scope, workspaceIds: [] } }
      )
    ).toEqual({ items: [] });
    expect(created.actor).toEqual({
      kind: 'automation',
      id: created.id,
      responsibleUserId: 'user_creator',
    });
  });
});

it('paginates lossless ranges directly and joins accepted-but-queued truth without exposing host roots', async () => {
  const { request, input, automationStore, setTime } = fixture();
  const schedule = await (await request('create', { ...input, intervalSeconds: 3600 })).json();
  expect(
    (
      await request('update', {
        automationId: schedule.id,
        expectedRevision: 1,
        status: 'active',
        scheduledAt: '2026-10-16T00:00:00.000Z',
      })
    ).status
  ).toBe(200);
  setTime('2026-10-16T01:00:00.000Z');
  const [occurrence] = automationStore.collectScanCandidates('2026-10-16T01:00:00.000Z');
  automationStore.commitAttempt(occurrence!.id, 2, {
    kind: 'ready',
    payload: {
      backendId: 'private-backend',
      requestedAgentId: 'worker',
      profileRef: 'provider/main',
      modelId: 'model',
      workspaceCwd: '/private/core/working',
      workspaceRoots: [],
    },
  });
  const first = await request('history', { automationId: schedule.id, limit: 1 });
  expect(first.status).toBe(200);
  const firstPage = await first.json();
  expect(firstPage).toMatchObject({
    items: [
      {
        kind: 'occurrence',
        record: {
          state: 'admission-accepted',
          schedulerStatus: 'queued',
          resolvedSelection: { agentId: 'worker', profileId: 'provider/main', modelId: 'model' },
        },
      },
    ],
    nextBefore: '2026-10-16T01:00:00.000Z',
  });
  expect(JSON.stringify(firstPage)).not.toContain('/private/core/working');
  expect(JSON.stringify(firstPage)).not.toContain('private-backend');
  const secondPage = await (
    await request('history', { automationId: schedule.id, limit: 1, before: firstPage.nextBefore })
  ).json();
  expect(secondPage).toMatchObject({
    items: [
      {
        kind: 'expired-range',
        record: {
          firstScheduledAt: '2026-10-16T00:00:00.000Z',
          lastScheduledAt: '2026-10-16T00:00:00.000Z',
          count: 1,
        },
      },
    ],
    nextBefore: null,
  });
});

it('attributes a member edit to the actual caller while preserving the responsible actor', async () => {
  const { db, store, input, automationStore } = fixture();
  const schedule = automationStore.createAutomation('user_creator', input);
  const operations = createAutomationOperationImplementations({
    coreDb: db,
    store,
    automationStore,
  });
  const context = {
    kind: 'public',
    actor: { kind: 'session', userId: 'user_member' },
    actorRef: { kind: 'user', id: 'user_member' },
    scope: {
      kind: 'workspace',
      workspaceId: input.workspaceId,
      effectiveRole: 'editor',
      policyOperation: 'workspace.configure',
    },
    resolvedLineage: { workspaceId: input.workspaceId, ownerUserId: 'user_creator' },
  } as const;
  const edited = await operations['automation.update'](
    { automationId: schedule.id, expectedRevision: 1, name: 'Updated by member' },
    context
  );
  expect(edited.actor).toEqual(schedule.actor);
  expect(
    db.sqlite
      .prepare("SELECT actor_json FROM audit_events WHERE action = 'recurring.schedule.edited'")
      .get()
  ).toEqual({ actor_json: JSON.stringify({ kind: 'user', id: 'user_member' }) });
});
