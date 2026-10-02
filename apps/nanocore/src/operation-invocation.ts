import {
  type KernelOperationId,
  type KernelOperationInput,
  type KernelOperationOutput,
  OPERATION_DEFINITIONS,
  type OperationId,
  type OperationInput,
  type OperationOutput,
  type THREAD_OPERATION_DEFINITIONS,
  type TURN_OPERATION_DEFINITIONS,
  type WORKSPACE_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import type { OpenKitNanoHostConfig } from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import { responsibleUserIdForActor } from '@openkit/protocol';
import { readThreadDashboard } from './app-dashboard.js';
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
import type { FsStore } from './lib/store.js';
import type { InflightIdempotentCommand } from './runtime/idempotent-command.js';
import { readConfiguredNanoHostRuntimeTargetStatus } from './runtime/nanohost-runtime-target.js';
import type { SchedulerLeaseTokenBindingLineage } from './scheduler-records.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { createThread } from './thread-routes.js';
import { readTurn } from './turn-routes.js';
import type { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';
import { readAuthorizedWorkspaces } from './workspace-sharing-routes.js';

/** Trusted entry context, constructed by authentication or Worker supply assembly. */
export type OperationInvocationContext =
  | { readonly kind: 'public'; readonly actor: Actor }
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
  readonly runtimeConfigManager?: RuntimeConfigManager;
  readonly repositoryWorkspaceDb?: (workspaceId: string) => WorkspaceDb;
  readonly store?: FsStore;
  readonly inflightCommands?: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly workspaceMutationAdmission?: WorkspaceMutationAdmission;
  /** Existing configured RuntimeTarget observation owner inputs, used only by the administration read. */
  readonly mode?: CoreMode;
  readonly nanoHostConfig?: Pick<OpenKitNanoHostConfig, 'identityId' | 'deploymentId'>;
}

/** Typed boundary failure; output failure never implies effect rollback. */
export class OperationInvocationError extends Error {
  public constructor(
    public readonly code:
      | 'bound_input_conflict'
      | 'workspace_access_denied'
      | 'invalid_operation_output'
      | 'invalid_request'
      | 'unsupported_operation'
      | 'not_found'
      | 'deployment_admin_required'
      | 'nanohost_transport_admin_server_mode_required'
      | 'nanohost_transport_storage_unavailable'
      | 'nanohost_transport_config_unavailable'
      | 'nanohost_runtime_target_not_found',
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
  ) => OperationOutput<K> | Promise<OperationOutput<K>>;
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
  if (context.kind !== 'public') throw denied();
  return context.actor;
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
  return async <K extends OperationId>(
    id: K,
    value: unknown,
    context: OperationInvocationContext
  ): Promise<OperationOutput<K>> => {
    if (!Object.hasOwn(OPERATION_DEFINITIONS, id))
      throw new OperationInvocationError('unsupported_operation', 'Unknown operation.', 400);
    const definition = OPERATION_DEFINITIONS[id];
    const assembled = bindOperationInput(value, context, definition.mutating);
    const parsed = definition.inputSchema.safeParse(assembled);
    if (!parsed.success)
      throw new OperationInvocationError('invalid_request', 'Invalid operation input.', 400);
    const coreDb = dependencies.coreDb;
    const credential =
      context.kind === 'worker'
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
      if (definition.scope.kind !== 'body-workspace') throw denied();
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
        definition.target.kind === 'addressed-turn'
      ) {
        const userId = responsibleUserIdForActor(actor);
        const administratorEligible =
          context.kind === 'public' && isCurrentDeploymentAdministrator(coreDb, context.actor);
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
      const validated = definition.outputSchema.safeParse(output);
      if (!validated.success)
        throw new OperationInvocationError(
          'invalid_operation_output',
          definition.mutating
            ? 'Operation output is invalid. Inspect the effect outcome; output validation does not undo committed effects.'
            : 'Operation output is invalid.',
          500
        );
      return validated.data as OperationOutput<K>;
    } finally {
      release?.();
    }
  };
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
