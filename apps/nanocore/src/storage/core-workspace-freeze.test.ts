// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestStore } from '../test-support/store.js';
import { publishWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';

it('ORACLE S7 refuses logical Workspace effects in Core while sibling Core publication stays usable', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-core-workspace-freeze-'));
  const store = createTestStore({ dataRoot });
  const coreDb = openCoreDb(dataRoot);
  let releaseFreeze: (() => void) | undefined;
  const posts = vi.spyOn(Worker.prototype, 'postMessage');
  const replies = vi.spyOn(Worker.prototype, 'emit');
  try {
    const ownerUserId = ensureLocalUser(coreDb);
    const target = await store.createWorkspace('Frozen target');
    const sibling = await store.createWorkspace('Unfrozen sibling');
    const gate = new WorkspaceMutationAdmission();
    store.setWorkspaceMutationAdmission(gate);
    const before = coreDb.sqlite
      .prepare('SELECT * FROM workspace_registry WHERE workspace_id=?')
      .get(target.id);
    expect(before).toBeUndefined();
    const frozen = gate.tryFreeze(target.id, () => []);
    expect(frozen.status).toBe('frozen');
    if (frozen.status !== 'frozen') throw new Error('Expected actual target freeze.');
    releaseFreeze = frozen.release;
    coreDb.sqlite.pragma('query_only = ON');
    // Native Core publication remains usable for an unrelated Workspace with the same actual User.
    await publishWorkspaceOwnerMembership({ coreDb, workspaceId: sibling.id, ownerUserId });
    expect(
      coreDb.sqlite
        .prepare('SELECT status FROM workspace_registry WHERE workspace_id=?')
        .pluck()
        .get(sibling.id)
    ).toBe('active');
    const siblingPosts = posts.mock.calls
      .map(([message]) => message)
      .filter(
        (message) =>
          message.operation === 'private-workspace' && message.input.workspaceId === sibling.id
      );
    expect(siblingPosts.length).toBeGreaterThan(0);
    expect(
      siblingPosts.some((request) =>
        replies.mock.calls.some(
          ([event, reply]) =>
            event === 'message' &&
            reply?.id === request.id &&
            reply?.operation === request.operation &&
            reply?.status === 'ok'
        )
      )
    ).toBe(true);
    let refusal: unknown;
    try {
      await publishWorkspaceOwnerMembership({ coreDb, workspaceId: target.id, ownerUserId });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: 'workspace_frozen', status: 409 });
    expect(
      coreDb.sqlite.prepare('SELECT * FROM workspace_registry WHERE workspace_id=?').get(target.id)
    ).toEqual(before);
    expect(
      coreDb.sqlite.prepare('SELECT * FROM workspace_members WHERE workspace_id=?').all(target.id)
    ).toEqual([]);
    expect(gate.isClosed(target.id)).toBe(true);
    releaseFreeze();
    releaseFreeze = undefined;
    await publishWorkspaceOwnerMembership({ coreDb, workspaceId: target.id, ownerUserId });
    expect(
      coreDb.sqlite
        .prepare('SELECT status FROM workspace_registry WHERE workspace_id=?')
        .pluck()
        .get(target.id)
    ).toBe('active');
  } finally {
    releaseFreeze?.();
    posts.mockRestore();
    replies.mockRestore();
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}, 120_000);
