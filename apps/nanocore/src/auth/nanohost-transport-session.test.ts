import { describe, expect, it } from 'vitest';

import {
  bindRequiresServerAuthenticatedTls,
  createNanoHostTransportSessionAuthority,
  resolveNanoHostTransportListener,
} from './nanohost-transport-session.js';

/**
 * S-2b-3 Unit 1 reds: one authoritative NanoHost transport session and
 * predecessor fencing (`docs/specs/20260802-nanohost_runtime_and_transport.md`).
 *
 * Prefer fail-on-absence: the harness stub admits every generation as
 * authoritative and always allows work, so these predicates fail until the
 * builder lands real session authority.
 */
describe('nanohost-transport-session authority', () => {
  const identityId = 'nanohost_test_identity';
  const configuredNanoHost = {
    bind: { host: '127.0.0.1', port: 4318 },
    credentialRef: 'nanohost-transport:primary',
    credentialSlots: {
      A: { companionPath: '/run/nanohost-a.meta', secretPath: '/run/nanohost-a.token' },
      B: { companionPath: '/run/nanohost-b.meta', secretPath: '/run/nanohost-b.token' },
    },
    deploymentId: 'deployment-test',
    identityId: 'nanohost-test',
    rendezvousUrl: 'http://127.0.0.1:4318',
  };

  it('rejects caller-created objects as physical connection identities', () => {
    const authority = createNanoHostTransportSessionAuthority();
    const forged = authority.admit({
      identityId,
      physicalConnection: {} as never,
      connectionGeneration: 1,
      predecessorGeneration: null,
    });
    expect(forged.role).toBe('rejected');
    expect(authority.mayCarryWork(forged)).toBe(false);
    expect(authority.authoritativeGeneration(identityId)).toBeNull();
  });

  it('non_loopback_bind_requires_server_authenticated_tls', () => {
    expect(bindRequiresServerAuthenticatedTls('0.0.0.0')).toBe(true);
    expect(bindRequiresServerAuthenticatedTls('192.168.1.10')).toBe(true);
    expect(bindRequiresServerAuthenticatedTls('127.0.0.1')).toBe(false);
    expect(bindRequiresServerAuthenticatedTls('localhost')).toBe(false);
    expect(bindRequiresServerAuthenticatedTls('::1')).toBe(false);
  });

  it('resolves one dedicated loopback h2c listener from NanoHost config', () => {
    expect(resolveNanoHostTransportListener(configuredNanoHost, 4317)).toEqual({
      hostname: '127.0.0.1',
      port: 4318,
      secure: false,
    });
  });

  it('rejects plaintext when either NanoHost listener address is non-loopback', () => {
    const config = {
      ...configuredNanoHost,
      bind: { host: '0.0.0.0', port: 4318 },
    };

    expect(() => resolveNanoHostTransportListener(config, 4317)).toThrow(
      'Plaintext NanoHost HTTP/2 requires loopback'
    );
    expect(() =>
      resolveNanoHostTransportListener(
        {
          ...config,
          bind: { host: '127.0.0.1', port: 4318 },
          rendezvousUrl: 'http://nanocore.example:4318',
        },
        4317
      )
    ).toThrow('Plaintext NanoHost HTTP/2 requires loopback');
  });

  it('accepts a non-loopback NanoHost listener only through HTTPS', () => {
    expect(
      resolveNanoHostTransportListener(
        {
          ...configuredNanoHost,
          bind: { host: '0.0.0.0', port: 4318 },
          rendezvousUrl: 'https://nanocore.example:4318',
        },
        4317
      )
    ).toEqual({ hostname: '0.0.0.0', port: 4318, secure: true });
  });

  it('rejects an App and NanoHost listener port collision', () => {
    expect(() => resolveNanoHostTransportListener(configuredNanoHost, 4318)).toThrow(
      'App and NanoHost listeners must use distinct TCP ports.'
    );
  });
});
