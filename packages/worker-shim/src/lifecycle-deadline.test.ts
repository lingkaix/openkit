import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { expect, it, vi } from 'vitest';
import { LIFECYCLE_DEFAULTS } from './lifecycle-deadline.js';

vi.mock('node:fs', () => ({ readFileSync: vi.fn(() => 'max 100000\n') }));
vi.mock('node:os', () => ({ availableParallelism: vi.fn(() => 4) }));

/** Observes the production default under independent quota and affinity inputs. */
async function startupDefault(affinity: number, quota: string | Error): Promise<number> {
  vi.mocked(availableParallelism).mockReturnValue(affinity);
  vi.mocked(readFileSync).mockImplementation(() => {
    if (quota instanceof Error) throw quota;
    return quota;
  });
  vi.resetModules();
  return (await import('./lifecycle-deadline.js')).LIFECYCLE_DEFAULTS.nativeStartupConcurrency;
}

it('keeps native request timing and covers the former sequential open ceilings plus cleanup', () => {
  expect(LIFECYCLE_DEFAULTS.nativeRequestMs).toBe(8_000);
  expect(LIFECYCLE_DEFAULTS.nativeOpenMs).toBeGreaterThanOrEqual(3 * 8_000 + 4_000);
  expect(LIFECYCLE_DEFAULTS.nativeOpenMs).toBeLessThanOrEqual(60_000);
});

it.each([
  [8, '100000 100000\n', 1],
  [8, '200000 100000\n', 2],
  [8, '400000 100000\n', 2],
  [8, '150000 100000\n', 1],
  [8, '50000 100000\n', 1],
  [8, 'max 100000\n', 2],
  [1, 'max 100000\n', 1],
  [1, '400000 100000\n', 1],
] as const)('bounds native startup for affinity %i and cpu.max %s at %i', async (affinity, quota, bound) => {
  expect(await startupDefault(affinity, quota)).toBe(bound);
});

it('uses affinity when the cgroup v2 quota file is absent', async () => {
  const missing = Object.assign(new Error('No cgroup v2 CPU controller.'), { code: 'ENOENT' });
  expect(await startupDefault(8, missing)).toBe(2);
  expect(await startupDefault(1, missing)).toBe(1);
});

it('serializes native startup when the quota cannot be read', async () => {
  const denied = Object.assign(new Error('CPU quota is not readable.'), { code: 'EACCES' });
  expect(await startupDefault(8, denied)).toBe(1);
});

it.each([
  '',
  '100000 0',
  '0 100000',
  'invalid',
  '100000 100000 extra',
])('serializes native startup for malformed cpu.max %j', async (quota) => {
  expect(await startupDefault(8, quota)).toBe(1);
});
