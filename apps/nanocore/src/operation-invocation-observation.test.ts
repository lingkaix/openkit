import { performance } from 'node:perf_hooks';
import { setImmediate as nextCallback } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { startMainLoopObserver } from './main-loop-observer.js';
import { createOperationEngine } from './operation-invocation.js';

// Admission semantics belong to operation-projections.test.ts; this observes the engine/label join.
vi.mock('./operation-resolvers.js', () => ({
  admitOperation: async (_definition: unknown, input: unknown, context: unknown) => ({
    input,
    context,
  }),
}));
let stop: (() => void) | undefined;
afterEach(() => stop?.());

it('labels the admitted native handler continuation without changing its validated result', async () => {
  const records: Record<string, unknown>[] = [];
  const observer = startMainLoopObserver({ emit: (record) => records.push(record) });
  stop = observer.stop;
  const invoke = createOperationEngine(
    {
      'workspace.list': async () => {
        await nextCallback();
        const end = performance.now() + 110;
        while (performance.now() < end) {}
        return { items: [] };
      },
    },
    { coreDb: undefined }
  );
  expect(
    await invoke(
      'workspace.list',
      {},
      {
        kind: 'public',
        actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
      }
    )
  ).toEqual({ items: [] });
  await nextCallback();
  observer.flush();
  expect(records).toContainEqual(
    expect.objectContaining({
      event: 'main_loop_long_task',
      observation: 'callback',
      operation: 'workspace.list',
    })
  );
});
