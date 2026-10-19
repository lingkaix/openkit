import {
  type VaultGrantRequestTerms,
  VaultGrantRequestTermsSchema,
  type VaultGrantRequestView,
} from '@openkit/app-api-schemas';
import { resolveWorkspaceMcpServer } from '@openkit/config-schema';
import {
  AccessTokenIdSchema,
  type ActorRef,
  AgentSessionIdSchema,
  allocateEntityId,
  isSealedTurnTerminal,
  responsibleUserIdForActor,
  ThreadIdSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import {
  authorizeWorkspace,
  currentWorkerLineageWorkspaceAuthority,
  requireCurrentDeploymentAdmin,
} from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import { composeWorkspaceMcpCatalog } from '../catalog/resource-catalog.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import {
  type AdmittedOperationContext,
  type OperationImplementations,
  publicOperationActor,
} from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { recordProductPermissionDecision } from '../policy/permission-decisions.js';
import { readAuditEventRowV1 } from '../policy/retained-records-v1.js';
import { findNamedAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { projectApprovalEffect } from '../runtime/pending-request-disclosure.js';
import {
  admitIfIdle,
  raiseRecordedPendingRequest,
  requireUsableRecord,
} from '../runtime/pending-request-flow.js';
import {
  canonicalJsonText,
  claimCommandIntentGrant,
  finishPendingExecution,
  listThreadPendingRequests,
  PendingRequestCommandError,
  type PendingRequestRecord,
  preflightPendingRequest,
  readPendingRequest,
  refuseCommandIntentGrant,
} from '../runtime/pending-requests.js';
import type { WorkspaceDb } from '../storage/db.js';
import { isCurrentServerMcpMaterial } from './server-mcp-authority.js';
import { recordVaultAdminAuditEvent } from './vault-admin-audit-events.js';
import { createVaultGrant, getVaultGrant } from './vault-grants.js';
import { getVaultReference } from './vault-references.js';

/** Uses only the existing request, grant, material and current authorization owners. */
type Dependencies = Pick<
  OperationInvocationDependencies,
  'coreDb' | 'store' | 'repositoryWorkspaceDb' | 'vaultUnlockState' | 'pendingRequestServices'
>;

const ActorSchema = z
  .object({
    userId: UserIdSchema,
    kind: z.enum(['local', 'session', 'token']),
    tokenId: AccessTokenIdSchema.optional(),
    tokenScope: z.enum(['server-admin', 'workspace', 'workspace-readonly']).optional(),
    tokenWorkspaceIds: z.array(WorkspaceIdSchema).optional(),
    adminTokenId: AccessTokenIdSchema.optional(),
  })
  .strict();
const OriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('public'), actor: ActorSchema }).strict(),
  z
    .object({
      kind: z.literal('worker'),
      actor: z
        .object({
          kind: z.enum(['user', 'agent', 'system']),
          id: z.string(),
          responsibleUserId: UserIdSchema.nullable().optional(),
        })
        .strict()
        .superRefine((actor, ctx) => {
          // Only a User actor names a Core entity; Agent and system selectors stay opaque.
          if (actor.kind === 'user' && !UserIdSchema.safeParse(actor.id).success)
            ctx.addIssue({
              code: 'custom',
              path: ['id'],
              message: 'Canonical User identity is required.',
            });
        }),
      lineage: z
        .object({
          workspaceId: WorkspaceIdSchema,
          threadId: ThreadIdSchema,
          turnId: TurnIdSchema,
          agentSessionId: AgentSessionIdSchema,
          packageSnapshotId: z.string(),
        })
        .strict(),
    })
    .strict(),
]);
const IntentSchema = z
  .object({
    operation: z.literal('vault.grant-issue'),
    terms: VaultGrantRequestTermsSchema,
    origin: OriginSchema,
  })
  .strict();

/** Selects only this effect owner; unrelated command intents keep their existing owner. */
export function isVaultGrantRequest(record: PendingRequestRecord): boolean {
  return (
    record.kind === 'approval' &&
    record.serverId === null &&
    record.governedIntent?.operation === 'vault.grant-issue'
  );
}

