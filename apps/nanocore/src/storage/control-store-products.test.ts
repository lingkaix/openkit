import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import {
  LocalStorage,
  type StorageAccess,
  type StorageContent,
  type StorageResult,
} from '@openkit/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { type CommandRequestRecord, commandRequestKey } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import {
  getCommandRequestRecordFromDb,
  recordCommandRequestRecordInDb,
} from './command-request-records.js';
import { type ControlAdmission, ControlAdmissionSchema } from './control-store-admission.js';
import type {
  ControlProductEntry,
  ControlProductMutation,
  ControlProductOwner,
} from './control-store-products.js';
import { openControlStoreProductReadHandle } from './control-store-products.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { coreDbPath } from './fs-layout.js';
import { publishImmutableContent } from './immutable-content.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { StoredServerEventV1Schema } from './retained-server-work-v1.js';
import { StoredEventV1Schema, StoredThreadSnapshotV1Schema } from './retained-work-events-v1.js';
import { StoredItemV1Schema } from './retained-work-items-v1.js';
import { StoredTurnV1Schema } from './retained-work-metadata-v1.js';

const timestamp = '2026-10-20T00:00:00.000Z';
const roots: string[] = [];
let client: ReturnType<typeof getControlStoreWorkerClient> | undefined;
const storageInstances: LocalStorage[] = [];
afterEach(async () => {
  await client?.shutdown();
  client = undefined;
  for (const storage of storageInstances.splice(0)) await storage.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Uses the actual Core journal and existing owning receipt producer, never test-owned product DDL or handlers. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'control-products-'));
  roots.push(root);
  const db = openCoreDb(root);
  try {
    applyMigrations(db);
    return { root, db, path: coreDbPath(root) };
  } catch (error) {
    db.sqlite.close();
    throw error;
  }
}

/** Current input and required Audit; replay must return the retained original without evaluating a new product candidate. */
function replayInput(receipt: CommandRequestRecord): ControlAdmission {
  return {
    receipt,
    products: [{ kind: 'thread', expectedRevision: 0, record: { schemaVersion: 1 } }],
    entries: [],
    audit: {
      id: allocateEntityId('aud'),
      workspaceId: null,
      threadId: null,
      turnId: null,
      itemId: null,
      capabilityCallId: null,
      permissionDecisionId: null,
      vaultGrantId: null,
      requestId: receipt.requestId,
      actor: null,
      subject: null,
      agentId: null,
      agentSessionId: null,
      category: 'command',
      action: receipt.command,
      resource: null,
      resourceRevision: null,
      outcome: 'succeeded',
      severity: 'info',
      summary: 'Admission replay',
      errorCode: null,
      createdAt: timestamp,
      occurredAt: timestamp,
    },
  } as ControlAdmission;
}

