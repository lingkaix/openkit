import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as authority from '../auth/operation-authorizer.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openWorkspaceDb } from './db.js';
import * as observations from './work-observations.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The original observation publisher owns all facts; the public timeline is the consumer. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'timeline-activity-'));
  const coreDb = createTestCoreDb(root);
  const userId = ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot: root });
  const db = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
  cleanups.push(() => disposeTestStore(root, db, coreDb));
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Reported activity');
  const turn = await store.createTurn(
    DEMO_WORKSPACE_ID,
    thread.id,
    'Report work',
    { kind: 'user', id: userId },
    null,
    { captureCoverage: { scope: 'server', value: 'off' } }
  );
  const app = createAppWithWorkspaceAuthority({ store, coreDb, dataRoot: root });
  const owner = { threadId: thread.id, turnId: turn.id };
  async function publish(index: number, fact: Record<string, unknown>, selected = owner) {
    return observations.appendWorkObservation(db, {
      ...selected,
      bodies: [],
      observation: {
        id: `reported-${index}`,
        type: 'runtime.observed',
        ts: '2026-11-12T21:00:00.000Z',
        obs: 'worker-shim',
        payload: {
          observationId: `reported-${index}`,
          sourceRef: 'native-source-private',
          sourceSequence: index,
          observedAt: '2026-11-12T21:00:00.000Z',
          fact: {
            ...(fact.kind === 'assistant' ? { messageRef: `native-message-${index}` } : {}),
            ...fact,
          },
          content: { state: 'off' },
        },
      },
    });
  }
  async function read(input = {}) {
    const response = await app.request('/api/app/operations/thread.timeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: thread.id,
        anchor: { kind: 'turn', turnId: turn.id },
        ...input,
      }),
    });
    return { response, body: await response.json() };
  }
  return { root, coreDb, store, db, thread, turn, owner, publish, read };
}

it('TW2 returns exact-run structural activity as worker reports, never raw runtime identity or liveness', async () => {
  const f = await fixture();
  await f.publish(0, {
    kind: 'origin',
    runtimeOriginRef: 'native-child-private',
    parentRuntimeOriginRef: 'native-parent-private',
    phase: 'started',
  });
  await f.publish(1, {
    kind: 'assistant',
    runtimeOriginRef: 'native-child-private',
    phase: 'running',
  });
  await f.publish(2, {
    kind: 'assistant',
    runtimeOriginRef: 'native-child-private',
    phase: 'completed',
  });
  await f.publish(3, { kind: 'assistant', runtimeOriginRef: null, phase: 'failed' });
  const other = await f.store.createThread(DEMO_WORKSPACE_ID, 'Unrelated');
  const otherTurn = await f.store.createTurn(
    DEMO_WORKSPACE_ID,
    other.id,
    'Other work',
    { kind: 'user', id: f.turn.triggerActor.id },
    null,
    { captureCoverage: { scope: 'server', value: 'off' } }
  );
  await f.publish(
    100,
    { kind: 'assistant', runtimeOriginRef: null, phase: 'completed' },
    { threadId: other.id, turnId: otherTurn.id }
  );
  const broad = vi.spyOn(observations, 'readThreadRuntimeActivity').mockImplementation(() => {
    throw new Error('No whole-history projection');
  });
  const { response, body } = await f.read();
  expect(response.status).toBe(200);
  const run = body.runs.find((row: { id: string }) => row.id === f.turn.id);
  expect(run.reportedActivity).toMatchObject({
    reportedBy: 'worker',
    contentCapture: 'off',
    coverage: 'partial',
  });
  expect(run.reportedActivity.entries.map((entry: { kind: string }) => entry.kind)).toEqual([
    'child-started',
    'progress',
    'result',
    'failure',
  ]);
  expect(run.reportedActivity.entries[0].label).toBe('Child 1');
  expect(run.reportedActivity.entries[1].label).toBe('Child 1');
  expect(run.reportedActivity.entries.map((entry: { sequence: number }) => entry.sequence)).toEqual(
    [1, 2, 3, 4]
  );
  expect(run.status).toBe('running');
  expect(JSON.stringify(body)).not.toContain('native-child-private');
  expect(JSON.stringify(body)).not.toContain('native-source-private');
  expect(broad).not.toHaveBeenCalled();
});

it('bounds native activity reads to one 128-observation prefix and at most 50 outward entries', async () => {
  const f = await fixture();
  for (let index = 0; index < 140; index++)
    await f.publish(index, { kind: 'assistant', runtimeOriginRef: null, phase: 'running' });
  const read = vi.spyOn(observations, 'readControlWorkObservations');
  const { body } = await f.read({ limit: 1 });
  const activity = body.runs[0].reportedActivity;
  expect(activity.entries).toHaveLength(50);
  expect(activity.entries.every((entry: { sequence: number }) => entry.sequence <= 128)).toBe(true);
  expect(activity.coverage).toBe('partial');
  expect(activity.omittedEntryCount).toBe(78);
  expect(read).toHaveBeenCalled();
  expect(
    read.mock.calls.every(([, , input]) => input.turnId === f.turn.id && input.limit === 128)
  ).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(262144);
});

it('requires independent Audit admission before observation access', async () => {
  const f = await fixture();
  await f.publish(0, { kind: 'assistant', runtimeOriginRef: null, phase: 'completed' });
  const original = authority.isWorkspaceOperationAuthorized;
  vi.spyOn(authority, 'isWorkspaceOperationAuthorized').mockImplementation((...args) =>
    args[3].policyOperation === 'audit.read' ? false : original(...args)
  );
  const read = vi.spyOn(observations, 'readControlWorkObservations');
  const { response, body } = await f.read();
  expect(response.status).toBe(200);
  expect(body.runs[0].reportedActivity).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

it('keeps absent activity unavailable and foreign run selection opaque', async () => {
  const f = await fixture();
  const { body } = await f.read();
  expect(body.runs[0].reportedActivity).toMatchObject({ coverage: 'unavailable', entries: [] });
  const other = await f.store.createThread(DEMO_WORKSPACE_ID, 'Other');
  const result = await f.read({ threadId: other.id });
  expect(result.response.status).toBe(404);
  expect(JSON.stringify(result.body)).not.toContain('reportedActivity');
});