/** Captured session administration cannot silently switch to a replacement administrator Token. */
function administrator(dependencies: Dependencies, actor: Actor): void {
  if (!dependencies.coreDb)
    throw new PendingRequestCommandError(
      'vault_storage_unavailable',
      'Vault storage is unavailable.',
      503
    );
  let authority: ReturnType<typeof requireCurrentDeploymentAdmin>;
  try {
    authority = requireCurrentDeploymentAdmin(dependencies.coreDb, actor);
  } catch {
    throw new PendingRequestCommandError(
      'deployment_admin_required',
      'Current deployment administrator authority is required.',
      403
    );
  }
  if (actor.kind === 'session' && authority.tokenId !== actor.adminTokenId)
    throw new PendingRequestCommandError(
      'deployment_admin_required',
      'The deciding administrator credential is no longer current.',
      403
    );
}

/** Checks supported terms and exact active material metadata without resolving any secret. */
function currentReference(
  dependencies: Dependencies,
  workspaceId: string,
  terms: VaultGrantRequestTerms
): void {
  const backend = dependencies.vaultUnlockState?.backend();
  if (!dependencies.coreDb || !backend)
    throw new PendingRequestCommandError(
      'vault_storage_unavailable',
      'Vault storage is unavailable.',
      503
    );
  if (backend.health().state !== 'available')
    throw new PendingRequestCommandError(
      'vault_backend_not_available',
      'Vault backend is not available.',
      423
    );
  if (terms.expiresAt && Date.parse(terms.expiresAt) <= Date.now())
    throw new PendingRequestCommandError(
      'vault_request_stale',
      'The requested expiry is no longer in the future.',
      409
    );
  const reference = getVaultReference(dependencies.coreDb, terms.referenceId);
  if (terms.ownerScope === 'server') {
    if (!reference || !isCurrentServerMcpMaterial(backend, reference))
      throw new PendingRequestCommandError(
        'vault_reference_not_active',
        'Current shared-MCP material authority is unavailable.',
        409
      );
    return;
  }
  if (
    !reference ||
    reference.status !== 'active' ||
    reference.ownerScope !== 'workspace' ||
    reference.workspaceId !== workspaceId ||
    reference.userId !== null
  )
    throw new PendingRequestCommandError(
      'vault_reference_not_active',
      'Current Workspace material authority is unavailable.',
      409
    );
  const material = backend
    .listReferences({ ownerScope: 'workspace', workspaceId })
    .find((row) => row.referenceId === reference.referenceId);
  if (
    !material ||
    material.revoked ||
    material.ownerScope !== 'workspace' ||
    material.workspaceId !== workspaceId ||
    material.userId !== undefined ||
    material.providerSubscriptionAccount !== undefined ||
    material.currentVersion !== reference.currentVersion ||
    material.backendKind !== reference.backendKind ||
    reference.backendKind !== backend.kind ||
    reference.backendLocator !==
      `${backend.kind}://workspace/${workspaceId}/vault/${reference.referenceId}`
  )
    throw new PendingRequestCommandError(
      'vault_recovery_required',
      'Vault storage requires inspection.',
      409
    );
  if (terms.injectionPath === 'runtime-env' && reference.secretKind !== 'github-token')
    throw new PendingRequestCommandError(
      'invalid_request',
      'Runtime environment grants require a GitHub token reference.',
      400
    );
}

