import { randomUUID } from 'node:crypto';
import { mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadTimelineResponseSchema } from '@openkit/app-api-schemas';
import { allocateEntityId, type Item } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import {
  answerRecordedUserInput,
  raiseRecordedPendingRequest,
  withdrawRecordedPendingRequest,
} from '../runtime/pending-request-flow.js';
import { readPendingRequest } from '../runtime/pending-requests.js';
import { recordActiveHumanWorkspaceMember } from '../test-support/active-human-member.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { commandInputHash } from './control-store-input.js';
import { openWorkspaceDb } from './db.js';
import { nativeProductScope, type ThreadTimelineSnapshot } from './workspace-file-records.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
type QuestionItem = Extract<Item, { type: 'user-input-request' }>;

/** Publishes real request Items and Pending records; no canonical SQL or receipt construction. */
async function fixture(
  kind: 'approval' | 'user-input' = 'user-input',
  options: { privateSource?: boolean; largePrompt?: boolean } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'timeline-request-anchor-'));
  const coreDb = createTestCoreDb(root);
  const handles: ReturnType<typeof openWorkspaceDb>[] = [];
  cleanups.push(() => disposeTestStore(root, ...handles, coreDb));
  const userId = ensureLocalUser(coreDb);
  const viewer = { kind: 'local', userId } as const;
  const store = await createDemoStore({ dataRoot: root });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  const sourceUserId = options.privateSource ? allocateEntityId('usr') : userId;
  if (options.privateSource)
    recordActiveHumanWorkspaceMember(coreDb, {
      userId: sourceUserId,
      email: 'source-owner@example.invalid',
      workspaceId: DEMO_WORKSPACE_ID,
      joinedAt: new Date().toISOString(),
      nowMs: Date.now(),
    });
  const actor = { kind: 'user', id: sourceUserId } as const;
  const thread = await store.createThread(
    DEMO_WORKSPACE_ID,
    'Exact request anchor',
    undefined,
    'conversation',
    options.privateSource
      ? { visibility: 'private', privateOwnerUserId: sourceUserId }
      : { visibility: 'workspace' }
  );
  const turn = await store.createTurn(
    DEMO_WORKSPACE_ID,
    thread.id,
    'Original question or approval',
    actor
  );
  const workspaceDb = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
  handles.push(workspaceDb);
  const requestId = randomUUID();
  const itemId = allocateEntityId('it');
  const timestamp = new Date().toISOString();
  const question: QuestionItem = {
    id: itemId,
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    type: 'user-input-request',
    status: 'completed',
    responsibleUserId: sourceUserId,
    userInputRequestId: requestId,
    prompt: options.largePrompt
      ? 'Original retained question prompt. '.repeat(12_000)
      : 'Exact original source prompt',
    questions: [
      {
        id: 'path',
        header: 'Path',
        question: 'Which recorded path should be used?',
        options: null,
        isOther: true,
        isSecret: false,
      },
    ],
    createdAt: timestamp,
    completedAt: timestamp,
  };
  await raiseRecordedPendingRequest(
    store,
    workspaceDb.sqlite,
    {
      requestId,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: thread.id,
      raisingTurnId: turn.id,
      requestItemId: itemId,
      kind,
      requesterKind: 'assistant',
      responsibleUserId: sourceUserId,
      ...(kind === 'approval'
        ? {
            approval: {
              kind: 'permission' as const,
              title: 'Review this exact action',
              description: 'Original recorded approval',
            },
          }
        : {
            questions: question.questions,
            questionDigest: commandInputHash(question.questions),
          }),
      now: timestamp,
    },
    kind === 'user-input' ? question : undefined
  );
  expect(readPendingRequest(workspaceDb.sqlite, requestId)).toMatchObject({
    kind,
    state: 'pending',
    requestItemId: itemId,
  });
  const anchor =
    kind === 'approval'
      ? { kind: 'approval-request', approvalRequestId: requestId }
      : { kind: 'user-input-request', userInputRequestId: requestId };
  let app: ReturnType<typeof createApp> | undefined;
  const read = async (
    input: Record<string, unknown> = {},
    headers: Record<string, string> = {}
  ) => {
    app ??= createApp({ coreDb, store });
    const response = await app.request('/api/app/operations/thread.timeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: thread.id,
        anchor,
        ...input,
      }),
    });
    return { response, body: await response.json() };
  };
  return {
    root,
    coreDb,
    workspaceDb,
    store,
    thread,
    turn,
    actor,
    viewer,
    userId,
    requestId,
    itemId,
    question,
    anchor,
    read,
  };
}

