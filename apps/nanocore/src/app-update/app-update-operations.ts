import type { APP_UPDATE_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';

import { recordServerAuditEvent } from '../audit-events.js';
import { type FamilyImplementations, publicOperationActor } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
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

/** Joins App-update definitions to the boot-bound restricted host transport and existing audit owner. */
export function createAppUpdateOperationImplementations(input: {
  readonly coreDb?: CoreDb;
  readonly transport: AppUpdateHostTransport | null;
}) {
  const { coreDb, transport } = input;
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

  /** Refuses model-mediated host effects until the existing exact approval binding has an admitted adapter. */
  function requireHuman(context: import('../operation-contract.js').AdmittedOperationContext) {
    if (context.delivery === 'model')
      throw new OperationError(
        'unsupported_operation',
        'Agent-mediated App update requires an exact approval binding and is unsupported.',
        403
      );
  }

  /** Classifies the host's bounded refusals without claiming an effect was rolled back. */
  function status(result: AppUpdateHostResult) {
    if (!result.ok)
      throw new OperationError(result.code, result.message, HOST_ERROR_STATUS[result.code] ?? 503);
    return result.status;
  }

  return {
    'app-update.prepare': async (input, context) => {
      requireHuman(context);
      const result = await invoke({
        expectedCurrentImageId: input.expectedCurrentImageId,
        op: 'prepare',
        source: input.source,
      });
      const receipt = status(result);
      return {
        expectedCurrentImageId: receipt.expectedCurrentImageId,
        preparedAt: receipt.preparedAt,
        requestId: receipt.requestId,
        source: receipt.source,
        stage: 'prepared',
      };
    },
    'app-update.start': async (input, context) => {
      requireHuman(context);
      const actor = publicOperationActor(context);
      const auditActor = actor ? { actor: { id: actor.userId, kind: 'user' as const } } : {};
      if (coreDb) {
        recordServerAuditEvent({
          action: 'app.update.start',
          category: 'system',
          coreDb,
          outcome: 'succeeded',
          requestId: input.requestId,
          resource: `app-update:${input.requestId}`,
          severity: 'info',
          summary: 'Authorized App-update start request was accepted.',
          ...auditActor,
        });
      }

      const result = await invoke({
        maintenanceConsent: true,
        op: 'start',
        requestId: input.requestId,
      });
      if (coreDb) {
        recordServerAuditEvent({
          action: 'app.update.start.handoff',
          category: 'system',
          coreDb,
          ...(result.ok
            ? { outcome: 'succeeded' as const }
            : { errorCode: result.code, outcome: 'failed' as const }),
          requestId: input.requestId,
          resource: `app-update:${input.requestId}`,
          severity: result.ok ? 'info' : 'error',
          summary: result.ok
            ? 'App-update start host handoff returned a receipt.'
            : 'App-update start host handoff did not return a receipt.',
          ...auditActor,
        });
      }

      return status(result);
    },
    'app-update.status': async (input, context) => {
      requireHuman(context);
      return status(await invoke({ op: 'status', requestId: input.requestId }));
    },
  } satisfies FamilyImplementations<typeof APP_UPDATE_OPERATION_DEFINITIONS>;
}
