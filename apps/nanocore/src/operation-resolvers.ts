import { isDeepStrictEqual } from 'node:util';
import type {
  OperationDefinition,
  OperationMutationTarget,
  OperationTarget,
} from '@openkit/app-api-schemas';
import { operationUsesBootstrapSecret } from '@openkit/app-api-schemas';
import { responsibleUserIdForActor } from '@openkit/protocol';
import Database from 'better-sqlite3';
import {
  authorizedWorkspaceSet,
  authorizeWorkspace,
  currentWorkerLineageWorkspaceAuthority,
  DeploymentAdminRequiredError,
  hasWorkspaceDeletionRetryAuthority,
  isCanonicalUserOperationAuthorized,
  isCurrentDeploymentAdministrator,
  requireCurrentDeploymentAdmin,
} from './auth/operation-authorizer.js';
import { isThreadIdVisible } from './auth/thread-visibility.js';
import { readAutomationOperationLineage } from './automation-operations.js';
import { normalizeCapabilityRequestId } from './capability/usage-ledger.js';
import type { AutomationStore } from './lib/automation-store.js';
import { type FsStore, quickChatWorkspaceIdForUser } from './lib/store.js';
import type {
  AdmittedOperationContext,
  AdmittedOperationScope,
  AssistantOperationInvocationContext,
  InternalOperationDefinition,
  OperationInvocationContext,
} from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { readPendingOperationLineage } from './pending-request-operations.js';
import { requireCoordinatorGoal } from './runtime/goal-owner.js';
import { readRecoveryOperationLineage } from './runtime/worker-recovery-operations.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { readTurnOperationLineage } from './turn-operation-implementations.js';
import {
  ensureUserQuickChatWorkspace,
  WorkspaceOwnerMembershipRemovedError,
} from './workspace-membership.js';
import type { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';
import { readInvitationOperationLineage } from './workspace-sharing-operations.js';

/** Existing admission owners and statically wired minimum-lineage readers; no family execution services. */
export interface OperationAdmissionDependencies {
  readonly coreDb: CoreDb | undefined;
  readonly store?: FsStore;
  readonly automationStore?: AutomationStore;
  readonly workspaceMutationAdmission?: WorkspaceMutationAdmission;
  readonly repositoryWorkspaceDb?: (workspaceId: string) => WorkspaceDb;
}

/** Uniform scope refusal reveals neither child content nor credential details. */
function denied(): OperationError {
  return new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
}
/** Exhaustive strategy failure also rejects corrupted or unknown required discriminants at runtime. */
function unknownStrategy(strategy: never): never {
  void strategy;
  throw denied();
}
/** Only a parsed declared selector is read; field presence grants no authority. */
function selector(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || !value) throw denied();
  return value;
}

/** Trusted entry bindings are explicit, independent of schema shape and eligibility. */
function bindOperationInput(
  value: unknown,
  context: OperationInvocationContext,
  definition: OperationDefinition
): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  for (const field of [
    'actor',
    'userId',
    'triggerActor',
    'entryScope',
    'agentSessionId',
    'packageSnapshotId',
  ]) {
    if (Object.hasOwn(input, field))
      throw new OperationError(
        'bound_input_conflict',
        'Caller cannot supply trusted invocation identity.',
        403
      );
  }
  if (context.kind === 'public' || context.kind === 'bootstrap') return input;
  const bindings =
    context.kind === 'coordinator'
      ? {
          workspaceId: context.workspaceId,
          threadId: context.threadId,
          goalId: context.goalId,
          ...(definition.mutating ? { requestId: context.requestId } : {}),
        }
      : context.bindings;
  const identity =
    context.kind === 'worker'
      ? {
          workspaceId: context.lineage.workspaceId,
          threadId: context.lineage.threadId,
          turnId: context.lineage.turnId,
          requestId: context.requestId,
        }
      : { ...bindings, requestId: context.requestId };
  for (const [field, bound] of Object.entries(identity)) {
    if (Object.hasOwn(input, field) && input[field] !== bound)
      throw new OperationError(
        'bound_input_conflict',
        'Caller input conflicts with bound identity.',
        403
      );
  }
  const args = { ...input };
  if (context.kind === 'worker' && !Object.hasOwn(bindings, 'requestId')) delete args.requestId;
  const logicalBindings =
    context.kind === 'coordinator'
      ? Object.fromEntries(
          Object.entries(bindings).filter(([field]) =>
            Object.hasOwn(definition.inputSchema.shape, field)
          )
        )
      : bindings;
  return { ...args, ...logicalBindings };
}

