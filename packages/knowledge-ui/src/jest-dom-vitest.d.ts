import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

// Vitest 5 types custom matchers via `Matchers<R, T>`; jest-dom's bridge still augments the
// vitest 4 `Assertion` shape, so expose its matchers here.
declare module 'vitest' {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown>
    extends TestingLibraryMatchers<unknown, R> {}
}
