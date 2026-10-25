import { describe, expect, it } from 'vitest';

import { resolveBindHost, resolveBindPort } from './bind-host.js';

describe('resolveBindHost', () => {
  it('binds local mode to loopback by default', () => {
    expect(resolveBindHost({}, 'local')).toBe('127.0.0.1');
  });

  it('honors server-mode OPENKIT_BIND_HOST overrides', () => {
    expect(resolveBindHost({ OPENKIT_BIND_HOST: '0.0.0.0' }, 'server')).toBe('0.0.0.0');
  });

  it.each([
    '0.0.0.0',
    '::',
    '192.0.2.10',
    'core.example',
  ])('rejects local non-loopback bind %s even when TLS material is configured', (host) => {
    const tlsEnv = {
      PORT: '4317',
      OPENKIT_TLS_CERT_FILE: '/fixture/server.crt',
      OPENKIT_TLS_KEY_FILE: '/fixture/server.key',
    };
    expect(() => resolveBindHost({ ...tlsEnv, OPENKIT_BIND_HOST: host }, 'local')).toThrow();
    expect(() =>
      resolveBindHost(tlsEnv, 'local', { server: { bind: { host, port: 4317 } } })
    ).toThrow();
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
