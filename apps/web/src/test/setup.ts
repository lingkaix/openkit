import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';

// globals: false, so register the axe a11y matchers explicitly.
expect.extend(axeMatchers);

// globals: false, so register Testing Library's DOM cleanup explicitly.
afterEach(() => {
  cleanup();
});
