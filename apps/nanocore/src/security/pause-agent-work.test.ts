import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { closeTestCoreDb, createTestCoreDb } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { SecurityTriggerStore } from './trigger.js';

it('persists administrator pause/unpause, loads it at boot, raises R1, and keeps reads/configuration available', async () => {
  const root = mkdtempSync(join(tmpdir(), 'persistent-agent-pause-'));
  const coreDb = createTestCoreDb(root);
  ensureLocalUser(coreDb);
  createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config/server.jsonc'), '{"schemaVersion":1}');
  const store = await createDemoStore({ dataRoot: root });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    workspaceId: DEMO_WORKSPACE_ID,
  });
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Pause admission');
  const manager = createRuntimeConfigManager({ dataRoot: root });
  const app = createApp({ dataRoot: root, coreDb, store, runtimeConfigManager: manager });
  const trigger = new SecurityTriggerStore(coreDb);
  const invoke = (id: string, body: unknown) =>
    app.request(`/api/app/operations/${id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...((body as { requestId?: string }).requestId
          ? { 'x-openkit-request-id': (body as { requestId: string }).requestId }
          : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    await trigger.enable({ kind: 'local', userId: FIXTURE_LOCAL_USER_ID });
    for (const paused of [true, false]) {
      const read = await (await invoke('runtime.file-read', { id: 'server.jsonc' })).json();
      const response = await invoke('runtime.file-update', {
        id: 'server.jsonc',
        kind: 'server',
        expectedRevision: read.file.revision,
        content: JSON.stringify({ schemaVersion: 1, security: { pauseAgentWork: paused } }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const reload = await invoke('runtime.reload', { dryRun: false, mode: 'safe' });
      expect(reload.status, await reload.clone().text()).toBe(200);
      expect(manager.current().openKitConfig.security?.pauseAgentWork).toBe(paused);
      expect(
        JSON.parse(readFileSync(join(root, 'config/server.jsonc'), 'utf8')).security.pauseAgentWork
      ).toBe(paused);
      expect(
        createRuntimeConfigManager({ dataRoot: root }).current().openKitConfig.security
          ?.pauseAgentWork
      ).toBe(paused);
      expect((await invoke('runtime.file-read', { id: 'server.jsonc' })).status).toBe(200);
      if (paused) {
        const common = {
          workspaceId: DEMO_WORKSPACE_ID,
          threadId: thread.id,
          requestId: randomUUID(),
          input: 'Wait',
        };
        for (const [id, input] of [
          ['turn.start', common],
          ['conversation.submit', { ...common, targetRef: 'internal-role:assistant' }],
          ['task.start', common],
          [
            'goal.create',
            { workspaceId: DEMO_WORKSPACE_ID, requestId: randomUUID(), intent: 'Wait' },
          ],
        ] as const) {
          const refusal = await invoke(id, input);
          expect(refusal.status, `${id}: ${await refusal.clone().text()}`).toBe(503);
          expect(await refusal.json()).toMatchObject({ code: 'agent_work_paused' });
        }
        expect(store.listThreadTurns(DEMO_WORKSPACE_ID, thread.id)).toEqual([]);
      }
      await trigger.detectAudit();
      const detected = (await trigger.readDetections()).events.filter(
        (event) => event.action === 'server.config.update'
      );
      expect(detected).toHaveLength(paused ? 1 : 2);
      expect(
        detected.every(
          (event) =>
            event.status === 'detected' &&
            event.rule === 'R1' &&
            event.notify === 'immediate' &&
            event.missingFields.length === 0
        )
      ).toBe(true);
    }
  } finally {
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(coreDb);
    rmSync(root, { recursive: true, force: true });
  }
});
