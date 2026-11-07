import { describe, expect, it } from 'vitest';
import {
  workerObservationSourceRelativePath,
  workerSessionInputPaths,
  workerThreadRuntimeRoot,
  workerTurnCapturePaths,
} from './index.js';

describe('Thread and runtime capture paths', () => {
  it('preserves exact identities and the native collector-relative structure', () => {
    expect(workerThreadRuntimeRoot('th_00000000-0000-73e1-8c64-898ab9209386', 'codex')).toBe(
      '/openkit/threads/th_00000000-0000-73e1-8c64-898ab9209386/codex'
    );
    expect(
      workerTurnCapturePaths(
        'th_00000000-0000-73e1-8c64-898ab9209386',
        'codex',
        'tu_00000000-0000-78bc-a301-425daca952a3'
      )
    ).toEqual({
      root: '/openkit/threads/th_00000000-0000-73e1-8c64-898ab9209386/codex/capture/tu_00000000-0000-78bc-a301-425daca952a3',
      eventsPath:
        '/openkit/threads/th_00000000-0000-73e1-8c64-898ab9209386/codex/capture/tu_00000000-0000-78bc-a301-425daca952a3/events.jsonl',
      itemsPath:
        '/openkit/threads/th_00000000-0000-73e1-8c64-898ab9209386/codex/capture/tu_00000000-0000-78bc-a301-425daca952a3/items.jsonl',
      rawStreamsRoot:
        '/openkit/threads/th_00000000-0000-73e1-8c64-898ab9209386/codex/capture/tu_00000000-0000-78bc-a301-425daca952a3/runtime/raw',
      streamManifestPath:
        '/openkit/threads/th_00000000-0000-73e1-8c64-898ab9209386/codex/capture/tu_00000000-0000-78bc-a301-425daca952a3/runtime/raw-streams.json',
      nativeOriginIndexPath:
        '/openkit/threads/th_00000000-0000-73e1-8c64-898ab9209386/codex/capture/tu_00000000-0000-78bc-a301-425daca952a3/runtime/native-origin-index.jsonl',
    });
  });

  it('preserves canonical owner-derived Thread and Turn identities without transforming them', () => {
    expect(
      workerTurnCapturePaths(
        'th_00000000-0000-51c6-9c44-9f6b3fa169f2',
        'codex',
        'tu_00000000-0000-557c-9567-a7db75693c37'
      ).root
    ).toBe(
      '/openkit/threads/th_00000000-0000-51c6-9c44-9f6b3fa169f2/codex/capture/tu_00000000-0000-557c-9567-a7db75693c37'
    );
  });

  it('keeps every Thread, runtime family and Turn address distinct', () => {
    const paths = [
      'th_01890f3e-0000-7000-8000-000000000001',
      'th_01890f3e-0000-5000-8000-000000000001',
    ].flatMap((thread) =>
      ['codex', 'pi', 'opencode', 'deepseek'].flatMap((runtime) =>
        ['tu_01890f3e-0000-7000-8000-000000000001', 'tu_01890f3e-0000-5000-8000-000000000001'].map(
          (turn) => workerTurnCapturePaths(thread, runtime, turn).root
        )
      )
    );
    expect(new Set(paths).size).toBe(16);
  });

  it.each([
    '',
    '.',
    '..',
    '../other',
    'nested/thread',
    'nested\\thread',
    'thread\n',
    'thread name',
    '%2e%2e',
    '线程',
  ])('rejects noncanonical identities without encoding or hashing: %j', (value) => {
    expect(() =>
      workerTurnCapturePaths(value, 'codex', 'tu_01890f3e-0000-7000-8000-000000000001')
    ).toThrow();
    expect(() =>
      workerTurnCapturePaths(
        'th_01890f3e-0000-7000-8000-000000000001',
        value,
        'tu_01890f3e-0000-7000-8000-000000000001'
      )
    ).toThrow();
    expect(() =>
      workerTurnCapturePaths('th_01890f3e-0000-7000-8000-000000000001', 'codex', value)
    ).toThrow();
  });

  it('derives AgentSession input paths only for canonical AgentSession identities', () => {
    const id = 'as_01890f3e-0000-7000-8000-000000000001';
    expect(workerSessionInputPaths(id)).toEqual({
      root: `/openkit/sessions/${id}`,
      packagePath: `/openkit/sessions/${id}/config/package.json`,
      contextRoot: `/openkit/sessions/${id}/context`,
      supplyRoot: `/openkit/sessions/${id}/supply/inputs`,
      packageRelativePath: `${id}/config/package.json`,
      contextRelativePath: `${id}/context`,
      supplyRelativePath: `${id}/supply/inputs`,
    });

    for (const invalid of [
      undefined,
      '',
      'as_01890f3e-0000-5000-8000-000000000001',
      'ws_01890f3e-0000-7000-8000-000000000001',
      'th_01890f3e-0000-7000-8000-000000000001',
      '../as_01890f3e-0000-7000-8000-000000000001',
      `${id}/extra`,
    ]) {
      expect(() => workerSessionInputPaths(invalid)).toThrow(
        'Worker inputs require a canonical AgentSession identity.'
      );
    }
  });

  it('derives observation source relative paths only from non-negative integer sequences', () => {
    expect(workerObservationSourceRelativePath(0)).toBe('runtime/observations/0.jsonl');
    expect(workerObservationSourceRelativePath(42)).toBe('runtime/observations/42.jsonl');
    for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => workerObservationSourceRelativePath(invalid)).toThrow();
    }
  });
});
