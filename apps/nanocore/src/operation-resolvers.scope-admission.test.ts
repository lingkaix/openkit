import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';
import { createBetterAuth } from './auth/better-auth.js';
import { refuseScope } from './bootstrap/readiness.js';
import { FsStore } from './lib/store.js';
import { projectOperationError } from './operation-error.js';
import { admitOperation } from './operation-resolvers.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

describe('quarantined Workspace native admission', () => {
  it('diagnoses only an eligible viewer and preserves the outsider response before history reads', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'resolver-scope-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const ownerUserId = ensureLocalUser(coreDb);
    const outsider = await createBetterAuth(coreDb, { env: {} }).api.signUpEmail({
      body: {
        email: ['outside-viewer', 'example.invalid'].join('@'),
        name: 'Outside viewer',
        password: randomUUID(),
      },
    });
    const outsiderId = outsider.user.id;
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Unreadable authority');
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId });
    const thread = await store.createThread(workspace.id, 'Do not disclose this history');
    const admission = new WorkspaceMutationAdmission();
    const invoke = (userId: string) =>
      admitOperation(
        OPERATION_DEFINITIONS['thread.read'],
        { workspaceId: workspace.id, threadId: thread.id },
        { kind: 'public', actor: { kind: 'session', userId } },
        { coreDb, store, dataRoot, workspaceMutationAdmission: admission }
      );
    const refusal = async (userId: string) => {
      try {
        (await invoke(userId)).release?.();
        throw new Error('Expected classified refusal.');
      } catch (error) {
        const projected = projectOperationError(error);
        if (!projected) throw error;
        return JSON.stringify(projected);
      }
    };
    try {
      (await invoke(ownerUserId)).release?.();
      const outsiderBefore = await refusal(outsiderId);
      expect(JSON.parse(outsiderBefore!)).toEqual({
        code: 'workspace_access_denied',
        message: 'Workspace access denied.',
        status: 403,
      });
      const reads = vi.spyOn(store, 'getThread');
      refuseScope(dataRoot, { scope: 'workspace', id: workspace.id, check: 'database' });
      const ownerFailure = JSON.parse((await refusal(ownerUserId))!);
      expect(ownerFailure).toMatchObject({ code: 'recovery_required', status: 409 });
      expect(ownerFailure.message).not.toContain(thread.name);
      expect(await refusal(outsiderId)).toBe(outsiderBefore);
      expect(reads).not.toHaveBeenCalled();
      reads.mockRestore();
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
