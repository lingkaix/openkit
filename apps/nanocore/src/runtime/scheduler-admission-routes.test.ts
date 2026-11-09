import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { AuthVariables } from '../auth/middleware.js';
import { registerOperationJsonRoutes } from '../operation-json-routes.js';
import {
  createSchedulerAdmissionEntry,
  denySchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';

const receiptFault = vi.hoisted(() => ({
  gate: new SharedArrayBuffer(4),
  message: 'Scheduler fixture Audit INSERT',
}));
const FAULT_MESSAGE = 'Scheduler fixture Audit INSERT';
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  class ReceiptObservedWorker extends actual.Worker {
    constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
      const prelude = String.raw`
        const {workerData}=require('node:worker_threads');
        const Database=require(workerData.receiptFaultSqlite),prepare=Database.prototype.prepare;
        Database.prototype.prepare=function(sql){
          const statement=prepare.call(this,sql),run=statement.run;
          statement.run=function(...args){try{return run.apply(this,args);}catch(error){
            if(error.code?.startsWith('SQLITE_CONSTRAINT')&&error.message===workerData.receiptFaultMessage)Atomics.store(workerData.receiptFaultGate,0,1);
            throw error;
          }};return statement;
        };
      `;
      super(
        prelude +
          (options?.eval ? String(filename) : `import(${JSON.stringify(String(filename))});`),
        {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            receiptFaultSqlite: require.resolve('better-sqlite3'),
            receiptFaultGate: new Int32Array(receiptFault.gate),
            receiptFaultMessage: receiptFault.message,
          },
        }
      );
    }
  }
  return { ...actual, Worker: ReceiptObservedWorker };
});

