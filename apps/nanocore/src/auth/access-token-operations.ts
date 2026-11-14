import type {
  ACCESS_TOKEN_OPERATION_DEFINITIONS,
  OpenKitAccessTokenRecord as PublicOpenKitAccessTokenRecord,
} from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { prepareServerAuditEvent } from '../audit-events.js';
import type { CoreMode } from '../config/mode.js';
import { type FamilyImplementations, publicOperationActor } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { presentControlFacts } from '../storage/control-store-input.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import { resolveWorkspaceMembershipRelation } from '../workspace-sharing.js';
import {
  AccessTokenScopeError,
  createOpenKitAccessTokenSecret,
  hashOpenKitAccessTokenSecret,
  normalizeOpenKitAccessTokenScope,
} from './access-token.js';
import type { ControlAccessTokenLifecycleResult } from './access-token-lifecycle-codecs.js';
import {
  listOpenKitAccessTokenRecords,
  listOwnedServerAdminAccessTokens,
  type OpenKitAccessTokenRecord,
} from './access-token-store.js';
import { auditAuthenticationFromActor } from './audit-attribution.js';
import { consumeServerBootstrapToken } from './bootstrap-token.js';
import type { Actor } from './identity.js';
import { isCanonicalUserActive } from './user-lifecycle.js';

/**
 * Builds the redacted requester suffix for one access-token lifecycle audit event.
 *
 * @param actor Authenticated request actor when present.
 * @returns Summary suffix naming the user and non-secret derived or presented admin token id.
 */
function accessTokenLifecycleActorSuffix(actor: Actor | undefined): string {
  if (!actor?.userId) {
    return '';
  }

  if (actor.kind === 'session' && actor.adminTokenId) {
    return ` Requested by ${actor.userId} using derived admin ${actor.adminTokenId}.`;
  }

  if (actor.kind === 'token' && actor.tokenId) {
    return ` Requested by ${actor.userId} using presented admin ${actor.tokenId}.`;
  }

  return ` Requested by ${actor.userId}.`;
}

/**
 * Records a server audit event for one successful access-token lifecycle operation.
 *
 * @param coreDb Server database that owns the event.
 * @param action Stable access-token lifecycle action.
 * @param record Redacted access-token record affected by the operation.
 * @param actor Request actor used for user and non-secret admin-token attribution.
 */
