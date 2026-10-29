import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntityKind } from '@openkit/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { prepareAuditEvent } from '../audit-events.js';
import type {
  CommandRequestRecord,
  CommandRequestResponse,
  CommandRequestResponseKind,
} from '../lib/store.js';
import { commandRequestKey, FsStore } from '../lib/store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { createTestStore } from '../test-support/store.js';
import {
  getCommandRequestRecordFromDb,
  normalizeCommandRequestResponse,
  recordCommandRequestRecord,
  recordCommandRequestRecordInDb,
} from './command-request-records.js';
import { ControlAdmissionSchema } from './control-store-admission.js';
import {
  closeWorkspaceProductReadHandles,
  openControlStoreProductReadHandle,
} from './control-store-products.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { bindWorkspaceSqlite, openWorkspaceDb, type WorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';
import { controlThreads } from './schema/index.js';

/** Installs retained bytes with the live writer stopped; this fixture proves decoding, not command acceptance. */
function seedRetainedReceipt(db: WorkspaceDb, record: CommandRequestRecord): void {
  db.sqlite
    .prepare(`INSERT INTO idempotency_requests
      (schema_version, request_key, command_name, request_id, scope_json, input_hash,
       response_kind, response_id, response_json, created_at, expires_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      record.key,
      record.command,
      record.requestId,
      JSON.stringify(record.scope),
      record.inputHash,
      record.response.kind,
      record.response.id,
      record.response.conversationMetadata === undefined
        ? null
        : JSON.stringify(record.response.conversationMetadata),
      record.createdAt,
      record.expiresAt
    );
}

describe('retained conversation receipt metadata', () => {
  it.each([
    'task',
    'goal',
  ] as const)('reads, protects and reopens extended %s facts without changing identity', async (kind) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-receipt-extension-'));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Receipt');
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
    await shutdownControlStoreWorkerClient();
    const original = {
      ...input,
      key: commandRequestKey(input.command, input.requestId, input.scope),
    };
    const db = openWorkspaceDb(dataRoot, workspace.id);
    onTestFinished(async () => {
      if (db.sqlite.open) db.sqlite.close();
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    applyScopedMigrations(db);
    seedRetainedReceipt(db, original);
    expect(store.getCommandRequest(input.command, input.requestId, input.scope)).toEqual(original);
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
    // The retained codec accepts these bytes; Main cannot rewrite this native family.
    expect(() => recordCommandRequestRecordInDb(db, loaded)).toThrow(
      'Native admission receipts belong to the database worker.'
    );
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
  ['knowledge_proposal_review', 'kr'],
  ['generative_presentation', 'pres'],
  ['worker_environment', 'wst'],
  ['vault_reference', 'vault'],
  ['vault_grant', 'grant'],
] as const satisfies readonly (readonly [CommandRequestResponseKind, EntityKind])[];

describe('kind-named command response pointers', () => {
  it.each(
    RESPONSE_ID_CASES
  )('validates %s as its owned %s kind in the codec and retained reader', async (kind, entityKind) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-receipt-kinds-'));
    const store = createTestStore({ dataRoot });
    const sourceRoot = mkdtempSync(join(tmpdir(), 'openkit-receipt-source-'));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(sourceRoot);
      rmSync(sourceRoot, { recursive: true, force: true });
    });
    const sourceStore = createTestStore({ dataRoot: sourceRoot });
    const workspace = await store.createWorkspace('Receipt kind boundary');
    await shutdownControlStoreWorkerClient();
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
      expect(normalizeCommandRequestResponse(input.command, input.response)).toEqual(
        input.response
      );
      const original = {
        ...input,
        key: commandRequestKey(input.command, input.requestId, input.scope),
      };
      seedRetainedReceipt(db, original);
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
        expect(() => normalizeCommandRequestResponse(input.command, response)).toThrow();
        expect(() => sourceStore.recordCommandRequest({ ...input, response })).toThrow();
        expect(sourceStore.listCommandRequests()).toEqual([]);
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
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'future-core-kind',
    'knowledge_observation',
    'knowledge_claim',
    'knowledge_conflict',
  ])('refuses unsupported Core response kind %s instead of treating it as an opaque owner', async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-receipt-unknown-kind-'));
    const store = createTestStore({ dataRoot: root });
    const workspace = await store.createWorkspace('Closed receipt kind');
    const sourceRoot = mkdtempSync(join(tmpdir(), 'openkit-receipt-source-'));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(sourceRoot);
      rmSync(sourceRoot, { recursive: true, force: true });
    });
    const sourceStore = createTestStore({ dataRoot: sourceRoot });
    const input = {
      command: 'task.start' as const,
      requestId: 'closed-kind',
      scope: { workspaceId: workspace.id },
      inputHash: 'owned-input',
      response: { kind: 'turn' as const, id: testEntityId('tu', 'closed-receipt-kind') },
      createdAt: '2026-10-06T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    };
    await shutdownControlStoreWorkerClient();
    const original = {
      ...input,
      key: commandRequestKey(input.command, input.requestId, input.scope),
    };
    const db = openWorkspaceDb(root, workspace.id);
    seedRetainedReceipt(db, original);
    try {
      const untrusted = {
        ...input.response,
        kind,
      } as unknown as CommandRequestResponse;
      expect(() => normalizeCommandRequestResponse(input.command, untrusted)).toThrow(
        'kind is unsupported'
      );
      expect(() => sourceStore.recordCommandRequest({ ...input, response: untrusted })).toThrow(
        'kind is unsupported'
      );
      expect(sourceStore.listCommandRequests()).toEqual([]);
      const rows = () =>
        db.sqlite.prepare('SELECT * FROM idempotency_requests ORDER BY request_key').all();
      const before = rows();
      expect(() =>
        recordCommandRequestRecordInDb(db, { ...original, response: untrusted })
      ).toThrow('Native admission receipts belong to the database worker.');
      expect(rows()).toEqual(before);
      expect(
        db.sqlite
          .prepare('UPDATE idempotency_requests SET response_kind = ? WHERE request_key = ?')
          .run(kind, original.key).changes
      ).toBe(1);
      const corrupted = rows();
      expect(() => getCommandRequestRecordFromDb(db, original.key, input.createdAt)).toThrow(
        'kind is unsupported'
      );
      expect(rows()).toEqual(corrupted);
    } finally {
      db.sqlite.close();
      await shutdownControlStoreWorkerClient();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates a Core response pointer before creating its database or directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-receipt-before-owner-'));
    const sourceRoot = mkdtempSync(join(tmpdir(), 'openkit-receipt-source-'));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(sourceRoot);
      rmSync(sourceRoot, { recursive: true, force: true });
    });
    const sourceStore = createTestStore({ dataRoot: sourceRoot });
    const userId = testEntityId('usr', 'receipt-disabled-user');
    const record = sourceStore.recordCommandRequest({
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
      await shutdownControlStoreWorkerClient();
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

describe('native receipt ownership and replay', () => {
  it('commits the original Thread receipt and Audit on its owner and refuses Main backfill', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-native-receipt-'));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Native receipt owner');
    const threadId = testEntityId('th', 'native-receipt-owner');
    const scope = { workspaceId: workspace.id };
    const command = 'thread.create' as const;
    const requestId = '0190f4c8-0000-7000-8000-000000000502';
    const receipt: CommandRequestRecord = {
      key: commandRequestKey(command, requestId, scope),
      command,
      requestId,
      scope,
      inputHash: `sha256:${'a'.repeat(64)}`,
      response: { kind: 'thread', id: threadId },
      createdAt: '2026-10-22T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    };
    const admission = {
      receipt: ControlAdmissionSchema.shape.receipt.parse(receipt),
      audit: ControlAdmissionSchema.shape.audit.parse(
        prepareAuditEvent({
          workspaceId: workspace.id,
          threadId,
          requestId,
          category: 'command',
          action: command,
          resource: `thread:${threadId}`,
          outcome: 'succeeded',
          summary: 'Thread admitted.',
          now: new Date(receipt.createdAt),
        })
      ),
    };
    const created = await store.createThread(
      workspace.id,
      'Original receipt',
      threadId,
      'conversation',
      undefined,
      admission
    );
    expect(created.id).toBe(threadId);
    const reader = openControlStoreProductReadHandle(
      join(dataRoot, 'workspaces', workspace.id, 'db', 'workspace.sqlite'),
      { kind: 'workspace', workspaceId: workspace.id }
    );
    try {
      const db = bindWorkspaceSqlite(reader.sqlite, dataRoot, workspace.id);
      const readThread = (id: string) =>
        db.db.query.controlThreads.findFirst({ where: eq(controlThreads.id, id) }).sync();
      expect(readThread(threadId)).toMatchObject({ id: threadId, workspaceId: workspace.id });
      expect(reader.sqlite.readonly).toBe(true);
      expect(reader.sqlite.pragma('query_only', { simple: true })).toBe(1);
      expect(reader.sqlite.inTransaction).toBe(false);
      expect(getCommandRequestRecordFromDb(db, receipt.key, receipt.createdAt)).toEqual(receipt);
      expect(reader.get('thread', threadId)?.record.id).toBe(threadId);
      expect(
        reader.sqlite
          .prepare('SELECT schema_version FROM idempotency_requests WHERE request_key = ?')
          .get(receipt.key)
      ).toEqual({ schema_version: 1 });
      const rows = () => ({
        receipts: reader.sqlite.prepare('SELECT * FROM idempotency_requests').all(),
        audits: reader.sqlite.prepare('SELECT * FROM audit_events').all(),
        threads: reader.sqlite.prepare('SELECT * FROM control_threads').all(),
      });
      const committed = rows();
      // The same-connection ORM view must preserve SQLite's original readonly refusal.
      expect(() =>
        db.db.delete(controlThreads).where(eq(controlThreads.id, threadId)).run()
      ).toThrowError(expect.objectContaining({ name: 'SqliteError', code: 'SQLITE_READONLY' }));
      expect(rows()).toEqual(committed);
      expect(reader.sqlite.inTransaction).toBe(false);
      expect(
        reader.sqlite
          .prepare('SELECT audit_event_id FROM audit_events WHERE action = ? AND request_id = ?')
          .all(command, requestId)
      ).toEqual([{ audit_event_id: admission.audit.id }]);
      expect(() => store.recordCommandRequest(receipt)).toThrow(
        'Native admission receipts belong to the database worker.'
      );
      expect(rows()).toEqual(committed);
      expect(() => recordCommandRequestRecordInDb(db, receipt)).toThrow(
        'Native admission receipts belong to the database worker.'
      );
      const replay = await store.createThread(
        workspace.id,
        'Unused replay candidate',
        undefined,
        'conversation',
        undefined,
        admission
      );
      expect(replay).toEqual(created);
      expect(rows()).toEqual(committed);
      await expect(
        store.createThread(
          workspace.id,
          'Conflicting input',
          undefined,
          'conversation',
          undefined,
          {
            ...admission,
            receipt: { ...receipt, inputHash: `sha256:${'b'.repeat(64)}` },
          }
        )
      ).rejects.toThrow();
      expect(rows()).toEqual(committed);
      const laterThread = await store.createThread(workspace.id, 'Fresh bound ORM read');
      expect(readThread(laterThread.id)).toMatchObject({
        id: laterThread.id,
        workspaceId: workspace.id,
      });
      expect(reader.sqlite.inTransaction).toBe(false);
    } finally {
      reader.close();
    }
    await shutdownControlStoreWorkerClient();
    const reopened = new FsStore({ dataRoot });
    expect(reopened.getCommandRequest(command, requestId, scope)).toEqual(receipt);
    expect(reopened.getThread(workspace.id, threadId)).toEqual(created);
  });
});

/** Uses the real scoped journal with stopped retained bytes; it does not publish a native command. */
function retainedReceiptFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-receipt-format-'));
  const workspaceId = testEntityId('ws', 'receipt-format');
  const db = openWorkspaceDb(dataRoot, workspaceId);
  onTestFinished(async () => {
    db.sqlite.close();
    await shutdownControlStoreWorkerClient();
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
  seedRetainedReceipt(db, record);
  return { db, record };
}

describe('retained SQL receipt format', () => {
  it('reads retained v1 and the owned receipt without a repair write', () => {
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
