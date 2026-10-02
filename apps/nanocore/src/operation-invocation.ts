import {
  type ATTENTION_OPERATION_DEFINITIONS,
  type CONVERSATION_OPERATION_DEFINITIONS,
  type GOAL_OPERATION_DEFINITIONS,
  type KernelOperationId,
  type KernelOperationInput,
  type KernelOperationOutput,
  OPERATION_DEFINITIONS,
  type OperationId,
  type OperationInput,
  type OperationOutput,
  type TASK_OPERATION_DEFINITIONS,
  type THREAD_OPERATION_DEFINITIONS,
  type TURN_OPERATION_DEFINITIONS,
  type WORKSPACE_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import type { OpenKitNanoHostConfig } from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import { responsibleUserIdForActor } from '@openkit/protocol';
import { HumanAttentionReadError, readHumanAttention } from './action-center.js';
import {
  ConversationNavigationReadError,
  readConversationNavigation,
  readThreadDashboard,
} from './app-dashboard.js';
import {
  ArtifactOperationError,
  createArtifactOperationImplementations,
} from './artifact-operations.js';
import type { Actor } from './auth/identity.js';
import {
  assertAuthorizedWorkspaceLineage,
  authorizedWorkspaceSet,
  authorizeWorkspace,
  currentWorkerLineageWorkspaceAuthority,
  DeploymentAdminRequiredError,
  isCurrentDeploymentAdministrator,
  requireCurrentDeploymentAdmin,
} from './auth/operation-authorizer.js';
import { isThreadIdVisible } from './auth/thread-visibility.js';
import type { CoreMode } from './config/mode.js';
import type { RuntimeConfigManager } from './config/runtime-config.js';
import { createRecord, getLightApp } from './generative-kernel/commands.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import type { PreparedTaskKnowledgeContext } from './knowledge-manager.js';
import {
  createKnowledgeOperationImplementations,
  KnowledgeOperationError,
} from './knowledge-operations.js';
import type { FsStore } from './lib/store.js';
import type {
  createTaskStartOperation,
  registerQuickAndChatModeRoutes,
} from './mode-entry-routes.js';
import { createPendingRequestOperationImplementations } from './pending-request-operations.js';
import {
  executeGoalOperation,
  type GoalOperationId,
  type GoalOwnerServices,
} from './runtime/goal-owner.js';
import type { InflightIdempotentCommand } from './runtime/idempotent-command.js';
import { IdempotencyKeyConflictError } from './runtime/idempotent-command.js';
import { readConfiguredNanoHostRuntimeTargetStatus } from './runtime/nanohost-runtime-target.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import {
  PendingRequestCommandError,
  readPendingRequestLineage,
} from './runtime/pending-requests.js';
import type { SchedulerLeaseTokenBindingLineage } from './scheduler-records.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { createThread } from './thread-routes.js';
import { readTurn } from './turn-routes.js';
import type { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';
import { readAuthorizedWorkspaces } from './workspace-sharing-routes.js';

/** Trusted entry context, constructed by authentication or Worker supply assembly. */
export type OperationInvocationContext =
  | { readonly kind: 'public'; readonly actor: Actor }
  | { readonly kind: 'task'; readonly actor: Actor; readonly traceId: string }
  | {
      readonly kind: 'coordinator';
      readonly actor: Actor;
      readonly workspaceId: string;
      readonly threadId: string;
      readonly goalId: string;
      readonly turnId: string;
      readonly requestId: string;
    }
  | {
      readonly kind: 'worker';
      readonly actor: ActorRef;
      readonly lineage: SchedulerLeaseTokenBindingLineage;
      readonly requestId: string;
    };

/** Exact handler signatures joined to the shared definition keys. */
export type KernelOperationImplementations = {
  [K in KernelOperationId]: (
    input: KernelOperationInput<K>,
    actor: ActorRef
  ) => KernelOperationOutput<K> | Promise<KernelOperationOutput<K>>;
};

/** Existing process and record owners used by native invocation. */
export interface OperationInvocationDependencies {
  readonly coreDb: CoreDb | undefined;
  /** Existing conversation owner, including process-local interruption handles. */
  readonly conversationService?: ReturnType<typeof registerQuickAndChatModeRoutes>;
  /** Existing bounded Task admission command. */
  readonly taskStart?: ReturnType<typeof createTaskStartOperation>;
  /** Existing captured-call and pending outcome delivery dependencies. */
  readonly pendingRequestServices?: Omit<
    Parameters<typeof createPendingRequestOperationImplementations>[0],
    'store'
  >;
  /** Observes the owner's dynamic success status; it is not command or replay authority. */
  readonly observeSuccessStatus?: (status: 200 | 202) => void;
  readonly goalServices?: GoalOwnerServices;
  readonly runtimeConfigManager?: RuntimeConfigManager;
  readonly repositoryWorkspaceDb?: (workspaceId: string) => WorkspaceDb;
  readonly store?: FsStore;
  readonly inflightCommands?: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly workspaceMutationAdmission?: WorkspaceMutationAdmission;
  /** Existing app-owned worker starter used only by Artifact Review refinement and redo. */
  readonly startModeWorkerTurn?: (input: {
    readonly store: FsStore;
    readonly triggerActor: ActorRef;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly requestId: string;
    readonly requestedAgentId: string;
    readonly reservedTurnId?: string | undefined;
  }) => Promise<ReturnType<FsStore['getTurnById']>>;
  /** Existing configured RuntimeTarget observation owner inputs, used only by the administration read. */
  readonly mode?: CoreMode;
  readonly nanoHostConfig?: Pick<OpenKitNanoHostConfig, 'identityId' | 'deploymentId'>;
}

/** Typed boundary failure; output failure never implies effect rollback. */
export class OperationInvocationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'OperationInvocationError';
  }
}

