import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationHttpPath } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { AutomationStore } from './lib/automation-store.js';
import {
  createSchedulerAdmissionEntry,
  denySchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from './scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Real authorized former bindings and their exact protected records. */
describe('migrated execution route retirement', () => {
  it.each([
    'automation.list',
    'automation.create',
    'automation.update',
    'automation.delete',
    'scheduler.list',
    'scheduler.retry',
    'scheduler.cancel',
    'recovery.worker-list',
    'recovery.checkpoint-retry',
  ] as const)('retires %s without changing its owner', async (operation) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-b9-retirement-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: 'ws_demo', ownerUserId: 'user_local' });
    const automationStore = new AutomationStore();
    const automation = automationStore.createAutomation('user_local', {
      workspaceId: 'ws_demo',
      name: 'Retained',
      cron: '*',
      prompt: 'Work',
    });
    const thread = store.createThread('ws_demo', 'Retirement');
    const turn = store.createTurn('ws_demo', thread.id, 'Original', {
      kind: 'user',
      id: 'user_local',
    });
    store.updateTurn(turn.id, { status: 'interrupted', completedAt: new Date().toISOString() });
    createSchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_retirement',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      triggerActor: { kind: 'user', id: 'user_local' },
      turnInput: 'Work',
      requestedAgentId: 'agent_codex_host',
      priorityClass: 'interactive',
      requiredPoolConstraints: ['openshell.local'],
    });
    if (operation === 'scheduler.retry')
      denySchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_retirement',
        denialReason: 'no-compatible-pool',
      });
    const beforeQueue = requireSchedulerAdmissionEntry(coreDb, 'queue_retirement');
    const beforeTurn = { ...store.getTurnById(turn.id) };
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    const recoveryScope = { workspaceId: 'ws_demo', threadId: thread.id, turnId: turn.id };
    const app = createApp({ coreDb, dataRoot, store, automationStore });
    const binding = {
      'automation.list': ['GET', '/api/app/automations', undefined],
      'automation.create': [
        'POST',
        '/api/app/automations',
        { workspaceId: 'ws_demo', name: 'Unexpected', cron: '*', prompt: 'Work' },
      ],
      'automation.update': [
        'PATCH',
        `/api/app/automations/${automation.id}`,
        { status: 'enabled' },
      ],
      'automation.delete': ['DELETE', `/api/app/automations/${automation.id}`, undefined],
      'scheduler.list': ['GET', '/api/app/workspaces/ws_demo/scheduler/admissions', undefined],
      'scheduler.retry': [
        'POST',
        '/api/app/workspaces/ws_demo/scheduler/admissions/queue_retirement/retry',
        undefined,
      ],
      'scheduler.cancel': [
        'POST',
        '/api/app/workspaces/ws_demo/scheduler/admissions/queue_retirement/cancel',
        undefined,
      ],
      'recovery.worker-list': ['GET', '/api/app/recovery/interrupted-workers', undefined],
      'recovery.checkpoint-retry': [
        'POST',
        `/api/app/workspaces/ws_demo/threads/${thread.id}/recovery/interrupted-worker/${turn.id}/retry`,
        { requestId: 'req_retirement' },
      ],
    }[operation];
    try {
      const response = await app.request(binding[1] as string, {
        method: binding[0] as string,
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': 'req_retirement' },
        ...(binding[2] ? { body: JSON.stringify(binding[2]) } : {}),
      });
      expect(response.status, await response.text()).toBe(404);
      expect(automationStore.listAutomations('user_local')).toEqual([automation]);
      expect(requireSchedulerAdmissionEntry(coreDb, 'queue_retirement')).toEqual(beforeQueue);
      expect(store.getTurnById(turn.id)).toEqual(beforeTurn);
      expect(
        store.getCommandRequest(
          'worker.recovery.retry',
          'req_retirement',
          recoveryScope,
          workspaceDb
        )
      ).toBeNull();
      const input = {
        'automation.list': {},
        'automation.create': {
          workspaceId: 'ws_demo',
          name: 'Unexpected',
          cron: '*',
          prompt: 'Work',
        },
        'automation.update': { automationId: automation.id, status: 'enabled' },
        'automation.delete': { automationId: automation.id },
        'scheduler.list': { workspaceId: 'ws_demo' },
        'scheduler.retry': { workspaceId: 'ws_demo', queueEntryId: 'queue_retirement' },
        'scheduler.cancel': { workspaceId: 'ws_demo', queueEntryId: 'queue_retirement' },
        'recovery.worker-list': {},
        'recovery.checkpoint-retry': { ...recoveryScope, requestId: 'req_retirement' },
      }[operation];
      const canonical = await app.request(operationHttpPath(operation), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': 'req_retirement' },
        body: JSON.stringify(input),
      });
      const status =
        operation === 'automation.create'
          ? 201
          : operation === 'automation.delete'
            ? 204
            : operation === 'recovery.checkpoint-retry'
              ? 409
              : 200;
      expect(canonical.status, await canonical.clone().text()).toBe(status);
      if (operation === 'scheduler.retry') {
        await expect(canonical.json()).resolves.toEqual({ retried: true });
        expect(requireSchedulerAdmissionEntry(coreDb, 'queue_retirement').status).toBe('queued');
      } else if (operation === 'scheduler.cancel') {
        await expect(canonical.json()).resolves.toEqual({ cancelled: true });
        expect(requireSchedulerAdmissionEntry(coreDb, 'queue_retirement').status).toBe('cancelled');
      } else if (operation === 'recovery.checkpoint-retry') {
        await expect(canonical.json()).resolves.toMatchObject({ code: 'recovery_required' });
        expect(store.getTurnById(turn.id)).toEqual(beforeTurn);
        expect(
          store.getCommandRequest(
            'worker.recovery.retry',
            'req_retirement',
            recoveryScope,
            workspaceDb
          )
        ).toBeNull();
      } else if (operation === 'automation.delete') {
        expect(await canonical.text()).toBe('');
        expect(automationStore.listAutomations('user_local')).toEqual([]);
      } else if (operation === 'automation.update') {
        expect(automationStore.getAutomation('user_local', automation.id)).toMatchObject({
          status: 'enabled',
        });
      } else if (operation === 'automation.create') {
        expect(automationStore.listAutomations('user_local')).toHaveLength(2);
      }
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