async function recordAccessTokenLifecycleAuditEvent(
  coreDb: CoreDb,
  action: 'auth.token.issue' | 'auth.token.revoke' | 'auth.token.rotate',
  record: OpenKitAccessTokenRecord,
  actor: Actor | undefined
): Promise<void> {
  const actorSuffix = accessTokenLifecycleActorSuffix(actor);
  let summary: string;
  switch (action) {
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

  // The canonical token mutation has already returned; only this later Audit moves.
  await getControlStoreWorkerClient().standaloneAudit(coreDb, {
    stage: action,
    event: prepareServerAuditEvent({
      action,
      coreDb,
      category: 'system',
      actor: actor ? { kind: 'user', id: actor.userId } : null,
      ...(actor ? { authentication: auditAuthenticationFromActor(actor) } : {}),
      outcome: 'succeeded',
      resource: `auth-token:${record.tokenId}`,
      severity: 'info',
      summary,
    }),
  });
}

/** Preserves the existing public refusal codes after native current-fact revalidation. */
function requireTokenLifecycleResult(
  result: ControlAccessTokenLifecycleResult
): Exclude<ControlAccessTokenLifecycleResult, { kind: 'denied' }> {
  if (result.kind !== 'denied') return result;
  const refusal = {
    deployment_admin_required: {
      message: 'Current deployment administrator authority is required.',
      status: 403,
    },
    workspace_access_denied: { message: 'Workspace access denied.', status: 403 },
    access_token_owner_invalid: {
      message: 'Access token owner must be an exact active canonical user.',
      status: 400,
    },
    'core.auth.scope_forbidden': {
      message: 'Access token scope does not allow this request.',
      status: 403,
    },
  } as const;
  const denied = refusal[result.code];
  throw new OperationError(result.code, denied.message, denied.status);
}

/** Keep the new native issuance link private; the existing closed public record stays unchanged. */
function publicTokenRecord(record: OpenKitAccessTokenRecord): PublicOpenKitAccessTokenRecord {
  return {
    tokenId: record.tokenId,
    ownerUserId: record.ownerUserId,
    scope: record.scope,
    workspaceIds: record.workspaceIds,
    status: record.status,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    predecessorTokenId: record.predecessorTokenId,
    rotatedGraceExpiresAt: record.rotatedGraceExpiresAt,
    lastUsedAt: record.lastUsedAt,
    lastUsedChannel: record.lastUsedChannel,
    lastUsedSource: record.lastUsedSource,
  };
}

/** Preserve the existing owned-list projection without exposing private issuer references. */
function publicOwnedAdminTokens(coreDb: CoreDb, userId: string) {
  const listed = listOwnedServerAdminAccessTokens(coreDb, userId);
  return { defaultTokenId: listed.defaultTokenId, items: listed.items.map(publicTokenRecord) };
}

/** Joins the human credential family to the existing token, bootstrap, membership and audit owners. */
export function createAccessTokenOperationImplementations({
  coreDb,
  mode,
}: {
  readonly coreDb: CoreDb | undefined;
  readonly mode: CoreMode;
}) {
  const storage = () => {
    if (!coreDb)
      throw new OperationError(
        'access_token_storage_unavailable',
        'Access-token storage is unavailable.',
        503
      );
    return coreDb;
  };
  const administratorStorage = () => {
    if (mode !== 'server')
      throw new OperationError(
        'access_token_admin_server_mode_required',
        'Access-token administration is only available in server mode.',
        404
      );
    return storage();
  };
  return {
    'bootstrap.consume': async (input) => {
      if (mode !== 'server')
        throw new OperationError(
          'not_found',
          'Server bootstrap is only available in server mode.',
          404
        );
      if (!coreDb)
        throw new OperationError(
          'bootstrap_unavailable',
          'Server bootstrap storage is unavailable.',
          503
        );
      const consumed = await consumeServerBootstrapToken(coreDb, input);
      if (consumed.status !== 'consumed') {
        if (consumed.status === 'admin_expiry')
          throw new OperationError(
            'bootstrap_admin_token_expiry',
            'Administrator token expiration must be strictly after the server clock.',
            400
          );
        if (consumed.status === 'unavailable')
          throw new OperationError(
            'bootstrap_unavailable',
            'Server bootstrap is unavailable.',
            409
          );
        throw new OperationError('bootstrap_invalid', 'Invalid bootstrap token.', 401);
      }
      const record = consumed.record;
      const actorSuffix = accessTokenLifecycleActorSuffix(undefined);
      await getControlStoreWorkerClient().standaloneAudit(coreDb, {
        stage: 'auth.bootstrap.consume',
        event: prepareServerAuditEvent({
          coreDb,
          action: 'auth.bootstrap.consume',
          category: 'system',
          actor: null,
          outcome: 'succeeded',
          resource: `auth-token:${record.tokenId}`,
          severity: 'info',
          summary: `Bootstrap token consumed for owner ${record.ownerUserId}.${actorSuffix}`,
        }),
      });
      return { record: publicTokenRecord(consumed.record), token: consumed.secret };
    },
    'token.list': () => ({
      items: listOpenKitAccessTokenRecords(administratorStorage()).map(publicTokenRecord),
    }),
    'token.create': async (input, context) => {
      const db = administratorStorage();
      const actor = publicOperationActor(context);
      const ownerUserId = input.ownerUserId ?? actor.userId;
      if (!isCanonicalUserActive(db, ownerUserId))
        throw new OperationError(
          'access_token_owner_invalid',
          'Access token owner must be an exact active canonical user.',
          400
        );
      if (
        input.scope !== 'server-admin' &&
        input.workspaceIds.some(
          (id) => resolveWorkspaceMembershipRelation(db, id, ownerUserId) === null
        )
      )
        throw new OperationError(
          'core.auth.scope_forbidden',
          'Access token scope does not allow this request.',
          403
        );
      let record: OpenKitAccessTokenRecord;
      let secret: string;
      try {
        const binding = normalizeOpenKitAccessTokenScope(input.scope, input.workspaceIds);
        const tokenId = allocateEntityId('tok');
        secret = createOpenKitAccessTokenSecret();
        const mutation = requireTokenLifecycleResult(
          await getControlStoreWorkerClient().accessTokenLifecycle(db, {
            kind: 'issue',
            actor: presentControlFacts(actor),
            ownerUserId,
            scope: binding.scope,
            workspaceIds: binding.workspaceIds,
            expiresAt: input.expiresAt,
            token: { tokenId, tokenHash: hashOpenKitAccessTokenSecret(secret) },
          })
        );
        if (mutation.kind !== 'issue')
          throw new Error('Unexpected canonical token mutation result.');
        record = mutation.record;
      } catch (error) {
        if (error instanceof AccessTokenScopeError)
          throw new OperationError('access_token_issue_failed', error.message, 400, {
            cause: error,
          });
        throw error;
      }
      await recordAccessTokenLifecycleAuditEvent(db, 'auth.token.issue', record, actor);
      return { record: publicTokenRecord(record), token: secret };
    },
    'token.revoke': async (input, context) => {
      const db = administratorStorage();
      const actor = publicOperationActor(context);
      const mutation = requireTokenLifecycleResult(
        await getControlStoreWorkerClient().accessTokenLifecycle(db, {
          kind: 'revoke',
          actor: presentControlFacts(actor),
          tokenId: input.tokenId,
        })
      );
      if (mutation.kind !== 'revoke')
        throw new Error('Unexpected canonical token mutation result.');
      const record = mutation.record;
      if (!record)
        throw new OperationError('access_token_not_found', 'Access token not found.', 404);
      await recordAccessTokenLifecycleAuditEvent(db, 'auth.token.revoke', record, actor);
      return { record: publicTokenRecord(record) };
    },
    'token.rotate': async (input, context) => {
      const db = administratorStorage();
      const actor = publicOperationActor(context);
      const secret = createOpenKitAccessTokenSecret();
      const mutation = requireTokenLifecycleResult(
        await getControlStoreWorkerClient().accessTokenLifecycle(db, {
          kind: 'rotate',
          actor: presentControlFacts(actor),
          tokenId: input.tokenId,
          graceSeconds: input.graceSeconds,
          successor: {
            tokenId: allocateEntityId('tok'),
            tokenHash: hashOpenKitAccessTokenSecret(secret),
          },
        })
      );
      if (mutation.kind !== 'rotate')
        throw new Error('Unexpected canonical token mutation result.');
      const rotated = mutation.value;
      if (!rotated)
        throw new OperationError(
          'access_token_not_found',
          'Access token not found or not rotatable.',
          404
        );
      await recordAccessTokenLifecycleAuditEvent(db, 'auth.token.rotate', rotated.record, actor);
      return {
        record: publicTokenRecord(rotated.record),
        rotatedRecord: publicTokenRecord(rotated.rotatedRecord),
        token: secret,
      };
    },
    'token.my-admin-list': (_input, context) =>
      publicOwnedAdminTokens(storage(), publicOperationActor(context).userId),
    'token.my-admin-default': async (input, context) => {
      const db = storage();
      const actor = publicOperationActor(context);
      if (
        !(await getControlStoreWorkerClient().serverAdminTokenDefault(db, {
          ownerUserId: actor.userId,
          tokenId: input.tokenId,
        }))
      )
        throw new OperationError(
          'access_token_default_invalid',
          'Default token must be an owned usable server-admin token.',
          400
        );
      return publicOwnedAdminTokens(db, actor.userId);
    },
  } satisfies FamilyImplementations<typeof ACCESS_TOKEN_OPERATION_DEFINITIONS>;
}
