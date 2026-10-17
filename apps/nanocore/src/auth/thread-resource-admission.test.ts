import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_RESOURCE_POLICY_FEATURE, WorkspaceConfigSchema } from '@openkit/config-schema';
import * as policyKernel from '@openkit/policy-kernel';
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';

describe('managed Thread native admission', () => {
  it('decides the concrete operation once and excludes a revoked Thread from shared lists', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'resource-native-admission-'));
    const db = openCoreDb(dataRoot);
    applyMigrations(db);
    ensureLocalUser(db);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Managed admission');
    recordWorkspaceOwnerMembership({
      coreDb: db,
      workspaceId: workspace.id,
      ownerUserId: FIXTURE_LOCAL_USER_ID,
    });
    const thread = store.createThread(workspace.id, 'Managed');
    const ordinary = store.createThread(workspace.id, 'Ordinary');
    const config = WorkspaceConfigSchema.parse({
      requiredFeatures: [WORKSPACE_RESOURCE_POLICY_FEATURE],
      workspace: {
        name: workspace.name,
        policy: {
          resourceAccess: [
            {
              resource: { family: 'thread', id: thread.id },
              grants: [
                {
                  subject: { kind: 'user', userId: FIXTURE_LOCAL_USER_ID },
                  operations: ['thread.read'],
                },
              ],
              prohibitions: [],
            },
          ],
        },
      },
    });
    const manager = createRuntimeConfigManager({
      dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        dataRoot,
        workspaceConfigs: [
          {
            workspaceId: workspace.id,
            path: join(dataRoot, 'workspaces', workspace.id, 'config/workspace.jsonc'),
            config,
          },
        ],
      }),
    });
    const app = createApp({ dataRoot, coreDb: db, store, runtimeConfigManager: manager });
    const kernel = vi.spyOn(policyKernel, 'evaluateAccess');
    try {
      kernel.mockClear();
      expect(
        (
          await app.request(
            ...operationRequest('thread.read', { workspaceId: workspace.id, threadId: thread.id })
          )
        ).status
      ).toBe(200);
      expect(kernel).toHaveBeenCalledTimes(1);
      const denied = await app.request(
        ...operationRequest('thread.update', {
          workspaceId: workspace.id,
          threadId: thread.id,
          requestId: randomUUID(),
          name: 'Forbidden mutation',
        })
      );
      expect(denied.status).toBe(404);
      expect(store.getThread(workspace.id, thread.id).name).toBe('Managed');
      manager.current().workspaceConfigs[0]!.config.workspace.policy!.resourceAccess[0]!.grants =
        [];
      expect(
        (
          await app.request(
            ...operationRequest('thread.read', { workspaceId: workspace.id, threadId: thread.id })
          )
        ).status
      ).toBe(404);
      const list = await app.request(
        ...operationRequest('thread.list', { workspaceId: workspace.id })
      );
      expect(list.status).toBe(200);
      expect((await list.json()).items.map((item: { id: string }) => item.id)).toEqual([
        ordinary.id,
      ]);
    } finally {
      kernel.mockRestore();
      db.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
