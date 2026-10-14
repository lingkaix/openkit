import { describe, expect, it } from 'vitest';
import { workerThreadRuntimeRoot, workerTurnCapturePaths } from './index.js';

describe('Thread and runtime capture paths', () => {
  it('preserves exact identities and the native collector-relative structure', () => {
    expect(workerThreadRuntimeRoot('thread_a-1', 'codex')).toBe(
      '/openkit/threads/thread_a-1/codex'
    );
    expect(workerTurnCapturePaths('thread_a-1', 'codex', 'turn_b-2')).toEqual({
      root: '/openkit/threads/thread_a-1/codex/capture/turn_b-2',
      eventsPath: '/openkit/threads/thread_a-1/codex/capture/turn_b-2/events.jsonl',
      itemsPath: '/openkit/threads/thread_a-1/codex/capture/turn_b-2/items.jsonl',
      rawStreamsRoot: '/openkit/threads/thread_a-1/codex/capture/turn_b-2/runtime/raw',
      streamManifestPath:
        '/openkit/threads/thread_a-1/codex/capture/turn_b-2/runtime/raw-streams.json',
      nativeOriginIndexPath:
        '/openkit/threads/thread_a-1/codex/capture/turn_b-2/runtime/native-origin-index.jsonl',
    });
  });

  it('preserves Core hash-qualified Thread and Turn identities without transforming them', () => {
    expect(workerTurnCapturePaths('th_task_sha256:0123', 'codex', 'tu_task_sha256:4567').root).toBe(
      '/openkit/threads/th_task_sha256:0123/codex/capture/tu_task_sha256:4567'
    );
  });

  it('keeps every Thread, runtime family and Turn address distinct', () => {
    const paths = ['thread-a', 'thread-b'].flatMap((thread) =>
      ['codex', 'pi', 'opencode', 'deepseek'].flatMap((runtime) =>
        ['turn-a', 'turn-b'].map((turn) => workerTurnCapturePaths(thread, runtime, turn).root)
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
    expect(() => workerTurnCapturePaths(value, 'codex', 'turn')).toThrow();
    expect(() => workerTurnCapturePaths('thread', value, 'turn')).toThrow();
    expect(() => workerTurnCapturePaths('thread', 'codex', value)).toThrow();
  });
});