/** Validates complete logical input before request-store selection or native admission; only declared field names may be published. */
export function parseOperationInput(
  definition: OperationDefinition,
  value: unknown,
  entry: OperationInvocationContext
): Record<string, unknown> {
  const parsed = definition.inputSchema.safeParse(bindOperationInput(value, entry, definition));
  if (!parsed.success) {
    const fields = Object.keys(definition.inputSchema.shape).filter((field) =>
      parsed.error.issues.some((issue) => issue.path[0] === field)
    );
    throw new OperationError(
      definition.invalidInputCode ?? 'invalid_request',
      'Invalid operation input.',
      400,
      fields.length ? { details: { fields } } : {}
    );
  }
  return parsed.data as Record<string, unknown>;
}

/** Preserves primary admission, audience ordering and effect fencing for public and private owned entries. */
export function admitOperation(
  definition: OperationDefinition,
  value: unknown,
  entry: OperationInvocationContext,
  dependencies: OperationAdmissionDependencies
) {
  const bootstrap = operationUsesBootstrapSecret(definition);
  if ((entry.kind === 'bootstrap') !== bootstrap)
    throw new OperationError('core.auth.unauthenticated', 'Authentication required.', 401);
  const input = parseOperationInput(definition, value, entry);
  if (entry.kind === 'bootstrap') return { input, context: entry, release: undefined };
  const credential =
    entry.kind === 'coordinator'
      ? 'coordinator'
      : entry.kind === 'worker'
        ? 'worker-package'
        : entry.actor.kind === 'local'
          ? 'local-user'
          : entry.actor.kind === 'session'
            ? 'user-session'
            : entry.actor.tokenScope === 'server-admin'
              ? 'deployment-administrator'
              : 'user-bearer';
  if (!(definition.credentials as readonly string[]).includes(credential)) {
    if (definition.scope.kind === 'server')
      throw new OperationError(
        'deployment_admin_required',
        'Current deployment administrator authority is required.',
        403
      );
    throw denied();
  }
  const actorRef =
    entry.kind === 'worker' ? entry.actor : { kind: 'user' as const, id: entry.actor.userId };
  const { coreDb, store, workspaceMutationAdmission: admission } = dependencies;
  let scope: AdmittedOperationScope;
  let resolvedLineage: AdmittedOperationContext['resolvedLineage'];
  let mutationWorkspaceId: string | undefined;
  switch (definition.scope.kind) {
    case 'user':
      if (
        entry.kind !== 'public' ||
        !coreDb ||
        !isCanonicalUserOperationAuthorized(coreDb, entry.actor)
      )
        throw denied();
      scope = { kind: 'user' };
      break;
    case 'server':
      if (entry.kind !== 'public') throw denied();
      if (!coreDb && entry.actor.kind !== 'local')
        throw new OperationError(
          'operation_storage_unavailable',
          'Operation authority storage is unavailable.',
          503
        );
      try {
        if (coreDb) requireCurrentDeploymentAdmin(coreDb, entry.actor);
      } catch (error) {
        if (error instanceof DeploymentAdminRequiredError)
          throw new OperationError(
            'deployment_admin_required',
            'Current deployment administrator authority is required.',
            403,
            { cause: error }
          );
        if (error instanceof Database.SqliteError || !coreDb?.sqlite.open)
          throw new OperationError(
            'operation_storage_unavailable',
            'Operation authority storage is unavailable.',
            503,
            { cause: error }
          );
        throw error;
      }
      scope = { kind: 'server' };
      break;
    case 'authorized-workspace-set':
      if (!coreDb || !admission) throw denied();
      if (entry.kind === 'coordinator') {
        if (
          !store ||
          !dependencies.repositoryWorkspaceDb ||
          admission.isClosed(entry.workspaceId) ||
          !authorizeWorkspace(coreDb, entry.actor, entry.workspaceId, definition)
        )
          throw denied();
        const db = dependencies.repositoryWorkspaceDb(entry.workspaceId);
        try {
          requireCoordinatorGoal(store, db, entry);
          requireThreadAudience(store, coreDb, entry, entry.workspaceId, entry.threadId);
        } finally {
          db.sqlite.close();
        }
        // Restrict candidates before the Agent owner reads content, even for an administrator.
        scope = { kind: 'authorized-workspace-set', workspaceIds: [entry.workspaceId] };
      } else {
        if (entry.kind !== 'public') throw denied();
        scope = {
          kind: 'authorized-workspace-set',
          workspaceIds: authorizedWorkspaceSet(coreDb, entry.actor, definition, admission),
        };
      }
      break;
    case 'body-workspace':
    case 'opaque-child-workspace':
    case 'actor-quick-chat-workspace': {
      if (!coreDb || !store || !admission) throw denied();
      let workspaceId: string;
      switch (definition.scope.kind) {
        case 'body-workspace':
          workspaceId = selector(input, definition.scope.field);
          break;
        case 'actor-quick-chat-workspace':
          if (entry.kind !== 'public') throw denied();
          // Ordinary principal initialization stays with authentication; the administrator bearer initializes only its own Quick Chat.
          if (
            entry.actor.kind === 'token' &&
            isCurrentDeploymentAdministrator(coreDb, entry.actor)
          ) {
            try {
              ensureUserQuickChatWorkspace({ coreDb, store, userId: entry.actor.userId });
            } catch (error) {
              if (error instanceof WorkspaceOwnerMembershipRemovedError) throw denied();
              throw error;
            }
          }
          workspaceId = quickChatWorkspaceIdForUser(entry.actor.userId);
          break;
        case 'opaque-child-workspace':
          switch (definition.scope.childOwner) {
            case 'automation': {
              resolvedLineage =
                readAutomationOperationLineage(
                  dependencies.automationStore,
                  selector(input, definition.scope.childField),
                  actorRef.id,
                  entry.kind === 'public' && isCurrentDeploymentAdministrator(coreDb, entry.actor)
                ) ?? undefined;
              if (!resolvedLineage) throw denied();
              workspaceId = resolvedLineage.workspaceId;
              break;
            }
            case 'pending-request':
              workspaceId = selector(input, definition.scope.field);
              break;
            case 'turn':
              resolvedLineage = readTurnOperationLineage(
                store,
                selector(input, definition.scope.childField),
                'access-denied'
              );
              workspaceId = resolvedLineage.workspaceId;
              break;
            default:
              return unknownStrategy(definition.scope);
          }
          break;
      }
      if (entry.kind === 'worker' && workspaceId !== entry.lineage.workspaceId) throw denied();
      const authorized =
        entry.kind === 'worker'
          ? currentWorkerLineageWorkspaceAuthority(
              coreDb,
              { ...entry.lineage, triggerActor: actorRef },
              definition.policyOperation,
              true
            )
          : authorizeWorkspace(coreDb, entry.actor, workspaceId, definition);
      if (
        definition.scope.kind === 'actor-quick-chat-workspace' &&
        (!authorized || typeof authorized === 'string' || authorized.effectiveRole !== 'owner')
      )
        throw denied();
      if (definition.target.kind === 'workspace-deletion') {
        if (
          entry.kind !== 'public' ||
          (!authorized && !hasWorkspaceDeletionRetryAuthority(coreDb, entry.actor, workspaceId))
        )
          throw denied();
      } else if (!authorized || admission.isClosed(workspaceId)) throw denied();
      if (definition.scope.kind === 'opaque-child-workspace') {
        switch (definition.scope.childOwner) {
          case 'automation':
            break;
          case 'pending-request':
            resolvedLineage =
              readPendingOperationLineage(
                dependencies.repositoryWorkspaceDb!,
                store,
                workspaceId,
                selector(input, definition.scope.childField)
              ) ?? undefined;
            break;
          case 'turn':
            break;
          default:
            return unknownStrategy(definition.scope);
        }
        if (!resolvedLineage || resolvedLineage.workspaceId !== workspaceId) throw denied();
        if (resolvedLineage.threadId)
          requireThreadAudience(store, coreDb, entry, workspaceId, resolvedLineage.threadId);
      }
      if (
        entry.kind === 'worker' &&
        !isThreadIdVisible(
          store,
          workspaceId,
          entry.lineage.threadId,
          responsibleUserIdForActor(actorRef) ?? undefined
        )
      )
        throw denied();
      resolveTarget(definition.target, input, dependencies, entry, workspaceId);
      scope = { kind: 'workspace', workspaceId };
      if (definition.mutating && definition.target.kind !== 'workspace-deletion')
        mutationWorkspaceId = workspaceId;
      break;
    }
    default:
      return unknownStrategy(definition.scope);
  }
  if (definition.mutationTarget)
    mutationWorkspaceId = resolveMutationTarget(
      definition.mutationTarget,
      input,
      dependencies,
      entry
    );
  let release: (() => void) | undefined;
  if (mutationWorkspaceId) {
    if (!admission || admission.isClosed(mutationWorkspaceId)) throw denied();
    if (definition.mutating) {
      release = admission.enter(mutationWorkspaceId) ?? undefined;
      if (!release) throw denied();
    }
  }
  const context: AdmittedOperationContext = {
    ...entry,
    actorRef,
    scope,
    delivery: entry.kind === 'public' ? (entry.delivery ?? 'human') : 'model',
    ...(resolvedLineage ? { resolvedLineage } : {}),
    observeSuccessStatus: (status) => {
      if (!(definition.successStatuses ?? [definition.successStatus]).includes(status))
        throw new OperationError(
          'invalid_operation_output',
          'Operation returned an undeclared success status. Inspect the effect outcome; response validation does not undo committed effects.',
          500
        );
      entry.observeSuccessStatus?.(status);
    },
  };
  return { input, context, release };
}