/** Admit metadata only from the human's readable owner or the Worker's exact current package and canonical selected slot. */
function assertRequestSelection(
  dependencies: Dependencies,
  db: WorkspaceDb,
  workspaceId: string,
  terms: VaultGrantRequestTerms,
  origin: z.infer<typeof OriginSchema>
): void {
  const denied = () =>
    new PendingRequestCommandError(
      'workspace_access_denied',
      'Credential request target is unavailable.',
      403
    );
  if (origin.kind === 'public') {
    if (terms.ownerScope === 'server') administrator(dependencies, origin.actor as Actor);
    else if (
      !authorizeWorkspace(dependencies.coreDb!, origin.actor as Actor, workspaceId, {
        policyOperation: 'vault.admin',
        mutating: false,
      })
    )
      throw denied();
    return;
  }
  try {
    const record = findNamedAgentEnvironmentPackageSnapshot(
      db,
      workspaceId,
      origin.lineage.agentSessionId,
      origin.lineage.packageSnapshotId
    );
    const snapshot = record?.snapshot;
    if (
      !snapshot ||
      snapshot.scope.workspaceId !== workspaceId ||
      snapshot.scope.threadId !== origin.lineage.threadId ||
      snapshot.scope.turnId !== origin.lineage.turnId ||
      snapshot.scope.agentSessionId !== origin.lineage.agentSessionId ||
      snapshot.agent.agentId !== dependencies.store!.getTurnById(origin.lineage.turnId).agentId ||
      canonicalJsonText(snapshot.scope.triggerActor) !== canonicalJsonText(origin.actor)
    )
      throw denied();
    if (terms.mcpSource) {
      const selected = snapshot.supply.mcpServers.find(
        (entry) => entry.id === terms.mcpSource!.serverId
      );
      const catalog = composeWorkspaceMcpCatalog({
        dataRoot: dependencies.coreDb!.dataRoot,
        workspaceId,
      });
      const current = resolveWorkspaceMcpServer({ catalog, serverId: terms.mcpSource.serverId });
      if (
        !selected ||
        !current.enabled ||
        selected.catalogDigest !== current.catalogDigest ||
        (current.scope ?? 'workspace') !== terms.ownerScope ||
        terms.injectionPath !== 'gateway-only'
      )
        throw denied();
      const binding = current.credentialBindings.find(
        (entry) => entry.slot === terms.mcpSource!.slot
      );
      const grant = binding ? getVaultGrant(dependencies.coreDb!, binding.vaultGrantId) : null;
      if (
        !grant ||
        grant.vaultReferenceId !== terms.referenceId ||
        grant.ownerScope !== terms.ownerScope ||
        grant.workspaceId !== (terms.ownerScope === 'workspace' ? workspaceId : null)
      )
        throw denied();
      return;
    }
    if (
      terms.ownerScope !== 'workspace' ||
      !snapshot.vault.references.some(
        (entry) =>
          entry.id === terms.referenceId &&
          entry.kind === 'secret-ref' &&
          entry.secretRef === `vault://${terms.referenceId}`
      )
    )
      throw denied();
  } catch {
    throw denied();
  }
}

