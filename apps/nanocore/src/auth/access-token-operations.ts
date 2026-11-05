import type { ACCESS_TOKEN_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { prepareServerAuditEvent } from '../audit-events.js';
import type { CoreMode } from '../config/mode.js';
import { type FamilyImplementations, publicOperationActor } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import { resolveWorkspaceMembershipRelation } from '../workspace-sharing.js';
import {
  AccessTokenScopeError,
  createOpenKitAccessTokenSecret,
  hashOpenKitAccessTokenSecret,
} from './access-token.js';
import {
  createOpenKitAccessTokenRecord,
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
      return { record: consumed.record, token: consumed.secret };
    },
    'token.list': () => ({ items: listOpenKitAccessTokenRecords(administratorStorage()) }),
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
      let issued: ReturnType<typeof createOpenKitAccessTokenRecord>;
      try {
        issued = createOpenKitAccessTokenRecord(db, { ...input, ownerUserId });
      } catch (error) {
        if (error instanceof AccessTokenScopeError)
          throw new OperationError('access_token_issue_failed', error.message, 400, {
            cause: error,
          });
        throw error;
      }
      await recordAccessTokenLifecycleAuditEvent(db, 'auth.token.issue', issued.record, actor);
      return { record: issued.record, token: issued.secret };
    },
    'token.revoke': async (input, context) => {
      const db = administratorStorage();
      const mutation = await getControlStoreWorkerClient().accessTokenLifecycle(db, {
        kind: 'revoke',
        tokenId: input.tokenId,
      });
      if (mutation.kind !== 'revoke')
        throw new Error('Unexpected canonical token mutation result.');
      const record = mutation.record;
      if (!record)
        throw new OperationError('access_token_not_found', 'Access token not found.', 404);
      await recordAccessTokenLifecycleAuditEvent(
        db,
        'auth.token.revoke',
        record,
        publicOperationActor(context)
      );
      return { record };
    },
    'token.rotate': async (input, context) => {
      const db = administratorStorage();
      const secret = createOpenKitAccessTokenSecret();
      const mutation = await getControlStoreWorkerClient().accessTokenLifecycle(db, {
        kind: 'rotate',
        tokenId: input.tokenId,
        graceSeconds: input.graceSeconds,
        successor: {
          tokenId: allocateEntityId('tok'),
          tokenHash: hashOpenKitAccessTokenSecret(secret),
        },
      });
      if (mutation.kind !== 'rotate')
        throw new Error('Unexpected canonical token mutation result.');
      const rotated = mutation.value;
      if (!rotated)
        throw new OperationError(
          'access_token_not_found',
          'Access token not found or not rotatable.',
          404
        );
      await recordAccessTokenLifecycleAuditEvent(
        db,
        'auth.token.rotate',
        rotated.record,
        publicOperationActor(context)
      );
      return {
        record: rotated.record,
        rotatedRecord: rotated.rotatedRecord,
        token: secret,
      };
    },
    'token.my-admin-list': (_input, context) =>
      listOwnedServerAdminAccessTokens(storage(), publicOperationActor(context).userId),
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
      return listOwnedServerAdminAccessTokens(db, actor.userId);
    },
  } satisfies FamilyImplementations<typeof ACCESS_TOKEN_OPERATION_DEFINITIONS>;
}
