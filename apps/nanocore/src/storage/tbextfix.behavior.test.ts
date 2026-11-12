import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ListHumanAttentionResponseSchema,
  ThreadTimelineResponseSchema,
} from '@openkit/app-api-schemas';
import { allocateEntityId, type Item } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArtifactReview } from '../artifact-reviews.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import {
  readThreadItemBody,
  readThreadTimeline,
  type ThreadTimelineReadInput,
} from '../thread-timeline.js';
import { readTimelinePlanSegments } from '../thread-timeline-attributes.js';
import { readTimelineDigest } from '../thread-timeline-digest.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './db.js';
import * as immutableBodies from './immutable-content.js';
import { nativeProductScope, withNativeThreadTimelineSnapshot } from './workspace-file-records.js';

const roots: string[] = [];
const coreHandles: CoreDb[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const core of coreHandles.splice(0)) if (core.sqlite.open) core.sqlite.close();
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

/** All state enters through real publishers; the App builder supplies actual local admission. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tbextfix-tests-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const thread = await store.createThread(
    DEMO_WORKSPACE_ID,
    'Independent timeline regression',
    undefined,
    'conversation',
    { visibility: 'workspace' }
  );
  const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Recorded work', actor);
  const app = createAppWithWorkspaceAuthority({ store, dataRoot: root });
  const coreDb = openCoreDb(root);
  coreHandles.push(coreDb);
  const selector = { workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id };
  const owner: ThreadTimelineReadInput = {
    store,
    coreDb,
    actor: { kind: 'local', userId: actor.id },
    administratorEligible: true,
    repositoryWorkspaceDb: (id) => openWorkspaceDb(root, id),
    input: selector,
  };
  const at = new Date().toISOString();
  const base = {
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    status: 'completed' as const,
    createdAt: at,
    completedAt: at,
  };
  async function operation(name: string, input: object) {
    const response = await app.request(`/api/app/operations/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body: unknown = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
  }
  function projection() {
    const response = readThreadTimeline(owner);
    const run = response.runs.find((row) => row.id === turn.id);
    if (!run?.planSegments) throw new Error('The admitted run has no plan-segment projection.');
    return { response, run, segments: run.planSegments };
  }
  const plan = (stepId = 'active', title = 'Active step') =>
    store.createItem({
      ...base,
      id: allocateEntityId('it'),
      type: 'plan',
      title: 'Plan',
      summary: null,
      steps: [{ id: stepId, title, status: 'in_progress' }],
    });
  const step = () =>
    store.createItem({
      ...base,
      id: allocateEntityId('it'),
      type: 'reasoning',
      summary: [],
      content: ['Recorded reasoning'],
    });
  return {
    root,
    store,
    thread,
    actor,
    turn,
    owner,
    selector,
    at,
    base,
    operation,
    projection,
    plan,
    step,
  };
}

describe('TBEXTFIX independent regressions', () => {
  // Owner: conversation_timeline / Digest and TB-EXT G8: admitted Reviews are needs-you sources.
  it('W1 counts an admitted pending Artifact Review and links to that exact attention row', async () => {
    const f = await fixture();
    const body = 'A retained output that needs review';
    const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    const requestId = randomUUID();
    const artifact = await f.store.createArtifact({
      id: allocateEntityId('ar'),
      ...f.selector,
      turnId: f.turn.id,
      kind: 'report',
      title: 'Review this output',
      summary: null,
      status: 'ready',
      version: 1,
      content: { format: 'markdown', body },
      contentDigest: digest,
      lastMutationRequestId: requestId,
      origin: { kind: 'turn-output', threadId: f.thread.id, turnId: f.turn.id, requestId },
      createdAt: f.at,
      updatedAt: f.at,
    });
    const db = openWorkspaceDb(f.root, DEMO_WORKSPACE_ID);
    let reviewId: string;
    try {
      reviewId = createArtifactReview(db, {
        artifactId: artifact.id,
        artifactVersion: 1,
        contentDigest: digest,
        sourceThreadId: f.thread.id,
        sourceTurnId: f.turn.id,
        sourceAgentId: f.turn.agentId ?? null,
        materialProposal: null,
        createdAt: f.at,
      }).reviewId;
    } finally {
      db.sqlite.close();
    }
    const attention = ListHumanAttentionResponseSchema.parse(
      await f.operation('attention.list', { workspaceId: DEMO_WORKSPACE_ID })
    );
    const row = attention.items.find(
      (candidate) =>
        candidate.source.type === 'artifact_review' && candidate.source.reviewId === reviewId
    );
    expect(row, 'The real attention owner must admit the Review before it can count').toBeDefined();
    if (!row) throw new Error('The Review fixture was not admitted.');
    const anchor = { kind: 'attention' as const, rowId: row.id };
    const response = readThreadTimeline(f.owner);
    expect(response.catchUpAnchor).toBeNull();
    expect(
      response.digest.lines,
      'Digest must include the admitted Review, not only its output'
    ).toContainEqual({ kind: 'needs-you', count: 1, anchor });
    const opened = ThreadTimelineResponseSchema.parse(
      await f.operation('thread.timeline', { ...f.selector, anchor })
    );
    expect(opened.anchor?.turnId).toBe(f.turn.id);
  });

  // Owner: TB-EXT G8 recorded problems; revisions cannot multiply one source identity.
  it('W2 counts a later error-level status revision once per Item, including later title edits', async () => {
    const f = await fixture();
    const status = await f.store.createItem({
      ...f.base,
      id: allocateEntityId('it'),
      type: 'status',
      level: 'info',
      title: 'Starting',
      summary: null,
    });
    const error = await f.store.updateItem(status.id, { level: 'error', title: 'Recorded error' });
    expect(error).toMatchObject({ type: 'status', level: 'error' });
    await f.store.updateItem(status.id, { title: 'More context for the same error' });
    await f.store.updateItem(status.id, { summary: 'Still the same recorded problem' });
    const initiallyError = await f.store.createItem({
      ...f.base,
      id: allocateEntityId('it'),
      type: 'status',
      level: 'error',
      title: 'Another error',
      summary: null,
    });
    await f.store.updateItem(initiallyError.id, { summary: 'Not a third problem' });
    const response = readThreadTimeline(f.owner);
    expect(response.digest.coverage).toBe('complete');
    expect(
      response.digest.lines.find((line) => line.kind === 'problems')?.count,
      'Two distinct error Items, not revisions, are problems'
    ).toBe(2);
  });

  // Owner: P10 and TB-EXT plan bounds. Return values alone cannot prove metadata traversal cost.
  it('W3 does not increase plan-read metadata evaluations when unrelated output revisions grow', async () => {
    const f = await fixture();
    await f.plan();
    const output = await f.step();
    const db = openWorkspaceDb(f.root, DEMO_WORKSPACE_ID);
    const builtin = new Database(':memory:');
    try {
      // A passive counter on this borrowed, query-only fixture connection. Every extraction
      // delegates to SQLite's unchanged builtin in an empty independent connection.
      // No production SELECT, index name, retained row, snapshot or result is replaced.
      db.sqlite.pragma('trusted_schema = ON');
      db.sqlite.pragma('query_only = ON');
      let evaluations = 0;
      const expressions = new Map<number, Database.Statement>();
      db.sqlite.function(
        'json_extract',
        { deterministic: true, varargs: true },
        (...values: unknown[]) => {
          evaluations++;
          let expression = expressions.get(values.length);
          if (!expression) {
            expression = builtin.prepare(
              `SELECT json_extract(${values.map(() => '?').join(',')}) AS value`
            );
            expressions.set(values.length, expression);
          }
          return (expression.get(...values) as { value: string | number | bigint | Buffer | null })
            .value;
        }
      );
      expect(
        db.sqlite.prepare('SELECT json_extract(?, ?) AS value').get('{"probe":7}', '$.probe')
      ).toEqual({ value: 7 });
      expect(evaluations, 'The passive metadata counter must be active').toBe(1);
      const scope = { ...nativeProductScope(f.root, f.turn.owner), sqlite: db.sqlite };
      function measure() {
        evaluations = 0;
        const result = withNativeThreadTimelineSnapshot(scope, f.thread.id, (snapshot) =>
          readTimelinePlanSegments(snapshot, f.turn.id, 1536)
        );
        return { result, evaluations };
      }
      const before = measure();
      expect(before.result.segments).toHaveLength(1);
      expect(before.result.segments[0]?.steps).toBe(1);
      for (let revision = 0; revision < 300; revision++)
        await f.store.updateItem(output.id, { content: [`Unrelated output revision ${revision}`] });
      const after = measure();
      expect(after.result).toEqual(before.result);
      expect(
        after.evaluations,
        'Unrelated revisions must not increase metadata examined for the same plan window'
      ).toBeLessThanOrEqual(before.evaluations);
    } finally {
      if (db.sqlite.open) db.sqlite.close();
      builtin.close();
    }
  }, 120_000);

  // Owner: TB-EXT G8's 65,536-byte historical body bound, including the catch-up boundary.
  it('W4 finds the actual viewer-action boundary without opening its oversized historical body', async () => {
    const f = await fixture();
    const boundary = await f.store.createItem({
      ...f.base,
      id: allocateEntityId('it'),
      type: 'user-message',
      actor: f.actor,
      text: 'x'.repeat(100_000),
    });
    // Default spy behavior calls the real verifier/reader. It observes work; it does not stub it.
    const opens = vi.spyOn(immutableBodies, 'readImmutableProductJson');
    const digest = f.store.readThreadTimelineSnapshot(
      DEMO_WORKSPACE_ID,
      f.thread.id,
      (snapshot) => {
        const b = snapshot.catchUp(f.actor.id, []);
        expect(b?.itemId, 'B must come from the actual authenticated viewer action').toBe(
          boundary.id
        );
        return readTimelineDigest(f.owner, snapshot, b);
      }
    );
    expect(digest.lines).toEqual([]);
    const oversizedOpens = opens.mock.calls
      .map(([, , content]) => content.byteLength)
      .filter((bytes) => bytes > 65_536);
    const beforeControl = opens.mock.calls.length;
    expect(readThreadItemBody(f.owner, f.turn.id, boundary.id).item).toMatchObject({
      id: boundary.id,
      type: 'user-message',
    });
    expect(
      opens.mock.calls.slice(beforeControl).some(([, , content]) => content.byteLength > 65_536),
      'A permitted exact-body read must validate the observation channel'
    ).toBe(true);
    expect(
      oversizedOpens,
      'Digest must not open a body over 65,536 bytes merely to obtain B'
    ).toEqual([]);
  });

  // Owner: TB-EXT plan coverage is partial for clipping, not merely equality with the limit.
  it('W5 reports complete coverage for exactly ten unclipped plan observations', async () => {
    const f = await fixture();
    const plan = await f.plan();
    for (let revision = 1; revision < 10; revision++)
      await f.store.updateItem(plan.id, { title: `Title-only revision ${revision}` });
    const { response, segments } = f.projection();
    expect(response.digest.coverage).toBe('complete');
    expect(segments.segments).toHaveLength(1);
    expect(segments.segments[0]).toMatchObject({ planItemId: plan.id, stepId: 'active', steps: 0 });
    expect(
      segments.coverage,
      'All ten observations fit; none of the plan history was clipped'
    ).toBe('complete');
  });

  // Owner: TB-EXT plan JSON allowance is 1,536 UTF-8 bytes for the object actually returned.
  it('W6 keeps the returned planSegments JSON within 1536 bytes including its actual coverage', async () => {
    const f = await fixture();
    let plan: Item | undefined;
    for (let interval = 0; interval < 8; interval++) {
      const stepId = `s${interval}`;
      const title = 'x'.repeat(interval === 0 ? 47 : 43);
      if (!plan) plan = await f.plan(stepId, title);
      else
        await f.store.updateItem(plan.id, {
          steps: [{ id: stepId, title, status: 'in_progress' }],
        });
      await f.step();
    }
    const { segments } = f.projection();
    expect(segments.segments.length).toBeGreaterThan(0);
    expect(
      Buffer.byteLength(JSON.stringify(segments), 'utf8'),
      'The serialized object, not a different coverage label, must fit'
    ).toBeLessThanOrEqual(1536);
  });
});
