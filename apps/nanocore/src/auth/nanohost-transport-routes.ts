import {
  AbortNanoHostTransportRotationResponseSchema,
  DecommissionNanoHostResponseSchema,
  EnrollNanoHostRequestSchema,
  EnrollNanoHostResponseSchema,
  IssueNanoHostTransportTokenRequestSchema,
  IssueNanoHostTransportTokenResponseSchema,
  ListNanoHostTransportTokensResponseSchema,
  NanoHostRuntimeTargetStatusResponseSchema,
  RevokeNanoHostTransportTokenResponseSchema,
  RotateNanoHostTransportTokenRequestSchema,
  RotateNanoHostTransportTokenResponseSchema,
} from '@openkit/app-api-schemas';
import type { OpenKitNanoHostConfig } from '@openkit/config-schema';
import type { Context, Hono } from 'hono';

import { asApiError } from '../api-errors.js';
import { recordServerAuditEvent } from '../audit-events.js';
import type { CoreMode } from '../config/mode.js';
import { registerAppApiRoute } from '../openapi.js';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target.js';
import { generateUuidV7 } from '../runtime/session-id.js';
import type { CoreDb } from '../storage/db.js';
import type { AuthVariables } from './middleware.js';
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

/**
 * Registers server-admin NanoHost transport Token lifecycle and RuntimeTarget observation routes.
 *
 * Enrollment, issue, and rotate deliver the one-time secret only through a proved
 * named safe-sink write. General App API JSON results carry redacted identity,
 * token-reference, and slot-result metadata only.
 *
 * @param dependencies Route dependencies owned by the app composition root.
 */
