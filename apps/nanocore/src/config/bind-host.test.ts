import { describe, expect, it } from 'vitest';

import { resolveBindHost } from './bind-host.js';

describe('resolveBindHost', () => {
  it('binds local mode to loopback by default', () => {
    expect(resolveBindHost({}, 'local')).toBe('127.0.0.1');
  });

  it('honors OPENKIT_BIND_HOST overrides', () => {
    expect(resolveBindHost({ OPENKIT_BIND_HOST: '0.0.0.0' }, 'local')).toBe('0.0.0.0');
  });
});
