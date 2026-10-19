import { allocateEntityId, isEntityId } from '@openkit/protocol';
import type { CoreMode } from '../config/mode.js';
import type { CoreDb } from '../storage/db.js';
import { ensureUserLayout } from '../storage/fs-layout.js';
import { users } from '../storage/schema/index.js';
import type { OpenKitAccessTokenScope } from './access-token.js';

/**
 * Request actor used by the NanoCore auth facade.
 */
export interface Actor {
  /** Stable user id for request ownership. */
  userId: string;
  /** Actor source kind. */
  kind: 'local' | 'session' | 'token';
  /** Canonical browser authentication-session record id when supplied by authentication. */
  sessionId?: string;
  /** Durable token id when the actor authenticated with an OpenKit access token. */
  tokenId?: string;
  /** Access-token scope when the actor authenticated with an OpenKit access token. */
  tokenScope?: OpenKitAccessTokenScope;
  /** Workspace ids bound to the authenticating token. */
  tokenWorkspaceIds?: string[];
  /** Non-secret selected or default server-admin token id for derived session administration. */
  adminTokenId?: string;
}

/**
 * Checks whether one actor may administer deployment-wide state.
 *
 * @param actor Authenticated or implicit request actor.
 * @returns True for the local actor, a server-admin bearer token, or a session that currently carries a resolved admin token id.
 */
export function isDeploymentAdminActor(actor: Actor | undefined): boolean {
  if (!actor) {
    return false;
  }

  if (actor.kind === 'local') {
    return true;
  }

  if (actor.kind === 'token' && actor.tokenScope === 'server-admin') {
    return true;
  }

  return actor.kind === 'session' && Boolean(actor.adminTokenId);
}

/**
 * Resolves the request actor for the current auth mode.
 *
 * @param _request HTTP request being authenticated.
 * @param mode Resolved NanoCore runtime mode.
 * @returns Local actor in local mode.
 */
export function actorFromRequest(_request: Request, mode: CoreMode, localUserId: string): Actor {
  if (mode !== 'local' || !isEntityId('usr', localUserId)) {
    throw new Error('Canonical local User authority is unavailable.');
  }
  return { userId: localUserId, kind: 'local' };
}

/**
 * Minimal Better Auth session shape needed by the identity facade.
 */
export interface AuthSessionIdentity {
  /** Non-secret session record identity, separate from its cookie or bearer value. */
  session?: { id: string };
  /** Better Auth user payload. */
  user: {
    /** Authenticated user id. */
    id: string;
  };
}

/**
 * Converts a Better Auth session payload into the internal actor shape.
 *
 * @param session Better Auth session payload.
 * @returns Session actor used by product code.
 */
export function actorFromSession(session: AuthSessionIdentity): Actor {
  if (!isEntityId('usr', session.user.id))
    throw new Error('Canonical session User authority is unavailable.');
  return {
    userId: session.user.id,
    kind: 'session',
    ...(isEntityId('auth', session.session?.id) ? { sessionId: session.session!.id } : {}),
  };
}

/** Reads the unique recorded local User without creating or changing its lifecycle. */
export function getLocalUserId(coreDb: CoreDb): string {
  const users = coreDb.sqlite.prepare("SELECT id FROM users WHERE kind = 'local'").all() as Array<{
    id: string;
  }>;
  if (users.length !== 1 || !isEntityId('usr', users[0]?.id)) {
    throw new Error('Canonical local User authority is missing or ambiguous.');
  }
  return users[0]!.id;
}

/**
 * Initializes one canonical local User only within the proved fresh deployment transaction.
 * Reopen, updates and disabled state retain the recorded identity; an empty used lookup never remints.
 */
export function ensureLocalUser(coreDb: CoreDb): string {
  const id = coreDb.sqlite.transaction(() => {
    const existing = coreDb.sqlite.prepare("SELECT id FROM users WHERE kind = 'local'").all();
    if (existing.length > 0) return getLocalUserId(coreDb);
    const count = coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get() as {
      count: number;
    };
    if (!coreDb.canInitializeLocalUser || count.count !== 0) {
      throw new Error('Missing local User on an initialized deployment requires inspection.');
    }
    const now = new Date();
    const id = allocateEntityId('usr');
    coreDb.db
      .insert(users)
      .values({
        id,
        kind: 'local',
        displayName: 'Local User',
        email: 'local@local.openkit.invalid',
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now.toISOString(),
      })
      .run();
    return id;
  })();
  coreDb.canInitializeLocalUser = false;
  ensureUserLayout(coreDb.dataRoot, id);
  return id;
}