export function registerNanoHostTransportRoutes({
  app,
  coreDb,
  mode,
  nanoHostConfig,
  sessionAuthority,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly mode: CoreMode;
  readonly nanoHostConfig?: OpenKitNanoHostConfig;
  readonly sessionAuthority?: NanoHostTransportSessionAuthority;
}): void {
  /**
   * Checks whether the current actor can administer NanoHost transport tokens.
   *
   * @param c Hono context carrying the actor variable.
   * @returns Error response when access should be denied.
   */
  function requireNanoHostTransportAdmin(
    c: Context<{ Variables: AuthVariables }>
  ): Response | null {
    if (mode !== 'server') {
      return asApiError(
        'NanoHost transport administration is only available in server mode.',
        'nanohost_transport_admin_server_mode_required',
        404
      );
    }

    if (!coreDb) {
      return asApiError(
        'NanoHost transport token storage is unavailable.',
        'nanohost_transport_storage_unavailable',
        503
      );
    }

    const actor = c.get('actor');
    if (actor?.kind !== 'token' || actor.tokenScope !== 'server-admin') {
      return asApiError('Server-admin token required.', 'nanohost_transport_admin_forbidden', 403);
    }

    return null;
  }

  /** Returns the configured NanoHost deployment or a fail-closed response. */
  function requireNanoHostConfig(): OpenKitNanoHostConfig | Response {
    return (
      nanoHostConfig ??
      asApiError(
        'NanoHost deployment configuration is unavailable.',
        'nanohost_transport_config_unavailable',
        503
      )
    );
  }

  /** Returns whether a config lookup result is an error response. */
  function isConfigError(value: OpenKitNanoHostConfig | Response): value is Response {
    return value instanceof Response;
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

  registerAppApiRoute(app, 'enrollNanoHost', async (c) => {
    const adminError = requireNanoHostTransportAdmin(c);
    if (adminError) {
      return adminError;
    }

    const parsed = EnrollNanoHostRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return asApiError('Invalid NanoHost enrollment request.', 'invalid_request', 400);
    }

    const config = requireNanoHostConfig();
    if (isConfigError(config)) {
      return config;
    }
    if (isNanoHostTransportIdentityActive(coreDb!, config.identityId, config.deploymentId)) {
      return asApiError(
        'Configured NanoHost identity is already enrolled.',
        'nanohost_already_enrolled',
        409
      );
    }

    try {
      const actorUserId = c.get('actor')?.userId ?? 'user_local';
      const tokenId = generateUuidV7();
      const secret = createOpenKitAccessTokenSecret();
      const sink = configuredSink(config, parsed.data.targetSlot);
      const slotResult = deliverNanoHostTransportTokenToNamedSlot({
        deploymentId: config.deploymentId,
        identityId: config.identityId,
        issuanceGeneration: 1,
        secret,
        sink,
        slot: parsed.data.targetSlot,
        tokenId,
        writeDisposition: 'exclusive-create',
      });
      let issued: ReturnType<typeof enrollNanoHostTransportIdentity>;
      try {
        issued = enrollNanoHostTransportIdentity(coreDb!, {
          deploymentId: config.deploymentId,
          expiresAt: parsed.data.expiresAt,
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

      return c.json(
        EnrollNanoHostResponseSchema.parse({
          credentialRef: config.credentialRef,
          deploymentId: config.deploymentId,
          identityId: config.identityId,
          record: issued.record,
          slotResult,
          targetSlot: parsed.data.targetSlot,
        }),
        201
      );
    } catch (error) {
      return asApiError((error as Error).message, 'nanohost_enroll_failed', 400);
    }
  });

  registerAppApiRoute(app, 'getNanoHostRuntimeTargetStatus', (c) => {
    const adminError = requireNanoHostTransportAdmin(c);
    if (adminError) {
      return adminError;
    }

    const config = requireNanoHostConfig();
    if (isConfigError(config)) {
      return config;
    }

    const target = getNanoHostRuntimeTarget(coreDb!, config.identityId);
    if (
      !target ||
      target.identityId !== config.identityId ||
      target.deploymentId !== config.deploymentId
    ) {
      return asApiError(
        'Configured NanoHost RuntimeTarget is unavailable.',
        'nanohost_runtime_target_not_found',
        404
      );
    }

    return c.json(
      NanoHostRuntimeTargetStatusResponseSchema.parse({
        identityId: target.identityId,
        deploymentId: target.deploymentId,
        connectionGeneration: target.connectionGeneration,
        predecessorFenced: target.predecessorFenced,
        ready: target.ready,
        freshEmpty: target.freshEmpty,
        observedAt: target.observedAt,
      })
    );
  });

  registerAppApiRoute(app, 'listNanoHostTransportTokens', (c) => {
    const adminError = requireNanoHostTransportAdmin(c);
    if (adminError) {
      return adminError;
    }

    return c.json(
      ListNanoHostTransportTokensResponseSchema.parse({
        items: listNanoHostTransportTokenRecords(coreDb!),
      })
    );
  });

  registerAppApiRoute(app, 'issueNanoHostTransportToken', async (c) => {
    const adminError = requireNanoHostTransportAdmin(c);
    if (adminError) {
      return adminError;
    }

    const parsed = IssueNanoHostTransportTokenRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asApiError('Invalid NanoHost transport token issue request.', 'invalid_request', 400);
    }

    const config = requireNanoHostConfig();
    if (isConfigError(config)) {
      return config;
    }

    try {
      const actorUserId = c.get('actor')?.userId ?? 'user_local';
      const issued = createNanoHostTransportTokenRecord(coreDb!, {
        deploymentId: config.deploymentId,
        expiresAt: parsed.data.expiresAt,
        ownerNanoHostIdentityId: config.identityId,
        responsibleServerAdminActorId: actorUserId,
      });
      const slotResult = deliverOrRevokeIssuedToken(coreDb!, issued, {
        deploymentId: config.deploymentId,
        identityId: config.identityId,
        sink: configuredSink(config, parsed.data.targetSlot),
        slot: parsed.data.targetSlot,
      });
      recordNanoHostTransportLifecycleAuditEvent(
        coreDb!,
        'nanohost.transport.issue',
        issued.record,
        actorUserId
      );

      return c.json(
        IssueNanoHostTransportTokenResponseSchema.parse({
          credentialRef: config.credentialRef,
          record: issued.record,
          slotResult,
          targetSlot: parsed.data.targetSlot,
        }),
        201
      );
    } catch (error) {
      return asApiError((error as Error).message, 'nanohost_transport_issue_failed', 400);
    }
  });

  registerAppApiRoute(app, 'revokeNanoHostTransportToken', (c) => {
    const adminError = requireNanoHostTransportAdmin(c);
    if (adminError) {
      return adminError;
    }

    const record = sessionAuthority
      ? revokeNanoHostTransportTokenAndFence(coreDb!, sessionAuthority, {
          tokenId: c.req.param('tokenId'),
        })
      : revokeNanoHostTransportTokenRecord(coreDb!, c.req.param('tokenId'));
    if (!record) {
      return asApiError(
        'NanoHost transport token not found.',
        'nanohost_transport_token_not_found',
        404
      );
    }

    recordNanoHostTransportLifecycleAuditEvent(
      coreDb!,
      'nanohost.transport.revoke',
      record,
      c.get('actor')?.userId ?? null
    );

    return c.json(RevokeNanoHostTransportTokenResponseSchema.parse({ record }));
  });

  registerAppApiRoute(app, 'rotateNanoHostTransportToken', async (c) => {
    const adminError = requireNanoHostTransportAdmin(c);
    if (adminError) {
      return adminError;
    }

    const parsed = RotateNanoHostTransportTokenRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asApiError(
        'Invalid NanoHost transport token rotation request.',
        'invalid_request',
        400
      );
    }

    const config = requireNanoHostConfig();
    if (isConfigError(config)) {
      return config;
    }

    try {
      const predecessorSlot = configuredSlotForToken(config, c.req.param('tokenId'));
      if (!predecessorSlot) {
        return asApiError(
          'NanoHost transport predecessor slot could not be proved.',
          'nanohost_transport_predecessor_slot_unproved',
          409
        );
      }
      const targetSlot = predecessorSlot === 'A' ? 'B' : 'A';
      const rotated = rotateNanoHostTransportTokenRecord(coreDb!, c.req.param('tokenId'), {
        overlapSeconds: parsed.data.overlapSeconds,
      });
      if (!rotated) {
        return asApiError(
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
        c.get('actor')?.userId ?? null
      );

      return c.json(
        RotateNanoHostTransportTokenResponseSchema.parse({
          credentialRef: config.credentialRef,
          record: rotated.record,
          rotatedRecord: rotated.rotatedRecord,
          slotResult,
          targetSlot,
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'nanohost_transport_rotate_failed', 400);
    }
  });

  registerAppApiRoute(app, 'abortNanoHostTransportTokenRotation', (c) => {
    const adminError = requireNanoHostTransportAdmin(c);
    if (adminError) return adminError;
    const config = requireNanoHostConfig();
    if (isConfigError(config)) return config;
    if (!sessionAuthority) {
      return asApiError(
        'NanoHost session authority is unavailable.',
        'nanohost_transport_unavailable',
        503
      );
    }
    const successor = getNanoHostTransportTokenRecord(coreDb!, c.req.param('tokenId'));
    if (!successor?.predecessorTokenId) {
      return asApiError(
        'NanoHost rotation not found.',
        'nanohost_transport_rotation_not_found',
        404
      );
    }
    const successorSlot = configuredSlotForToken(config, successor.tokenId);
    if (!successorSlot) {
      return asApiError(
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
    return c.json(AbortNanoHostTransportRotationResponseSchema.parse(aborted));
  });

  registerAppApiRoute(app, 'decommissionNanoHost', (c) => {
    const adminError = requireNanoHostTransportAdmin(c);
    if (adminError) return adminError;
    const config = requireNanoHostConfig();
    if (isConfigError(config)) return config;
    if (!sessionAuthority) {
      return asApiError(
        'NanoHost session authority is unavailable.',
        'nanohost_transport_unavailable',
        503
      );
    }
    const records = decommissionNanoHostTransportAndFence(coreDb!, sessionAuthority, {
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
      actor: { kind: 'user', id: c.get('actor').userId },
      category: 'system',
      coreDb: coreDb!,
      outcome: 'succeeded',
      resource: `nanohost-transport-identity:${config.identityId}`,
      severity: 'info',
      summary: `NanoHost ${config.identityId} decommissioned for deployment ${config.deploymentId}; newly revoked ${records.length} transport token${records.length === 1 ? '' : 's'}; retained lineage count=${retainedRecords.length}; lineage=${tokenLineage || 'none'}.`,
    });
    return c.json(
      DecommissionNanoHostResponseSchema.parse({
        identityId: config.identityId,
        revokedTokenCount: records.length,
        status: 'decommissioned',
      })
    );
  });
}
