// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { openTestNativeWorkspace } from '../test-support/store.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';
import { abandonCapture, inspectCapture, protectCapture } from './workspace-capture-protection.js';
import { nativeProductScope, readNativeProduct } from './workspace-file-records.js';

const roots: string[] = [];
const handles: WorkspaceDb[] = [];

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const db of handles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Produces a real native Workspace and its original active capture publication right. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-source-move-'));
  roots.push(root);
  await createDemoStore({ dataRoot: root });
  const workspaceId = DEMO_WORKSPACE_ID;
  const db = openWorkspaceDb(root, workspaceId);
  handles.push(db);
  const captureId = allocateEntityId('wsbak');
  const capture = protectCapture(db, workspaceId, captureId);
  await openTestNativeWorkspace(db);
  const scope = nativeProductScope(root, { kind: 'workspace', workspaceId });
  const snapshot = () => ({
    workspace: readNativeProduct(scope, 'workspace', workspaceId)!,
    capture: inspectCapture(db, workspaceId, captureId),
    audit: listWorkspaceAuditEvents(db, workspaceId),
  });
  const before = snapshot();
  return {
    db,
    capture,
    snapshot,
    before,
    client: getControlStoreWorkerClient(),
    database: `workspace:${scope.path}`,
    input: {
      workspaceId,
      captureId,
      expectedRevision: before.workspace.revision,
      manifestDigest: `sha256:${'2'.repeat(64)}`,
    },
  };
}

/** Source Seal points 3-4 bind revision, moved-out lineage and original Audit in one native commit. */
describe('native source MOVE transaction', () => {
  it('commits the moved-out tuple once and retains active capture protection for later marker publication', async () => {
    const f = await fixture();
    await f.client.recoveryMoveOut(f.database, f.input);
    const committed = f.snapshot();
    expect(committed.workspace.revision).toBe(f.before.workspace.revision + 1);
    expect(committed.workspace.record).toMatchObject({
      id: f.input.workspaceId,
      movedOut: { backupId: f.input.captureId, manifestDigest: f.input.manifestDigest },
    });
    expect(committed.capture).toEqual(f.capture);
    expect(committed.audit).toHaveLength(f.before.audit.length + 1);
    const moveAudit = committed.audit.filter((event) => event.action === 'workspace.move-out');
    expect(moveAudit).toHaveLength(1);
    expect(moveAudit[0]).toMatchObject({
      workspaceId: f.input.workspaceId,
      resource: `workspace:${f.input.workspaceId}`,
      outcome: 'succeeded',
    });
    expect(moveAudit[0]!.summary).toContain(f.input.captureId);
    expect(moveAudit[0]!.summary).toContain(f.input.manifestDigest);
    await f.client.recoveryMoveOut(f.database, f.input);
    expect(f.snapshot()).toEqual(committed);
  }, 30_000);

  it.each([
    'stale-revision',
    'abandoned-publication-right',
  ] as const)('refuses %s without changing any source tuple member', async (conflict) => {
    const f = await fixture();
    if (conflict === 'abandoned-publication-right') {
      await f.client.recoveryMoveOut(f.database, f.input);
      abandonCapture(f.db, f.input.workspaceId, f.input.captureId);
    }
    const before = f.snapshot();
    const input = {
      ...f.input,
      expectedRevision: f.input.expectedRevision + (conflict === 'stale-revision' ? 1 : 0),
    };
    // A historical matching seal cannot restore a closed capture publication right.
    await expect(f.client.recoveryMoveOut(f.database, input)).rejects.toThrow();
    expect(f.snapshot()).toEqual(before);
  }, 30_000);
});
