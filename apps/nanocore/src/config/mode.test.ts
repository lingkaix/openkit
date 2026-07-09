import { describe, expect, it } from 'vitest';

import { BootConfigError, resolveMode } from './mode.js';

describe('resolveMode', () => {
  it('defaults to local when env and config are absent', () => {
    expect(resolveMode({}, {})).toBe('local');
  });

  it('uses config mode when env is absent', () => {
    expect(resolveMode({}, { mode: 'server' })).toBe('server');
  });

  it('uses env mode before config mode', () => {
    expect(resolveMode({ OPENKIT_CORE_MODE: 'local' }, { mode: 'server' })).toBe('local');
  });

  it('accepts server mode from env', () => {
    expect(resolveMode({ OPENKIT_CORE_MODE: 'server' }, {})).toBe('server');
  });

  it('throws a typed boot error for invalid env mode', () => {
    expect(() => resolveMode({ OPENKIT_CORE_MODE: 'desktop' }, { mode: 'local' })).toThrow(
      BootConfigError
    );
    expect(() => resolveMode({ OPENKIT_CORE_MODE: 'desktop' }, { mode: 'local' })).toThrow(
      /Invalid OPENKIT_CORE_MODE "desktop"/
    );
  });
});