/** Joins only executable behavior to the definition's exact operation keys. */
function createKernelOperationImplementations(
  dependencies: OperationInvocationDependencies
): KernelOperationImplementations {
  return {
    'kernel.apps.get': (input) =>
      getLightApp(kernelDataRoot(dependencies), input.workspaceId, input.appId),
    'kernel.records.create': (input, actor) =>
      createRecord(
        {
          store: dependencies.store!,
          inflightCommands: dependencies.inflightCommands!,
          dataRoot: kernelDataRoot(dependencies),
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          actor,
        },
        input.appId,
        input.collection,
        input.schemaRevision,
        input.data
      ),
  } satisfies KernelOperationImplementations;
}

/** Exact-key handler join across the families exercised by this milestone. */
export type OperationImplementations = {
  [K in OperationId]: (
    input: OperationInput<K>,
    actor: ActorRef,
    context: OperationInvocationContext,
    workspaceIds: readonly string[]
  ) =>
    | OperationOutput<K>
    | (K extends 'knowledge.context.prepare' ? PreparedTaskKnowledgeContext : never)
    | Promise<
        | OperationOutput<K>
        | (K extends 'knowledge.context.prepare' ? PreparedTaskKnowledgeContext : never)
      >;
};

/** Exact family join signatures; descriptors and id sets remain solely in the shared tables. */
type FamilyImplementations<T> = Pick<OperationImplementations, Extract<keyof T, OperationId>>;

/** Joins Workspace reads to their existing admitted-set and resource owners. */
function createWorkspaceOperationImplementations(
  dependencies: OperationInvocationDependencies
): FamilyImplementations<typeof WORKSPACE_OPERATION_DEFINITIONS> {
  return {
    'workspace.list': (_input, _actor, context, workspaceIds) =>
      readAuthorizedWorkspaces(
        dependencies.coreDb!,
        dependencies.store!,
        publicActor(context),
        workspaceIds
      ),
    'workspace.resources': (input) => dependencies.store!.getWorkspaceResources(input.workspaceId),
  };
}

