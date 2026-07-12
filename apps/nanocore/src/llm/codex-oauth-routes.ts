import {
  CancelOpenAICodexOAuthRequestSchema,
  CodexOAuthAccountSummarySchema,
  CodexOAuthAccountsPayloadSchema,
  CodexOAuthStatusPayloadSchema,
  CreateOpenAICodexOAuthAccountRequestSchema,
  StartOpenAICodexOAuthRequestSchema,
  UpdateOpenAICodexOAuthAccountRequestSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError, asInvalidRequestError } from '../api-errors.js';
import { isDeploymentAdminActor } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { registerAppApiRoute } from '../openapi.js';
import type { CodexOAuthAccountManager } from './codex-oauth-accounts.js';

/**
 * Requires deployment-admin authority for server-owned Codex OAuth state.
 *
 * @param c Hono context carrying the authenticated actor.
 * @returns Error response when the actor lacks deployment-admin authority.
 */
function requireCodexOAuthAdminActor(c: Context<{ Variables: AuthVariables }>): Response | null {
  return isDeploymentAdminActor(c.get('actor'))
    ? null
    : asApiError('Server-admin authority is required.', 'codex_oauth_admin_forbidden', 403);
}

/**
 * Registers Codex OAuth account inventory and metadata routes.
 *
 * @param app NanoCore Hono app.
 * @param codexOAuthAccountManager Account-slot owner.
 */
export function registerCodexOAuthAccountRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  codexOAuthAccountManager: CodexOAuthAccountManager
): void {
  registerAppApiRoute(app, 'listOpenAICodexOAuthAccounts', async (c) => {
    const adminError = requireCodexOAuthAdminActor(c);

    return (
      adminError ??
      c.json(CodexOAuthAccountsPayloadSchema.parse(await codexOAuthAccountManager.listAccounts()))
    );
  });

  registerAppApiRoute(app, 'createOpenAICodexOAuthAccount', async (c) => {
    const adminError = requireCodexOAuthAdminActor(c);
    if (adminError) {
      return adminError;
    }

    const parsed = CreateOpenAICodexOAuthAccountRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      return c.json(
        CodexOAuthAccountSummarySchema.parse(
          await codexOAuthAccountManager.createAccount({
            accountSlotId: parsed.data.accountSlotId,
            ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
          })
        )
      );
    } catch (error) {
      const message = (error as Error).message;

      if (message.startsWith('Codex OAuth account slot already exists:')) {
        return asApiError(message, 'codex_oauth_account_exists', 409);
      }

      return asApiError(message, 'codex_oauth_account_create_failed', 400);
    }
  });

  registerAppApiRoute(app, 'updateOpenAICodexOAuthAccount', async (c) => {
    const adminError = requireCodexOAuthAdminActor(c);
    if (adminError) {
      return adminError;
    }

    const parsed = UpdateOpenAICodexOAuthAccountRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      return c.json(
        CodexOAuthAccountSummarySchema.parse(
          await codexOAuthAccountManager.updateAccount(c.req.param('accountSlotId'), parsed.data)
        )
      );
    } catch (error) {
      return asApiError((error as Error).message, 'codex_oauth_account_update_failed', 400);
    }
  });

  registerAppApiRoute(app, 'deleteOpenAICodexOAuthAccount', async (c) => {
    const adminError = requireCodexOAuthAdminActor(c);
    if (adminError) {
      return adminError;
    }

    try {
      await codexOAuthAccountManager.deleteAccount(c.req.param('accountSlotId'));
      return c.body(null, 204);
    } catch (error) {
      return asApiError((error as Error).message, 'codex_oauth_account_delete_failed', 400);
    }
  });

  registerAppApiRoute(app, 'getOpenAICodexOAuthAccountStatus', async (c) => {
    const adminError = requireCodexOAuthAdminActor(c);

    return (
      adminError ??
      c.json(
        CodexOAuthStatusPayloadSchema.parse(
          await codexOAuthAccountManager.getStatus(c.req.param('accountSlotId'))
        )
      )
    );
  });
}

/**
 * Registers Codex OAuth login lifecycle routes.
 *
 * @param app NanoCore Hono app.
 * @param codexOAuthAccountManager Account-slot owner.
 */
export function registerCodexOAuthLoginRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  codexOAuthAccountManager: CodexOAuthAccountManager
): void {
  registerAppApiRoute(app, 'startOpenAICodexOAuthAccountLogin', async (c) => {
    const adminError = requireCodexOAuthAdminActor(c);
    if (adminError) {
      return adminError;
    }

    const parsed = StartOpenAICodexOAuthRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    return c.json(
      CodexOAuthStatusPayloadSchema.parse(
        await codexOAuthAccountManager.start(
          c.req.param('accountSlotId'),
          parsed.data.mode ?? 'browser'
        )
      )
    );
  });

  registerAppApiRoute(app, 'cancelOpenAICodexOAuthAccountLogin', async (c) => {
    const adminError = requireCodexOAuthAdminActor(c);
    if (adminError) {
      return adminError;
    }

    const parsed = CancelOpenAICodexOAuthRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    return c.json(
      CodexOAuthStatusPayloadSchema.parse(
        await codexOAuthAccountManager.cancel(c.req.param('accountSlotId'), parsed.data.loginId)
      )
    );
  });

  registerAppApiRoute(app, 'logoutOpenAICodexOAuthAccount', async (c) => {
    const adminError = requireCodexOAuthAdminActor(c);

    return (
      adminError ??
      c.json(
        CodexOAuthStatusPayloadSchema.parse(
          await codexOAuthAccountManager.logout(c.req.param('accountSlotId'))
        )
      )
    );
  });
}
