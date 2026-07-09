import {
  type AgentEnvironmentPackage,
  redactAgentEnvironmentPackageSnapshot,
} from '@openkit/config-schema';
import type { StopReason } from '@openkit/protocol';
import type { FsStore } from '../lib/store.js';
import {
  type ResolveAgentEnvironmentBackendInput,
  resolveAgentEnvironmentPackage,
} from './agent-environment.js';
import { CodexAppServerClient } from './codex/client.js';
import { createCodexLaunchPayload } from './codex/materializer.js';
import type {
  AgentMessageDeltaNotification,
  ApplyPatchApprovalParams,
  CodexApprovalResponse,
  CodexThreadItem,
  CodexTurn,
  CommandExecutionOutputDeltaNotification,
  CommandExecutionRequestApprovalParams,
  ExecCommandApprovalParams,
  ItemCompletedNotification,
  ItemStartedNotification,
  JsonRpcRequest,
  ThreadStartResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnCompletedNotification,
  TurnStartedNotification,
  TurnStartResponse,
} from './codex/protocol.js';
import { StdioJsonRpcTransport } from './codex/transport.js';
import { OpenCodeCommandAgentSessionFactory } from './opencode/command-session.js';
import { OpenCodeServerAgentSessionFactory } from './opencode/server-session.js';
import { generateUuidV7 } from './session-id.js';
import { stopReasonForTurnStatus } from './stop-after-turn.js';
import type {
  AgentApprovalRequestedEvent,
  AgentRuntimeItemSnapshot,
  AgentSession,
  AgentSessionBackendSummary,
  AgentSessionEvent,
  AgentSessionFactory,
  AgentSessionReadModel,
  AgentSessionState,
  AgentUserInputQuestion,
  AgentUserInputRequestedEvent,
  ApprovalDecision,
  CreateAgentSessionInput,
  RuntimeCapabilities,
  RuntimeEventFamily,
  RuntimeItemDeltaKind,
  RuntimeItemType,
  TurnCommandRuntimeContext,
  TurnExecutor,
  TurnStartRuntimeContext,
} from './types.js';

type AgentAdapterType = CreateAgentSessionInput['agent']['config']['adapterType'];
type ProtocolItem = ReturnType<FsStore['createItem']>;

/**
 * Session factories used by the legacy Codex adapter.
 */
interface CodexHostAdapterSessionFactories
  extends Partial<Record<AgentAdapterType, AgentSessionFactory>> {
  /** Factory used when an OpenCode agent is configured for `opencode serve`. */
  opencodeServer?: AgentSessionFactory;
}

/**
 * Legacy Codex adapter construction options.
 */
interface CodexHostAdapterOptions {
  /** App-local backend target used when resolving Agent Environment Packages. */
  environmentBackend?: ResolveAgentEnvironmentBackendInput;
  /** Optional test or custom session factories. */
  sessionFactories?: CodexHostAdapterSessionFactories;
}

interface TurnExecutionState {
  turnId: string;
  agentSessionId: string;
  workspaceId: string;
  threadId: string;
  agentId: string;
  requestId: string | null;
  assistantItemId: string | null;
  assistantText: string;
  started: boolean;
  itemIdsByAgentItemId: Map<string, string>;
}

interface PendingCodexApproval {
  method: string;
  resolve: (response: CodexApprovalResponse) => void;
}

interface PendingCodexUserInput {
  resolve: (response: ToolRequestUserInputResponse) => void;
}

interface PendingUserInput {
  execution: TurnExecutionState;
  requestId: string;
  questionIds: string[];
  session: AgentSession;
}

/**
 * Real nanocore capability flags for the local Codex adapter.
 */
export const HOST_ADAPTER_CAPABILITIES: RuntimeCapabilities = {
  approvals: true,
  interrupts: true,
  artifacts: true,
  workspaceConfig: true,
  workspaceKnowledgeEditing: true,
  questions: true,
};

/**
 * SSE event families emitted by the local Codex adapter.
 */