/** Re-evaluates the actual original requester without treating a request as secret-use authority. */
function currentRequester(dependencies: Dependencies, record: PendingRequestRecord): void {
  const intent = IntentSchema.safeParse(record.governedIntent);
  const coreDb = dependencies.coreDb;
  const store = dependencies.store;
  if (!intent.success || !coreDb || !store)
    throw new PendingRequestCommandError(
      'recovery_required',
      'The captured Vault request cannot be verified.',
      409
    );
  const { origin } = intent.data;
  if (origin.kind === 'public' && origin.actor.kind === 'session' && origin.actor.adminTokenId)
    administrator(dependencies, origin.actor as Actor);
  const actorId =
    origin.kind === 'public'
      ? origin.actor.userId
      : responsibleUserIdForActor(origin.actor as ActorRef);
  const turn = origin.kind === 'worker' ? store.getTurnById(origin.lineage.turnId) : null;
  const requestingAgent =
    turn?.agentId && turn.agentSessionId && actorId
      ? {
          kind: 'agent' as const,
          userId: actorId,
          agentId: turn.agentId,
          processId: turn.agentSessionId,
        }
      : undefined;
  const authorized =
    origin.kind === 'public'
      ? authorizeWorkspace(coreDb, origin.actor as Actor, record.workspaceId, {
          policyOperation: 'workspace.write',
          mutating: true,
        })
      : currentWorkerLineageWorkspaceAuthority(
          coreDb,
          { ...origin.lineage, triggerActor: origin.actor as ActorRef },
          'workspace.write',
          true
        );
  if (
    !authorized ||
    actorId !== record.responsibleUserId ||
    (origin.kind === 'worker' && !requestingAgent) ||
    !isThreadIdVisible(
      store,
      record.workspaceId,
      record.threadId,
      actorId ?? undefined,
      origin.kind === 'public' &&
        Boolean(
          origin.actor.kind === 'local' ||
            origin.actor.adminTokenId ||
            origin.actor.tokenScope === 'server-admin'
        ),
      'workspace.write',
      requestingAgent
    )
  )
    throw new PendingRequestCommandError(
      'workspace_access_denied',
      'The original requester is no longer authorized.',
      403
    );
  const thread = store.getThread(record.workspaceId, record.threadId);
  if (thread.status === 'archived')
    throw new PendingRequestCommandError(
      'vault_request_stale',
      'The request Thread is archived.',
      409
    );
  if (origin.kind === 'worker') {
    if (
      !turn ||
      turn.workspaceId !== record.workspaceId ||
      turn.threadId !== record.threadId ||
      turn.agentId !== record.agentId ||
      turn.agentSessionId !== record.agentSessionId ||
      turn.agentSessionId !== origin.lineage.agentSessionId
    )
      throw new PendingRequestCommandError(
        'recovery_required',
        'The requesting Worker lineage cannot be verified.',
        409
      );
    if (
      dependencies.pendingRequestServices?.agentAuthority &&
      !dependencies.pendingRequestServices.agentAuthority(record)
    )
      throw new PendingRequestCommandError(
        'workspace_access_denied',
        'The requesting Agent is no longer authorized.',
        403
      );
  }
  const db = dependencies.repositoryWorkspaceDb!(record.workspaceId);
  try {
    assertRequestSelection(dependencies, db, record.workspaceId, intent.data.terms, origin);
  } finally {
    db.sqlite.close();
  }
  currentReference(dependencies, record.workspaceId, intent.data.terms);
}

/** The grant decision keeps the effect owner's strict administrative and current requester boundary. */
export function checkVaultGrantCommandIntent(
  dependencies: Dependencies,
  record: PendingRequestRecord,
  actor: Actor
): void {
  if (!isVaultGrantRequest(record)) return;
  administrator(dependencies, actor);
  if (
    !authorizeWorkspace(dependencies.coreDb!, actor, record.workspaceId, {
      policyOperation: 'vault.admin',
      mutating: true,
    })
  )
    throw new PendingRequestCommandError(
      'workspace_access_denied',
      'Workspace access denied.',
      403
    );
  currentRequester(dependencies, record);
}

/** Reads the immutable issue Audit link, which survives later narrowing and held-result cleanup. */
function issuedGrantId(dependencies: Dependencies, requestId: string): string | null {
  const rows = dependencies.coreDb?.sqlite
    .prepare("SELECT * FROM audit_events WHERE action = 'vault.grant-issue' AND resource = ?")
    .all(`approval:${requestId}`) as { vault_grant_id: string | null }[] | undefined;
  if (!rows?.length) return null;
  for (const row of rows) readAuditEventRowV1(row);
  if (rows.length !== 1 || !rows[0]?.vault_grant_id)
    throw new PendingRequestCommandError(
      'recovery_required',
      'The issued grant lineage requires inspection.',
      409
    );
  return rows[0].vault_grant_id;
}

