import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it } from 'vitest';
import { isScopeAdmitted } from '../bootstrap/readiness.js';
import { FsStore } from '../lib/store.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openBootVerifiedWorkspaceDb, openWorkspaceDb } from '../storage/db.js';
import { workspaceDbPath } from '../storage/fs-layout.js';
import { createTestStore } from '../test-support/store.js';
import { raiseRecordedPendingRequest } from './pending-request-flow.js';

it.each([
  'column',
  'table',
  'database',
] as const)('contains missing approval %s authority without losing a healthy sibling projection', async (fault) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'pending-scope-'));
  try {
    const initial = createTestStore({ dataRoot });
    const bad = await initial.createWorkspace('Unreadable approval authority');
    const good = await initial.createWorkspace('Healthy approval authority');
    const userId = 'usr_00000000-0000-7000-8000-000000000001';
    const thread = await initial.createThread(good.id, 'Approval source');
    const turn = await initial.createTurn(
      good.id,
      thread.id,
      'Ask for permission',
      { kind: 'user', id: userId },
      null
    );
    const requestId = 'ap_scope_healthy';
    const requestItemId = allocateEntityId('it');
    const now = new Date().toISOString();
    await initial.createItem({
      id: requestItemId,
      owner: turn.owner,
      threadId: thread.id,
      turnId: turn.id,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: requestId,
      title: 'Retained permission',
      description: 'Keep this exact request.',
      kind: 'permission',
      createdAt: now,
      completedAt: now,
    });
    const healthyDb = openWorkspaceDb(dataRoot, good.id);
    let beforeRow: unknown;
    try {
      await raiseRecordedPendingRequest(initial, healthyDb.sqlite, {
        requestId,
        requestItemId,
        workspaceId: good.id,
        threadId: thread.id,
        raisingTurnId: turn.id,
        kind: 'approval',
        requesterKind: 'person',
        responsibleUserId: userId,
        approval: {
          kind: 'permission',
          title: 'Retained permission',
          description: 'Keep this exact request.',
        },
        governedIntent: { operation: 'scope-projection-test' },
        now,
      });
      beforeRow = healthyDb.sqlite
        .prepare('SELECT * FROM pending_requests WHERE request_id = ?')
        .get(requestId);
    } finally {
      healthyDb.sqlite.close();
    }
    const badPath = workspaceDbPath(dataRoot, bad.id);
    const badDb = openWorkspaceDb(dataRoot, bad.id);
    try {
      if (fault === 'column')
        badDb.sqlite.exec(
          'ALTER TABLE pending_requests RENAME COLUMN schema_version TO unsupported_version'
        );
      if (fault === 'table') badDb.sqlite.exec('DROP TABLE pending_requests');
    } finally {
      badDb.sqlite.close();
    }
    if (fault === 'database') rmSync(badPath);
    const badBytes = fault === 'database' ? null : readFileSync(badPath);
    const goodPath = workspaceDbPath(dataRoot, good.id);
    const goodBytes = readFileSync(goodPath);

    const reopened = new FsStore({ dataRoot });
    expect(isScopeAdmitted(dataRoot, 'workspace', bad.id)).toBe(false);
    expect(reopened.listWorkspaces().map(({ id }) => id)).toEqual([good.id]);
    expect(() => reopened.getWorkspace(bad.id)).toThrow('quarantined');
    expect(reopened.getApproval(requestId)).toMatchObject({
      id: requestId,
      workspaceId: good.id,
      status: 'pending',
    });
    const inspect = openBootVerifiedWorkspaceDb(dataRoot, good.id);
    try {
      expect(
        inspect.sqlite.prepare('SELECT * FROM pending_requests WHERE request_id = ?').get(requestId)
      ).toEqual(beforeRow);
    } finally {
      inspect.sqlite.close();
    }
    expect(readFileSync(goodPath)).toEqual(goodBytes);
    if (badBytes) expect(readFileSync(badPath)).toEqual(badBytes);
    else expect(() => readFileSync(badPath)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  } finally {
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
