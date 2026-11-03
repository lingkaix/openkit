import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutomationRecord } from '@openkit/app-api-schemas';
import { afterEach, expect, it, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import type { Actor } from '../auth/identity.js';
import { isWorkspaceOperationAuthorized } from '../auth/operation-authorizer.js';
import { createAutomationOperationImplementations } from '../automation-operations.js';
import { AutomationMutationError, AutomationStore } from '../lib/automation-store.js';
import { FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

const fixtures: { root: string; db: CoreDb }[] = [];
const start = '2026-11-02T00:00:00.000Z';
const sealedAt = '2026-11-02T00:11:00.000Z';
const otherUser = testEntityId('usr', 'definition-editor');
const definition = {
  workspaceId: testEntityId('ws', 'definition-owner'),
  threadId: testEntityId('th', 'definition-owner'),
  name: 'Inspect status',
  prompt: '  Keep the exact instruction.\nInspect status. 🚀  ',
  intervalSeconds: 60,
  agentId: 'worker-exact',
  profileId: 'provider/exact',
  modelId: 'model-exact',
};

afterEach(async () => {
  for (const { db } of fixtures) if (db.sqlite.open) db.sqlite.pragma('query_only = OFF');
  await shutdownControlStoreWorkerClient();
  for (const { root, db } of fixtures.splice(0)) {
    if (db.sqlite.open) db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Completes real Core setup before the connection-local Main write prohibition. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'automation-definition-owner-'));
  const db = openCoreDb(root);
  fixtures.push({ root, db });
  applyMigrations(db);
  const userId = ensureLocalUser(db);
  recordWorkspaceOwnerMembership({
    coreDb: db,
    workspaceId: definition.workspaceId,
    ownerUserId: userId,
  });
  let timestamp = start;
  const gate = new WorkspaceMutationAdmission();
  const store = new AutomationStore(db, gate, () => timestamp);
  return {
    db,
    userId,
    gate,
    store,
    setTime: (value: string) => {
      timestamp = value;
    },
  };
}

/** Opens the actual existing native owner before making only Main query-only. */
async function prohibitMainWrites(db: CoreDb) {
  const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
  await getControlStoreWorkerClient().open({
    database: `core:${scope.path}`,
    path: scope.path,
    dataRoot: db.dataRoot,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  expect(
    db.sqlite.prepare('SELECT count(*) AS count FROM recurring_schedules').get()
  ).toBeDefined();
  db.sqlite.pragma('query_only = ON');
  expect(db.sqlite.pragma('query_only', { simple: true })).toBe(1);
}

/** Observes all committed Core rows, including untouched families, without writing. */
function coreRows(db: CoreDb) {
  const tables = db.sqlite
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return tables.map(({ name }) => [
    name,
    db.sqlite
      .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
      .all()
      .map((row) => JSON.stringify(row))
      .sort(),
  ]);
}

/** Checks both the public record and the indexed canonical definition after acknowledgement. */
function expectDefinition(db: CoreDb, store: AutomationStore, expected: AutomationRecord) {
  expect(store.getAutomation(expected.id)).toEqual(expected);
  const row = db.sqlite
    .prepare('SELECT * FROM recurring_schedules WHERE id = ?')
    .get(expected.id) as Record<string, unknown>;
  expect({ ...row, record_json: JSON.parse(row.record_json as string) }).toEqual({
    id: expected.id,
    workspace_id: expected.workspaceId,
    responsible_user_id: expected.responsibleUserId,
    status: expected.status,
    revision: expected.revision,
    next_scheduled_at:
      expected.nextScheduledAt === null ? null : Date.parse(expected.nextScheduledAt),
    record_json: expected,
    schema_version: 1,
  });
}

it('publishes exact definitions, old-cadence history and attributed Audit while Main cannot write', async () => {
  const f = fixture();
  await prohibitMainWrites(f.db);
  // Expected RED before cutover: the real create attempts a write on the query-only Main handle.
  const created = await f.store.createAutomation(f.userId, definition);
  const expected: AutomationRecord = {
    ...definition,
    id: created.id,
    responsibleUserId: f.userId,
    actor: { kind: 'automation', id: created.id, responsibleUserId: f.userId },
    status: 'paused',
    revision: 1,
    nextScheduledAt: null,
    greatestAccountedScheduledAt: null,
    createdAt: start,
    updatedAt: start,
    deletedAt: null,
  };
  expect(created).toEqual(expected);
  expectDefinition(f.db, f.store, expected);
  const active = await f.store.updateAutomation(otherUser, created.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: start,
  });
  expect(active).toEqual({ ...expected, status: 'active', revision: 2, nextScheduledAt: start });
  f.setTime(sealedAt);
  const paused = await f.store.updateAutomation(otherUser, created.id, {
    expectedRevision: 2,
    status: 'paused',
  });
  expect(paused).toEqual({
    ...expected,
    revision: 3,
    greatestAccountedScheduledAt: sealedAt,
    updatedAt: sealedAt,
  });
  expectDefinition(f.db, f.store, paused);
  const history = f.store.listHistory(created.id, 128);
  expect(history.nextBefore).toBeNull();
  expect(history.items).toHaveLength(11);
  const snapshot = {
    threadId: definition.threadId,
    actor: expected.actor,
    prompt: definition.prompt,
    agentId: definition.agentId,
    profileId: definition.profileId,
    modelId: definition.modelId,
  };
  const range = history.items.find((entry) => entry.kind === 'expired-range')!;
  expect(range.record).toEqual({
    id: expect.any(String),
    scheduleId: created.id,
    workspaceId: definition.workspaceId,
    definitionRevision: 2,
    intervalSeconds: 60,
    firstScheduledAt: start,
    lastScheduledAt: '2026-11-02T00:01:00.000Z',
    count: 2,
    snapshot,
    reason: 'deadline_elapsed',
    createdAt: sealedAt,
    terminalAt: sealedAt,
  });
  const cancelled = history.items
    .filter((entry) => entry.kind === 'occurrence')
    .map((entry) => entry.record);
  expect(cancelled.map((record) => record.scheduledAt).sort()).toEqual(
    Array.from(
      { length: 10 },
      (_, index) => `2026-11-02T00:${String(index + 2).padStart(2, '0')}:00.000Z`
    )
  );
  for (const occurrence of cancelled) {
    expect(occurrence).toEqual({
      id: expect.any(String),
      requestId: expect.any(String),
      scheduleId: created.id,
      workspaceId: definition.workspaceId,
      definitionRevision: 2,
      scheduledAt: occurrence.scheduledAt,
      deadline: new Date(Date.parse(occurrence.scheduledAt) + 600_000).toISOString(),
      snapshot,
      resolvedPayload: null,
      state: 'cancelled',
      attempts: [],
      queueEntryId: null,
      turnId: null,
      createdAt: sealedAt,
      terminalAt: sealedAt,
    });
  }
  const edited = await f.store.updateAutomation(otherUser, created.id, {
    expectedRevision: 3,
    prompt: '  New instruction.\nKeep exact bytes.  ',
    intervalSeconds: 120,
    agentId: null,
  });
  expect(edited).toEqual({
    ...paused,
    revision: 4,
    prompt: '  New instruction.\nKeep exact bytes.  ',
    intervalSeconds: 120,
    agentId: undefined,
  });
  expect(edited).not.toHaveProperty('agentId');
  const resumed = await f.store.updateAutomation(otherUser, created.id, {
    expectedRevision: 4,
    status: 'active',
    scheduledAt: '2026-11-02T00:12:00.000Z',
  });
  expect(resumed).toEqual({
    ...edited,
    revision: 5,
    status: 'active',
    nextScheduledAt: '2026-11-02T00:12:00.000Z',
  });
  f.setTime('2026-11-02T00:14:00.000Z');
  await f.store.deleteAutomation(otherUser, created.id);
  expectDefinition(f.db, f.store, {
    ...edited,
    revision: 6,
    status: 'deleted',
    greatestAccountedScheduledAt: '2026-11-02T00:14:00.000Z',
    updatedAt: '2026-11-02T00:14:00.000Z',
    deletedAt: '2026-11-02T00:14:00.000Z',
  });
  const deletedHistory = f.store.listHistory(created.id, 128);
  expect(deletedHistory.items.slice(2)).toEqual(history.items);
  expect(deletedHistory.items.slice(0, 2).map((entry) => entry.record)).toEqual(
    ['2026-11-02T00:14:00.000Z', '2026-11-02T00:12:00.000Z'].map((scheduledAt) => ({
      id: expect.any(String),
      requestId: expect.any(String),
      scheduleId: created.id,
      workspaceId: definition.workspaceId,
      definitionRevision: 5,
      scheduledAt,
      deadline: new Date(Date.parse(scheduledAt) + 600_000).toISOString(),
      snapshot: { ...snapshot, prompt: edited.prompt, agentId: undefined },
      resolvedPayload: null,
      state: 'cancelled',
      attempts: [],
      queueEntryId: null,
      turnId: null,
      createdAt: '2026-11-02T00:14:00.000Z',
      terminalAt: '2026-11-02T00:14:00.000Z',
    }))
  );
  const audits = listServerAuditEvents(f.db);
  const definitions = audits
    .filter((event) => event.action.startsWith('recurring.schedule.'))
    .sort((left, right) => left.resourceRevision! - right.resourceRevision!);
  expect(
    definitions.map(
      ({ action, resourceRevision, actor, workspaceId, threadId, resource, outcome, summary }) => ({
        action,
        resourceRevision,
        actor,
        workspaceId,
        threadId,
        resource,
        outcome,
        summary,
      })
    )
  ).toEqual(
    ['create', 'resume', 'pause', 'edit', 'resume', 'delete'].map((action, index) => ({
      action: `recurring.schedule.${action}`,
      resourceRevision: index + 1,
      actor: { kind: 'user', id: index === 0 ? f.userId : otherUser },
      workspaceId: definition.workspaceId,
      threadId: definition.threadId,
      resource: created.id,
      outcome: 'succeeded',
      summary: `Recurring schedule ${action}.`,
    }))
  );
  const terminal = audits.filter((event) => event.action === 'recurring.occurrence.terminal');
  expect(terminal).toHaveLength(12);
  expect(terminal.map((event) => event.resource).sort()).toEqual(
    deletedHistory.items
      .filter((entry) => entry.kind === 'occurrence')
      .map((entry) => entry.record.id)
      .sort()
  );
  for (const event of terminal)
    expect(event).toMatchObject({
      actor: expected.actor,
      workspaceId: definition.workspaceId,
      threadId: definition.threadId,
      outcome: 'cancelled',
      resourceRevision: null,
      summary: 'Recurring occurrence terminal: cancelled.',
    });
  expect(audits.filter((event) => event.action === 'recurring.expired-range.record')).toEqual([
    expect.objectContaining({
      resource: range.record.id,
      actor: expected.actor,
      workspaceId: definition.workspaceId,
      threadId: definition.threadId,
      resourceRevision: 2,
      outcome: 'failed',
      summary:
        'Expired nominal range 2026-11-02T00:00:00.000Z through 2026-11-02T00:01:00.000Z; count 2.',
    }),
  ]);
  const committed = coreRows(f.db);
  await f.store.deleteAutomation(otherUser, created.id);
  expect(coreRows(f.db)).toEqual(committed);
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
});

it('refuses a public definition mutation when its real bearer is revoked after post-open admission', async () => {
  const f = fixture();
  const store = new FsStore({ dataRoot: f.db.dataRoot });
  const workspace = await store.createWorkspace('Definition authorization');
  const thread = await store.createThread(workspace.id, 'Exact public target');
  recordWorkspaceOwnerMembership({
    coreDb: f.db,
    workspaceId: workspace.id,
    ownerUserId: f.userId,
  });
  const input = { ...definition, workspaceId: workspace.id, threadId: thread.id };
  const target = await f.store.createAutomation(f.userId, input);
  const active = await f.store.updateAutomation(f.userId, target.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: start,
  });
  const [pending] = await f.store.collectScanCandidates(start);
  expect(pending?.scheduleId).toBe(target.id);
  const scanned = f.store.getAutomation(target.id);
  expect(scanned).toEqual({
    ...active,
    greatestAccountedScheduledAt: start,
    nextScheduledAt: '2026-11-02T00:01:00.000Z',
  });
  const issued = createOpenKitAccessTokenRecord(f.db, {
    ownerUserId: f.userId,
    scope: 'workspace',
    workspaceIds: [workspace.id],
    expiresAt: '2999-01-01T00:00:00.000Z',
    now: new Date(start),
    secret: `okt_${'a'.repeat(43)}`,
  });
  const actor: Actor = {
    kind: 'token',
    userId: f.userId,
    tokenId: issued.tokenId,
    tokenScope: issued.record.scope,
    tokenWorkspaceIds: [workspace.id],
  };
  const access = { mutating: true, policyOperation: 'workspace.configure' } as const;
  let rechecks = 0;
  const context = {
    kind: 'public',
    actor,
    actorRef: { kind: 'user', id: f.userId },
    scope: { kind: 'workspace', workspaceId: workspace.id },
    resolvedLineage: { workspaceId: workspace.id, ownerUserId: f.userId },
    recheckAdmission: async () => {
      rechecks += 1;
      if (!isWorkspaceOperationAuthorized(f.db, actor, workspace.id, access))
        throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
    },
  } satisfies AdmittedOperationContext;
  const operations = createAutomationOperationImplementations({
    coreDb: f.db,
    store,
    automationStore: f.store,
  });
  expect(isWorkspaceOperationAuthorized(f.db, actor, workspace.id, access)).toBe(true);
  await prohibitMainWrites(f.db);
  // A real admitted public Actor must publish; unconditional refusal cannot satisfy this case.
  const control = await operations['automation.create'](input, context);
  expect(control).toEqual({
    ...input,
    id: control.id,
    responsibleUserId: f.userId,
    actor: { kind: 'automation', id: control.id, responsibleUserId: f.userId },
    status: 'paused',
    revision: 1,
    nextScheduledAt: null,
    greatestAccountedScheduledAt: null,
    createdAt: start,
    updatedAt: start,
    deletedAt: null,
  });
  expectDefinition(f.db, f.store, control);
  expect(rechecks).toBe(1);
  expect(listServerAuditEvents(f.db).filter((event) => event.resource === control.id)).toEqual([
    expect.objectContaining({
      action: 'recurring.schedule.create',
      resourceRevision: 1,
      workspaceId: workspace.id,
      threadId: thread.id,
      actor: { kind: 'user', id: f.userId },
      outcome: 'succeeded',
    }),
  ]);

  f.setTime(sealedAt);
  const client = getControlStoreWorkerClient();
  const submit = client.schedulerAdmission.bind(client);
  let revokedRows: ReturnType<typeof coreRows> | undefined;
  const posted = vi
    .spyOn(client, 'schedulerAdmission')
    .mockImplementation(async (database, request) => {
      expect(rechecks).toBe(2);
      expect(isWorkspaceOperationAuthorized(f.db, actor, workspace.id, access)).toBe(true);
      // Change only the real credential owner after preparation, immediately before native submission.
      const authority = openCoreDb(f.db.dataRoot);
      try {
        expect(
          revokeOpenKitAccessTokenRecord(authority, issued.tokenId, new Date(sealedAt))
        ).toMatchObject({
          tokenId: issued.tokenId,
          status: 'revoked',
          revokedAt: sealedAt,
        });
      } finally {
        authority.sqlite.close();
      }
      expect(isWorkspaceOperationAuthorized(f.db, actor, workspace.id, access)).toBe(false);
      revokedRows = coreRows(f.db);
      return await submit(database, request);
    });
  try {
    const refused = operations['automation.update'](
      { automationId: target.id, expectedRevision: active.revision, status: 'paused' },
      context
    );
    await expect(refused).rejects.toBeInstanceOf(OperationError);
    await expect(refused).rejects.toMatchObject({
      code: 'workspace_access_denied',
      status: 403,
      message: 'Workspace access denied.',
    });
    expect(posted).toHaveBeenCalledOnce();
    expect(revokedRows).toBeDefined();
    expect(coreRows(f.db)).toEqual(revokedRows);
    expect(f.store.getAutomation(target.id)).toEqual(scanned);
    expect(f.store.getOccurrence(pending!.id)).toEqual(pending);
    expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  } finally {
    posted.mockRestore();
  }
});

it('preserves every Core row on frozen, stale-revision and audit-failed definition mutations', async () => {
  const f = fixture();
  const created = await f.store.createAutomation(f.userId, definition);
  const active = await f.store.updateAutomation(f.userId, created.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: start,
  });
  expect(active.status).toBe('active');
  const [pending] = await f.store.collectScanCandidates(start);
  expect(pending?.state).toBe('pending');
  // Reject the final definition Audit after old-cadence rows have been prepared.
  f.db.sqlite.exec(
    "CREATE TRIGGER reject_definition_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'recurring.schedule.pause' BEGIN SELECT RAISE(ABORT, 'definition audit rejected'); END;"
  );
  await prohibitMainWrites(f.db);
  f.setTime(sealedAt);
  const before = coreRows(f.db);
  const freeze = f.gate.tryFreeze(definition.workspaceId, () => []);
  expect(freeze.status).toBe('frozen');
  if (freeze.status !== 'frozen') throw new Error('Fixture did not freeze the Workspace.');
  try {
    const mutations = [
      () => f.store.createAutomation(otherUser, definition),
      () =>
        f.store.updateAutomation(otherUser, created.id, {
          expectedRevision: active.revision,
          status: 'paused',
        }),
      () => f.store.deleteAutomation(otherUser, created.id),
    ];
    for (const mutate of mutations) {
      const result = Promise.resolve().then(async () => {
        await mutate();
      });
      await expect(result).rejects.toBeInstanceOf(AutomationMutationError);
      await expect(result).rejects.toThrow(/^Workspace mutations are fenced\.$/);
      expect(coreRows(f.db)).toEqual(before);
    }
  } finally {
    freeze.release();
  }
  const stale = Promise.resolve().then(() =>
    f.store.updateAutomation(otherUser, created.id, { expectedRevision: 1, status: 'paused' })
  );
  await expect(stale).rejects.toBeInstanceOf(AutomationMutationError);
  await expect(stale).rejects.toThrow(/^Recurring schedule revision or lifecycle conflicts\.$/);
  expect(coreRows(f.db)).toEqual(before);
  // The native fault boundary returns closed failure facts, never SQLite trigger diagnostics.
  const auditFailure = Promise.resolve().then(() =>
    f.store.updateAutomation(otherUser, created.id, {
      expectedRevision: active.revision,
      status: 'paused',
    })
  );
  await expect(auditFailure).rejects.toBeInstanceOf(ControlStoreWorkerError);
  await expect(auditFailure).rejects.toMatchObject({
    name: 'ControlStoreWorkerError',
    code: 'constraint',
    commit: 'not-committed',
    message: 'Control database writer operation failed.',
  });
  expect(coreRows(f.db)).toEqual(before);
  expect(f.store.getOccurrence(pending!.id)).toEqual(pending);
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
});
