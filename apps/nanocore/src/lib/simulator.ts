import type { ApprovalRequestSchema, ItemSchema, ItemType } from '@openkit/protocol';
import { ItemDeltaEventSchema } from '@openkit/protocol';
import type { z } from 'zod';

import type {
  AgentSessionReadModel,
  ApprovalDecision,
  RuntimeCapabilities,
  RuntimeEventFamily,
  RuntimeItemDeltaKind,
  RuntimeItemType,
  TurnCommandRuntimeContext,
  TurnExecutor,
  TurnStartRuntimeContext,
} from '../runtime/types.js';
import type { FsStore } from './store.js';

type RuntimeItem = z.infer<typeof ItemSchema>;

interface SimulatedTurnState {
  workspaceId: string;
  threadId: string;
  turnId: string;
  agentSessionId: string;
  approvalId: string;
  requestId: string | null;
  userInputRequestId: string;
}

/**
 * Capability flags supported by the deterministic simulator.
 */
export const SIMULATOR_CAPABILITIES: RuntimeCapabilities = {
  approvals: true,
  interrupts: true,
  artifacts: true,
  workspaceConfig: true,
  workspaceKnowledgeEditing: true,
  questions: true,
};

/**
 * SSE event families emitted by the deterministic simulator.
 */
export const SIMULATOR_EVENT_FAMILIES: readonly RuntimeEventFamily[] = [
  'workspace.updated',
  'thread.created',
  'thread.updated',
  'turn.started',
  'turn.updated',
  'item.created',
  'item.delta',
  'item.completed',
  'approval.requested',
  'approval.resolved',
  'agent.session.updated',
  'artifact.created',
  'artifact.updated',
  'turn.completed',
  'error',
];

/**
 * Protocol item types emitted by the deterministic simulator.
 */
export const SIMULATOR_ITEM_TYPES: readonly RuntimeItemType[] = [
  'user-message',
  'assistant-message',
  'reasoning',
  'command-execution',
  'approval-request',
  'approval-decision',
  'user-input-request',
  'user-input-response',
  'artifact-reference',
];

/**
 * Protocol delta kinds emitted by the deterministic simulator.
 */
export const SIMULATOR_ITEM_DELTA_KINDS: readonly RuntimeItemDeltaKind[] = [
  'text-delta',
  'indexed-text-delta',
  'output-delta',
  'artifact-updated',
];

/**
 * Deterministic no-Codex turn executor used for local UI and e2e development.
 */
export class SimulatedTurnExecutor implements TurnExecutor {
  public readonly capabilities = SIMULATOR_CAPABILITIES;
  public readonly eventFamilies = SIMULATOR_EVENT_FAMILIES;
  public readonly itemTypes = SIMULATOR_ITEM_TYPES;
  public readonly itemDeltaKinds = SIMULATOR_ITEM_DELTA_KINDS;
  private readonly pendingByApprovalId = new Map<string, SimulatedTurnState>();
  private readonly pendingByTurnId = new Map<string, SimulatedTurnState>();

