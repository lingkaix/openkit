import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openWorkspaceDb } from './db.js';
import { appendWorkObservation } from './work-observations.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('rechecks native payload, observer, sequence and parent authority on every reported-activity read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timeline-activity-validation-'));
  const coreDb = createTestCoreDb(root);
  const userId = ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot: root });
  const db = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
  cleanups.push(() => disposeTestStore(root, db, coreDb));
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Native activity validation');
  const turn = await store.createTurn(
    DEMO_WORKSPACE_ID,
    thread.id,
    'Report work',
    { kind: 'user', id: userId },
    null,
    { captureCoverage: { scope: 'server', value: 'off' } }
  );
  await appendWorkObservation(db, {
    threadId: thread.id,
    turnId: turn.id,
    bodies: [],
    observation: {
      id: 'validation-report',
      type: 'runtime.observed',
      ts: '2026-11-12T21:00:00.000Z',
      obs: 'worker-shim',
      payload: {
        observationId: 'validation-report',
        sourceRef: 'private-source',
        sourceSequence: 0,
        observedAt: '2026-11-12T21:00:00.000Z',
        fact: {
          kind: 'assistant',
          messageRef: 'private-message',
          runtimeOriginRef: null,
          phase: 'running',
        },
        content: { state: 'off' },
      },
    },
  });
  const app = createAppWithWorkspaceAuthority({ store, coreDb, dataRoot: root });
  async function read() {
    const response = await app.request('/api/app/operations/thread.timeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    return body.runs[0].reportedActivity;
  }
  const row = db.sqlite
    .prepare('SELECT record_json FROM control_work_observations WHERE turn_id=? AND sequence=1')
    .get(turn.id) as { record_json: string };
  const replace = db.sqlite.prepare(
    'UPDATE control_work_observations SET record_json=? WHERE turn_id=? AND sequence=1'
  );
  // Fault injection follows real native publication; no malformed state is used as a positive fixture.
  const original = JSON.parse(row.record_json);
  const faults = [
    {
      ...original,
      payload: { ...original.payload, fact: { ...original.payload.fact, phase: 'not-a-phase' } },
    },
    { ...original, obs: 'nanocore' },
    { ...original, seq: 999 },
    { ...original, parent: 'absent-parent' },
  ];
  for (const fault of faults) {
    expect(await read()).toMatchObject({
      reportedBy: 'worker',
      coverage: 'partial',
      entries: [{ kind: 'progress' }],
    });
    replace.run(JSON.stringify(fault), turn.id);
    expect(await read()).toBeNull();
    replace.run(row.record_json, turn.id);
  }
  expect(await read()).toMatchObject({
    reportedBy: 'worker',
    coverage: 'partial',
    entries: [{ kind: 'progress' }],
  });
});