/** Publishes only non-secret workflow fields; requested terms never masquerade as the issued grant. */
function view(
  dependencies: Dependencies,
  record: PendingRequestRecord,
  actor?: Actor
): VaultGrantRequestView {
  const intent = IntentSchema.parse(record.governedIntent);
  const grantId = issuedGrantId(dependencies, record.requestId);
  let currentAdministrator = false;
  if (actor) {
    try {
      administrator(dependencies, actor);
      currentAdministrator = Boolean(
        authorizeWorkspace(dependencies.coreDb!, actor, record.workspaceId, {
          policyOperation: 'vault.admin',
          mutating: true,
        })
      );
    } catch {
      /* Eligibility is a read projection; every command rechecks it. */
    }
  }
  if (
    record.disposition === 'approved-executed' &&
    (!grantId || !getVaultGrant(dependencies.coreDb!, grantId))
  )
    throw new PendingRequestCommandError(
      'recovery_required',
      'The issued grant is unavailable.',
      409
    );
  return {
    approvalRequestId: record.requestId,
    workspaceId: record.workspaceId,
    threadId: record.threadId,
    raisingTurnId: record.raisingTurnId,
    responsibleUserId: record.responsibleUserId,
    requesterKind: record.requesterKind as 'person' | 'worker',
    agentId: record.agentId,
    agentSessionId: record.agentSessionId,
    terms: intent.terms,
    state: record.state,
    resolution: record.resolution,
    ending: record.ending,
    claim: record.claim,
    disposition: record.disposition,
    delivery: record.delivery,
    decidingActorId: record.decidingActor?.id ?? null,
    grantId,
    createdAt: record.createdAt,
    canApprove: currentAdministrator && record.state === 'pending',
    canIssue:
      currentAdministrator &&
      record.resolution === 'granted' &&
      record.claim === 'unclaimed' &&
      record.disposition === null,
    effect: projectApprovalEffect({
      record,
      store: dependencies.store!,
      coreDb: dependencies.coreDb,
      actor,
    }),
  };
}

/** Returns a fixed typed refusal without publishing captured input or backend exception content. */
function failure(error: unknown): never {
  if (error instanceof PendingRequestCommandError)
    throw new OperationError(error.code, error.message, error.status, { cause: error });
  if (error instanceof OperationError) throw error;
  throw new OperationError(
    'vault_request_failed',
    'Vault request failed. Inspect current request and grant inventory.',
    409,
    { cause: error }
  );
}

