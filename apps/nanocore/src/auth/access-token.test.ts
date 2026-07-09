import { describe, expect, it } from 'vitest';
import {
  createOpenKitAccessTokenSecret,
  evaluateOpenKitAccessTokenUsability,
  hashOpenKitAccessTokenSecret,
  isOpenKitAccessTokenSecret,
  normalizeOpenKitAccessTokenScope,
  verifyOpenKitAccessTokenSecret,
} from './access-token.js';

describe('OpenKit access token helpers', () => {
  it('generates okt-prefixed URL-safe opaque secrets with at least 256 bits of entropy', () => {
    const token = createOpenKitAccessTokenSecret();
    const second = createOpenKitAccessTokenSecret();

    expect(token).toMatch(/^okt_[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(47);
    expect(second).not.toBe(token);
    expect(isOpenKitAccessTokenSecret(token)).toBe(true);
    expect(isOpenKitAccessTokenSecret('sk-openkit-secret')).toBe(false);
  });

  it('hashes token secrets and verifies them without exposing the secret', () => {
    const token = createOpenKitAccessTokenSecret();
    const hash = hashOpenKitAccessTokenSecret(token);

    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(verifyOpenKitAccessTokenSecret(token, hash)).toBe(true);
    expect(verifyOpenKitAccessTokenSecret(createOpenKitAccessTokenSecret(), hash)).toBe(false);
    expect(verifyOpenKitAccessTokenSecret('not-a-token', hash)).toBe(false);
  });

  it('enforces the closed v1 scope shapes', () => {
    expect(normalizeOpenKitAccessTokenScope('server-admin', [])).toEqual({
      scope: 'server-admin',
      workspaceIds: [],
    });
    expect(normalizeOpenKitAccessTokenScope('workspace-readonly', ['ws_demo'])).toEqual({
      scope: 'workspace-readonly',
      workspaceIds: ['ws_demo'],
    });
    expect(() => normalizeOpenKitAccessTokenScope('server-admin', ['ws_demo'])).toThrow(
      /workspace bindings/
    );
    expect(() => normalizeOpenKitAccessTokenScope('workspace', [])).toThrow(/workspace id/);
  });

  it('evaluates active, expired, revoked, and rotated token records', () => {
    const now = new Date('2026-07-05T00:00:00.000Z');

    expect(
      evaluateOpenKitAccessTokenUsability(
        {
          expiresAt: '2026-07-06T00:00:00.000Z',
          status: 'active',
        },
        now
      )
    ).toEqual({ usable: true });
    expect(
      evaluateOpenKitAccessTokenUsability(
        {
          expiresAt: '2026-07-04T00:00:00.000Z',
          status: 'active',
        },
        now
      )
    ).toEqual({ reason: 'expired', usable: false });
    expect(
      evaluateOpenKitAccessTokenUsability(
        {
          expiresAt: '2026-07-06T00:00:00.000Z',
          status: 'revoked',
        },
        now
      )
    ).toEqual({ reason: 'revoked', usable: false });
    expect(
      evaluateOpenKitAccessTokenUsability(
        {
          expiresAt: '2026-07-06T00:00:00.000Z',
          rotatedGraceExpiresAt: '2026-07-05T00:10:00.000Z',
          status: 'rotated',
        },
        now
      )
    ).toEqual({ usable: true });
    expect(
      evaluateOpenKitAccessTokenUsability(
        {
          expiresAt: '2026-07-06T00:00:00.000Z',
          rotatedGraceExpiresAt: '2026-07-04T00:00:00.000Z',
          status: 'rotated',
        },
        now
      )
    ).toEqual({ reason: 'rotated', usable: false });
  });
});
