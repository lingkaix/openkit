import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreClient } from '@openkit/core-client';
import { expect, it } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { AutomationStore } from './lib/automation-store.js';
import { FsStore } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

it('projects the same durable lifecycle through HTTP and the derived Core Client', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recurrence-projections-'));
  const coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot: root });
  const workspace = store.createWorkspace('Recurring');
  const thread = store.createThread(workspace.id, 'Target');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: 'user_local' });
  const automationStore = new AutomationStore(coreDb, new WorkspaceMutationAdmission());
  const app = createApp({ store, coreDb, dataRoot: root, automationStore });
  const responses: Response[] = [];
  const client = createCoreClient({
    baseUrl: 'http://nanocore.test',
    fetch: async (url, init) => {
      const response = await app.request(new Request(url, init));
      responses.push(response.clone());
      return response;
    },
  });
  try {
    const record = await client.operations['automation.create']({
      workspaceId: workspace.id,
      threadId: thread.id,
      name: 'Morning',
      intervalSeconds: 60,
      prompt: 'Summarize work',
    });
    expect(responses[0]!.status).toBe(201);
    expect(automationStore.getAutomation(record.id)).toEqual(record);
    expect(
      await client.operations['automation.update']({
        automationId: record.id,
        expectedRevision: record.revision,
        status: 'active',
        scheduledAt: '2999-01-01T00:00:00.000Z',
      })
    ).toMatchObject({ status: 'active', revision: 2 });
    expect(await client.operations['automation.delete']({ automationId: record.id })).toBeNull();
    const deleted = responses.at(-1)!;
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get('content-type')).toBeNull();
    expect(await deleted.text()).toBe('');
    expect(deleted.headers.get('cache-control')).toBe('no-store');
    expect(automationStore.getAutomation(record.id).status).toBe('deleted');
  } finally {
    coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});
