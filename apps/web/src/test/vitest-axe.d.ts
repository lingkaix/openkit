import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';
import type { AxeMatchers } from 'vitest-axe/matchers';

// Vitest 4 types custom matchers via the `vitest` module (not the legacy global
// `Vi` namespace vitest-axe augments), so bridge the axe matchers here.
declare module 'vitest' {
  interface Assertion<T> extends TestingLibraryMatchers<unknown, T>, AxeMatchers {}
  interface AsymmetricMatchersContaining
    extends TestingLibraryMatchers<unknown, unknown>,
      AxeMatchers {}
}
