// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker, WorkerOptions } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listSqliteAuditEvents, recordServerAuditEvent } from '../audit-events.js';
import { AutomationStore } from '../lib/automation-store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { workspaceMembershipDecisionFixture } from '../test-support/resource-policy.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { acceptWorkspaceInvitation, createWorkspaceInvitation } from '../workspace-sharing.js';
import {
  commandRequestKey,
  readCommandRequestRecordsFromSqlite,
} from './command-request-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { insertExternalTriggerAdmission } from './external-trigger-admissions.js';
import { applyMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

const interception = vi.hoisted(() => ({
  gate: undefined as SharedArrayBuffer | undefined,
  path: '',
  workers: [] as NativeWorker[],
}));

// Reuses the real client test's COMMIT boundary: genuine SQL executes before host termination.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        if (interception.gate) {
          const require = createRequire(import.meta.url);
          const entry = options?.eval
            ? String(filename)
            : `import(${JSON.stringify(String(filename))});`;
          const prelude = `
            const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
            const gate = new Int32Array(require('node:worker_threads').workerData.deletionGate);
            const exec = Database.prototype.exec;
            Database.prototype.exec = function(sql) {
              const result = exec.call(this, sql);
              if (this.name === ${JSON.stringify(interception.path)} && /^COMMIT$/i.test(sql)
                  && Atomics.compareExchange(gate, 2, 1, 0) === 1) {
                Atomics.store(gate, 0, 1);
                Atomics.wait(gate, 1, 0);
              }
              return result;
            };
          `;
          super(prelude + entry, {
            ...options,
            eval: true,
            workerData: { ...options?.workerData, deletionGate: interception.gate },
          });
          interception.workers.push(this);
        } else super(filename, options);
      }
    },
  };
});