/** Joins Thread creation, record/history reads and dashboard projection without a second lifecycle. */
function createThreadOperationImplementations(
  dependencies: OperationInvocationDependencies
): FamilyImplementations<typeof THREAD_OPERATION_DEFINITIONS> {
  return {
    'thread.create': (input, actor) =>
      createThread(
        input,
        { store: dependencies.store!, inflightCommands: dependencies.inflightCommands! },
        responsibleUserIdForActor(actor)!
      ),
    'thread.read': (input) => dependencies.store!.getThread(input.workspaceId, input.threadId),
    // The old owner accepts the cursor/limit view but returns the full retained Item log.
    'thread.items': (input) => ({
      items: dependencies.store!.listThreadItems(input.workspaceId, input.threadId),
      nextCursor: null,
    }),
    'thread.dashboard': (input, _actor, context) =>
      readThreadDashboard({
        ...input,
        store: dependencies.store!,
        coreDb: dependencies.coreDb,
        actor: publicActor(context),
        runtimeConfigManager: dependencies.runtimeConfigManager!,
        repositoryWorkspaceDb: dependencies.repositoryWorkspaceDb!,
        administratorEligible: isCurrentDeploymentAdministrator(
          dependencies.coreDb!,
          publicActor(context)
        ),
      }),
  };
}

/** Joins the ordinary Turn read to its existing evidence projection. */
function createTurnOperationImplementations(
  dependencies: OperationInvocationDependencies
): FamilyImplementations<typeof TURN_OPERATION_DEFINITIONS> {
  return {
    'turn.read': (input) =>
      readTurn(
        dependencies.store!,
        dependencies.coreDb,
        dependencies.repositoryWorkspaceDb!,
        input
      ),
  };
}

/** Requires public authenticated context for families that have no Worker projection. */
function publicActor(context: OperationInvocationContext): Actor {
  if (context.kind === 'worker') throw denied();
  return context.actor;
}

/** Exact ten-key join to the sole Goal domain owner. */
function createGoalOperationImplementations(
  dependencies: OperationInvocationDependencies
): FamilyImplementations<typeof GOAL_OPERATION_DEFINITIONS> {
  const execute = async <K extends GoalOperationId>(
    id: K,
    input: OperationInput<K>,
    context: OperationInvocationContext
  ): Promise<import('@openkit/app-api-schemas').GoalView> => {
    const db = dependencies.repositoryWorkspaceDb!(input.workspaceId);
    try {
      return await executeGoalOperation(
        id,
        input,
        {
          actor: publicActor(context),
          ...(context.kind === 'coordinator' ? { coordinatorTurnId: context.turnId } : {}),
        },
        dependencies.store!,
        db,
        {
          ...dependencies.goalServices,
          ...(dependencies.coreDb ? { coreDb: dependencies.coreDb } : {}),
          inflightCommands: dependencies.inflightCommands!,
        }
      );
    } finally {
      db.sqlite.close();
    }
  };
  return {
    'goal.create': (input, _actor, context) => execute('goal.create', input, context),
    'goal.intent.revise': (input, _actor, context) => execute('goal.intent.revise', input, context),
    'goal.card.create': (input, _actor, context) => execute('goal.card.create', input, context),
    'goal.card.edit': (input, _actor, context) => execute('goal.card.edit', input, context),
    'goal.card.cancel': (input, _actor, context) => execute('goal.card.cancel', input, context),
    'goal.plan.propose': (input, _actor, context) => execute('goal.plan.propose', input, context),
    'goal.plan.approve': (input, _actor, context) => execute('goal.plan.approve', input, context),
    'goal.cancel': (input, _actor, context) => execute('goal.cancel', input, context),
    'goal.completion.accept': (input, _actor, context) =>
      execute('goal.completion.accept', input, context),
    'goal.read': (input, _actor, context) => execute('goal.read', input, context),
  };
}

/** Joins conversation, Task and attention definitions to their existing owners without transport context. */
function createTaskConversationOperationImplementations(
  dependencies: OperationInvocationDependencies
): FamilyImplementations<
  typeof CONVERSATION_OPERATION_DEFINITIONS &
    typeof TASK_OPERATION_DEFINITIONS &
    typeof ATTENTION_OPERATION_DEFINITIONS
