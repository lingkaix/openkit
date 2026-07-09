import type { ArtifactSchema, ItemSchema, ThreadSchema, TurnSchema } from '@openkit/protocol';

type Artifact = import('zod').infer<typeof ArtifactSchema>;
type Item = import('zod').infer<typeof ItemSchema>;
type Thread = import('zod').infer<typeof ThreadSchema>;
type Turn = import('zod').infer<typeof TurnSchema>;

/**
 * Product modes exposed by NanoCore app-level read models.
 */
export type ProductWorkMode = 'chat' | 'automation' | 'plan' | 'review' | 'organize' | 'delegation';

/**
 * Routing decision labels shown by product dashboard surfaces.
 */
export type WorkRoutingDecision =
  | 'quick_chat'
  | 'worker_turn'
  | 'review'
  | 'plan'
  | 'organize'
  | 'delegation'
  | 'handoff'
  | 'unsupported'
  | 'idle';

/**
 * Product-visible routing summary for the current workbench.
 */
export interface WorkRoutingSummary {
  /** NanoCore routing decision label. */
  decision: WorkRoutingDecision;
  /** Human-readable explanation for why this route was selected. */
  explanation: string;
  /** Worker agent selected by the route, when one applies. */
  selectedAgentId: string | null;
  /** Deterministic routing confidence for the current local read model. */
  confidence: number | null;
  /** Next user action needed before work can continue. */
  requiredUserAction: string | null;
}

/**
 * Compact artifact summary for dashboard read models.
 */
export interface DashboardArtifactSummary {
  /** Artifact id. */
  id: string;
  /** Artifact title. */
  title: string;
  /** Artifact lifecycle status. */
  status: Artifact['status'];
  /** Optional artifact summary. */
  summary: string | null;
  /** Last artifact update timestamp. */
  updatedAt: string;
}

/**
 * Thread-level product work status for the workbench header.
 */
export interface ThreadWorkStatus {
  /** Current product mode represented by the thread. */
  currentMode: ProductWorkMode;
  /** Selected worker agent id, when the mode delegates to a worker. */
  selectedAgentId: string | null;
  /** Active turn status or idle when the thread has no active turn. */
  activeTurnStatus: Turn['status'] | 'idle';
  /** Count of unresolved approval request items. */
  pendingApprovalCount: number;
  /** Count of unresolved user-input request items. */
  pendingQuestionCount: number;
  /** Most recently updated artifact attached to the thread. */
  latestArtifact: DashboardArtifactSummary | null;
  /** Product-visible NanoCore routing explanation. */
  routing: WorkRoutingSummary;
}

/**
 * Active work row for a workspace dashboard.
 */
export interface WorkspaceActiveWork {
  /** Thread id with active work. */
  threadId: string;
  /** Thread title. */
  title: string;
  /** Active turn status. */
  status: Turn['status'];
  /** Product mode for this work item. */
  mode: ProductWorkMode;
  /** Worker agent associated with the active turn. */
  agentId: string | null;
  /** Current thread preview. */
  summary: string | null;
  /** Timestamp used to sort active work. */
  updatedAt: string;
}

/**
 * Completed turn row for a workspace dashboard.
 */
export interface WorkspaceCompletion {
  /** Thread id with the completed turn. */
  threadId: string;
  /** Thread title. */
  title: string;
  /** Completed turn id. */
  turnId: string;
  /** Completion timestamp. */
  completedAt: string;
  /** Count of artifacts attached to the turn. */
  artifactCount: number;
  /** Completion summary from the latest artifact or thread preview. */
  summary: string | null;
}

/**
 * Attention-needed row for a workspace dashboard.
 */
export interface WorkspaceAttention {
  /** Thread id that needs attention. */
  threadId: string;
  /** Thread title. */
  title: string;
  /** Turn id that needs attention. */
  turnId: string;
  /** Attention category. */
  kind: 'approval' | 'question' | 'failed' | 'interrupted' | 'cancelled';
  /** Source item id when attention comes from an item. */
  itemId: string | null;
  /** Product-visible attention summary. */
  summary: string;
  /** Timestamp used to sort attention rows. */
  updatedAt: string;
}

/**
 * Workspace dashboard product work sections.
 */
export interface WorkspaceWorkSections {
  /** Running or pending worker work. */
  activeWork: WorkspaceActiveWork[];
  /** Recently completed worker turns. */
  recentCompletions: WorkspaceCompletion[];
  /** Work blocked on user attention or terminal failure. */
  attentionNeeded: WorkspaceAttention[];
}

/**
 * Input required to build one thread work status read model.
 */