const roots: string[] = [];
const handles: CoreDb[] = [];
const freezeReleases: (() => void)[] = [];
afterEach(async () => {
  if (interception.gate) {
    const gate = new Int32Array(interception.gate);
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
  }
  await shutdownControlStoreWorkerClient();
  for (const release of freezeReleases.splice(0)) release();
  interception.gate = undefined;
  interception.path = '';
  interception.workers.length = 0;
  for (const db of handles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Reads the actual complete SQL tuple on a separate read-only connection. */
function retained(path: string, workspaceId: string) {
  const reader = new Database(path, { readonly: true, fileMustExist: true });
  try {
    reader.pragma('query_only = ON');
    return {
      registry: reader
        .prepare('SELECT * FROM workspace_registry WHERE workspace_id = ?')
        .get(workspaceId),
      members: reader
        .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? ORDER BY user_id')
        .all(workspaceId) as Array<Record<string, unknown>>,
      invitations: reader
        .prepare(
          'SELECT * FROM workspace_invitations WHERE workspace_id = ? ORDER BY invitation_id'
        )
        .all(workspaceId) as Array<Record<string, unknown>>,
      schedules: reader
        .prepare('SELECT * FROM recurring_schedules WHERE workspace_id = ? ORDER BY id')
        .all(workspaceId),
      occurrences: reader
        .prepare('SELECT * FROM recurring_occurrences WHERE workspace_id = ? ORDER BY id')
        .all(workspaceId),
      ranges: reader
        .prepare('SELECT * FROM recurring_expired_ranges WHERE workspace_id = ? ORDER BY id')
        .all(workspaceId),
      // No join: a dangling child must still be visible after a wrong parent-first purge.
      external: reader
        .prepare('SELECT * FROM external_trigger_admissions ORDER BY schedule_id, event_key')
        .all(),
      audit: listSqliteAuditEvents(reader, workspaceId),
      receipts: readCommandRequestRecordsFromSqlite(reader),
    };
  } finally {
    reader.close();
  }
}

/** Uses existing domain owners for membership and every recurring/external graph edge. */
async function fixture(lostAck = false) {
  const root = mkdtempSync(join(tmpdir(), 'native-workspace-delete-'));
  roots.push(root);
  const coreDb = openCoreDb(root);
  handles.push(coreDb);
  applyMigrations(coreDb);
  const actorId = ensureLocalUser(coreDb);
  const workspaceId = allocateEntityId('ws');
  const threadId = allocateEntityId('th');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: actorId });
  const memberId = allocateEntityId('usr');
  const inviteeId = allocateEntityId('usr');
  // This is the native Core owner's own canonical-User fixture, not a lifecycle or receipt bypass.
  for (const userId of [memberId, inviteeId])
    coreDb.sqlite
      .prepare(`INSERT INTO users
    (id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at)
    VALUES (?, ?, ?, false, ?, ?, 'human', 'active', NULL)`)
      .run(userId, userId, `${userId}@example.com`, Date.now(), Date.now());
  const invite = (userId: string) =>
    coreDb.sqlite.transaction(() =>
      createWorkspaceInvitation({
        coreDb,
        workspaceId,
        inviterUserId: actorId,
        inviteeEmail: `${userId}@example.com`,
        authorization: workspaceMembershipDecisionFixture(coreDb, actorId, workspaceId),
      })
    )();
  const accepted = invite(memberId);
  if (accepted.kind !== 'created') throw new Error('Owner fixture could not invite its member.');
  const member = coreDb.sqlite.transaction(() =>
    acceptWorkspaceInvitation({
      coreDb,
      invitationId: accepted.invitation.invitationId,
      inviteeUserId: memberId,
      expectedRevision: 1,
    })
  )();
  expect(member.kind).toBe('accepted');
  const pending = invite(inviteeId);
  if (pending.kind !== 'created')
    throw new Error('Owner fixture could not create a pending invitation.');

  let instant = '2026-10-16T00:00:00.000Z';
  const admission = new WorkspaceMutationAdmission();
  const schedules = new AutomationStore(coreDb, admission, () => instant);
  const schedule = await schedules.createAutomation(actorId, {
    workspaceId,
    threadId,
    name: 'Retained deletion graph',
    prompt: 'Inspect history.',
    intervalSeconds: 3600,
  });
  await schedules.updateAutomation(actorId, schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: instant,
  });
  const occurrence = schedules.collectScanCandidates(instant)[0]!;
  for (let attempt = 0; attempt < 3; attempt++)
    await schedules.commitAttempt(occurrence.id, 2, {
      kind: 'failure',
      code: 'selection_unavailable',
    });
  instant = '2026-10-16T03:10:00.000Z';
  schedules.collectScanCandidates(instant);
  coreDb.sqlite.transaction(() => {
    const entry = createSchedulerAdmissionEntry(coreDb, {
      queueEntryId: `external-${randomUUID()}`,
      backendId: 'nanohost',
      requestedAgentId: 'fixture-worker',
      workspaceId,
      threadId,
      turnId: allocateEntityId('tu'),
      turnInput: 'Retained external event.',
      triggerActor: schedule.actor,
    });
    insertExternalTriggerAdmission(coreDb, {
      scheduleId: schedule.id,
      eventKey: 'source/retained-event',
      sourceTurnId: allocateEntityId('tu'),
      queueEntryId: entry.queueEntryId,
    });
  })();
  const untouchedAudit = recordServerAuditEvent({
    coreDb,
    workspaceId,
    action: 'recurring.unrecognized-core-action',
    resource: schedule.id,
    outcome: 'succeeded',
    summary: 'This action is outside the selected recurring Audit set.',
  });
  const selectedAuditIds = listSqliteAuditEvents(coreDb.sqlite, workspaceId, true).map(
    (event) => event.id
  );
  expect(selectedAuditIds.length).toBeGreaterThan(0);
  const scope = nativeProductScope(root, { kind: 'server' });
  const before = retained(scope.path, workspaceId);
  expect(
    [before.schedules, before.occurrences, before.ranges, before.external].every(
      (rows) => rows.length > 0
    )
  ).toBe(true);
  // Fixture writers finish before the exact native owner is reopened with instrumentation.
  await shutdownControlStoreWorkerClient();
  if (lostAck) {
    interception.gate = new SharedArrayBuffer(12);
    interception.path = scope.path;
  }
  const freeze = admission.tryFreeze(workspaceId, () => []);
  if (freeze.status !== 'frozen') throw new Error('Expected the existing target freeze.');
  freezeReleases.push(freeze.release);
  const client = getControlStoreWorkerClient(admission);
  const database = `core:${scope.path}`;
  const open = {
    database,
    path: scope.path,
    dataRoot: root,
    create: false,
    initialize: 'core' as const,
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  };
  await client.open(open);
  coreDb.sqlite.pragma('query_only = ON');
  expect(() =>
    coreDb.sqlite.prepare('DELETE FROM workspace_registry WHERE workspace_id = ?').run(workspaceId)
  ).toThrowError(expect.objectContaining({ code: 'SQLITE_READONLY' }));
  const request = {
    confirmation: `permanently-delete-workspace:${workspaceId}:1`,
    expectedRegistryRevision: 1,
    requestId: randomUUID(),
  };
  const actor = { kind: 'local' as const, userId: actorId };
  const begin = {
    stage: 'begin' as const,
    workspaceId,
    originalOwnerUserId: actorId,
    expectedRegistryRevision: 1,
    actor,
  };
  const complete = {
    stage: 'complete' as const,
    workspaceId,
    originalOwnerUserId: actorId,
    expectedRegistryRevision: 2,
    actor,
    initiatingUserId: actorId,
    request,
  };
  const receiptScope = { coreId: 'server', actorId, targetWorkspaceId: workspaceId };
  const key = commandRequestKey('workspace.delete', request.requestId, receiptScope);
  return {
    root,
    coreDb,
    path: scope.path,
    workspaceId,
    actorId,
    memberId,
    pendingId: pending.invitation.invitationId,
    before,
    untouchedAudit,
    selectedAuditIds,
    client,
    database,
    open,
    begin,
    complete,
    key,
    receiptScope,
    admission,
    freeze,
    snapshot: () => retained(scope.path, workspaceId),
  };
}