export const HOST_ADAPTER_EVENT_FAMILIES: readonly RuntimeEventFamily[] = [
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
 * Protocol item types emitted by the local Codex adapter.
 */
export const HOST_ADAPTER_ITEM_TYPES: readonly RuntimeItemType[] = [
  'user-message',
  'assistant-message',
  'command-execution',
  'approval-request',
  'approval-decision',
  'user-input-request',
  'user-input-response',
];

/**
 * Protocol item delta kinds emitted by the local Codex adapter.
 */
export const HOST_ADAPTER_ITEM_DELTA_KINDS: readonly RuntimeItemDeltaKind[] = [
  'text-delta',
  'output-delta',
];

/**
 * Spawns one Codex app-server process and binds it to one nanocore thread.
 */
export class CodexAgentSession implements AgentSession {
  public readonly id: string;
  public readonly environmentPackage: CreateAgentSessionInput['environmentPackage'];
  public readonly threadId: string;

  private readonly client: CodexAppServerClient;
  private readonly codexThreadId: string;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private readonly localTurnByCodexTurnId = new Map<string, string>();
  private readonly pendingApprovals = new Map<string, PendingCodexApproval>();
  private readonly pendingUserInputs = new Map<string, PendingCodexUserInput>();
  private state: AgentSessionState = 'bound';
  private activeCodexTurnId: string | null = null;

  /**
   * Creates and initializes one Codex-backed agent session.
   */
  public static async create(input: CreateAgentSessionInput): Promise<CodexAgentSession> {
    const launchPayload = createCodexLaunchPayload(
      {
        ...input.agent.config,
        workspaceRoot: input.workspaceCwd ?? input.agent.config.workspaceRoot,
      },
      input.workspaceRoots
    );
    const transport = new StdioJsonRpcTransport({
      cwd: launchPayload.transport.cwd,
      environment: launchPayload.transport.environment,
      ...(launchPayload.transport.command ? { command: launchPayload.transport.command } : {}),
    });
    const client = new CodexAppServerClient({ transport });

    await client.initialize();

    const startedThread = await client.request<ThreadStartResponse>(
      'thread/start',
      launchPayload.threadStart
    );

    return new CodexAgentSession(
      input.id,
      input.threadId,
      client,
      startedThread.thread.id,
      input.environmentPackage
    );
  }

  /**
   * Subscribes to Codex notifications and stores the bound thread id.
   */
  public constructor(
    id: string,
    threadId: string,
    client: CodexAppServerClient,
    codexThreadId: string,
    environmentPackage: CreateAgentSessionInput['environmentPackage']
  ) {
    this.id = id;
    this.environmentPackage = environmentPackage;
    this.threadId = threadId;
    this.client = client;
    this.codexThreadId = codexThreadId;
    this.client.onNotification((message) => {
      this.handleNotification(message.method, message.params as Record<string, unknown>);
    });
    this.client.onRequest((message) => this.handleRequest(message));
  }

  /**
   * Registers a session event listener.
   */
  public onEvent(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Starts one turn on the bound Codex thread.
   */
  public async startTurn(turnId: string, input: string): Promise<void> {
    this.state = 'running';
    const response = await this.client.request<TurnStartResponse>('turn/start', {
      threadId: this.codexThreadId,
      input: [
        {
          type: 'text',
          text: input,
          text_elements: [],
        },
      ],
    });

    this.localTurnByCodexTurnId.set(response.turn.id, turnId);
    this.activeCodexTurnId = response.turn.id;
  }

  /**
   * Interrupts the currently active Codex turn.
   */
  public async interruptTurn(turnId: string): Promise<void> {
    if (!this.activeCodexTurnId) {
      return;
    }

    await this.client.request('turn/interrupt', {
      threadId: this.codexThreadId,
      turnId: this.activeCodexTurnId,
    });

    this.localTurnByCodexTurnId.set(this.activeCodexTurnId, turnId);
  }

  /**
   * Resolves one pending Codex approval request.
   */
  public async respondApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(approvalId);

    if (!pending) {
      throw new Error(`Codex approval request not found: ${approvalId}`);
    }

    pending.resolve(toCodexApprovalResponse(pending.method, decision));
    this.pendingApprovals.delete(approvalId);
    this.state = 'running';
  }

  /**
   * Resolves one pending Codex user-input request.
   */
  public async respondUserInput(
    requestId: string,
    answers: Record<string, string[]>
  ): Promise<void> {
    const pending = this.pendingUserInputs.get(requestId);

    if (!pending) {
      throw new Error(`Codex user-input request not found: ${requestId}`);
    }

    pending.resolve({
      answers: Object.fromEntries(
        Object.entries(answers).map(([questionId, answerValues]) => [
          questionId,
          { answers: answerValues },
        ])
      ),
    });
    this.pendingUserInputs.delete(requestId);
    this.state = 'running';
  }

  /**
   * Closes the app-server transport.
   */
  public async close(): Promise<void> {
    this.state = 'exited';
    await this.client.close();
  }

  /**
   * Returns the current agent-session state.
   */
  public getState(): AgentSessionState {
    return this.state;
  }

  /**
   * Emits one normalized event to all listeners.
   */
  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /**
   * Maps a provider turn id back to the local nanocore turn id.
   */
  private getLocalTurnId(codexTurn: CodexTurn): string | null {
    return this.localTurnByCodexTurnId.get(codexTurn.id) ?? null;
  }

  /**
   * Handles the small notification subset used by nanocore.
   */
  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'turn/started') {
      const notification = params as unknown as TurnStartedNotification;
      const localTurnId = this.getLocalTurnId(notification.turn);

      if (!localTurnId) {
        return;
      }

      this.state = 'running';
      this.emit({
        type: 'turn-started',
        turnId: localTurnId,
        startedAt: new Date(
          (notification.turn.startedAt ?? Date.now() / 1000) * 1000
        ).toISOString(),
      });
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const notification = params as unknown as AgentMessageDeltaNotification;
      const localTurnId =
        this.localTurnByCodexTurnId.get(notification.turnId) ??
        this.localTurnByCodexTurnId.get(this.activeCodexTurnId ?? '');

      if (!localTurnId) {
        return;
      }

      this.emit({
        type: 'agent-message-delta',
        turnId: localTurnId,
        itemId: notification.itemId,
        delta: notification.delta,
      });
      return;
    }

    if (method === 'item/commandExecution/outputDelta') {
      const notification = params as unknown as CommandExecutionOutputDeltaNotification;
      const localTurnId =
        this.localTurnByCodexTurnId.get(notification.turnId) ??
        this.localTurnByCodexTurnId.get(this.activeCodexTurnId ?? '');

      if (!localTurnId) {
        return;
      }

      this.emit({
        type: 'command-output-delta',
        turnId: localTurnId,
        itemId: notification.itemId,
        delta: notification.delta,
      });
      return;
    }

    if (method === 'item/started' || method === 'item/completed') {
      const notification = params as unknown as ItemStartedNotification | ItemCompletedNotification;
      const localTurnId =
        this.localTurnByCodexTurnId.get(notification.turnId) ??
        this.localTurnByCodexTurnId.get(this.activeCodexTurnId ?? '');
      const item = mapCodexThreadItem(notification.item);

      if (!localTurnId || !item) {
        return;
      }

      this.emit({
        type: method === 'item/started' ? 'agent-item-started' : 'agent-item-completed',
        turnId: localTurnId,
        item,
      });
      return;
    }

    if (method === 'turn/completed') {
      const notification = params as unknown as TurnCompletedNotification;
      const localTurnId = this.getLocalTurnId(notification.turn);

      if (!localTurnId) {
        return;
      }

      this.state = 'bound';
      const status = mapTurnStatus(notification.turn.status);
      const completedEvent: AgentSessionEvent = {
        type: 'turn-completed',
        turnId: localTurnId,
        status,
        stopReason: stopReasonForTurnStatus(status),
        completedAt: new Date(
          (notification.turn.completedAt ?? Date.now() / 1000) * 1000
        ).toISOString(),
        ...(notification.turn.error ? { error: notification.turn.error } : {}),
      };

      this.emit(completedEvent);
    }
  }

  /**
   * Handles one inbound Codex server request.
   */
  private handleRequest(
    message: JsonRpcRequest
  ): Promise<CodexApprovalResponse | ToolRequestUserInputResponse> {
    const userInput = this.mapUserInputRequest(message.method, message.params);

    if (userInput) {
      return new Promise<ToolRequestUserInputResponse>((resolve) => {
        this.pendingUserInputs.set(userInput.requestId, { resolve });
        this.state = 'awaiting_input';
        this.emit(userInput);
      });
    }

    const approval = this.mapApprovalRequest(message.method, message.params);

    if (!approval) {
      throw new Error(`Unsupported Codex server request: ${message.method}`);
    }

    return new Promise<CodexApprovalResponse>((resolve) => {
      this.pendingApprovals.set(approval.approvalId, { method: message.method, resolve });
      this.emit(approval);
    });
  }

  /**
   * Maps a Codex approval request into a normalized agent approval event.
   */
  private mapApprovalRequest(method: string, params: unknown): AgentApprovalRequestedEvent | null {
    if (method === 'execCommandApproval') {
      const request = params as ExecCommandApprovalParams;
      const turnId = this.localTurnByCodexTurnId.get(this.activeCodexTurnId ?? '');

      if (!turnId) {
        return null;
      }

      const command = request.command.join(' ');
      return {
        type: 'approval-requested',
        turnId,
        approvalId: request.approvalId ?? request.callId,
        kind: 'permission',
        title: 'Approve command',
        description: request.reason ?? `Run \`${command}\` in ${request.cwd}.`,
      };
    }

    if (method === 'applyPatchApproval') {
      const request = params as ApplyPatchApprovalParams;
      const turnId = this.localTurnByCodexTurnId.get(this.activeCodexTurnId ?? '');

      if (!turnId) {
        return null;
      }

      return {
        type: 'approval-requested',
        turnId,
        approvalId: request.callId,
        kind: 'destructive-action',
        title: 'Approve patch',
        description:
          request.reason ??
          `Apply patch with ${Object.keys(request.fileChanges).length} file changes.`,
      };
    }

    if (method === 'item/commandExecution/requestApproval') {
      const request = params as CommandExecutionRequestApprovalParams;
      const turnId =
        this.localTurnByCodexTurnId.get(request.turnId) ??
        this.localTurnByCodexTurnId.get(this.activeCodexTurnId ?? '');

      if (!turnId) {
        return null;
      }

      return {
        type: 'approval-requested',
        turnId,
        approvalId: request.approvalId ?? request.itemId,
        kind: 'permission',
        title: 'Approve command',
        description: request.reason ?? `Run \`${request.command ?? request.itemId}\`.`,
      };
    }

    return null;
  }

  /**
   * Maps a Codex user-input request into a normalized agent question event.
   */
  private mapUserInputRequest(
    method: string,
    params: unknown
  ): AgentUserInputRequestedEvent | null {
    if (method !== 'item/tool/requestUserInput') {
      return null;
    }

    const request = params as ToolRequestUserInputParams;
    const turnId =
      this.localTurnByCodexTurnId.get(request.turnId) ??
      this.localTurnByCodexTurnId.get(this.activeCodexTurnId ?? '');

    if (!turnId || request.questions.length === 0) {
      return null;
    }

    const questions: AgentUserInputQuestion[] = request.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: question.options ?? null,
      isOther: question.isOther ?? false,
      isSecret: question.isSecret ?? false,
    }));

    return {
      type: 'user-input-requested',
      turnId,
      requestId: request.itemId,
      prompt: questions[0]?.question ?? 'Agent input requested.',
      questions,
    };
  }
}

