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
    registerSchedulerAdmissionRoutes({
      app,
      coreDb,
      requestStore: () => store,
      repositoryWorkspaceDb: () => {
        const workspaceDb = openWorkspaceDb(dataRoot, store.getUserId(), 'ws_demo');
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

  it('does not reveal whether a scheduler admission belongs to another workspace', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-admission-ownership-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = new Hono<{ Variables: AuthVariables }>();

    for (const queueEntryId of ['queue_foreign_retry', 'queue_foreign_cancel']) {
      createSchedulerAdmissionEntry(coreDb, {
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
    registerSchedulerAdmissionRoutes({
      app,
      coreDb,
      requestStore: () => store,
      repositoryWorkspaceDb: () => {
        throw new Error('Foreign scheduler admissions must fail before opening workspace storage.');
      },
    });

    try {
      for (const [queueEntryId, action] of [
        ['queue_foreign_retry', 'retry'],
        ['queue_foreign_cancel', 'cancel'],
      ] as const) {
        const path = `/api/app/workspaces/ws_demo/scheduler/admissions/${queueEntryId}/${action}`;
        const foreign = await app.request(path, { method: 'POST' });
        const foreignBody = await foreign.json();
        coreDb.sqlite
          .prepare('DELETE FROM scheduler_admission_entries WHERE queue_entry_id = ?')
          .run(queueEntryId);
        const absent = await app.request(path, { method: 'POST' });

        expect(foreign.status).toBe(absent.status);
        expect(foreignBody).toEqual(await absent.json());
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('scopes scheduler admissions by user when workspace ids collide', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-admission-user-scope-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = new Hono<{ Variables: AuthVariables }>();

    for (const queueEntryId of ['queue_victim_retry', 'queue_victim_cancel']) {
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId,
        userId: 'user_victim',
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
        throw new Error('Foreign scheduler admissions must fail before opening workspace storage.');
      },
    });

    try {
      const listed = await app.request('/api/app/workspaces/ws_demo/scheduler/admissions');

      expect(listed.status).toBe(200);
      await expect(listed.json()).resolves.toMatchObject({ items: [] });

      for (const [queueEntryId, action, originalStatus] of [
        ['queue_victim_retry', 'retry', 'denied'],
        ['queue_victim_cancel', 'cancel', 'queued'],
      ] as const) {
        const path = `/api/app/workspaces/ws_demo/scheduler/admissions/${queueEntryId}/${action}`;
        const foreign = await app.request(path, { method: 'POST' });
        const foreignBody = await foreign.json();
        expect(
          coreDb.sqlite
            .prepare('SELECT status FROM scheduler_admission_entries WHERE queue_entry_id = ?')
            .get(queueEntryId)
        ).toEqual({ status: originalStatus });
        coreDb.sqlite
          .prepare('DELETE FROM scheduler_admission_entries WHERE queue_entry_id = ?')
          .run(queueEntryId);
        const absent = await app.request(path, { method: 'POST' });

        expect(foreign.status).toBe(absent.status);
        expect(foreignBody).toEqual(await absent.json());
      }
    } finally {
      coreDb.sqlite.close();
    }
  });
});
