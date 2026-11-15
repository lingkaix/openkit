import { describe, expect, it } from 'vitest';
import type {
  VaultCredentialWriter,
  VaultReferenceRecord,
} from '../storage/vault-native-codecs.js';
import {
  assertCoreMayDelegateCredentialFamily,
  assertCoreMayRotateCredentialFamily,
  assertDelegatedRefreshStrategyAvailable,
  readDelegatedRefreshShape,
} from './credential-writer.js';

const reference: VaultReferenceRecord = {
  referenceId: 'vault_writer_case',
  ownerScope: 'workspace',
  workspaceId: 'ws_writer_case',
  userId: null,
  displayName: 'Writer case',
  secretKind: 'http-bearer',
  backendKind: 'encrypted-file',
  backendLocator: null,
  status: 'active',
  currentVersion: 1,
  createdAt: '2026-11-15T00:00:00.000Z',
  updatedAt: '2026-11-15T00:00:00.000Z',
};
const gateway = (state: 'active' | 'pending' | 'fenced'): VaultCredentialWriter => ({
  generation: 2,
  mode: 'gateway',
  holder: 'receipt_writer_case',
  state,
});
const busy = { code: 'credential_family_busy', status: 409 };

describe('credential writer pre-checks', () => {
  it('lets Core rotate and delegate an absent or Core writer', () => {
    for (const value of [
      reference,
      {
        ...reference,
        credentialWriter: { generation: 3, mode: 'core', holder: null, state: 'active' } as const,
      },
    ]) {
      expect(() => assertCoreMayRotateCredentialFamily(value)).not.toThrow();
      expect(() => assertCoreMayDelegateCredentialFamily(value)).not.toThrow();
    }
  });

  it.each(['pending', 'active'] as const)('refuses rotation while delegation is %s', (state) => {
    expect(() =>
      assertCoreMayRotateCredentialFamily({ ...reference, credentialWriter: gateway(state) })
    ).toThrow(expect.objectContaining(busy));
  });

  it('accepts a new root version from a fenced holder but refuses redelegation', () => {
    const fenced = { ...reference, credentialWriter: gateway('fenced') };
    expect(() => assertCoreMayRotateCredentialFamily(fenced)).not.toThrow();
    expect(() => assertCoreMayDelegateCredentialFamily(fenced)).toThrow(
      expect.objectContaining(busy)
    );
  });

  it.each(['pending', 'active', 'fenced'] as const)(
    'refuses delegation while a %s Gateway writer exists',
    (state) => {
      expect(() =>
        assertCoreMayDelegateCredentialFamily({ ...reference, credentialWriter: gateway(state) })
      ).toThrow(expect.objectContaining(busy));
    }
  );
});

describe('delegated refresh configuration reads', () => {
  const shape = {
    id: 'example-api',
    credentialKey: 'EXAMPLE_TOKEN',
    endpoints: [{ name: 'api', host: 'api.example.test', port: 443, binaries: ['/usr/bin/curl'] }],
  };
  const refresh = {
    strategy: 'oauth2_client_credentials' as const,
    tokenUrl: 'https://auth.example.test/token',
    scopes: [],
  };

  it('returns only an exact single configured refresh shape', () => {
    expect(readDelegatedRefreshShape({ providerAccessShapes: [shape] }, shape.id)).toBeUndefined();
    expect(readDelegatedRefreshShape(undefined, shape.id)).toBeUndefined();
    const configured = { ...shape, refresh };
    expect(readDelegatedRefreshShape({ providerAccessShapes: [configured] }, shape.id)).toEqual({
      shape: configured,
      refresh,
    });
    expect(
      readDelegatedRefreshShape({ providerAccessShapes: [configured, configured] }, shape.id)
    ).toBeUndefined();
    expect(
      readDelegatedRefreshShape({ providerAccessShapes: [configured] }, 'other')
    ).toBeUndefined();
  });

  it('blocks the rotating strategy before any effect and admits the others', () => {
    expect(() =>
      assertDelegatedRefreshStrategyAvailable({ ...refresh, strategy: 'oauth2_refresh_token' })
    ).toThrow(expect.objectContaining({ code: 'credential_delegation_blocked', status: 409 }));
    expect(() => assertDelegatedRefreshStrategyAvailable(refresh)).not.toThrow();
    expect(() =>
      assertDelegatedRefreshStrategyAvailable({
        ...refresh,
        strategy: 'google_service_account_jwt',
        scopes: ['scope'],
      })
    ).not.toThrow();
  });
});
