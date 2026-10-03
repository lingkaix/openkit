import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { type Actor, ensureLocalUser } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import { AutomationStore } from './lib/automation-store.js';
import { registerOperationJsonRoutes } from './operation-json-routes.js';
import {
  createSchedulerAdmissionEntry,
  denySchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from './scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

/** Current credentials and minimum child selectors at the native operation seam. */
describe('execution operation authority', () => {
  it.each([
    'session',
    'token',
  ] as const)('uses current %s administrator eligibility and refuses stale authority before changing child records', async (kind) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-b9-authority-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: 'ws_demo', ownerUserId: 'user_local' });
    const automationStore = new AutomationStore();
    const automation = automationStore.createAutomation('user_other', {
      workspaceId: 'ws_demo',
      name: 'Other owner',
      cron: '*',
      prompt: 'Work',
    });
    const thread = store.createThread('ws_demo', 'Private queue', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'user_other',
    });
    createSchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_admin',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: 'turn_admin',
      triggerActor: { kind: 'user', id: 'user_other' },
      turnInput: 'Work',
      requestedAgentId: 'agent_codex_host',
      priorityClass: 'interactive',
      requiredPoolConstraints: ['openshell.local'],
    });
    denySchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_admin',
      denialReason: 'no-healthy-target',
    });
    let actor: Actor = { kind: 'session', userId: 'user_local' };
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('actor', actor);
      await next();
    });
    registerOperationJsonRoutes({
      app,
      coreDb,
      automationStore,
      requestStore: () => store,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      inflightCommands: new WeakMap(),
      repositoryWorkspaceDb: (id) => {
        const db = openWorkspaceDb(dataRoot, id);
        applyScopedMigrations(db);
        return db;
      },
    });
    try {
      const hidden = await app.request(
        ...operationRequest('automation.delete', { automationId: automation.id })
      );
      expect(hidden.status).toBe(403);
      const queueBefore = requireSchedulerAdmissionEntry(coreDb, 'queue_admin');
      const privateDenied = await app.request(
        ...operationRequest('scheduler.retry', {
          workspaceId: 'ws_demo',
          queueEntryId: 'queue_admin',
        })
      );
      expect(privateDenied.status).toBe(404);
      expect(requireSchedulerAdmissionEntry(coreDb, 'queue_admin')).toEqual(queueBefore);
      expect(automationStore.getAutomation('user_other', automation.id)).toEqual(automation);
      const token = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: 'user_local',
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      actor =
        kind === 'session'
          ? { kind, userId: 'user_local' }
          : {
              kind,
              userId: 'user_local',
              tokenId: token.record.tokenId,
              tokenScope: 'server-admin',
              tokenWorkspaceIds: [],
            };
      const listed = await app.request(...operationRequest('automation.list', {}));
      await expect(listed.json()).resolves.toEqual({ items: [automation] });
      const queueList = await app.request(
        ...operationRequest('scheduler.list', { workspaceId: 'ws_demo' })
      );
      expect(
        (await queueList.json()).items.map((row: { queueEntryId: string }) => row.queueEntryId)
      ).toEqual(['queue_admin']);
      const update = await app.request(
        ...operationRequest('automation.update', { automationId: automation.id, status: 'enabled' })
      );
      expect(update.status).toBe(200);
      const retried = await app.request(
        ...operationRequest('scheduler.retry', {
          workspaceId: 'ws_demo',
          queueEntryId: 'queue_admin',
        })
      );
      expect(retried.status).toBe(200);
      const updated = automationStore.getAutomation('user_other', automation.id);
      const retriedRow = requireSchedulerAdmissionEntry(coreDb, 'queue_admin');
      revokeOpenKitAccessTokenRecord(coreDb, token.record.tokenId);
      expect(
        (
          await app.request(
            ...operationRequest('automation.delete', { automationId: automation.id })
          )
        ).status
      ).toBe(403);
      const cancelled = await app.request(
        ...operationRequest('scheduler.cancel', {
          workspaceId: 'ws_demo',
          queueEntryId: 'queue_admin',
        })
      );
      expect(cancelled.status).toBe(kind === 'token' ? 403 : 404);
      expect(automationStore.getAutomation('user_other', automation.id)).toEqual(updated);
      expect(requireSchedulerAdmissionEntry(coreDb, 'queue_admin')).toEqual(retriedRow);
    } finally {
      coreDb.sqlite.close();
    }
  });
});