/** Owner predicates: one terminal tuple, selected graph purge, original attribution and original receipt identity. */
function expectComplete(f: Awaited<ReturnType<typeof fixture>>) {
  const tuple = f.snapshot();
  expect(tuple.registry).toMatchObject({
    workspace_id: f.workspaceId,
    owner_user_id: f.actorId,
    status: 'deleted',
    revision: 3,
  });
  expect(tuple.members.find((row) => row.user_id === f.actorId)).toEqual(
    f.before.members.find((row) => row.user_id === f.actorId)
  );
  expect(tuple.members.find((row) => row.user_id === f.memberId)).toMatchObject({
    status: 'removed',
    revision: 2,
    removed_at: expect.any(String),
  });
  expect(tuple.invitations.find((row) => row.invitation_id === f.pendingId)).toMatchObject({
    status: 'revoked',
    revision: 2,
    revoked_at: expect.any(String),
  });
  expect(tuple.schedules).toEqual([]);
  expect(tuple.occurrences).toEqual([]);
  expect(tuple.ranges).toEqual([]);
  expect(tuple.external).toEqual([]);
  expect(tuple.audit.filter((event) => f.selectedAuditIds.includes(event.id))).toEqual([]);
  expect(tuple.audit.find((event) => event.id === f.untouchedAudit.id)).toEqual(f.untouchedAudit);
  const deletion = tuple.audit.filter((event) => event.action === 'workspace.delete');
  expect(deletion).toHaveLength(1);
  expect(tuple.audit).toHaveLength(f.before.audit.length - f.selectedAuditIds.length + 1);
  expect(deletion[0]).toMatchObject({
    actor: { kind: 'user', id: f.actorId },
    workspaceId: f.workspaceId,
    requestId: f.complete.request.requestId,
    resource: `workspace:${f.workspaceId}`,
    resourceRevision: 3,
    outcome: 'succeeded',
  });
  const receipts = tuple.receipts.filter((record) => record.key === f.key);
  expect(receipts).toHaveLength(1);
  expect(tuple.receipts).toHaveLength(f.before.receipts.length + 1);
  expect(receipts[0]).toMatchObject({
    command: 'workspace.delete',
    requestId: f.complete.request.requestId,
    scope: f.receiptScope,
    inputHash: commandInputHash(f.complete.request),
    response: { kind: 'workspace_deletion', id: f.complete.request.requestId },
  });
  expect(Date.parse(receipts[0]!.expiresAt)).toBeGreaterThan(Date.parse(receipts[0]!.createdAt));
  return tuple;
}

