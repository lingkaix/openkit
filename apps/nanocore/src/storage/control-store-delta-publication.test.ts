import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, type Item, PROTOCOL_VERSION, writeRetainedV1 } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { listWorkspaceAuditEvents, prepareAuditEvent } from '../audit-events.js';
import { commandRequestKey } from '../lib/store.js';
import {
  closeTestCoreDb,
  createTestStore,
  createTestWorkspaceDb,
  disposeTestStore,
} from '../test-support/store.js';
import type { ControlProductTransition } from './control-store-product-records.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import { nativeProductScope, readNativeProduct } from './workspace-file-records.js';

const auditFaultObservation = vi.hoisted(() => ({
  shared: undefined as SharedArrayBuffer | undefined,
}));

// Observe actual SQL transaction identity; only the fixture's batching delay is extended.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (!auditFaultObservation.shared) {
          super(filename, options);
          return;
        }
        const prelude = `
        const state = new Int32Array(require('node:worker_threads').workerData.auditFaultObservation);
        const Database = require(require('node:worker_threads').workerData.databaseModule);
        const execute = Database.prototype.exec;
        Database.prototype.exec = function(sql) {
          if (Atomics.load(state, 0) && /^BEGIN IMMEDIATE$/i.test(sql)) Atomics.add(state, 1, 1);
          return execute.call(this, sql);
        };
        const prepare = Database.prototype.prepare;
        Database.prototype.prepare = function(sql) {
          const statement = prepare.call(this, sql);
          const run = statement.run;
          statement.run = function(...parameters) {
            if (Atomics.load(state, 0)) {
              if (sql.includes('INSERT INTO audit_events') && parameters.includes('core.protocol.invalid_delta')) Atomics.store(state, 2, Atomics.load(state, 1));
              if (sql.includes('INSERT INTO control_turns')) Atomics.store(state, 3, Atomics.load(state, 1));
            }
            return run.apply(this, parameters);
          };
          return statement;
        };
        const schedule = global.setTimeout;
        global.setTimeout = function(callback, delay, ...args) {
          return schedule(callback, Atomics.load(state, 0) && delay === 5 ? 50 : delay, ...args);
        };
      `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            auditFaultObservation: auditFaultObservation.shared,
            databaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
          },
        });
      }
    },
  };
});

const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;

