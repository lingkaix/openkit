import { describe, expect, it } from 'vitest';

import { resolveBindHost, resolveBindPort } from './bind-host.js';

describe('resolveBindHost', () => {
  it('binds local mode to loopback by default', () => {
    expect(resolveBindHost({}, 'local')).toBe('127.0.0.1');
  });

  it('honors OPENKIT_BIND_HOST overrides', () => {
    expect(resolveBindHost({ OPENKIT_BIND_HOST: '0.0.0.0' }, 'local')).toBe('0.0.0.0');
  });

  it('uses configured bind values when environment overrides are absent', () => {
    const config = { server: { bind: { host: '10.0.0.8', port: 4310 } } };

    expect(resolveBindHost({}, 'server', config)).toBe('10.0.0.8');
    expect(resolveBindPort({}, config)).toBe(4310);
  });

  it('gives environment bind values precedence over server config', () => {
    const config = { server: { bind: { host: '10.0.0.8', port: 4310 } } };

    expect(resolveBindHost({ OPENKIT_BIND_HOST: '127.0.0.1' }, 'server', config)).toBe('127.0.0.1');
    expect(resolveBindPort({ PORT: '4320' }, config)).toBe(4320);
  });

  it('uses port 3000 when neither environment nor config selects a port', () => {
    expect(resolveBindPort({}, {})).toBe(3000);
  });

  it('rejects invalid environment ports', () => {
    expect(() => resolveBindPort({ PORT: 'not-a-port' }, {})).toThrow('PORT');
    expect(() => resolveBindPort({ PORT: '70000' }, {})).toThrow('PORT');
  });
});