describe('native Core Workspace deletion tuple', () => {
  it('commits both original transitions with a query-only Main Core and retains the exact complete tuple after cold reopen', async () => {
    const f = await fixture();
    await expect(f.client.workspaceDeletion(f.database, f.begin, f.freeze)).resolves.toEqual({
      stage: 'begin',
    });
    const begun = f.snapshot();
    expect(begun).toEqual({
      ...f.before,
      registry: expect.objectContaining({
        ...(f.before.registry as object),
        status: 'deleting',
        revision: 2,
        updated_at: expect.any(String),
      }),
    });
    const result = await f.client.workspaceDeletion(f.database, f.complete, f.freeze);
    const committed = expectComplete(f);
    expect(result).toEqual({
      stage: 'complete',
      auditEventId: committed.audit.find((event) => event.action === 'workspace.delete')!.id,
      commandReceiptKey: f.key,
    });
    await shutdownControlStoreWorkerClient();
    f.coreDb.sqlite.close();
    expect(retained(f.path, f.workspaceId)).toEqual(committed);
  }, 30_000);

  it.each([
    'audit',
    'receipt',
  ] as const)('rolls back every SQL tuple member when the late native %s insert fails', async (point) => {
    const f = await fixture();
    await f.client.workspaceDeletion(f.database, f.begin, f.freeze);
    const before = f.snapshot();
    const fault = new Database(f.path, { fileMustExist: true });
    try {
      fault.exec(
        point === 'audit'
          ? `CREATE TRIGGER deletion_late_failure BEFORE INSERT ON audit_events WHEN NEW.action = 'workspace.delete' BEGIN SELECT RAISE(ABORT, 'injected late deletion audit'); END`
          : `CREATE TRIGGER deletion_late_failure BEFORE INSERT ON idempotency_requests WHEN NEW.command_name = 'workspace.delete' BEGIN SELECT RAISE(ABORT, 'injected late deletion receipt'); END`
      );
    } finally {
      fault.close();
    }
    await expect(
      f.client.workspaceDeletion(f.database, f.complete, f.freeze)
    ).rejects.toMatchObject({ commit: 'not-committed' });
    expect(f.snapshot()).toEqual(before);
    const repair = new Database(f.path, { fileMustExist: true });
    try {
      repair.exec('DROP TRIGGER deletion_late_failure');
    } finally {
      repair.close();
    }
    await f.client.workspaceDeletion(f.database, f.complete, f.freeze);
    expectComplete(f);
  }, 30_000);

  it('reports unknown after the actual terminal COMMIT loses its reply and preserves the exact cold tuple without automatic replay', async () => {
    const f = await fixture(true);
    await f.client.workspaceDeletion(f.database, f.begin, f.freeze);
    const gate = new Int32Array(interception.gate!);
    Atomics.store(gate, 2, 1);
    let returned = false;
    const pending = f.client.workspaceDeletion(f.database, f.complete, f.freeze).then(
      (value) => {
        returned = true;
        return value;
      },
      (error: unknown) => {
        returned = true;
        return error;
      }
    );
    await Promise.race([
      (async () => {
        while (Atomics.load(gate, 0) === 0) await nextTurn();
      })(),
      pending.then(() => {
        throw new Error('Terminal request settled before the real COMMIT hold.');
      }),
    ]);
    expect(returned).toBe(false);
    const committed = expectComplete(f);
    expect(interception.workers).toHaveLength(1);
    await interception.workers[0]!.terminate();
    expect(await pending).toMatchObject({ code: 'unavailable', commit: 'unknown' });
    expect(f.snapshot()).toEqual(committed);
    await shutdownControlStoreWorkerClient();
    interception.gate = undefined;
    f.coreDb.sqlite.close();
    expect(retained(f.path, f.workspaceId)).toEqual(committed);
    const next = getControlStoreWorkerClient(f.admission);
    await next.open(f.open);
    expect(retained(f.path, f.workspaceId)).toEqual(committed);
  }, 30_000);
});

/** The original target freeze must still own authority when the existing Core posting hold resumes. */
describe('native Core Workspace deletion tuple', () => {
  it('refuses deferred terminal posting after the exact lifecycle freeze is released without changing any SQL tuple member', async () => {
    const f = await fixture();
    const admission = f.admission;
    const frozen = f.freeze;
    const client = getControlStoreWorkerClient(admission);
    expect(client).toBe(f.client);
    try {
      await client.workspaceDeletion(f.database, f.begin, frozen);
      const before = f.snapshot();
      expect(before.registry).toMatchObject({ status: 'deleting', revision: 2 });
      const resume = await client.pauseForDataRootBackup(f.database);
      const { Worker } = await import('node:worker_threads');
      // Observes the real transport; does not replace a handler, acknowledgement, or SQL effect.
      const posted = vi.spyOn(Worker.prototype, 'postMessage');
      let pending: Promise<unknown> | undefined;
      try {
        let settled = false;
        pending = client.workspaceDeletion(f.database, f.complete, frozen).then(
          (value) => {
            settled = true;
            return value;
          },
          (error: unknown) => {
            settled = true;
            return error;
          }
        );
        await nextTurn();
        expect(settled).toBe(false);
        expect(posted).not.toHaveBeenCalled();
        expect(f.snapshot()).toEqual(before);
        frozen.release();
        expect(admission.ownsFreeze(f.workspaceId, frozen)).toBe(false);
        resume();
        expect(await pending).toMatchObject({ code: 'precondition', commit: 'not-committed' });
        expect(posted).not.toHaveBeenCalled();
        expect(f.snapshot()).toEqual(before);
      } finally {
        frozen.release();
        resume();
        if (pending) await pending;
        posted.mockRestore();
      }
    } finally {
      frozen.release();
    }
  }, 30_000);
});