/** Audience is checked after selected-Workspace authority and before addressed content. */
function requireThreadAudience(
  store: FsStore,
  coreDb: CoreDb,
  entry: Exclude<OperationInvocationContext, { kind: 'bootstrap' }>,
  workspaceId: string,
  threadId: string
): void {
  const userId =
    entry.kind === 'worker' ? responsibleUserIdForActor(entry.actor) : entry.actor.userId;
  if (
    !isThreadIdVisible(
      store,
      workspaceId,
      threadId,
      userId ?? undefined,
      entry.kind !== 'worker' && isCurrentDeploymentAdministrator(coreDb, entry.actor)
    )
  )
    throw new OperationError('not_found', 'Thread not found.', 404);
}

/** Static wiring dispatches declared target strategies, including Recovery's distinct missing-lineage outcome. */
function resolveTarget(
  target: OperationTarget,
  input: Record<string, unknown>,
  dependencies: OperationAdmissionDependencies,
  entry: Exclude<OperationInvocationContext, { kind: 'bootstrap' }>,
  workspaceId: string
): void {
  switch (target.kind) {
    case 'addressed-thread':
      requireThreadAudience(
        dependencies.store!,
        dependencies.coreDb!,
        entry,
        workspaceId,
        selector(input, target.threadField)
      );
      return;
    case 'optional-addressed-thread':
      if (input[target.threadField] !== undefined)
        requireThreadAudience(
          dependencies.store!,
          dependencies.coreDb!,
          entry,
          workspaceId,
          selector(input, target.threadField)
        );
      return;
    case 'addressed-turn': {
      const threadId = selector(input, target.threadField);
      requireThreadAudience(
        dependencies.store!,
        dependencies.coreDb!,
        entry,
        workspaceId,
        threadId
      );
      let lineage: ReturnType<typeof readTurnOperationLineage>;
      switch (target.lineage) {
        case 'turn':
          lineage = readTurnOperationLineage(
            dependencies.store!,
            selector(input, target.turnField),
            target.missing ?? 'not-found'
          );
          break;
        case 'recovery-checkpoint':
          lineage = readRecoveryOperationLineage(
            dependencies.store!,
            selector(input, target.turnField)
          );
          break;
        default:
          unknownStrategy(target);
      }
      if (workspaceId !== lineage.workspaceId) throw denied();
      if (lineage.threadId !== threadId)
        requireThreadAudience(
          dependencies.store!,
          dependencies.coreDb!,
          entry,
          workspaceId,
          lineage.threadId
        );
      return;
    }
    case 'workspace':
    case 'authorized-workspaces':
    case 'automation':
    case 'workspace-deletion':
    case 'deleted-workspace':
    case 'deployment':
    case 'configured-runtime-target':
    case 'server':
    case 'user':
    case 'workspace-light-app':
    case 'invitation':
    case 'workspace-invitation':
    case 'workspace-member':
    case 'scheduler-admission':
      return;
    default:
      unknownStrategy(target);
  }
}

