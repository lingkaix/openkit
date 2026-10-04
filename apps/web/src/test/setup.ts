import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';

// Allow scheduling contention in parallel unit runs; these waits prove state, not render speed.
// Knowledge's initial controls appeared within 2s under CPU load but missed the default 1s bound.
configure({ asyncUtilTimeout: 3000 });

// globals: false, so register the axe a11y matchers explicitly.
expect.extend(axeMatchers);

// globals: false, so register Testing Library's DOM cleanup explicitly.
afterEach(() => {
  cleanup();
});
