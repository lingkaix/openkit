import { isIP } from 'node:net';

import { ApiErrorSchema, PROTOCOL_VERSION } from '@openkit/protocol';
import type { MiddlewareHandler } from 'hono';
import type { CoreMode } from '../config/mode.js';
import {
  type Actor,
  type AuthSessionIdentity,
  actorFromRequest,
  actorFromSession,
} from './identity.js';
import type { WorkspaceAccess } from './operation-authorizer.js';

/**
 * Minimal Better Auth server surface used by NanoCore middleware.
 */
export interface BetterAuthServer {
  /** Better Auth API helpers. */
  api: {
    /** Validates request headers and returns the active session if present. */
    getSession: (context: { headers: Headers }) => Promise<AuthSessionIdentity | null>;
  };
  /** Better Auth route handler for /api/auth/*. */
  handler: (request: Request) => Promise<Response>;
}

/**
 * Hono variable shape installed by the auth middleware.
 */
export interface AuthVariables {
  /** Authenticated or implicit request actor. */
  actor: Actor;
  /** Optional centralized Workspace authorization result for the current operation. */
  workspaceAccess?: WorkspaceAccess;
}

/**
 * Verified bearer access token result.
 */
interface AccessTokenVerification {
  /** Durable token id. */
  tokenId: string;
  /** Request actor resolved from the token owner. */
  actor: Actor;
}

/**
 * Verifies a presented bearer token secret.
 */
type AccessTokenVerifier = (
  secret: string,
  request: Request
) => AccessTokenVerification | null | Promise<AccessTokenVerification | null>;

/** Checks whether one canonical user may authenticate. */
type CanonicalUserActiveVerifier = (userId: string) => boolean | Promise<boolean>;

/**
 * Optional auth middleware dependencies.
 */
interface AuthMiddlewareOptions {
  /** Verifier for OpenKit `okt_` bearer tokens. */
  accessTokenVerifier?: AccessTokenVerifier;
  /** Verifier for the canonical lifecycle status of local and session users. */
  canonicalUserActive?: CanonicalUserActiveVerifier;
}

/**
 * Creates the NanoCore auth facade middleware.
 *
 * @param mode Resolved NanoCore runtime mode.
 * @param auth Optional Better Auth server.
 * @param options Optional authentication middleware dependencies.
 * @returns Hono middleware that records an actor and continues the request.
 */
export function createAuthMiddleware(
  mode: CoreMode,
  auth?: BetterAuthServer,
  options: AuthMiddlewareOptions = {}
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    if (isPublicRoute(c.req.method, c.req.path)) {
      if (
        mode === 'server' &&
        c.req.method === 'POST' &&
        c.req.path === '/api/app/auth/bootstrap/consume' &&
        !acceptsSecretTransport(c)
      ) {
        return insecureTransport(c);
      }

      await next();
      return;
    }

    if (mode === 'local') {
      const actor = actorFromRequest(c.req.raw, mode);
      if (options.canonicalUserActive && !(await options.canonicalUserActive(actor.userId))) {
        return unauthorized(c);
      }

      c.set('actor', actor);
      await next();
      return;
    }

    const bearerToken = readBearerToken(c.req.raw);
    if (bearerToken) {
      if (!acceptsSecretTransport(c)) {
        return insecureTransport(c);
      }

      const token = await options.accessTokenVerifier?.(bearerToken, c.req.raw);

      if (!token) {
        return unauthorized(c);
      }

      c.set('actor', { ...token.actor, kind: 'token', tokenId: token.tokenId });
      await next();
      return;
    }

    const session = await auth?.api.getSession({ headers: c.req.raw.headers });

    if (!session) {
      return unauthorized(c);
    }

    if (options.canonicalUserActive && !(await options.canonicalUserActive(session.user.id))) {
      return unauthorized(c);
    }

    c.set('actor', actorFromSession(session));
    await next();
  };
}

/**
 * Checks whether a route is public before auth enforcement.
 *
 * @param method HTTP method.
 * @param path Request path.
 * @returns True when the route is public in server mode.
 */
function isPublicRoute(method: string, path: string): boolean {
  if (path.startsWith('/api/auth/')) {
    return true;
  }

  if (method === 'POST' && path === '/api/app/auth/bootstrap/consume') {
    return true;
  }

  return method === 'GET' && (path === '/api/health' || path === '/api/meta');
}

/**
 * Reads the bearer token from a request.
 *
 * @param request HTTP request.
 * @returns Bearer token or null.
 */
function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
}

/**
 * Checks whether one request may carry a plaintext secret credential.
 *
 * @param context Hono request context carrying Node connection bindings in production.
 * @returns True when HTTPS is used or plaintext is loopback-only.
 */
function acceptsSecretTransport(context: Parameters<MiddlewareHandler>[0]): boolean {
  const env = context.env as
    | {
        incoming?: unknown;
        server?: { incoming?: unknown };
      }
    | undefined;
  const incoming = env?.incoming ?? env?.server?.incoming;

  if (incoming !== undefined) {
    const socket = (
      incoming as {
        socket?: {
          encrypted?: boolean;
          remoteAddress?: string;
        };
      } | null
    )?.socket;

    if (!socket) {
      return false;
    }

    return socket.encrypted === true || isLoopbackHost(socket.remoteAddress ?? '');
  }

  const url = new URL(context.req.url);
  if (url.protocol === 'https:') {
    return true;
  }

  if (url.protocol !== 'http:') {
    return false;
  }

  return isLoopbackHost(url.hostname);
}

/**
 * Checks whether a hostname is loopback.
 *
 * @param hostname URL hostname.
 * @returns True for localhost, IPv4 127/8, or IPv6 loopback.
 */
export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');

  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }

  if (normalized.startsWith('::ffff:')) {
    return isLoopbackHost(normalized.slice('::ffff:'.length));
  }

  return isIP(normalized) === 4 && normalized.split('.')[0] === '127';
}

/**
 * Creates a uniform auth failure response without echoing credential material.
 *
 * @param c Hono context.
 * @returns JSON response.
 */
function unauthorized(c: Parameters<MiddlewareHandler>[0]) {
  return c.json(
    ApiErrorSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      code: 'core.auth.unauthenticated',
      message: 'Authentication required.',
    }),
    401
  );
}

/**
 * Creates a transport failure response without verifying or echoing credential material.
 *
 * @param c Hono context.
 * @returns JSON response.
 */
function insecureTransport(c: Parameters<MiddlewareHandler>[0]) {
  return c.json(
    ApiErrorSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      code: 'core.auth.insecure_transport',
      message: 'Bearer token authentication requires HTTPS outside loopback.',
    }),
    400
  );
}
