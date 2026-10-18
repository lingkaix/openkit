import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntityKind } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { CommandRequestResponse, CommandRequestResponseKind } from '../lib/store.js';
import { FsStore } from '../lib/store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  getCommandRequestRecordFromDb,
  normalizeCommandRequestResponse,
  recordCommandRequestRecord,
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
        id: 'tu_00000000-0000-775f-8a76-b1204634948f',
        conversationMetadata: {
          downstream:
            kind === 'task'
              ? { kind, turnId: 'tu_00000000-0000-7c1e-94d2-e114d4a15de4' }
              : {
                  kind,
                  goalId: 'goal_downstream',
                  turnId: 'tu_00000000-0000-7c1e-94d2-e114d4a15de4',
                },
          logicalModelId: 'reasoning',
          receivingThreadId: 'th_00000000-0000-7406-b2a7-192f628666f1',
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

const RESPONSE_ID_CASES = [
  ['workspace', 'ws'],
  ['workspace_recovery', 'ws'],
  ['user', 'usr'],
  ['thread', 'th'],
  ['turn', 'tu'],
  ['artifact', 'ar'],
  ['material', 'mat'],
  ['thread_material_binding', 'mat'],
  ['material_revision', 'mrev'],
  ['artifact_review', 'arev'],
  ['workspace_invitation', 'inv'],
  ['knowledge_source', 'ks'],
  ['knowledge_observation', 'ko'],
  ['knowledge_claim', 'kc'],
  ['knowledge_conflict', 'kf'],
  ['knowledge_proposal_review', 'kr'],
  ['generative_presentation', 'pres'],
  ['worker_environment', 'wst'],
  ['vault_reference', 'vault'],
  ['vault_grant', 'grant'],
] as const satisfies readonly (readonly [CommandRequestResponseKind, EntityKind])[];

describe('kind-named command response pointers', () => {
  it.each(
    RESPONSE_ID_CASES
  )('admits %s only as its owned %s kind before publication and on readback', (kind, entityKind) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-receipt-kinds-'));
    const store = new FsStore({ dataRoot });
    const memory = new FsStore();
    const workspace = store.createWorkspace('Receipt kind boundary');
    const db = openWorkspaceDb(dataRoot, workspace.id);
    try {
      applyScopedMigrations(db);
      const input = {
        command: 'task.start' as const,
        requestId: `receipt-${kind}`,
        scope: { workspaceId: workspace.id },
        inputHash: 'owned-input',
        response: { kind, id: testEntityId(entityKind, `receipt-${kind}`) },
        createdAt: '2026-10-06T00:00:00.000Z',
        expiresAt: '2999-01-01T00:00:00.000Z',
      };
      const original = store.recordCommandRequest(input);
      const rows = () =>
        db.sqlite.prepare('SELECT * FROM idempotency_requests ORDER BY request_key').all();
      const retained = rows();
      expect(getCommandRequestRecordFromDb(db, original.key, input.createdAt)?.response).toEqual(
        input.response
      );
      for (const id of [
        'legacy',
        testEntityId(entityKind === 'ws' ? 'usr' : 'ws', 'wrong-receipt-kind'),
      ]) {
        const response = { kind, id };
        expect(() => memory.recordCommandRequest({ ...input, response })).toThrow();
        expect(memory.listCommandRequests()).toEqual([]);
        expect(() =>
          store.recordCommandRequest({ ...input, requestId: `bad-${kind}`, response })
        ).toThrow();
        expect(rows()).toEqual(retained);
        expect(() => recordCommandRequestRecordInDb(db, { ...original, response })).toThrow();
        expect(rows()).toEqual(retained);
        expect(
          db.sqlite
            .prepare('UPDATE idempotency_requests SET response_id = ? WHERE request_key = ?')
            .run(id, original.key).changes
        ).toBe(1);
        const corrupted = rows();
        expect(() => getCommandRequestRecordFromDb(db, original.key, input.createdAt)).toThrow();
        expect(rows()).toEqual(corrupted);
        db.sqlite
          .prepare('UPDATE idempotency_requests SET response_id = ? WHERE request_key = ?')
          .run(original.response.id, original.key);
      }
      expect(rows()).toEqual(retained);
    } finally {
      db.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('refuses an unknown Core response kind instead of treating it as an opaque owner', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-receipt-unknown-kind-'));
    const store = new FsStore({ dataRoot: root });
    const workspace = store.createWorkspace('Closed receipt kind');
    const memory = new FsStore();
    const input = {
      command: 'task.start' as const,
      requestId: 'closed-kind',
      scope: { workspaceId: workspace.id },
      inputHash: 'owned-input',
      response: { kind: 'turn' as const, id: testEntityId('tu', 'closed-receipt-kind') },
      createdAt: '2026-10-06T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    };
    const original = store.recordCommandRequest(input);
    const db = openWorkspaceDb(root, workspace.id);
    try {
      const untrusted = {
        ...input.response,
        kind: 'future-core-kind',
      } as unknown as CommandRequestResponse;
      expect(() => normalizeCommandRequestResponse(input.command, untrusted)).toThrow(
        'kind is unsupported'
      );
      expect(() => memory.recordCommandRequest({ ...input, response: untrusted })).toThrow(
        'kind is unsupported'
      );
      expect(memory.listCommandRequests()).toEqual([]);
      const rows = () =>
        db.sqlite.prepare('SELECT * FROM idempotency_requests ORDER BY request_key').all();
      const before = rows();
      expect(() =>
        recordCommandRequestRecordInDb(db, { ...original, response: untrusted })
      ).toThrow('kind is unsupported');
      expect(rows()).toEqual(before);
      expect(
        db.sqlite
          .prepare('UPDATE idempotency_requests SET response_kind = ? WHERE request_key = ?')
          .run('future-core-kind', original.key).changes
      ).toBe(1);
      const corrupted = rows();
      expect(() => getCommandRequestRecordFromDb(db, original.key, input.createdAt)).toThrow(
        'kind is unsupported'
      );
      expect(rows()).toEqual(corrupted);
    } finally {
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates a Core response pointer before creating its database or directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-receipt-before-owner-'));
    const memory = new FsStore();
    const userId = testEntityId('usr', 'receipt-disabled-user');
    const record = memory.recordCommandRequest({
      command: 'user.disable',
      requestId: 'disable-pointer',
      scope: { coreId: 'server', actorId: userId, targetUserId: userId },
      inputHash: 'owned-input',
      response: { kind: 'user', id: userId },
      createdAt: '2026-10-06T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    try {
      const validRoot = join(root, 'valid');
      recordCommandRequestRecord(validRoot, record);
      expect(existsSync(join(validRoot, 'server', 'db', 'core.sqlite'))).toBe(true);
      for (const [index, id] of ['legacy', testEntityId('ws', 'wrong-user-pointer')].entries()) {
        const invalidRoot = join(root, `invalid-${index}`);
        expect(() =>
          recordCommandRequestRecord(invalidRoot, { ...record, response: { kind: 'user', id } })
        ).toThrow();
        expect(existsSync(invalidRoot)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    'goal',
    'workspace_member',
    'pending_request',
    'light_app_record',
  ] as const)('preserves the excluded opaque %s owner pointer', (kind) => {
    const response = { kind, id: 'owner:opaque-key' };
    expect(normalizeCommandRequestResponse('task.start', response)).toEqual(response);
  });
});

/** Uses the native scoped journal and receipt publisher without a second content owner. */
function retainedReceiptFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-receipt-format-'));
  const workspaceId = testEntityId('ws', 'receipt-format');
  const db = openWorkspaceDb(dataRoot, workspaceId);
  onTestFinished(() => {
    db.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyScopedMigrations(db);
  const record = {
    key: 'receipt-format',
    command: 'task.start' as const,
    requestId: 'receipt-format',
    scope: { workspaceId },
    inputHash: 'owned-input',
    response: { kind: 'turn' as const, id: testEntityId('tu', 'receipt-format') },
    createdAt: '2026-10-06T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
  };
  recordCommandRequestRecordInDb(db, record);
  return { db, record };
}

describe('retained SQL receipt format', () => {
  it('writes v1 and reads the owned receipt without a repair write', () => {
    const { db, record } = retainedReceiptFixture();
    expect(db.sqlite.prepare('SELECT schema_version FROM idempotency_requests').get()).toEqual({
      schema_version: 1,
    });
    const before = db.sqlite.prepare('SELECT * FROM idempotency_requests').all();
    expect(getCommandRequestRecordFromDb(db, record.key, record.createdAt)).toEqual(record);
    expect(db.sqlite.prepare('SELECT * FROM idempotency_requests').all()).toEqual(before);
  });

  it('refuses an unknown row version before JSON decoding without repairing the receipt', () => {
    const { db, record } = retainedReceiptFixture();
    db.sqlite
      .prepare('UPDATE idempotency_requests SET schema_version = 2, scope_json = ?')
      .run('{invalid');
    const before = db.sqlite.prepare('SELECT * FROM idempotency_requests').all();
    expect(() => getCommandRequestRecordFromDb(db, record.key, record.createdAt)).toThrow(
      'Unsupported retained record format.'
    );
    expect(db.sqlite.prepare('SELECT * FROM idempotency_requests').all()).toEqual(before);
  });
});
