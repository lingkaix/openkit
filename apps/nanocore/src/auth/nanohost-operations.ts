import type {
  NANOHOST_OPERATION_DEFINITIONS,
  OperationInput,
  OperationOutput,
} from '@openkit/app-api-schemas';
import {
  AbortNanoHostTransportRotationResponseSchema,
  DecommissionNanoHostResponseSchema,
  EnrollNanoHostResponseSchema,
  IssueNanoHostTransportTokenResponseSchema,
  ListNanoHostTransportTokensResponseSchema,
  RevokeNanoHostTransportTokenResponseSchema,
  RotateNanoHostTransportTokenResponseSchema,
} from '@openkit/app-api-schemas';
import type { OpenKitNanoHostConfig } from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';

import { publishedErrorMessage } from '../api-errors.js';
import { recordServerAuditEvent } from '../audit-events.js';
import type { CoreMode } from '../config/mode.js';
import { readConfiguredNanoHostRuntimeTargetStatus } from '../runtime/nanohost-runtime-target.js';
import { generateUuidV7 } from '../runtime/session-id.js';
import type { CoreDb } from '../storage/db.js';
import {
  abortNanoHostTransportRotation,
  decommissionNanoHostTransportAndFence,
  revokeNanoHostTransportTokenAndFence,
} from './nanohost-transport-lifecycle.js';
import type { NanoHostTransportSessionAuthority } from './nanohost-transport-session.js';
import {
  clearExactOwnedNanoHostCredentialSlot,
  clearNanoHostCredentialSlot,
  deliverNanoHostTransportTokenToNamedSlot,
  readNanoHostCredentialSlotTokenId,
} from './nanohost-transport-sink.js';
import { createOpenKitAccessTokenSecret } from './nanohost-transport-token.js';
import {
  createNanoHostTransportTokenRecord,
  enrollNanoHostTransportIdentity,
  getNanoHostTransportTokenRecord,
  isNanoHostTransportIdentityActive,
  listNanoHostTransportTokenRecords,
  type NanoHostTransportTokenRecord,
  revokeNanoHostTransportTokenRecord,
  rotateNanoHostTransportTokenRecord,
} from './nanohost-transport-token-store.js';

/** Exact native NanoHost handler signatures; facts remain in the browser-safe family table. */
type NanoHostImplementations = {
  [K in keyof typeof NANOHOST_OPERATION_DEFINITIONS]: (
    input: OperationInput<K>,
    actor: ActorRef
  ) => OperationOutput<K> | Promise<OperationOutput<K>>;
};

