import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { recordServerAuditEvent, recordWorkspaceAuditEvent } from '../audit-events.js';
import { type CommandRequestRecord, commandRequestKey } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { readCommandRequestRecordsFromSqlite } from './command-request-records.js';
import { applyControlAdmission, pruneControlAdmissionReceipts } from './control-store-admission.js';
import { type ControlAdmission, ControlAdmissionSchema } from './control-store-admission-codecs.js';
import {
  type ControlProductOwner,
  openControlStoreProductReadHandle,
} from './control-store-product-records.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { StoredThreadSnapshotV1Schema } from './retained-work-events-v1.js';
import {
  StoredAgentSessionV1Schema,
  StoredTurnV1Schema,
  StoredWorkspaceV1Schema,
} from './retained-work-metadata-v1.js';

const createdAt = '2026-10-18T00:00:00.000Z';
const expiredAt = '2026-10-19T00:00:00.000Z';
const now = '2026-10-20T00:00:00.000Z';
const future = '2026-10-27T00:00:00.000Z';
const disposals: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

/** Opens the genuine native writer for the same caller-owned journal; no injected SQL observer. */
async function openNative(f: ReturnType<typeof fixture>) {
  const client = getControlStoreWorkerClient();
  disposals.push(() => client.shutdown());
  await client.open({
    database: 'owned',
    path: f.db.sqlite.name,
    create: false,
    initialize: f.db.scope,
    productOwner: f.owner,
  });
  return client;
}

/** Actual owned journals and retained rows; no product DDL or test-created read-only handle. */
function fixture(kind: 'server' | 'workspace') {
  const root = mkdtempSync(join(tmpdir(), 'control-family-ownership-'));
  disposals.push(() => rmSync(root, { recursive: true, force: true }));
  const owner: ControlProductOwner =
    kind === 'server'
      ? { kind: 'server' }
      : { kind: 'workspace', workspaceId: allocateEntityId('ws') };
  const db =
    owner.kind === 'server'
      ? openCoreDb(join(root, 'data'))
      : openWorkspaceDb(join(root, 'data'), owner.workspaceId);
  disposals.push(() => {
    db.sqlite.close();
  });
  if (db.scope === 'core') applyMigrations(db);
  else applyScopedMigrations(db, undefined, 'pre-knowledge');
  const scope = owner.kind === 'server' ? { coreId: 'server' } : { workspaceId: owner.workspaceId };
  return { root, db, owner, scope };
}

/** Original identity/hash owners are reused; these are retained fixture receipts, not native proof. */
function receipt(
  scope: Record<string, string>,
  command: CommandRequestRecord['command'] = 'thread.create',
  expiresAt = future
): CommandRequestRecord {
  const requestId = randomUUID();
  const response: CommandRequestRecord['response'] =
    command.startsWith('turn.') || command === 'conversation.submit'
      ? { kind: 'turn', id: allocateEntityId('tu') }
      : command === 'workspace.update'
        ? { kind: 'workspace', id: allocateEntityId('ws') }
        : { kind: 'thread', id: allocateEntityId('th') };
  return {
    key: commandRequestKey(command, requestId, scope),
    command,
    requestId,
    scope,
    inputHash: commandInputHash({ command, requestId, scope }),
    response,
    createdAt,
    expiresAt,
  };
}

