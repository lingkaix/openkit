import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createAppWithLocalIdentity as createApp } from '../test-support/app.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';

describe('raw Workspace configuration Policy edits', () => {
  it('requires the confirmed request path to remove a boundary but permits an unchanged Policy sibling', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'resource-policy-confirmation-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    try {
      const store = new FsStore({ dataRoot });
      const workspace = store.createWorkspace('Managed Workspace');
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: workspace.id,
        ownerUserId: FIXTURE_LOCAL_USER_ID,
      });
      const thread = store.createThread(workspace.id, 'Managed Thread');
      const source = {
        requiredFeatures: ['openkit.workspace-resource-policy.v1'],
        workspace: {
          name: 'Managed Workspace',
          policy: {
            resourceAccess: [
              { resource: { family: 'thread', id: thread.id }, grants: [], prohibitions: [] },
            ],
          },
        },
      };
      const configPath = join(dataRoot, 'workspaces', workspace.id, 'config', 'workspace.jsonc');
      writeFileSync(configPath, JSON.stringify(source));
      const app = createApp({ dataRoot, coreDb, store });
      const send = (operation: string, body: unknown) =>
        app.request(`/api/app/operations/${operation}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const id = `workspaces/${workspace.id}/workspace.jsonc`;
      const read = await send('runtime.file-read', { id });
      expect(read.status).toBe(200);
      const { file } = (await read.json()) as { file: { revision: string } };
      const widened = {
        ...source,
        workspace: { ...source.workspace, policy: { resourceAccess: [] } },
      };
      const refused = await send('runtime.file-update', {
        id,
        kind: 'workspace',
        content: JSON.stringify(widened),
        expectedRevision: file.revision,
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: 'resource_policy_confirmation_required' });
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(source);
      const unchangedPolicy = {
        ...source,
        workspace: { ...source.workspace, name: 'Renamed Workspace' },
      };
      const renamed = await send('runtime.file-update', {
        id,
        kind: 'workspace',
        content: JSON.stringify(unchangedPolicy),
        expectedRevision: file.revision,
      });
      expect(renamed.status).toBe(200);
      expect(JSON.parse(readFileSync(configPath, 'utf8')).workspace).toMatchObject({
        name: 'Renamed Workspace',
        policy: source.workspace.policy,
      });
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