> {
  const store = dependencies.store!;
  return {
    'conversation.targets': (input, _actor, context) =>
      dependencies.conversationService!.targets(store, input, publicActor(context)),
    'conversation.navigation': (input, _actor, context) =>
      readConversationNavigation({
        ...input,
        store,
        actor: publicActor(context),
        coreDb: dependencies.coreDb,
        runtimeConfigManager: dependencies.runtimeConfigManager!,
        repositoryWorkspaceDb: dependencies.repositoryWorkspaceDb!,
        administratorEligible: isCurrentDeploymentAdministrator(
          dependencies.coreDb!,
          publicActor(context)
        ),
      }),
    'conversation.submit': async (input, _actor, context) => {
      const result = await dependencies.conversationService!.submit(
        store,
        input,
        publicActor(context)
      );
      dependencies.observeSuccessStatus?.(result.status);
      return result.body;
    },
    'task.start': (input, _actor, context) =>
      dependencies.taskStart!(store, input, publicActor(context)),
    'attention.list': (input, _actor, context) =>
      readHumanAttention({
        ...input,
        store,
        actor: publicActor(context),
        coreDb: dependencies.coreDb,
        repositoryWorkspaceDb: dependencies.repositoryWorkspaceDb!,
        administratorEligible: isCurrentDeploymentAdministrator(
          dependencies.coreDb!,
          publicActor(context)
        ),
      }),
  };
}

/** Supplies only executable bindings, with no repeated declarative contract facts. */
function createOperationImplementations(
  dependencies: OperationInvocationDependencies
): OperationImplementations {
  return {
    ...createKernelOperationImplementations(dependencies),
    ...createWorkspaceOperationImplementations(dependencies),
    ...createThreadOperationImplementations(dependencies),
    ...createTurnOperationImplementations(dependencies),
    ...createKnowledgeOperationImplementations(dependencies),
    ...createArtifactOperationImplementations(dependencies),
    ...createGoalOperationImplementations(dependencies),
    ...createTaskConversationOperationImplementations(dependencies),
    ...createPendingRequestOperationImplementations({
      ...dependencies.pendingRequestServices!,
      store: dependencies.store!,
    }),
    'nanohost.runtime-target': () => {
      const observation = readConfiguredNanoHostRuntimeTargetStatus({
        coreDb: dependencies.coreDb,
        mode: dependencies.mode ?? 'local',
        ...(dependencies.nanoHostConfig ? { nanoHostConfig: dependencies.nanoHostConfig } : {}),
      });
      if (!observation.ok)
        throw new OperationInvocationError(
          observation.code,
          observation.message,
          observation.httpStatus
        );
      return observation.status;
    },
  } satisfies OperationImplementations;
}

