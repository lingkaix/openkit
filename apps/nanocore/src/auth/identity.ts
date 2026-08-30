import type { CoreMode } from '../config/mode.js';
import type { CoreDb } from '../storage/db.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
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
export function actorFromRequest(_request: Request, mode: CoreMode): Actor {
  if (mode === 'local') {
    return { userId: LOCAL_USER_ID, kind: 'local' };
  }

  return { userId: LOCAL_USER_ID, kind: 'session' };
}

/**
 * Minimal Better Auth session shape needed by the identity facade.
 */
export interface AuthSessionIdentity {
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
  return { userId: session.user.id, kind: 'session' };
}

/**
 * Upserts the implicit local user into the server-scope Core SQLite database.
 *
 * @param coreDb Open Core database handles.
 */
export function ensureLocalUser(coreDb: CoreDb): void {
  const now = new Date();
  const nowIso = now.toISOString();

  coreDb.db
    .insert(users)
    .values({
      id: LOCAL_USER_ID,
      kind: 'local',
      displayName: 'Local User',
      email: 'user_local@local.openkit.invalid',
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: nowIso,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        kind: 'local',
        displayName: 'Local User',
        email: 'user_local@local.openkit.invalid',
        emailVerified: false,
        image: null,
        updatedAt: now,
        lastSeenAt: nowIso,
      },
    })
    .run();
}
