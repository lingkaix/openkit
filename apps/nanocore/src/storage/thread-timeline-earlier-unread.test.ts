import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadTimelineInputSchema, ThreadTimelineResponseSchema } from '@openkit/app-api-schemas';
import { allocateEntityId, type Item, writeRetainedV1 } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { recordActiveHumanWorkspaceMember } from '../test-support/active-human-member.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { markThreadRead, readThreadReceiptMembership } from '../thread-read-state.js';
import { readThreadTimeline } from '../thread-timeline.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import * as immutableOwner from './immutable-content.js';
import type { ThreadTimelineSnapshot } from './workspace-file-records.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
type Message = Extract<Item, { type: 'assistant-message' | 'user-message' }>;

/** Publishes real native Items and User-owned read membership; no raw records or fabricated receipts. */
async function fixture(privateThread = false) {
  const root = mkdtempSync(join(tmpdir(), 'timeline-earlier-unread-'));
  const coreDb = createTestCoreDb(root);
  cleanups.push(() => disposeTestStore(root, coreDb));
  const userId = ensureLocalUser(coreDb);
  const otherUserId = allocateEntityId('usr');
  const actor = { kind: 'user', id: userId } as const;
  const store = await createDemoStore({ dataRoot: root });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  recordActiveHumanWorkspaceMember(coreDb, {
    userId: otherUserId,
    email: 'unread-viewer@example.invalid',
    workspaceId: DEMO_WORKSPACE_ID,
    joinedAt: new Date().toISOString(),
    nowMs: Date.now(),
  });
  const thread = await store.createThread(
    DEMO_WORKSPACE_ID,
    'Earlier unread',
    undefined,
    'conversation',
    privateThread
      ? { visibility: 'private', privateOwnerUserId: otherUserId }
      : { visibility: 'workspace' }
  );
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Original probe run', actor);
  async function message(
    text: string,
    options: {
      kind?: 'assistant' | 'own' | 'other' | 'gate';
      status?: Message['status'];
      turn?: typeof turn;
      id?: string;
      createdAt?: string;
    } = {}
  ): Promise<Message> {
    const source = options.turn ?? turn;
    const kind = options.kind ?? 'assistant';
    const status = options.status ?? 'completed';
    const timestamp = options.createdAt ?? new Date().toISOString();
    const base = {
      id: options.id ?? allocateEntityId('it'),
      owner: source.owner,
      threadId: source.threadId,
      turnId: source.id,
      status,
      text,
      createdAt: timestamp,
      completedAt: status === 'completed' ? timestamp : null,
    };
    return (await store.createItem(
      kind === 'assistant'
        ? { ...base, type: 'assistant-message' }
        : {
            ...base,
            type: 'user-message',
            actor:
              kind === 'gate'
                ? { kind: 'system', id: 'nanocore-pending-request', responsibleUserId: userId }
                : { kind: 'user', id: kind === 'other' ? otherUserId : userId },
          }
    )) as Message;
  }
  async function mark(itemIds: string[], ownerUserId = userId, threadId = thread.id) {
    return markThreadRead({
      coreDb,
      store,
      userId: ownerUserId,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId,
      itemIds,
    });
  }
  const receipts = (ownerUserId = userId, threadId = thread.id) =>
    readThreadReceiptMembership({
      coreDb,
      userId: ownerUserId,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId,
    });
  let app: ReturnType<typeof createApp> | undefined;
  async function read(input: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    app ??= createApp({ coreDb, store });
    const response = await app.request('/api/app/operations/thread.timeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id, ...input }),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { response, body };
  }
  return {
    root,
    coreDb,
    userId,
    otherUserId,
    actor,
    store,
    thread,
    turn,
    message,
    mark,
    receipts,
    read,
  };
}

/** Validates the public response and its top-level proof result without inventing a catch-up object. */
function projection(result: { response: Response; body: unknown }) {
  expect(result.response.status, JSON.stringify(result.body)).toBe(200);
  return ThreadTimelineResponseSchema.parse(result.body);
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Measures only the new probe through real snapshot capabilities; other timeline owners keep their original reads. */
function observeProbe(store: Fixture['store']) {
  const observed = {
    bodies: [] as string[],
    requests: [] as string[],
    limits: [] as number[],
    boundedBodies: [] as string[],
    returnedBytes: 0,
    legacy: [] as string[],
    beforeBLegacy: [] as string[],
    positions: 0,
    turnRows: 0,
    heads: 0,
    bytes: 0,
  };
  const actual = store.readThreadTimelineSnapshot.bind(store);
  const inProbe = () => (new Error().stack ?? '').includes('at earlierUnread (');
  const immutableRead = immutableOwner.readImmutableProductJson;
  // This is the real immutable reader, including inline bodies. A refusal must not hide an actual body read.
  vi.spyOn(immutableOwner, 'readImmutableProductJson').mockImplementation((...args) => {
    const selected = inProbe();
    if (selected) observed.bytes += args[2].byteLength;
    const value = immutableRead(...args);
    if (
      selected &&
      value &&
      typeof value === 'object' &&
      'id' in value &&
      typeof value.id === 'string'
    )
      observed.bodies.push(value.id);
    return value;
  });
  const instrument = (snapshot: ThreadTimelineSnapshot) =>
    new Proxy(snapshot, {
      get(target, key) {
        if (key === 'item')
          return (itemId: string) => {
            observed.legacy.push(itemId);
            if (inProbe()) observed.beforeBLegacy.push(itemId);
            return target.item(itemId);
          };
        if (key === 'itemWithinBytes')
          return (itemId: string, maxBytes: number) => {
            const selected = inProbe();
            if (selected) {
              observed.requests.push(itemId);
              observed.limits.push(maxBytes);
              expect(Number.isSafeInteger(maxBytes)).toBe(true);
              expect(maxBytes).toBeGreaterThanOrEqual(0);
              expect(maxBytes).toBeLessThanOrEqual(65_536);
              expect(maxBytes).toBe(65_536 - observed.returnedBytes);
            }
            const result = target.itemWithinBytes(itemId, maxBytes);
            if (selected && result) {
              const encodedBytes = Buffer.byteLength(
                JSON.stringify(writeRetainedV1(result.item)),
                'utf8'
              );
              expect(result.byteLength).toBeGreaterThanOrEqual(encodedBytes);
              expect(result.byteLength).toBeLessThanOrEqual(maxBytes);
              observed.boundedBodies.push(result.item.id);
              observed.returnedBytes += result.byteLength;
            }
            return result;
          };
        if (key === 'itemHead')
          return (turnId: string) => {
            if (inProbe()) observed.heads++;
            return target.itemHead(turnId);
          };
        if (key === 'positions')
          return (...args: Parameters<ThreadTimelineSnapshot['positions']>) => {
            const selected = inProbe();
            const rows = target.positions(...args);
            if (selected) observed.positions += rows.length;
            return rows;
          };
        if (key === 'turns')
          return (...args: Parameters<ThreadTimelineSnapshot['turns']>) => {
            const selected = inProbe();
            const rows = target.turns(...args);
            if (selected) observed.turnRows += rows.length;
            return rows;
          };
        return Reflect.get(target, key);
      },
    });
  const completeRead = () => {
    expect(observed.requests.length).toBeLessThanOrEqual(128);
    expect(observed.bytes).toBeLessThanOrEqual(65_536);
    expect(observed.returnedBytes).toBeLessThanOrEqual(65_536);
    expect(observed.beforeBLegacy).toEqual([]);
  };
  vi.spyOn(store, 'readThreadTimelineSnapshot').mockImplementation((workspaceId, threadId, read) =>
    actual(workspaceId, threadId, (snapshot) => {
      const result = read(instrument(snapshot));
      completeRead();
      return result;
    })
  );
  const actualCooperative = store.readThreadTimelineSnapshotCooperative.bind(store);
  // The real generator is exhausted before the same end-of-read observations run.
  vi.spyOn(store, 'readThreadTimelineSnapshotCooperative').mockImplementation(
    <T>(
      workspaceId: string,
      threadId: string,
      read: (snapshot: ThreadTimelineSnapshot) => Generator<void, T, void>,
      signal?: AbortSignal
    ): Promise<T> =>
      actualCooperative(
        workspaceId,
        threadId,
        function* (snapshot: ThreadTimelineSnapshot) {
          const result = yield* read(instrument(snapshot));
          completeRead();
          return result;
        },
        signal
      )
  );
  return observed;
}

describe('Bounded earlier-unread proof before B', () => {
  it('returns unknown when B is absent, not a false zero', async () => {
    const f = await fixture();
    await f.message('Unread without any prior read or own message');
    const probe = observeProbe(f.store);
    const body = projection(await f.read());
    expect(body.catchUpAnchor).toBeNull();
    expect(body.earlierUnread).toBeNull();
    expect(probe.requests).toEqual([]);
    expect(probe.beforeBLegacy).toEqual([]);
    expect(probe.bodies).toEqual([]);
    expect(probe.legacy.length).toBeGreaterThan(0);
  }, 30_000);

  it('finds sparse unread holes before the latest own-input B without counting later messages', async () => {
    const f = await fixture();
    const oldest = await f.message('First unread hole');
    const seen = await f.message('Actually read');
    await f.message('Second unread hole');
    await f.mark([seen.id]);
    const boundary = await f.message('Latest own input', { kind: 'own' });
    await f.message('After B, not an earlier unread message');
    const probe = observeProbe(f.store);
    const body = projection(await f.read());
    expect(body.catchUpAnchor).toEqual({ turnId: f.turn.id, itemId: boundary.id });
    expect(body.earlierUnread).toEqual({
      count: 2,
      capped: false,
      oldest: { turnId: f.turn.id, itemId: oldest.id },
    });
    expect(probe.requests.length).toBeGreaterThan(0);
    expect(probe.requests.length).toBeLessThanOrEqual(128);
    expect(probe.beforeBLegacy).toEqual([]);
    expect(probe.bytes).toBeGreaterThan(0);
    expect(probe.bytes).toBeLessThanOrEqual(65_536);
    expect(probe.returnedBytes).toBe(probe.bytes);
    expect(probe.boundedBodies).toEqual(probe.bodies);
    expect(probe.legacy.length).toBeGreaterThan(0);
  }, 30_000);

  it('returns a proved zero when the entire prefix is empty before an existing B', async () => {
    const f = await fixture();
    const boundary = await f.message('Own B at the first position', { kind: 'own' });
    await f.message('After B');
    const body = projection(await f.read());
    expect(body.catchUpAnchor).toEqual({ turnId: f.turn.id, itemId: boundary.id });
    expect(body.earlierUnread).toEqual({ count: 0, capped: false, oldest: null });
  }, 30_000);

  it('returns unknown with no Core even when a real own-input B exists', async () => {
    const f = await fixture();
    await f.message('Unread before B');
    const boundary = await f.message('Own B', { kind: 'own' });
    expect(projection(await f.read()).earlierUnread?.count).toBe(1);
    const probe = observeProbe(f.store);
    const body = readThreadTimeline({
      store: f.store,
      actor: { kind: 'local', userId: f.userId },
      administratorEligible: true,
      input: ThreadTimelineInputSchema.parse({
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: f.thread.id,
      }),
    });
    expect(body.catchUpAnchor).toEqual({ turnId: f.turn.id, itemId: boundary.id });
    expect(body.earlierUnread).toBeNull();
    expect(probe.bodies).toEqual([]);
  }, 30_000);

  it('uses receipt membership and append positions, not receipt serialization, IDs or message timestamps', async () => {
    const f = await fixture();
    const oldest = await f.message('Unread hole before both read messages');
    const [small, large] = [allocateEntityId('it'), allocateEntityId('it')].sort();
    const first = await f.message('Read first in append order', {
      id: large!,
      createdAt: '2030-01-01T00:00:00.000Z',
    });
    const last = await f.message('Read last despite its lower ID and timestamp', {
      id: small!,
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    await f.mark([last.id, first.id]);
    expect(f.receipts()).toEqual([last.id, first.id]);
    await f.message('Unread after the last read, outside the prefix');
    const body = projection(await f.read());
    expect(body.catchUpAnchor).toEqual({ turnId: f.turn.id, itemId: last.id });
    expect(body.earlierUnread).toEqual({
      count: 1,
      capped: false,
      oldest: { turnId: f.turn.id, itemId: oldest.id },
    });
  }, 30_000);

  it('orders runs by native admission even when recorded run timestamps go backwards', async () => {
    const f = await fixture();
    const oldest = await f.message('Unread in the first admitted run');
    await f.store.completeTurn(f.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const later = await f.store.createTurn(
      DEMO_WORKSPACE_ID,
      f.thread.id,
      'Later admission with an older clock',
      f.actor,
      null,
      { startedAt: '2000-01-01T00:00:00.000Z' }
    );
    const seen = await f.message('Read B in the later run', {
      turn: later,
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    await f.mark([seen.id]);
    const body = projection(await f.read());
    expect(body.catchUpAnchor).toEqual({ turnId: later.id, itemId: seen.id });
    expect(body.earlierUnread).toEqual({
      count: 1,
      capped: false,
      oldest: { turnId: f.turn.id, itemId: oldest.id },
    });
  }, 30_000);

  it('does not borrow another Thread\u2019s receipts or own-input boundary', async () => {
    const f = await fixture();
    const oldest = await f.message('Main Thread unread');
    const boundary = await f.message('Main Thread own B', { kind: 'own' });
    const foreign = await f.store.createThread(DEMO_WORKSPACE_ID, 'Foreign Thread');
    const foreignTurn = await f.store.createTurn(
      DEMO_WORKSPACE_ID,
      foreign.id,
      'Foreign source',
      f.actor
    );
    const foreignSeen = await f.message('Foreign receipt', { turn: foreignTurn });
    await f.mark([foreignSeen.id], f.userId, foreign.id);
    await f.message('Foreign latest own input', { kind: 'own', turn: foreignTurn });
    const body = projection(await f.read());
    expect(body.catchUpAnchor).toEqual({ turnId: f.turn.id, itemId: boundary.id });
    expect(body.earlierUnread).toEqual({
      count: 1,
      capped: false,
      oldest: { turnId: f.turn.id, itemId: oldest.id },
    });
  }, 30_000);

  it('keeps two real viewers\u2019 receipts and own-input exclusions independent', async () => {
    const f = await fixture();
    const oldest = await f.message('Unread for both viewers');
    const rootSeen = await f.message('Read only by the first viewer');
    const rootBoundary = await f.message(
      'Own input for the first viewer, another human\u2019s input for the second',
      { kind: 'own' }
    );
    const otherBoundary = await f.message('Read only by the second viewer');
    await f.mark([rootSeen.id]);
    await f.mark([otherBoundary.id], f.otherUserId);
    const beforeRoot = f.receipts(),
      beforeOther = f.receipts(f.otherUserId);
    const root = projection(await f.read());
    expect(root.catchUpAnchor).toEqual({ turnId: f.turn.id, itemId: rootBoundary.id });
    expect(root.earlierUnread).toEqual({
      count: 1,
      capped: false,
      oldest: { turnId: f.turn.id, itemId: oldest.id },
    });
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.otherUserId,
      scope: 'workspace',
      workspaceIds: [DEMO_WORKSPACE_ID],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const other = projection(await f.read({}, { authorization: `Bearer ${token.secret}` }));
    expect(other.catchUpAnchor).toEqual({ turnId: f.turn.id, itemId: otherBoundary.id });
    expect(other.earlierUnread).toEqual({
      count: 3,
      capped: false,
      oldest: { turnId: f.turn.id, itemId: oldest.id },
    });
    expect(f.receipts()).toEqual(beforeRoot);
    expect(f.receipts(f.otherUserId)).toEqual(beforeOther);
  }, 30_000);

  it('uses current revisions and the unchanged completion, text, own-input and hidden-gate predicates', async () => {
    const f = await fixture();
    const oldest = await f.message('Initially streaming', { status: 'in_progress' });
    const emptied = await f.message('Initially visible');
    const failed = await f.message('Initially completed');
    const revived = await f.message('');
    await f.message('Still streaming', { status: 'in_progress' });
    await f.message('Hidden gate delivery', { kind: 'gate' });
    await f.message('Earlier own input', { kind: 'own' });
    await f.message('Other human input is eligible', { kind: 'other' });
    const boundary = await f.message('Latest own B', { kind: 'own' });
    await f.store.updateItem(oldest.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    await f.store.updateItem(emptied.id, { text: '\u00a0\u2003\u2028\ufeff\t\r\n ' });
    await f.store.updateItem(failed.id, { status: 'failed' });
    await f.store.updateItem(revived.id, { text: 'Now eligible, at its original position' });
    const body = projection(await f.read());
    expect(body.catchUpAnchor).toEqual({ turnId: f.turn.id, itemId: boundary.id });
    expect(body.earlierUnread).toEqual({
      count: 3,
      capped: false,
      oldest: { turnId: f.turn.id, itemId: oldest.id },
    });
  }, 30_000);

  it.each([100, 101])(
    'proves the exact count-cap boundary with %i short genuine unread messages',
    async (count) => {
      const f = await fixture();
      const messages: Message[] = [];
      for (let index = 0; index < count; index++) messages.push(await f.message('x'));
      // This is a qualified count test, not a body-budget failure disguised as a count regression.
      expect(
        messages.reduce(
          (bytes, item) => bytes + Buffer.byteLength(JSON.stringify(writeRetainedV1(item))),
          0
        )
      ).toBeLessThanOrEqual(65_536);
      await f.message('Own B', { kind: 'own' });
      const probe = observeProbe(f.store);
      const body = projection(await f.read());
      expect(body.earlierUnread).toEqual({
        count: 100,
        capped: count === 101,
        oldest: { turnId: f.turn.id, itemId: messages[0]!.id },
      });
      expect(probe.bodies.length).toBe(count);
      expect(probe.bytes).toBeLessThanOrEqual(65_536);
    },
    30_000
  );

  it.each([127, 128, 129])(
    'handles %i read candidate positions without inventing a proved zero beyond the probe',
    async (count) => {
      const f = await fixture();
      const messages: Message[] = [];
      for (let index = 0; index < count; index++) messages.push(await f.message('x'));
      await f.mark(messages.map((item) => item.id));
      await f.message('Own B', { kind: 'own' });
      const before = f.receipts();
      const probe = observeProbe(f.store);
      const body = projection(await f.read());
      expect(body.earlierUnread).toEqual(
        count <= 128 ? { count: 0, capped: false, oldest: null } : null
      );
      expect(probe.positions).toBeGreaterThan(0);
      expect(probe.positions).toBeLessThanOrEqual(128);
      expect(probe.bodies).toEqual([]);
      expect(f.receipts()).toEqual(before);
    },
    30_000
  );

  it('returns unknown at 128 inspected messages when a later non-message position prevents an exhaustion proof', async () => {
    const f = await fixture();
    const read: Message[] = [];
    for (let index = 0; index < 128; index++) read.push(await f.message('x'));
    await f.mark(read.map((item) => item.id));
    await f.store.createItem({
      id: allocateEntityId('it'),
      owner: f.turn.owner,
      threadId: f.thread.id,
      turnId: f.turn.id,
      type: 'command-execution',
      command: 'recorded tail step',
      cwd: '.',
      output: '',
      exitCode: 0,
      durationMs: 0,
      status: 'completed',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await f.message('Own B', { kind: 'own' });
    const probe = observeProbe(f.store);
    expect(projection(await f.read()).earlierUnread).toBeNull();
    expect(probe.positions).toBe(128);
    expect(probe.bodies).toEqual([]);
  }, 30_000);

  it('does not use an unbounded prior-turn head aggregate to prove exhaustion at exactly 128 messages', async () => {
    const f = await fixture();
    const read: Message[] = [];
    for (let index = 0; index < 128; index++) read.push(await f.message('x'));
    await f.mark(read.map((item) => item.id));
    await f.store.completeTurn(f.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const later = await f.store.createTurn(
      DEMO_WORKSPACE_ID,
      f.thread.id,
      'B in the next run',
      f.actor
    );
    await f.message('Own B', { kind: 'own', turn: later });
    const probe = observeProbe(f.store);
    expect(projection(await f.read()).earlierUnread).toBeNull();
    expect(probe.positions).toBe(128);
    expect(probe.heads).toBe(0);
    expect(probe.bodies).toEqual([]);
  }, 30_000);

  it.each([32, 33])(
    'uses only the first 32 turns plus lookahead with B in run %i',
    async (count) => {
      const f = await fixture();
      let current = f.turn;
      for (let index = 1; index < count; index++) {
        await f.store.completeTurn(current.id, {
          status: 'completed',
          completedAt: new Date().toISOString(),
        });
        current = await f.store.createTurn(
          DEMO_WORKSPACE_ID,
          f.thread.id,
          `Probe run ${index + 1}`,
          f.actor
        );
      }
      const oldest = await f.message('Unread in the B run', { turn: current });
      await f.message('Own B', { kind: 'own', turn: current });
      const probe = observeProbe(f.store);
      const body = projection(await f.read());
      expect(body.earlierUnread).toEqual(
        count === 32
          ? { count: 1, capped: false, oldest: { turnId: current.id, itemId: oldest.id } }
          : null
      );
      expect(probe.turnRows).toBeLessThanOrEqual(33);
      expect(probe.heads).toBe(0);
      expect(probe.bodies).toEqual(count === 32 ? [oldest.id] : []);
    },
    30_000
  );

  it('returns unknown before opening an oversized unreceipted current body or any later candidate', async () => {
    const f = await fixture();
    const large = await f.message('x'.repeat(80_000));
    const later = await f.message('Later candidate must not be opened by the probe');
    await f.message('Own B', { kind: 'own' });
    const probe = observeProbe(f.store);
    expect(projection(await f.read()).earlierUnread).toBeNull();
    expect(probe.requests).toContain(large.id);
    expect(probe.bodies).not.toContain(large.id);
    expect(probe.bodies).not.toContain(later.id);
  }, 30_000);

  it('uses a cumulative canonical-body budget and discards partial count and oldest on exhaustion', async () => {
    const f = await fixture();
    const items: Message[] = [];
    for (let index = 0; index < 3; index++) items.push(await f.message('x'.repeat(24_000)));
    const sizes = items.map((item) => Buffer.byteLength(JSON.stringify(writeRetainedV1(item))));
    expect(sizes[0]! + sizes[1]!).toBeLessThanOrEqual(65_536);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThan(65_536);
    const later = await f.message('Never open after exhaustion');
    await f.message('Own B', { kind: 'own' });
    const probe = observeProbe(f.store);
    expect(projection(await f.read()).earlierUnread).toBeNull();
    expect(probe.bodies).toEqual(items.slice(0, 2).map((item) => item.id));
    expect(probe.requests).toContain(items[2]!.id);
    expect(probe.bodies).not.toContain(later.id);
    expect(probe.bytes).toBeLessThanOrEqual(65_536);
  }, 30_000);

  it('skips a genuinely read large body before invoking the bounded reader or opening its body', async () => {
    const f = await fixture();
    const large = await f.message('x'.repeat(80_000));
    const oldest = await f.message('Unread hole after the read large body');
    await f.mark([large.id]);
    await f.message('Own B', { kind: 'own' });
    const before = f.receipts();
    const probe = observeProbe(f.store);
    expect(projection(await f.read()).earlierUnread).toEqual({
      count: 1,
      capped: false,
      oldest: { turnId: f.turn.id, itemId: oldest.id },
    });
    expect(probe.bodies).toEqual([oldest.id]);
    expect(probe.requests).not.toContain(large.id);
    expect(f.receipts()).toEqual(before);
  }, 30_000);

  it('uses the current revised body size rather than the small first-revision descriptor', async () => {
    const f = await fixture();
    const changed = await f.message('x');
    await f.message('Own B', { kind: 'own' });
    await f.store.updateItem(changed.id, { text: 'x'.repeat(80_000) });
    const probe = observeProbe(f.store);
    expect(projection(await f.read()).earlierUnread).toBeNull();
    expect(probe.requests).toContain(changed.id);
    expect(probe.bodies).not.toContain(changed.id);
  }, 30_000);

  it('checks the private Thread audience before invoking any timeline snapshot or exposing unread facts', async () => {
    const f = await fixture(true);
    await f.message('Private unread content');
    await f.message('Own B', { kind: 'own' });
    expect(projection(await f.read()).earlierUnread?.count).toBe(1);
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.userId,
      scope: 'workspace',
      workspaceIds: [DEMO_WORKSPACE_ID],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const snapshots = vi.spyOn(f.store, 'readThreadTimelineSnapshot');
    const cooperativeSnapshots = vi.spyOn(f.store, 'readThreadTimelineSnapshotCooperative');
    const denied = await f.read({}, { authorization: `Bearer ${token.secret}` });
    expect(denied.response.status).toBe(404);
    expect(JSON.stringify(denied.body)).not.toContain('Private unread content');
    expect(snapshots).not.toHaveBeenCalled();
    expect(cooperativeSnapshots).not.toHaveBeenCalled();
  }, 30_000);

  it('seeks original message positions without traversing old revisions or a long non-message prefix', async () => {
    const f = await fixture();
    const revised = await f.message('Original recorded note');
    for (let index = 0; index < 140; index++)
      await f.store.updateItem(revised.id, { text: `Recorded revision ${index}` });
    await f.mark([revised.id]);
    for (let index = 0; index < 200; index++)
      await f.store.createItem({
        id: allocateEntityId('it'),
        owner: f.turn.owner,
        threadId: f.thread.id,
        turnId: f.turn.id,
        type: 'command-execution',
        command: 'recorded fixture step',
        cwd: '.',
        output: '',
        exitCode: 0,
        durationMs: 0,
        status: 'completed',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
    const oldest = await f.message('Unread after 200 steps');
    await f.message('Own B', { kind: 'own' });
    const plans: string[] = [];
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      const statement = prepare.call(this, sql);
      if (
        (new Error().stack ?? '').includes('at earlierUnread (') &&
        /\bfrom\s+control_product_entries\b/i.test(sql)
      ) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, 'all').mockImplementation((...bindings: unknown[]) => {
          const rows = all(...bindings);
          const plan = prepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{
            detail: string;
          }>;
          plans.push(...plan.map((row) => row.detail));
          return rows;
        });
      }
      return statement;
    });
    const probe = observeProbe(f.store);
    expect(projection(await f.read()).earlierUnread).toEqual({
      count: 1,
      capped: false,
      oldest: { turnId: f.turn.id, itemId: oldest.id },
    });
    expect(probe.bodies).toEqual([oldest.id]);
    expect(
      plans.some((detail) => detail.includes('control_items_turn_type_idx')),
      JSON.stringify(plans)
    ).toBe(true);
    expect(plans.some((detail) => /SCAN (?:e|control_product_entries)\b/i.test(detail))).toBe(
      false
    );
  }, 30_000);
});
