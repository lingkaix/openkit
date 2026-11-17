import { describe, expect, it } from 'vitest';
import { GatewayConfigSchema } from './gateway.js';
import {
  BLOCKED_DELEGATED_REFRESH_STRATEGIES,
  DELEGATED_REFRESH_MATERIAL_KEYS,
  requireDelegatedRefreshMaterial,
  StaticProviderAccessShapeSchema,
} from './provider-access-shapes.js';

const shape = {
  id: 'example-api',
  credentialKey: 'EXAMPLE_TOKEN',
  endpoints: [{ name: 'api', host: 'api.example.test', port: 443, binaries: ['/usr/bin/curl'] }],
};
const refresh = {
  strategy: 'oauth2_client_credentials',
  tokenUrl: 'https://auth.example.test/oauth/token',
  scopes: ['read'],
};

describe('Provider access-shape delegated refresh intent', () => {
  it('keeps static shapes valid and accepts each configured strategy', () => {
    expect(StaticProviderAccessShapeSchema.parse(shape)).toEqual(shape);
    for (const strategy of Object.keys(DELEGATED_REFRESH_MATERIAL_KEYS))
      expect(
        StaticProviderAccessShapeSchema.parse({ ...shape, refresh: { ...refresh, strategy } })
          .refresh?.strategy
      ).toBe(strategy);
  });

  it.each([
    ['http token URL', { tokenUrl: 'http://auth.example.test/token' }],
    // Built at runtime so no URL with embedded userinfo appears in source.
    [
      'userinfo',
      {
        tokenUrl: Object.assign(new URL('https://auth.example.test/token'), { username: 'u' }).href,
      },
    ],
    ['query', { tokenUrl: 'https://auth.example.test/token?a=1' }],
    ['empty query marker', { tokenUrl: 'https://auth.example.test/token?' }],
    ['fragment', { tokenUrl: 'https://auth.example.test/token#x' }],
    ['padded URL', { tokenUrl: ' https://auth.example.test/token' }],
    ['control character', { tokenUrl: 'https://auth.example.test/to\nken' }],
    ['oversized URL', { tokenUrl: `https://auth.example.test/${'a'.repeat(2048)}` }],
    ['not a URL', { tokenUrl: 'auth.example.test/token' }],
    ['unknown strategy', { strategy: 'static' }],
    ['empty scope', { scopes: [''] }],
    ['control scope', { scopes: ['a\u0000'] }],
    ['too many scopes', { scopes: Array.from({ length: 65 }, (_, index) => `s${index}`) }],
    ['JWT without scope', { strategy: 'google_service_account_jwt', scopes: [] }],
    ['unknown member', { material: { client_secret: 'x' } }],
  ])('refuses %s', (_name, change) => {
    expect(
      StaticProviderAccessShapeSchema.safeParse({ ...shape, refresh: { ...refresh, ...change } })
        .success
    ).toBe(false);
  });

  // rc.9-to-stable freeze: an rc.9-shape config, without `refresh`, admits byte-identically.
  it('admits an rc.9-shape gateway config byte-identically', () => {
    // Canonical member order, as rc.9 already re-emits endpoints in schema order.
    const rc9Shape = {
      ...shape,
      endpoints: [
        { binaries: ['/usr/bin/curl'], host: 'api.example.test', name: 'api', port: 443 },
      ],
    };
    const rc9 = JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      logicalModels: [],
      providerAccessShapes: [rc9Shape],
      requiredFeatures: [],
    });
    expect(JSON.stringify(GatewayConfigSchema.parse(JSON.parse(rc9)))).toBe(rc9);
    expect(JSON.stringify(StaticProviderAccessShapeSchema.parse(rc9Shape))).toBe(
      JSON.stringify(rc9Shape)
    );
  });

  it('blocks only the strategy whose rotated family is unrecoverable', () => {
    expect(BLOCKED_DELEGATED_REFRESH_STRATEGIES).toEqual(['oauth2_refresh_token']);
  });
});

describe('Delegated refresh material keys', () => {
  it('returns exact required and optional keys', () => {
    expect(
      requireDelegatedRefreshMaterial(
        'oauth2_client_credentials',
        JSON.stringify({ client_id: 'id', client_secret: 'FAKE_secret' })
      )
    ).toEqual({ client_id: 'id', client_secret: 'FAKE_secret' });
    expect(
      requireDelegatedRefreshMaterial(
        'google_service_account_jwt',
        JSON.stringify({ client_email: 'svc', private_key: 'FAKE_key', subject: 'user' })
      )
    ).toEqual({ client_email: 'svc', private_key: 'FAKE_key', subject: 'user' });
  });

  it.each([
    ['missing required key', { client_id: 'id' }],
    ['undeclared key', { client_id: 'id', client_secret: 'FAKE_secret', refresh_token: 'x' }],
    ['empty value', { client_id: 'id', client_secret: '' }],
    ['non-string value', { client_id: 'id', client_secret: 1 }],
    ['oversized value', { client_id: 'id', client_secret: 'a'.repeat(1024 * 1024 + 1) }],
    ['array', ['client_id', 'client_secret']],
    ['null', null],
  ])('refuses %s without echoing material', (_name, value) => {
    let failure: unknown;
    try {
      requireDelegatedRefreshMaterial('oauth2_client_credentials', JSON.stringify(value));
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toBe('Error: Delegated refresh material does not match its strategy.');
  });

  it('refuses non-JSON material without echoing it', () => {
    expect(() =>
      requireDelegatedRefreshMaterial('oauth2_client_credentials', 'FAKE_raw-secret')
    ).toThrow(new Error('Delegated refresh material does not match its strategy.'));
  });
});