/** Joins enrollment, named-slot delivery, lifecycle fencing and RuntimeTarget observation to their existing owners. */
export function createNanoHostOperationImplementations({
  coreDb,
  mode,
  nanoHostConfig,
  sessionAuthority,
}: {
  readonly coreDb: CoreDb | undefined;
  readonly mode: CoreMode;
  readonly nanoHostConfig?: Pick<OpenKitNanoHostConfig, 'identityId' | 'deploymentId'> &
    Partial<OpenKitNanoHostConfig>;
  readonly sessionAuthority?: NanoHostTransportSessionAuthority;
}): NanoHostImplementations {
  /** Preserves the domain's server-mode and storage availability boundary after primary admission. */
  function requireNanoHostEnvironment(): void {
    if (mode !== 'server')
      failure(
        'NanoHost transport administration is only available in server mode.',
        'nanohost_transport_admin_server_mode_required',
        404
      );
    if (!coreDb)
      failure(
        'NanoHost transport token storage is unavailable.',
        'nanohost_transport_storage_unavailable',
        503
      );
  }

  /** Returns the configured NanoHost deployment or a fail-closed response. */
  function requireNanoHostConfig(): OpenKitNanoHostConfig {
    if (!nanoHostConfig?.credentialSlots)
      failure(
        'NanoHost deployment configuration is unavailable.',
        'nanohost_transport_config_unavailable',
        503
      );
    return nanoHostConfig as OpenKitNanoHostConfig;
  }

  /** Returns the configured sink for one named slot. */
  function configuredSink(config: OpenKitNanoHostConfig, slot: 'A' | 'B') {
    return config.credentialSlots[slot];
  }

  /** Returns the slot whose companion metadata names one Token id. */
  function configuredSlotForToken(
    config: OpenKitNanoHostConfig,
    tokenId: string
  ): 'A' | 'B' | null {
    for (const slot of ['A', 'B'] as const) {
      if (readNanoHostCredentialSlotTokenId(configuredSink(config, slot)) === tokenId) {
        return slot;
      }
    }
    return null;
  }

  /**
   * Records a server audit event for one successful NanoHost transport lifecycle operation.
   *
   * @param coreDb Server database that owns the event.
   * @param action Stable NanoHost transport lifecycle action.
   * @param record Redacted token record affected by the operation.
   * @param actorUserId User id that requested the operation when authenticated.
   */
  function recordNanoHostTransportLifecycleAuditEvent(
    coreDb: CoreDb,
    action:
      | 'nanohost.transport.enroll'
      | 'nanohost.transport.issue'
      | 'nanohost.transport.revoke'
      | 'nanohost.transport.rotate',
    record: NanoHostTransportTokenRecord,
    actorUserId: string | null
  ): void {
    const actorSuffix = actorUserId ? ` Requested by ${actorUserId}.` : '';
    let summary: string;
    switch (action) {
      case 'nanohost.transport.enroll':
        summary = `NanoHost ${record.ownerNanoHostIdentityId} enrolled with transport token ${record.tokenId} for deployment ${record.deploymentId}.${actorSuffix}`;
        break;
      case 'nanohost.transport.issue':
        summary = `NanoHost transport token ${record.tokenId} issued for ${record.ownerNanoHostIdentityId}.${actorSuffix}`;
        break;
      case 'nanohost.transport.revoke':
        summary = `NanoHost transport token ${record.tokenId} revoked.${actorSuffix}`;
        break;
      case 'nanohost.transport.rotate':
        summary = `NanoHost transport token ${record.predecessorTokenId ?? record.tokenId} rotated to ${record.tokenId}.${actorSuffix}`;
        break;
    }

    recordServerAuditEvent({
      action,
      category: 'system',
      coreDb,
      outcome: 'succeeded',
      resource: `nanohost-transport-token:${record.tokenId}`,
      severity: 'info',
      summary,
    });
  }

  /**
   * Counts durable tokens for one identity+deployment to derive issuance generation.
   *
   * @param coreDb Server database that owns the tokens.
   * @param ownerNanoHostIdentityId Configured NanoHost identity.
   * @param deploymentId Declared deployment binding.
   * @returns Positive issuance generation for the newest token row.
   */
  function nextIssuanceGeneration(
    coreDb: CoreDb,
    ownerNanoHostIdentityId: string,
    deploymentId: string
  ): number {
    const row = coreDb.sqlite
      .prepare(
        `SELECT COUNT(*) AS count
         FROM nanohost_transport_tokens
         WHERE owner_nanohost_identity_id = ? AND deployment_id = ?`
      )
      .get(ownerNanoHostIdentityId, deploymentId) as { count: number };
    return Math.max(1, Number(row.count));
  }

  /**
   * Delivers a newly issued secret to the named sink or revokes the token.
   *
   * @param coreDb Server database that owns the token.
   * @param issued Newly created token id and secret.
   * @param options Slot, sink, and companion identity fields.
   * @returns Redacted slot-result metadata when the write is proved.
   */
  function deliverOrRevokeIssuedToken(
    coreDb: CoreDb,
    issued: { record: NanoHostTransportTokenRecord; secret: string; tokenId: string },
    options: {
      readonly deploymentId: string;
      readonly identityId: string;
      readonly sink: { companionPath: string; secretPath: string };
      readonly slot: 'A' | 'B';
    }
  ): ReturnType<typeof deliverNanoHostTransportTokenToNamedSlot> {
    const issuanceGeneration = nextIssuanceGeneration(
      coreDb,
      options.identityId,
      options.deploymentId
    );
    try {
      return deliverNanoHostTransportTokenToNamedSlot({
        deploymentId: options.deploymentId,
        identityId: options.identityId,
        issuanceGeneration,
        secret: issued.secret,
        sink: options.sink,
        slot: options.slot,
        tokenId: issued.tokenId,
        writeDisposition: 'replace',
      });
    } catch (error) {
      revokeNanoHostTransportTokenRecord(coreDb, issued.tokenId);
      throw error;
    }
  }

  return {
    'nanohost.enroll': (input, actor) => {
      requireNanoHostEnvironment();

      const config = requireNanoHostConfig();
      if (isNanoHostTransportIdentityActive(coreDb!, config.identityId, config.deploymentId)) {
        return failure(
          'Configured NanoHost identity is already enrolled.',
          'nanohost_already_enrolled',
          409
        );
      }

      try {
        const actorUserId = actor.id;
        const tokenId = generateUuidV7();
        const secret = createOpenKitAccessTokenSecret();
        const sink = configuredSink(config, input.targetSlot);
        const slotResult = deliverNanoHostTransportTokenToNamedSlot({
          deploymentId: config.deploymentId,
          identityId: config.identityId,
          issuanceGeneration: 1,
          secret,
          sink,
          slot: input.targetSlot,
          tokenId,
          writeDisposition: 'exclusive-create',
        });
        let issued: ReturnType<typeof enrollNanoHostTransportIdentity>;
        try {
          issued = enrollNanoHostTransportIdentity(coreDb!, {
            deploymentId: config.deploymentId,
            expiresAt: input.expiresAt,
            ownerNanoHostIdentityId: config.identityId,
            responsibleServerAdminActorId: actorUserId,
            secret,
            tokenId,
          });
        } catch (error) {
          clearExactOwnedNanoHostCredentialSlot(sink, tokenId);
          throw error;
        }

        recordNanoHostTransportLifecycleAuditEvent(
          coreDb!,
          'nanohost.transport.enroll',
          issued.record,
          actorUserId
        );

        return EnrollNanoHostResponseSchema.parse({
          credentialRef: config.credentialRef,
          deploymentId: config.deploymentId,
          identityId: config.identityId,
          record: issued.record,
          slotResult,
          targetSlot: input.targetSlot,
        });
      } catch (error) {
        return failure(publishedErrorMessage(error), 'nanohost_enroll_failed', 400);
      }
    },

    'nanohost.runtime-target': () => {
      requireNanoHostEnvironment();

      const observation = readConfiguredNanoHostRuntimeTargetStatus({
        coreDb,
        mode,
        ...(nanoHostConfig ? { nanoHostConfig } : {}),
      });
      if (!observation.ok) {
        return failure(observation.message, observation.code, observation.httpStatus);
      }
      return observation.status;
    },

    'nanohost.token-list': () => {
      requireNanoHostEnvironment();

      return ListNanoHostTransportTokensResponseSchema.parse({
        items: listNanoHostTransportTokenRecords(coreDb!),
      });
    },

    'nanohost.token-issue': (input, actor) => {
      requireNanoHostEnvironment();

      const config = requireNanoHostConfig();

      try {
        const actorUserId = actor.id;
        const issued = createNanoHostTransportTokenRecord(coreDb!, {
          deploymentId: config.deploymentId,
          expiresAt: input.expiresAt,
          ownerNanoHostIdentityId: config.identityId,
          responsibleServerAdminActorId: actorUserId,
        });
        const slotResult = deliverOrRevokeIssuedToken(coreDb!, issued, {
          deploymentId: config.deploymentId,
          identityId: config.identityId,
          sink: configuredSink(config, input.targetSlot),
          slot: input.targetSlot,
        });
        recordNanoHostTransportLifecycleAuditEvent(
          coreDb!,
          'nanohost.transport.issue',
          issued.record,
          actorUserId
        );

        return IssueNanoHostTransportTokenResponseSchema.parse({
          credentialRef: config.credentialRef,
          record: issued.record,
          slotResult,
          targetSlot: input.targetSlot,
        });
      } catch (error) {
        return failure(publishedErrorMessage(error), 'nanohost_transport_issue_failed', 400);
      }
    },

    'nanohost.token-revoke': (input, actor) => {
      requireNanoHostEnvironment();

      const record = sessionAuthority
        ? revokeNanoHostTransportTokenAndFence(coreDb!, sessionAuthority, {
            tokenId: input.tokenId,
          })
        : revokeNanoHostTransportTokenRecord(coreDb!, input.tokenId);
      if (!record) {
        return failure(
          'NanoHost transport token not found.',
          'nanohost_transport_token_not_found',
          404
        );
      }

      recordNanoHostTransportLifecycleAuditEvent(
        coreDb!,
        'nanohost.transport.revoke',
        record,
        actor.id
      );

      return RevokeNanoHostTransportTokenResponseSchema.parse({ record });
    },

    'nanohost.token-rotate': (input, actor) => {
      requireNanoHostEnvironment();

      const config = requireNanoHostConfig();

      try {
        const predecessorSlot = configuredSlotForToken(config, input.tokenId);
        if (!predecessorSlot) {
          return failure(
            'NanoHost transport predecessor slot could not be proved.',
            'nanohost_transport_predecessor_slot_unproved',
            409
          );
        }
        const targetSlot = predecessorSlot === 'A' ? 'B' : 'A';
        const rotated = rotateNanoHostTransportTokenRecord(coreDb!, input.tokenId, {
          overlapSeconds: input.overlapSeconds,
        });
        if (!rotated) {
          return failure(
            'NanoHost transport token not found or not rotatable.',
            'nanohost_transport_token_not_found',
            404
          );
        }

        let slotResult: ReturnType<typeof deliverNanoHostTransportTokenToNamedSlot>;
        try {
          slotResult = deliverNanoHostTransportTokenToNamedSlot({
            deploymentId: config.deploymentId,
            identityId: config.identityId,
            issuanceGeneration: nextIssuanceGeneration(
              coreDb!,
              config.identityId,
              config.deploymentId
            ),
            secret: rotated.secret,
            sink: configuredSink(config, targetSlot),
            slot: targetSlot,
            tokenId: rotated.tokenId,
            writeDisposition: 'replace',
          });
        } catch (error) {
          if (sessionAuthority) {
            abortNanoHostTransportRotation(coreDb!, sessionAuthority, {
              predecessorTokenId: rotated.rotatedRecord.tokenId,
              successorSink: configuredSink(config, targetSlot),
              successorTokenId: rotated.tokenId,
            });
          }
          throw error;
        }

        recordNanoHostTransportLifecycleAuditEvent(
          coreDb!,
          'nanohost.transport.rotate',
          rotated.record,
          actor.id
        );

        return RotateNanoHostTransportTokenResponseSchema.parse({
          credentialRef: config.credentialRef,
          record: rotated.record,
          rotatedRecord: rotated.rotatedRecord,
          slotResult,
          targetSlot,
        });
      } catch (error) {
        if (error instanceof NanoHostOperationError) throw error;
        return failure(publishedErrorMessage(error), 'nanohost_transport_rotate_failed', 400);
      }
    },

    'nanohost.token-rotation-abort': (input) => {
      requireNanoHostEnvironment();
      const config = requireNanoHostConfig();
      if (!sessionAuthority) {
        return failure(
          'NanoHost session authority is unavailable.',
          'nanohost_transport_unavailable',
          503
        );
      }
      const successor = getNanoHostTransportTokenRecord(coreDb!, input.tokenId);
      if (!successor?.predecessorTokenId) {
        return failure(
          'NanoHost rotation not found.',
          'nanohost_transport_rotation_not_found',
          404
        );
      }
      const successorSlot = configuredSlotForToken(config, successor.tokenId);
      if (!successorSlot) {
        return failure(
          'NanoHost successor slot could not be proved.',
          'nanohost_transport_successor_slot_unproved',
          409
        );
      }
      const aborted = abortNanoHostTransportRotation(coreDb!, sessionAuthority, {
        predecessorTokenId: successor.predecessorTokenId,
        successorSink: configuredSink(config, successorSlot),
        successorTokenId: successor.tokenId,
      });
      return AbortNanoHostTransportRotationResponseSchema.parse(aborted);
    },

    'nanohost.decommission': (_input, actor) => {
      requireNanoHostEnvironment();
      const config = requireNanoHostConfig();
      if (!sessionAuthority) {
        return failure(
          'NanoHost session authority is unavailable.',
          'nanohost_transport_unavailable',
          503
        );
      }
      const records = decommissionNanoHostTransportAndFence(coreDb!, sessionAuthority, {
        deploymentId: config.deploymentId,
        identityId: config.identityId,
      });
      clearNanoHostCredentialSlot(config.credentialSlots.A);
      clearNanoHostCredentialSlot(config.credentialSlots.B);
      const retainedRecords = listNanoHostTransportTokenRecords(coreDb!).filter(
        (record) =>
          record.ownerNanoHostIdentityId === config.identityId &&
          record.deploymentId === config.deploymentId
      );
      const tokenLineage = retainedRecords
        .map((record) => `${record.tokenId}<-${record.predecessorTokenId ?? 'root'}`)
        .join(',');
      recordServerAuditEvent({
        action: 'nanohost.transport.decommission',
        actor: { kind: 'user', id: actor.id },
        category: 'system',
        coreDb: coreDb!,
        outcome: 'succeeded',
        resource: `nanohost-transport-identity:${config.identityId}`,
        severity: 'info',
        summary: `NanoHost ${config.identityId} decommissioned for deployment ${config.deploymentId}; newly revoked ${records.length} transport token${records.length === 1 ? '' : 's'}; retained lineage count=${retainedRecords.length}; lineage=${tokenLineage || 'none'}.`,
      });
      return DecommissionNanoHostResponseSchema.parse({
        identityId: config.identityId,
        revokedTokenCount: records.length,
        status: 'decommissioned',
      });
    },
  };
}

/** Domain failure preserved by invocation and its transport projections. */
export class NanoHostOperationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'NanoHostOperationError';
  }
}

/** Throws the same owned failure without an HTTP response or a transport dependency. */
function failure(message: string, code: string, status: number): never {
  throw new NanoHostOperationError(code, message, status);
}