/** Seeds retained bytes before this fresh fixture opens its native writer; this is not command acceptance. */
function retainReceipt(f: ReturnType<typeof fixture>, record: CommandRequestRecord) {
  f.db.sqlite
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

/** Uses existing Audit producers only before native ownership observation starts. */
function retainedAudit(f: ReturnType<typeof fixture>, record: CommandRequestRecord) {
  const input = {
    action: record.command,
    requestId: record.requestId,
    outcome: 'succeeded' as const,
    summary: 'Retained admission evidence',
    now: new Date(createdAt),
    occurredAt: new Date(createdAt),
  };
  return f.db.scope === 'core'
    ? recordServerAuditEvent({ ...input, coreDb: f.db })
    : recordWorkspaceAuditEvent({ ...input, workspaceDb: f.db, workspaceId: f.db.workspaceId });
}

/** A real frozen Thread payload; the native producer still validates ownership and revision itself. */
function thread(owner: ControlProductOwner, id: string = allocateEntityId('th')) {
  return {
    schemaVersion: 1,
    ...StoredThreadSnapshotV1Schema.parse({
      id,
      owner,
      name: 'Independent native tuple',
      preview: 'Preparation only',
      status: 'active',
      entryPath: 'conversation',
      visibility: owner.kind === 'server' ? 'server' : 'workspace',
      createdAt,
      updatedAt: now,
    }),
  };
}

/** Required local Audit is part of the submitted native tuple, not a second main-thread commit. */
function admission(f: ReturnType<typeof fixture>, record = receipt(f.scope)): ControlAdmission {
  return ControlAdmissionSchema.parse({
    receipt: { ...record, createdAt: now },
    products: [
      { kind: 'thread', expectedRevision: 0, record: thread(f.owner, record.response.id) },
    ],
    entries: [],
    audit: {
      id: allocateEntityId('aud'),
      workspaceId: f.owner.kind === 'workspace' ? f.owner.workspaceId : null,
      threadId: record.response.id,
      turnId: null,
      itemId: null,
      capabilityCallId: null,
      permissionDecisionId: null,
      vaultGrantId: null,
      requestId: record.requestId,
      actor: null,
      subject: null,
      agentId: null,
      agentSessionId: null,
      category: 'command',
      action: record.command,
      resource: null,
      resourceRevision: null,
      outcome: 'succeeded',
      severity: 'info',
      summary: 'Native admission evidence',
      errorCode: null,
      createdAt: now,
      occurredAt: now,
    },
  });
}

/** Distinguishes exact operation/scope/version partitions without another ownership column. */
function seedPartitions(f: ReturnType<typeof fixture>) {
  const commands = [
    'thread.create',
    'thread.update',
    'thread.archive',
    'turn.start',
    'turn.input.submit',
    'conversation.submit',
  ] as const;
  const expired = [
    ...commands.map((command) => receipt(f.scope, command, expiredAt)),
    receipt({ ...f.scope, threadId: allocateEntityId('th') }, 'thread.update', expiredAt),
  ];
  const protectedRows = [
    receipt(f.scope),
    receipt(f.scope, 'workspace.update', expiredAt),
    receipt({ workspaceId: allocateEntityId('ws') }, 'thread.create', expiredAt),
    receipt(
      f.owner.kind === 'server' ? { workspaceId: allocateEntityId('ws') } : { coreId: 'server' },
      'thread.create',
      expiredAt
    ),
    receipt({ ...f.scope, userId: allocateEntityId('usr') }, 'thread.create', expiredAt),
    receipt({ ...f.scope, appId: 'independent-app' }, 'thread.create', expiredAt),
    receipt(
      {
        ...f.scope,
        ...(f.owner.kind === 'server'
          ? { workspaceId: allocateEntityId('ws') }
          : { coreId: 'server' }),
      },
      'thread.create',
      expiredAt
    ),
    receipt(f.scope, 'thread.create', expiredAt),
  ];
  for (const row of [...expired, ...protectedRows]) {
    const admittedKey = commandRequestKey(row.command, row.requestId, f.scope);
    retainReceipt(f, { ...row, key: admittedKey, scope: f.scope });
    // Adversarial retained-scope bytes are fixture mutations, never a native producer substitute.
    f.db.sqlite
      .prepare('UPDATE idempotency_requests SET request_key=?,scope_json=? WHERE request_key=?')
      .run(row.key, JSON.stringify(row.scope), admittedKey);
  }
  // Unsupported retained core versions are not in the native pruning partition.
  f.db.sqlite
    .prepare('UPDATE idempotency_requests SET schema_version=2 WHERE request_key=?')
    .run(protectedRows.at(-1)!.key);
  for (const row of [...expired, protectedRows[1]!]) retainedAudit(f, row);
  expect(
    f.db.sqlite
      .prepare('SELECT request_key FROM idempotency_requests ORDER BY request_key')
      .pluck()
      .all()
  ).toEqual([...expired, ...protectedRows].map((row) => row.key).sort());
  return { expired, protectedRows };
}

/** Materializes logical rows only. WAL/SHM paths and process shutdown are outside this oracle. */
function retainedRows(sqlite: Database.Database) {
  return {
    receipts: sqlite.prepare('SELECT * FROM idempotency_requests ORDER BY request_key').all(),
    audit: sqlite.prepare('SELECT * FROM audit_events ORDER BY audit_event_id').all(),
  };
}

// DX write/space budget and the mixed-writer ADR govern these preparation-only checks.
// No ordinary route, public C3 activation, mixed-load or all-family writable-handle claim.
describe.each(['server', 'workspace'] as const)('prepared %s family ownership', (kind) => {
  it('rejects writes through the production product reader without disabling the legacy owner', async () => {
    const f = fixture(kind);
    const original = receipt(f.scope, 'workspace.update');
    retainReceipt(f, original);
    retainedAudit(f, original);
    await openNative(f);
    const reader = openControlStoreProductReadHandle(f.db.sqlite.name, f.owner);
    disposals.push(() => reader.close());
    const before = retainedRows(reader.sqlite);
    expect(reader.sqlite).not.toBe(f.db.sqlite);
    expect(reader.sqlite.readonly).toBe(true);
    expect(reader.sqlite.pragma('query_only', { simple: true })).toBe(1);
    for (const sql of ['DELETE FROM idempotency_requests', 'DELETE FROM audit_events']) {
      expect(() => reader.sqlite.prepare(sql).run()).toThrowError(
        expect.objectContaining({ code: 'SQLITE_READONLY' })
      );
    }
    expect(retainedRows(reader.sqlite)).toEqual(before);
    expect(reader.sqlite.inTransaction).toBe(false);
    expect(f.db.sqlite.readonly).toBe(false);
    expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(0);
    // A retained, non-native operation row remains writable through its legacy owner.
    const replacement = allocateEntityId('ws');
    expect(
      f.db.sqlite
        .prepare('UPDATE idempotency_requests SET response_id=? WHERE request_key=?')
        .run(replacement, original.key).changes
    ).toBe(1);
    expect(readCommandRequestRecordsFromSqlite(reader.sqlite)[0]?.response.id).toBe(replacement);
    // Guard the actual native functions even with a writable main connection inside a transaction.
    const beforeMainRefusal = retainedRows(reader.sqlite);
    f.db.sqlite.exec('BEGIN');
    try {
      expect(() => applyControlAdmission(f.db.sqlite, f.owner, admission(f), [])).toThrow(
        'Control product transition precondition failed.'
      );
      expect(() => pruneControlAdmissionReceipts(f.db.sqlite, f.owner, now)).toThrow(
        'Control product transition precondition failed.'
      );
    } finally {
      f.db.sqlite.exec('ROLLBACK');
    }
    expect(retainedRows(reader.sqlite)).toEqual(beforeMainRefusal);
  });

  it('inspects and replays the original receipt on real handles without a second Audit or main mutation', async () => {
    const f = fixture(kind);
    const original = receipt(f.scope);
    retainReceipt(f, original);
    retainedAudit(f, original);
    const client = await openNative(f);
    const reader = openControlStoreProductReadHandle(f.db.sqlite.name, f.owner);
    disposals.push(() => reader.close());
    const before = retainedRows(reader.sqlite);
    const input = admission(f, original);
    input.receipt.response = { kind: 'thread', id: allocateEntityId('th') };
    expect(readCommandRequestRecordsFromSqlite(reader.sqlite)).toEqual([original]);
    await expect(client.transition('owned', input)).resolves.toEqual({
      replayed: true,
      response: original.response,
    });
    await expect(
      client.transition('owned', {
        ...input,
        receipt: { ...input.receipt, inputHash: commandInputHash({ different: true }) },
      })
    ).rejects.toMatchObject({ code: 'precondition', commit: 'not-committed' });
    expect(retainedRows(reader.sqlite)).toEqual(before);

    expect(reader.sqlite.inTransaction).toBe(false);
  });

  it('prunes only its declared receipt partition in the worker and rolls it back with a refused tuple', async () => {
    const f = fixture(kind);
    seedPartitions(f);
    const client = await openNative(f);
    const reader = openControlStoreProductReadHandle(f.db.sqlite.name, f.owner);
    disposals.push(() => reader.close());
    const before = retainedRows(reader.sqlite);
    const input = admission(f);
    // A conflicting product revision refuses the whole admission, including receipt maintenance.
    input.products[0]!.expectedRevision = 1;
    await expect(client.transition('owned', input)).rejects.toMatchObject({
      code: 'precondition',
      commit: 'not-committed',
    });

    expect(
      retainedRows(reader.sqlite),
      'rollback restores every pruned receipt and preserves all required Audit'
    ).toEqual(before);
  });

  it('commits fresh native product metadata, original receipt, required Audit and pruning without a main writer', async () => {
    const f = fixture(kind);
    const partitions = seedPartitions(f);
    const input = admission(f);
    const threadId = input.receipt.response.id;
    let agentSessionId: string | null = null;
    if (f.owner.kind === 'workspace') {
      input.products.push({
        kind: 'workspace',
        expectedRevision: 0,
        record: StoredWorkspaceV1Schema.parse({
          schemaVersion: 1,
          id: f.owner.workspaceId,
          kind: 'general',
          status: 'active',
          createdAt,
          updatedAt: now,
        }),
      });
      agentSessionId = allocateEntityId('as');
      input.products.push({
        kind: 'agent-session',
        expectedRevision: 0,
        record: StoredAgentSessionV1Schema.parse({
          schemaVersion: 1,
          id: agentSessionId,
          workspaceId: f.owner.workspaceId,
          threadId,
          agentId: 'independent-preparation-agent',
          status: 'created',
          message: null,
          sandboxSummary: null,
          createdAt,
          updatedAt: now,
          configVersion: null,
          environmentPackageSnapshotId: null,
          policySnapshotId: null,
          sessionCompatibilityKey: null,
          stale: false,
          workspaceRoots: [],
        }),
      });
    }
    input.products.push({
      kind: 'turn',
      expectedRevision: 0,
      record: StoredTurnV1Schema.parse({
        schemaVersion: 1,
        id: allocateEntityId('tu'),
        owner: f.owner,
        threadId,
        agentSessionId,
        triggerActor: { kind: 'system', id: 'independent-preparation', responsibleUserId: null },
        error: null,
        configVersion: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        status: 'pending',
      }),
    });
    const client = await openNative(f);
    const reader = openControlStoreProductReadHandle(f.db.sqlite.name, f.owner);
    disposals.push(() => reader.close());
    const before = retainedRows(reader.sqlite);
    await expect(client.transition('owned', input)).resolves.toEqual({
      replayed: false,
      response: input.receipt.response,
    });
    for (const product of input.products) {
      const record = { ...product.record };
      if (product.kind === 'thread') delete record.schemaVersion;
      expect(reader.get(product.kind, String(record.id))).toEqual({ revision: 1, record });
    }
    const after = retainedRows(reader.sqlite);
    expect(
      after.receipts.map((row) => (row as { request_key: string }).request_key).sort()
    ).toEqual([...partitions.protectedRows.map((row) => row.key), input.receipt.key].sort());
    const protectedKeys = new Set(partitions.protectedRows.map((row) => row.key));
    expect(after.receipts).toEqual(
      expect.arrayContaining(
        before.receipts.filter((row) =>
          protectedKeys.has((row as { request_key: string }).request_key)
        )
      )
    );
    expect(
      reader.sqlite
        .prepare(
          'SELECT schema_version,request_key,command_name,request_id,scope_json,input_hash,response_kind,response_id,response_json,created_at,expires_at FROM idempotency_requests WHERE request_key=?'
        )
        .get(input.receipt.key)
    ).toEqual({
      schema_version: 1,
      request_key: input.receipt.key,
      command_name: input.receipt.command,
      request_id: input.receipt.requestId,
      scope_json: JSON.stringify(input.receipt.scope),
      input_hash: input.receipt.inputHash,
      response_kind: input.receipt.response.kind,
      response_id: input.receipt.response.id,
      response_json: null,
      created_at: input.receipt.createdAt,
      expires_at: input.receipt.expiresAt,
    });
    expect(after.audit).toEqual(expect.arrayContaining(before.audit));
    expect(after.audit).toHaveLength(before.audit.length + 1);
    expect(
      reader.sqlite
        .prepare('SELECT action, request_id, workspace_id FROM audit_events WHERE audit_event_id=?')
        .get(input.audit.id)
    ).toEqual({
      action: input.receipt.command,
      request_id: input.receipt.requestId,
      workspace_id: f.owner.kind === 'workspace' ? f.owner.workspaceId : null,
    });

    expect(reader.sqlite.inTransaction).toBe(false);
  });
});
