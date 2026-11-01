import type { NANOHOST_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
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
import { allocateEntityId } from '@openkit/protocol';
import type { CoreMode } from '../config/mode.js';
import {
  type AdmittedOperationContext,
  type FamilyImplementations,
  publicOperationActor,
} from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { readConfiguredNanoHostRuntimeTargetStatus } from '../runtime/nanohost-runtime-target.js';
import type { CoreDb } from '../storage/db.js';
import {
  DeploymentAdminRequiredError,
  requireCurrentDeploymentAdmin,
} from './access-token-store.js';
import { NANOHOST_TRANSPORT_ADMIN_REFUSAL } from './nanohost-transport-codecs.js';
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
import {
  createOpenKitAccessTokenSecret,
  evaluateNanoHostTransportTokenUsability,
} from './nanohost-transport-token.js';
import {
  createNanoHostTransportTokenRecord,
  type enrollNanoHostTransportIdentity,
  getNanoHostTransportTokenRecord,
  isNanoHostTransportIdentityActive,
  listNanoHostTransportTokenRecords,
  type NanoHostTransportTokenRecord,
  nanoHostTransportCommitState,
  prepareNanoHostTransportWriter,
  recordNanoHostTransportAudit,
  revokeNanoHostTransportTokenRecord,
  rotateNanoHostTransportTokenRecord,
  submitNanoHostTransportEnrollment,
} from './nanohost-transport-token-store.js';

/** Exact native NanoHost handler signatures; facts remain in the browser-safe family table. */
type NanoHostImplementations = FamilyImplementations<typeof NANOHOST_OPERATION_DEFINITIONS>;

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
}) {
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
  async function recordNanoHostTransportLifecycleAuditEvent(
    coreDb: CoreDb,
    action:
      | 'nanohost.transport.enroll'
      | 'nanohost.transport.issue'
      | 'nanohost.transport.revoke'
      | 'nanohost.transport.rotate',
    record: NanoHostTransportTokenRecord,
    actorUserId: string | null
  ): Promise<void> {
    await recordNanoHostTransportAudit(coreDb, {
      kind: 'lifecycle-audit',
      action,
      record,
      actorUserId,
    });
  }

  /** Rechecks current credential facts immediately before a later Main sink effect. */
  function requireCurrentDelivery(record: NanoHostTransportTokenRecord): void {
    const current = getNanoHostTransportTokenRecord(coreDb!, record.tokenId);
    if (
      !current ||
      current.ownerNanoHostIdentityId !== record.ownerNanoHostIdentityId ||
      current.deploymentId !== record.deploymentId ||
      !isNanoHostTransportIdentityActive(
        coreDb!,
        current.ownerNanoHostIdentityId,
        current.deploymentId
      ) ||
      !evaluateNanoHostTransportTokenUsability(current).usable
    )
      throw new Error('NanoHost transport credential changed before delivery.');
  }

  /** Clears only this decommission's currently revoked credential after the native wait. */
  function clearDecommissionedSlot(config: OpenKitNanoHostConfig, slot: 'A' | 'B'): void {
    const sink = configuredSink(config, slot);
    const tokenId = readNanoHostCredentialSlotTokenId(sink);
    if (tokenId !== null) {
      const record = getNanoHostTransportTokenRecord(coreDb!, tokenId);
      if (
        !record ||
        record.ownerNanoHostIdentityId !== config.identityId ||
        record.deploymentId !== config.deploymentId ||
        record.status !== 'revoked'
      )
        throw new Error('NanoHost credential slot changed before decommission cleanup.');
    }
    clearNanoHostCredentialSlot(sink);
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
  async function deliverOrRevokeIssuedToken(
    coreDb: CoreDb,
    issued: { record: NanoHostTransportTokenRecord; secret: string; tokenId: string },
    options: {
      readonly deploymentId: string;
      readonly identityId: string;
      readonly sink: { companionPath: string; secretPath: string };
      readonly slot: 'A' | 'B';
    },
    context: AdmittedOperationContext
  ): Promise<ReturnType<typeof deliverNanoHostTransportTokenToNamedSlot>> {
    try {
      await context.recheckAdmission?.();
      requireCurrentDeploymentAdmin(coreDb, publicOperationActor(context));
      requireCurrentDelivery(issued.record);
      const issuanceGeneration = nextIssuanceGeneration(
        coreDb,
        options.identityId,
        options.deploymentId
      );
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
      // This remains the original separate compensator, without a fresh administrator requirement.
      await revokeNanoHostTransportTokenRecord(coreDb, issued.tokenId);
      throw error;
    }
  }

  return {
    'nanohost.enroll': async (input, context) => {
      const actor = context.actorRef;
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
        const tokenId = allocateEntityId('nhtok');
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
        const requestActor = { ...publicOperationActor(context) };
        let writer: Awaited<ReturnType<typeof prepareNanoHostTransportWriter>>;
        try {
          writer = await prepareNanoHostTransportWriter(coreDb!);
          await context.recheckAdmission?.();
          requireCurrentDeploymentAdmin(coreDb!, requestActor);
          if (readNanoHostCredentialSlotTokenId(sink) !== tokenId)
            throw new Error('NanoHost enrollment slot changed before persistence.');
        } catch (error) {
          clearExactOwnedNanoHostCredentialSlot(sink, tokenId);
          throw error;
        }
        let issued: Awaited<ReturnType<typeof enrollNanoHostTransportIdentity>>;
        try {
          issued = await submitNanoHostTransportEnrollment(
            writer,
            {
              deploymentId: config.deploymentId,
              expiresAt: input.expiresAt,
              ownerNanoHostIdentityId: config.identityId,
              responsibleServerAdminActorId: actorUserId,
              secret,
              tokenId,
            },
            requestActor
          );
        } catch (error) {
          // Only this credential stage's definite rollback proves that delivery is residue.
          if (nanoHostTransportCommitState(error) === 'not-committed')
            clearExactOwnedNanoHostCredentialSlot(sink, tokenId);
          throw error;
        }

        await recordNanoHostTransportLifecycleAuditEvent(
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
        rethrowNanoHostOperationError(error);
        return failure('NanoHost enrollment failed.', 'nanohost_enroll_failed', 400);
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

    'nanohost.token-issue': async (input, context) => {
      const actor = context.actorRef;
      requireNanoHostEnvironment();

      const config = requireNanoHostConfig();

      try {
        const actorUserId = actor.id;
        const issued = await createNanoHostTransportTokenRecord(
          coreDb!,
          {
            deploymentId: config.deploymentId,
            expiresAt: input.expiresAt,
            ownerNanoHostIdentityId: config.identityId,
            responsibleServerAdminActorId: actorUserId,
          },
          publicOperationActor(context),
          context.recheckAdmission
        );
        const slotResult = await deliverOrRevokeIssuedToken(
          coreDb!,
          issued,
          {
            deploymentId: config.deploymentId,
            identityId: config.identityId,
            sink: configuredSink(config, input.targetSlot),
            slot: input.targetSlot,
          },
          context
        );
        await recordNanoHostTransportLifecycleAuditEvent(
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
        rethrowNanoHostOperationError(error);
        return failure(
          'NanoHost transport token issuance failed.',
          'nanohost_transport_issue_failed',
          400
        );
      }
    },

    'nanohost.token-revoke': async (input, context) => {
      const actor = context.actorRef;
      requireNanoHostEnvironment();

      const record = sessionAuthority
        ? await revokeNanoHostTransportTokenAndFence(
            coreDb!,
            sessionAuthority,
            {
              tokenId: input.tokenId,
            },
            publicOperationActor(context),
            context.recheckAdmission
          )
        : await revokeNanoHostTransportTokenRecord(
            coreDb!,
            input.tokenId,
            {},
            publicOperationActor(context),
            context.recheckAdmission
          );
      if (!record) {
        return failure(
          'NanoHost transport token not found.',
          'nanohost_transport_token_not_found',
          404
        );
      }

      await recordNanoHostTransportLifecycleAuditEvent(
        coreDb!,
        'nanohost.transport.revoke',
        record,
        actor.id
      );

      return RevokeNanoHostTransportTokenResponseSchema.parse({ record });
    },

    'nanohost.token-rotate': async (input, context) => {
      const actor = context.actorRef;
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
        const rotated = await rotateNanoHostTransportTokenRecord(
          coreDb!,
          input.tokenId,
          {
            overlapSeconds: input.overlapSeconds,
          },
          publicOperationActor(context),
          context.recheckAdmission
        );
        if (!rotated) {
          return failure(
            'NanoHost transport token not found or not rotatable.',
            'nanohost_transport_token_not_found',
            404
          );
        }

        let slotResult: ReturnType<typeof deliverNanoHostTransportTokenToNamedSlot>;
        try {
          await context.recheckAdmission?.();
          requireCurrentDeploymentAdmin(coreDb!, publicOperationActor(context));
          requireCurrentDelivery(rotated.record);
          if (configuredSlotForToken(config, input.tokenId) !== predecessorSlot)
            throw new Error('NanoHost predecessor slot changed before rotation delivery.');
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
            await abortNanoHostTransportRotation(coreDb!, sessionAuthority, {
              auditActorUserId: actor.id,
              predecessorTokenId: rotated.rotatedRecord.tokenId,
              successorSink: configuredSink(config, targetSlot),
              successorTokenId: rotated.tokenId,
            });
          }
          throw error;
        }

        await recordNanoHostTransportLifecycleAuditEvent(
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
        rethrowNanoHostOperationError(error);
        return failure(
          'NanoHost transport token rotation failed.',
          'nanohost_transport_rotate_failed',
          400
        );
      }
    },

    'nanohost.token-rotation-abort': async (input, context) => {
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
      const aborted = await abortNanoHostTransportRotation(
        coreDb!,
        sessionAuthority,
        {
          auditActorUserId: context.actorRef.id,
          predecessorTokenId: successor.predecessorTokenId,
          successorSink: configuredSink(config, successorSlot),
          successorTokenId: successor.tokenId,
        },
        publicOperationActor(context),
        context.recheckAdmission
      );
      return AbortNanoHostTransportRotationResponseSchema.parse(aborted);
    },

    'nanohost.decommission': async (_input, context) => {
      const actor = context.actorRef;
      requireNanoHostEnvironment();
      const config = requireNanoHostConfig();
      if (!sessionAuthority) {
        return failure(
          'NanoHost session authority is unavailable.',
          'nanohost_transport_unavailable',
          503
        );
      }
      const records = await decommissionNanoHostTransportAndFence(
        coreDb!,
        sessionAuthority,
        {
          deploymentId: config.deploymentId,
          identityId: config.identityId,
        },
        publicOperationActor(context),
        context.recheckAdmission
      );
      clearDecommissionedSlot(config, 'A');
      clearDecommissionedSlot(config, 'B');
      const retainedRecords = listNanoHostTransportTokenRecords(coreDb!).filter(
        (record) =>
          record.ownerNanoHostIdentityId === config.identityId &&
          record.deploymentId === config.deploymentId
      );
      const tokenLineage = retainedRecords
        .map((record) => `${record.tokenId}<-${record.predecessorTokenId ?? 'root'}`)
        .join(',');
      await recordNanoHostTransportAudit(coreDb!, {
        kind: 'decommission-audit',
        identityId: config.identityId,
        deploymentId: config.deploymentId,
        actorUserId: actor.id,
        newlyRevokedCount: records.length,
        retainedTokenCount: retainedRecords.length,
        tokenLineage,
      });
      return DecommissionNanoHostResponseSchema.parse({
        identityId: config.identityId,
        revokedTokenCount: records.length,
        status: 'decommissioned',
      });
    },
  } satisfies NanoHostImplementations;
}

/** Throws the same owned failure without an HTTP response or a transport dependency. */
function failure(message: string, code: string, status: number): never {
  throw new OperationError(code, message, status);
}

/** Preserves the existing public administrator refusal after new waits and the original operation failures. */
function rethrowNanoHostOperationError(error: unknown): void {
  if (error instanceof DeploymentAdminRequiredError) {
    const refusal = NANOHOST_TRANSPORT_ADMIN_REFUSAL;
    throw new OperationError(refusal.code, refusal.message, refusal.status, { cause: error });
  }
  if (error instanceof OperationError) throw error;
}
