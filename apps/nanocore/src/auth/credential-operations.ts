import { randomUUID } from 'node:crypto';
import type {
  ACCESS_TOKEN_OPERATION_DEFINITIONS,
  INBOUND_CREDENTIAL_OPERATION_DEFINITIONS,
  InboundCredentialRecord,
  OpenKitAccessTokenRecord as PublicOpenKitAccessTokenRecord,
} from '@openkit/app-api-schemas';
import { allocateEntityId, responsibleUserIdForActor } from '@openkit/protocol';
import { prepareServerAuditEvent } from '../audit-events.js';
import type { CoreMode } from '../config/mode.js';
import type { FsStore } from '../lib/store.js';
import { type FamilyImplementations, publicOperationActor } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import type { InflightIdempotentCommand } from '../runtime/idempotent-command.js';
import type { TurnExecutor } from '../runtime/types.js';
import type { WorkerControlGateway } from '../runtime/worker-control-gateway.js';
import { findSchedulerAdmissionForTurn } from '../scheduler-records.js';
import { presentControlFacts } from '../storage/control-store-input.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import type { StorageResult } from '../storage/storage-owner.js';
import { interruptProductTurn } from '../turn-routes.js';
import { resolveWorkspaceMembershipRelation } from '../workspace-sharing.js';
import {
  AccessTokenScopeError,
  createOpenKitAccessTokenSecret,
  hashOpenKitAccessTokenSecret,
  normalizeOpenKitAccessTokenScope,
} from './access-token.js';
import type { ControlAccessTokenLifecycleResult } from './access-token-lifecycle-codecs.js';
import {
  getOpenKitAccessTokenRecord,
  listOpenKitAccessTokenRecords,
  listOwnedServerAdminAccessTokens,
  type OpenKitAccessTokenRecord,
} from './access-token-store.js';
import { auditAuthenticationFromActor } from './audit-attribution.js';
import { commitBetterAuthStage } from './better-auth-adapter.js';
import { consumeServerBootstrapToken } from './bootstrap-token.js';
import type { Actor } from './identity.js';
import { revokeNanoHostInboundCredential } from './nanohost-operations.js';
import type { NanoHostTransportSessionAuthority } from './nanohost-transport-session.js';
import {
  listNanoHostTransportTokenRecords,
  type NanoHostTransportTokenRecord,
} from './nanohost-transport-token-store.js';
import { isCurrentDeploymentAdministrator } from './operation-authorizer.js';
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

/** Credential projection from the deployment's admitted communication owner. */
export interface CommunicationCredentials {
  readBinding(
    userId: string
  ): StorageResult<
    'communication',
    { readonly revision: string; readonly pairedAt: number } | null
  >;
  unbind(input: {
    readonly actor: Actor;
    readonly bindingRevision: string;
  }): Promise<StorageResult<'communication', void>>;
}

/** Existing owners supplied by App assembly. */
export interface InboundCredentialOwners {
  readonly coreDb: CoreDb | undefined;
  readonly mode: CoreMode;
  readonly store?: FsStore;
  readonly workerControlGateway?: WorkerControlGateway;
  readonly turnExecutor?: TurnExecutor;
  readonly inflightCommands?: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly nanoHostSessionAuthority?: NanoHostTransportSessionAuthority;
}

type BindingSelection = Parameters<CommunicationCredentials['unbind']>[0];
type TransportTokens = StorageResult<'nanohost', readonly NanoHostTransportTokenRecord[]>;

interface CredentialStorage {
  readBinding(db: CoreDb, userId: string): ReturnType<CommunicationCredentials['readBinding']>;
  unbind(db: CoreDb, input: BindingSelection): ReturnType<CommunicationCredentials['unbind']>;
  transportTokens(db: CoreDb): TransportTokens;
}

const unavailableCommunication = {
  state: 'unavailable',
  owner: 'communication',
  reason: 'missing',
} as const;

