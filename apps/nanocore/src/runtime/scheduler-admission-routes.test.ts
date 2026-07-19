import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { AuthVariables } from '../auth/middleware.js';
import {
  createSchedulerAdmissionEntry,
  denySchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { registerSchedulerAdmissionRoutes } from './scheduler-admission-routes.js';

describe('scheduler admission routes', () => {
  it('closes workspace databases after scheduler admission audit attempts', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-admission-routes-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Scheduler admission database lifecycle');

    for (const queueEntryId of [
      'queue_retry_close',
      'queue_cancel_close',
      'queue_retry_audit_failure',
    ]) {
      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: `turn_${queueEntryId}`,
        turnInput: 'Exercise scheduler admission database lifecycle.',
        requestedAgentId: 'agent_codex_host',
        profileRef: 'agent_codex_host',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
      });
    }
    for (const queueEntryId of ['queue_retry_close', 'queue_retry_audit_failure']) {
      denySchedulerAdmissionEntry(coreDb, { queueEntryId, denialReason: 'no-healthy-target' });
    }

    const workspaceDbs: WorkspaceDb[] = [];
    let failAudit = false;
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('actor', { kind: 'session', userId: 'user_local' });
      c.set('workspaceAccess', {
        effectiveRole: 'owner',
        kind: 'workspace',
        policyOperation: 'turn.run',
        workspaceId: 'ws_demo',
      });
      await next();
    });
    registerSchedulerAdmissionRoutes({
      app,
      coreDb,
      requestStore: () => store,
      repositoryWorkspaceDb: () => {
        const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
        applyScopedMigrations(workspaceDb);

        if (failAudit) {
          vi.spyOn(workspaceDb.sqlite, 'prepare').mockImplementation(() => {
            throw new Error('Injected audit failure.');
          });
        }

        workspaceDbs.push(workspaceDb);
        return workspaceDb;
      },
    });

    try {
      const retried = await app.request(
        '/api/app/workspaces/ws_demo/scheduler/admissions/queue_retry_close/retry',
        { method: 'POST' }
      );
      const cancelled = await app.request(
        '/api/app/workspaces/ws_demo/scheduler/admissions/queue_cancel_close/cancel',
        { method: 'POST' }
      );
      failAudit = true;
      const auditFailed = await app.request(
        '/api/app/workspaces/ws_demo/scheduler/admissions/queue_retry_audit_failure/retry',
        { method: 'POST' }
      );

      expect(retried.status).toBe(200);
      expect(cancelled.status).toBe(200);
      expect(auditFailed.status).toBe(400);
      expect(workspaceDbs).toHaveLength(3);
      for (const workspaceDb of workspaceDbs) {
        expect(workspaceDb.sqlite.open).toBe(false);
      }
    } finally {
      for (const workspaceDb of workspaceDbs) {
        if (workspaceDb.sqlite.open) {
          workspaceDb.sqlite.close();
        }
      }
      coreDb.sqlite.close();
    }
  });

  it('denies cross-Workspace admissions before mutation while preserving missing behavior', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-admission-ownership-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('actor', { kind: 'session', userId: 'user_local' });
      c.set('workspaceAccess', {
        effectiveRole: 'owner',
        kind: 'workspace',
        policyOperation: 'turn.run',
        workspaceId: 'ws_demo',
      });
      await next();
    });

    for (const queueEntryId of ['queue_foreign_retry', 'queue_foreign_cancel']) {
      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId,
        workspaceId: 'ws_foreign',
        threadId: 'thread_foreign',
        turnId: `turn_${queueEntryId}`,
        turnInput: 'Keep foreign scheduler admission existence private.',
        requestedAgentId: 'agent_codex_host',
        profileRef: 'agent_codex_host',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
      });
    }
    denySchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_foreign_retry',
      denialReason: 'no-healthy-target',
    });
    const repositoryWorkspaceDb = vi.fn(() => {
      throw new Error('Foreign scheduler admissions must fail before opening workspace storage.');
    });
    registerSchedulerAdmissionRoutes({
      app,
      coreDb,
      requestStore: () => store,
      repositoryWorkspaceDb,
    });

    try {
      const missing = await app.request(
        '/api/app/workspaces/ws_demo/scheduler/admissions/queue_missing/retry',
        { method: 'POST' }
      );

      expect(missing.status).toBe(400);
      await expect(missing.json()).resolves.toMatchObject({
        code: 'scheduler_admission_retry_failed',
      });
      for (const [queueEntryId, action, expectedStatus] of [
        ['queue_foreign_retry', 'retry', 'denied'],
        ['queue_foreign_cancel', 'cancel', 'queued'],
      ] as const) {
        const path = `/api/app/workspaces/ws_demo/scheduler/admissions/${queueEntryId}/${action}`;
        const foreign = await app.request(path, { method: 'POST' });

        expect(foreign.status).toBe(403);
        await expect(foreign.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
        expect(
          coreDb.sqlite
            .prepare('SELECT status FROM scheduler_admission_entries WHERE queue_entry_id = ?')
            .get(queueEntryId)
        ).toEqual({ status: expectedStatus });
      }
      expect(repositoryWorkspaceDb).not.toHaveBeenCalled();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('lets an authorized workspace actor manage admissions created by another user', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-admission-user-scope-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('actor', { kind: 'session', userId: 'user_local' });
      c.set('workspaceAccess', {
        effectiveRole: 'owner',
        kind: 'workspace',
        policyOperation: 'turn.run',
        workspaceId: 'ws_demo',
      });
      await next();
    });

    for (const queueEntryId of ['queue_victim_retry', 'queue_victim_cancel']) {
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId,
        triggerActor: { kind: 'user', id: 'user_victim' },
        workspaceId: 'ws_demo',
        threadId: 'thread_victim',
        turnId: `turn_${queueEntryId}`,
        turnInput: 'Keep another user scheduler admission private.',
        requestedAgentId: 'agent_codex_host',
        profileRef: 'agent_codex_host',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
      });
    }
    denySchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_victim_retry',
      denialReason: 'no-healthy-target',
    });
    registerSchedulerAdmissionRoutes({
      app,
      coreDb,
      requestStore: () => store,
      repositoryWorkspaceDb: () => {
        const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
        applyScopedMigrations(workspaceDb);
        return workspaceDb;
      },
    });

    try {
      const listed = await app.request('/api/app/workspaces/ws_demo/scheduler/admissions');

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
        const path = `/api/app/workspaces/ws_demo/scheduler/admissions/${queueEntryId}/${action}`;
        const response = await app.request(path, { method: 'POST' });

        expect(response.status).toBe(200);
        expect(
          coreDb.sqlite
            .prepare('SELECT status FROM scheduler_admission_entries WHERE queue_entry_id = ?')
            .get(queueEntryId)
        ).toEqual({ status: expectedStatus });
      }
    } finally {
      coreDb.sqlite.close();
    }
  });
});
