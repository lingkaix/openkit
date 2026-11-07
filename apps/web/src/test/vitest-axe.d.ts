import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';
import type { AxeMatchers } from 'vitest-axe/matchers';

// Vitest 5 types custom matchers via `Matchers<R, T>` in the `vitest` module; jest-dom's own
// bridge still augments the two-parameter `Assertion` (vitest 4 shape), and vitest-axe only the
// legacy global `Vi` namespace, so bridge both matcher sets here.
declare module 'vitest' {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown>
    extends TestingLibraryMatchers<unknown, R>,
      AxeMatchers {}
}