/** Requires the exact original request, not merely a successful response or another run containing the same text. */
function expectOriginal(
  result: { response: Response; body: unknown },
  expected: { turnId: string; itemId: string; type: string }
) {
  expect(result.response.status, JSON.stringify(result.body)).toBe(200);
  const body = ThreadTimelineResponseSchema.parse(result.body);
  expect(body.anchor).toEqual({ turnId: expected.turnId, itemId: expected.itemId });
  expect(body.itemWindow).not.toBeNull();
  expect(body.itemWindow!.items.find((item) => item.id === expected.itemId)).toMatchObject({
    id: expected.itemId,
    turnId: expected.turnId,
    type: expected.type,
  });
}

describe('Exact request-ID timeline anchors', () => {
  it.each(['approval', 'user-input'] as const)(
    'anchors a genuinely pending %s request through its exact selector',
    async (kind) => {
      const f = await fixture(kind);
      expectOriginal(await f.read(), {
        turnId: f.turn.id,
        itemId: f.itemId,
        type: kind === 'approval' ? 'approval-request' : 'user-input-request',
      });
      expect(readPendingRequest(f.workspaceDb.sqlite, f.requestId)).toMatchObject({
        state: 'pending',
        requestItemId: f.itemId,
      });
    },
    30_000
  );

  it('finds the original request outside the loaded narrative window without mutating it', async () => {
    const f = await fixture();
    for (let index = 0; index < 75; index++)
      await f.store.createItem({
        id: allocateEntityId('it'),
        owner: f.turn.owner,
        threadId: f.thread.id,
        turnId: f.turn.id,
        type: 'assistant-message',
        status: 'completed',
        text: `Later note ${index}`,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
    const latest = await f.read({ anchor: { kind: 'latest' } });
    expect(latest.response.status).toBe(200);
    const latestBody = ThreadTimelineResponseSchema.parse(latest.body);
    expect(
      latestBody.runs
        .find((run) => run.id === f.turn.id)!
        .narrative.some((item) => item.id === f.itemId)
    ).toBe(false);
    const before = f.store.getTurnById(f.turn.id);
    const requestBefore = readPendingRequest(f.workspaceDb.sqlite, f.requestId);
    expectOriginal(await f.read(), {
      turnId: f.turn.id,
      itemId: f.itemId,
      type: 'user-input-request',
    });
    expect(f.store.getTurnById(f.turn.id)).toEqual(before);
    expect(readPendingRequest(f.workspaceDb.sqlite, f.requestId)).toEqual(requestBefore);
  }, 30_000);

  it.each(['answered', 'withdrawn'] as const)(
    'anchors a genuinely %s request on its terminal raising Turn rather than the later run',
    async (outcome) => {
      const f = await fixture(outcome === 'answered' ? 'user-input' : 'approval');
      const dependencies = {
        coreDb: f.coreDb,
        openWorkspace: (workspaceId: string) => openWorkspaceDb(f.root, workspaceId),
      };
      // Resolve while the actual raising Turn is still active: original admission correctly starts no successor.
      if (outcome === 'answered')
        await answerRecordedUserInput(
          f.store,
          f.workspaceDb.sqlite,
          {
            requestId: f.requestId,
            workspaceId: DEMO_WORKSPACE_ID,
            threadId: f.thread.id,
            answers: { path: ['Recorded answer'] },
          },
          f.userId,
          f.coreDb,
          f.viewer,
          dependencies
        );
      else
        await withdrawRecordedPendingRequest(
          f.store,
          f.workspaceDb.sqlite,
          f.requestId,
          DEMO_WORKSPACE_ID,
          f.thread.id,
          f.userId,
          dependencies,
          f.viewer
        );
      expect(readPendingRequest(f.workspaceDb.sqlite, f.requestId)).toMatchObject(
        outcome === 'answered'
          ? { state: 'resolved', resolution: 'answered' }
          : { state: 'ended', ending: 'withdrawn' }
      );
      await f.store.completeTurn(f.turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      const later = await f.store.createTurn(
        DEMO_WORKSPACE_ID,
        f.thread.id,
        'Later independent work',
        f.actor
      );
      const latest = await f.read({ anchor: { kind: 'latest' }, limit: 1 });
      expect(latest.response.status).toBe(200);
      expect(ThreadTimelineResponseSchema.parse(latest.body).runs.map((run) => run.id)).toEqual([
        later.id,
      ]);
      const before = readPendingRequest(f.workspaceDb.sqlite, f.requestId);
      expectOriginal(await f.read({ limit: 1 }), {
        turnId: f.turn.id,
        itemId: f.itemId,
        type: outcome === 'answered' ? 'user-input-request' : 'approval-request',
      });
      expect(readPendingRequest(f.workspaceDb.sqlite, f.requestId)).toEqual(before);
      expect(f.store.getTurnById(f.turn.id).status).toBe('completed');
    },
    30_000
  );

  it('rejects an absent request, the wrong exact kind and foreign Thread or Workspace scope', async () => {
    const f = await fixture();
    const foreignThread = await f.store.createThread(DEMO_WORKSPACE_ID, 'Other admitted Thread');
    const foreignWorkspace = await f.store.createWorkspace('Other admitted Workspace');
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: foreignWorkspace.id,
      ownerUserId: f.userId,
    });
    const foreignWorkspaceThread = await f.store.createThread(
      foreignWorkspace.id,
      'Other Workspace Thread'
    );
    const cases = [
      { anchor: { kind: 'user-input-request', userInputRequestId: randomUUID() } },
      { anchor: { kind: 'approval-request', approvalRequestId: f.requestId } },
      { threadId: foreignThread.id },
      { workspaceId: foreignWorkspace.id, threadId: foreignWorkspaceThread.id },
    ];
    for (const input of cases) {
      const result = await f.read(input);
      expect(result.response.status, JSON.stringify(result.body)).toBe(404);
      expect(JSON.stringify(result.body)).not.toContain(f.question.prompt);
    }
    expect(readPendingRequest(f.workspaceDb.sqlite, f.requestId)).toMatchObject({
      state: 'pending',
    });
  }, 30_000);

  it('rejects conflicting or mismatched selector keys instead of choosing either request kind', async () => {
    const f = await fixture();
    const anchors = [
      { kind: 'approval-request', approvalRequestId: f.requestId, userInputRequestId: f.requestId },
      {
        kind: 'user-input-request',
        userInputRequestId: f.requestId,
        approvalRequestId: f.requestId,
      },
      { kind: 'user-input-request', approvalRequestId: f.requestId },
    ];
    for (const anchor of anchors) {
      const result = await f.read({ anchor });
      expect(result.response.status, JSON.stringify(result.body)).toBe(400);
    }
  }, 30_000);

  it('rechecks the current private Thread audience rather than borrowing prior administrator visibility', async () => {
    const f = await fixture('user-input', { privateSource: true });
    expectOriginal(await f.read(), {
      turnId: f.turn.id,
      itemId: f.itemId,
      type: 'user-input-request',
    });
    // A real Workspace-scoped credential has no deployment-administrator override for this other User's private Thread.
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.userId,
      scope: 'workspace',
      workspaceIds: [DEMO_WORKSPACE_ID],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const denied = await f.read({}, { authorization: `Bearer ${token.secret}` });
    expect(denied.response.status).toBe(404);
    expect(JSON.stringify(denied.body)).not.toContain(f.question.prompt);
    expect(JSON.stringify(denied.body)).not.toContain(f.question.questions[0]!.question);
    expect(readPendingRequest(f.workspaceDb.sqlite, f.requestId)).toMatchObject({
      state: 'pending',
    });
  }, 30_000);

  it('fails closed when the genuine request Item body is missing and leaves its record unchanged', async () => {
    const f = await fixture('user-input', { largePrompt: true });
    expectOriginal(await f.read(), {
      turnId: f.turn.id,
      itemId: f.itemId,
      type: 'user-input-request',
    });
    const descriptor = f.workspaceDb.sqlite
      .prepare(
        "SELECT content_json FROM control_product_entries WHERE kind='item' AND id=? AND is_current=1"
      )
      .get(f.itemId) as { content_json: string };
    const content = JSON.parse(descriptor.content_json);
    expect(content.reference.representation).not.toBe('inline');
    const scope = nativeProductScope(f.root, f.turn.owner);
    const path = join(scope.contentMount.root, content.reference.locator.path);
    const hidden = `${path}.fault-hidden`;
    const before = readPendingRequest(f.workspaceDb.sqlite, f.requestId);
    // Physical fault only after a fully validated public read; no fake row, reference, hash or receipt.
    renameSync(path, hidden);
    try {
      const result = await f.read();
      expect(result.response.status).toBe(404);
      expect(JSON.stringify(result.body)).not.toContain('Original retained question prompt.');
      expect(readPendingRequest(f.workspaceDb.sqlite, f.requestId)).toEqual(before);
    } finally {
      renameSync(hidden, path);
    }
  }, 30_000);

  it('rejects duplicate canonical request Items instead of selecting the first or latest match', async () => {
    const f = await fixture();
    await f.store.completeTurn(f.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const later = await f.store.createTurn(
      DEMO_WORKSPACE_ID,
      f.thread.id,
      'Later original run',
      f.actor
    );
    // Deliberate post-publication contradiction through the actual Item owner, not a fabricated Pending record.
    await f.store.createItem({ ...f.question, id: allocateEntityId('it'), turnId: later.id });
    const result = await f.read();
    expect(result.response.status).toBe(404);
    expect(readPendingRequest(f.workspaceDb.sqlite, f.requestId)).toMatchObject({
      state: 'pending',
      requestItemId: f.itemId,
    });
  }, 30_000);

  it('bounds canonical source-body materialization when request associations exceed 256', async () => {
    const f = await fixture();
    for (let index = 0; index < 257; index++)
      await f.store.createItem({
        ...f.question,
        id: allocateEntityId('it'),
        causationId: f.itemId,
      });
    let bodyReads = 0;
    const actual = f.store.readThreadTimelineSnapshot.bind(f.store);
    // Observe the public snapshot read capability without changing any returned native fact.
    const instrument = (snapshot: ThreadTimelineSnapshot) =>
      new Proxy(snapshot, {
        get(target, key) {
          if (key === 'item')
            return (itemId: string) => {
              bodyReads++;
              return target.item(itemId);
            };
          return Reflect.get(target, key);
        },
      });
    vi.spyOn(f.store, 'readThreadTimelineSnapshot').mockImplementation(
      (workspaceId, threadId, read) =>
        actual(workspaceId, threadId, (snapshot) => {
          const result = read(instrument(snapshot));

          return result;
        })
    );
    const actualCooperative = f.store.readThreadTimelineSnapshotCooperative.bind(f.store);
    // The real generator is exhausted before the same end-of-read observations run.
    vi.spyOn(f.store, 'readThreadTimelineSnapshotCooperative').mockImplementation(
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

            return result;
          },
          signal
        )
    );
    const result = await f.read();
    expect(result.response.status).toBe(404);
    expect(bodyReads).toBeLessThanOrEqual(256);
    expect(readPendingRequest(f.workspaceDb.sqlite, f.requestId)).toMatchObject({
      state: 'pending',
    });
  }, 60_000);

  it('adds no anchor-proof receipt query or broad census beyond the identical original Item-anchor read', async () => {
    const f = await fixture();
    const expected = { turnId: f.turn.id, itemId: f.itemId, type: 'user-input-request' };
    expectOriginal(await f.read(), expected);
    const census = [
      'listThreadTurns',
      'listThreadItems',
      'listThreads',
      'listCommandRequests',
    ] as const;
    const censusSpies = census.map((name) => vi.spyOn(f.store, name));
    const receipts: Array<{
      channel: 'item' | 'request';
      sql: string;
      proof: boolean;
      digest: boolean;
    }> = [];
    let channel: 'item' | 'request' = 'item';
    let proofLookups = 0;
    const previousLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 60;
    const prepare = Database.prototype.prepare;
    // Observe both real SQL paths. No receipt owner, statement, result or canonical record is replaced.
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      const stack = new Error('receipt query channel').stack ?? '';
      const proof = stack.includes('at requestAnchor (');
      if (/\bfrom\s+pending_requests\b/i.test(sql) && proof) proofLookups++;
      if (/\bselect\b/i.test(sql) && /\bidempotency_requests\b/i.test(sql))
        receipts.push({
          channel,
          sql: sql.replace(/\s+/g, ' ').trim(),
          proof,
          digest:
            stack.includes('at readTimelineDigestSteps (') ||
            stack.includes('at readTimelineDigest ('),
        });
      return prepare.call(this, sql);
    });
    try {
      expectOriginal(await f.read({ anchor: { kind: 'item', itemId: f.itemId } }), expected);
      channel = 'request';
      expectOriginal(await f.read(), expected);
      // The positive lookup proves that the named proof channel is observed, not silently absent.
      expect(proofLookups).toBeGreaterThan(0);
      expect(receipts.filter((receipt) => receipt.proof)).toEqual([]);
      const baseline = receipts.filter((receipt) => receipt.channel === 'item');
      const added = receipts.filter((receipt) => receipt.channel === 'request');
      // Existing Digest -> pendingRequestRows retains receipt authority and is not globally bounded by this test or Item 9.
      expect(added.every((receipt) => receipt.digest)).toBe(true);
      for (const sql of new Set(added.map((receipt) => receipt.sql)))
        expect(added.filter((receipt) => receipt.sql === sql).length).toBeLessThanOrEqual(
          baseline.filter((receipt) => receipt.sql === sql).length
        );
      for (const spy of censusSpies) expect(spy).not.toHaveBeenCalled();
    } finally {
      Error.stackTraceLimit = previousLimit;
    }
  }, 30_000);
});
