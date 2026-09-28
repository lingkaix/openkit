import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workObservationBodyBundleId } from '../evidence-bundles.js';
import { withTurnModelCapture } from '../llm/model-capture.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { appendWorkObservation, readWorkObservations } from '../storage/work-observations.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { DEFAULT_CAPTURE_COVERAGE_BINDING, FsStore } from './store.js';

// Fault only the selected Turn manifest's actual file or parent-directory synchronization.
const syncFailure = vi.hoisted(() => ({
  target: null as string | null,
  stage: 'file' as 'file' | 'directory',
  failures: 0,
  descriptors: new Map<number, string>(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const openSync: typeof actual.openSync = (path, flags, mode) => {
    const descriptor = actual.openSync(path, flags, mode);
    syncFailure.descriptors.set(descriptor, String(path));
    return descriptor;
  };
  const closeSync: typeof actual.closeSync = (descriptor) => {
    syncFailure.descriptors.delete(descriptor);
    actual.closeSync(descriptor);
  };
  const fsyncSync: typeof actual.fsyncSync = (descriptor) => {
    const path = syncFailure.descriptors.get(descriptor);
    const target = syncFailure.target;
    if (
      target &&
      path &&
      (syncFailure.stage === 'file'
        ? dirname(path) === dirname(target) && basename(path).startsWith('.turn.json.')
        : path === dirname(target) && actual.existsSync(target))
    ) {
      syncFailure.failures += 1;
      throw new Error(`injected Turn manifest ${syncFailure.stage} sync failure`);
    }
    actual.fsyncSync(descriptor);
  };
  return { ...actual, openSync, closeSync, fsyncSync };
});

const syncFailureRoots: string[] = [];
afterEach(() => {
  syncFailure.target = null;
  syncFailure.failures = 0;
  for (const root of syncFailureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LOCAL_ACTOR = { kind: 'user', id: 'user_local' } as const;

describe('Turn capture coverage binding', () => {
  it.each([
    'file',
    'directory',
  ] as const)('blocks governed collection when admission coverage %s sync fails', async (stage) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capture-sync-'));
    syncFailureRoots.push(dataRoot);
    const store = createDemoStore({ dataRoot });
    store.setLiveCaptureCoverage({ scope: 'server', value: 'on' });
    const thread = store.createThread('ws_demo', 'Capture sync failure');
    const turnId = 'tu_capture_sync_failure';
    const turnPath = join(
      dataRoot,
      'workspaces',
      'ws_demo',
      'threads',
      thread.id,
      'turns',
      turnId,
      'turn.json'
    );
    syncFailure.target = turnPath;
    syncFailure.stage = stage;
    const collect = vi.fn(async () => undefined);

    await expect(
      (async () => {
        const turn = store.createTurn('ws_demo', thread.id, 'Must not collect', LOCAL_ACTOR, null, {
          turnId,
        });
        await withTurnModelCapture({ store, turn }, collect);
      })()
    ).rejects.toThrow(`injected Turn manifest ${stage} sync failure`);
    expect(syncFailure.failures).toBe(1);
    expect(collect).not.toHaveBeenCalled();
    // A rename may be visible after directory-sync failure; visibility is not admission ACK.
    expect(existsSync(turnPath)).toBe(stage === 'directory');
    expect(existsSync(join(dirname(turnPath), 'observations.jsonl'))).toBe(false);
  });

  it.each([
    'file',
    'directory',
  ] as const)('retains no observation or body when required Turn manifest %s sync fails', (stage) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capture-manifest-sync-'));
    syncFailureRoots.push(dataRoot);
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Manifest sync failure');
    const turn = store.createTurn('ws_demo', thread.id, 'Admitted', LOCAL_ACTOR, null, {
      captureCoverage: { scope: 'server', value: 'on' },
    });
    const turnRoot = join(
      dataRoot,
      'workspaces',
      'ws_demo',
      'threads',
      thread.id,
      'turns',
      turn.id
    );
    const db = openWorkspaceDb(dataRoot, 'ws_demo');
    try {
      applyScopedMigrations(db);
      syncFailure.target = join(turnRoot, 'turn.json');
      syncFailure.stage = stage;
      expect(() =>
        appendWorkObservation(db, {
          threadId: thread.id,
          turnId: turn.id,
          observation: {
            id: 'blocked-observation',
            type: 'model.observed',
            ts: '2026-09-29T00:00:00.000Z',
            obs: 'gateway',
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
      ).toThrow(`injected Turn manifest ${stage} sync failure`);
      expect(syncFailure.failures).toBe(1);
      expect(readWorkObservations(db, { threadId: thread.id, turnId: turn.id })).toEqual([]);
      expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM evidence_bundles').get()).toEqual({
        count: 0,
      });
      const bundleId = workObservationBodyBundleId(
        'ws_demo',
        thread.id,
        turn.id,
        'blocked-observation',
        'semantic'
      );
      expect(
        existsSync(
          join(dataRoot, 'workspaces', 'ws_demo', 'evidence', 'backend', bundleId, 'raw', 'content')
        )
      ).toBe(false);
      expect(existsSync(join(turnRoot, 'observations.jsonl'))).toBe(false);
    } finally {
      syncFailure.target = null;
      db.sqlite.close();
    }
  });

  it('records the off pair at admission by default', () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Capture off');
    const turn = store.createTurn('ws_demo', thread.id, 'Default off', LOCAL_ACTOR);

    expect(store.getTurnCaptureCoverage(turn.id)).toEqual(DEFAULT_CAPTURE_COVERAGE_BINDING);
    expect(store.getLiveCaptureCoverage()).toEqual({ scope: 'server', value: 'off' });
  });

  it('records the on pair when the live switch is on at admission', () => {
    const store = createDemoStore();
    store.setLiveCaptureCoverage({ scope: 'workspace', value: 'on' });
    const thread = store.createThread('ws_demo', 'Capture on');
    const turn = store.createTurn('ws_demo', thread.id, 'Switch on', LOCAL_ACTOR);

    expect(store.getTurnCaptureCoverage(turn.id)).toEqual({ scope: 'workspace', value: 'on' });
  });

  it('keeps a running Turn pair unchanged and does not interrupt when the live switch changes', () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Capture mid-turn');
    const turn = store.createTurn('ws_demo', thread.id, 'Keep historical pair', LOCAL_ACTOR);
    store.setLiveCaptureCoverage({ scope: 'server', value: 'on' });

    expect(store.getTurnById(turn.id).status).toBe('running');
    expect(store.getTurnCaptureCoverage(turn.id)).toEqual(DEFAULT_CAPTURE_COVERAGE_BINDING);
    const next = store.createTurn('ws_demo', thread.id, 'Next turn sees the new pair', LOCAL_ACTOR);
    expect(store.getTurnCaptureCoverage(next.id)).toEqual({ scope: 'server', value: 'on' });
    expect(store.getTurnById(turn.id).status).toBe('running');
  });

  it('reads the recorded pair back from turn.json after restart', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capture-coverage-'));
    const store = createDemoStore({ dataRoot });
    store.setLiveCaptureCoverage({ scope: 'task', value: 'on' });
    const thread = store.createThread('ws_demo', 'Capture restart');
    const turn = store.createTurn('ws_demo', thread.id, 'Persist the pair', LOCAL_ACTOR);
    const turnPath = join(
      dataRoot,
      'workspaces',
      'ws_demo',
      'threads',
      thread.id,
      'turns',
      turn.id,
      'turn.json'
    );
    const recorded = JSON.parse(readFileSync(turnPath, 'utf8')) as {
      captureCoverage?: { scope: string; value: string };
      items: unknown[];
    };
    expect(recorded.items).toEqual([]);
    expect(recorded.captureCoverage).toEqual({ scope: 'task', value: 'on' });

    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getTurnCaptureCoverage(turn.id)).toEqual({ scope: 'task', value: 'on' });
    expect(reloaded.getTurnById(turn.id).status).toBe('running');
  });

  it('records on from server.jsonc policy.workDataCapture at the next admitted Turn', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capture-config-on-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        policy: { workDataCapture: { value: 'on' } },
      })
    );
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Configured capture');
    const turn = store.createTurn('ws_demo', thread.id, 'Operator switch on', LOCAL_ACTOR);

    expect(store.getTurnCaptureCoverage(turn.id)).toEqual({ scope: 'server', value: 'on' });
  });
});
