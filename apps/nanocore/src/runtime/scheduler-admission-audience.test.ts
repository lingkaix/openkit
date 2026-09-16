import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { AuthVariables } from '../auth/middleware.js';
import {
  createSchedulerAdmissionEntry,
  denySchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { registerSchedulerAdmissionRoutes } from './scheduler-admission-routes.js';

describe('scheduler admission thread audience', () => {
  it('hides private Thread queue rows and denies child mutations with a nondisclosing 404', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-admission-audience-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const shared = store.createThread('ws_demo', 'Shared admission');
    const privateThread = store.createThread(
      'ws_demo',
      'SECRET_PRIVATE_ADMISSION',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: 'user_outsider' }
    );
    const ownPrivate = store.createThread(
      'ws_demo',
      'Owner private admission',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: 'user_local' }
    );

    for (const [queueEntryId, threadId] of [
      ['queue_shared', shared.id],
      ['queue_foreign_private', privateThread.id],
      ['queue_own_private', ownPrivate.id],
    ] as const) {
      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId,
        workspaceId: 'ws_demo',
        threadId,
        turnId: `turn_${queueEntryId}`,
        turnInput: `Admission for ${threadId}.`,
        requestedAgentId: 'agent_codex_host',
        profileRef: 'agent_codex_host',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
      });
    }
    denySchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_foreign_private',
      denialReason: 'no-healthy-target',
    });
    denySchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_own_private',
      denialReason: 'no-healthy-target',
    });

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
    const repositoryWorkspaceDb = vi.fn(() => {
      throw new Error('Private Thread admissions must fail before opening workspace storage.');
    });
    registerSchedulerAdmissionRoutes({
      app,
      coreDb,
      requestStore: () => store,
      repositoryWorkspaceDb,
    });

    try {
      const listed = await app.request('/api/app/workspaces/ws_demo/scheduler/admissions');
      const listedBody = await listed.json();

      expect(listed.status).toBe(200);
      expect(
        listedBody.items.map((item: { queueEntryId: string }) => item.queueEntryId).sort()
      ).toEqual(['queue_own_private', 'queue_shared']);
      expect(JSON.stringify(listedBody)).not.toContain(privateThread.id);
      expect(JSON.stringify(listedBody)).not.toContain('queue_foreign_private');

      const hiddenRetry = await app.request(
        '/api/app/workspaces/ws_demo/scheduler/admissions/queue_foreign_private/retry',
        { method: 'POST' }
      );
      const hiddenCancel = await app.request(
        '/api/app/workspaces/ws_demo/scheduler/admissions/queue_foreign_private/cancel',
        { method: 'POST' }
      );
      const missingRetry = await app.request(
        '/api/app/workspaces/ws_demo/scheduler/admissions/queue_missing/retry',
        { method: 'POST' }
      );
      const missingCancel = await app.request(
        '/api/app/workspaces/ws_demo/scheduler/admissions/queue_missing/cancel',
        { method: 'POST' }
      );
      const hiddenRetryText = await hiddenRetry.text();
      const hiddenCancelText = await hiddenCancel.text();
      const missingRetryText = await missingRetry.text();
      const missingCancelText = await missingCancel.text();

      expect(hiddenRetry.status).toBe(404);
      expect(hiddenCancel.status).toBe(404);
      expect(missingRetry.status).toBe(hiddenRetry.status);
      expect(missingCancel.status).toBe(hiddenCancel.status);
      expect(hiddenRetryText).toBe('Thread not found.');
      expect(hiddenCancelText).toBe('Thread not found.');
      expect(missingRetryText).toBe(hiddenRetryText);
      expect(missingCancelText).toBe(hiddenCancelText);
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_admission_entries WHERE queue_entry_id = ?')
          .get('queue_foreign_private')
      ).toEqual({ status: 'denied' });
      expect(repositoryWorkspaceDb).not.toHaveBeenCalled();
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });
});