/** Revocation remains a per-effect native authority check even while the original freeze stays current. */
describe('native Core Workspace deletion current administrator credential', () => {
  it.each([
    'begin',
    'complete',
  ] as const)('refuses %s after the distinct administrator bearer is revoked during the existing Core hold', async (stage) => {
    const f = await fixture();
    const { createBetterAuth } = await import('../auth/better-auth.js');
    const { createOpenKitAccessTokenRecord, revokeOpenKitAccessTokenRecord } = await import(
      '../auth/access-token-store.js'
    );
    const { isCurrentDeploymentAdministrator, isWorkspaceOperationAuthorized } = await import(
      '../auth/operation-authorizer.js'
    );
    const { isCanonicalUserActive } = await import('../auth/user-lifecycle.js');
    const owner = openCoreDb(f.root);
    try {
      const auth = createBetterAuth(owner, { env: {} });
      const { user } = await auth.api.signUpEmail({
        body: {
          name: 'Deletion administrator',
          email: `${randomUUID()}@example.invalid`,
          password: randomUUID(),
        },
      });
      expect(user.id).not.toBe(f.actorId);
      const issued = createOpenKitAccessTokenRecord(owner, {
        ownerUserId: user.id,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2999-01-01T00:00:00.000Z',
      });
      const actor = {
        kind: 'token' as const,
        userId: user.id,
        tokenId: issued.tokenId,
        tokenScope: 'server-admin' as const,
      };
      expect(isCurrentDeploymentAdministrator(f.coreDb, actor)).toBe(true);
      expect(
        isWorkspaceOperationAuthorized(f.coreDb, actor, f.workspaceId, {
          mutating: true,
          policyOperation: 'workspace.lifecycle',
        })
      ).toBe(true);
      if (stage === 'complete') await f.client.workspaceDeletion(f.database, f.begin, f.freeze);
      const command =
        stage === 'begin'
          ? { ...f.begin, actor }
          : { ...f.complete, actor, initiatingUserId: user.id };
      const before = f.snapshot();
      const resume = await f.client.pauseForDataRootBackup(f.database);
      const { Worker } = await import('node:worker_threads');
      const posted = vi.spyOn(Worker.prototype, 'postMessage');
      let pending: Promise<unknown> | undefined;
      try {
        let settled = false;
        pending = f.client.workspaceDeletion(f.database, command, f.freeze).then(
          (value) => {
            settled = true;
            return value;
          },
          (error: unknown) => {
            settled = true;
            return error;
          }
        );
        await nextTurn();
        expect(settled).toBe(false);
        expect(posted).not.toHaveBeenCalled();
        expect(f.snapshot()).toEqual(before);
        expect(revokeOpenKitAccessTokenRecord(owner, issued.tokenId)?.status).toBe('revoked');
        expect(isCurrentDeploymentAdministrator(f.coreDb, actor)).toBe(false);
        expect(isCanonicalUserActive(f.coreDb, f.actorId)).toBe(true);
        expect(f.admission.ownsFreeze(f.workspaceId, f.freeze)).toBe(true);
        resume();
        const outcome = await pending;
        // Establish the actual native crossing before the refusal oracle, including on the wire-only red candidate.
        expect(posted).toHaveBeenCalled();
        expect(outcome).toMatchObject({ commit: 'not-committed' });
        expect(f.snapshot()).toEqual(before);
        expect(f.admission.ownsFreeze(f.workspaceId, f.freeze)).toBe(true);
      } finally {
        resume();
        if (pending) await pending;
        posted.mockRestore();
      }
    } finally {
      owner.sqlite.close();
    }
  }, 30_000);
});
