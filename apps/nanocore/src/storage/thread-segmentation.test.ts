import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished } from 'vitest';
import { findAssistantTimeline } from '../internal-agents/assistant-timeline.js';
import { FsStore } from '../lib/store.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { StoredThreadSnapshotV1Schema } from './retained-work-events-v1.js';
import { appendWorkObservation } from './work-observations.js';

const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
async function fixture(maxBytes = 100_000_000, maxObservationLines = 1) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'thread-segmentation-'));
  const core = openCoreDb(dataRoot);
  applyMigrations(core);
  core.sqlite.close();
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Continuous output');
  const thread = await store.createThread(workspace.id, 'Assistant', undefined, 'conversation', {
    visibility: 'private',
    privateOwnerUserId: actor.id,
    segment: 0,
    segmentation: { maxObservationLines, maxBytes, boundaryDelayed: true },
  });
  const db = openWorkspaceDb(dataRoot, workspace.id);
  onTestFinished(async () => {
    db.sqlite.close();
    await shutdownControlStoreWorkerClient();
    closeWorkspaceProductReadHandles(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return { dataRoot, store, workspace, thread, db };
}

it('delays segmentation until a Turn boundary and reuses the exact retained successor after restart (#732)', async () => {
  const f = await fixture();
  const turn = await f.store.createTurn(f.workspace.id, f.thread.id, 'Long response', actor);
  for (let index = 0; index < 2; index++)
    await appendWorkObservation(f.db, {
      threadId: f.thread.id,
      turnId: turn.id,
      observation: {
        id: `configured-${index}`,
        ts: new Date().toISOString(),
        type: 'config.model',
        obs: 'llm-gateway',
        ret: 'turn-evidence',
        payload: { attempt: index, providerRef: 'p', model: 'm', sampling: {} },
      },
      bodies: [],
    });
  expect((await f.store.continueThreadSegment(f.workspace.id, f.thread.id)).id).toBe(f.thread.id);
  expect(f.store.listThreads(f.workspace.id)).toHaveLength(1);
  await f.store.completeTurn(turn.id, {
    status: 'completed',
    completedAt: new Date().toISOString(),
  });
  const next = await f.store.continueThreadSegment(f.workspace.id, f.thread.id);
  expect(next).toMatchObject({
    parentThreadId: f.thread.id,
    segment: 1,
    segmentation: f.thread.segmentation,
    visibility: 'private',
    privateOwnerUserId: actor.id,
    threadSource: 'conversation',
  });
  // This reader's source is unchanged from the rc.9 reservation at f1041512f.
  expect(StoredThreadSnapshotV1Schema.parse(next)).toEqual(next);
  expect(f.store.listThreadTurns(f.workspace.id, f.thread.id).map((value) => value.id)).toEqual([
    turn.id,
  ]);
  expect(f.store.listThreadTurns(f.workspace.id, next.id)).toEqual([]);
  expect(findAssistantTimeline(f.store, f.workspace.id, actor.id)?.id).toBe(next.id);
  await expect(
    f.store.createTurn(f.workspace.id, f.thread.id, 'Stale predecessor', actor)
  ).rejects.toThrow();
  const reloaded = new FsStore({ dataRoot: f.dataRoot });
  expect((await reloaded.continueThreadSegment(f.workspace.id, f.thread.id)).id).toBe(next.id);
  await expect(
    f.store.createThread(f.workspace.id, 'Conflicting successor', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: actor.id,
      parentThreadId: f.thread.id,
      segment: 1,
      segmentation: f.thread.segmentation,
    })
  ).rejects.toThrow();
});

it('refuses a new continuation with a missing predecessor and does not reinterpret a handoff as a segment (#732)', async () => {
  const f = await fixture();
  await expect(
    f.store.createThread(f.workspace.id, 'Missing predecessor', undefined, 'conversation', {
      visibility: 'workspace',
      parentThreadId: allocateEntityId('th'),
      segment: 1,
      segmentation: f.thread.segmentation,
    })
  ).rejects.toThrow();
});

it('uses the declared byte cap independently of the observation-line cap (#732)', async () => {
  const f = await fixture(1, 100);
  const turn = await f.store.createTurn(f.workspace.id, f.thread.id, 'Byte overflow', actor);
  await appendWorkObservation(f.db, {
    threadId: f.thread.id,
    turnId: turn.id,
    observation: {
      id: 'configured',
      ts: new Date().toISOString(),
      type: 'config.model',
      obs: 'llm-gateway',
      ret: 'turn-evidence',
      payload: { attempt: 0, providerRef: 'p', model: 'm', sampling: {} },
    },
    bodies: [],
  });
  await f.store.completeTurn(turn.id, {
    status: 'completed',
    completedAt: new Date().toISOString(),
  });
  const next = await f.store.continueThreadSegment(f.workspace.id, f.thread.id);
  expect(next).toMatchObject({ parentThreadId: f.thread.id, segment: 1 });
});

it('declares a cap for future admission on an unsegmented rc.9 Thread without changing old Turn coverage (#732)', async () => {
  const f = await fixture();
  // Seed the exact valid historical absence shape; no historical default is inferred by a reader.
  f.db.sqlite
    .prepare(
      "UPDATE control_threads SET record_json=json_remove(record_json,'$.segment','$.segmentation') WHERE id=?"
    )
    .run(f.thread.id);
  expect(f.store.getThread(f.workspace.id, f.thread.id).segmentation).toBeUndefined();
  const old = await f.store.createTurn(f.workspace.id, f.thread.id, 'Historical run', actor, null, {
    captureCoverage: { scope: 'server', value: 'off' },
  });
  expect(
    (await f.store.continueThreadSegment(f.workspace.id, f.thread.id)).segmentation
  ).toBeUndefined();
  await f.store.completeTurn(old.id, {
    status: 'completed',
    completedAt: new Date().toISOString(),
  });
  const bound = await f.store.continueThreadSegment(f.workspace.id, f.thread.id);
  expect(bound).toMatchObject({
    segment: 0,
    segmentation: { maxObservationLines: 10_000, maxBytes: 100_000_000, boundaryDelayed: true },
  });
  expect(f.store.getTurnCaptureCoverage(old.id)).toEqual({ scope: 'server', value: 'off' });
});
