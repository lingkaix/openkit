import {
  type WorkspaceWorker,
  type WorkspaceWorkerLastUsedModel,
  type WorkspaceWorkerPackageDetails,
  type WorkspaceWorkerPolicyDimension,
  WorkspaceWorkerStatusSchema,
  WorkspaceWorkersResponseSchema,
  type WorkspaceWorkerWork,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import { isWorkspaceOperationAuthorized } from '../auth/operation-authorizer.js';
import { isThreadVisible } from '../auth/thread-visibility.js';
import { readLatestCurrentAgentSessionLlmUsage } from '../capability/usage-ledger.js';
import type { AgentSession, FsStore } from '../lib/store.js';
import { registerAppApiRoute } from '../openapi.js';
import { requireAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import {
  listThreadWorkerCheckpoints,
  type WorkerCheckpointRecord,
} from '../runtime/worker-checkpoints.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { isCurrentAgentSessionStatus } from '../storage/workspace-file-records.js';

/**
 * Registers the selected-Workspace current Worker inventory read.
 *
 * @param dependencies Hono app and concrete Workspace owners.
 */
export function registerWorkspaceWorkerRoutes({
  app,
  coreDb,
  repositoryWorkspaceDb,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(app, 'listWorkspaceWorkers', (c) => {
    const store = requestStore(c);
    const workspaceId = c.req.param('workspaceId');
    const actor = c.get('actor');
    let workspaceDb: WorkspaceDb | undefined;
    try {
      store.getWorkspace(workspaceId);
      workspaceDb = repositoryWorkspaceDb(workspaceId);
      const openedWorkspaceDb = workspaceDb;
      const canReadUsage =
        coreDb !== undefined &&
        Boolean(actor) &&
        isWorkspaceOperationAuthorized(coreDb, actor, workspaceId, {
          mutating: false,
          policyOperation: 'audit.read',
        });
      const catalogById = new Map(
        store.getWorkspaceResources(workspaceId).agents.map((agent) => [agent.id, agent])
      );
      const items = store
        .listWorkspaceAgentSessions(workspaceId)
        .filter(
          (session) => session.threadId !== null && isCurrentAgentSessionStatus(session.status)
        )
        .flatMap((session) => {
          const threadId = session.threadId;
          if (!threadId) {
            return [];
          }
          let thread: ReturnType<FsStore['getThread']> | undefined;
          try {
            thread = store.getThread(workspaceId, threadId);
          } catch {
            return [];
          }
          if (!thread || !isThreadVisible(store, thread, actor?.userId)) {
            return [];
          }
          return [
            projectWorkspaceWorker({
              canReadUsage,
              catalogName: catalogById.get(session.agentId)?.name ?? null,
              session,
              store,
              threadTitle: thread.name ?? thread.preview ?? thread.id,
              workspaceDb: openedWorkspaceDb,
              workspaceId,
            }),
          ];
        })
        .sort((left, right) => left.threadId.localeCompare(right.threadId));

      return c.json(
        WorkspaceWorkersResponseSchema.parse({
          items,
          workspaceId,
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    } finally {
      workspaceDb?.sqlite.close();
    }
  });
}

/**
 * Projects one visible current AgentSession into a product-safe Worker row.
 *
 * @param input Visible session, Thread title, and authorized dependent-read handles.
 * @returns Public current Worker row.
 */
function projectWorkspaceWorker(input: {
  readonly canReadUsage: boolean;
  readonly catalogName: string | null;
  readonly session: AgentSession;
  readonly store: FsStore;
  readonly threadTitle: string;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
}): WorkspaceWorker {
  const threadId = input.session.threadId!;
  const packageRecord = readExactCurrentPackage(
    input.workspaceDb,
    input.workspaceId,
    input.session
  );
  const packageDetails = projectPackageDetails(packageRecord, threadId);
  const packageName = packageRecord?.snapshot.agent.displayName;
  return {
    agentId: input.session.agentId,
    agentName:
      input.catalogName ??
      (typeof packageName === 'string' && packageName.length > 0 ? packageName : null) ??
      input.session.agentId,
    lastUsedModel: projectLastUsedModel(input),
    packageDetails,
    recordUpdatedAt: input.session.updatedAt,
    stale: input.session.stale,
    status: WorkspaceWorkerStatusSchema.parse(input.session.status),
    threadId,
    threadTitle: input.threadTitle,
    work: projectWork(input.store, input.workspaceDb, input.workspaceId, threadId, input.session),
  };
}

/**
 * Projects exact current work from matching uncleared checkpoints and existing Turns.
 *
 * @param store Product store that owns Turns.
 * @param workspaceDb Workspace database that owns checkpoints.
 * @param workspaceId Selected Workspace id.
 * @param threadId Visible Thread id.
 * @param session Current AgentSession for the row.
 * @returns Exact current work, none, or unavailable.
 */
function projectWork(
  store: FsStore,
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  session: AgentSession
): WorkspaceWorkerWork {
  let assignment: WorkerCheckpointRecord | undefined;
  for (const checkpoint of listThreadWorkerCheckpoints(workspaceDb, workspaceId, threadId)) {
    // A pre-launch reservation cannot attribute work to a current Worker.
    if (checkpoint.workerSessionId === null) continue;
    let turn: ReturnType<FsStore['getTurn']>;
    try {
      turn = store.getTurn(workspaceId, threadId, checkpoint.turnId);
    } catch {
      if (checkpoint.workerSessionId === session.id) return { kind: 'unavailable' };
      continue;
    }
    if (checkpoint.workerSessionId !== session.id && turn.agentSessionId !== session.id) continue;
    if (
      checkpoint.workerSessionId !== session.id ||
      turn.agentSessionId !== session.id ||
      assignment
    ) {
      return { kind: 'unavailable' };
    }
    assignment = checkpoint;
  }
  if (!assignment) return { kind: 'none' };
  const { goalId, taskId, turnId } = assignment;
  if (goalId === null && taskId === null) {
    return { kind: 'task', turnId };
  }
  if (goalId !== null && taskId !== null) {
    return { goalId, kind: 'goal', taskId, turnId };
  }
  return { kind: 'unavailable' };
}

/**
 * Projects exact current package details after Workspace, Thread, and AgentSession scope match.
 *
 * @param packageRecord Exact current package snapshot, or null when missing.
 * @param threadId Visible Thread id.
 * @returns Available allowlisted package details, or unavailable.
 */
function projectPackageDetails(
  packageRecord: ReturnType<typeof readExactCurrentPackage>,
  threadId: string
): WorkspaceWorkerPackageDetails {
  if (!packageRecord || packageRecord.snapshot.scope.threadId !== threadId) {
    return { kind: 'unavailable' };
  }
  const preferredLogicalModelId = packageRecord.snapshot.llm.preferredLogicalModelId;
  if (typeof preferredLogicalModelId !== 'string' || preferredLogicalModelId.length === 0) {
    return { kind: 'unavailable' };
  }
  return {
    filesystem: projectPolicyDimension(packageRecord.snapshot.policy.filesystem),
    kind: 'available',
    mcpServers: packageRecord.snapshot.supply.mcpServers.map((server) => ({
      id: server.id,
      allowedTools: server.allowedTools,
      deniedTools: server.deniedTools,
      approvalRequiredTools: server.approvalRequiredTools,
    })),
    network: projectPolicyDimension(packageRecord.snapshot.policy.network),
    preferredLogicalModelId,
    process: projectPolicyDimension(packageRecord.snapshot.policy.process),
  };
}

/**
 * Reads the current package snapshot only when its pointer and session scope match exactly.
 *
 * @param workspaceDb Workspace database that owns package snapshots.
 * @param workspaceId Selected Workspace id.
 * @param session Current AgentSession whose package pointer is used.
 * @returns Matching snapshot, or null when the pointer or scope is not exact.
 */
function readExactCurrentPackage(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  session: AgentSession
) {
  if (!session.environmentPackageSnapshotId) {
    return null;
  }
  try {
    const record = requireAgentEnvironmentPackageSnapshot(
      workspaceDb,
      workspaceId,
      session.environmentPackageSnapshotId
    );
    if (
      record.snapshot.scope.workspaceId !== workspaceId ||
      record.snapshot.scope.threadId !== session.threadId ||
      record.snapshot.scope.agentSessionId !== session.id
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

/**
 * Copies filesystem, network, or process default, enforcement, and rule count only.
 *
 * @param value Package policy dimension.
 * @returns Product-safe policy summary.
 */
function projectPolicyDimension(value: unknown): WorkspaceWorkerPolicyDimension | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return {
    default: record.default === 'allow' || record.default === 'deny' ? record.default : null,
    enforcement:
      record.enforcement === 'openshell' || record.enforcement === 'none'
        ? record.enforcement
        : null,
    ruleCount: Array.isArray(record.rules) ? record.rules.length : 0,
  };
}

/**
 * Projects last-used LLM usage for the current AgentSession, or an explicit restriction.
 *
 * @param input Visible session and audit authorization for ledger access.
 * @returns Available usage, unavailable attribution, or restricted.
 */
function projectLastUsedModel(input: {
  readonly canReadUsage: boolean;
  readonly session: AgentSession;
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
}): WorkspaceWorkerLastUsedModel {
  if (!input.canReadUsage) {
    return { kind: 'restricted' };
  }
  const threadId = input.session.threadId;
  if (!threadId) {
    return { kind: 'unavailable' };
  }
  const usage = readLatestCurrentAgentSessionLlmUsage(input.workspaceDb, {
    agentSessionId: input.session.id,
    threadId,
    workspaceId: input.workspaceId,
  });
  if (!usage) {
    return { kind: 'unavailable' };
  }
  try {
    const turn = input.store.getTurn(input.workspaceId, threadId, usage.turnId);
    if (turn.agentSessionId !== input.session.id) {
      return { kind: 'unavailable' };
    }
  } catch {
    return { kind: 'unavailable' };
  }
  return {
    kind: 'available',
    modelId: usage.modelId,
    recordedAt: usage.recordedAt,
  };
}
