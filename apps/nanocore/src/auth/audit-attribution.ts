import type { AuditEvent } from '@openkit/protocol';
import type { Actor } from './identity.js';

/** Keeps authentication method and the presented Token or canonical browser session record id, never credential material. */
export function auditAuthenticationFromActor(
  actor: Actor
): NonNullable<AuditEvent['authentication']> {
  return {
    credentialKind: actor.kind,
    credentialId:
      actor.kind === 'token'
        ? (actor.tokenId ?? null)
        : actor.kind === 'session'
          ? (actor.sessionId ?? actor.adminTokenId ?? null)
          : null,
  };
}
