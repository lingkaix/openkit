import {
  ConsumeOpenKitBootstrapTokenRequestSchema,
  ConsumeOpenKitBootstrapTokenResponseSchema,
  CreateOpenKitAccessTokenRequestSchema,
  CreateOpenKitAccessTokenResponseSchema,
  ListOpenKitAccessTokensResponseSchema,
  RevokeOpenKitAccessTokenResponseSchema,
  RotateOpenKitAccessTokenRequestSchema,
  RotateOpenKitAccessTokenResponseSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError } from '../api-errors.js';
import { recordServerAuditEvent } from '../audit-events.js';
import type { CoreMode } from '../config/mode.js';
import { registerAppApiRoute } from '../openapi.js';
import type { CoreDb } from '../storage/db.js';
import {
  createOpenKitAccessTokenRecord,
  listOpenKitAccessTokenRecords,
  type OpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
  rotateOpenKitAccessTokenRecord,
} from './access-token-store.js';
import { consumeServerBootstrapToken } from './bootstrap-token.js';
import type { AuthVariables } from './middleware.js';

/**
 * Registers server bootstrap and OpenKit access-token lifecycle routes.
 *
 * @param dependencies Access-token dependencies owned by the app composition root.
 */
export function registerAccessTokenRoutes({
  app,
  coreDb,
  isActiveWorkspaceMember,
  mode,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly isActiveWorkspaceMember: (userId: string, workspaceId: string) => boolean;
  readonly mode: CoreMode;
}): void {
  /**
   * Checks whether the current actor can administer OpenKit access tokens.
   *
   * @param c Hono context carrying the actor variable.
   * @returns Error response when access should be denied.
   */
  function requireAccessTokenAdmin(c: Context<{ Variables: AuthVariables }>): Response | null {
    if (mode !== 'server') {
      return asApiError(
        'Access-token administration is only available in server mode.',
        'access_token_admin_server_mode_required',
        404
      );
    }

    if (!coreDb) {
      return asApiError(
        'Access-token storage is unavailable.',
        'access_token_storage_unavailable',
        503
      );
    }

    const actor = c.get('actor');
    if (actor?.kind !== 'token' || actor.tokenScope !== 'server-admin') {
      return asApiError('Server-admin token required.', 'access_token_admin_forbidden', 403);
    }

    return null;
  }

  /**
   * Records a server audit event for one successful access-token lifecycle operation.
   *
   * @param coreDb Server database that owns the event.
   * @param action Stable access-token lifecycle action.
   * @param record Redacted access-token record affected by the operation.
   * @param actorUserId User id that requested the operation when authenticated.
   */
  function recordAccessTokenLifecycleAuditEvent(
    coreDb: CoreDb,
    action:
      | 'auth.bootstrap.consume'
      | 'auth.token.issue'
      | 'auth.token.revoke'
      | 'auth.token.rotate',
    record: OpenKitAccessTokenRecord,
    actorUserId: string | null
  ): void {
    const actorSuffix = actorUserId ? ` Requested by ${actorUserId}.` : '';
    let summary: string;
    switch (action) {
      case 'auth.bootstrap.consume':
        summary = `Bootstrap token consumed for owner ${record.ownerUserId}.${actorSuffix}`;
        break;
      case 'auth.token.issue':
        summary = `Access token ${record.tokenId} issued with ${record.scope} scope for ${record.ownerUserId}.${actorSuffix}`;
        break;
      case 'auth.token.revoke':
        summary = `Access token ${record.tokenId} revoked.${actorSuffix}`;
        break;
      case 'auth.token.rotate':
        summary = `Access token ${record.predecessorTokenId ?? record.tokenId} rotated to ${record.tokenId}.${actorSuffix}`;
        break;
    }

    recordServerAuditEvent({
      action,
      category: 'system',
      coreDb,
      outcome: 'succeeded',
      resource: `auth-token:${record.tokenId}`,
      severity: 'info',
      summary,
    });
  }

  registerAppApiRoute(app, 'consumeOpenKitBootstrapToken', async (c) => {
    if (mode !== 'server') {
      return asApiError('Server bootstrap is only available in server mode.', 'not_found', 404);
    }

    if (!coreDb) {
      return asApiError('Server bootstrap storage is unavailable.', 'bootstrap_unavailable', 503);
    }

    const parsed = ConsumeOpenKitBootstrapTokenRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asApiError('Invalid bootstrap consume request.', 'invalid_request', 400);
    }

    const consumed = consumeServerBootstrapToken(coreDb, {
      displayName: parsed.data.displayName,
      ownerUserId: parsed.data.ownerUserId,
      token: parsed.data.token,
      tokenExpiresAt: parsed.data.tokenExpiresAt,
    });

    if (consumed.status !== 'consumed') {
      return consumed.status === 'unavailable'
        ? asApiError('Server bootstrap is unavailable.', 'bootstrap_unavailable', 409)
        : asApiError('Invalid bootstrap token.', 'bootstrap_invalid', 401);
    }

    recordAccessTokenLifecycleAuditEvent(coreDb, 'auth.bootstrap.consume', consumed.record, null);

    return c.json(
      ConsumeOpenKitBootstrapTokenResponseSchema.parse({
        record: consumed.record,
        token: consumed.secret,
      }),
      201
    );
  });

  registerAppApiRoute(app, 'listOpenKitAccessTokens', (c) => {
    const adminError = requireAccessTokenAdmin(c);
    if (adminError) {
      return adminError;
    }

    return c.json(
      ListOpenKitAccessTokensResponseSchema.parse({
        items: listOpenKitAccessTokenRecords(coreDb!),
      })
    );
  });

  registerAppApiRoute(app, 'createOpenKitAccessToken', async (c) => {
    const adminError = requireAccessTokenAdmin(c);
    if (adminError) {
      return adminError;
    }

    const parsed = CreateOpenKitAccessTokenRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asApiError('Invalid access-token issue request.', 'invalid_request', 400);
    }

    try {
      const ownerUserId = c.get('actor')?.userId ?? 'user_local';
      if (
        parsed.data.scope !== 'server-admin' &&
        parsed.data.workspaceIds.some(
          (workspaceId) => !isActiveWorkspaceMember(ownerUserId, workspaceId)
        )
      ) {
        return asApiError(
          'Access token scope does not allow this request.',
          'core.auth.scope_forbidden',
          403
        );
      }

      const issued = createOpenKitAccessTokenRecord(coreDb!, {
        expiresAt: parsed.data.expiresAt,
        ownerUserId,
        scope: parsed.data.scope,
        workspaceIds: parsed.data.workspaceIds,
      });
      recordAccessTokenLifecycleAuditEvent(
        coreDb!,
        'auth.token.issue',
        issued.record,
        c.get('actor')?.userId ?? null
      );

      return c.json(
        CreateOpenKitAccessTokenResponseSchema.parse({
          record: issued.record,
          token: issued.secret,
        }),
        201
      );
    } catch (error) {
      return asApiError((error as Error).message, 'access_token_issue_failed', 400);
    }
  });

  registerAppApiRoute(app, 'revokeOpenKitAccessToken', (c) => {
    const adminError = requireAccessTokenAdmin(c);
    if (adminError) {
      return adminError;
    }

    const record = revokeOpenKitAccessTokenRecord(coreDb!, c.req.param('tokenId'));
    if (!record) {
      return asApiError('Access token not found.', 'access_token_not_found', 404);
    }

    recordAccessTokenLifecycleAuditEvent(
      coreDb!,
      'auth.token.revoke',
      record,
      c.get('actor')?.userId ?? null
    );

    return c.json(RevokeOpenKitAccessTokenResponseSchema.parse({ record }));
  });

  registerAppApiRoute(app, 'rotateOpenKitAccessToken', async (c) => {
    const adminError = requireAccessTokenAdmin(c);
    if (adminError) {
      return adminError;
    }

    const parsed = RotateOpenKitAccessTokenRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asApiError('Invalid access-token rotation request.', 'invalid_request', 400);
    }

    const rotated = rotateOpenKitAccessTokenRecord(coreDb!, c.req.param('tokenId'), {
      graceSeconds: parsed.data.graceSeconds,
    });
    if (!rotated) {
      return asApiError('Access token not found or not rotatable.', 'access_token_not_found', 404);
    }

    recordAccessTokenLifecycleAuditEvent(
      coreDb!,
      'auth.token.rotate',
      rotated.record,
      c.get('actor')?.userId ?? null
    );

    return c.json(
      RotateOpenKitAccessTokenResponseSchema.parse({
        record: rotated.record,
        rotatedRecord: rotated.rotatedRecord,
        token: rotated.secret,
      })
    );
  });
}