describe('scheduler admission routes', () => {
  it('closes workspace databases after scheduler admission audit attempts', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-admission-routes-'));
    const coreDb = openCoreDb(dataRoot);
    const workspaceDbs: WorkspaceDb[] = [];
    onTestFinished(() => disposeTestStore(dataRoot, ...workspaceDbs, coreDb));
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Scheduler admission database lifecycle'
    );

    for (const queueEntryId of [
      'queue_retry_close',
      'queue_cancel_close',
      'queue_retry_audit_failure',
    ]) {
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        queueEntryId,
        requestId: `request_${queueEntryId}`,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: thread.id,
        turnId: testEntityId('tu', `turn_${queueEntryId}`),
        turnInput: 'Exercise scheduler admission database lifecycle.',
        requestedAgentId: 'agent_codex_host',
        profileRef: 'agent_codex_host',
      });
    }
    for (const queueEntryId of ['queue_retry_close', 'queue_retry_audit_failure']) {
      denySchedulerAdmissionEntry(coreDb, { queueEntryId, denialReason: 'authority-denied' });
    }

    let failAudit = false;
    Atomics.store(new Int32Array(receiptFault.gate), 0, 0);
    const originalPrepare = Database.prototype.prepare;
    const auditObserver = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      const statement = originalPrepare.call(this, sql),
        run = statement.run;
      statement.run = function (...args: unknown[]) {
        try {
          return Reflect.apply(run, this, args);
        } catch (error) {
          const e = error as { code?: string; message?: string };
          if (e.code?.startsWith('SQLITE_CONSTRAINT') && e.message === FAULT_MESSAGE)
            Atomics.store(new Int32Array(receiptFault.gate), 0, 1);
          throw error;
        }
      };
      return statement;
    });
    onTestFinished(() => auditObserver.mockRestore());
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('actor', { kind: 'session', userId: 'usr_00000000-0000-7000-8000-000000000001' });
      c.set('workspaceAccess', {
        isOwner: true,
        kind: 'workspace',
        policyOperation: 'turn.run',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      await next();
    });
    registerOperationJsonRoutes({
      app,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      inflightCommands: new WeakMap(),
      coreDb,
      requestStore: () => store,
      repositoryWorkspaceDb: () => {
        const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
        applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');

        if (failAudit) {
          workspaceDb.sqlite.exec(
            `CREATE TRIGGER refuse_scheduler_audit BEFORE INSERT ON audit_events WHEN NEW.action='scheduler.admission.retry' AND NEW.resource='scheduler-admission:queue_retry_audit_failure' BEGIN SELECT RAISE(ABORT,'${FAULT_MESSAGE}'); END`
          );
        }

        workspaceDbs.push(workspaceDb);
        return workspaceDb;
      },
    });

    const retried = await app.request(
      ...operationRequest(
        'scheduler.retry',
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          queueEntryId: 'queue_retry_close',
        },
        { method: 'POST' }
      )
    );
    const cancelled = await app.request(
      ...operationRequest(
        'scheduler.cancel',
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          queueEntryId: 'queue_cancel_close',
        },
        { method: 'POST' }
      )
    );
    failAudit = true;
    const auditFailed = await app.request(
      ...operationRequest(
        'scheduler.retry',
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          queueEntryId: 'queue_retry_audit_failure',
        },
        { method: 'POST' }
      )
    );

    expect(retried.status).toBe(200);
    expect(cancelled.status).toBe(200);
    expect(auditFailed.status).toBe(500);
    expect(await auditFailed.text()).toBe('Internal Server Error');
    expect(
      Atomics.load(new Int32Array(receiptFault.gate), 0),
      'The real late Audit SQLite failure was not reached.'
    ).toBe(1);
    expect(workspaceDbs).toHaveLength(3);
    for (const workspaceDb of workspaceDbs) {
      expect(workspaceDb.sqlite.open).toBe(false);
    }
  });

  it('denies missing and cross-Workspace admissions with a nondisclosing 404 before mutation', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-admission-ownership-'));
    const coreDb = openCoreDb(dataRoot);
    onTestFinished(() => disposeTestStore(dataRoot, coreDb));
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('actor', { kind: 'session', userId: 'usr_00000000-0000-7000-8000-000000000001' });
      c.set('workspaceAccess', {
        isOwner: true,
        kind: 'workspace',
        policyOperation: 'turn.run',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      await next();
    });

    for (const queueEntryId of ['queue_foreign_retry', 'queue_foreign_cancel']) {
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        queueEntryId,
        requestId: `request_${queueEntryId}`,
        workspaceId: 'ws_00000000-0000-7f9c-aa14-53566c621405',
        threadId: testEntityId('th', 'thread_foreign'),
        turnId: testEntityId('tu', `turn_${queueEntryId}`),
        turnInput: 'Keep foreign scheduler admission existence private.',
        requestedAgentId: 'agent_codex_host',
        profileRef: 'agent_codex_host',
      });
    }
    denySchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_foreign_retry',
      denialReason: 'authority-denied',
    });
    const repositoryWorkspaceDb = vi.fn(() => {
      throw new Error('Foreign scheduler admissions must fail before opening workspace storage.');
    });
    registerOperationJsonRoutes({
      app,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      inflightCommands: new WeakMap(),
      coreDb,
      requestStore: () => store,
      repositoryWorkspaceDb,
    });

    const missingRetry = await app.request(
      ...operationRequest(
        'scheduler.retry',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', queueEntryId: 'queue_missing' },
        { method: 'POST' }
      )
    );
    const missingCancel = await app.request(
      ...operationRequest(
        'scheduler.cancel',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', queueEntryId: 'queue_missing' },
        { method: 'POST' }
      )
    );
    const missingRetryText = await missingRetry.text();
    const missingCancelText = await missingCancel.text();

    expect(missingRetry.status).toBe(404);
    expect(missingCancel.status).toBe(404);
    expect(JSON.parse(missingRetryText)).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      code: 'not_found',
      message: 'Thread not found.',
    });
    expect(JSON.parse(missingCancelText)).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      code: 'not_found',
      message: 'Thread not found.',
    });
    for (const [queueEntryId, action, expectedStatus] of [
      ['queue_foreign_retry', 'retry', 'denied'],
      ['queue_foreign_cancel', 'cancel', 'queued'],
    ] as const) {
      const foreign = await app.request(
        ...operationRequest(`scheduler.${action}`, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          queueEntryId,
        })
      );
      const foreignText = await foreign.text();

      expect(foreign.status).toBe(action === 'retry' ? missingRetry.status : missingCancel.status);
      expect(foreignText).toBe(action === 'retry' ? missingRetryText : missingCancelText);
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_admission_entries WHERE queue_entry_id = ?')
          .get(queueEntryId)
      ).toEqual({ status: expectedStatus });
    }
    expect(repositoryWorkspaceDb).not.toHaveBeenCalled();
  });

  it('lets an authorized workspace actor manage admissions created by another user', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-admission-user-scope-'));
    const coreDb = openCoreDb(dataRoot);
    onTestFinished(() => disposeTestStore(dataRoot, coreDb));
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const shared = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Shared other-user admission'
    );
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('actor', { kind: 'session', userId: 'usr_00000000-0000-7000-8000-000000000001' });
      c.set('workspaceAccess', {
        isOwner: true,
        kind: 'workspace',
        policyOperation: 'turn.run',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      await next();
    });

    for (const queueEntryId of ['queue_victim_retry', 'queue_victim_cancel']) {
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId,
        requestId: `request_${queueEntryId}`,
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7ed6-81e5-051501208741' },
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: shared.id,
        turnId: testEntityId('tu', `turn_${queueEntryId}`),
        turnInput: 'Shared workspace admission from another actor.',
        requestedAgentId: 'agent_codex_host',
        profileRef: 'agent_codex_host',
      });
    }
    denySchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_victim_retry',
      denialReason: 'authority-denied',
    });
    registerOperationJsonRoutes({
      app,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      inflightCommands: new WeakMap(),
      coreDb,
      requestStore: () => store,
      repositoryWorkspaceDb: () => {
        const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
        applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
        return workspaceDb;
      },
    });

    const listed = await app.request(
      ...operationRequest('scheduler.list', {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    );

    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ queueEntryId: 'queue_victim_retry', status: 'denied' }),
        expect.objectContaining({ queueEntryId: 'queue_victim_cancel', status: 'queued' }),
      ]),
    });

    for (const [queueEntryId, action, expectedStatus] of [
      ['queue_victim_retry', 'retry', 'queued'],
      ['queue_victim_cancel', 'cancel', 'cancelled'],
    ] as const) {
      const response = await app.request(
        ...operationRequest(`scheduler.${action}`, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          queueEntryId,
        })
      );

      expect(response.status).toBe(200);
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_admission_entries WHERE queue_entry_id = ?')
          .get(queueEntryId)
      ).toEqual({ status: expectedStatus });
    }
  });
});
