import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDemoStore } from '../test-support/demo-store.js';
import { DEFAULT_CAPTURE_COVERAGE_BINDING, FsStore } from './store.js';

const LOCAL_ACTOR = { kind: 'user', id: 'user_local' } as const;

describe('Turn capture coverage binding', () => {
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