/** Native transport-free seam; projections supply arguments and trusted entry context only. */
export function createOperationInvocation(dependencies: OperationInvocationDependencies) {
  function invoke(
    id: 'knowledge.context.prepare',
    value: unknown,
    context: Extract<OperationInvocationContext, { kind: 'task' }>
  ): Promise<PreparedTaskKnowledgeContext>;
  function invoke<K extends OperationId>(
    id: K,
    value: unknown,
    context: Exclude<OperationInvocationContext, { kind: 'task' }>
  ): Promise<OperationOutput<K>>;
  async function invoke<K extends OperationId>(
    id: K,
    value: unknown,
    context: OperationInvocationContext
  ): Promise<OperationOutput<K> | PreparedTaskKnowledgeContext> {
    if (!Object.hasOwn(OPERATION_DEFINITIONS, id))
      throw new OperationInvocationError('unsupported_operation', 'Unknown operation.', 400);
    if (context.kind === 'task' && id !== 'knowledge.context.prepare')
      throw new OperationInvocationError(
        'invalid_request',
        'Task context is reserved for Knowledge preparation.',
        400
      );
    const definition = OPERATION_DEFINITIONS[id];
    const assembled = bindOperationInput(value, context, definition.mutating);
    const parsed = definition.inputSchema.safeParse(assembled);
    if (!parsed.success)
      throw new OperationInvocationError('invalid_request', 'Invalid operation input.', 400);
    const coreDb = dependencies.coreDb;
    const credential =
      context.kind === 'coordinator'
        ? 'coordinator'
        : context.kind === 'worker'
          ? 'worker-package'
          : context.actor.kind === 'local'
            ? 'local-user'
            : context.actor.kind === 'session'
              ? 'user-session'
              : context.actor.tokenScope === 'server-admin'
                ? 'deployment-administrator'
                : 'user-bearer';
    if (!(definition.credentials as readonly string[]).includes(credential)) throw denied();
    const actor =
      context.kind === 'worker'
        ? context.actor
        : { kind: 'user' as const, id: context.actor.userId };
    let release: (() => void) | undefined;
    let workspaceIds: readonly string[] = [];
    if (definition.scope.kind === 'server') {
      if (context.kind !== 'public') throw denied();
      if (!coreDb)
        throw new OperationInvocationError(
          'nanohost_transport_storage_unavailable',
          'NanoHost transport storage is unavailable.',
          503
        );
      try {
        requireCurrentDeploymentAdmin(coreDb, context.actor);
      } catch (error) {
        if (error instanceof DeploymentAdminRequiredError)
          throw new OperationInvocationError('deployment_admin_required', error.message, 403);
        throw error;
      }
    } else if (definition.scope.kind === 'authorized-workspace-set') {
      if (context.kind !== 'public' || !coreDb || !dependencies.workspaceMutationAdmission)
        throw denied();
      workspaceIds = authorizedWorkspaceSet(
        coreDb,
        context.actor,
        definition,
        dependencies.workspaceMutationAdmission
      );
    } else {
      if (
        definition.scope.kind !== 'body-workspace' &&
        definition.scope.kind !== 'opaque-child-workspace'
      )
        throw denied();
      const input = parsed.data as { workspaceId: string; threadId?: string; turnId?: string };
      const workspaceId = input[definition.scope.field];
      if (
        !coreDb ||
        !dependencies.store ||
        !dependencies.workspaceMutationAdmission ||
        !dependencies.inflightCommands
      )
        throw denied();
      const authorized =
        context.kind === 'worker'
          ? currentWorkerLineageWorkspaceAuthority(
              coreDb,
              { ...context.lineage, triggerActor: actor },
              definition.policyOperation,
              true
            )
          : authorizeWorkspace(coreDb, context.actor, workspaceId, definition);
      if (!authorized || dependencies.workspaceMutationAdmission.isClosed(workspaceId))
        throw denied();
      if (definition.scope.kind === 'opaque-child-workspace') {
        // This branch resolves only Pending Request lineage and fails closed for any other child family.
        const childId = (parsed.data as Record<string, unknown>)[
          definition.scope.childField
        ] as string;
        const db = dependencies.repositoryWorkspaceDb!(workspaceId);
        let lineage: ReturnType<typeof readPendingRequestLineage>;
        try {
          lineage = readPendingRequestLineage(db.sqlite, childId);
        } finally {
          db.sqlite.close();
        }
        lineage ??= dependencies.store.getApprovalProjectionLineage(workspaceId, childId);
        if (!lineage || lineage.workspaceId !== workspaceId) throw denied();
        const administratorEligible =
          context.kind !== 'worker' && isCurrentDeploymentAdministrator(coreDb, context.actor);
        if (
          !isThreadIdVisible(
            dependencies.store,
            workspaceId,
            lineage.threadId,
            responsibleUserIdForActor(actor) ?? undefined,
            administratorEligible
          )
        )
          throw new OperationInvocationError('not_found', 'Thread not found.', 404);
      }
      if (context.kind === 'worker') {
        const userId = responsibleUserIdForActor(actor);
        if (
          !userId ||
          !isThreadIdVisible(dependencies.store, workspaceId, context.lineage.threadId, userId)
        )
          throw denied();
      }
      if (
        definition.target.kind === 'addressed-thread' ||
        definition.target.kind === 'addressed-turn' ||
        (definition.target.kind === 'optional-addressed-thread' && input.threadId !== undefined)
      ) {
        const userId = responsibleUserIdForActor(actor);
        const administratorEligible =
          context.kind !== 'worker' && isCurrentDeploymentAdministrator(coreDb, context.actor);
        if (
          !isThreadIdVisible(
            dependencies.store,
            workspaceId,
            input[definition.target.threadField]!,
            userId ?? undefined,
            administratorEligible
          )
        )
          throw new OperationInvocationError('not_found', 'Thread not found.', 404);
        if (definition.target.kind === 'addressed-turn') {
          const turn = dependencies.store.getTurnById(input[definition.target.turnField]!);
          assertAuthorizedWorkspaceLineage(
            {
              ...(authorized as {
                workspaceId: string;
                effectiveRole: import('./workspace-membership.js').WorkspaceRole;
              }),
              kind: 'workspace',
              policyOperation: definition.policyOperation,
            },
            turn.workspaceId
          );
        }
      }
      // Domain handlers resolve the child inside this authorized Workspace and preserve their own availability outcomes.
      release = definition.mutating
        ? (dependencies.workspaceMutationAdmission.enter(workspaceId) ?? undefined)
        : undefined;
      if (definition.mutating && !release) throw denied();
    }
    try {
      const handlers: OperationImplementations = createOperationImplementations(dependencies);
      const output = await handlers[id](
        parsed.data as OperationInput<K>,
        actor,
        context,
        workspaceIds
      );
      // Task owns a trace-only view of the same definition; public projections keep their complete output contract.
      const outputSchema =
        context.kind === 'task'
          ? OPERATION_DEFINITIONS['knowledge.context.prepare'].outputSchema.pick({
              retrievalTraceId: true,
            })
          : definition.outputSchema;
      const validated = outputSchema.safeParse(output);
      if (!validated.success)
        throw new OperationInvocationError(
          'invalid_operation_output',
          definition.mutating
            ? 'Operation output is invalid. Inspect the effect outcome; output validation does not undo committed effects.'
            : 'Operation output is invalid.',
          500
        );
      return validated.data as OperationOutput<K> | PreparedTaskKnowledgeContext;
    } catch (error) {
      if (
        error instanceof KnowledgeOperationError ||
        error instanceof ArtifactOperationError ||
        error instanceof HumanAttentionReadError ||
        error instanceof ConversationNavigationReadError ||
        error instanceof TurnStartValidationError ||
        error instanceof PendingRequestCommandError ||
        error instanceof IdempotencyKeyConflictError
      )
        throw new OperationInvocationError(error.code, error.message, error.status);
      throw error;
    } finally {
      release?.();
    }
  }
  return invoke;
}

