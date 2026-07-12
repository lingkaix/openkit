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

/**
 * Checks whether one authenticated actor is an active workspace member.
 */
type WorkspaceMembershipVerifier = (
  actor: Actor,
  workspaceId: string
) => boolean | Promise<boolean>;

/**
 * Optional auth middleware dependencies.
 */
interface AuthMiddlewareOptions {
  /** Verifier for OpenKit `okt_` bearer tokens. */
  accessTokenVerifier?: AccessTokenVerifier;
  /** Verifier for authenticated-actor workspace membership. */
  workspaceMembershipVerifier?: WorkspaceMembershipVerifier;
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
      c.set('actor', actorFromRequest(c.req.raw, mode));
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
      const scopeError = await tokenScopeViolation(
        c.req.method,
        c.req.path,
        c.req.raw,
        c.get('actor'),
        options.workspaceMembershipVerifier
      );
      if (scopeError) {
        return scopeForbidden(c);
      }

      await next();
      return;
    }

    const session = await auth?.api.getSession({ headers: c.req.raw.headers });

    if (!session) {
      return unauthorized(c);
    }

    const actor = actorFromSession(session);
    c.set('actor', actor);
    const workspaceId =
      workspaceIdFromPath(c.req.path) ?? (await workspaceIdFromJsonBody(c.req.raw));
    if (
      workspaceId &&
      (!options.workspaceMembershipVerifier ||
        !(await options.workspaceMembershipVerifier(actor, workspaceId)))
    ) {
      return scopeForbidden(c);
    }

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
 * Checks coarse token scope before product route handling.
 *
 * @param method HTTP method.
 * @param path Request path.
 * @param request HTTP request.
 * @param actor Authenticated token actor.
 * @param workspaceMembershipVerifier Optional token-owner membership verifier.
 * @returns True when the route is outside the token scope.
 */
async function tokenScopeViolation(
  method: string,
  path: string,
  request: Request,
  actor: Actor,
  workspaceMembershipVerifier?: WorkspaceMembershipVerifier
): Promise<boolean> {
  if (actor.kind !== 'token' || actor.tokenScope === 'server-admin') {
    return false;
  }

  const workspaceId = workspaceIdFromPath(path) ?? (await workspaceIdFromJsonBody(request));
  if (!workspaceId) {
    return !isReadMethod(method);
  }

  if (!actor.tokenWorkspaceIds?.includes(workspaceId)) {
    return true;
  }

  if (!workspaceMembershipVerifier || !(await workspaceMembershipVerifier(actor, workspaceId))) {
    return true;
  }

  return actor.tokenScope === 'workspace-readonly' && !isReadMethod(method);
}

/**
 * Extracts a product workspace id from NanoCore public paths.
 *
 * @param path Request path.
 * @returns Workspace id when the path targets a workspace.
 */
function workspaceIdFromPath(path: string): string | null {
  const match = /^\/api\/(?:app\/)?workspaces\/([^/]+)/.exec(path);
  return match ? decodeURIComponent(match[1] ?? '') : null;
}

/**
 * Extracts a route-owned workspace id from a JSON request body without consuming it.
 *
 * @param request HTTP request.
 * @returns Workspace id when the body names one.
 */
async function workspaceIdFromJsonBody(request: Request): Promise<string | null> {
  if (!request.body) {
    return null;
  }

  const payload = await request
    .clone()
    .json()
    .catch(() => null);

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const workspaceId = record.workspaceId;

  if (!new URL(request.url).pathname.startsWith('/v1/')) {
    return typeof workspaceId === 'string' && workspaceId.length > 0 ? workspaceId : null;
  }

  const metadata = record.metadata;
  const openkit =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).openkit
      : null;
  const gatewayWorkspaceId =
    openkit && typeof openkit === 'object' && !Array.isArray(openkit)
      ? (openkit as Record<string, unknown>).workspaceId
      : null;

  if (typeof gatewayWorkspaceId === 'string' && gatewayWorkspaceId.length > 0) {
    return gatewayWorkspaceId;
  }

  return typeof workspaceId === 'string' && workspaceId.length > 0 ? workspaceId : null;
}

/**
 * Checks whether one HTTP method is read-only at the auth-scope layer.
 *
 * @param method HTTP method.
 * @returns True for read-only methods.
 */
function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
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

/**
 * Creates a uniform scope failure without revealing target resource existence.
 *
 * @param c Hono context.
 * @returns JSON response.
 */
function scopeForbidden(c: Parameters<MiddlewareHandler>[0]) {
  return c.json(
    ApiErrorSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      code: 'core.auth.scope_forbidden',
      message: 'Actor scope does not allow this request.',
    }),
    403
  );
}
