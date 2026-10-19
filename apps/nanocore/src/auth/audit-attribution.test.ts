import { describe, expect, it } from 'vitest';
import { testEntityId } from '../test-support/entity-ids.js';
import { auditAuthenticationFromActor } from './audit-attribution.js';

describe('Audit authentication attribution', () => {
  it('records the presented or derived credential identity without inventing a session id', () => {
    const userId = testEntityId('usr', 'audit-operator');
    const tokenId = testEntityId('tok', 'audit-presented');
    const sessionId = testEntityId('auth', 'audit-session');
    expect(
      auditAuthenticationFromActor({ userId, kind: 'session', sessionId, adminTokenId: tokenId })
    ).toEqual({ credentialKind: 'session', credentialId: sessionId });
    expect(auditAuthenticationFromActor({ userId, kind: 'local' })).toEqual({
      credentialKind: 'local',
      credentialId: null,
    });
    expect(auditAuthenticationFromActor({ userId, kind: 'session' })).toEqual({
      credentialKind: 'session',
      credentialId: null,
    });
    expect(
      auditAuthenticationFromActor({ userId, kind: 'session', adminTokenId: tokenId })
    ).toEqual({ credentialKind: 'session', credentialId: tokenId });
    expect(
      auditAuthenticationFromActor({ userId, kind: 'token', tokenId, tokenScope: 'server-admin' })
    ).toEqual({ credentialKind: 'token', credentialId: tokenId });
  });
});