/** Joins the bounded request and issue commands to the existing Pending Request and Vault owners. */
export function createVaultGrantRequestImplementations(dependencies: Dependencies) {
  const { coreDb, store, repositoryWorkspaceDb } = dependencies;
  /** Open only the selected Workspace database and always release its handle. */
  function withDatabase<T>(workspaceId: string, execute: (db: WorkspaceDb) => T): T {
    if (!coreDb || !store || !repositoryWorkspaceDb)
      throw new OperationError('vault_storage_unavailable', 'Vault storage is unavailable.', 503);
    const db = repositoryWorkspaceDb(workspaceId);
    try {
      return execute(db);
    } catch (error) {
      failure(error);
    } finally {
      db.sqlite.close();
    }
  }
  /** Requester Agent identity survives execution bindings; issue still verifies the original lineage. */
  function mayInspect(record: PendingRequestRecord, context: AdmittedOperationContext): boolean {
    if (context.kind === 'worker')
      return (
        record.requesterKind === 'worker' &&
        record.threadId === context.lineage.threadId &&
        record.responsibleUserId === responsibleUserIdForActor(context.actor) &&
        record.agentId === store!.getTurnById(context.lineage.turnId).agentId
      );
    const actor = publicOperationActor(context);
    if (actor.userId === record.responsibleUserId) return true;
    try {
      administrator(dependencies, actor);
      return true;
    } catch {
      return false;
    }
  }
  return {
    'vault.grant-request': (input, context) =>
      withDatabase(input.workspaceId, (db) => {
        const terms = VaultGrantRequestTermsSchema.parse({
          ...input.terms,
          ...(input.terms.expiresAt
            ? { expiresAt: new Date(input.terms.expiresAt).toISOString() }
            : {}),
        });
        const worker = context.kind === 'worker';
        const origin = worker
          ? {
              kind: 'worker' as const,
              actor: context.actor,
              lineage: {
                workspaceId: context.lineage.workspaceId,
                threadId: context.lineage.threadId,
                turnId: context.lineage.turnId,
                agentSessionId: context.lineage.agentSessionId,
                packageSnapshotId: context.lineage.packageSnapshotId,
              },
            }
          : { kind: 'public' as const, actor: publicOperationActor(context) };
        const responsibleUserId = worker
          ? responsibleUserIdForActor(context.actor)
          : publicOperationActor(context).userId;
        if (!responsibleUserId)
          throw new PendingRequestCommandError(
            'workspace_access_denied',
            'Responsible user is required.',
            403
          );
        const intent = IntentSchema.parse({ operation: 'vault.grant-issue', terms, origin });
        assertRequestSelection(dependencies, db, input.workspaceId, terms, intent.origin);
        currentReference(dependencies, input.workspaceId, terms);
        const prior = readPendingRequest(db.sqlite, input.requestId);
        if (prior) {
          if (
            !isVaultGrantRequest(prior) ||
            prior.workspaceId !== input.workspaceId ||
            prior.threadId !== input.threadId ||
            canonicalJsonText(prior.governedIntent) !== canonicalJsonText(intent)
          )
            throw new PendingRequestCommandError(
              'idempotency_key_conflict',
              'The request identity has different captured terms or actor.',
              409
            );
          return view(
            dependencies,
            requireUsableRecord(
              store!,
              db.sqlite,
              prior.requestId,
              input.workspaceId,
              input.threadId
            ),
            worker ? undefined : publicOperationActor(context)
          );
        }
        const duplicate = listThreadPendingRequests(
          db.sqlite,
          input.workspaceId,
          input.threadId
        ).find(
          (record) =>
            record.state === 'pending' &&
            isVaultGrantRequest(record) &&
            canonicalJsonText(record.governedIntent) === canonicalJsonText(intent)
        );
        if (duplicate)
          return view(
            dependencies,
            requireUsableRecord(
              store!,
              db.sqlite,
              duplicate.requestId,
              input.workspaceId,
              input.threadId
            ),
            worker ? undefined : publicOperationActor(context)
          );
        const thread = store!.getThread(input.workspaceId, input.threadId);
        if (thread.status === 'archived')
          throw new PendingRequestCommandError(
            'vault_request_stale',
            'The request Thread is archived.',
            409
          );
        const turn = worker ? store!.getTurnById(context.lineage.turnId) : null;
        if (
          worker &&
          (!turn ||
            turn.workspaceId !== input.workspaceId ||
            turn.threadId !== input.threadId ||
            turn.agentSessionId !== context.lineage.agentSessionId ||
            !turn.agentId ||
            isSealedTurnTerminal(turn.status))
        )
          throw new PendingRequestCommandError(
            'workspace_access_denied',
            'The requesting Worker lineage is unavailable.',
            403
          );
        if (
          !worker &&
          store!
            .listThreadTurns(input.workspaceId, input.threadId)
            .some((row) => !isSealedTurnTerminal(row.status))
        )
          throw new PendingRequestCommandError(
            'thread_busy',
            'The request Thread already has a Turn in flight.',
            409
          );
        const now = new Date().toISOString();
        const raisingTurnId = turn?.id ?? allocateEntityId('tu');
        const requestItemId = allocateEntityId('it');
        const raisedInput = {
          requestId: input.requestId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          raisingTurnId,
          requestItemId,
          kind: 'approval' as const,
          requesterKind: worker ? ('worker' as const) : ('person' as const),
          agentId: turn?.agentId ?? null,
          agentSessionId: turn?.agentSessionId ?? null,
          responsibleUserId,
          governedIntent: intent,
          approval: {
            kind: 'permission' as const,
            title: 'Credential-use grant requested',
            description:
              terms.injectionPath === 'runtime-env'
                ? 'Review exact terms. This grant permits Worker-visible material.'
                : 'Review exact terms. This grant permits Gateway-only credential use.',
          },
          now,
        };
        // Check the shared bound before admitting a Core-local raising Turn.
        preflightPendingRequest(db.sqlite, raisedInput);
        if (!worker)
          store!.createTurn(
            input.workspaceId,
            input.threadId,
            'Request credential-use authority',
            { kind: 'user', id: responsibleUserId },
            null,
            { turnId: raisingTurnId, status: 'running' }
          );
        try {
          const record = raiseRecordedPendingRequest(store!, db.sqlite, raisedInput);
          store!.createItem({
            id: requestItemId,
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            turnId: raisingTurnId,
            type: 'approval-request',
            approvalRequestId: record.requestId,
            kind: 'permission',
            status: 'completed',
            completedAt: now,
            title: raisedInput.approval.title,
            description: raisedInput.approval.description,
            createdAt: now,
          });
          if (!worker) store!.updateTurn(raisingTurnId, { status: 'completed', completedAt: now });
          return view(
            dependencies,
            record,
            context.kind === 'worker' ? undefined : publicOperationActor(context)
          );
        } catch (error) {
          // Preserve partial request evidence as inspect-only, while releasing the Core-local raising Turn.
          if (!worker && !isSealedTurnTerminal(store!.getTurnById(raisingTurnId).status))
            store!.updateTurn(raisingTurnId, {
              status: 'failed',
              completedAt: new Date().toISOString(),
            });
          throw error;
        }
      }),
    'vault.grant-request-list': (input, context) =>
      withDatabase(input.workspaceId, (db) => ({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        items: listThreadPendingRequests(db.sqlite, input.workspaceId, input.threadId)
          .filter((record) => isVaultGrantRequest(record) && mayInspect(record, context))
          .map((record) =>
            view(
              dependencies,
              requireUsableRecord(
                store!,
                db.sqlite,
                record.requestId,
                input.workspaceId,
                input.threadId
              ),
              context.kind === 'worker' ? undefined : publicOperationActor(context)
            )
          ),
      })),
    'vault.grant-issue': (input, context) =>
      withDatabase(input.workspaceId, (db) => {
        const actor = publicOperationActor(context);
        administrator(dependencies, actor);
        const record = requireUsableRecord(
          store!,
          db.sqlite,
          input.approvalRequestId,
          input.workspaceId,
          input.threadId
        );
        if (!isVaultGrantRequest(record) || !mayInspect(record, context))
          throw new PendingRequestCommandError(
            'workspace_access_denied',
            'Workspace access denied.',
            403
          );
        if (record.claim === 'finished' && record.disposition === 'approved-executed')
          return view(
            dependencies,
            record,
            context.kind === 'worker' ? undefined : publicOperationActor(context)
          );
        if (
          record.state !== 'resolved' ||
          record.resolution !== 'granted' ||
          record.claim !== 'unclaimed' ||
          record.disposition !== null
        )
          throw new PendingRequestCommandError(
            record.claim === 'claimed' ? 'recovery_required' : 'vault_request_not_approved',
            'The request is not an unused approved grant intent.',
            409
          );
        try {
          checkVaultGrantCommandIntent(dependencies, record, actor);
          if (
            !record.decidingActorContext ||
            record.decidingActor?.id !== record.decidingActorContext.userId
          )
            throw new PendingRequestCommandError(
              'recovery_required',
              'The deciding credential lineage is unavailable.',
              409
            );
          checkVaultGrantCommandIntent(dependencies, record, record.decidingActorContext);
        } catch (error) {
          refuseCommandIntentGrant(
            db.sqlite,
            record.requestId,
            'Current request or deciding authority is unavailable.',
            new Date().toISOString()
          );
          const services = dependencies.pendingRequestServices;
          admitIfIdle(
            store!,
            {
              coreDb: coreDb!,
              openWorkspace: repositoryWorkspaceDb!,
              ...(services?.workerDelivery ? { workerDelivery: services.workerDelivery } : {}),
              ...(services?.assistantDelivery
                ? { assistantDelivery: services.assistantDelivery }
                : {}),
              ...(services?.coordinatorDelivery
                ? { coordinatorDelivery: services.coordinatorDelivery }
                : {}),
              ...(services?.agentAuthority ? { agentAuthority: services.agentAuthority } : {}),
              ...(services?.requesterAuthority
                ? { requesterAuthority: services.requesterAuthority }
                : {}),
              ...(services?.goalTerminal ? { goalTerminal: services.goalTerminal } : {}),
            },
            input.workspaceId,
            input.threadId
          );
          throw error;
        }
        const { terms } = IntentSchema.parse(record.governedIntent);
        const now = new Date().toISOString();
        const claimed = claimCommandIntentGrant(db.sqlite, record.requestId, now);
        if (!claimed)
          throw new PendingRequestCommandError(
            'vault_request_not_approved',
            'The request was already consumed or invalidated.',
            409
          );
        const grantId = allocateEntityId('grant');
        const policyDecisionId = allocateEntityId('pd');
        let coreAttempted = false;
        try {
          const access = authorizeWorkspace(
            coreDb!,
            record.decidingActorContext!,
            input.workspaceId,
            { policyOperation: 'vault.admin', mutating: true }
          );
          if (!access) throw new Error('Current Policy refusal.');
          // Administrator eligibility does not create a Workspace membership fact.
          recordProductPermissionDecision({
            workspaceDb: db,
            ownerScope: 'workspace',
            workspaceId: input.workspaceId,
            decisionId: policyDecisionId,
            result: 'allow',
            reasonCode: 'reviewed_vault_grant_administrator_authorized',
            policyEngineVersion: 'nanocore-vault-policy:v1',
            policySnapshotId: 'reviewed_vault_grant_issue',
            subjectSummary: { kind: 'user', id: record.decidingActorContext!.userId },
            action: 'vault.admin',
            resourceSummary: {
              kind: 'vault-reference',
              id: terms.referenceId,
              ownerScope: terms.ownerScope,
            },
            contextSummary: {
              requestId: record.requestId,
              threadId: record.threadId,
              turnId: record.raisingTurnId,
              approvalRequestId: record.requestId,
              issuingActorId: actor.userId,
              requesterId: record.responsibleUserId,
            },
            enforcementPoint: 'vault.grant-issue',
            approvalId: record.requestId,
            auditActor: { kind: 'user', id: actor.userId },
          });
          coreAttempted = true;
          coreDb!.sqlite.transaction(() => {
            createVaultGrant(coreDb!, {
              grantId,
              vaultReferenceId: terms.referenceId,
              ownerScope: terms.ownerScope,
              workspaceId: terms.ownerScope === 'workspace' ? input.workspaceId : null,
              lifetime: terms.lifetime,
              allowedInjectionPaths: [terms.injectionPath],
              targetAgentId: terms.targetAgentId ?? null,
              targetAgentSessionId: terms.targetAgentSessionId ?? null,
              targetCapabilityId: terms.targetCapabilityId ?? null,
              expiresAt: terms.expiresAt ?? null,
              subjectSummary: 'Reviewed credential-use request',
              policyDecisionId,
              approvalId: record.requestId,
            });
            recordVaultAdminAuditEvent({
              coreDb: coreDb!,
              actor,
              action: 'vault.grant-issue',
              outcome: 'succeeded',
              backendKind: dependencies.vaultUnlockState!.backend().kind,
              workspaceId: input.workspaceId,
              resource: `approval:${record.requestId}`,
              vaultGrantId: grantId,
              requestId: record.requestId,
              summary: 'Reviewed credential-use grant issued. Explicit binding is required.',
            });
          })();
          const finished = finishPendingExecution(
            db.sqlite,
            record.requestId,
            'approved-executed',
            null,
            record.delivery === 'delivered' || record.delivery === 'closed-out'
              ? null
              : { grantId },
            new Date().toISOString()
          );
          if (!finished) throw new Error('Missing execution settlement.');
          return view(dependencies, finished, actor);
        } catch {
          finishPendingExecution(
            db.sqlite,
            record.requestId,
            coreAttempted ? 'outcome-unknown' : 'execution-error',
            'Grant issue requires inspection. Do not retry the effect.',
            null,
            new Date().toISOString()
          );
          throw new PendingRequestCommandError(
            'vault_issue_unknown',
            'Grant issue requires inspection of the request, grant inventory and Audit.',
            409
          );
        }
      }),
  } satisfies Pick<
    OperationImplementations,
    'vault.grant-request' | 'vault.grant-request-list' | 'vault.grant-issue'
  >;
}
