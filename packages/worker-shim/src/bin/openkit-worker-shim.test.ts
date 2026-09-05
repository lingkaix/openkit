import { afterEach, expect, it, vi } from 'vitest';

const activity = vi.hoisted(
  () => [] as Array<{ readonly bytes?: number[]; readonly kind: 'harness' | 'stdout' }>
);

vi.mock('../harness.js', () => ({
  runWorkerHarness: vi.fn(async () => {
    activity.push({ kind: 'harness' });
  }),
}));

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

it('hands marker ownership to the listener-ready Harness on the production path', async () => {
  activity.length = 0;
  vi.resetModules();
  process.argv = [process.execPath, '/usr/local/bin/openkit-worker-shim'];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    activity.push({
      bytes: [...(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))],
      kind: 'stdout',
    });
    return true;
  }) as typeof process.stdout.write);

  await import('./openkit-worker-shim.js');

  expect(activity.at(-1)).toEqual({ kind: 'harness' });
  expect(activity.filter(({ kind }) => kind === 'harness')).toHaveLength(1);
  expect(activity.filter(({ kind }) => kind === 'stdout')).toEqual([]);
});

it('rejects every bootstrap argument without starting the Harness', async () => {
  activity.length = 0;
  vi.resetModules();
  process.argv = [process.execPath, '/usr/local/bin/openkit-worker-shim', '--package'];
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  await import('./openkit-worker-shim.js');

  expect(activity).toEqual([]);
  expect(error).toHaveBeenCalledWith('Worker Harness accepts no arguments.');
  expect(process.exitCode).toBe(64);
});
