import {
  type ConversationNavigationResponse,
  ConversationNavigationResponseSchema,
  type WorkspaceDashboardResponse,
  WorkspaceDashboardResponseSchema,
} from '@openkit/app-api-schemas';
import {
  type ArtifactSchema,
  compareCodeUnits,
  type ItemSchema,
  isRecoveryRewritableTurnStatus,
  isSealedTurnTerminal,
  ThreadIdSchema,
  type ThreadSchema,
  TimestampSchema,
  type TurnSchema,
  WorkspaceIdSchema,
  workspaceIdForOwner,
} from '@openkit/protocol';
import { z } from 'zod';
import { publishedErrorMessage } from './api-errors.js';
import { listOutputArtifacts } from './artifact-catalog.js';
import {
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from './auth/operation-authorizer.js';
import { isThreadVisible } from './auth/thread-visibility.js';
import { type RuntimeConfigManager, resolveDefaultAgentId } from './config/runtime-config.js';
import type { FsStore } from './lib/store.js';
import { StoreRecordNotFoundError } from './lib/store.js';
import { OperationError } from './operation-error.js';
import { QUICK_CHAT_AGENT_ID } from './quick-chat-agent.js';
import { readAuthorizedWorkspaceNotebookPages } from './retrieval-knowledge-adapter.js';
import { listGoalsForThread } from './runtime/goal-owner.js';
import { getControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import type { CoreDb, UserDb, WorkspaceDb } from './storage/db.js';
import { readThreadReadReceipt } from './storage/thread-read-receipts.js';
import { readBoundedThreadDashboard } from './thread-dashboard.js';
import { receiptMessageItemIds } from './thread-read-state.js';

type Artifact = import('zod').infer<typeof ArtifactSchema>;
type Item = import('zod').infer<typeof ItemSchema>;
type Thread = import('zod').infer<typeof ThreadSchema>;
type Turn = import('zod').infer<typeof TurnSchema>;

/**
 * Returns true when a turn should appear as active work.
 *
 * @param status Turn status to test.
 * @returns True when the status is recovery rewritable.
 */
function isActiveWorkStatus(status: Turn['status']): boolean {
  return isRecoveryRewritableTurnStatus(status);
}

/**
 * Returns true when a turn needs user attention on the workspace dashboard.
 *
 * Product projection that differs from sealed terminals by omitting completed.
 *
 * Members: failed, interrupted, cancelled.
 *
 * @param status Turn status to test.
 * @returns True when the status is a sealed terminal other than completed.
 */
function isAttentionTurnStatus(status: Turn['status']): boolean {
  return isSealedTurnTerminal(status) && status !== 'completed';
}

/**
 * Sorts turns by their started timestamp.
 *
 * @param turns Turns to sort.
 * @returns Turns in ascending chronological order.
 */
function sortTurns(turns: readonly Turn[]): Turn[] {
  return [...turns].sort((left, right) =>
    compareCodeUnits(left.startedAt ?? '', right.startedAt ?? '')
  );
}

/**
 * Selects the newest Artifact without changing the input order or objects.
 *
 * @param artifacts Artifacts in the caller's existing order.
 * @returns The original newest Artifact, retaining the first timestamp tie, or null when empty.
 */
function selectNewestArtifact(artifacts: readonly Artifact[]): Artifact | null {
  let newest: Artifact | null = null;
  for (const artifact of artifacts) {
    if (newest === null || compareCodeUnits(artifact.updatedAt, newest.updatedAt) > 0) {
      newest = artifact;
    }
  }
  return newest;
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
      store.getTurn(workspaceIdForOwner(item.owner), item.threadId, item.turnId);
      return true;
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
      store.getTurn(workspaceIdForOwner(item.owner), item.threadId, item.turnId);
      return true;
    } catch {
      return false;
    }
  });
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
 * Converts dashboard attention Turn statuses to workspace attention kinds.
 *
 * Product projection that differs from sealed terminals by omitting completed.
 *
 * Members: failed, interrupted, cancelled.
 *
 * @param status Turn status to convert.
 * @returns Attention kind for failed, interrupted, and cancelled statuses.
 */
