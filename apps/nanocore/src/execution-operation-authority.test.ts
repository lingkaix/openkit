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
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { testEntityId } from './test-support/entity-ids.js';
import { FIXTURE_LOCAL_USER_ID } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

/** Current credentials and minimum child selectors at the native operation seam. */
describe('execution operation authority', () => {
  it.each([
    'session',
    'token',
  ] as const)('uses current %s Workspace authority and preserves private child and revoked credential boundaries', async (kind) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-b9-authority-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: DEMO_WORKSPACE_ID,
      ownerUserId: FIXTURE_LOCAL_USER_ID,
    });
    const workspaceMutationAdmission = new WorkspaceMutationAdmission();
    const automationStore = new AutomationStore(coreDb, workspaceMutationAdmission);
    const automation = automationStore.createAutomation(testEntityId('usr', 'user_other'), {
      workspaceId: DEMO_WORKSPACE_ID,
      name: 'Other owner',
      intervalSeconds: 60,
      threadId: DEMO_THREAD_ID,
      prompt: 'Work',
    });
    const thread = store.createThread(
      DEMO_WORKSPACE_ID,
      'Private queue',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: testEntityId('usr', 'user_other'),
      }
    );
    createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: 'queue_admin',
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: thread.id,
      turnId: testEntityId('tu', 'turn_admin'),
      triggerActor: { kind: 'user', id: testEntityId('usr', 'user_other') },
      turnInput: 'Work',
      requestedAgentId: 'agent_codex_host',
    });
    denySchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_admin',
      denialReason: 'authority-denied',
    });
    let actor: Actor = { kind: 'session', userId: FIXTURE_LOCAL_USER_ID };
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
      workspaceMutationAdmission,
      inflightCommands: new WeakMap(),
      repositoryWorkspaceDb: (id) => {
        const db = openWorkspaceDb(dataRoot, id);
        applyScopedMigrations(db);
        return db;
      },
    });
    try {
      const memberEdit = await app.request(
        ...operationRequest('automation.update', {
          automationId: automation.id,
          expectedRevision: 1,
          name: 'Edited by Workspace owner',
        })
      );
      expect(memberEdit.status, await memberEdit.clone().text()).toBe(200);
      const edited = automationStore.getAutomation(automation.id);
      expect(edited).toMatchObject({
        name: 'Edited by Workspace owner',
        revision: 2,
        responsibleUserId: testEntityId('usr', 'user_other'),
        actor: automation.actor,
      });
      expect(
        coreDb.sqlite
          .prepare("SELECT actor_json FROM audit_events WHERE action = 'recurring.schedule.edited'")
          .get()
      ).toEqual({ actor_json: JSON.stringify({ kind: 'user', id: FIXTURE_LOCAL_USER_ID }) });
      const queueBefore = requireSchedulerAdmissionEntry(coreDb, 'queue_admin');
      const privateDenied = await app.request(
        ...operationRequest('scheduler.retry', {
          workspaceId: DEMO_WORKSPACE_ID,
          queueEntryId: 'queue_admin',
        })
      );
      expect(privateDenied.status).toBe(404);
      expect(requireSchedulerAdmissionEntry(coreDb, 'queue_admin')).toEqual(queueBefore);
      expect(automationStore.getAutomation(automation.id)).toEqual(edited);
      const token = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: FIXTURE_LOCAL_USER_ID,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      actor =
        kind === 'session'
          ? { kind, userId: FIXTURE_LOCAL_USER_ID }
          : {
              kind,
              userId: FIXTURE_LOCAL_USER_ID,
              tokenId: token.record.tokenId,
              tokenScope: 'server-admin',
              tokenWorkspaceIds: [],
            };
      const listed = await app.request(...operationRequest('automation.list', {}));
      await expect(listed.json()).resolves.toEqual({ items: [edited] });
      const queueList = await app.request(
        ...operationRequest('scheduler.list', { workspaceId: DEMO_WORKSPACE_ID })
      );
      expect(
        (await queueList.json()).items.map((row: { queueEntryId: string }) => row.queueEntryId)
      ).toEqual(['queue_admin']);
      const update = await app.request(
        ...operationRequest('automation.update', {
          automationId: automation.id,
          expectedRevision: 2,
          status: 'active',
          scheduledAt: '2999-01-01T00:00:00.000Z',
        })
      );
      expect(update.status).toBe(200);
      const retried = await app.request(
        ...operationRequest('scheduler.retry', {
          workspaceId: DEMO_WORKSPACE_ID,
          queueEntryId: 'queue_admin',
        })
      );
      expect(retried.status).toBe(200);
      const updated = automationStore.getAutomation(automation.id);
      const retriedRow = requireSchedulerAdmissionEntry(coreDb, 'queue_admin');
      revokeOpenKitAccessTokenRecord(coreDb, token.record.tokenId);
      const deletion = await app.request(
        ...operationRequest('automation.delete', { automationId: automation.id })
      );
      expect(deletion.status).toBe(kind === 'token' ? 403 : 204);
      if (kind === 'session') {
        expect(automationStore.getAutomation(automation.id)).toMatchObject({
          status: 'deleted',
          responsibleUserId: testEntityId('usr', 'user_other'),
          actor: automation.actor,
        });
        expect(
          coreDb.sqlite
            .prepare(
              "SELECT actor_json FROM audit_events WHERE action = 'recurring.schedule.deleted'"
            )
            .get()
        ).toEqual({ actor_json: JSON.stringify({ kind: 'user', id: FIXTURE_LOCAL_USER_ID }) });
      } else {
        expect(automationStore.getAutomation(automation.id)).toEqual(updated);
      }
      const cancelled = await app.request(
        ...operationRequest('scheduler.cancel', {
          workspaceId: DEMO_WORKSPACE_ID,
          queueEntryId: 'queue_admin',
        })
      );
      expect(cancelled.status).toBe(kind === 'token' ? 403 : 404);
      expect(requireSchedulerAdmissionEntry(coreDb, 'queue_admin')).toEqual(retriedRow);
    } finally {
      coreDb.sqlite.close();
    }
  });
});