/** Keeps the independent credential owners available before the Communication adapter is selected. */
export function createCredentialOperationImplementations(owners: InboundCredentialOwners) {
  return createCredentialOperations(owners, {
    readBinding: () => unavailableCommunication,
    unbind: async () => unavailableCommunication,
    transportTokens: (db) => ({ state: 'ready', value: listNanoHostTransportTokenRecords(db) }),
  });
}

/** Composition entry for the cutover. The live App can supply it after both owner adapters land. */
export function createCommunicationCredentialOperationImplementations(
  owners: InboundCredentialOwners & {
    readonly communicationCredentials?: CommunicationCredentials;
    readonly listNanoHostTransportTokens?: () => TransportTokens;
  }
) {
  return createCredentialOperations(owners, {
    readBinding: (_db, userId) =>
      owners.communicationCredentials?.readBinding(userId) ?? unavailableCommunication,
    unbind: async (_db, input) =>
      owners.communicationCredentials?.unbind(input) ?? unavailableCommunication,
    transportTokens: () =>
      owners.listNanoHostTransportTokens?.() ?? {
        state: 'unavailable',
        owner: 'nanohost',
        reason: 'missing',
      },
  });
}

/** Joins the human credential family to one selected set of storage owners. */
function createCredentialOperations(
  owners: InboundCredentialOwners,
  credentialStorage: CredentialStorage
) {
  const { coreDb, mode } = owners;
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
  const missing = () => new OperationError('credential_not_found', 'Credential not found.', 404);
  const communicationUnavailable = () =>
    new OperationError('channel_storage_unavailable', 'Communication storage is unavailable.', 503);
  const runs = (userId: string) =>
    owners.workerControlGateway?.listCredentialRuns().filter((run) => {
      const admission = findSchedulerAdmissionForTurn(storage(), run);
      return admission && responsibleUserIdForActor(admission.triggerActor) === userId;
    }) ?? [];
  return {
    'credential.list': (_input, context) => {
      const actor = publicOperationActor(context);
      const db = storage();
      const administrator = owners.mode === 'server' && isCurrentDeploymentAdministrator(db, actor);
      const items: InboundCredentialRecord[] = listOpenKitAccessTokenRecords(db)
        .filter((record) => administrator || record.ownerUserId === actor.userId)
        .map((record) => ({
          kind: 'access-token',
          id: record.tokenId,
          record: publicTokenRecord(record),
          integrationId: record.principalRef?.id ?? null,
        }));
      const sessions = db.sqlite
        .prepare(
          'SELECT id, created_at AS issuedAt, expires_at AS expiresAt FROM session WHERE user_id = ? ORDER BY created_at, id'
        )
        .all(actor.userId) as { id: string; issuedAt: number; expiresAt: number }[];
      for (const session of sessions)
        items.push({
          kind: 'auth-session',
          id: session.id,
          issuedAt: new Date(session.issuedAt).toISOString(),
          expiresAt: new Date(session.expiresAt).toISOString(),
          status: session.expiresAt > Date.now() ? 'active' : 'expired',
          current: actor.kind === 'session' && actor.sessionId === session.id,
        });
      const binding = credentialStorage.readBinding(db, actor.userId);
      if (binding.state === 'ready' && binding.value)
        items.push({
          kind: 'discord-pairing',
          id: binding.value.revision,
          issuedAt: new Date(binding.value.pairedAt).toISOString(),
        });
      for (const run of runs(actor.userId)) {
        const turn = owners.store?.getTurnById(run.turnId);
        items.push({
          kind: 'worker-run',
          id: run.turnId,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          turnId: run.turnId,
          agentSessionId: run.agentSessionId,
          status:
            turn && ['completed', 'failed', 'interrupted'].includes(turn.status)
              ? 'closing'
              : 'open',
          issuedAt: run.registeredAt,
          expiresAt: null,
        });
      }
      if (administrator) {
        const transportTokens = credentialStorage.transportTokens(db);
        if (transportTokens.state === 'ready')
          for (const record of transportTokens.value)
            items.push({ kind: 'nanohost-transport', id: record.tokenId, record });
      }
      return { items, canManageServerCredentials: administrator };
    },
    'credential.revoke': async (input, context) => {
      const actor = publicOperationActor(context);
      const db = storage();
      switch (input.kind) {
        case 'access-token': {
          const current = getOpenKitAccessTokenRecord(db, input.id);
          const administrator =
            owners.mode === 'server' && isCurrentDeploymentAdministrator(db, actor);
          if (!current || (current.ownerUserId !== actor.userId && !administrator)) throw missing();
          const result = requireTokenLifecycleResult(
            await getControlStoreWorkerClient().accessTokenLifecycle(db, {
              kind: 'revoke',
              actor: presentControlFacts(actor),
              tokenId: input.id,
            })
          );
          if (result.kind !== 'revoke' || !result.record) throw missing();
          await recordAccessTokenLifecycleAuditEvent(db, 'auth.token.revoke', result.record, actor);
          return { status: 'revoked' as const };
        }
        case 'auth-session': {
          const current = db.sqlite
            .prepare('SELECT id FROM session WHERE id = ? AND user_id = ?')
            .get(input.id, actor.userId);
          if (!current) throw missing();
          await commitBetterAuthStage(db, {
            kind: 'session-owned-delete',
            sessionId: input.id,
            requestActor: presentControlFacts(actor),
          });
          return { status: 'revoked' as const };
        }
        case 'discord-pairing': {
          const binding = credentialStorage.readBinding(db, actor.userId);
          if (binding.state !== 'ready') throw communicationUnavailable();
          if (binding.value?.revision !== input.id) throw missing();
          const result = await credentialStorage.unbind(db, { actor, bindingRevision: input.id });
          if (result.state !== 'ready') throw communicationUnavailable();
          return { status: 'revoked' as const };
        }
        case 'nanohost-transport': {
          if (owners.mode !== 'server' || !isCurrentDeploymentAdministrator(db, actor))
            throw missing();
          await revokeNanoHostInboundCredential(
            {
              coreDb: db,
              mode: owners.mode,
              ...(owners.nanoHostSessionAuthority
                ? { sessionAuthority: owners.nanoHostSessionAuthority }
                : {}),
            },
            input.id,
            context
          );
          return { status: 'revoked' as const };
        }
        case 'worker-run': {
          const run = runs(actor.userId).find((run) => run.turnId === input.id);
          if (!run) throw missing();
          if (!owners.store || !owners.turnExecutor || !owners.inflightCommands)
            throw new OperationError(
              'operation_storage_unavailable',
              'Worker cancellation is unavailable.',
              503
            );
          await context.recheckAdmission?.();
          if (
            ['completed', 'failed', 'interrupted'].includes(
              owners.store.getTurnById(run.turnId).status
            )
          )
            return { status: 'ending' as const };
          await interruptProductTurn({
            store: owners.store,
            coreDb: db,
            inflightCommands: owners.inflightCommands,
            turnExecutor: owners.turnExecutor,
            workspaceId: run.workspaceId,
            threadId: run.threadId,
            turnId: run.turnId,
            requestId: randomUUID(),
            actor: context.actorRef,
          });
          return {
            status: owners.workerControlGateway?.getSessionSnapshot(run.packageSnapshotId)
              ? ('ending' as const)
              : ('revoked' as const),
          };
        }
      }
    },
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
    'token.create': async (input, context) => {
      const db = administratorStorage();
      const actor = publicOperationActor(context);
      const ownerUserId = input.ownerUserId ?? actor.userId;
      if (input.forMcpClient && input.scope === 'server-admin')
        throw new OperationError(
          'core.auth.scope_forbidden',
          'MCP clients cannot administer the Server.',
          400
        );
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
            ...(input.forMcpClient === undefined ? {} : { forMcpClient: input.forMcpClient }),
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
  } satisfies FamilyImplementations<
    typeof ACCESS_TOKEN_OPERATION_DEFINITIONS & typeof INBOUND_CREDENTIAL_OPERATION_DEFINITIONS
  >;
}