function terminalAttentionKind(
  status: Turn['status']
): WorkspaceDashboardResponse['attentionNeeded'][number]['kind'] | null {
  switch (status) {
    case 'failed':
    case 'interrupted':
    case 'cancelled':
      return status;
    case 'completed':
    case 'pending':
    case 'running':
      return null;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
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
    const newestArtifact = selectNewestArtifact(threadArtifacts);
    const activeTurn = [...turns].reverse().find((turn) => isActiveWorkStatus(turn.status));

    if (activeTurn) {
      activeWork.push({
        threadId: thread.id,
        title: threadTitle(thread),
        status: activeTurn.status,
        agentId: activeTurn.agentId ?? null,
        summary: thread.preview ?? null,
        updatedAt: activeTurn.startedAt ?? thread.updatedAt,
      });
    }

    for (const turn of turns) {
      // Product projection that differs from sealed terminals: recent completions include completed only.
      if (turn.status === 'completed' && turn.completedAt) {
        const turnArtifacts = threadArtifacts.filter((artifact) => artifact.turnId === turn.id);
        const latestTurnArtifact = selectNewestArtifact(turnArtifacts) ?? newestArtifact;

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
      .sort((left, right) => compareCodeUnits(right.updatedAt, left.updatedAt))
      .slice(0, 5),
    recentCompletions: recentCompletions
      .sort((left, right) => compareCodeUnits(right.completedAt, left.completedAt))
      .slice(0, 5),
    attentionNeeded: attentionNeeded
      .sort((left, right) => compareCodeUnits(right.updatedAt, left.updatedAt))
      .slice(0, 5),
  };
}

/** Reads the existing Workspace dashboard after primary admission; audience filtering includes current administrator eligibility. */
export function readWorkspaceDashboard(input: {
  store: FsStore;
  coreDb: CoreDb | undefined;
  runtimeConfigManager: RuntimeConfigManager;
  actor: import('./auth/identity.js').Actor;
  workspaceId: string;
  administratorEligible: boolean;
}) {
  const { store, coreDb, runtimeConfigManager, actor, workspaceId, administratorEligible } = input;
  try {
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
      .filter((thread) => isThreadVisible(store, thread, actor.userId, administratorEligible))
      .sort((left, right) => compareCodeUnits(right.updatedAt, left.updatedAt));
    const snapshot = runtimeConfigManager.current();
    const providerCount = snapshot.providerRegistry.list().length;
    const defaultAgentId = resolveDefaultAgentId(snapshot, workspaceId, actor.userId);
    const workspaceArtifacts = listOutputArtifacts(
      store,
      coreDb,
      workspaceId,
      actor.userId,
      administratorEligible
    );
    const counts = {
      ...workspace.counts,
      knowledgeEntryCount: store.getDataRoot()
        ? readAuthorizedWorkspaceNotebookPages({
            dataRoot: store.getDataRoot()!,
            workspaceId,
            access: {
              store,
              coreDb,
              actor: { kind: 'user', id: actor.userId },
              requestActor: actor,
            },
          }).pages.length
        : resources.knowledge.length,
      threadCount: threads.length,
      artifactCount: workspaceArtifacts.length,
    };
    const workSections = buildWorkspaceWorkSections(
      store,
      workspaceId,
      threads,
      workspaceArtifacts,
      approvalDecisionAuthorized,
      turnDecisionAuthorized,
      actor?.userId ?? null
    );

    return WorkspaceDashboardResponseSchema.parse({
      workspace: { ...workspace, counts },
      counts: {
        ...counts,
        providerCount,
      },
      defaultContext: {
        agentId: defaultAgentId,
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
    });
  } catch (error) {
    if (error instanceof StoreRecordNotFoundError)
      throw new OperationError('not_found', error.message, 404, { cause: error });
    throw error;
  }
}

/** Builds the existing dashboard after primary Workspace admission and addressed-Thread audience resolution. */
export function readThreadDashboard(input: {
  store: FsStore;
  coreDb: CoreDb | undefined;
  runtimeConfigManager: RuntimeConfigManager;
  repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  actor: import('./auth/identity.js').Actor;
  workspaceId: string;
  threadId: string;
  administratorEligible: boolean;
}) {
  return readBoundedThreadDashboard(input);
}

/** Owner-local navigation read failure; invocation preserves its published message, code and status. */
export class ConversationNavigationReadError extends Error {
  public readonly code = 'not_found';
  public readonly status = 404;

  public constructor(message: string) {
    super(message);
    this.name = 'ConversationNavigationReadError';
  }
}

/** A continuation is a scoped position, not a retained anchor or an authorization grant. */
const conversationNavigationCursorSchema = z.tuple([
  z.literal('conversation.navigation'),
  WorkspaceIdSchema,
  z.enum(['working', 'needs-you', 'idle']),
  TimestampSchema,
  ThreadIdSchema,
]);

type ConversationNavigationPosition = {
  state: ConversationNavigationResponse['items'][number]['state'];
  lastActivityAt: string;
  thread: { id: string };
};

/** Working and actionable rows sort before idle rows, then by descending activity timestamp and Thread id. */
function compareConversationNavigationPositions(
  left: ConversationNavigationPosition,
  right: ConversationNavigationPosition
): number {
  return (
    Number(right.state !== 'idle') - Number(left.state !== 'idle') ||
    compareCodeUnits(right.lastActivityAt, left.lastActivityAt) ||
    compareCodeUnits(right.thread.id, left.thread.id)
  );
}

/** Reject malformed or foreign positions without reading an anchor or disclosing cursor content. */
function decodeConversationNavigationCursor(
  cursor: string | undefined,
  workspaceId: string
): ConversationNavigationPosition | undefined {
  if (cursor === undefined) return undefined;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    const position = conversationNavigationCursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (bytes.toString('base64url') !== cursor || position[1] !== workspaceId) {
      throw new Error('Invalid conversation navigation continuation.');
    }
    return {
      state: position[2],
      lastActivityAt: position[3],
      thread: { id: position[4] },
    };
  } catch {
    throw new OperationError(
      'invalid_request',
      'Invalid conversation navigation continuation.',
      400
    );
  }
}

/** Reads current conversation activity after native Workspace admission, admitting each audience before dependent reads. */
export async function readConversationNavigation({
  store,
  workspaceId,
  limit,
  cursor,
  actor,
  coreDb,
  runtimeConfigManager,
  repositoryWorkspaceDb,
  administratorEligible = false,
  recheckAdmission,
}: {
  store: FsStore;
  workspaceId: string;
  limit?: number | undefined;
  cursor?: string | undefined;
  actor: import('./auth/identity.js').Actor;
  coreDb: CoreDb | undefined;
  runtimeConfigManager: RuntimeConfigManager;
  repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  administratorEligible?: boolean | undefined;
  recheckAdmission?: (() => Promise<void>) | undefined;
}): Promise<ConversationNavigationResponse> {
  let workspaceDb: WorkspaceDb | undefined;
  let userDb: UserDb | undefined;
  try {
    store.getWorkspace(workspaceId);
    const position = decodeConversationNavigationCursor(cursor, workspaceId);
    if (coreDb) {
      userDb = await getControlStoreWorkerClient().openInitializedUserReadDb(
        coreDb.dataRoot,
        actor.userId
      );
      await recheckAdmission?.();
      store.getWorkspace(workspaceId);
    }
    const agents = runtimeConfigManager.current().agentManifests;
    workspaceDb = coreDb ? repositoryWorkspaceDb(workspaceId) : undefined;
    const currentAdministratorEligible =
      administratorEligible &&
      (coreDb === undefined || isCurrentDeploymentAdministrator(coreDb, actor));
    const authorized = (policyOperation: 'approval.respond' | 'turn.run' | 'review.apply') =>
      coreDb === undefined ||
      isWorkspaceOperationAuthorized(coreDb, actor, workspaceId, {
        mutating: true,
        policyOperation,
      });
    const approvalAllowed = authorized('approval.respond');
    const turnAllowed = authorized('turn.run');
    const visibleThreads = store
      .listThreads(workspaceId)
      .filter((thread) =>
        isThreadVisible(store, thread, actor?.userId, currentAdministratorEligible)
      );
    const rows: ConversationNavigationResponse['items'] = visibleThreads
      .filter((thread) => thread.status === 'active')
      .map((thread) => {
        const turns = sortTurns(store.listThreadTurns(workspaceId, thread.id));
        const items = store.listThreadItems(workspaceId, thread.id);
        const readIds = new Set(
          userDb ? readThreadReadReceipt(userDb, workspaceId, thread.id) : []
        );
        const unreadCount = receiptMessageItemIds(items, actor.userId).filter(
          (id) => !readIds.has(id)
        ).length;
        const activeTurn = turns.findLast((turn) => !isSealedTurnTerminal(turn.status));
        const latestTurn = activeTurn ?? turns.at(-1);
        const goals = workspaceDb ? listGoalsForThread(workspaceDb, thread.id) : [];
        const activeGoal = goals.findLast((goal) => goal.disposition === null);
        const latestGoal = activeGoal ?? goals.at(-1);
        const hasGoalContext =
          latestGoal && (activeGoal || latestGoal.updatedAt >= (latestTurn?.startedAt ?? ''));
        const internalChat =
          latestTurn?.agentId === QUICK_CHAT_AGENT_ID ||
          latestTurn?.agentId === 'knowledge-manager';
        const worker =
          latestTurn?.agentSessionId || agents.some((agent) => agent.id === latestTurn?.agentId);
        const activity = hasGoalContext
          ? 'goal'
          : internalChat
            ? 'chat'
            : worker
              ? 'task'
              : !latestTurn
                ? 'chat'
                : 'unknown';
        const needsYou =
          pendingApprovalItems(store, items, approvalAllowed).length > 0 ||
          pendingQuestionItems(store, items, turnAllowed, actor?.userId ?? null).length > 0;
        const working = turns.some((turn) => isActiveWorkStatus(turn.status));
        const times = [
          ...turns.flatMap((turn) => [turn.startedAt, turn.completedAt]),
          ...items.flatMap((item) => [item.createdAt, item.completedAt]),
          ...goals.map((goal) => goal.updatedAt),
        ].filter((time): time is string => time !== null);
        return {
          thread,
          activity,
          state: needsYou ? 'needs-you' : working ? 'working' : 'idle',
          lastActivityAt: times.sort().at(-1) ?? thread.createdAt,
          unreadCount,
        };
      });
    const remaining = rows
      .sort(compareConversationNavigationPositions)
      .filter((row) => !position || compareConversationNavigationPositions(row, position) > 0);
    const items = limit === undefined ? remaining : remaining.slice(0, limit);
    const last = items.at(-1);
    return ConversationNavigationResponseSchema.parse({
      items,
      nextCursor:
        last && items.length < remaining.length
          ? Buffer.from(
              JSON.stringify([
                'conversation.navigation',
                workspaceId,
                last.state,
                last.lastActivityAt,
                last.thread.id,
              ])
            ).toString('base64url')
          : null,
    });
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new ConversationNavigationReadError(publishedErrorMessage(error));
  } finally {
    workspaceDb?.sqlite.close();
    userDb?.sqlite.close();
  }
}
