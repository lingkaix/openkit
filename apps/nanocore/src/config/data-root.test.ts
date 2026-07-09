import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveDataRoot } from './data-root.js';

describe('resolveDataRoot', () => {
  it('resolves the default data root to an absolute system temp path', () => {
    expect(resolveDataRoot({})).toBe(resolve(tmpdir(), 'openkit-nanocore-data'));
  });

  it('honors a relative OPENKIT_DATA_ROOT value', () => {
    expect(resolveDataRoot({ OPENKIT_DATA_ROOT: 'tmp/openkit-data' })).toBe(
      resolve(process.cwd(), 'tmp/openkit-data')
    );
  });

  it('honors an absolute OPENKIT_DATA_ROOT value', () => {
    const absoluteRoot = resolve(process.cwd(), 'absolute-data');

    expect(resolveDataRoot({ OPENKIT_DATA_ROOT: absoluteRoot })).toBe(absoluteRoot);
  });
});