export interface ThreadWorkStatusInput {
  /** Thread turn history. */
  turns: readonly Turn[];
  /** Thread item history. */
  items: readonly Item[];
  /** Thread artifact inventory. */
  artifacts: readonly Artifact[];
  /** Worker agent selected for this thread. */
  selectedAgentId: string | null;
}

/**
 * Input required to build workspace work sections.
 */
export interface WorkspaceWorkSectionsInput {
  /** Workspace threads sorted by the caller's preferred base ordering. */
  threads: readonly Thread[];
  /** Workspace artifact inventory. */
  artifacts: readonly Artifact[];
  /** Returns turns for one thread. */
  getThreadTurns(thread: Thread): readonly Turn[];
  /** Returns items for one thread. */
  getThreadItems(thread: Thread): readonly Item[];
  /** Resolves the worker agent associated with a turn. */
  resolveAgentId(turn: Turn): string | null;
}

const ACTIVE_WORK_STATUSES = new Set<Turn['status']>(['pending', 'running']);
const ATTENTION_TURN_STATUSES = new Set<Turn['status']>([
  'awaiting_human',
  'failed',
  'interrupted',
  'cancelled',
]);

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
 * @param items Thread items to inspect.
 * @returns Approval request items without a matching decision item.
 */
function pendingApprovalItems(
  items: readonly Item[]
): Array<Extract<Item, { type: 'approval-request' }>> {
  const decisions = new Set(
    items
      .filter((item): item is Extract<Item, { type: 'approval-decision' }> => {
        return item.type === 'approval-decision';
      })
      .map((item) => item.approvalRequestId)
  );

  return items.filter((item): item is Extract<Item, { type: 'approval-request' }> => {
    return item.type === 'approval-request' && !decisions.has(item.approvalRequestId);
  });
}

/**
 * Returns unresolved user-input request items.
 *
 * @param items Thread items to inspect.
 * @returns User-input request items without a matching response item.
 */
function pendingQuestionItems(
  items: readonly Item[]
): Array<Extract<Item, { type: 'user-input-request' }>> {
  const responses = new Set(
    items
      .filter((item): item is Extract<Item, { type: 'user-input-response' }> => {
        return item.type === 'user-input-response';
      })
      .map((item) => item.userInputRequestId)
  );

  return items.filter((item): item is Extract<Item, { type: 'user-input-request' }> => {
    return item.type === 'user-input-request' && !responses.has(item.userInputRequestId);
  });
}

/**
 * Converts a durable artifact into a compact dashboard summary.
 *
 * @param artifact Artifact to summarize.
 * @returns Dashboard artifact summary.
 */
export function summarizeDashboardArtifact(artifact: Artifact): DashboardArtifactSummary {
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
): WorkRoutingSummary {
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
function terminalAttentionKind(status: Turn['status']): WorkspaceAttention['kind'] | null {
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
export function buildThreadWorkStatus(input: ThreadWorkStatusInput): ThreadWorkStatus {
  const turns = sortTurns(input.turns);
  const activeTurn = [...turns]
    .reverse()
    .find((turn) => !['completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status));
  const latestArtifact = sortArtifactsNewestFirst(input.artifacts)[0] ?? null;
  const pendingApprovals = pendingApprovalItems(input.items);
  const pendingQuestions = pendingQuestionItems(input.items);

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
 * @param input Workspace work section source data.
 * @returns Active work, completions, and attention-needed sections.
 */
export function buildWorkspaceWorkSections(
  input: WorkspaceWorkSectionsInput
): WorkspaceWorkSections {
  const activeWork: WorkspaceActiveWork[] = [];
  const recentCompletions: WorkspaceCompletion[] = [];
  const attentionNeeded: WorkspaceAttention[] = [];

  for (const thread of input.threads) {
    const turns = sortTurns(input.getThreadTurns(thread));
    const items = input.getThreadItems(thread);
    const threadArtifacts = input.artifacts.filter((artifact) => artifact.threadId === thread.id);
    const newestArtifact = sortArtifactsNewestFirst(threadArtifacts)[0] ?? null;
    const activeTurn = [...turns].reverse().find((turn) => isActiveWorkStatus(turn.status));

    if (activeTurn) {
      activeWork.push({
        threadId: thread.id,
        title: threadTitle(thread),
        status: activeTurn.status,
        mode: 'automation',
        agentId: input.resolveAgentId(activeTurn),
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

    const pendingApproval = pendingApprovalItems(items)[0];

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

    const pendingQuestion = pendingQuestionItems(items)[0];

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