/** Calls the genuine compound native publication owner, outside FsStore event wrappers. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'compound-delta-'));
  onTestFinished(() => disposeTestStore(root));
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Compound');
  const thread = await store.createThread(workspace.id, 'Events');
  const turn = await store.createTurn(workspace.id, thread.id, 'Work', actor);
  const item: Item = {
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    type: 'assistant-message',
    text: '',
    status: 'in_progress',
    createdAt: turn.startedAt!,
    completedAt: null,
  };
  await store.createItem(item);
  const scope = nativeProductScope(root, turn.owner);
  const database = `workspace:${scope.path}`;
  const client = getControlStoreWorkerClient();
  await client.open({
    database,
    path: scope.path,
    dataRoot: root,
    create: false,
    initialize: 'workspace',
    productOwner: turn.owner,
    contentMount: scope.contentMount,
  });
  const content = (value: unknown) => {
    const body = JSON.stringify(writeRetainedV1(value));
    return {
      reference: {
        representation: 'inline' as const,
        body,
        ownerScope: turn.owner,
        contentDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      },
      byteLength: Buffer.byteLength(body),
      mediaType: 'application/json',
    };
  };
  const delta = (
    data: Record<string, unknown>,
    sequence = 1,
    targetTurn = turn,
    targetItem = item
  ) => ({
    kind: 'event' as const,
    turnId: targetTurn.id,
    sequence,
    expectedRevision: 0,
    content: content({
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: workspace.id,
      threadId: targetTurn.threadId,
      turnId: targetTurn.id,
      requestId: null,
      timestamp: turn.startedAt!,
      sequence,
      event: 'item.delta',
      data: { type: 'item-delta', itemId: targetItem.id, itemType: targetItem.type, ...data },
    }),
  });
  const audits = () => {
    const db = createTestWorkspaceDb(root, workspace.id);
    try {
      return listWorkspaceAuditEvents(db, workspace.id).filter((event) =>
        event.action.startsWith('core.protocol.')
      );
    } finally {
      closeTestCoreDb(db);
    }
  };
  const pending = (tuple: ControlProductTransition, targetTurn = turn) =>
    client.pendingCommand(database, {
      ...tuple,
      receipt: null,
      input: {
        action: 'closeout',
        workspaceId: workspace.id,
        threadId: targetTurn.threadId,
        closeoutTurnId: targetTurn.id,
        expectedThreadCensus: [],
        expected: [],
        actor,
        now: turn.startedAt!,
      },
    });
  return {
    store,
    workspace,
    thread,
    turn,
    item,
    client,
    database,
    content,
    delta,
    audits,
    pending,
    scope,
  };
}

describe('native compound delta boundary', () => {
  it.each(['products', 'transition'] as const)(
    'audits undeclared pairs and orphan references through %s without publishing them',
    async (operation) => {
      const f = await fixture();
      for (const data of [
        { deltaKind: 'output-delta', delta: 'private rejected bytes' },
        { deltaKind: 'indexed-text-delta', partId: 'missing', delta: 'private rejected bytes' },
      ]) {
        const tuple = { products: [], entries: [f.delta(data)] };
        let publication: Promise<unknown>;
        const requestId = randomUUID();
        const scope = { workspaceId: f.workspace.id, threadId: f.thread.id };
        if (operation === 'products') publication = f.client.products(f.database, tuple);
        else
          publication = f.client.transition(f.database, {
            ...tuple,
            receipt: {
              key: commandRequestKey('turn.input.submit', requestId, scope),
              command: 'turn.input.submit',
              requestId,
              scope,
              inputHash: `sha256:${'a'.repeat(64)}`,
              response: { kind: 'turn', id: f.turn.id },
              createdAt: f.turn.startedAt!,
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
            audit: prepareAuditEvent({
              workspaceId: f.workspace.id,
              threadId: f.thread.id,
              turnId: f.turn.id,
              requestId,
              action: 'turn.input.submit',
              outcome: 'succeeded',
              summary: 'Must not be published.',
            }),
          });
        await expect(publication).rejects.toMatchObject({ code: 'core.protocol.invalid_delta' });
        expect(f.store.getTurnEventsForExport(f.turn.id)).toEqual([]);
        expect(f.store.getCommandRequest('turn.input.submit', requestId, scope)).toBeNull();
      }
      expect(f.audits()).toHaveLength(2);
      expect(f.audits()).toMatchObject([
        { action: 'core.protocol.invalid_delta', errorCode: 'core.protocol.invalid_delta' },
        { action: 'core.protocol.invalid_delta', errorCode: 'core.protocol.invalid_delta' },
      ]);
      expect(JSON.stringify(f.audits())).not.toContain('private rejected bytes');
      await f.client.products(f.database, {
        products: [],
        entries: [f.delta({ deltaKind: 'text-delta', delta: 'valid after refusal' })],
      });
      expect(f.store.getTurnEventsForExport(f.turn.id)).toHaveLength(1);
    }
  );

  it('isolates a failed diagnostic SQL statement from an unrelated Turn in the same native batch', async () => {
    const shared = new SharedArrayBuffer(16);
    const state = new Int32Array(shared);
    auditFaultObservation.shared = shared;
    onTestFinished(() => {
      Atomics.store(state, 0, 0);
      auditFaultObservation.shared = undefined;
    });
    const f = await fixture();
    const sibling = await f.store.createThread(f.workspace.id, 'Independent admission');
    const turn = { ...f.turn, id: allocateEntityId('tu'), threadId: sibling.id, items: [] };
    await f.client.write(f.database, [
      {
        mode: 'run',
        sql: "CREATE TRIGGER reject_protocol_diagnostic BEFORE INSERT ON audit_events WHEN NEW.action='core.protocol.invalid_delta' BEGIN SELECT RAISE(FAIL, 'Injected diagnostic write fault.'); END",
        parameters: [],
      },
    ]);
    Atomics.store(state, 0, 1);
    const results = await Promise.allSettled([
      f.client.products(f.database, {
        products: [],
        entries: [
          f.delta({ deltaKind: 'indexed-text-delta', partId: 'missing', delta: 'private' }),
        ],
      }),
      f.client.products(f.database, {
        products: [
          {
            kind: 'turn',
            expectedRevision: 0,
            record: writeRetainedV1({
              ...turn,
              captureCoverage: { scope: 'workspace', value: 'off' },
            }),
          },
        ],
        entries: [],
      }),
    ]);
    Atomics.store(state, 0, 0);
    expect(Atomics.load(state, 2)).toBeGreaterThan(0);
    expect(Atomics.load(state, 3)).toBe(Atomics.load(state, 2));
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(results[0]).toMatchObject({ reason: { commit: 'not-committed' } });
    expect(f.store.getTurnEventsForExport(f.turn.id)).toEqual([]);
    expect(f.store.getTurnById(turn.id).status).toBe('running');
    expect(f.audits()).toEqual([]);
  });

  it('replays exact historical terminal deltas without revalidating or rewriting them', async () => {
    const f = await fixture();
    await f.client.products(f.database, {
      products: [],
      entries: [f.delta({ deltaKind: 'text-delta', delta: 'original' })],
    });
    const historical = f.delta({
      deltaKind: 'indexed-text-delta',
      partId: 'old-unintroduced-part',
      delta: 'historical bytes',
    });
    // Emulate bytes accepted by the previous publisher in this disposable native fixture.
    await f.client.write(f.database, [
      {
        mode: 'run',
        sql: "UPDATE control_product_entries SET content_json=? WHERE kind='event' AND turn_id=? AND sequence=1",
        parameters: [JSON.stringify(historical.content), f.turn.id],
        expectChanges: 1,
      },
    ]);
    const event = f.store.getTurnEventsForExport(f.turn.id)[0]!;
    const completedAt = f.turn.startedAt!;
    await f.store.completeTurn(f.turn.id, { status: 'completed', completedAt });
    const before = f.store.getTurnEventsForExport(f.turn.id);
    await f.store.completeTurn(
      f.turn.id,
      { status: 'completed', completedAt },
      {
        precedingEvents: [event],
      }
    );
    expect(f.store.getTurnEventsForExport(f.turn.id)).toEqual(before);
    const head = readNativeProduct(f.scope, 'turn', f.turn.id)!;
    await f.client.publication(f.database, {
      category: 'already-decided-publication',
      turnId: f.turn.id,
      expectedRevision: head.revision,
      entries: [historical],
    });
    expect(f.store.getTurnEventsForExport(f.turn.id)).toEqual(before);
    expect(f.audits()).toEqual([]);
    await expect(
      f.client.publication(f.database, {
        category: 'already-decided-publication',
        turnId: f.turn.id,
        expectedRevision: head.revision,
        entries: [
          f.delta(
            { deltaKind: 'indexed-text-delta', partId: 'fresh-orphan', delta: 'new invalid bytes' },
            3
          ),
        ],
      })
    ).rejects.toMatchObject({ code: 'core.protocol.invalid_delta' });
    expect(f.store.getTurnEventsForExport(f.turn.id)).toEqual(before);
    expect(f.audits()).toMatchObject([{ errorCode: 'core.protocol.invalid_delta' }]);
  });

  it('correlates Pending resolution after its native predecessor and refuses a fresh orphan', async () => {
    const f = await fixture();
    const introduction = f.client.products(f.database, {
      products: [],
      entries: [f.delta({ deltaKind: 'request-started', requestRefId: 'r' })],
    });
    const resolution = f.pending({
      products: [],
      entries: [
        f.delta({ deltaKind: 'request-resolved', requestRefId: 'r', status: 'completed' }, 2),
      ],
    });
    await expect(Promise.all([introduction, resolution])).resolves.toHaveLength(2);
    await expect(
      f.pending({
        products: [],
        entries: [
          f.delta(
            { deltaKind: 'request-resolved', requestRefId: 'absent', status: 'completed' },
            3
          ),
        ],
      })
    ).rejects.toMatchObject({ code: 'core.protocol.invalid_delta' });
    expect(f.store.getTurnEventsForExport(f.turn.id)).toHaveLength(2);
    expect(f.audits()).toMatchObject([{ errorCode: 'core.protocol.invalid_delta' }]);
  });

  it('correlates concurrent compound resolutions against the committed predecessor', async () => {
    const f = await fixture();
    await f.client.products(f.database, {
      products: [],
      entries: [f.delta({ deltaKind: 'request-started', requestRefId: 'r' })],
    });
    const results = await Promise.allSettled(
      [2, 3].map((sequence) =>
        f.client.products(f.database, {
          products: [],
          entries: [
            f.delta(
              { deltaKind: 'request-resolved', requestRefId: 'r', status: 'completed' },
              sequence
            ),
          ],
        })
      )
    );
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: { code: 'core.protocol.invalid_delta' } });
    expect(f.store.getTurnEventsForExport(f.turn.id)).toHaveLength(2);
    expect(f.audits()).toMatchObject([{ errorCode: 'core.protocol.invalid_delta' }]);
  });

  it.each(['pending', 'running'] as const)(
    'checks the segment head atomically after idle preflight (%s)',
    async (status) => {
      const f = await fixture();
      const origin = await f.store.createThread(
        f.workspace.id,
        'Old segment',
        undefined,
        'conversation',
        {
          visibility: 'workspace',
          segmentation: { maxObservationLines: 10000, maxBytes: 1, boundaryDelayed: true },
        }
      );
      const previous = await f.store.createTurn(f.workspace.id, origin.id, 'Prior segment', actor);
      await f.store.createItem({
        ...f.item,
        id: allocateEntityId('it'),
        threadId: origin.id,
        turnId: previous.id,
        createdAt: previous.startedAt!,
      });
      await f.store.completeTurn(previous.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      const head = await f.store.createThread(
        f.workspace.id,
        'Current segment',
        undefined,
        'conversation',
        {
          visibility: 'workspace',
          parentThreadId: origin.id,
          segment: 1,
          segmentation: origin.segmentation,
        }
      );
      // The caller observed idle; the competing admission commits before its native decision.
      expect(f.store.listThreadTurns(f.workspace.id, head.id)).toEqual([]);
      const live = await f.store.createTurn(f.workspace.id, head.id, 'Wins the race', actor, null, {
        status,
      });
      const proposed = {
        ...f.turn,
        id: allocateEntityId('tu'),
        threadId: origin.id,
        status,
        items: [],
      };
      await expect(
        f.client.products(f.database, {
          products: [
            {
              kind: 'turn',
              expectedRevision: 0,
              record: writeRetainedV1({
                ...proposed,
                captureCoverage: { scope: 'workspace', value: 'off' },
              }),
            },
          ],
          entries: [],
        })
      ).rejects.toMatchObject({ code: 'thread_busy' });
      expect(f.store.listThreadTurns(f.workspace.id, origin.id).map((turn) => turn.id)).toEqual([
        previous.id,
      ]);
      expect(f.store.listThreadTurns(f.workspace.id, head.id).map((turn) => turn.id)).toEqual([
        live.id,
      ]);
    }
  );

  it.each(['products', 'pending'] as const)(
    'admits a new Turn, actual Item and correlated deltas through %s',
    async (operation) => {
      const f = await fixture();
      const publish = (tuple: ControlProductTransition, target: typeof f.turn) =>
        operation === 'products' ? f.client.products(f.database, tuple) : f.pending(tuple, target);
      const thread = await f.store.createThread(f.workspace.id, 'Born together');
      const turn = { ...f.turn, id: allocateEntityId('tu'), threadId: thread.id, items: [] };
      const item = { ...f.item, id: allocateEntityId('it'), threadId: thread.id, turnId: turn.id };
      await publish(
        {
          products: [
            {
              kind: 'turn',
              expectedRevision: 0,
              record: writeRetainedV1({
                ...turn,
                captureCoverage: { scope: 'workspace', value: 'off' },
              }),
            },
          ],
          entries: [
            {
              kind: 'item',
              turnId: turn.id,
              sequence: 1,
              expectedRevision: 0,
              content: f.content(item),
            },
            f.delta({ deltaKind: 'part-started', partId: 'p' }, 1, turn, item),
            f.delta(
              { deltaKind: 'indexed-text-delta', partId: 'p', delta: 'valid' },
              2,
              turn,
              item
            ),
          ],
        },
        turn
      );
      expect(f.store.getTurnById(turn.id).items).toEqual([item]);
      expect(f.store.getTurnEventsForExport(turn.id)).toHaveLength(2);
      const sibling = await f.store.createThread(f.workspace.id, 'Invalid sibling');
      const badTurn = { ...turn, id: allocateEntityId('tu'), threadId: sibling.id };
      const badItem = {
        ...item,
        id: allocateEntityId('it'),
        threadId: sibling.id,
        turnId: badTurn.id,
      };
      await expect(
        publish(
          {
            products: [
              {
                kind: 'turn',
                expectedRevision: 0,
                record: writeRetainedV1({
                  ...badTurn,
                  captureCoverage: { scope: 'workspace', value: 'off' },
                }),
              },
            ],
            entries: [
              {
                kind: 'item',
                turnId: badTurn.id,
                sequence: 1,
                expectedRevision: 0,
                content: f.content(badItem),
              },
              f.delta(
                { deltaKind: 'indexed-text-delta', partId: 'missing', delta: 'invalid' },
                1,
                badTurn,
                badItem
              ),
            ],
          },
          badTurn
        )
      ).rejects.toMatchObject({ code: 'core.protocol.invalid_delta' });
      expect(f.store.listThreadTurns(f.workspace.id, sibling.id)).toEqual([]);
      expect(f.audits()).toMatchObject([{ errorCode: 'core.protocol.invalid_delta' }]);
    }
  );
});
