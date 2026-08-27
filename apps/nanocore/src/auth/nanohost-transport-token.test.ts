import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  createOpenKitAccessTokenSecret,
  hashOpenKitAccessTokenSecret,
  verifyOpenKitAccessTokenSecret,
} from './access-token.js';
import {
  evaluateNanoHostTransportTokenUsability,
  NANOHOST_TRANSPORT_TOKEN_SCOPE,
  NANOHOST_TRANSPORT_TOKEN_TYPE,
} from './nanohost-transport-token.js';

/**
 * S-2b-1 Unit 2 red: NanoHost transport token class helpers.
 *
 * Contract: `docs/specs/20260802-nanohost_runtime_and_transport.md` requires a
 * dedicated `nanohost-transport` Token class that reuses `okt_` create/hash/verify
 * from `access-token.ts` and must not admit human remote-access scopes.
 *
 * Prefer fail-on-absence: this file imports `./nanohost-transport-token.js`, which
 * does not exist yet. Do not implement the production module here.
 */
describe('NanoHost transport token class', () => {
  it('imports okt_ create/hash/verify helpers from access-token.ts', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'nanohost-transport-token.ts'),
      'utf8'
    );

    expect(source).toMatch(/from ['"]\.\/access-token\.js['"]/);
    expect(source).toContain('createOpenKitAccessTokenSecret');
    expect(source).toContain('hashOpenKitAccessTokenSecret');
    expect(source).toContain('verifyOpenKitAccessTokenSecret');
  });

  it('exposes closed nanohost-transport type and scope, not human scopes', () => {
    expect(NANOHOST_TRANSPORT_TOKEN_TYPE).toBe('nanohost-transport');
    expect(NANOHOST_TRANSPORT_TOKEN_SCOPE).toBe('nanohost-transport');
    expect(NANOHOST_TRANSPORT_TOKEN_TYPE).not.toBe('server-admin');
    expect(NANOHOST_TRANSPORT_TOKEN_SCOPE).not.toBe('workspace');
    expect(NANOHOST_TRANSPORT_TOKEN_SCOPE).not.toBe('workspace-readonly');
  });

  it('evaluates usability for the nanohost-transport class', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');

    expect(
      evaluateNanoHostTransportTokenUsability(
        {
          expiresAt: '2026-08-09T00:00:00.000Z',
          status: 'active',
        },
        now
      )
    ).toEqual({ usable: true });
    expect(
      evaluateNanoHostTransportTokenUsability(
        {
          expiresAt: '2026-08-07T00:00:00.000Z',
          status: 'active',
        },
        now
      )
    ).toEqual({ reason: 'expired', usable: false });
  });

  it('relies on okt_ secret hashing that does not echo the secret', () => {
    const secret = createOpenKitAccessTokenSecret();
    const hash = hashOpenKitAccessTokenSecret(secret);

    expect(secret).toMatch(/^okt_/);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hash).not.toContain(secret);
    expect(verifyOpenKitAccessTokenSecret(secret, hash)).toBe(true);
  });
});
