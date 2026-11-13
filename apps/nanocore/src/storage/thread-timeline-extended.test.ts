import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadTimelineAnchorSchema } from '@openkit/app-api-schemas';
import * as policyKernel from '@openkit/policy-kernel';
import { allocateEntityId, type Item } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { raiseRecordedPendingRequest } from '../runtime/pending-request-flow.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { openWorkspaceDb } from './db.js';

const roots: string[] = [];
const time = '2026-11-08T17:00:00.000Z';
const otherActor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000777' };
type Anchor = ReturnType<typeof ThreadTimelineAnchorSchema.parse>;
type Digest = {
  lines: Array<{
    kind:
      | 'needs-you'
      | 'runs-finished'
      | 'outputs'
      | 'plan-steps-finished'
      | 'problems'
      | 'decisions-by-others'
      | 'new-messages';
    count: number;
    anchor: Anchor;
  }>;
  coverage: 'complete' | 'partial';
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

/** Uses the real App operation and native Store; no retained state is fabricated with SQL. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'timeline-extended-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const thread = await store.createThread(
    DEMO_WORKSPACE_ID,
    'Catch-up digest',
    undefined,
    'conversation',
    { visibility: 'workspace' }
  );
  const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Fixture input', actor, null, {
    agentId: 'agent_demo',
  });
  const app = createAppWithWorkspaceAuthority({
    store,
    dataRoot: root,
    agentManifests: [createTestAgentSetup({ agentId: 'agent_demo' }).manifest],
  });
  const selector = { workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id };
  const base = {
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    status: 'completed' as const,
    createdAt: time,
    completedAt: time,
  };
  async function operation(name: string, input: Record<string, unknown> = {}) {
    const response = await app.request(`/api/app/operations/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...selector, ...input }),
    });
    const text = await response.text();
    expect(response.status, `${name}: ${text}`).toBe(200);
    return JSON.parse(text);
  }
  const read = (input: Record<string, unknown> = {}) => operation('thread.timeline', input);
  const message = (text: string) =>
    store.createItem({ ...base, id: allocateEntityId('it'), type: 'assistant-message', text });
  const mark = (item: Item) => operation('thread.mark-read', { itemIds: [item.id] });
  async function artifact() {
    const body = 'Retained output body';
    const requestId = randomUUID();
    const output = await store.createArtifact({
      id: allocateEntityId('ar'),
      ...selector,
      turnId: turn.id,
      kind: 'summary',
      title: 'Retained output',
      status: 'ready',
      summary: body,
      version: 1,
      content: { format: 'markdown', body },
      contentDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      lastMutationRequestId: requestId,
      origin: { kind: 'turn-output', threadId: thread.id, turnId: turn.id, requestId },
      createdAt: time,
      updatedAt: time,
    });
    // The Artifact owner publishes its reference. Select that exact lineage instead of adding a duplicate.
    const references = store
      .listThreadItems(DEMO_WORKSPACE_ID, thread.id)
      .filter(
        (item) =>
          item.type === 'artifact-reference' &&
          item.artifactId === output.id &&
          item.artifactVersion === output.version
      );
    expect(references).toHaveLength(1);
    return { output, reference: references[0]! };
  }
  const decision = () =>
    store.createItem({
      ...base,
      id: allocateEntityId('it'),
      type: 'approval-decision',
      actor: otherActor,
      causationId: `fixture-decision:${randomUUID()}`,
      approvalRequestId: randomUUID(),
      decision: 'denied',
      decidedAt: time,
    });
  return {
    root,
    store,
    thread,
    turn,
    actor,
    selector,
    base,
    read,
    message,
    mark,
    artifact,
    decision,
    operation,
  };
}

/** Checks the release read field without deriving expected counts from production helpers. */
function digest(body: { digest?: Digest }): Digest {
  expect(body.digest, 'New Since You Were Here requires the server digest').toBeDefined();
  const value = body.digest!;
  expect(['complete', 'partial']).toContain(value.coverage);
  expect(value.lines.length).toBeLessThanOrEqual(7);
  expect(new Set(value.lines.map((line) => line.kind)).size).toBe(value.lines.length);
  for (const line of value.lines) {
    expect(Number.isInteger(line.count) && line.count > 0).toBe(true);
    expect(ThreadTimelineAnchorSchema.safeParse(line.anchor).success).toBe(true);
  }
  return value;
}

/** Ignores line order: the owner fixes count semantics, but not category ordering. */
function counts(value: Digest) {
  return Object.fromEntries(value.lines.map((line) => [line.kind, line.count]));
}

/** A summary must resolve to its actual source, not a generic latest/catch-up position. */
async function expectSource(
  f: Awaited<ReturnType<typeof fixture>>,
  anchor: Anchor,
  turnId: string,
  itemIds: string[]
) {
  expect(['turn', 'item', 'attention']).toContain(anchor.kind);
  const resolved = await f.read({ anchor });
  expect(resolved.anchor.turnId).toBe(turnId);
  if (anchor.kind === 'item' || anchor.kind === 'attention')
    expect(itemIds, JSON.stringify({ anchor, resolved: resolved.anchor })).toContain(
      resolved.anchor.itemId
    );
}

describe('Thread timeline Extended catch-up digest', () => {
  // Owner: Conversation Timeline, New Since You Were Here / Digest; TB-EXT bounded read contract.
  it('omits zero-count lines and starts at the beginning when there is no B', async () => {
    const f = await fixture();
    const empty = await f.read();
    expect(empty.catchUpAnchor).toBeNull();
    expect(digest(empty)).toEqual({ lines: [], coverage: 'complete' });
    const note = await f.message('First retained message');
    const result = await f.read();
    expect(result.catchUpAnchor).toBeNull();
    expect(counts(digest(result))).toEqual({ 'new-messages': 1 });
    expect(result.digest.coverage).toBe('complete');
    await expectSource(f, result.digest.lines[0].anchor, f.turn.id, [note.id]);
  });

  it('returns deterministic nonzero counts and source links, independent of the selected display anchor', async () => {
    const f = await fixture();
    const first = await f.message('First new note');
    const second = await f.message('Second new note');
    const { reference } = await f.artifact();
    const decision = await f.decision();
    const plan = await f.store.createItem({
      ...f.base,
      id: allocateEntityId('it'),
      type: 'plan',
      title: 'Current plan',
      summary: null,
      steps: [
        { id: 'done', title: 'Done', status: 'completed' },
        { id: 'next', title: 'Next', status: 'pending' },
      ],
    });
    const problem = await f.store.createItem({
      ...f.base,
      id: allocateEntityId('it'),
      type: 'command-execution',
      status: 'failed',
      command: 'fixture failure',
      cwd: '.',
      output: 'Fixture error',
      exitCode: 1,
      durationMs: 1,
    });
    await f.store.completeTurn(f.turn.id, { status: 'completed', completedAt: time });
    const firstRead = digest(await f.read());
    expect(firstRead.coverage).toBe('complete');
    expect(counts(firstRead)).toEqual({
      'runs-finished': 1,
      outputs: 1,
      'plan-steps-finished': 1,
      problems: 1,
      'decisions-by-others': 1,
      'new-messages': 2,
    });
    expect(digest(await f.read({ anchor: { kind: 'item', itemId: second.id } }))).toEqual(
      firstRead
    );
    const sources: Record<string, string[]> = {
      'runs-finished': [],
      outputs: [reference.id],
      'plan-steps-finished': [plan.id],
      problems: [problem.id],
      'decisions-by-others': [decision.id],
      'new-messages': [first.id, second.id],
    };
    for (const line of firstRead.lines)
      await expectSource(f, line.anchor, f.turn.id, sources[line.kind]!);
  });

  it('counts retained plan transitions after a mid-run B, not current plan totals or repeated title revisions', async () => {
    const f = await fixture();
    const earlierUnread = await f.message('Earlier unread message');
    const steps = [
      { id: 'already-done', title: 'Finished before B', status: 'completed' as const },
      { id: 'newly-done', title: 'Finish after B', status: 'pending' as const },
      { id: 'not-done', title: 'Still pending', status: 'pending' as const },
    ];
    const plan = await f.store.createItem({
      ...f.base,
      id: allocateEntityId('it'),
      type: 'plan',
      title: 'Plan before B',
      summary: null,
      steps,
    });
    const boundary = await f.message('Actually displayed boundary');
    await f.mark(boundary);
    await f.store.updateItem(plan.id, { title: 'Title only after B' });
    const completedSteps = steps.map((step) =>
      step.id === 'newly-done' ? { ...step, status: 'completed' as const } : step
    );
    await f.store.updateItem(plan.id, { steps: completedSteps });
    await f.store.updateItem(plan.id, { title: 'Same two completed steps, another title' });
    const note = await f.message('New progress after B');
    const result = await f.read();
    expect(result.catchUpAnchor).toEqual({ turnId: f.turn.id, itemId: boundary.id });
    expect(counts(digest(result))).toEqual({ 'plan-steps-finished': 1, 'new-messages': 1 });
    expect(result.digest.coverage).toBe('complete');
    for (const line of result.digest.lines)
      await expectSource(
        f,
        line.anchor,
        f.turn.id,
        line.kind === 'plan-steps-finished' ? [plan.id] : [note.id]
      );
    const readState = await f.operation('thread.read-state', {
      itemIds: [earlierUnread.id, boundary.id, note.id],
    });
    expect(readState.readItemIds).toEqual([boundary.id]);
    expect(readState.unreadItemIds).toHaveLength(2);
  });

  it('uses the viewer newer action as B while leaving earlier unread membership unchanged', async () => {
    const f = await fixture();
    const displayed = await f.message('Displayed before my action');
    await f.mark(displayed);
    const earlierUnread = await f.message('Unread before my action');
    const action = await f.store.createItem({
      ...f.base,
      id: allocateEntityId('it'),
      type: 'user-message',
      actor: f.actor,
      text: 'My action',
    });
    const incoming = await f.message('Only this message is new since B');
    const result = await f.read({ anchor: { kind: 'catch-up' } });
    expect(result.catchUpAnchor).toEqual({ turnId: f.turn.id, itemId: action.id });
    expect(counts(digest(result))).toEqual({ 'new-messages': 1 });
    await expectSource(f, result.digest.lines[0].anchor, f.turn.id, [incoming.id]);
    const readState = await f.operation('thread.read-state', {
      itemIds: [displayed.id, earlierUnread.id, incoming.id],
    });
    expect(readState.readItemIds).toEqual([displayed.id]);
    expect(readState.unreadItemIds).toEqual([earlierUnread.id, incoming.id]);
  });

  it('counts needs-you from the pending owner, never from an unbacked communication Item', async () => {
    const f = await fixture();
    await f.store.createItem({
      ...f.base,
      id: allocateEntityId('it'),
      type: 'approval-request',
      approvalRequestId: randomUUID(),
      kind: 'permission',
      title: 'Unbacked communication',
      description: 'No native Pending Request backs this Item.',
    });
    const requestId = randomUUID();
    const itemId = allocateEntityId('it');
    const db = openWorkspaceDb(f.root, DEMO_WORKSPACE_ID);
    try {
      await raiseRecordedPendingRequest(f.store, db.sqlite, {
        requestId,
        ...f.selector,
        raisingTurnId: f.turn.id,
        requestItemId: itemId,
        kind: 'approval',
        requesterKind: 'worker',
        agentId: 'agent_demo',
        responsibleUserId: FIXTURE_LOCAL_USER_ID,
        approval: {
          kind: 'permission',
          title: 'Choose whether to continue',
          description: 'Exact effect stays at its owner.',
        },
        now: time,
      });
    } finally {
      db.sqlite.close();
    }
    const result = digest(await f.read());
    expect(counts(result)).toEqual({ 'needs-you': 1 });
    await expectSource(f, result.lines[0]!.anchor, f.turn.id, [itemId]);
    const actual = policyKernel.evaluateAccess;
    vi.spyOn(policyKernel, 'evaluateAccess').mockImplementation((policy, request) =>
      actual(
        {
          ...policy,
          associations: policy.associations.map((association) => ({
            ...association,
            accessRights: association.accessRights.filter(
              (right) => right !== 'ar:approval-respond'
            ),
          })),
        },
        request
      )
    );
    const denied = digest(await f.read());
    expect(counts(denied)).toEqual({});
    expect(JSON.stringify(denied)).not.toContain(requestId);
    expect(JSON.stringify(denied)).not.toContain(itemId);
  });

  it('omits separately denied Artifact and Audit sources without leaking their counts or links', async () => {
    const f = await fixture();
    await f.message('Still admitted Thread message');
    const { output, reference } = await f.artifact();
    const decision = await f.decision();
    const admitted = digest(await f.read());
    expect(counts(admitted)).toEqual({ outputs: 1, 'decisions-by-others': 1, 'new-messages': 1 });
    const actual = policyKernel.evaluateAccess;
    vi.spyOn(policyKernel, 'evaluateAccess').mockImplementation((policy, request) =>
      actual(
        {
          ...policy,
          associations: policy.associations.map((association) => ({
            ...association,
            accessRights: association.accessRights.filter(
              (right) => right !== 'ar:artifact-read' && right !== 'ar:audit-read'
            ),
          })),
        },
        request
      )
    );
    const artifactRead = vi.spyOn(f.store, 'getArtifact');
    const denied = digest(await f.read());
    expect(counts(denied)).toEqual({ 'new-messages': 1 });
    expect(artifactRead).not.toHaveBeenCalled();
    for (const id of [output.id, reference.id, decision.id])
      expect(JSON.stringify(denied)).not.toContain(id);
  });

  it('distinguishes exactly 31 runs from an overflowing new-history window', async () => {
    const f = await fixture();
    await f.message('First run note');
    await f.store.completeTurn(f.turn.id, { status: 'completed', completedAt: time });
    for (let index = 1; index < 35; index++) {
      if (index === 31) {
        const exact = digest(await f.read());
        expect(exact.coverage).toBe('complete');
        expect(counts(exact)).toEqual({ 'runs-finished': 31, 'new-messages': 31 });
      }
      const turn = await f.store.createTurn(
        DEMO_WORKSPACE_ID,
        f.thread.id,
        `New run ${index}`,
        f.actor
      );
      await f.store.createItem({
        ...f.base,
        turnId: turn.id,
        id: allocateEntityId('it'),
        type: 'assistant-message',
        text: `New run note ${index}`,
      });
      await f.store.completeTurn(turn.id, { status: 'completed', completedAt: time });
    }
    const result = digest(await f.read());
    expect(result.coverage).toBe('partial');
    expect(counts(result)).toEqual({ 'runs-finished': 31, 'new-messages': 31 });
  }, 120_000);

  it('bounds new Item reads after B and refuses whole-history Store censuses', async () => {
    const f = await fixture();
    const old = new Set<string>();
    for (let index = 0; index < 270; index++) old.add((await f.message(`Old unseen ${index}`)).id);
    const boundary = await f.message('B inside this run');
    await f.mark(boundary);
    for (let index = 0; index < 300; index++) await f.message(`New note ${index}`);
    for (const name of [
      'listThreadTurns',
      'listThreadItems',
      'listThreads',
      'listArtifacts',
      'listCommandRequests',
    ] as const) {
      vi.spyOn(f.store, name).mockImplementation(() => {
        throw new Error(`Digest must not census ${name}`);
      });
    }
    const itemReads: string[] = [];
    const historicalItems: string[] = [];
    const revisionPages: number[] = [];
    let predecessorReads = 0;
    const actual = f.store.readThreadTimelineSnapshot.bind(f.store);
    vi.spyOn(f.store, 'readThreadTimelineSnapshot').mockImplementation(
      (workspaceId, threadId, read) =>
        actual(workspaceId, threadId, (snapshot) =>
          read(
            new Proxy(snapshot, {
              get(target, key, receiver) {
                if (key === 'item')
                  return (itemId: string) => {
                    itemReads.push(itemId);
                    return target.item(itemId);
                  };
                if (key === 'revisions')
                  return (turnId: string, after: number, limit: number) => {
                    expect(turnId).toBe(f.turn.id);
                    expect(after).toBeGreaterThanOrEqual(271);
                    expect(limit).toBeLessThanOrEqual(64);
                    const page = target.revisions(turnId, after, limit);
                    revisionPages.push(page.length);
                    for (const entry of page) if (entry.item) historicalItems.push(entry.item.id);
                    return page;
                  };
                if (key === 'revision')
                  return (turnId: string, itemId: string, revision: number) => {
                    predecessorReads++;
                    return target.revision(turnId, itemId, revision);
                  };
                return Reflect.get(target, key, receiver);
              },
            })
          )
        )
    );
    const result = digest(await f.read());
    expect(result.coverage).toBe('partial');
    expect(counts(result)).toEqual({ 'new-messages': 256 });
    expect(revisionPages.reduce((total, size) => total + size, 0)).toBe(256);
    expect(predecessorReads).toBe(0);
    expect(historicalItems.some((id) => old.has(id))).toBe(false);
    expect(itemReads.some((id) => old.has(id))).toBe(false);
    // Allow the independent 24-Item narrative, 256 digest revisions, and one exact B lookup.
    expect(new Set([...itemReads, ...historicalItems]).size).toBeLessThanOrEqual(281);
  }, 180_000);

  it('shares the 256-revision budget across runs and distinguishes an exact full window from overflow', async () => {
    const f = await fixture();
    for (let index = 0; index < 128; index++) await f.message(`First run ${index}`);
    await f.store.completeTurn(f.turn.id, { status: 'completed', completedAt: time });
    const next = await f.store.createTurn(DEMO_WORKSPACE_ID, f.thread.id, 'Second run', f.actor);
    const append = (index: number) =>
      f.store.createItem({
        ...f.base,
        turnId: next.id,
        id: allocateEntityId('it'),
        type: 'assistant-message',
        text: `Second run ${index}`,
      });
    for (let index = 0; index < 128; index++) await append(index);
    let selectedRevisions = 0;
    const actual = f.store.readThreadTimelineSnapshot.bind(f.store);
    vi.spyOn(f.store, 'readThreadTimelineSnapshot').mockImplementation(
      (workspaceId, threadId, read) =>
        actual(workspaceId, threadId, (snapshot) =>
          read(
            new Proxy(snapshot, {
              get(target, key, receiver) {
                if (key === 'revisions')
                  return (turnId: string, after: number, limit: number) => {
                    const page = target.revisions(turnId, after, limit);
                    selectedRevisions += page.length;
                    return page;
                  };
                return Reflect.get(target, key, receiver);
              },
            })
          )
        )
    );
    const exact = digest(await f.read());
    expect(exact.coverage).toBe('complete');
    expect(counts(exact)).toEqual({ 'runs-finished': 1, 'new-messages': 256 });
    expect(selectedRevisions).toBe(256);
    for (let index = 128; index < 172; index++) await append(index);
    selectedRevisions = 0;
    const overflowing = digest(await f.read());
    expect(overflowing.coverage).toBe('partial');
    expect(counts(overflowing)).toEqual({ 'runs-finished': 1, 'new-messages': 256 });
    expect(selectedRevisions).toBe(256);
  }, 120_000);

  it('marks an oversized retained digest body partial without manufacturing its count', async () => {
    const f = await fixture();
    const note = await f.message(`Oversized new note ${'x'.repeat(65_536)}`);
    const result = digest(await f.read());
    expect(result).toEqual({ lines: [], coverage: 'partial' });
    expect(JSON.stringify(result)).not.toContain(note.id);
  });

  it('applies the 256 bound to retained revisions, not only distinct Item identities', async () => {
    const f = await fixture();
    const plan = await f.store.createItem({
      ...f.base,
      id: allocateEntityId('it'),
      type: 'plan',
      title: 'Unfinished plan',
      summary: null,
      steps: [{ id: 'pending', title: 'Still pending', status: 'pending' }],
    });
    const boundary = await f.message('B before plan revisions');
    await f.mark(boundary);
    for (let index = 0; index < 270; index++)
      await f.store.updateItem(plan.id, { title: `Still unfinished revision ${index}` });
    const result = digest(await f.read());
    expect(result.coverage).toBe('partial');
    expect(result.lines).toEqual([]);
  }, 180_000);
});
