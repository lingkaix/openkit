import {
  type ConversationNavigationResponse,
  ConversationNavigationResponseSchema,
  type DashboardArtifactSummary,
  operationHttpPath,
  type ThreadDashboardResponse,
  ThreadDashboardResponseSchema,
  type ThreadWorkStatus,
  type WorkRouting,
  type WorkspaceDashboardResponse,
  WorkspaceDashboardResponseSchema,
} from '@openkit/app-api-schemas';
import {
  type ArtifactSchema,
  type ItemSchema,
  isRecoveryRewritableTurnStatus,
  isSealedTurnTerminal,
  type ThreadSchema,
  type TurnSchema,
} from '@openkit/protocol';
import { publishedErrorMessage } from './api-errors.js';
import { listOutputArtifacts } from './artifact-catalog.js';
import { isWorkspaceOperationAuthorized } from './auth/operation-authorizer.js';
import { isArtifactVisible, isThreadVisible } from './auth/thread-visibility.js';
import { type RuntimeConfigManager, resolveDefaultAgentId } from './config/runtime-config.js';
import { projectThreadTaskInputs } from './context/worker-context-projection.js';
import { CoreCommandError } from './core-command-errors.js';
import type { FsStore } from './lib/store.js';
import { QUICK_CHAT_AGENT_ID } from './mode-entry-routes.js';
import { listGoalsForThread } from './runtime/goal-owner.js';
import { projectApprovalEffect } from './runtime/pending-request-disclosure.js';
import { listThreadPendingRequests, validateCanonicalLoad } from './runtime/pending-requests.js';
import { readCommandRequestRecordsFromSqlite } from './storage/command-request-records.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { readThreadRuntimeActivity } from './storage/work-observations.js';

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
    (left.startedAt ?? '').localeCompare(right.startedAt ?? '')
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
    if (newest === null || artifact.updatedAt.localeCompare(newest.updatedAt) > 0) {
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
      store.getTurn(item.workspaceId, item.threadId, item.turnId);
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
      store.getTurn(item.workspaceId, item.threadId, item.turnId);
      return true;
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
  const activeTurn = [...turns].reverse().find((turn) => !isSealedTurnTerminal(turn.status));
  const latestArtifact = selectNewestArtifact(input.artifacts);
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
    const newestArtifact = selectNewestArtifact(threadArtifacts);
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
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const snapshot = runtimeConfigManager.current();
    const providerCount = snapshot.providerRegistry.list().length;
    const defaultAgentId = resolveDefaultAgentId(snapshot, workspaceId);
    const workspaceArtifacts = listOutputArtifacts(
      store,
      coreDb,
      workspaceId,
      actor.userId,
      administratorEligible
    );
    const counts = {
      ...workspace.counts,
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
    throw new CoreCommandError('not_found', publishedErrorMessage(error), 404);
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
  const {
    store,
    coreDb,
    runtimeConfigManager,
    repositoryWorkspaceDb,
    actor,
    workspaceId,
    threadId,
    administratorEligible,
  } = input;
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
  const thread = store.getThread(workspaceId, threadId);
  const visibleArtifacts = store
    .listArtifacts(workspaceId)
    .filter((artifact) => isArtifactVisible(store, artifact, actor?.userId, administratorEligible));
  const visibleArtifactIds = new Set(visibleArtifacts.map((artifact) => artifact.id));
  const turns = store.listThreadTurns(workspaceId, threadId).map((turn) => ({
    ...turn,
    items: turn.items.filter(
      (item) => item.type !== 'artifact-reference' || visibleArtifactIds.has(item.artifactId)
    ),
  }));
  const threadItems = store.listThreadItems(workspaceId, threadId);
  const participants = new Map<string, ThreadDashboardResponse['participants'][number]>();
  const authors = [
    ...threadItems.flatMap((item) => ('actor' in item ? [item.actor] : [])),
    ...turns.flatMap((turn) =>
      turn.agentId ? [{ kind: 'agent' as const, id: turn.agentId }] : []
    ),
  ];
  for (const { kind, id } of authors) {
    const key = `${kind}:${id}`;
    if (participants.has(key)) continue;
    const user =
      kind === 'user'
        ? (coreDb?.sqlite.prepare('SELECT display_name FROM users WHERE id = ?').get(id) as
            | { display_name: string }
            | undefined)
        : undefined;
    const agent =
      kind === 'agent'
        ? runtimeConfigManager.current().agentManifests.find((entry) => entry.id === id)
        : undefined;
    participants.set(key, {
      kind,
      id,
      displayName:
        user?.display_name.trim() ||
        agent?.displayName.trim() ||
        (kind === 'agent' && id === QUICK_CHAT_AGENT_ID
          ? 'Assistant'
          : kind === 'agent' && id === 'knowledge-manager'
            ? 'Knowledge Manager'
            : id),
    });
  }
  const latestTurn = turns.at(-1) ?? null;
  const defaultAgentId = resolveDefaultAgentId(runtimeConfigManager.current(), workspaceId);
  const selectedAgentId = latestTurn ? (latestTurn.agentId ?? null) : defaultAgentId;
  const threadArtifacts = listOutputArtifacts(
    store,
    coreDb,
    workspaceId,
    actor?.userId,
    administratorEligible
  ).filter((artifact) => artifact.threadId === threadId && visibleArtifactIds.has(artifact.id));
  const artifacts = threadArtifacts.map((artifact) => summarizeDashboardArtifact(artifact));
  let pendingRequests: ThreadDashboardResponse['pendingRequests'] = [];
  let taskInputs: ThreadDashboardResponse['taskInputs'] = [];
  let runtimeActivity: ThreadDashboardResponse['runtimeActivity'];
  if (coreDb) {
    let workspaceDb: WorkspaceDb | undefined;
    try {
      workspaceDb = repositoryWorkspaceDb(workspaceId);
      const workspaceTurns = store
        .listThreads(workspaceId)
        .flatMap((candidate) => store.listThreadTurns(workspaceId, candidate.id));
      const receipts = readCommandRequestRecordsFromSqlite(workspaceDb.sqlite);
      pendingRequests = listThreadPendingRequests(workspaceDb.sqlite, workspaceId, threadId).map(
        (record) => ({
          requestId: record.requestId,
          canRespond:
            actor?.userId === record.responsibleUserId &&
            isWorkspaceOperationAuthorized(coreDb, actor, workspaceId, {
              mutating: true,
              policyOperation: 'approval.respond',
            }),
          ...(record.kind === 'approval' && !validateCanonicalLoad(record, workspaceTurns, receipts)
            ? { approvalEffect: projectApprovalEffect({ record, store, coreDb, actor }) }
            : {}),
          state: validateCanonicalLoad(record, workspaceTurns, receipts)
            ? 'inspect-only'
            : record.state,
          resolution: record.resolution,
          ending: record.ending,
          disposition: record.disposition,
        })
      );
      const projected = new Set(pendingRequests.map((record) => record.requestId));
      const unreadable = workspaceDb.sqlite
        .prepare('SELECT request_id FROM pending_requests WHERE workspace_id = ? AND thread_id = ?')
        .all(workspaceId, threadId) as Array<{ request_id: string }>;
      for (const row of unreadable)
        if (!projected.has(row.request_id))
          pendingRequests.push({
            requestId: row.request_id,
            state: 'inspect-only',
            resolution: null,
            ending: null,
            disposition: null,
          });
      try {
        taskInputs = projectThreadTaskInputs({ coreDb, store, threadId, workspaceDb });
      } catch {
        taskInputs = [];
      }
      // Audience and Workspace lineage were checked before opening any activity or body reader.
      runtimeActivity = readThreadRuntimeActivity(workspaceDb, {
        threadId,
        turnIds: turns.map((turn) => turn.id),
      }).map((activity) => ({
        turnId: activity.turnId,
        contentCapture: activity.contentCapture,
        coverage: activity.coverage,
        entries: activity.entries.map((entry) => ({
          sequence: entry.sequence,
          observedAt: entry.observedAt,
          kind: entry.kind,
          label: entry.label,
          text: entry.text,
          textTruncated: entry.textTruncated,
        })),
        omittedEntryCount: activity.omittedEntryCount,
      }));
    } finally {
      workspaceDb?.sqlite.close();
    }
  }

  return ThreadDashboardResponseSchema.parse({
    viewerUserId: actor?.userId ?? null,
    participants: [...participants.values()],
    thread,
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
      defaultAgentId,
    },
    itemLog: {
      href: operationHttpPath('thread.items'),
    },
    taskInputs,
    pendingRequests,
    runtimeActivity,
  });
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

/** Reads current conversation activity after native Workspace admission, admitting each audience before dependent reads. */
export function readConversationNavigation({
  store,
  workspaceId,
  actor,
  coreDb,
  runtimeConfigManager,
  repositoryWorkspaceDb,
  administratorEligible = false,
}: {
  store: FsStore;
  workspaceId: string;
  actor: import('./auth/identity.js').Actor;
  coreDb: CoreDb | undefined;
  runtimeConfigManager: RuntimeConfigManager;
  repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  administratorEligible?: boolean;
}): ConversationNavigationResponse {
  let workspaceDb: WorkspaceDb | undefined;
  try {
    store.getWorkspace(workspaceId);
    const agents = runtimeConfigManager.current().agentManifests;
    workspaceDb = coreDb ? repositoryWorkspaceDb(workspaceId) : undefined;
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
      .filter((thread) => isThreadVisible(store, thread, actor?.userId, administratorEligible));
    const rows: ConversationNavigationResponse['items'] = visibleThreads
      .filter((thread) => thread.status === 'active')
      .map((thread) => {
        const turns = sortTurns(store.listThreadTurns(workspaceId, thread.id));
        const items = store.listThreadItems(workspaceId, thread.id);
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
        };
      });
    rows.sort(
      (left, right) =>
        Number(right.state !== 'idle') - Number(left.state !== 'idle') ||
        right.lastActivityAt.localeCompare(left.lastActivityAt) ||
        left.thread.id.localeCompare(right.thread.id)
    );
    return ConversationNavigationResponseSchema.parse({ items: rows });
  } catch (error) {
    throw new ConversationNavigationReadError(publishedErrorMessage(error));
  } finally {
    workspaceDb?.sqlite.close();
  }
}
