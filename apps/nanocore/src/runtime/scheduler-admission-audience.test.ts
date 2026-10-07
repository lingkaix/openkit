import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';

import type { AuthVariables } from '../auth/middleware.js';
import { registerOperationJsonRoutes } from '../operation-json-routes.js';
import {
  createSchedulerAdmissionEntry,
  denySchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';

describe('scheduler admission thread audience', () => {
  it('hides private Thread queue rows and denies child mutations with a nondisclosing 404', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-admission-audience-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
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
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId,
        workspaceId: 'ws_demo',
        threadId,
        turnId: `turn_${queueEntryId}`,
        turnInput: `Admission for ${threadId}.`,
        requestedAgentId: 'agent_codex_host',
        profileRef: 'agent_codex_host',
      });
    }
    denySchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_foreign_private',
      denialReason: 'authority-denied',
    });
    denySchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_own_private',
      denialReason: 'authority-denied',
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
    registerOperationJsonRoutes({
      app,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      inflightCommands: new WeakMap(),
      coreDb,
      requestStore: () => store,
      repositoryWorkspaceDb,
    });

    try {
      const listed = await app.request(
        ...operationRequest('scheduler.list', { workspaceId: 'ws_demo' })
      );
      const listedBody = await listed.json();

      expect(listed.status).toBe(200);
      expect(
        listedBody.items.map((item: { queueEntryId: string }) => item.queueEntryId).sort()
      ).toEqual(['queue_own_private', 'queue_shared']);
      expect(JSON.stringify(listedBody)).not.toContain(privateThread.id);
      expect(JSON.stringify(listedBody)).not.toContain('queue_foreign_private');

      const hiddenRetry = await app.request(
        ...operationRequest(
          'scheduler.retry',
          { workspaceId: 'ws_demo', queueEntryId: 'queue_foreign_private' },
          { method: 'POST' }
        )
      );
      const hiddenCancel = await app.request(
        ...operationRequest(
          'scheduler.cancel',
          { workspaceId: 'ws_demo', queueEntryId: 'queue_foreign_private' },
          { method: 'POST' }
        )
      );
      const missingRetry = await app.request(
        ...operationRequest(
          'scheduler.retry',
          { workspaceId: 'ws_demo', queueEntryId: 'queue_missing' },
          { method: 'POST' }
        )
      );
      const missingCancel = await app.request(
        ...operationRequest(
          'scheduler.cancel',
          { workspaceId: 'ws_demo', queueEntryId: 'queue_missing' },
          { method: 'POST' }
        )
      );
      const hiddenRetryText = await hiddenRetry.text();
      const hiddenCancelText = await hiddenCancel.text();
      const missingRetryText = await missingRetry.text();
      const missingCancelText = await missingCancel.text();

      expect(hiddenRetry.status).toBe(404);
      expect(hiddenCancel.status).toBe(404);
      expect(missingRetry.status).toBe(hiddenRetry.status);
      expect(missingCancel.status).toBe(hiddenCancel.status);
      expect(JSON.parse(hiddenRetryText)).toEqual({
        protocolVersion: '0.5.0',
        code: 'not_found',
        message: 'Thread not found.',
      });
      expect(JSON.parse(hiddenCancelText)).toEqual({
        protocolVersion: '0.5.0',
        code: 'not_found',
        message: 'Thread not found.',
      });
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