/** Requires the existing Kernel storage owner without creating substitute state. */
function kernelDataRoot(dependencies: OperationInvocationDependencies): string {
  const dataRoot = dependencies.store?.getDataRoot();
  if (!dataRoot) throw new KernelCommandError('unavailable', 'Workspace storage is unavailable.');
  return dataRoot;
}

/** Assembles owner-bound Workspace/request identity and refuses model-selected authority. */
function bindOperationInput(
  value: unknown,
  context: OperationInvocationContext,
  mutating: boolean
): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  for (const key of [
    'actor',
    'userId',
    'triggerActor',
    'entryScope',
    'agentSessionId',
    'packageSnapshotId',
  ]) {
    if (Object.hasOwn(input, key))
      throw new OperationInvocationError(
        'bound_input_conflict',
        'Caller cannot supply trusted invocation identity.',
        403
      );
  }
  if (context.kind === 'coordinator') {
    const bound = {
      workspaceId: context.workspaceId,
      threadId: context.threadId,
      goalId: context.goalId,
      requestId: context.requestId,
    };
    for (const key of Object.keys(bound) as (keyof typeof bound)[])
      if (Object.hasOwn(input, key) && input[key] !== bound[key])
        throw new OperationInvocationError(
          'bound_input_conflict',
          'Input conflicts with the Coordinator owner.',
          403
        );
    return {
      ...input,
      workspaceId: bound.workspaceId,
      threadId: bound.threadId,
      goalId: bound.goalId,
      ...(mutating ? { requestId: bound.requestId } : {}),
    };
  }
  if (context.kind !== 'worker') return input;
  for (const key of ['threadId', 'turnId']) {
    if (Object.hasOwn(input, key))
      throw new OperationInvocationError(
        'bound_input_conflict',
        'Caller cannot supply trusted invocation identity.',
        403
      );
  }
  const bound = { workspaceId: context.lineage.workspaceId, requestId: context.requestId };
  for (const key of ['workspaceId', 'requestId'] as const) {
    if (Object.hasOwn(input, key) && input[key] !== bound[key])
      throw new OperationInvocationError(
        'bound_input_conflict',
        'Caller input conflicts with bound identity.',
        403
      );
  }
  const { requestId: _requestId, ...args } = input;
  return {
    ...args,
    workspaceId: bound.workspaceId,
    ...(mutating ? { requestId: bound.requestId } : {}),
  };
}

/** Uniform denial without child or credential disclosure. */
function denied(): OperationInvocationError {
  return new OperationInvocationError('workspace_access_denied', 'Workspace access denied.', 403);
}