/**
 * Creates bound Codex agent sessions on demand.
 */
export class CodexAgentSessionFactory implements AgentSessionFactory {
  /**
   * Starts one Codex-backed agent session.
   */
  public async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    return CodexAgentSession.create(input);
  }
}

/**
 * Local Codex adapter that keeps one Codex session bound to one nanocore thread.
 */
export class CodexHostAdapter implements TurnExecutor {
  public readonly capabilities = HOST_ADAPTER_CAPABILITIES;
  public readonly eventFamilies = HOST_ADAPTER_EVENT_FAMILIES;
  public readonly itemTypes = HOST_ADAPTER_ITEM_TYPES;
  public readonly itemDeltaKinds = HOST_ADAPTER_ITEM_DELTA_KINDS;

  private readonly sessionFactories: Record<AgentAdapterType, AgentSessionFactory>;
  private readonly opencodeServerSessionFactory: AgentSessionFactory;
  private readonly environmentBackend: ResolveAgentEnvironmentBackendInput | undefined;
  private readonly sessionsByThreadId = new Map<string, AgentSession>();
  private readonly sessionWorkspaceCwdByThreadId = new Map<string, string>();
  private readonly executionsByTurnId = new Map<string, TurnExecutionState>();
  private readonly approvalsById = new Map<
    string,
    { execution: TurnExecutionState; session: AgentSession }
  >();
  private readonly userInputsByTurnId = new Map<string, PendingUserInput>();

  /**
   * Builds the local Codex adapter with an optional custom session factory.
   */
  public constructor(options: CodexHostAdapterOptions = {}) {
    this.environmentBackend = options.environmentBackend;
    this.sessionFactories = {
      codex: options.sessionFactories?.codex ?? new CodexAgentSessionFactory(),
      opencode: options.sessionFactories?.opencode ?? new OpenCodeCommandAgentSessionFactory(),
    };
    this.opencodeServerSessionFactory =
      options.sessionFactories?.opencodeServer ?? new OpenCodeServerAgentSessionFactory();
  }

