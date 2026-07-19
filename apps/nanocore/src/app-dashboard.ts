import {
  type DashboardArtifactSummary,
  ThreadDashboardResponseSchema,
  type ThreadWorkStatus,
  type WorkRouting,
  type WorkspaceDashboardResponse,
  WorkspaceDashboardResponseSchema,
} from '@openkit/app-api-schemas';
import type { ArtifactSchema, ItemSchema, ThreadSchema, TurnSchema } from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { asApiError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import {
  assertAuthorizedWorkspaceLineage,
  isWorkspaceOperationAuthorized,
} from './auth/operation-authorizer.js';
import type { RuntimeConfigManager } from './config/runtime-config.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import { getThreadAgentSession } from './runtime/agent-session-read-model.js';
import type { TurnExecutor } from './runtime/types.js';
import type { WorkerControlGateway } from './runtime/worker-control-gateway.js';
import { hasExactActiveHumanGate } from './runtime/worker-recovery.js';
import type { CoreDb } from './storage/db.js';

type Artifact = import('zod').infer<typeof ArtifactSchema>;
type Item = import('zod').infer<typeof ItemSchema>;
type Thread = import('zod').infer<typeof ThreadSchema>;
type Turn = import('zod').infer<typeof TurnSchema>;

const ACTIVE_WORK_STATUSES = new Set<Turn['status']>(['pending', 'running']);
const ATTENTION_TURN_STATUSES = new Set<Turn['status']>(['failed', 'interrupted', 'cancelled']);

/**
 * Returns true when a turn should appear as active work.
 *
 * @param status Turn status to test.
 * @returns True when the status is pending or running.
 */
function isActiveWorkStatus(status: Turn['status']): boolean {
  return ACTIVE_WORK_STATUSES.has(status);
}

/**
 * Returns true when a turn needs user attention on the workspace dashboard.
 *
 * @param status Turn status to test.
 * @returns True when the status is blocked or terminal with attention value.
 */
function isAttentionTurnStatus(status: Turn['status']): boolean {
  return ATTENTION_TURN_STATUSES.has(status);
}

/**
 * Sorts turns by their started timestamp.
 *
 * @param turns Turns to sort.
 * @returns Turns in ascending chronological order.
 */
function sortTurns(turns: readonly Turn[]): Turn[] {
  return [...turns].sort((left, right) =>
    (left.startedAt ?? '').localeCompare(right.startedAt ?? '')
  );
}

/**
 * Sorts artifacts by their update timestamp descending.
 *
 * @param artifacts Artifacts to sort.
 * @returns Artifacts in newest-first order.
 */
function sortArtifactsNewestFirst(artifacts: readonly Artifact[]): Artifact[] {
  return [...artifacts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * Returns unresolved approval request items.
 *
 * @param store Store that owns the exact human Gate.
 * @param items Thread items to inspect.
 * @param decisionAuthorized Whether the actor may respond to approvals.
 * @returns Completed approval request Items owned by an exact active Gate.
 */
function pendingApprovalItems(
  store: FsStore,
  items: readonly Item[],
  decisionAuthorized: boolean
): Array<Extract<Item, { type: 'approval-request' }>> {
  if (!decisionAuthorized) {
    return [];
  }
  const decisions = new Set(
    items
      .filter((item): item is Extract<Item, { type: 'approval-decision' }> => {
        return item.type === 'approval-decision';
      })
      .map((item) => item.approvalRequestId)
  );

  return items.filter((item): item is Extract<Item, { type: 'approval-request' }> => {
    if (
      item.type !== 'approval-request' ||
      item.status !== 'completed' ||
      decisions.has(item.approvalRequestId)
    ) {
      return false;
    }
    try {
      const turn = store.getTurn(item.workspaceId, item.threadId, item.turnId);
      return (
        hasExactActiveHumanGate(store, turn) &&
        turn.humanGate.kind === 'approval' &&
        turn.humanGate.itemId === item.id &&
        turn.humanGate.approvalRequestId === item.approvalRequestId
      );
    } catch {
      return false;
    }
  });
}

/**
 * Returns unresolved user-input request items.
 *
 * @param store Store that owns the exact human Gate.
 * @param items Thread items to inspect.
 * @param decisionAuthorized Whether the actor may run the responding Turn operation.
 * @param responsibleUserId Actor id that must exactly own the input request.
 * @returns Completed non-secret unique-question Items owned by an exact active Gate.
 */
function pendingQuestionItems(
  store: FsStore,
  items: readonly Item[],
  decisionAuthorized: boolean,
  responsibleUserId: string | null
): Array<Extract<Item, { type: 'user-input-request' }>> {
  if (!decisionAuthorized) {
    return [];
  }
  const responses = new Set(
    items
      .filter((item): item is Extract<Item, { type: 'user-input-response' }> => {
        return item.type === 'user-input-response';
      })
      .map((item) => item.userInputRequestId)
  );

  return items.filter((item): item is Extract<Item, { type: 'user-input-request' }> => {
    if (item.type !== 'user-input-request') {
      return false;
    }
    const questionIds = item.questions.map((question) => question.id);
    if (
      item.status !== 'completed' ||
      item.responsibleUserId !== responsibleUserId ||
      responses.has(item.userInputRequestId) ||
      item.questions.some((question) => question.isSecret) ||
      new Set(questionIds).size !== questionIds.length
    ) {
      return false;
    }
    try {
      const turn = store.getTurn(item.workspaceId, item.threadId, item.turnId);
      return (
        hasExactActiveHumanGate(store, turn) &&
        turn.humanGate.kind === 'user-input' &&
        turn.humanGate.itemId === item.id &&
        turn.humanGate.userInputRequestId === item.userInputRequestId
      );
    } catch {
      return false;
    }
  });
}

/**
 * Converts a durable artifact into a compact dashboard summary.
 *
 * @param artifact Artifact to summarize.
 * @returns Dashboard artifact summary.
 */
function summarizeDashboardArtifact(artifact: Artifact): DashboardArtifactSummary {
  return {
    id: artifact.id,
    title: artifact.title,
    status: artifact.status,
    summary: artifact.summary,
    updatedAt: artifact.updatedAt,
  };
}

/**
 * Builds the product-visible routing explanation for a worker-backed thread.
 *
 * @param selectedAgentId Worker agent id selected for the thread.
 * @param pendingApprovalCount Number of pending approvals.
 * @param pendingQuestionCount Number of pending questions.
 * @returns Routing summary for the thread.
 */
function buildWorkerRouting(
  selectedAgentId: string | null,
  pendingApprovalCount: number,
  pendingQuestionCount: number
): WorkRouting {
  if (!selectedAgentId) {
    return {
      decision: 'unsupported',
      explanation: 'NanoCore cannot route this thread until a worker agent is selected.',
      selectedAgentId: null,
      confidence: 1,
      requiredUserAction: 'Select a worker agent before starting a turn.',
    };
  }

  const requiredUserAction =
    pendingApprovalCount > 0 && pendingQuestionCount > 0
      ? 'Respond to the pending approval and question.'
      : pendingApprovalCount > 0
        ? 'Respond to the pending approval.'
        : pendingQuestionCount > 0
          ? 'Respond to the pending question.'
          : null;

  return {
    decision: 'worker_turn',
    explanation:
      'NanoCore routes thread prompts through WorkerCoordinator to the selected worker agent because automation changes workspace state.',
    selectedAgentId,
    confidence: 1,
    requiredUserAction,
  };
}

/**
 * Returns a stable product title for a thread.
 *
 * @param thread Thread to name.
 * @returns Thread name, preview, or id.
 */
function threadTitle(thread: Thread): string {
  return thread.name ?? thread.preview ?? thread.id;
}

/**
 * Converts failed terminal turn statuses to workspace attention kinds.
 *
 * @param status Turn status to convert.
 * @returns Attention kind for failed terminal statuses.
 */
function terminalAttentionKind(
  status: Turn['status']
): WorkspaceDashboardResponse['attentionNeeded'][number]['kind'] | null {
  switch (status) {
    case 'failed':
    case 'interrupted':
    case 'cancelled':
      return status;
    default:
      return null;
  }
}

/**
 * Returns a product-visible terminal turn summary.
 *
 * @param turn Turn that needs attention.
 * @returns Error message or generic status summary.
 */
function terminalTurnSummary(turn: Turn): string {
  return turn.error?.message ?? `${turn.status} turn needs review.`;
}

/**
 * Builds a thread-level product work status read model.
 *
 * @param input Thread work status source data.
 * @returns Product work status for the thread workbench.
 */
function buildThreadWorkStatus(input: {
  store: FsStore;
  turns: readonly Turn[];
  items: readonly Item[];
  artifacts: readonly Artifact[];
  selectedAgentId: string | null;
  approvalDecisionAuthorized: boolean;
  turnDecisionAuthorized: boolean;
  responsibleUserId: string | null;
}): ThreadWorkStatus {
  const turns = sortTurns(input.turns);
  const activeTurn = [...turns]
    .reverse()
    .find((turn) => !['completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status));
  const latestArtifact = sortArtifactsNewestFirst(input.artifacts)[0] ?? null;
  const pendingApprovals = pendingApprovalItems(
    input.store,
    input.items,
    input.approvalDecisionAuthorized
  );
  const pendingQuestions = pendingQuestionItems(
    input.store,
    input.items,
    input.turnDecisionAuthorized,
    input.responsibleUserId
  );

  return {
    currentMode: 'automation',
    selectedAgentId: input.selectedAgentId,
    activeTurnStatus: activeTurn?.status ?? 'idle',
    pendingApprovalCount: pendingApprovals.length,
    pendingQuestionCount: pendingQuestions.length,
    latestArtifact: latestArtifact ? summarizeDashboardArtifact(latestArtifact) : null,
    routing: buildWorkerRouting(
      input.selectedAgentId,
      pendingApprovals.length,
      pendingQuestions.length
    ),
  };
}

/**
 * Builds workspace-level product work sections.
 *
 * @param store Store that owns dashboard records.
 * @param workspaceId Workspace whose work sections are projected.
 * @param threads Workspace threads in the caller's preferred base ordering.
 * @param artifacts Workspace artifact inventory.
 * @param approvalDecisionAuthorized Whether the actor may respond to approvals.
 * @param turnDecisionAuthorized Whether the actor may run the responding Turn operation.
 * @param responsibleUserId Actor id that must exactly own user-input requests.
 * @returns Active work, completions, and attention-needed sections.
 */
function buildWorkspaceWorkSections(
  store: FsStore,
  workspaceId: string,
  threads: readonly Thread[],
  artifacts: readonly Artifact[],
  approvalDecisionAuthorized: boolean,
  turnDecisionAuthorized: boolean,
  responsibleUserId: string | null
): Pick<WorkspaceDashboardResponse, 'activeWork' | 'recentCompletions' | 'attentionNeeded'> {
  const activeWork: WorkspaceDashboardResponse['activeWork'] = [];
  const recentCompletions: WorkspaceDashboardResponse['recentCompletions'] = [];
  const attentionNeeded: WorkspaceDashboardResponse['attentionNeeded'] = [];

  for (const thread of threads) {
    const turns = sortTurns(store.listThreadTurns(workspaceId, thread.id));
    const items = store.listThreadItems(workspaceId, thread.id);
    const threadArtifacts = artifacts.filter((artifact) => artifact.threadId === thread.id);
    const newestArtifact = sortArtifactsNewestFirst(threadArtifacts)[0] ?? null;
    const activeTurn = [...turns].reverse().find((turn) => isActiveWorkStatus(turn.status));

    if (activeTurn) {
      activeWork.push({
        threadId: thread.id,
        title: threadTitle(thread),
        status: activeTurn.status,
        mode: 'automation',
        agentId: activeTurn.agentId ?? null,
        summary: thread.preview ?? null,
        updatedAt: activeTurn.startedAt ?? thread.updatedAt,
      });
    }

    for (const turn of turns) {
      if (turn.status === 'completed' && turn.completedAt) {
        const turnArtifacts = threadArtifacts.filter((artifact) => artifact.turnId === turn.id);
        const latestTurnArtifact = sortArtifactsNewestFirst(turnArtifacts)[0] ?? newestArtifact;

        recentCompletions.push({
          threadId: thread.id,
          title: threadTitle(thread),
          turnId: turn.id,
          completedAt: turn.completedAt,
          artifactCount: turnArtifacts.length,
          summary: latestTurnArtifact?.summary ?? thread.preview ?? null,
        });
      }
    }

    const pendingApproval = pendingApprovalItems(store, items, approvalDecisionAuthorized)[0];

    if (pendingApproval) {
      attentionNeeded.push({
        threadId: thread.id,
        title: threadTitle(thread),
        turnId: pendingApproval.turnId,
        kind: 'approval',
        itemId: pendingApproval.id,
        summary: pendingApproval.title,
        updatedAt: pendingApproval.createdAt,
      });
      continue;
    }

    const pendingQuestion = pendingQuestionItems(
      store,
      items,
      turnDecisionAuthorized,
      responsibleUserId
    )[0];

    if (pendingQuestion) {
      attentionNeeded.push({
        threadId: thread.id,
        title: threadTitle(thread),
        turnId: pendingQuestion.turnId,
        kind: 'question',
        itemId: pendingQuestion.id,
        summary: pendingQuestion.prompt,
        updatedAt: pendingQuestion.createdAt,
      });
      continue;
    }

    const attentionTurn = [...turns].reverse().find((turn) => isAttentionTurnStatus(turn.status));
    const attentionKind = attentionTurn ? terminalAttentionKind(attentionTurn.status) : null;

    if (attentionTurn && attentionKind) {
      attentionNeeded.push({
        threadId: thread.id,
        title: threadTitle(thread),
        turnId: attentionTurn.id,
        kind: attentionKind,
        itemId: null,
        summary: terminalTurnSummary(attentionTurn),
        updatedAt: attentionTurn.completedAt ?? attentionTurn.startedAt ?? thread.updatedAt,
      });
    }
  }

  return {
    activeWork: activeWork
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 5),
    recentCompletions: recentCompletions
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
      .slice(0, 5),
    attentionNeeded: attentionNeeded
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 5),
  };
}

/**
 * Registers workspace and thread dashboard routes.
 *
 * @param dependencies Hono app and current dashboard data owners.
 */
export function registerDashboardRoutes({
  app,
  coreDb,
  requestStore,
  runtimeConfigManager,
  turnExecutor,
  workerControlGateway,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly runtimeConfigManager: RuntimeConfigManager;
  readonly turnExecutor: TurnExecutor;
  readonly workerControlGateway: WorkerControlGateway;
}): void {
  registerAppApiRoute(app, 'getWorkspaceDashboard', (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const actor = c.get('actor');
      const approvalDecisionAuthorized =
        coreDb === undefined ||
        (actor !== undefined &&
          isWorkspaceOperationAuthorized(coreDb, actor, workspaceId, {
            mutating: true,
            policyOperation: 'approval.respond',
          }));
      const turnDecisionAuthorized =
        coreDb === undefined ||
        (actor !== undefined &&
          isWorkspaceOperationAuthorized(coreDb, actor, workspaceId, {
            mutating: true,
            policyOperation: 'turn.run',
          }));
      const workspace = store.getWorkspace(workspaceId);
      const resources = store.getWorkspaceResources(workspaceId);
      const threads = store
        .listThreads(workspaceId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const providerCount = runtimeConfigManager.current().providerRegistry.list().length;
      const workspaceArtifacts = store.listArtifacts(workspaceId);
      const workSections = buildWorkspaceWorkSections(
        store,
        workspaceId,
        threads,
        workspaceArtifacts,
        approvalDecisionAuthorized,
        turnDecisionAuthorized,
        actor?.userId ?? null
      );

      return c.json(
        WorkspaceDashboardResponseSchema.parse({
          workspace,
          counts: {
            ...workspace.counts,
            providerCount,
          },
          defaultContext: {
            modelId: workspace.defaults?.defaultModelId ?? null,
            agentId: workspace.defaults?.defaultAgentId ?? null,
            skillIds: workspace.defaults?.defaultSkillIds ?? [],
          },
          agentHealth: resources.agents.map((agent) => ({
            agentId: agent.id,
            status: agent.health.status,
            message: agent.health.message,
            checkedAt: agent.health.checkedAt,
          })),
          recentThreads: threads.slice(0, 10),
          activeWork: workSections.activeWork,
          recentCompletions: workSections.recentCompletions,
          attentionNeeded: workSections.attentionNeeded,
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'getThreadDashboard', (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const actor = c.get('actor');
      const approvalDecisionAuthorized =
        coreDb === undefined ||
        (actor !== undefined &&
          isWorkspaceOperationAuthorized(coreDb, actor, workspaceId, {
            mutating: true,
            policyOperation: 'approval.respond',
          }));
      const turnDecisionAuthorized =
        coreDb === undefined ||
        (actor !== undefined &&
          isWorkspaceOperationAuthorized(coreDb, actor, workspaceId, {
            mutating: true,
            policyOperation: 'turn.run',
          }));
      const threadId = c.req.param('threadId');
      const workspace = store.getWorkspace(workspaceId);
      const workspaceAccess = c.get('workspaceAccess');
      let thread: ReturnType<FsStore['getThread']>;
      try {
        thread = store.getThread(workspaceId, threadId);
      } catch (error) {
        if (workspaceAccess) {
          assertAuthorizedWorkspaceLineage(workspaceAccess, null);
        }
        throw error;
      }
      if (workspaceAccess) {
        assertAuthorizedWorkspaceLineage(workspaceAccess, thread.workspaceId);
      }
      const turns = store.listThreadTurns(workspaceId, threadId);
      const threadItems = store.listThreadItems(workspaceId, threadId);
      const latestTurn = turns.at(-1) ?? null;
      const selectedAgentId = latestTurn
        ? (latestTurn.agentId ?? null)
        : (workspace.defaults?.defaultAgentId ?? null);
      const threadArtifacts = store
        .listArtifacts(workspaceId)
        .filter((artifact) => artifact.threadId === threadId);
      const artifacts = threadArtifacts.map((artifact) => summarizeDashboardArtifact(artifact));

      return c.json(
        ThreadDashboardResponseSchema.parse({
          thread,
          activeSession: getThreadAgentSession(
            turnExecutor,
            store,
            workspaceId,
            threadId,
            runtimeConfigManager.current().version,
            workerControlGateway
          ),
          turns,
          artifacts,
          workStatus: buildThreadWorkStatus({
            store,
            turns,
            items: threadItems,
            artifacts: threadArtifacts,
            selectedAgentId,
            approvalDecisionAuthorized,
            turnDecisionAuthorized,
            responsibleUserId: actor?.userId ?? null,
          }),
          composer: {
            disabled: !turnDecisionAuthorized,
            defaultModelId: workspace.defaults?.defaultModelId ?? null,
            defaultAgentId: workspace.defaults?.defaultAgentId ?? null,
          },
          itemLog: {
            href: `/api/app/workspaces/${workspaceId}/threads/${threadId}/items`,
          },
        })
      );
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      return asApiError((error as Error).message);
    }
  });
}