/** Uses actual scoped journals and a real admitted Storage backend for immutable publication. */
async function nativeFixture(kind: 'server' | 'workspace') {
  const root = mkdtempSync(join(tmpdir(), 'native-product-entries-'));
  roots.push(root);
  const owner: ControlProductOwner =
    kind === 'server'
      ? { kind: 'server' }
      : { kind: 'workspace', workspaceId: allocateEntityId('ws') };
  const db = owner.kind === 'server' ? openCoreDb(root) : openWorkspaceDb(root, owner.workspaceId);
  const path = db.sqlite.name;
  try {
    if (db.scope === 'core') applyMigrations(db);
    else applyScopedMigrations(db);
  } finally {
    db.sqlite.close();
  }
  const contentRoot = join(root, 'immutable');
  const stagingRoot = join(root, 'staging');
  mkdirSync(join(contentRoot, 'entries'), { recursive: true });
  mkdirSync(stagingRoot);
  const knowledgeBaseId = allocateEntityId('kb');
  const storage = new LocalStorage({
    mounts: [{ knowledgeBaseId, ownerScope: owner, name: 'private', root: contentRoot }],
    stagingRoot,
  });
  storageInstances.push(storage);
  const access: StorageAccess = {
    basis: 'lease',
    grantId: allocateEntityId('grant'),
    knowledgeBaseId,
    ownerScope: owner,
    mount: 'private',
    pathPrefix: 'entries',
    mode: 'staged-write',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revoked: false,
  };
  const threadId = allocateEntityId('th');
  const turnId = allocateEntityId('tu');
  const thread = {
    schemaVersion: 1,
    id: threadId,
    owner,
    name: 'Native immutable qualification',
    preview: 'Immutable native tuple',
    status: 'active',
    entryPath: 'conversation',
    visibility: kind === 'server' ? 'server' : 'workspace',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const turn = {
    schemaVersion: 1,
    id: turnId,
    owner,
    threadId,
    agentSessionId: null,
    triggerActor: { kind: 'system', id: 'native-test', responsibleUserId: null },
    error: null,
    configVersion: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    status: 'pending',
  };
  const products: ControlProductMutation[] = [
    { kind: 'thread', expectedRevision: 0, record: thread },
    { kind: 'turn', expectedRevision: 0, record: turn },
  ];
  if (owner.kind === 'workspace')
    products.push({
      kind: 'workspace',
      expectedRevision: 0,
      record: {
        schemaVersion: 1,
        id: owner.workspaceId,
        kind: 'general',
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
  const scope = owner.kind === 'server' ? { coreId: 'server' } : { workspaceId: owner.workspaceId };
  client = getControlStoreWorkerClient();
  const open = () =>
    client!.open({
      database: 'native',
      path,
      create: false,
      initialize: kind === 'server' ? 'core' : 'workspace',
      productOwner: owner,
      contentMount: { root: contentRoot, knowledgeBaseId, mount: 'private' },
    });
  await open();
  return {
    root,
    path,
    owner,
    contentRoot,
    storage,
    access,
    threadId,
    turnId,
    thread,
    turn,
    products,
    scope,
    open,
  };
}

/** Requires the actual Storage success branch; scaffold refusals cannot count as native proof. */
function storageValue<T>(result: StorageResult<T>): T {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error(`Storage fixture refused: ${result.status}`);
  return result.value;
}

/** Seals real stage bytes, then uses the owning durable publisher rather than fabricating a descriptor. */
async function publish(
  f: Awaited<ReturnType<typeof nativeFixture>>,
  value: unknown
): Promise<StorageContent> {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const { handle } = storageValue(
    await f.storage.beginStage({
      access: f.access,
      locator: { ownerScope: f.owner, mount: 'private', path: 'entries/staged.json' },
      maxByteLength: bytes.length,
    })
  );
  storageValue(
    await f.storage.writeStage({ access: f.access, handle, data: bytes.toString('base64') })
  );
  const stage = storageValue(await f.storage.finishStage({ access: f.access, handle }));
  try {
    return await publishImmutableContent({
      storage: f.storage,
      access: f.access,
      stage,
      mountRoot: f.contentRoot,
    });
  } finally {
    storageValue(await f.storage.discardStage({ access: f.access, handle }));
  }
}

/** Keeps retained Item identity fixed across independently published content revisions. */
function item(
  f: Awaited<ReturnType<typeof nativeFixture>>,
  id = allocateEntityId('it'),
  text = 'first'
) {
  return {
    schemaVersion: 1,
    id,
    owner: f.owner,
    threadId: f.threadId,
    turnId: f.turnId,
    type: 'assistant-message',
    status: 'in_progress',
    text,
    createdAt: timestamp,
    completedAt: null,
  };
}

/** A frozen native event with explicit canonical order, not a synthetic SQL log row. */
function event(f: Awaited<ReturnType<typeof nativeFixture>>, sequence: number) {
  return {
    schemaVersion: 1,
    protocolVersion: '1',
    event: 'error',
    sequence,
    requestId: null,
    timestamp,
    ...(f.owner.kind === 'workspace' ? { workspaceId: f.owner.workspaceId } : { owner: f.owner }),
    threadId: f.threadId,
    turnId: f.turnId,
    data: { type: 'error', code: 'fixture', message: `event ${sequence}` },
  };
}

/** Every candidate has its own original identity and required local Audit in the actual native tuple. */
function nativeInput(
  f: Awaited<ReturnType<typeof nativeFixture>>,
  products = f.products,
  entries: ControlProductEntry[] = []
): ControlAdmission {
  const requestId = randomUUID();
  const receipt: CommandRequestRecord = {
    key: commandRequestKey('turn.input.submit', requestId, f.scope),
    command: 'turn.input.submit',
    requestId,
    scope: f.scope,
    inputHash: commandInputHash({ requestId }),
    response: { kind: 'turn', id: f.turnId },
    createdAt: timestamp,
    expiresAt: '2026-10-27T00:00:00.000Z',
  };
  const base = replayInput(receipt);
  return ControlAdmissionSchema.parse({
    ...base,
    products,
    entries,
    audit: {
      ...base.audit,
      workspaceId: f.owner.kind === 'workspace' ? f.owner.workspaceId : null,
      threadId: f.threadId,
      turnId: f.turnId,
    },
  });
}

/** Reads exact committed owned rows through the production readonly handle; no test writer or DDL. */
function committedRows(
  reader: ReturnType<typeof openControlStoreProductReadHandle>,
  owner: ControlProductOwner
) {
  const tables = [
    'control_threads',
    'control_turns',
    'control_product_entries',
    'idempotency_requests',
    'audit_events',
  ];
  if (owner.kind === 'workspace') tables.push('control_workspaces', 'control_agent_sessions');
  return Object.fromEntries(
    tables.map((table) => [
      table,
      reader.sqlite
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ])
  );
}

/** Initial native tuple supplies positive byte, lineage and SQL controls for every refusal test. */
async function initialEntries(f: Awaited<ReturnType<typeof nativeFixture>>) {
  StoredThreadSnapshotV1Schema.parse(f.thread);
  StoredTurnV1Schema.parse(f.turn);
  const body = item(f);
  StoredItemV1Schema.parse(body);
  (f.owner.kind === 'server' ? StoredServerEventV1Schema : StoredEventV1Schema).parse(event(f, 1));
  const itemContent = await publish(f, body);
  const eventContent = await publish(f, event(f, 1));
  const input = nativeInput(f, f.products, [
    { kind: 'item', turnId: f.turnId, sequence: 1, expectedRevision: 0, content: itemContent },
    { kind: 'event', turnId: f.turnId, sequence: 1, expectedRevision: 0, content: eventContent },
  ]);
  await expect(client!.transition('native', input)).resolves.toEqual({
    replayed: false,
    response: input.receipt.response,
  });
  return { body, input, itemContent, eventContent };
}

describe('prepared control product boundaries', () => {
  it('constructs the actual read-only product handle without replacing a legacy writable handle', () => {
    const f = fixture();
    let reader: ReturnType<typeof openControlStoreProductReadHandle> | undefined;
    try {
      reader = openControlStoreProductReadHandle(f.path, { kind: 'server' });
      const sqlite = reader.sqlite;
      expect(sqlite.readonly).toBe(true);
      expect(sqlite.pragma('query_only', { simple: true })).toBe(1);
      expect(() => sqlite.prepare('DELETE FROM audit_events').run()).toThrow();
      expect(f.db.sqlite.readonly).toBe(false);
      expect(() => f.db.sqlite.prepare('DELETE FROM audit_events WHERE 0').run()).not.toThrow();
    } finally {
      reader?.close();
      f.db.sqlite.close();
    }
  });

  it('replays native admission with descriptive additions in the original conversation receipt', async () => {
    const f = fixture();
    const scope = { coreId: 'server' };
    const requestId = randomUUID();
    const record: CommandRequestRecord = {
      key: commandRequestKey('conversation.submit', requestId, scope),
      command: 'conversation.submit',
      requestId,
      scope,
      inputHash: `sha256:${'a'.repeat(64)}`,
      response: {
        kind: 'turn',
        id: allocateEntityId('tu'),
        conversationMetadata: {
          targetRef: 'fixture-target',
          logicalModelId: null,
          receivingWorkspaceId: allocateEntityId('ws'),
          receivingThreadId: allocateEntityId('th'),
          downstream: null,
          resultKind: 'worker-turn',
          status: 202,
        },
      },
      createdAt: timestamp,
      expiresAt: '2026-10-27T00:00:00.000Z',
    };
    try {
      recordCommandRequestRecordInDb(f.db, record);
      // This is retained-data mutation, not a synthetic producer or ordinary public C3 proof.
      f.db.sqlite
        .prepare('UPDATE idempotency_requests SET response_json=? WHERE request_key=?')
        .run(
          JSON.stringify({
            ...record.response.conversationMetadata,
            annotation: { source: 'future-reader' },
          }),
          record.key
        );
      expect(getCommandRequestRecordFromDb(f.db, record.key, timestamp)?.response).toEqual(
        record.response
      );
    } finally {
      f.db.sqlite.close();
    }
    client = getControlStoreWorkerClient();
    await client.open({
      database: 'core',
      path: f.path,
      create: false,
      initialize: 'core',
      productOwner: { kind: 'server' },
    });
    await expect(client.transition('core', replayInput(record))).resolves.toEqual({
      replayed: true,
      response: record.response,
    });
  });

  it.each([
    'current',
    'closed',
    'failed',
  ] as const)('enforces AgentSession %s selection and non-reuse', async (state) => {
    const f = await nativeFixture('workspace');
    await initialEntries(f);
    if (f.owner.kind !== 'workspace') throw new Error('Workspace fixture required.');
    const session = {
      schemaVersion: 1,
      id: allocateEntityId('as'),
      workspaceId: f.owner.workspaceId,
      threadId: f.threadId,
      agentId: 'native-current-selection',
      status: 'created',
      message: null,
      sandboxSummary: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      configVersion: null,
      environmentPackageSnapshotId: null,
      policySnapshotId: null,
      sessionCompatibilityKey: null,
      stale: false,
      workspaceRoots: [],
    };
    const create = nativeInput(f, [
      { kind: 'agent-session', expectedRevision: 0, record: session },
    ]);
    await expect(client!.transition('native', create)).resolves.toMatchObject({ replayed: false });
    const reader = openControlStoreProductReadHandle(f.path, f.owner);
    try {
      if (state === 'current') {
        const before = committedRows(reader, f.owner);
        await expect(
          client!.transition(
            'native',
            nativeInput(f, [
              {
                kind: 'agent-session',
                expectedRevision: 0,
                record: { ...session, id: allocateEntityId('as') },
              },
            ])
          )
        ).rejects.toMatchObject({ commit: 'not-committed' });
        expect(committedRows(reader, f.owner)).toEqual(before);
      } else {
        await expect(
          client!.transition(
            'native',
            nativeInput(f, [
              { kind: 'agent-session', expectedRevision: 1, record: { ...session, status: state } },
            ])
          )
        ).resolves.toMatchObject({ replayed: false });
        const terminal = committedRows(reader, f.owner);
        await expect(
          client!.transition(
            'native',
            nativeInput(f, [
              {
                kind: 'agent-session',
                expectedRevision: 2,
                record: { ...session, status: 'ready' },
              },
            ])
          )
        ).rejects.toMatchObject({ commit: 'not-committed' });
        expect(committedRows(reader, f.owner)).toEqual(terminal);
      }
    } finally {
      reader.close();
    }
  });
});

describe.each(['server', 'workspace'] as const)('native %s immutable products', (kind) => {
  it('commits ordered immutable revisions and events with the product/receipt/Audit tuple and preserves them after reopen', async () => {
    const f = await nativeFixture(kind);
    const first = await initialEntries(f);
    const secondBody = item(f, first.body.id, 'second');
    const itemContent = await publish(f, secondBody);
    const secondEvent = {
      ...event(f, 2),
      event: 'item.created',
      data: { type: 'item-created', item: secondBody },
    };
    const eventContent = await publish(f, secondEvent);
    const nextTurn = { ...f.turn, status: 'running', startedAt: timestamp };
    const next = nativeInput(
      f,
      [{ kind: 'turn', expectedRevision: 1, record: nextTurn }],
      [
        { kind: 'item', turnId: f.turnId, sequence: 2, expectedRevision: 1, content: itemContent },
        {
          kind: 'event',
          turnId: f.turnId,
          sequence: 2,
          expectedRevision: 0,
          content: eventContent,
        },
      ]
    );
    await expect(client!.transition('native', next)).resolves.toEqual({
      replayed: false,
      response: next.receipt.response,
    });
    await client!.shutdown();
    client = getControlStoreWorkerClient();
    await f.open();
    const reader = openControlStoreProductReadHandle(f.path, f.owner);
    try {
      expect(reader.get('turn', f.turnId)).toMatchObject({
        revision: 2,
        record: { status: 'running' },
      });
      const items = reader.entries(f.turnId, 'item');
      expect(items.map((value) => [value.sequence, value.id, value.revision])).toEqual([
        [1, first.body.id, 1],
        [2, first.body.id, 2],
      ]);
      expect(reader.entries(f.turnId, 'item', 1, 1)).toEqual([items[1]]);
      const events = reader.entries(f.turnId, 'event');
      expect(events.map((value) => [value.sequence, value.id, value.revision])).toEqual([
        [1, `${f.turnId}:1`, 1],
        [2, `${f.turnId}:2`, 1],
      ]);
      for (const [content, body] of [
        [first.itemContent, first.body],
        [itemContent, secondBody],
        [first.eventContent, event(f, 1)],
        [eventContent, secondEvent],
      ] as const) {
        expect(
          JSON.parse(readFileSync(join(f.contentRoot, content.reference.locator.path), 'utf8'))
        ).toEqual(body);
      }
      expect(
        reader.sqlite
          .prepare('SELECT request_key FROM idempotency_requests ORDER BY request_key')
          .all()
      ).toEqual(
        [first.input.receipt.key, next.receipt.key].sort().map((request_key) => ({ request_key }))
      );
      expect(
        reader.sqlite
          .prepare('SELECT audit_event_id AS id FROM audit_events ORDER BY audit_event_id')
          .all()
      ).toEqual([first.input.audit.id, next.audit.id].sort().map((id) => ({ id })));
      const before = committedRows(reader, f.owner);
      await expect(client!.transition('native', next)).resolves.toEqual({
        replayed: true,
        response: next.receipt.response,
      });
      expect(committedRows(reader, f.owner)).toEqual(before);
    } finally {
      reader.close();
    }
  });

  it('refuses canonical event sequence mismatch without admitting preceding Item or metadata effects', async () => {
    const f = await nativeFixture(kind);
    const first = await initialEntries(f);
    const reader = openControlStoreProductReadHandle(f.path, f.owner);
    try {
      const before = committedRows(reader, f.owner);
      const next = nativeInput(
        f,
        [
          {
            kind: 'turn',
            expectedRevision: 1,
            record: { ...f.turn, status: 'running', startedAt: timestamp },
          },
        ],
        [
          {
            kind: 'item',
            turnId: f.turnId,
            sequence: 2,
            expectedRevision: 1,
            content: await publish(f, item(f, first.body.id, 'not committed')),
          },
          {
            kind: 'event',
            turnId: f.turnId,
            sequence: 2,
            expectedRevision: 0,
            content: await publish(f, event(f, 99)),
          },
        ]
      );
      await expect(client!.transition('native', next)).rejects.toMatchObject({
        code: 'precondition',
        commit: 'not-committed',
      });
      expect(committedRows(reader, f.owner)).toEqual(before);
    } finally {
      reader.close();
    }
  });

  it('refuses invalid byte facts, retained format, owner, lineage, identity and ordering with exact tuple rollback', async () => {
    const f = await nativeFixture(kind);
    const first = await initialEntries(f);
    const valid = await publish(f, item(f, first.body.id, 'next'));
    const wrongOwner: ControlProductOwner =
      f.owner.kind === 'server'
        ? { kind: 'workspace', workspaceId: allocateEntityId('ws') }
        : { kind: 'server' };
    const bodies = [
      { ...first.body, owner: wrongOwner },
      { ...first.body, turnId: allocateEntityId('tu') },
      { ...first.body, threadId: allocateEntityId('th') },
      { ...first.body, schemaVersion: 99 },
      { ...first.body, type: 'reasoning', summary: [], content: [] },
      Buffer.from([0xff]),
    ];
    const contents = [
      ...(await Promise.all(bodies.map((body) => publish(f, body)))),
      { ...valid, byteLength: valid.byteLength + 1 },
      { ...valid, reference: { ...valid.reference, contentDigest: `sha256:${'b'.repeat(64)}` } },
    ];
    const reader = openControlStoreProductReadHandle(f.path, f.owner);
    try {
      const before = committedRows(reader, f.owner);
      const products: ControlProductMutation[] = [
        {
          kind: 'turn',
          expectedRevision: 1,
          record: { ...f.turn, status: 'running', startedAt: timestamp },
        },
      ];
      for (const content of contents) {
        const candidate = nativeInput(f, products, [
          { kind: 'item', turnId: f.turnId, sequence: 2, expectedRevision: 1, content },
        ]);
        await expect(client!.transition('native', candidate)).rejects.toMatchObject({
          commit: 'not-committed',
        });
        expect(committedRows(reader, f.owner)).toEqual(before);
      }
      const badEvent = await publish(f, { ...event(f, 2), threadId: allocateEntityId('th') });
      await expect(
        client!.transition(
          'native',
          nativeInput(f, products, [
            { kind: 'item', turnId: f.turnId, sequence: 2, expectedRevision: 1, content: valid },
            {
              kind: 'event',
              turnId: f.turnId,
              sequence: 2,
              expectedRevision: 0,
              content: badEvent,
            },
          ])
        )
      ).rejects.toMatchObject({ code: 'precondition', commit: 'not-committed' });
      expect(committedRows(reader, f.owner)).toEqual(before);
      await expect(
        client!.transition(
          'native',
          nativeInput(f, products, [
            { kind: 'item', turnId: f.turnId, sequence: 3, expectedRevision: 1, content: valid },
          ])
        )
      ).rejects.toMatchObject({ code: 'precondition', commit: 'not-committed' });
      expect(committedRows(reader, f.owner)).toEqual(before);
      expect(readFileSync(join(f.contentRoot, valid.reference.locator.path)).length).toBe(
        valid.byteLength
      );
    } finally {
      reader.close();
    }
  });

  it.each([
    'knowledgeBaseId',
    'mount',
  ] as const)('refuses an unadmitted %s in an otherwise valid immutable reference', async (field) => {
    const f = await nativeFixture(kind);
    const first = await initialEntries(f);
    const actual = await publish(f, item(f, first.body.id, 'unadmitted locator'));
    const reference =
      field === 'knowledgeBaseId'
        ? { ...actual.reference, knowledgeBaseId: allocateEntityId('kb') }
        : { ...actual.reference, locator: { ...actual.reference.locator, mount: 'unadmitted' } };
    const reader = openControlStoreProductReadHandle(f.path, f.owner);
    try {
      const before = committedRows(reader, f.owner);
      await expect(
        client!.transition(
          'native',
          nativeInput(
            f,
            [{ kind: 'turn', expectedRevision: 1, record: f.turn }],
            [
              {
                kind: 'item',
                turnId: f.turnId,
                sequence: 2,
                expectedRevision: 1,
                content: { ...actual, reference },
              },
            ]
          )
        )
      ).rejects.toMatchObject({ commit: 'not-committed' });
      expect(committedRows(reader, f.owner)).toEqual(before);
    } finally {
      reader.close();
    }
  });

  it('validates nested event payload ownership and lineage against actual native Items', async () => {
    const f = await nativeFixture(kind);
    const first = await initialEntries(f);
    const reader = openControlStoreProductReadHandle(f.path, f.owner);
    const opposite: ControlProductOwner =
      f.owner.kind === 'server'
        ? { kind: 'workspace', workspaceId: allocateEntityId('ws') }
        : { kind: 'server' };
    try {
      const before = committedRows(reader, f.owner);
      for (const nested of [
        { ...first.body, owner: opposite },
        { ...first.body, threadId: allocateEntityId('th') },
        { ...first.body, turnId: allocateEntityId('tu') },
        { ...first.body, id: allocateEntityId('it') },
      ]) {
        const content = await publish(f, {
          ...event(f, 2),
          event: 'item.created',
          data: { type: 'item-created', item: nested },
        });
        await expect(
          client!.transition(
            'native',
            nativeInput(
              f,
              [{ kind: 'turn', expectedRevision: 1, record: f.turn }],
              [{ kind: 'event', turnId: f.turnId, sequence: 2, expectedRevision: 0, content }]
            )
          )
        ).rejects.toMatchObject({ commit: 'not-committed' });
        expect(committedRows(reader, f.owner)).toEqual(before);
      }
    } finally {
      reader.close();
    }
  });

  it.each([
    'valid',
    'wrong-thread',
    'wrong-turn',
    'unknown-item',
  ] as const)('checks %s Items inside a nonterminal Turn event snapshot', async (variant) => {
    const f = await nativeFixture(kind);
    const first = await initialEntries(f);
    const nested =
      variant === 'wrong-thread'
        ? { ...first.body, threadId: allocateEntityId('th') }
        : variant === 'wrong-turn'
          ? { ...first.body, turnId: allocateEntityId('tu') }
          : variant === 'unknown-item'
            ? { ...first.body, id: allocateEntityId('it') }
            : item(f, allocateEntityId('it'), 'same-tuple snapshot');
    const nextTurn = { ...f.turn, status: 'running', startedAt: timestamp };
    const content = await publish(f, {
      ...event(f, 2),
      event: 'turn.updated',
      data: {
        type: 'turn-updated',
        turn: { ...nextTurn, items: variant === 'valid' ? [first.body, nested] : [nested] },
      },
    });
    const candidate = nativeInput(
      f,
      [{ kind: 'turn', expectedRevision: 1, record: nextTurn }],
      [
        { kind: 'event', turnId: f.turnId, sequence: 2, expectedRevision: 0, content },
        ...(variant === 'valid'
          ? [
              {
                kind: 'item' as const,
                turnId: f.turnId,
                sequence: 2,
                expectedRevision: 0,
                content: await publish(f, nested),
              },
            ]
          : []),
      ]
    );
    const reader = openControlStoreProductReadHandle(f.path, f.owner);
    try {
      const before = committedRows(reader, f.owner);
      if (variant === 'valid') {
        await expect(client!.transition('native', candidate)).resolves.toEqual({
          replayed: false,
          response: candidate.receipt.response,
        });
        expect(reader.entries(f.turnId, 'event').map((row) => row.sequence)).toEqual([1, 2]);
        expect(reader.get('turn', f.turnId)).toMatchObject({
          revision: 2,
          record: { status: 'running' },
        });
        expect(
          reader.sqlite
            .prepare('SELECT request_key FROM idempotency_requests WHERE request_key=?')
            .get(candidate.receipt.key)
        ).toEqual({ request_key: candidate.receipt.key });
        expect(
          reader.sqlite
            .prepare('SELECT audit_event_id FROM audit_events WHERE audit_event_id=?')
            .get(candidate.audit.id)
        ).toEqual({ audit_event_id: candidate.audit.id });
      } else {
        await expect(client!.transition('native', candidate)).rejects.toMatchObject({
          commit: 'not-committed',
        });
        expect(committedRows(reader, f.owner)).toEqual(before);
      }
    } finally {
      reader.close();
    }
  });

  it('refuses terminal Turn publication through completed or updated immutable event snapshots', async () => {
    const f = await nativeFixture(kind);
    const first = await initialEntries(f);
    const reader = openControlStoreProductReadHandle(f.path, f.owner);
    try {
      const before = committedRows(reader, f.owner);
      for (const type of ['turn-completed', 'turn-updated'] as const) {
        const turn = {
          ...f.turn,
          status: 'completed',
          startedAt: timestamp,
          completedAt: timestamp,
          durationMs: 0,
          items: [first.body],
        };
        const data =
          type === 'turn-completed' ? { type, stopReason: 'completed', turn } : { type, turn };
        const content = await publish(f, {
          ...event(f, 2),
          event: type.replaceAll('-', '.'),
          data,
        });
        await expect(
          client!.transition(
            'native',
            nativeInput(
              f,
              [{ kind: 'turn', expectedRevision: 1, record: f.turn }],
              [{ kind: 'event', turnId: f.turnId, sequence: 2, expectedRevision: 0, content }]
            )
          )
        ).rejects.toMatchObject({ commit: 'not-committed' });
        expect(committedRows(reader, f.owner)).toEqual(before);
      }
    } finally {
      reader.close();
    }
  });

  it('keeps the complete tuple unchanged on stale revision, active Thread conflict, archive and partial terminal attempts', async () => {
    const f = await nativeFixture(kind);
    await initialEntries(f);
    const reader = openControlStoreProductReadHandle(f.path, f.owner);
    try {
      const before = committedRows(reader, f.owner);
      const attempts: ControlProductMutation[][] = [
        [
          {
            kind: 'turn',
            expectedRevision: 0,
            record: { ...f.turn, status: 'running', startedAt: timestamp },
          },
        ],
        [{ kind: 'turn', expectedRevision: 0, record: { ...f.turn, id: allocateEntityId('tu') } }],
        [{ kind: 'thread', expectedRevision: 1, record: { ...f.thread, status: 'archived' } }],
        [
          {
            kind: 'turn',
            expectedRevision: 1,
            record: {
              ...f.turn,
              status: 'completed',
              startedAt: timestamp,
              completedAt: timestamp,
              durationMs: 0,
            },
          },
        ],
      ];
      for (const products of attempts) {
        await expect(client!.transition('native', nativeInput(f, products))).rejects.toMatchObject({
          commit: 'not-committed',
        });
        expect(committedRows(reader, f.owner)).toEqual(before);
      }
    } finally {
      reader.close();
    }
  });
});
