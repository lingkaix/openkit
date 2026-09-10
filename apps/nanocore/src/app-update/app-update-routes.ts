import {
  AppUpdateStatusResponseSchema,
  PrepareAppUpdateRequestSchema,
  PrepareAppUpdateResponseSchema,
  StartAppUpdateRequestSchema,
} from '@openkit/app-api-schemas';
import type { Hono } from 'hono';

import { asApiError, asInvalidRequestError } from '../api-errors.js';
import { recordServerAuditEvent } from '../audit-events.js';
import { isDeploymentAdminActor } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { registerAppApiRoute } from '../openapi.js';
import type { CoreDb } from '../storage/db.js';
import type { AppUpdateHostCommand } from './host-request.js';
import type { AppUpdateHostResult, AppUpdateHostTransport } from './host-transport.js';

const HOST_ERROR_STATUS: Record<string, number> = {
  app_update_busy: 409,
  app_update_capacity: 409,
  app_update_expired: 409,
  app_update_invalid_request: 400,
  app_update_not_found: 404,
  app_update_recovery_required: 409,
  app_update_unconfigured: 503,
  app_update_unavailable: 503,
};

/**
 * Registers the administrator App-update prepare, start, and status routes.
 *
 * @param input Route dependencies captured from boot configuration.
 */
export function registerAppUpdateRoutes(input: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb?: CoreDb;
  readonly transport: AppUpdateHostTransport | null;
}): void {
  const { app, coreDb, transport } = input;

  /**
   * Requires deployment-admin authority for App-update operations.
   *
   * @param actor Request actor.
   * @returns Forbidden response when the actor is not a deployment admin.
   */
  function requireAdmin(actor: AuthVariables['actor']): ReturnType<typeof asApiError> | null {
    return isDeploymentAdminActor(actor)
      ? null
      : asApiError('Server-admin authority is required.', 'app_update_forbidden', 403);
  }

  /**
   * Invokes the boot-bound helper or reports that the capability is absent.
   *
   * @param command Closed helper command.
   * @returns Host observation.
   */
  async function invoke(command: AppUpdateHostCommand): Promise<AppUpdateHostResult> {
    if (!transport) {
      return {
        ok: false,
        code: 'app_update_unconfigured',
        message: 'App update is disabled because deployment configuration is absent.',
      };
    }
    return transport.invoke(command);
  }

  /**
   * Projects a helper result as an HTTP response.
   *
   * @param result Host observation.
   * @returns JSON success or coded API error.
   */
  function toResponse(result: AppUpdateHostResult): Response {
    if (!result.ok) {
      return asApiError(result.message, result.code, HOST_ERROR_STATUS[result.code] ?? 503);
    }
    return Response.json(AppUpdateStatusResponseSchema.parse(result.status));
  }

  registerAppApiRoute(app, 'prepareAppUpdate', async (c) => {
    const adminError = requireAdmin(c.get('actor'));
    if (adminError) {
      return adminError;
    }

    const parsed = PrepareAppUpdateRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    const result = await invoke({
      expectedCurrentImageId: parsed.data.expectedCurrentImageId,
      op: 'prepare',
      source: parsed.data.source,
    });
    if (!result.ok) {
      return toResponse(result);
    }
    return Response.json(
      PrepareAppUpdateResponseSchema.parse({
        expectedCurrentImageId: result.status.expectedCurrentImageId,
        preparedAt: result.status.preparedAt,
        requestId: result.status.requestId,
        source: result.status.source,
        stage: 'prepared',
      })
    );
  });

  registerAppApiRoute(app, 'startAppUpdate', async (c) => {
    const adminError = requireAdmin(c.get('actor'));
    if (adminError) {
      return adminError;
    }

    const parsed = StartAppUpdateRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    const actor = c.get('actor');
    const auditActor = actor ? { actor: { id: actor.userId, kind: 'user' as const } } : {};
    if (coreDb) {
      recordServerAuditEvent({
        action: 'app.update.start',
        category: 'system',
        coreDb,
        outcome: 'succeeded',
        requestId: parsed.data.requestId,
        resource: `app-update:${parsed.data.requestId}`,
        severity: 'info',
        summary: 'Authorized App-update start request was accepted.',
        ...auditActor,
      });
    }

    const result = await invoke({
      maintenanceConsent: true,
      op: 'start',
      requestId: parsed.data.requestId,
    });
    if (coreDb) {
      recordServerAuditEvent({
        action: 'app.update.start.handoff',
        category: 'system',
        coreDb,
        ...(result.ok
          ? { outcome: 'succeeded' as const }
          : { errorCode: result.code, outcome: 'failed' as const }),
        requestId: parsed.data.requestId,
        resource: `app-update:${parsed.data.requestId}`,
        severity: result.ok ? 'info' : 'error',
        summary: result.ok
          ? 'App-update start host handoff returned a receipt.'
          : 'App-update start host handoff did not return a receipt.',
        ...auditActor,
      });
    }

    return toResponse(result);
  });

  registerAppApiRoute(app, 'getAppUpdateStatus', async (c) => {
    const adminError = requireAdmin(c.get('actor'));
    if (adminError) {
      return adminError;
    }

    const requestId = c.req.param('requestId');
    const parsed = StartAppUpdateRequestSchema.pick({ requestId: true }).safeParse({
      requestId,
    });
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    return toResponse(
      await invoke({
        op: 'status',
        requestId: parsed.data.requestId,
      })
    );
  });
}
