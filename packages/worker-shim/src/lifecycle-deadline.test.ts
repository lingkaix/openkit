import { expect, it } from 'vitest';
import { LIFECYCLE_DEFAULTS } from './lifecycle-deadline.js';

it('keeps native request timing and covers the former sequential open ceilings plus cleanup', () => {
  expect(LIFECYCLE_DEFAULTS.nativeRequestMs).toBe(8_000);
  expect(LIFECYCLE_DEFAULTS.nativeOpenMs).toBeGreaterThanOrEqual(3 * 8_000 + 4_000);
  expect(LIFECYCLE_DEFAULTS.nativeOpenMs).toBeLessThanOrEqual(60_000);
});
