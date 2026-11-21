import type { NANOHOST_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import {
  AbortNanoHostTransportRotationResponseSchema,
  DecommissionNanoHostResponseSchema,
  EnrollNanoHostResponseSchema,
  IssueNanoHostTransportTokenResponseSchema,
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
import type { NanoHostCoreReads } from '../storage/control-kernel-port.js';
import type { CoreDb } from '../storage/db.js';
import { requireNanoHostObservation } from '../storage/nanohost-observation.js';
import type { AdmittedNanoHostTransportStorage } from '../storage/nanohost-transport-owner.js';
import type { StorageResult } from '../storage/storage-owner.js';
import {
  DeploymentAdminRequiredError,
  requireCurrentDeploymentAdmin,
} from './access-token-store.js';
import type { Actor } from './identity.js';
import {
  type ControlNanoHostTransportResult,
  NANOHOST_TRANSPORT_ADMIN_REFUSAL,
  nanoHostTransportAdminFacts,
} from './nanohost-transport-codecs.js';
import {
  abortNanoHostTransportRotation,
  fenceNanoHostTransportAuthority,
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
  getNanoHostTransportTokenRecord,
  isNanoHostTransportIdentityActive,
  listNanoHostTransportTokenRecords,
  type NanoHostTransportEnrollment,
  type NanoHostTransportTokenRecord,
  nanoHostTransportCommitState,
  prepareNanoHostTransportWriter,
  recordNanoHostTransportAudit,
  revokeNanoHostTransportTokenRecord,
  rotateNanoHostTransportTokenRecord,
  submitNanoHostTransportDecommission,
  submitNanoHostTransportEnrollment,
  submitNanoHostTransportRevocation,
} from './nanohost-transport-token-store.js';

/**
 * Commits the exact enrollment tuple on the selected Native opening after a
 * decisive Core administrator recheck ordered against issuance. A refusal
 * carries the original Worker commit certainty.
 */
export type NanoHostAdministratorEnroll = (
  input: NanoHostTransportEnrollment & { readonly actor: Actor }
) => Promise<Extract<ControlNanoHostTransportResult, { kind: 'record' }>>;

/** The worker orders staged Native revocation against the current Core administrator.
 * Its acknowledgement is for the exact original Native outcome, with the original Audit stage
 * still to be acknowledged. An unknown Native submission throws with its commit certainty.
 */
export type NanoHostAdministratorRevoke = (input: {
  readonly actor: Actor;
  readonly expected: NanoHostTransportTokenRecord;
}) => Promise<
  StorageResult<
    'nanohost' | 'control-kernel',
    { readonly record: NanoHostTransportTokenRecord; acknowledgeAudit(): Promise<void> }
  >
>;

/** Production credential.revoke handoff for the acknowledged Native owner. */
export async function revokeAdmittedNanoHostInboundCredential(
  input: {
    readonly storage: StorageResult<'nanohost', AdmittedNanoHostTransportStorage>;
    readonly sessionAuthority?: NanoHostTransportSessionAuthority;
    readonly commitRevoke?: NanoHostAdministratorRevoke;
  },
  tokenId: string,
  context: AdmittedOperationContext
): Promise<void> {
  const { storage, commitRevoke, sessionAuthority } = input;
  if (storage.state !== 'ready' || !commitRevoke || !sessionAuthority)
    return failure(
      'NanoHost transport administration is unavailable.',
      'nanohost_transport_storage_unavailable',
      503
    );

  const actor = nanoHostTransportAdminFacts(publicOperationActor(context));
  const selected = storage.value;
  const prior = selected.owner.read((sqlite) =>
    getNanoHostTransportTokenRecord({ sqlite }, tokenId)
  );
  if (prior.state !== 'ready')
    return failure(
      'NanoHost transport administration is unavailable.',
      'nanohost_transport_storage_unavailable',
      503
    );
  if (!prior.value)
    return failure(
      'NanoHost transport token not found.',
      'nanohost_transport_token_not_found',
      404
    );

  const expected = prior.value;
  await context.recheckAdmission?.();
  const fence = () =>
    fenceNanoHostTransportAuthority(
      selected,
      sessionAuthority,
      expected.ownerNanoHostIdentityId,
      new Date().toISOString()
    );
  let outcome: Awaited<ReturnType<NanoHostAdministratorRevoke>>;
  try {
    outcome = await commitRevoke({ actor, expected });
  } catch (error) {
    if (nanoHostTransportCommitState(error) === 'unknown') {
      try {
        await fence();
      } catch {
        // Process fencing ran first. Preserve the original Native acknowledgement uncertainty.
      }
    }
    throw error;
  }
  if (
    outcome.state !== 'ready' ||
    outcome.value.record.tokenId !== expected.tokenId ||
    outcome.value.record.ownerNanoHostIdentityId !== expected.ownerNanoHostIdentityId ||
    outcome.value.record.deploymentId !== expected.deploymentId ||
    outcome.value.record.predecessorTokenId !== expected.predecessorTokenId ||
    outcome.value.record.status !== 'revoked'
  )
    return failure(
      'NanoHost transport administration requires recovery.',
      'nanohost_transport_storage_unavailable',
      503
    );

  await fence();
  await outcome.value.acknowledgeAudit();
}

/** Revokes through the original writer, physical fencing and awaited lifecycle Audit. */
export async function revokeNanoHostInboundCredential(
  {
    coreDb,
    mode,
    sessionAuthority,
  }: {
    readonly coreDb: CoreDb | undefined;
    readonly mode: CoreMode;
    readonly sessionAuthority?: NanoHostTransportSessionAuthority;
  },
  tokenId: string,
  context: AdmittedOperationContext
): Promise<void> {
  const actor = context.actorRef;
  if (mode !== 'server' || !coreDb)
    throw new OperationError(
      'nanohost_transport_storage_unavailable',
      'NanoHost transport administration is unavailable.',
      mode === 'server' ? 503 : 404
    );

  const admin = { ...publicOperationActor(context) };
  const beforeSubmit = context.recheckAdmission;
  let record: NanoHostTransportTokenRecord | null;
  if (sessionAuthority) {
    const prior = getNanoHostTransportTokenRecord(coreDb!, tokenId);
    const writer = await prepareNanoHostTransportWriter(coreDb!);
    await beforeSubmit?.();
    try {
      record = await submitNanoHostTransportRevocation(writer, tokenId, {}, admin);
    } catch (error) {
      if (nanoHostTransportCommitState(error) === 'unknown' && prior) {
        try {
          await fenceNanoHostTransportAuthority(
            coreDb!,
            sessionAuthority,
            prior.ownerNanoHostIdentityId,
            new Date().toISOString()
          );
        } catch {
          // Process fencing ran first; readiness failure must preserve the original unknown commit.
        }
      }
      throw error;
    }
    if (record)
      await fenceNanoHostTransportAuthority(
        coreDb!,
        sessionAuthority,
        record.ownerNanoHostIdentityId,
        new Date().toISOString()
      );
  } else {
    record = await revokeNanoHostTransportTokenRecord(coreDb!, tokenId, {}, admin, beforeSubmit);
  }
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

/** Exact native NanoHost handler signatures; facts remain in the browser-safe family table. */
type NanoHostImplementations = FamilyImplementations<typeof NANOHOST_OPERATION_DEFINITIONS>;

/** Joins enrollment, named-slot delivery, lifecycle fencing and RuntimeTarget observation to their existing owners. */
export function createNanoHostOperationImplementations({
  coreDb,
  mode,
  nanoHostConfig,
  sessionAuthority,
  readNanoHostTarget,
  nanoHostEnrollment,
}: {
  readonly coreDb: CoreDb | undefined;
  readonly mode: CoreMode;
  readonly nanoHostConfig?: Pick<OpenKitNanoHostConfig, 'identityId' | 'deploymentId'> &
    Partial<OpenKitNanoHostConfig>;
  readonly sessionAuthority?: NanoHostTransportSessionAuthority;
  readonly readNanoHostTarget?: NanoHostCoreReads['readTarget'];
  readonly nanoHostEnrollment?: {
    readonly storage: StorageResult<'nanohost', AdmittedNanoHostTransportStorage>;
    readonly commitEnroll: NanoHostAdministratorEnroll;
  };
}) {
  /** Preserves the server-mode boundary after primary admission. */
  function requireNanoHostServerMode(): void {
    if (mode !== 'server')
      failure(
        'NanoHost transport administration is only available in server mode.',
        'nanohost_transport_admin_server_mode_required',
        404
      );
  }

  /** Holds the other administrator mutations until their deciding writers are joined. */
  function requireNanoHostEnvironment(): void {
    requireNanoHostServerMode();
    if (readNanoHostTarget || nanoHostEnrollment || !coreDb) unavailableNanoHostTransportStorage();
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
    const row = requireNanoHostObservation(
      coreDb,
      (sqlite) =>
        sqlite
          .prepare(
            `SELECT COUNT(*) AS count
         FROM nanohost_transport_tokens
         WHERE owner_nanohost_identity_id = ? AND deployment_id = ?`
          )
          .get(ownerNanoHostIdentityId, deploymentId) as { count: number }
    );
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
      requireNanoHostServerMode();
      if (!coreDb || !nanoHostEnrollment || nanoHostEnrollment.storage.state !== 'ready')
        return unavailableNanoHostTransportStorage();

      const { storage, commitEnroll } = nanoHostEnrollment;
      const config = requireNanoHostConfig();
      const existingIdentity = storage.value.owner.read((sqlite) =>
        isNanoHostTransportIdentityActive({ sqlite }, config.identityId, config.deploymentId)
      );
      if (existingIdentity.state !== 'ready') return unavailableNanoHostTransportStorage();
      if (existingIdentity.value)
        return failure(
          'Configured NanoHost identity is already enrolled.',
          'nanohost_already_enrolled',
          409
        );

      try {
        const actorUserId = context.actorRef.id;
        const requestActor = nanoHostTransportAdminFacts(publicOperationActor(context));
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

        try {
          await context.recheckAdmission?.();
          requireCurrentDeploymentAdmin(coreDb, requestActor);
          if (readNanoHostCredentialSlotTokenId(sink) !== tokenId)
            throw new Error('NanoHost enrollment slot changed before persistence.');
        } catch (error) {
          clearExactOwnedNanoHostCredentialSlot(sink, tokenId);
          throw error;
        }

        let issued: Awaited<ReturnType<typeof submitNanoHostTransportEnrollment>>;
        try {
          issued = await submitNanoHostTransportEnrollment(
            { submit: (command) => commitEnroll({ ...command, actor: requestActor }) },
            {
              deploymentId: config.deploymentId,
              expiresAt: input.expiresAt,
              ownerNanoHostIdentityId: config.identityId,
              responsibleServerAdminActorId: actorUserId,
              secret,
              tokenId,
            }
          );
        } catch (error) {
          // Only this credential stage's definite rollback proves that delivery is residue.
          if (nanoHostTransportCommitState(error) === 'not-committed')
            clearExactOwnedNanoHostCredentialSlot(sink, tokenId);
          throw error;
        }
        const { record } = issued;
        if (
          record.tokenId !== tokenId ||
          record.deploymentId !== config.deploymentId ||
          record.ownerNanoHostIdentityId !== config.identityId ||
          record.responsibleServerAdminActorId !== actorUserId ||
          record.expiresAt !== input.expiresAt ||
          record.predecessorTokenId !== null ||
          record.status !== 'active'
        )
          return unavailableNanoHostTransportStorage();

        await recordNanoHostTransportLifecycleAuditEvent(
          coreDb,
          'nanohost.transport.enroll',
          record,
          actorUserId
        );

        return EnrollNanoHostResponseSchema.parse({
          credentialRef: config.credentialRef,
          deploymentId: config.deploymentId,
          identityId: config.identityId,
          record,
          slotResult,
          targetSlot: input.targetSlot,
        });
      } catch (error) {
        rethrowNanoHostOperationError(error);
        return failure('NanoHost enrollment failed.', 'nanohost_enroll_failed', 400);
      }
    },

    'nanohost.runtime-target': () => {
      const observation = readConfiguredNanoHostRuntimeTargetStatus({
        coreDb,
        mode,
        ...(readNanoHostTarget ? { readNanoHostTarget } : {}),
        ...(nanoHostConfig ? { nanoHostConfig } : {}),
      });
      if (!observation.ok) {
        return failure(observation.message, observation.code, observation.httpStatus);
      }
      return observation.status;
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
      const snapshot = { deploymentId: config.deploymentId, identityId: config.identityId };
      const admin = { ...publicOperationActor(context) };
      const beforeSubmit = context.recheckAdmission;
      const writer = await prepareNanoHostTransportWriter(coreDb!);
      await beforeSubmit?.();
      let records: NanoHostTransportTokenRecord[];
      try {
        records = await submitNanoHostTransportDecommission(writer, snapshot, admin);
      } catch (error) {
        if (nanoHostTransportCommitState(error) === 'unknown') {
          try {
            await fenceNanoHostTransportAuthority(
              coreDb!,
              sessionAuthority,
              snapshot.identityId,
              new Date().toISOString()
            );
          } catch {
            // Keep the uncertain native outcome after process authority has been fenced.
          }
        }
        throw error;
      }
      await fenceNanoHostTransportAuthority(
        coreDb!,
        sessionAuthority,
        snapshot.identityId,
        new Date().toISOString()
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

function unavailableNanoHostTransportStorage(): never {
  return failure(
    'NanoHost transport token storage is unavailable.',
    'nanohost_transport_storage_unavailable',
    503
  );
}

/** Preserves the existing public administrator refusal after new waits and the original operation failures. */
function rethrowNanoHostOperationError(error: unknown): void {
  if (error instanceof DeploymentAdminRequiredError) {
    const refusal = NANOHOST_TRANSPORT_ADMIN_REFUSAL;
    throw new OperationError(refusal.code, refusal.message, refusal.status, { cause: error });
  }
  if (error instanceof OperationError) throw error;
}
