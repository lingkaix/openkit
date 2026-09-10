import { createHash } from 'node:crypto';

import {
  type GetWorkerEnvironmentStatusResponse,
  GetWorkerEnvironmentStatusResponseSchema,
  type ListWorkerEnvironmentsQuery,
  type ListWorkerEnvironmentsResponse,
  ListWorkerEnvironmentsResponseSchema,
  type PurgeWorkerEnvironmentRequest,
  type PurgeWorkerEnvironmentResponse,
  PurgeWorkerEnvironmentResponseSchema,
  type SelectWorkerEnvironmentRequest,
  type SelectWorkerEnvironmentResponse,
  SelectWorkerEnvironmentResponseSchema,
  type WorkerEnvironmentSummary,
  WorkerEnvironmentSummarySchema,
} from '@openkit/app-api-schemas';

import type { Actor } from '../auth/identity.js';
import {
  isWorkspaceOperationAuthorized,
  requireCurrentDeploymentAdmin,
} from '../auth/operation-authorizer.js';
import type { FsStore } from '../lib/store.js';
import { hasNonterminalGoalWorkerStorageReference } from '../runtime/goal-store.js';
import {
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import type { WorkerEnvironmentRuntimeEffects } from '../runtime/worker-environment-runtime-effects.js';
import {
  getWorkerStorageBinding,
  listWorkerStorageBindings,
  markWorkerStoragePurgePending,
  selectWorkerStorageBinding,
  settleWorkerStoragePurge,
  type WorkerStorageBinding,
  type WorkerStorageContributor,
} from '../runtime/worker-storage-bindings.js';
import { listSchedulerAdmissionEntriesForWorkspace } from '../scheduler-records.js';
import { type CoreDb, openBootVerifiedWorkspaceDb } from '../storage/db.js';

/** Current user and target Workspace supplied to one in-process environment operation. */
export interface WorkerEnvironmentOperationContext {
  /** Authenticated user whose current administration and audience authority is rechecked. */
  readonly actor: Actor;
  /** Exact target Workspace. */
  readonly workspaceId: string;
}

/** Stable product-safe failure from the Worker environment operation owner. */
export class WorkerEnvironmentOperationError extends Error {
  public constructor(
    public readonly code:
      | 'invalid_request'
      | 'not_found'
      | 'unavailable'
      | 'recovery_required'
      | 'thread_busy'
      | 'revision_conflict'
      | 'candidate_conflict'
      | 'effect_failed'
      | 'workspace_access_denied',
    message: string
  ) {
    super(message);
    this.name = 'WorkerEnvironmentOperationError';
  }
}

/** In-process Worker environment operations shared by public routes and private administration. */
export interface WorkerEnvironmentOperations {
  /** Lists a bounded page after rechecking all source audiences. */
  list(
    context: WorkerEnvironmentOperationContext,
    input: ListWorkerEnvironmentsQuery
  ): ListWorkerEnvironmentsResponse;
  /** Rechecks one explicit environment selection without reserving or attaching it. */
  select(
    context: WorkerEnvironmentOperationContext,
    input: SelectWorkerEnvironmentRequest
  ): SelectWorkerEnvironmentResponse;
  /** Returns current Core and host facts for one exact authorized environment. */
  status(
    context: WorkerEnvironmentOperationContext,
    input: { readonly storageRef: string }
  ): Promise<GetWorkerEnvironmentStatusResponse>;
  /** Purges one exact idle association under payload-bound human confirmation. */
  purge(
    context: WorkerEnvironmentOperationContext,
    input: PurgeWorkerEnvironmentRequest
  ): Promise<PurgeWorkerEnvironmentResponse>;
}

/** Dependencies for the shared Worker environment operation owner. */
export interface CreateWorkerEnvironmentOperationsInput {
  /** Core storage and membership authority. */
  readonly coreDb: CoreDb;
  /** Existing host effect adapter. */
  readonly runtimeEffects: WorkerEnvironmentRuntimeEffects;
  /** Existing Thread owner used for current source-audience proof. */
  readonly store: FsStore;
  /** Process-local duplicate-collapse owner shared by public commands. */
  readonly inflightCommands?: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
}

/** Creates the shared bounded Worker environment operation owner. */
export function createWorkerEnvironmentOperations(
  dependencies: CreateWorkerEnvironmentOperationsInput
): WorkerEnvironmentOperations {
  const inflightCommands =
    dependencies.inflightCommands ?? new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
  return {
    list(context, input) {
      requireOperationAuthority(dependencies.coreDb, context, false);
      const authorizeContributor = contributorAuthorizer(dependencies.store, context);
      const items = listWorkerStorageBindings(dependencies.coreDb, {
        authorizeContributor,
        workspaceId: context.workspaceId,
      });
      const start = input.after
        ? items.findIndex((binding) => binding.storageRef === input.after) + 1
        : 0;
      if (input.after && start === 0) {
        throw new WorkerEnvironmentOperationError('invalid_request', 'List cursor is invalid.');
      }
      const page = items.slice(start, start + input.limit);
      const hasMore = start + page.length < items.length;
      return ListWorkerEnvironmentsResponseSchema.parse({
        items: page.map(projectBinding),
        nextCursor: hasMore ? (page.at(-1)?.storageRef ?? null) : null,
      });
    },

    select(context, input) {
      requireOperationAuthority(dependencies.coreDb, context, false);
      requireThread(dependencies.store, context.workspaceId, input.threadId);
      const authorizeContributor = contributorAuthorizer(dependencies.store, context);
      const binding = requireAuthorizedBinding(
        dependencies.coreDb,
        context.workspaceId,
        input.storageRef,
        authorizeContributor
      );
      if (binding.layoutDigest !== input.layoutDigest) {
        throw new WorkerEnvironmentOperationError(
          'invalid_request',
          'Worker environment layout does not match the requested layout.'
        );
      }
      const selected = selectWorkerStorageBinding(dependencies.coreDb, {
        adjudicatedThreadIds: input.adjudicatedThreadIds,
        authorizeContributor,
        expectedRevision: input.expectedRevision,
        goalId: input.goalId,
        layout: binding.layout,
        purpose: input.purpose,
        responsibleUserId: context.actor.userId,
        storageRef: input.storageRef,
        taskId: input.taskId,
        threadId: input.threadId,
        workspaceId: context.workspaceId,
      });
      return SelectWorkerEnvironmentResponseSchema.parse({ selected: projectBinding(selected) });
    },

    async status(context, input) {
      requireOperationAuthority(dependencies.coreDb, context, false);
      const binding = requireAuthorizedBinding(
        dependencies.coreDb,
        context.workspaceId,
        input.storageRef,
        contributorAuthorizer(dependencies.store, context)
      );
      const storage = await dependencies.runtimeEffects.inspectStorage({
        authorize: () => hasOperationAuthority(dependencies.coreDb, context, false),
        binding,
        commandRequestId: readRequestId('status', context, binding),
      });
      return GetWorkerEnvironmentStatusResponseSchema.parse({
        environment: projectBinding(binding),
        storage: {
          attachment: storage.attachment ? { generation: storage.attachment.generation } : null,
          capacity: {
            availableBytes: storage.capacity.availableBytes,
            totalBytes: storage.capacity.totalBytes,
          },
          layoutDigest: storage.layoutDigest,
          scopeDigest: storage.scopeDigest,
          state: storage.state,
          storageRef: storage.storageRef,
          targets: storage.targets.map((target) => ({
            initialized: target.initialized,
            target: target.target,
            volumeRef: target.volumeRef,
          })),
        },
      });
    },

    async purge(context, input) {
      requireOperationAuthority(dependencies.coreDb, context, true);
      return runIdempotentCommand({
        command: 'worker_environment.purge',
        execute: async () => {
          const binding = requireAuthorizedBinding(
            dependencies.coreDb,
            context.workspaceId,
            input.storageRef,
            contributorAuthorizer(dependencies.store, context)
          );
          const pending = markWorkerStoragePurgePending(dependencies.coreDb, {
            authorizePurge: () => hasOperationAuthority(dependencies.coreDb, context, true),
            expectedRevision: input.expectedRevision,
            hasSurvivingReferences: () => hasSurvivingWork(dependencies, binding),
            storageRef: binding.storageRef,
          });
          let outcome: 'purged' | 'retained' | 'unknown';
          try {
            const result = await dependencies.runtimeEffects.purgeStorage({
              authorize: () => hasOperationAuthority(dependencies.coreDb, context, true),
              binding: pending,
              commandRequestId: input.requestId,
            });
            outcome = result.state;
          } catch {
            outcome = 'unknown';
          }
          const settled = settleWorkerStoragePurge(dependencies.coreDb, {
            expectedRevision: pending.revision,
            outcome,
            storageRef: pending.storageRef,
          });
          return purgeResponse(input.requestId, settled, outcome);
        },
        inflightCommands,
        input,
        replay: (record) => {
          if (record.response.kind !== 'worker_environment') {
            throw new WorkerEnvironmentOperationError(
              'unavailable',
              'Worker environment purge receipt is inconsistent.'
            );
          }
          const binding = getWorkerStorageBinding(dependencies.coreDb, {
            storageRef: record.response.id,
          });
          if (!binding || binding.workspaceId !== context.workspaceId) {
            throw new WorkerEnvironmentOperationError(
              'unavailable',
              'Worker environment purge receipt is incomplete.'
            );
          }
          if (
            binding.state !== 'purged' &&
            !binding.contributors.every(contributorAuthorizer(dependencies.store, context))
          ) {
            throw new WorkerEnvironmentOperationError(
              'not_found',
              'Worker environment was not found.'
            );
          }
          const outcome =
            binding.state === 'purged'
              ? 'purged'
              : binding.state === 'unknown'
                ? 'unknown'
                : 'retained';
          return purgeResponse(input.requestId, binding, outcome);
        },
        requestId: input.requestId,
        responseId: (result) => result.storageRef,
        responseKind: 'worker_environment',
        scope: {
          actorId: context.actor.userId,
          storageRef: input.storageRef,
          workspaceId: context.workspaceId,
        },
        store: dependencies.store,
      });
    },
  };
}

/** Rechecks durable future-work references before the synchronous purge reservation. */
function hasSurvivingWork(
  dependencies: CreateWorkerEnvironmentOperationsInput,
  binding: WorkerStorageBinding
): boolean {
  const entries = listSchedulerAdmissionEntriesForWorkspace(dependencies.coreDb, {
    statuses: ['queued', 'denied', 'admitted'],
    workspaceId: binding.workspaceId,
  });
  if (
    entries.some((entry) => {
      if (
        entry.workerStorageChoice?.kind !== 'selected' ||
        entry.workerStorageChoice.storageRef !== binding.storageRef
      )
        return false;
      if (entry.status !== 'admitted') return true;
      try {
        return ['pending', 'running', 'awaiting_human'].includes(
          dependencies.store.getTurnById(entry.turnId).status
        );
      } catch {
        return true;
      }
    })
  )
    return true;
  const workspaceDb = openBootVerifiedWorkspaceDb(
    dependencies.coreDb.dataRoot,
    binding.workspaceId
  );
  try {
    return hasNonterminalGoalWorkerStorageReference(workspaceDb, binding.storageRef);
  } finally {
    workspaceDb.sqlite.close();
  }
}

/** Projects one durable purge settlement into its bounded command response. */
function purgeResponse(
  requestId: string,
  binding: WorkerStorageBinding,
  outcome: 'purged' | 'retained' | 'unknown'
): PurgeWorkerEnvironmentResponse {
  return PurgeWorkerEnvironmentResponseSchema.parse({
    environment: binding.state === 'purged' ? null : projectBinding(binding),
    outcome,
    requestId,
    storageRef: binding.storageRef,
  });
}

/** Converts one private binding into the bounded public summary. */
function projectBinding(binding: WorkerStorageBinding): WorkerEnvironmentSummary {
  return WorkerEnvironmentSummarySchema.parse({
    attachmentGeneration: binding.attachmentGeneration,
    contributors: binding.contributors.map((contributor) => ({
      attachmentGeneration: contributor.attachmentGeneration,
      createdAt: contributor.createdAt,
      goalId: contributor.goalId,
      purpose: contributor.purpose,
      responsibleUserId: contributor.responsibleUserId,
      taskId: contributor.taskId,
      threadId: contributor.threadId,
    })),
    createdAt: binding.createdAt,
    layout: {
      ...binding.layout,
      platform: { ...binding.layout.platform },
      targets: binding.layout.targets.map((target) => ({ ...target })),
    },
    layoutDigest: binding.layoutDigest,
    revision: binding.revision,
    state: binding.state,
    storageRef: binding.storageRef,
    updatedAt: binding.updatedAt,
    workspaceId: binding.workspaceId,
  });
}

/** Builds the fail-closed current source-audience predicate used by every binding read. */
function contributorAuthorizer(
  store: FsStore,
  context: WorkerEnvironmentOperationContext
): (contributor: WorkerStorageContributor) => boolean {
  return (contributor) => {
    if (
      contributor.workspaceId !== context.workspaceId ||
      contributor.responsibleUserId !== context.actor.userId
    ) {
      return false;
    }
    try {
      return (
        store.getThread(context.workspaceId, contributor.threadId).workspaceId ===
        context.workspaceId
      );
    } catch {
      return false;
    }
  };
}

/** Reads one binding only after complete current audience admission. */
function requireAuthorizedBinding(
  coreDb: CoreDb,
  workspaceId: string,
  storageRef: string,
  authorizeContributor: (contributor: WorkerStorageContributor) => boolean
): WorkerStorageBinding {
  const binding = getWorkerStorageBinding(coreDb, { storageRef });
  if (
    !binding ||
    binding.workspaceId !== workspaceId ||
    binding.state === 'purged' ||
    !binding.contributors.every(authorizeContributor)
  ) {
    throw new WorkerEnvironmentOperationError('not_found', 'Worker environment was not found.');
  }
  return binding;
}

/** Requires one exact live source Thread without disclosing cross-Workspace lineage. */
function requireThread(store: FsStore, workspaceId: string, threadId: string): void {
  try {
    store.getThread(workspaceId, threadId);
  } catch {
    throw new WorkerEnvironmentOperationError('not_found', 'Worker environment was not found.');
  }
}

/** Rechecks deployment administration and target Workspace policy for one call. */
function requireOperationAuthority(
  coreDb: CoreDb,
  context: WorkerEnvironmentOperationContext,
  mutating: boolean
): void {
  try {
    requireCurrentDeploymentAdmin(coreDb, context.actor);
  } catch {
    throw new WorkerEnvironmentOperationError(
      'workspace_access_denied',
      'Workspace access denied.'
    );
  }
  if (
    !isWorkspaceOperationAuthorized(coreDb, context.actor, context.workspaceId, {
      authentication: 'deployment-admin',
      mutating,
      policyOperation: mutating ? 'workspace.configure' : 'workspace.read',
    })
  ) {
    throw new WorkerEnvironmentOperationError(
      'workspace_access_denied',
      'Workspace access denied.'
    );
  }
}

/** Returns current authority without letting runtime adapters cache an earlier decision. */
function hasOperationAuthority(
  coreDb: CoreDb,
  context: WorkerEnvironmentOperationContext,
  mutating: boolean
): boolean {
  try {
    requireOperationAuthority(coreDb, context, mutating);
    return true;
  } catch {
    return false;
  }
}

/** Derives one deterministic identity for a reissuable read-only host inspection. */
function readRequestId(
  operation: 'status',
  context: WorkerEnvironmentOperationContext,
  binding: WorkerStorageBinding
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'worker-environment',
        operation,
        context.actor.userId,
        context.workspaceId,
        binding.storageRef,
        binding.revision,
        binding.attachmentGeneration,
      ])
    )
    .digest('hex');
}