  /**
   * Starts one deterministic simulated turn and pauses on approval.
   */
  public async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
  ): Promise<void> {
    const turn = store.getTurnById(turnId);
    if (!turn.agentId) {
      throw new Error(`Simulator turn has no assigned agent: ${turn.id}`);
    }
    const selectedAgent = store.getAgent(turn.workspaceId, turn.agentId);
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const agentSession = store.createAgentSession({
      id: `session_sim_turn_${turn.id}`,
      agentId: selectedAgent.id,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      status: 'created',
      message: null,
      configVersion: turn.configVersion,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const selectedProfile =
      selectedAgent.profiles.find((profile) => profile.id === selectedAgent.defaultProfileId) ??
      selectedAgent.profiles[0] ??
      null;

    store.updateTurn(turnId, {
      agentProfileId: selectedProfile?.id ?? null,
      agentSessionId: agentSession.id,
    });
    const state: SimulatedTurnState = {
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      agentSessionId: agentSession.id,
      approvalId: `ap_${turnId}`,
      requestId: context.requestId ?? null,
      userInputRequestId: `ui_${turnId}`,
    };

    this.emitStartedEnvelope(store, state, agentSession, input);
    this.emitAssistant(store, state);
    this.emitReasoning(store, state);
    this.emitCommand(store, state);
    this.emitApprovalRequest(store, state);
    this.pendingByApprovalId.set(state.approvalId, state);
  }

  /**
   * Interrupts one simulated turn and emits a terminal interrupted state.
   */
  public async interruptTurn(
    store: FsStore,
    turnId: string,
    context: TurnCommandRuntimeContext = { requestId: null }
  ): Promise<void> {
    const turnRecord = store.getTurnById(turnId);
    if (!turnRecord.agentSessionId) {
      throw new Error(`Simulator turn has no assigned agent session: ${turnId}`);
    }
    const state = this.pendingByTurnId.get(turnId) ?? {
      workspaceId: turnRecord.workspaceId,
      threadId: turnRecord.threadId,
      turnId,
      agentSessionId: turnRecord.agentSessionId,
      approvalId: `ap_${turnId}`,
      requestId: context.requestId,
      userInputRequestId: `ui_${turnId}`,
    };
    state.requestId = context.requestId;
    const completedAt = new Date().toISOString();
    const agentSession = store.updateAgentSession(state.agentSessionId, {
      status: 'failed',
      message: 'The simulator turn was interrupted.',
      updatedAt: completedAt,
    });
    const turn = store.updateTurn(turnId, {
      status: 'interrupted',
      completedAt,
    });

    store.emitTurnEvent(turnId, {
      event: 'agent.session.updated',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId,
      data: { type: 'agent-session-updated', agentSession },
    });
    store.emitTurnEvent(turnId, {
      event: 'turn.completed',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId,
      data: { type: 'turn-completed', stopReason: 'aborted', turn },
    });
    this.pendingByApprovalId.delete(state.approvalId);
    this.pendingByTurnId.delete(turnId);
  }

  /**
   * Resolves the simulator approval and pauses on the deterministic question.
   */
  public async respondApproval(
    store: FsStore,
    approvalRequestId: string,
    decision: ApprovalDecision,
    context: TurnCommandRuntimeContext = { requestId: null }
  ): Promise<z.infer<typeof ApprovalRequestSchema>> {
    const state = this.pendingByApprovalId.get(approvalRequestId);

    if (!state) {
      throw new Error(`Simulator approval request is not active: ${approvalRequestId}`);
    }

    state.requestId = context.requestId;
    const timestamp = new Date().toISOString();
    const approval = store.updateApproval(approvalRequestId, {
      status: decision,
      resolvedAt: timestamp,
    });
    const decisionItem = store.createItem({
      id: `it_approval_decision_${state.turnId}`,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      type: 'approval-decision',
      status: 'completed',
      approvalRequestId,
      decision,
      createdAt: timestamp,
      completedAt: timestamp,
    });

    this.emitItemCreated(store, state, decisionItem);
    this.emitItemCompleted(store, state, decisionItem);
    store.emitTurnEvent(state.turnId, {
      event: 'approval.resolved',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'approval-resolved', approval },
    });
    this.pendingByApprovalId.delete(approvalRequestId);

    if (decision === 'denied') {
      this.failTurn(store, state, 'approval_denied', 'The simulator approval was denied.');
      return approval;
    }

    const requestItem = store.createItem({
      id: `it_user_input_request_${state.turnId}`,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      type: 'user-input-request',
      status: 'completed',
      userInputRequestId: state.userInputRequestId,
      prompt: 'Which summary tone should the simulator use?',
      questions: [
        {
          id: 'tone',
          header: 'Tone',
          question: 'Which summary tone should the simulator use?',
          options: null,
          isOther: false,
          isSecret: false,
        },
      ],
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const agentSession = store.updateAgentSession(state.agentSessionId, { status: 'suspended' });
    const turn = store.updateTurn(state.turnId, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'user-input',
        userInputRequestId: state.userInputRequestId,
        itemId: requestItem.id,
      },
    });

    this.pendingByTurnId.set(state.turnId, state);
    this.emitItemCreated(store, state, requestItem);
    this.emitItemCompleted(store, state, requestItem);
    this.emitTurnUpdated(store, state, turn);
    this.emitAgentSessionUpdated(store, state, agentSession);
    return approval;
  }

  /**
   * Returns the deterministic simulator session bound to one thread.
   */
  public getAgentSession(
    store: FsStore,
    workspaceId: string,
    threadId: string
  ): AgentSessionReadModel {
    const sessions = store.listThreadAgentSessions(workspaceId, threadId);
    const activeSessionId = store
      .listThreadTurns(workspaceId, threadId)
      .findLast(
        (turn) =>
          !['completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status) &&
          turn.agentSessionId?.startsWith('session_sim_turn_')
      )?.agentSessionId;
    const storedSession =
      sessions.find((session) => session.id === activeSessionId) ??
      sessions.findLast((session) => session.id.startsWith('session_sim_turn_'));

    return {
      id: storedSession?.id ?? `session_sim_${threadId}`,
      status: storedSession?.status ?? 'ready',
      message: null,
      configVersion: storedSession?.configVersion ?? null,
      workspaceRoots: storedSession?.workspaceRoots ?? [],
      stale: false,
      sandboxSummary: storedSession?.sandboxSummary ?? null,
      backend: {
        kind: 'unknown',
        health: 'not-applicable',
        controlMode: null,
        control: null,
        gatewayName: null,
        gatewayEndpoint: null,
        version: null,
        sandboxName: null,
      },
    };
  }

  /**
   * Returns deterministic simulator sessions for every thread in the workspace.
   */
  public refreshAgentSessions(store: FsStore, workspaceId: string): AgentSessionReadModel[] {
    return store
      .listThreads(workspaceId)
      .map((thread) => this.getAgentSession(store, workspaceId, thread.id));
  }

  /**
   * Resolves the simulator question, emits an artifact update, and completes the turn.
   */
  public async respondUserInput(
    store: FsStore,
    turnId: string,
    input: string,
    context: TurnCommandRuntimeContext = { requestId: null }
  ) {
    const state = this.pendingByTurnId.get(turnId);

    if (!state) {
      throw new Error(`Simulator user-input request is not active for turn: ${turnId}`);
    }

    state.requestId = context.requestId;
    const timestamp = new Date().toISOString();
    const responseItem = store.createItem({
      id: `it_user_input_response_${turnId}`,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId,
      type: 'user-input-response',
      status: 'completed',
      userInputRequestId: state.userInputRequestId,
      answers: { tone: [input] },
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const runningTurn = store.updateTurn(turnId, { status: 'running', humanGate: null });
    const runningAgentSession = store.updateAgentSession(state.agentSessionId, {
      status: 'busy',
    });

    this.emitItemCreated(store, state, responseItem);
    this.emitItemCompleted(store, state, responseItem);
    this.emitTurnUpdated(store, state, runningTurn);
    this.emitAgentSessionUpdated(store, state, runningAgentSession);
    this.emitArtifactAndComplete(store, state, input);
    this.pendingByTurnId.delete(turnId);
    return store.getTurnById(turnId);
  }

  /**
   * Emits the shared turn-start, user item, and agent-session events.
   */
  private emitStartedEnvelope(
    store: FsStore,
    state: SimulatedTurnState,
    agentSession: ReturnType<FsStore['createAgentSession']>,
    input: string
  ): void {
    const turn = store.getTurnById(state.turnId);
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const userItem = store.createItem({
      id: `it_user_${state.turnId}`,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      type: 'user-message',
      status: 'completed',
      text: input,
      createdAt: timestamp,
      completedAt: timestamp,
    });

    store.emitTurnEvent(state.turnId, {
      event: 'turn.started',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'turn-started', turnId: state.turnId, status: 'running' },
    });
    this.emitItemCreated(store, state, userItem);
    this.emitItemCompleted(store, state, userItem);
    this.emitAgentSessionUpdated(store, state, agentSession);
  }

  /**
   * Emits an assistant message with text deltas.
   */
  private emitAssistant(store: FsStore, state: SimulatedTurnState): void {
    const timestamp = new Date().toISOString();
    const assistantItem = store.createItem({
      id: `it_assistant_${state.turnId}`,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      type: 'assistant-message',
      status: 'in_progress',
      text: '',
      createdAt: timestamp,
      completedAt: null,
    });

    this.emitItemCreated(store, state, assistantItem);
    this.emitItemDelta(
      store,
      state,
      assistantItem.id,
      'text-delta',
      'Reviewing workspace context. ',
      'assistant-message'
    );
    this.emitItemDelta(
      store,
      state,
      assistantItem.id,
      'text-delta',
      'Preparing a deterministic plan.',
      'assistant-message'
    );
    const completedAssistantItem = store.updateItem(assistantItem.id, {
      status: 'completed',
      text: 'Reviewing workspace context. Preparing a deterministic plan.',
      completedAt: timestamp,
    });
    this.emitItemCompleted(store, state, completedAssistantItem);
  }

  /**
   * Emits a reasoning item with indexed text deltas.
   */
  private emitReasoning(store: FsStore, state: SimulatedTurnState): void {
    const timestamp = new Date().toISOString();
    const reasoningItem = store.createItem({
      id: `it_reasoning_${state.turnId}`,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      type: 'reasoning',
      status: 'in_progress',
      summary: [],
      content: [],
      createdAt: timestamp,
      completedAt: null,
    });

    this.emitItemCreated(store, state, reasoningItem);
    this.emitItemDelta(
      store,
      state,
      reasoningItem.id,
      'indexed-text-delta',
      'Check simulator branch coverage.',
      'reasoning'
    );
    const completedReasoningItem = store.updateItem(reasoningItem.id, {
      status: 'completed',
      summary: ['Simulator path covered.'],
      content: ['Check simulator branch coverage.'],
      completedAt: timestamp,
    });
    this.emitItemCompleted(store, state, completedReasoningItem);
  }

  /**
   * Emits a command-execution item with output deltas.
   */
  private emitCommand(store: FsStore, state: SimulatedTurnState): void {
    const timestamp = new Date().toISOString();
    const commandItem = store.createItem({
      id: `it_command_${state.turnId}`,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      type: 'command-execution',
      status: 'in_progress',
      command: 'pnpm verify --simulated',
      cwd: process.cwd(),
      output: '',
      exitCode: null,
      durationMs: null,
      createdAt: timestamp,
      completedAt: null,
    });

    this.emitItemCreated(store, state, commandItem);
    this.emitItemDelta(
      store,
      state,
      commandItem.id,
      'output-delta',
      'simulator: ok',
      'command-execution'
    );
    store.updateItem(commandItem.id, { output: 'simulator: ok' });
    const completedCommandItem = store.updateItem(commandItem.id, {
      status: 'completed',
      exitCode: 0,
      durationMs: 12,
      completedAt: timestamp,
    });
    this.emitItemCompleted(store, state, completedCommandItem);
  }

  /**
   * Emits an approval request item and pauses the turn.
   */
  private emitApprovalRequest(store: FsStore, state: SimulatedTurnState): void {
    const timestamp = new Date().toISOString();
    const approval = store.createApproval({
      id: state.approvalId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      kind: 'permission',
      status: 'pending',
      title: 'Approve simulated workspace update',
      description: 'Allow the simulator to continue to the question and artifact steps.',
      createdAt: timestamp,
      resolvedAt: null,
    });
    const approvalItem = store.createItem({
      id: `it_approval_request_${state.turnId}`,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: approval.id,
      title: approval.title,
      description: approval.description,
      kind: approval.kind,
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const agentSession = store.updateAgentSession(state.agentSessionId, { status: 'suspended' });
    const turn = store.updateTurn(state.turnId, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: approval.id,
        itemId: approvalItem.id,
      },
    });

    this.emitItemCreated(store, state, approvalItem);
    this.emitItemCompleted(store, state, approvalItem);
    store.emitTurnEvent(state.turnId, {
      event: 'approval.requested',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'approval-requested', approval },
    });
    this.emitTurnUpdated(store, state, turn);
    this.emitAgentSessionUpdated(store, state, agentSession);
  }

  /**
   * Emits a synthetic artifact update and terminal turn events.
   */
  private emitArtifactAndComplete(store: FsStore, state: SimulatedTurnState, input: string): void {
    const timestamp = new Date().toISOString();
    const artifact = store.createArtifact({
      id: `ar_${state.turnId}`,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      kind: 'summary',
      title: 'Simulated protocol summary',
      status: 'draft',
      summary: 'Draft simulator artifact.',
      version: 1,
      content: {
        format: 'markdown',
        body: `Simulator answer: ${input}`,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const updatedArtifact = store.updateArtifact(state.workspaceId, artifact.id, {
      status: 'ready',
      summary: 'Deterministic simulator artifact ready.',
      version: 2,
      updatedAt: timestamp,
    });
    const artifactItem = store
      .listThreadItems(state.workspaceId, state.threadId)
      .find(
        (item) =>
          item.type === 'artifact-reference' &&
          item.artifactId === updatedArtifact.id &&
          item.artifactVersion === updatedArtifact.version
      );
    if (!artifactItem) {
      throw new Error(`Artifact reference was not persisted: ${updatedArtifact.id}`);
    }
    const completedAt = new Date().toISOString();
    const agentSession = store.updateAgentSession(state.agentSessionId, {
      status: 'idle',
      message: null,
      updatedAt: completedAt,
    });
    const turn = store.updateTurn(state.turnId, {
      status: 'completed',
      completedAt,
    });

    store.emitTurnEvent(state.turnId, {
      event: 'artifact.created',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'artifact-created', artifact },
    });
    store.emitTurnEvent(state.turnId, {
      event: 'artifact.updated',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'artifact-updated', artifact: updatedArtifact },
    });
    this.emitItemCreated(store, state, artifactItem);
    this.emitItemDelta(
      store,
      state,
      artifactItem.id,
      'artifact-updated',
      updatedArtifact.id,
      'artifact-reference'
    );
    this.emitItemCompleted(store, state, artifactItem);
    this.emitAgentSessionUpdated(store, state, agentSession);
    store.emitTurnEvent(state.turnId, {
      event: 'turn.completed',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'turn-completed', stopReason: 'completed', turn },
    });
  }

  /**
   * Marks a simulated turn failed.
   */
  private failTurn(store: FsStore, state: SimulatedTurnState, code: string, message: string): void {
    const completedAt = new Date().toISOString();
    const agentSession = store.updateAgentSession(state.agentSessionId, {
      status: 'failed',
      message,
      updatedAt: completedAt,
    });
    const turn = store.updateTurn(state.turnId, {
      status: 'failed',
      completedAt,
      error: { code, message },
    });

    this.emitAgentSessionUpdated(store, state, agentSession);
    store.emitTurnEvent(state.turnId, {
      event: 'turn.completed',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'turn-completed', stopReason: 'error', turn },
    });
  }

  /**
   * Emits one item creation event.
   */
  private emitItemCreated(
    store: FsStore,
    state: SimulatedTurnState,
    item: ReturnType<FsStore['createItem']>
  ): void {
    store.emitTurnEvent(state.turnId, {
      event: 'item.created',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'item-created', item },
    });
  }

  /**
   * Emits one item delta event.
   */
  private emitItemDelta(
    store: FsStore,
    state: SimulatedTurnState,
    itemId: string,
    deltaKind:
      | 'text-delta'
      | 'indexed-text-delta'
      | 'output-delta'
      | 'interaction-delta'
      | 'artifact-updated',
    delta: string,
    itemType: ItemType
  ): void {
    const base = {
      type: 'item-delta' as const,
      itemId,
      itemType,
    };
    const data = ItemDeltaEventSchema.parse(
      deltaKind === 'indexed-text-delta'
        ? { ...base, deltaKind, partId: 'default', delta }
        : deltaKind === 'artifact-updated'
          ? { ...base, deltaKind, artifactId: delta, summary: null }
          : { ...base, deltaKind, delta }
    );

    store.emitTurnEvent(state.turnId, {
      event: 'item.delta',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data,
    });
  }

  /**
   * Emits one item completion event.
   */
  private emitItemCompleted(store: FsStore, state: SimulatedTurnState, item: RuntimeItem): void {
    store.emitTurnEvent(state.turnId, {
      event: 'item.completed',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'item-completed', itemId: item.id, item },
    });
  }

  /**
   * Emits one turn update event.
   */
  private emitTurnUpdated(
    store: FsStore,
    state: SimulatedTurnState,
    turn: ReturnType<FsStore['updateTurn']>
  ): void {
    store.emitTurnEvent(state.turnId, {
      event: 'turn.updated',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'turn-updated', turn },
    });
  }

  /**
   * Emits one agent-session update event.
   */
  private emitAgentSessionUpdated(
    store: FsStore,
    state: SimulatedTurnState,
    agentSession: ReturnType<FsStore['updateAgentSession']>
  ): void {
    store.emitTurnEvent(state.turnId, {
      event: 'agent.session.updated',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'agent-session-updated', agentSession },
    });
  }
}