  /**
   * Starts one turn by routing it through the thread-bound agent session.
   */
  public async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
  ): Promise<void> {
    const turn = store.getTurnById(turnId);
    const agent = store.getAgentForThread(turn.workspaceId, turn.threadId);
    const requestId = context.requestId ?? null;
    const session = await this.ensureSession(
      store,
      turn,
      agent.id,
      input,
      context.workspaceRoots,
      context.workspaceCwd ?? null,
      requestId,
      context.workspaceDataSourceCatalog,
      context.workspaceSourceRefs,
      context.backendRequirements
    );
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const existingAgentSession = store
      .listThreadAgentSessions(turn.workspaceId, turn.threadId)
      .find((storedSession) => storedSession.id === session.id);
    const agentSession = existingAgentSession
      ? store.updateAgentSession(existingAgentSession.id, {
          status: 'created',
          message: null,
          updatedAt: timestamp,
        })
      : store.createAgentSession({
          id: session.id,
          agentId: agent.id,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          status: 'created',
          message: null,
          configVersion: turn.configVersion,
          environmentPackageSnapshot: redactAgentEnvironmentPackageSnapshot(
            session.environmentPackage
          ),
          workspaceRoots: context.workspaceRoots,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
    const userItem = store.createItem({
      id: `it_user_${turnId}`,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      type: 'user-message',
      status: 'completed',
      text: input,
      createdAt: timestamp,
      completedAt: timestamp,
    });

    this.executionsByTurnId.set(turnId, {
      turnId,
      agentSessionId: agentSession.id,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      agentId: agent.id,
      requestId,
      assistantItemId: null,
      assistantText: '',
      started: false,
      itemIdsByAgentItemId: new Map<string, string>(),
    });

    store.emitTurnEvent(turnId, {
      event: 'turn.started',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'turn-started', turnId, status: 'running' },
    });
    store.emitTurnEvent(turnId, {
      event: 'item.created',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'item-created', item: userItem },
    });
    store.emitTurnEvent(turnId, {
      event: 'item.completed',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'item-completed', itemId: userItem.id, item: userItem },
    });
    store.emitTurnEvent(turnId, {
      event: 'agent.session.updated',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'agent-session-updated', agentSession },
    });

    try {
      await session.startTurn(turnId, input);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'The agent turn failed before it started.';
      const execution = this.executionsByTurnId.get(turnId) ?? {
        turnId,
        agentSessionId: agentSession.id,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        agentId: agent.id,
        requestId,
        assistantItemId: null,
        assistantText: '',
        started: false,
        itemIdsByAgentItemId: new Map<string, string>(),
      };

      this.completeTurn(store, execution, {
        status: 'failed',
        stopReason: 'error',
        completedAt: new Date().toISOString(),
        error: {
          code: 'agent_turn_start_failed',
          message,
        },
      });
      throw error;
    }
  }

  /**
   * Interrupts one active turn through its bound session.
   */
  public async interruptTurn(
    store: FsStore,
    turnId: string,
    context: TurnCommandRuntimeContext = { requestId: null }
  ): Promise<void> {
    const execution = this.executionsByTurnId.get(turnId);

    if (!execution) {
      return;
    }

    execution.requestId = context.requestId;

    const session = this.sessionsByThreadId.get(execution.threadId);

    if (!session) {
      return;
    }

    await session.interruptTurn(turnId);
    if (store.getTurnById(turnId).status !== 'interrupted') {
      this.completeTurn(store, execution, {
        status: 'interrupted',
        stopReason: 'aborted',
        completedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Sends one approval decision to the agent session and resumes the local turn.
   */
  public async respondApproval(
    store: FsStore,
    approvalRequestId: string,
    decision: ApprovalDecision,
    context: TurnCommandRuntimeContext = { requestId: null }
  ) {
    const pending = this.approvalsById.get(approvalRequestId);

    if (!pending?.session.respondApproval) {
      throw new Error(`Approval request is not active: ${approvalRequestId}`);
    }

    pending.execution.requestId = context.requestId;
    await pending.session.respondApproval(approvalRequestId, decision);

    const approval = store.updateApproval(approvalRequestId, {
      status: decision,
      resolvedAt: new Date().toISOString(),
    });
    const decisionItem = store.createItem({
      id: `it_approval_decision_${approvalRequestId}`,
      workspaceId: pending.execution.workspaceId,
      threadId: pending.execution.threadId,
      turnId: pending.execution.turnId,
      type: 'approval-decision',
      status: 'completed',
      approvalRequestId,
      decision,
      createdAt: approval.resolvedAt ?? new Date().toISOString(),
      completedAt: approval.resolvedAt ?? new Date().toISOString(),
    });
    const turn = store.updateTurn(pending.execution.turnId, { status: 'running', humanGate: null });
    const agentSession = store.updateAgentSession(pending.execution.agentSessionId, {
      status: 'busy',
    });

    this.emitItemCreated(store, pending.execution, decisionItem);
    this.emitItemCompleted(store, pending.execution, decisionItem);
    store.emitTurnEvent(pending.execution.turnId, {
      event: 'approval.resolved',
      requestId: pending.execution.requestId,
      workspaceId: approval.workspaceId,
      threadId: approval.threadId,
      turnId: approval.turnId,
      data: { type: 'approval-resolved', approval },
    });
    store.emitTurnEvent(pending.execution.turnId, {
      event: 'turn.updated',
      requestId: pending.execution.requestId,
      workspaceId: pending.execution.workspaceId,
      threadId: pending.execution.threadId,
      turnId: pending.execution.turnId,
      data: { type: 'turn-updated', turn },
    });
    store.emitTurnEvent(pending.execution.turnId, {
      event: 'agent.session.updated',
      requestId: pending.execution.requestId,
      workspaceId: pending.execution.workspaceId,
      threadId: pending.execution.threadId,
      turnId: pending.execution.turnId,
      data: { type: 'agent-session-updated', agentSession },
    });
    this.approvalsById.delete(approvalRequestId);
    return approval;
  }

  /**
   * Sends one user-input answer to the agent session and resumes the local turn.
   */
  public async respondUserInput(
    store: FsStore,
    turnId: string,
    input: string,
    context: TurnCommandRuntimeContext = { requestId: null }
  ) {
    const pending = this.userInputsByTurnId.get(turnId);

    if (!pending?.session.respondUserInput) {
      throw new Error(`User-input request is not active for turn: ${turnId}`);
    }

    const answers = Object.fromEntries(
      pending.questionIds.map((questionId) => [questionId, [input]])
    );

    pending.execution.requestId = context.requestId;
    await pending.session.respondUserInput(pending.requestId, answers);

    const timestamp = new Date().toISOString();
    const responseItem = store.createItem({
      id: `it_user_input_response_${pending.requestId}`,
      workspaceId: pending.execution.workspaceId,
      threadId: pending.execution.threadId,
      turnId: pending.execution.turnId,
      type: 'user-input-response',
      status: 'completed',
      userInputRequestId: pending.requestId,
      answers,
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const turn = store.updateTurn(pending.execution.turnId, { status: 'running', humanGate: null });
    const agentSession = store.updateAgentSession(pending.execution.agentSessionId, {
      status: 'busy',
    });

    this.emitItemCreated(store, pending.execution, responseItem);
    this.emitItemCompleted(store, pending.execution, responseItem);
    store.emitTurnEvent(pending.execution.turnId, {
      event: 'turn.updated',
      requestId: pending.execution.requestId,
      workspaceId: pending.execution.workspaceId,
      threadId: pending.execution.threadId,
      turnId: pending.execution.turnId,
      data: { type: 'turn-updated', turn },
    });
    store.emitTurnEvent(pending.execution.turnId, {
      event: 'agent.session.updated',
      requestId: pending.execution.requestId,
      workspaceId: pending.execution.workspaceId,
      threadId: pending.execution.threadId,
      turnId: pending.execution.turnId,
      data: { type: 'agent-session-updated', agentSession },
    });
    this.userInputsByTurnId.delete(turnId);
    return turn;
  }

  /**
   * Returns the product-visible agent session bound to one thread.
   */
  public getAgentSession(
    _store: FsStore,
    _workspaceId: string,
    threadId: string
  ): AgentSessionReadModel | null {
    const session = this.sessionsByThreadId.get(threadId);

    if (!session) {
      return null;
    }

    return toAgentSessionReadModel(session);
  }

  /**
   * Returns active agent sessions after refreshing health timestamps for the workspace.
   */
  public refreshAgentSessions(store: FsStore, workspaceId: string): AgentSessionReadModel[] {
    const sessions: AgentSessionReadModel[] = [];

    for (const [threadId, session] of this.sessionsByThreadId.entries()) {
      try {
        store.getThread(workspaceId, threadId);
        sessions.push(toAgentSessionReadModel(session));
      } catch {}
    }

    return sessions;
  }

  /**
   * Return sanitized lifecycle diagnostics for active agent sessions.
   *
   * @returns Active agent session diagnostics.
   */
  public getSessionDiagnostics(): Array<{
    threadId: string;
    sessionId: string;
    state: AgentSessionState;
  }> {
    return [...this.sessionsByThreadId.entries()].map(([threadId, session]) => ({
      threadId,
      sessionId: session.id,
      state: session.getState(),
    }));
  }

  /**
   * Close and forget idle or bound agent sessions.
   *
   * @returns Number of sessions reclaimed.
   */
  public async reclaimIdleSessions(): Promise<number> {
    let reclaimed = 0;

    for (const [threadId, session] of this.sessionsByThreadId.entries()) {
      if (session.getState() !== 'idle' && session.getState() !== 'bound') {
        continue;
      }

      await session.close();
      this.sessionsByThreadId.delete(threadId);
      this.sessionWorkspaceCwdByThreadId.delete(threadId);
      reclaimed += 1;
    }

    return reclaimed;
  }

  /**
   * Creates or reuses one bound session for the requested thread.
   */
  private async ensureSession(
    store: FsStore,
    turn: ReturnType<FsStore['getTurnById']>,
    agentId: string,
    turnInput: string,
    workspaceRoots: TurnStartRuntimeContext['workspaceRoots'],
    workspaceCwd: string | null,
    requestId: string | null,
    workspaceDataSourceCatalog: TurnStartRuntimeContext['workspaceDataSourceCatalog'],
    workspaceSourceRefs: TurnStartRuntimeContext['workspaceSourceRefs'],
    backendRequirements: TurnStartRuntimeContext['backendRequirements']
  ): Promise<AgentSession> {
    const { workspaceId, threadId } = turn;
    const agent = store.getAgent(workspaceId, agentId);
    const sessionFactory = this.selectSessionFactory(agent);
    const agentSessionId = generateUuidV7();
    const environmentPackage = resolveAgentEnvironmentPackage({
      agent,
      agentSessionId,
      ...(this.environmentBackend ? { backend: this.environmentBackend } : {}),
      ...(backendRequirements ? { backendRequirements } : {}),
      requestId,
      turn,
      turnInput,
      ...(workspaceDataSourceCatalog ? { workspaceDataSourceCatalog } : {}),
      workspaceCwd,
      workspaceRoots,
      ...(workspaceSourceRefs ? { workspaceSourceRefs } : {}),
    });
    const existing = this.sessionsByThreadId.get(threadId);

    if (existing && !['failed', 'exited', 'stopping'].includes(existing.getState())) {
      const existingWorkspaceCwd = this.sessionWorkspaceCwdByThreadId.get(threadId) ?? null;
      const existingWorkspaceKey = sessionWorkspaceCompatibilityKey(existing.environmentPackage);
      const candidateWorkspaceKey = sessionWorkspaceCompatibilityKey(environmentPackage);

      if (
        (!workspaceCwd || existingWorkspaceCwd === workspaceCwd) &&
        existingWorkspaceKey !== null &&
        existingWorkspaceKey === candidateWorkspaceKey
      ) {
        return existing;
      }

      await existing.close();
      this.sessionsByThreadId.delete(threadId);
      this.sessionWorkspaceCwdByThreadId.delete(threadId);
    }
    const session = await sessionFactory.createSession({
      id: agentSessionId,
      environmentPackage,
      workspaceId,
      threadId,
      agent,
      workspaceRoots,
      workspaceCwd,
    });

    session.onEvent((event) => {
      this.handleSessionEvent(store, session, event);
    });
    this.sessionsByThreadId.set(threadId, session);
    if (workspaceCwd) {
      this.sessionWorkspaceCwdByThreadId.set(threadId, workspaceCwd);
    }
    return session;
  }

  /**
   * Selects the internal agent-session factory for one product-visible agent.
   */
  private selectSessionFactory(agent: CreateAgentSessionInput['agent']): AgentSessionFactory {
    if (isOpenCodeServeAgent(agent)) {
      return this.opencodeServerSessionFactory;
    }

    return this.sessionFactories[agent.config.adapterType];
  }

  /**
   * Handles one normalized agent-session event.
   */
  private handleSessionEvent(
    store: FsStore,
    session: AgentSession,
    event: AgentSessionEvent
  ): void {
    if (event.type === 'session-state-changed') {
      if (event.state === 'failed' || event.state === 'exited') {
        this.sessionsByThreadId.delete(session.threadId);
        this.sessionWorkspaceCwdByThreadId.delete(session.threadId);

        for (const execution of this.executionsByTurnId.values()) {
          if (execution.threadId === session.threadId) {
            store.updateAgentHealth(execution.workspaceId, execution.agentId, {
              status: event.state === 'failed' ? 'failed' : 'offline',
              message: event.reason ?? 'The agent session exited unexpectedly.',
              checkedAt: new Date().toISOString(),
            });
            this.completeTurn(store, execution, {
              status: 'failed',
              stopReason: 'error',
              completedAt: new Date().toISOString(),
              error: {
                code: 'agent_session_failed',
                message: event.reason ?? 'The agent session exited unexpectedly.',
              },
            });
          }
        }
      }

      return;
    }

    const execution = this.executionsByTurnId.get(event.turnId);

    if (!execution) {
      return;
    }

    if (event.type === 'turn-started') {
      execution.started = true;
      const agentSession = store.updateAgentSession(execution.agentSessionId, {
        status: 'busy',
        message: null,
        updatedAt: event.startedAt,
      });
      store.emitTurnEvent(event.turnId, {
        event: 'agent.session.updated',
        requestId: execution.requestId,
        workspaceId: execution.workspaceId,
        threadId: execution.threadId,
        turnId: event.turnId,
        data: { type: 'agent-session-updated', agentSession },
      });
      return;
    }

    if (event.type === 'agent-message-delta') {
      const assistantItem = this.ensureAssistantItem(store, execution, event.itemId);

      execution.assistantText += event.delta;
      store.updateItem(assistantItem.id, {
        text: execution.assistantText,
      });
      store.emitTurnEvent(event.turnId, {
        event: 'item.delta',
        requestId: execution.requestId,
        workspaceId: execution.workspaceId,
        threadId: execution.threadId,
        turnId: event.turnId,
        data: {
          type: 'item-delta',
          itemId: assistantItem.id,
          itemType: 'assistant-message',
          deltaKind: 'text-delta',
          delta: event.delta,
        },
      });
      return;
    }

    if (event.type === 'command-output-delta') {
      const commandItemId = execution.itemIdsByAgentItemId.get(event.itemId);

      if (!commandItemId) {
        return;
      }

      const commandItem = store
        .listThreadItems(execution.workspaceId, execution.threadId)
        .find((item) => item.id === commandItemId);

      if (!commandItem || commandItem.type !== 'command-execution') {
        return;
      }

      store.updateItem(commandItem.id, {
        output: commandItem.output + event.delta,
      });
      store.emitTurnEvent(event.turnId, {
        event: 'item.delta',
        requestId: execution.requestId,
        workspaceId: execution.workspaceId,
        threadId: execution.threadId,
        turnId: event.turnId,
        data: {
          type: 'item-delta',
          itemId: commandItem.id,
          deltaKind: 'output-delta',
          itemType: 'command-execution',
          delta: event.delta,
        },
      });
      return;
    }

    if (event.type === 'approval-requested') {
      const timestamp = new Date().toISOString();
      const session = this.sessionsByThreadId.get(execution.threadId);

      if (!session) {
        return;
      }

      const approval = store.createApproval({
        id: event.approvalId,
        workspaceId: execution.workspaceId,
        threadId: execution.threadId,
        turnId: execution.turnId,
        kind: event.kind,
        status: 'pending',
        title: event.title,
        description: event.description,
        createdAt: timestamp,
        resolvedAt: null,
      });
      const agentSession = store.updateAgentSession(execution.agentSessionId, {
        status: 'suspended',
      });
      const approvalItem = store.createItem({
        id: `it_approval_request_${approval.id}`,
        workspaceId: execution.workspaceId,
        threadId: execution.threadId,
        turnId: execution.turnId,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: approval.id,
        title: approval.title,
        description: approval.description,
        kind: approval.kind,
        createdAt: timestamp,
        completedAt: timestamp,
      });
      const turn = store.updateTurn(execution.turnId, {
        status: 'awaiting_human',
        humanGate: {
          kind: 'approval',
          approvalRequestId: approval.id,
          itemId: approvalItem.id,
        },
      });

      this.approvalsById.set(approval.id, { execution, session });
      this.emitItemCreated(store, execution, approvalItem);
      this.emitItemCompleted(store, execution, approvalItem);
      store.emitTurnEvent(execution.turnId, {
        event: 'approval.requested',
        requestId: execution.requestId,
        workspaceId: execution.workspaceId,
        threadId: execution.threadId,
        turnId: execution.turnId,
        data: { type: 'approval-requested', approval },
      });
      store.emitTurnEvent(execution.turnId, {
        event: 'turn.updated',
        requestId: execution.requestId,
        workspaceId: execution.workspaceId,
        threadId: execution.threadId,
        turnId: execution.turnId,
        data: { type: 'turn-updated', turn },
      });
      store.emitTurnEvent(execution.turnId, {
        event: 'agent.session.updated',
        requestId: execution.requestId,
        workspaceId: execution.workspaceId,
        threadId: execution.threadId,
        turnId: execution.turnId,
        data: { type: 'agent-session-updated', agentSession },
      });
      return;
    }

    if (event.type === 'user-input-requested') {
      const timestamp = new Date().toISOString();
      const session = this.sessionsByThreadId.get(execution.threadId);

      if (!session) {
        return;
      }

      const agentSession = store.updateAgentSession(execution.agentSessionId, {
        status: 'suspended',
      });
      const requestItem = store.createItem({
        id: `it_user_input_request_${event.requestId}`,
        workspaceId: execution.workspaceId,
        threadId: execution.threadId,
        turnId: execution.turnId,
        type: 'user-input-request',
        status: 'completed',
        userInputRequestId: event.requestId,
        prompt: event.prompt,
        questions: event.questions,
        createdAt: timestamp,
        completedAt: timestamp,
      });
      const turn = store.updateTurn(execution.turnId, {
        status: 'awaiting_human',
        humanGate: {
          kind: 'user-input',
          userInputRequestId: event.requestId,
          itemId: requestItem.id,
        },
      });

      this.userInputsByTurnId.set(execution.turnId, {
        execution,
        requestId: event.requestId,
        questionIds: event.questions.map((question) => question.id),
        session,
      });
      this.emitItemCreated(store, execution, requestItem);
      this.emitItemCompleted(store, execution, requestItem);
      store.emitTurnEvent(execution.turnId, {
        event: 'turn.updated',
        requestId: execution.requestId,
        workspaceId: execution.workspaceId,
        threadId: execution.threadId,
        turnId: execution.turnId,
        data: { type: 'turn-updated', turn },
      });
      store.emitTurnEvent(execution.turnId, {
        event: 'agent.session.updated',
        requestId: execution.requestId,
        workspaceId: execution.workspaceId,
        threadId: execution.threadId,
        turnId: execution.turnId,
        data: { type: 'agent-session-updated', agentSession },
      });
      return;
    }

    if (event.type === 'agent-item-started' || event.type === 'agent-item-completed') {
      this.upsertRuntimeItem(store, execution, event.item, event.type === 'agent-item-completed');
      return;
    }

    if (event.type === 'turn-completed') {
      this.completeTurn(store, execution, event);
    }
  }

  /**
   * Creates the assistant item lazily on first streamed delta.
   */
  private ensureAssistantItem(store: FsStore, execution: TurnExecutionState, agentItemId?: string) {
    if (execution.assistantItemId) {
      return store.updateItem(execution.assistantItemId, {});
    }

    const turn = store.getTurnById(execution.turnId);
    const assistantItem = store.createItem({
      id: `it_assistant_${execution.turnId}`,
      workspaceId: execution.workspaceId,
      threadId: execution.threadId,
      turnId: execution.turnId,
      type: 'assistant-message',
      status: 'in_progress',
      text: execution.assistantText,
      createdAt: turn.startedAt ?? new Date().toISOString(),
      completedAt: null,
    });

    execution.assistantItemId = assistantItem.id;
    if (agentItemId) {
      execution.itemIdsByAgentItemId.set(agentItemId, assistantItem.id);
    }
    store.emitTurnEvent(execution.turnId, {
      event: 'item.created',
      requestId: execution.requestId,
      workspaceId: execution.workspaceId,
      threadId: execution.threadId,
      turnId: execution.turnId,
      data: { type: 'item-created', item: assistantItem },
    });

    return assistantItem;
  }

  /**
   * Creates or updates one protocol item from a normalized runtime item snapshot.
   */
  private upsertRuntimeItem(
    store: FsStore,
    execution: TurnExecutionState,
    item: AgentRuntimeItemSnapshot,
    completed: boolean
  ): void {
    const existingItemId = execution.itemIdsByAgentItemId.get(item.itemId);
    const localItemId = existingItemId ?? `it_agent_${execution.turnId}_${item.itemId}`;
    const timestamp = new Date().toISOString();

    if (item.kind === 'agent-message') {
      if (existingItemId) {
        const updatedItem = store.updateItem(existingItemId, {
          text: item.text,
          status: completed ? 'completed' : 'in_progress',
          completedAt: completed ? timestamp : null,
        });
        execution.assistantItemId = updatedItem.id;
        execution.assistantText = item.text;
        if (completed) {
          this.emitItemCompleted(store, execution, updatedItem);
        }
        return;
      }

      const assistantItem = store.createItem({
        id: localItemId,
        workspaceId: execution.workspaceId,
        threadId: execution.threadId,
        turnId: execution.turnId,
        type: 'assistant-message',
        status: completed ? 'completed' : 'in_progress',
        text: item.text,
        createdAt: timestamp,
        completedAt: completed ? timestamp : null,
      });
      execution.assistantItemId = assistantItem.id;
      execution.assistantText = item.text;
      execution.itemIdsByAgentItemId.set(item.itemId, assistantItem.id);
      this.emitItemCreated(store, execution, assistantItem);
      if (completed) {
        this.emitItemCompleted(store, execution, assistantItem);
      }
      return;
    }

    const status = completed
      ? item.exitCode === 0 || item.exitCode === null
        ? 'completed'
        : 'failed'
      : 'in_progress';

    if (existingItemId) {
      const updatedItem = store.updateItem(existingItemId, {
        status,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
        completedAt: completed ? timestamp : null,
      });
      if (completed) {
        this.emitItemCompleted(store, execution, updatedItem);
      }
      return;
    }

    const commandItem = store.createItem({
      id: localItemId,
      workspaceId: execution.workspaceId,
      threadId: execution.threadId,
      turnId: execution.turnId,
      type: 'command-execution',
      status,
      command: item.command,
      cwd: item.cwd,
      exitCode: item.exitCode,
      durationMs: item.durationMs,
      output: '',
      createdAt: timestamp,
      completedAt: completed ? timestamp : null,
    });
    execution.itemIdsByAgentItemId.set(item.itemId, commandItem.id);
    this.emitItemCreated(store, execution, commandItem);
    if (completed) {
      this.emitItemCompleted(store, execution, commandItem);
    }
  }

  /**
   * Emits a protocol item-created event.
   */
  private emitItemCreated(
    store: FsStore,
    execution: TurnExecutionState,
    item: ReturnType<FsStore['createItem']>
  ): void {
    store.emitTurnEvent(execution.turnId, {
      event: 'item.created',
      requestId: execution.requestId,
      workspaceId: execution.workspaceId,
      threadId: execution.threadId,
      turnId: execution.turnId,
      data: { type: 'item-created', item },
    });
  }

  /**
   * Emits a protocol item-completed event.
   */
  private emitItemCompleted(
    store: FsStore,
    execution: TurnExecutionState,
    item: ProtocolItem
  ): void {
    store.emitTurnEvent(execution.turnId, {
      event: 'item.completed',
      requestId: execution.requestId,
      workspaceId: execution.workspaceId,
      threadId: execution.threadId,
      turnId: execution.turnId,
      data: { type: 'item-completed', itemId: item.id, item },
    });
  }

  /**
   * Finalizes one turn and emits the terminal protocol events.
   */
  private completeTurn(
    store: FsStore,
    execution: TurnExecutionState,
    event: {
      status: 'completed' | 'interrupted' | 'failed';
      stopReason: StopReason;
      completedAt: string;
      error?: {
        code: string | null;
        message: string;
      };
    }
  ): void {
    const assistantItem = this.ensureAssistantItem(store, execution);
    const completedAssistantItem = store.updateItem(assistantItem.id, {
      status: event.status === 'completed' ? 'completed' : 'failed',
      text: execution.assistantText,
      completedAt: event.completedAt,
    });
    const agentSession = store.updateAgentSession(execution.agentSessionId, {
      status: event.status === 'completed' ? 'idle' : 'failed',
      message:
        event.status === 'failed' ? (event.error?.message ?? 'The agent session failed.') : null,
      updatedAt: event.completedAt,
    });
    const turn = store.updateTurn(execution.turnId, {
      status: event.status,
      completedAt: event.completedAt,
      error:
        event.status === 'failed'
          ? normalizeTurnError(event.error, 'agent_turn_failed', 'The agent turn failed.')
          : null,
    });

    store.emitTurnEvent(execution.turnId, {
      event: 'agent.session.updated',
      requestId: execution.requestId,
      workspaceId: execution.workspaceId,
      threadId: execution.threadId,
      turnId: execution.turnId,
      data: { type: 'agent-session-updated', agentSession },
    });
    store.emitTurnEvent(execution.turnId, {
      event: 'item.completed',
      requestId: execution.requestId,
      workspaceId: execution.workspaceId,
      threadId: execution.threadId,
      turnId: execution.turnId,
      data: {
        type: 'item-completed',
        itemId: completedAssistantItem.id,
        item: completedAssistantItem,
      },
    });
    store.emitTurnEvent(execution.turnId, {
      event: 'turn.completed',
      requestId: execution.requestId,
      workspaceId: execution.workspaceId,
      threadId: execution.threadId,
      turnId: execution.turnId,
      data: { type: 'turn-completed', stopReason: event.stopReason, turn },
    });

    this.executionsByTurnId.delete(execution.turnId);
  }
}

/**
 * Reads the OpenKit session workspace compatibility digest from a package extension.
 *
 * @param environmentPackage Package snapshot to inspect.
 * @returns Compatibility digest, or null when the package does not carry one.
 */
function sessionWorkspaceCompatibilityKey(
  environmentPackage: AgentEnvironmentPackage
): string | null {
  const openkit = environmentPackage.extensions.openkit;

  if (!openkit || typeof openkit !== 'object') {
    return null;
  }

  const sessionWorkspace = (openkit as Record<string, unknown>).sessionWorkspace;

  if (!sessionWorkspace || typeof sessionWorkspace !== 'object') {
    return null;
  }

  const compatibilityKey = (sessionWorkspace as Record<string, unknown>).compatibilityKey;

  if (!compatibilityKey || typeof compatibilityKey !== 'object') {
    return null;
  }

  const digest = (compatibilityKey as Record<string, unknown>).digest;

  return typeof digest === 'string' ? digest : null;
}

/**
 * Returns a protocol-valid failed-turn error payload.
 */
function normalizeTurnError(
  error: { code: string | null; message: string } | undefined,
  fallbackCode: string,
  fallbackMessage: string
): { code: string; message: string } {
  const code = typeof error?.code === 'string' && error.code.trim() ? error.code : fallbackCode;
  const message =
    typeof error?.message === 'string' && error.message.trim() ? error.message : fallbackMessage;

  return { code, message };
}

/**
 * Maps internal agent-session lifecycle states to the UI/Core protocol status vocabulary.
 */
function mapAgentSessionState(state: AgentSessionState): AgentSessionReadModel['status'] {
  switch (state) {
    case 'starting':
      return 'initializing';
    case 'running':
    case 'awaiting_input':
    case 'stopping':
      return 'busy';
    case 'idle':
    case 'bound':
      return 'idle';
    case 'failed':
      return 'failed';
    case 'exited':
      return 'closed';
  }
}

/**
 * Builds a product-safe sandbox summary from a resolved Agent Environment Package.
 */
function summarizeAgentSessionSandbox(
  environmentPackage: AgentEnvironmentPackage
): AgentSessionReadModel['sandboxSummary'] {
  const rootRefs = environmentPackage.workspace.inputs.map((input) => input.id);

  if (rootRefs.length === 0) {
    return null;
  }

  return {
    access: environmentPackage.workspace.inputs.some((input) => input.access === 'read-write')
      ? 'read-write'
      : 'read-only',
    workspaceRootRefs: rootRefs,
    summary: `${rootRefs.length} workspace root${rootRefs.length === 1 ? '' : 's'} materialized.`,
  };
}

/**
 * Builds a product-safe backend summary from a resolved Agent Environment Package.
 */
function summarizeAgentSessionBackend(
  environmentPackage: AgentEnvironmentPackage
): AgentSessionBackendSummary {
  const kind = environmentPackage.backend.preferred;

  return {
    kind,
    health: 'unknown',
    controlMode: environmentPackage.control.mode,
    control: null,
    gatewayName: null,
    gatewayEndpoint: null,
    version: null,
    sandboxName: null,
  };
}

/**
 * Converts one runtime agent session to the product-visible dashboard shape.
 */
function toAgentSessionReadModel(session: AgentSession): AgentSessionReadModel {
  return {
    id: session.id,
    status: mapAgentSessionState(session.getState()),
    message: null,
    configVersion: null,
    workspaceRoots: [],
    stale: false,
    sandboxSummary: summarizeAgentSessionSandbox(session.environmentPackage),
    backend: summarizeAgentSessionBackend(session.environmentPackage),
  };
}

/**
 * Maps Codex turn statuses into nanocore turn statuses.
 */
function mapTurnStatus(status: CodexTurn['status']): 'completed' | 'interrupted' | 'failed' {
  if (status === 'completed' || status === 'interrupted') {
    return status;
  }

  return 'failed';
}

/**
 * Maps an OpenKit approval decision into the matching Codex response shape.
 */
function toCodexApprovalResponse(
  method: string,
  decision: ApprovalDecision
): CodexApprovalResponse {
  if (method === 'item/commandExecution/requestApproval') {
    return { decision: decision === 'granted' ? 'accept' : 'decline' };
  }

  return { decision: decision === 'granted' ? 'approved' : 'denied' };
}

/**
 * Maps a Codex thread item into the normalized host-adapter item snapshot.
 */
function mapCodexThreadItem(item: CodexThreadItem): AgentRuntimeItemSnapshot | null {
  if (item.type === 'agentMessage') {
    return {
      kind: 'agent-message',
      itemId: item.id,
      text: item.text ?? '',
    };
  }

  if (item.type === 'commandExecution') {
    return {
      kind: 'command-execution',
      itemId: item.id,
      command: item.command,
      cwd: item.cwd,
      exitCode: item.exitCode,
      durationMs: item.durationMs,
    };
  }

  return null;
}

/**
 * Returns true when an OpenCode agent should use the supervised server adapter.
 */
function isOpenCodeServeAgent(agent: CreateAgentSessionInput['agent']): boolean {
  return (
    agent.config.adapterType === 'opencode' &&
    (agent.config.command ?? '').trim().toLowerCase().startsWith('opencode serve')
  );
}
