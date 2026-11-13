// Storage-owner fixture; the public HTTP response is the deciding budget and behavior oracle.
import { mkdtempSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import * as activityProjection from '../thread-timeline-attributes.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { testBudgetLimit } from './budget-test-limit.js';
import { openWorkspaceDb } from './db.js';
import { appendWorkObservation } from './work-observations.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Keeps the fixture's current native ownership and capture authority; no SQL rows are seeded. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'timeline-activity-budget-'));
  const coreDb = createTestCoreDb(root);
  const userId = ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot: root });
  const db = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
  cleanups.push(() => disposeTestStore(root, db, coreDb));
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Loaded reported-activity budget');
  const turnIds: string[] = [];
  for (let run = 0; run < 31; run++) {
    const turn = await store.createTurn(
      DEMO_WORKSPACE_ID,
      thread.id,
      `Reported work ${run}`,
      { kind: 'user', id: userId },
      null,
      { captureCoverage: { scope: 'server', value: 'off' } }
    );
    turnIds.push(turn.id);
    // 128 admitted prefix records plus 12 unseen records: neither a short prefix nor full coverage.
    for (let index = 0; index < 140; index++) {
      const observationId = `budget-${run}-${index}`;
      await appendWorkObservation(db, {
        threadId: thread.id,
        turnId: turn.id,
        bodies: [],
        observation: {
          id: observationId,
          type: 'runtime.observed',
          ts: '2026-11-12T21:00:00.000Z',
          obs: 'worker-shim',
          payload: {
            observationId,
            sourceRef: 'p3-budget-private-source',
            sourceSequence: index,
            observedAt: '2026-11-12T21:00:00.000Z',
            fact: {
              kind: 'assistant',
              messageRef: `p3-budget-private-message-${index}`,
              runtimeOriginRef: null,
              phase: 'running',
            },
            content: { state: 'off' },
          },
        },
      });
    }
    await store.completeTurn(turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
  }
  // Construct App after native source publication: its admission hooks are not fixture Turn writers.
  const app = createAppWithWorkspaceAuthority({ store, coreDb, dataRoot: root });
  const input = JSON.stringify({
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: thread.id,
    anchor: { kind: 'latest' },
  });
  return { app, input, turnIds };
}

type Sample = { elapsedMs: number; load1: number; load5: number };

/** Nearest-rank percentiles match the existing native timeline budget oracle. */
function summary(samples: Sample[]) {
  const ordered = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
  return {
    p50: ordered[Math.ceil(ordered.length * 0.5) - 1]!,
    p95: ordered[Math.ceil(ordered.length * 0.95) - 1]!,
    samples,
  };
}

it('keeps the default 31-run window with loaded worker reports within 150 ms p95 and 256 KiB', async () => {
  const f = await fixture();
  // Let fixture-write and prior-job load decay before the public-read measurements.
  // This bounded wait never skips, discards a measured sample, or changes the 150 ms oracle.
  const settleDeadline = performance.now() + 90_000;
  let settleLoad = loadavg();
  while ((settleLoad[0]! >= 8 || settleLoad[1]! >= 8) && performance.now() < settleDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    settleLoad = loadavg();
  }
  const samples: Record<'on' | 'off', Sample[]> = { on: [], off: [] };
  const loadAtStart = loadavg();
  let maxBytes = 0;
  for (let round = 0; round < 35; round++) {
    const modes = round % 2 ? (['on', 'off'] as const) : (['off', 'on'] as const);
    for (const mode of modes) {
      // Diagnostic ablation only. Every deciding 'on' read uses the real projection and native owner.
      // Null contributes no source work; no canned positive activity is ever supplied.
      const ablation =
        mode === 'off'
          ? vi.spyOn(activityProjection, 'readTimelineReportedActivity').mockReturnValue(null)
          : null;
      let response: Response;
      let text: string;
      let elapsedMs: number;
      try {
        const start = performance.now();
        response = await f.app.request('/api/app/operations/thread.timeline', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: f.input,
        });
        text = await response.text();
        elapsedMs = performance.now() - start;
      } finally {
        ablation?.mockRestore();
      }
      // Load and client-side oracle work are outside the measured HTTP window.
      const [load1, load5] = loadavg();
      if (round >= 5) samples[mode].push({ elapsedMs, load1: load1!, load5: load5! });
      expect(response.status, text).toBe(200);
      maxBytes = Math.max(maxBytes, Buffer.byteLength(text));
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(262_144);
      const body = JSON.parse(text);
      expect(body.runs.map((run: { id: string }) => run.id)).toEqual(f.turnIds);
      expect(text).not.toContain('p3-budget-private-source');
      expect(text).not.toContain('p3-budget-private-message');
      for (const run of body.runs) {
        // A reported 'running' phase must not override the authoritative completed Turn.
        expect(run.status).toBe('completed');
        if (mode === 'off') {
          expect(run.reportedActivity).toBeNull();
          continue;
        }
        const activity = run.reportedActivity;
        expect(activity).toMatchObject({
          reportedBy: 'worker',
          contentCapture: 'off',
          coverage: 'partial',
        });
        expect(activity.entries.length).toBeGreaterThan(0);
        expect(activity.entries.length).toBeLessThanOrEqual(50);
        // Whole-entry response clipping may shorten the last-50 window, but not substitute unseen tail.
        expect(activity.entries.map((entry: { sequence: number }) => entry.sequence)).toEqual(
          Array.from(
            { length: activity.entries.length },
            (_, index) => 128 - activity.entries.length + index + 1
          )
        );
        expect(activity.omittedEntryCount).toBe(128 - activity.entries.length);
        for (const entry of activity.entries) {
          expect(entry).toEqual({
            sequence: entry.sequence,
            observedAt: '2026-11-12T21:00:00.000Z',
            kind: 'progress',
            label: 'Worker',
          });
        }
      }
    }
  }
  expect(samples.on).toHaveLength(30);
  expect(samples.off).toHaveLength(30);
  const on = summary(samples.on);
  const off = summary(samples.off);
  console.info(
    'P3 loaded-observation budget',
    JSON.stringify({
      runs: 31,
      observationsPerRun: 140,
      admittedPrefixPerRun: 128,
      warmupsPerMode: 5,
      maxBytes,
      loadAtStart,
      loadAtEnd: loadavg(),
      on,
      off,
      deltaP95: on.p95 - off.p95,
    })
  );
  // Keep the 150 ms product budget; the shared helper selects and logs the asserted mode.
  expect(on.p95).toBeLessThanOrEqual(testBudgetLimit(on.p95, 150));
}, 240_000);
