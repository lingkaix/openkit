import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workObservationBodyBundleId } from '../evidence-bundles.js';
import { withTurnModelCapture } from '../llm/model-capture.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { appendWorkObservation, readWorkObservations } from '../storage/work-observations.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { DEFAULT_CAPTURE_COVERAGE_BINDING, FsStore } from './store.js';

const syncFailureRoots: string[] = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of syncFailureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LOCAL_ACTOR = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;

describe('Turn capture coverage binding', () => {
  it.each([
    { stage: 'thread metadata', operation: 'UPDATE', table: 'control_threads' },
    { stage: 'Turn coverage', operation: 'INSERT', table: 'control_turns' },
  ] as const)('blocks governed collection when native admission $stage fails', async ({
    operation,
    table,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capture-sync-'));
    syncFailureRoots.push(dataRoot);
    const store = await createDemoStore({ dataRoot });
    store.setLiveCaptureCoverage({ scope: 'server', value: 'on' });
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const thread = await store.createThread(workspaceId, 'Capture sync failure');
    const before = structuredClone(store.getThread(workspaceId, thread.id));
    const turnId = 'tu_00000000-0000-7a17-81b3-4a0efca762bc';
    const turnRoot = join(
      dataRoot,
      'workspaces',
      workspaceId,
      'threads',
      thread.id,
      'turns',
      turnId
    );
    const collect = vi.fn(async () => undefined);
    const admitted = vi.fn();
    store.setTurnAdmissionHooks({ onAdmitted: admitted });
    const db = openWorkspaceDb(dataRoot, workspaceId);
    try {
      // These replace file and parent-directory fsync faults: SQL now owns the whole admission tuple.
      db.sqlite.exec(`CREATE TRIGGER capture_admission_abort BEFORE ${operation} ON ${table}
        BEGIN SELECT RAISE(ABORT, 'capture_admission_abort'); END`);
      await expect(
        (async () => {
          const turn = await store.createTurn(
            workspaceId,
            thread.id,
            'Must not collect',
            LOCAL_ACTOR,
            null,
            { turnId }
          );
          await withTurnModelCapture({ store, turn }, collect);
        })()
      ).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
      expect(collect).not.toHaveBeenCalled();
      expect(admitted).not.toHaveBeenCalled();
      expect(store.getTurnCaptureCoverage(turnId)).toBeNull();
      expect(() => store.getTurnById(turnId)).toThrow('Turn not found');
      expect(store.getThread(workspaceId, thread.id)).toEqual(before);
      expect(db.sqlite.prepare('SELECT id FROM control_turns WHERE id=?').all(turnId)).toEqual([]);
      expect(
        db.sqlite.prepare('SELECT id FROM control_product_entries WHERE turn_id=?').all(turnId)
      ).toEqual([]);
      expect(
        db.sqlite.prepare('SELECT id FROM control_work_observations WHERE turn_id=?').all(turnId)
      ).toEqual([]);
      expect(existsSync(join(turnRoot, 'turn.json'))).toBe(false);
      expect(existsSync(join(turnRoot, 'observations.jsonl'))).toBe(false);
    } finally {
      db.sqlite.exec('DROP TRIGGER IF EXISTS capture_admission_abort');
      db.sqlite.close();
    }
    await shutdownControlStoreWorkerClient();
    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getTurnCaptureCoverage(turnId)).toBeNull();
    expect(reloaded.getThread(workspaceId, thread.id)).toEqual(before);
  });

  it.each([
    { stage: 'Turn metadata', operation: 'UPDATE', table: 'control_turns' },
    { stage: 'expected observation', operation: 'INSERT', table: 'control_work_observations' },
  ] as const)('retains no observation or body when native $stage commit fails', async ({
    operation,
    table,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capture-manifest-sync-'));
    syncFailureRoots.push(dataRoot);
    const store = await createDemoStore({ dataRoot });
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const thread = await store.createThread(workspaceId, 'Manifest sync failure');
    const turn = await store.createTurn(workspaceId, thread.id, 'Admitted', LOCAL_ACTOR, null, {
      captureCoverage: { scope: 'server', value: 'on' },
    });
    const before = structuredClone(store.getTurnById(turn.id));
    const turnRoot = join(
      dataRoot,
      'workspaces',
      workspaceId,
      'threads',
      thread.id,
      'turns',
      turn.id
    );
    const db = openWorkspaceDb(dataRoot, workspaceId);
    try {
      // Expected metadata must ACK before the independent retained-body publisher can run.
      db.sqlite.exec(`CREATE TRIGGER capture_observation_abort BEFORE ${operation} ON ${table}
        BEGIN SELECT RAISE(ABORT, 'capture_observation_abort'); END`);
      await expect(
        appendWorkObservation(db, {
          threadId: thread.id,
          turnId: turn.id,
          observation: {
            id: 'blocked-observation',
            type: 'model.observed',
            ts: '2026-09-29T00:00:00.000Z',
            obs: 'llm-gateway',
            payload: {
              attempt: 0,
              direction: 'response',
              event: 'text_end',
              runtimeOriginRef: null,
              content: { state: 'expected' },
            },
          },
          bodies: [
            {
              id: 'semantic',
              bytes: Buffer.from('Must not be retained'),
              mediaType: 'text/plain',
              boundary: 'test-semantic-v1',
            },
          ],
        })
      ).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
      expect(readWorkObservations(db, { threadId: thread.id, turnId: turn.id })).toEqual([]);
      expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM evidence_bundles').get()).toEqual({
        count: 0,
      });
      expect(store.getTurnById(turn.id)).toEqual(before);
      expect(store.getTurnCaptureCoverage(turn.id)).toEqual({ scope: 'server', value: 'on' });
      const bundleId = workObservationBodyBundleId(
        workspaceId,
        thread.id,
        turn.id,
        'blocked-observation',
        'semantic'
      );
      expect(
        existsSync(
          join(
            dataRoot,
            'workspaces',
            workspaceId,
            'evidence',
            'backend',
            bundleId,
            'raw',
            'content'
          )
        )
      ).toBe(false);
      expect(existsSync(join(turnRoot, 'observations.jsonl'))).toBe(false);
    } finally {
      db.sqlite.exec('DROP TRIGGER IF EXISTS capture_observation_abort');
      db.sqlite.close();
    }
    await shutdownControlStoreWorkerClient();
    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getTurnById(turn.id)).toEqual(before);
    expect(reloaded.getTurnCaptureCoverage(turn.id)).toEqual({ scope: 'server', value: 'on' });
  });

  it('records the off pair at admission by default', async () => {
    const store = await createDemoStore();
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Capture off'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Default off',
      LOCAL_ACTOR
    );

    expect(store.getTurnCaptureCoverage(turn.id)).toEqual(DEFAULT_CAPTURE_COVERAGE_BINDING);
    expect(store.getLiveCaptureCoverage()).toEqual({ scope: 'server', value: 'off' });
  });

  it('records the on pair when the live switch is on at admission', async () => {
    const store = await createDemoStore();
    store.setLiveCaptureCoverage({ scope: 'workspace', value: 'on' });
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Capture on'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Switch on',
      LOCAL_ACTOR
    );

    expect(store.getTurnCaptureCoverage(turn.id)).toEqual({ scope: 'workspace', value: 'on' });
  });

  it('keeps a running Turn pair unchanged and does not interrupt when the live switch changes', async () => {
    const store = await createDemoStore();
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Capture mid-turn'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Keep historical pair',
      LOCAL_ACTOR
    );
    store.setLiveCaptureCoverage({ scope: 'server', value: 'on' });

    expect(store.getTurnById(turn.id).status).toBe('running');
    expect(store.getTurnCaptureCoverage(turn.id)).toEqual(DEFAULT_CAPTURE_COVERAGE_BINDING);
    const next = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Next turn sees the new pair',
      LOCAL_ACTOR
    );
    expect(store.getTurnCaptureCoverage(next.id)).toEqual({ scope: 'server', value: 'on' });
    expect(store.getTurnById(turn.id).status).toBe('running');
  });

  it.each([
    'missing',
    'stale',
  ] as const)('reads the recorded native pair with a %s turn.json after restart', async (projection) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capture-coverage-'));
    syncFailureRoots.push(dataRoot);
    const store = await createDemoStore({ dataRoot });
    store.setLiveCaptureCoverage({ scope: 'task', value: 'on' });
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Capture restart'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Persist the pair',
      LOCAL_ACTOR
    );
    const turnPath = join(
      dataRoot,
      'workspaces',
      'ws_00000000-0000-7000-8000-000000000001',
      'threads',
      thread.id,
      'turns',
      turn.id,
      'turn.json'
    );
    expect(store.getTurnById(turn.id).items).toEqual([]);
    expect(store.getTurnCaptureCoverage(turn.id)).toEqual({ scope: 'task', value: 'on' });
    expect(existsSync(turnPath)).toBe(false);
    const stale = JSON.stringify({ ...turn, captureCoverage: { scope: 'server', value: 'off' } });
    if (projection === 'stale') {
      mkdirSync(dirname(turnPath), { recursive: true });
      writeFileSync(turnPath, stale);
    }
    store.setLiveCaptureCoverage({ scope: 'server', value: 'off' });
    await shutdownControlStoreWorkerClient();
    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getTurnCaptureCoverage(turn.id)).toEqual({ scope: 'task', value: 'on' });
    expect(reloaded.getTurnById(turn.id).status).toBe('running');
    expect(reloaded.getTurnById(turn.id).items).toEqual([]);
    expect(existsSync(turnPath)).toBe(projection === 'stale');
    if (projection === 'stale') expect(readFileSync(turnPath, 'utf8')).toBe(stale);
  });

  it('records on from server.jsonc policy.workDataCapture at the next admitted Turn', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capture-config-on-'));
    syncFailureRoots.push(dataRoot);
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        policy: { workDataCapture: { value: 'on' } },
      })
    );
    const store = await createDemoStore({ dataRoot });
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Configured capture'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Operator switch on',
      LOCAL_ACTOR
    );

    expect(store.getTurnCaptureCoverage(turn.id)).toEqual({ scope: 'server', value: 'on' });
  });
});
