import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import {
  getCommandRequestRecordFromDb,
  recordCommandRequestRecordInDb,
} from './command-request-records.js';
import { openWorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';

describe('retained conversation receipt metadata', () => {
  it.each([
    'task',
    'goal',
  ] as const)('reads, replays, rewrites and reopens extended %s facts without changing identity', (kind) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-receipt-extension-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Receipt');
    const input = {
      command: 'conversation.submit' as const,
      requestId: '0190f4c8-0000-7000-8000-000000000501',
      scope: { workspaceId: workspace.id },
      inputHash: 'sha256:owned-input',
      response: {
        kind: 'turn' as const,
        id: 'tu_receiving',
        conversationMetadata: {
          downstream:
            kind === 'task'
              ? { kind, turnId: 'tu_downstream' }
              : { kind, goalId: 'goal_downstream', turnId: 'tu_downstream' },
          logicalModelId: 'reasoning',
          receivingThreadId: 'th_receiving',
          receivingWorkspaceId: workspace.id,
          resultKind: kind === 'task' ? ('task-handoff' as const) : ('goal-handoff' as const),
          status: 202 as const,
          targetRef: 'internal-role:assistant',
        },
      },
      createdAt: '2026-10-06T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    };
    store.recordCommandRequest(input);
    const original = store.getCommandRequest(input.command, input.requestId, input.scope)!;
    const db = openWorkspaceDb(dataRoot, workspace.id);
    applyScopedMigrations(db);
    const metadata = {
      ...input.response.conversationMetadata,
      futureNote: 'retained',
      downstream: { ...input.response.conversationMetadata.downstream, futureNote: 'retained' },
    };
    db.sqlite
      .prepare('UPDATE idempotency_requests SET response_json = ? WHERE request_key = ?')
      .run(JSON.stringify(metadata), original.key);
    const loaded = getCommandRequestRecordFromDb(db, original.key, input.createdAt)!;
    expect(loaded).toEqual(original);
    recordCommandRequestRecordInDb(db, loaded);
    expect(
      JSON.parse(
        (
          db.sqlite
            .prepare('SELECT response_json FROM idempotency_requests WHERE request_key = ?')
            .get(original.key) as { response_json: string }
        ).response_json
      )
    ).toEqual(metadata);
    db.sqlite.close();
    const reopened = new FsStore({ dataRoot });
    expect(reopened.getCommandRequest(input.command, input.requestId, input.scope)).toEqual(
      original
    );
    const wrong = openWorkspaceDb(dataRoot, workspace.id);
    wrong.sqlite
      .prepare('UPDATE idempotency_requests SET response_json = ? WHERE request_key = ?')
      .run(JSON.stringify({ ...metadata, status: 204 }), original.key);
    expect(() => getCommandRequestRecordFromDb(wrong, original.key, input.createdAt)).toThrow(
      'metadata is invalid'
    );
    wrong.sqlite.close();
  });
});