/** Mutation targets never replace primary scope or cache effect-time authority. */
function resolveMutationTarget(
  target: OperationMutationTarget,
  input: Record<string, unknown>,
  dependencies: OperationAdmissionDependencies,
  entry: OperationInvocationContext
): string {
  switch (target.kind) {
    case 'body-workspace':
      return selector(input, target.field);
    case 'invitation-workspace': {
      if (!dependencies.coreDb || entry.kind !== 'public') throw denied();
      const row = readInvitationOperationLineage(
        dependencies.coreDb,
        selector(input, target.field)
      );
      if (
        !row ||
        (row.inviteeUserId !== entry.actor.userId &&
          !isCurrentDeploymentAdministrator(dependencies.coreDb, entry.actor))
      )
        throw denied();
      return row.workspaceId;
    }
    default:
      return unknownStrategy(target.kind);
  }
}

/** Parses and admits a private read against its original command binding and current owners. */
export function admitInternalOperation(
  definition: InternalOperationDefinition,
  value: unknown,
  entry: AssistantOperationInvocationContext | OperationInvocationContext,
  binding: AssistantOperationInvocationContext,
  dependencies: OperationAdmissionDependencies
) {
  if (
    definition.binding !== 'internal' ||
    definition.mutating !== false ||
    definition.policyOperation !== 'workspace.read' ||
    definition.entryScope !== 'conversation.submit' ||
    !binding ||
    binding.kind !== 'assistant-command' ||
    !entry ||
    entry.kind !== 'assistant-command' ||
    entry.entryScope !== definition.entryScope ||
    binding.entryScope !== definition.entryScope ||
    !binding.actor?.userId ||
    !['local', 'session', 'token'].includes(binding.actor.kind) ||
    !isDeepStrictEqual(entry.actor, binding.actor) ||
    !binding.workspaceId ||
    entry.workspaceId !== binding.workspaceId ||
    !binding.threadId ||
    entry.threadId !== binding.threadId ||
    !binding.turnId ||
    entry.turnId !== binding.turnId ||
    normalizeCapabilityRequestId(binding.requestId) === null ||
    entry.requestId !== binding.requestId ||
    !(binding.signal instanceof AbortSignal) ||
    !(entry.signal instanceof AbortSignal)
  )
    throw denied();
  // The original command can always cancel a Tool, even when the loop has its own deadline.
  const signal = AbortSignal.any([binding.signal, entry.signal]);
  signal.throwIfAborted();
  if (value && typeof value === 'object') {
    for (const field of [
      'actor',
      'userId',
      'triggerActor',
      'workspaceId',
      'threadId',
      'turnId',
      'entryScope',
      'requestId',
      'signal',
      'agentSessionId',
      'packageSnapshotId',
    ]) {
      if (Object.hasOwn(value, field))
        throw new OperationError(
          'bound_input_conflict',
          'Caller cannot supply trusted invocation identity.',
          403
        );
    }
  }
  const parsed = definition.inputSchema.safeParse(value);
  if (!parsed.success) throw new OperationError('invalid_request', 'Invalid operation input.', 400);
  const { coreDb, store } = dependencies;
  if (
    !coreDb ||
    !store ||
    coreDb.dataRoot !== store.getDataRoot() ||
    !authorizeWorkspace(coreDb, entry.actor, entry.workspaceId, definition) ||
    !isThreadIdVisible(
      store,
      entry.workspaceId,
      entry.threadId,
      entry.actor.userId,
      isCurrentDeploymentAdministrator(coreDb, entry.actor)
    )
  )
    throw denied();
  try {
    const thread = store.getThread(entry.workspaceId, entry.threadId);
    const turn = store.getTurn(entry.workspaceId, entry.threadId, entry.turnId);
    if (
      thread.entryPath !== 'conversation' ||
      (turn.status !== 'pending' && turn.status !== 'running') ||
      turn.triggerActor.kind !== 'user' ||
      turn.triggerActor.id !== entry.actor.userId
    )
      throw denied();
  } catch {
    throw denied();
  }
  return { input: parsed.data, context: { ...entry, signal } };
}
