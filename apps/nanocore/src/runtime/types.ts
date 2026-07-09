import type { MaterializedWorkspaceRoot } from '@openkit/app-api-schemas';
import type {
  AgentEnvironmentPackage,
  WorkerSandboxAccess,
  WorkspaceDataSourceCatalog,
} from '@openkit/config-schema';
import type {
  AgentSchema,
  AgentSessionStatus,
  ApprovalRequestSchema,
  AgentSession as ProtocolAgentSession,
  StopReason,
} from '@openkit/protocol';
import type { z } from 'zod';
import type { FsStore } from '../lib/store.js';

type Agent = z.infer<typeof AgentSchema>;

/**
 * App-local runnable agent adapter configuration kept out of the Core protocol.
 */
export interface RuntimeAgentConfig {
  /** Local worker runtime adapter. */
  adapterType: 'codex' | 'opencode';
  /** Optional command used to start the adapter. */
  command: string | null;
  /** Optional server URL used by server-backed adapters. */
  baseUrl: string | null;
  /** Host workspace root used by the runtime adapter. */
  workspaceRoot: string;
  /** Environment variables merged into the adapter process. */
  environment: Record<string, string>;
  /** Adapter-native capability flags. */
  capabilities: string[];
  /** Worker-side MCP server catalog ids requested for the runtime. */
  mcpServerIds?: string[] | undefined;
}

/**
 * App-local runnable agent record that augments the stable protocol summary.
 */
export type RuntimeAgent = Agent & { config: RuntimeAgentConfig };

/**
 * Product-visible capability flags exposed by `/api/meta`.
 */
export interface RuntimeCapabilities {
  approvals: boolean;
  interrupts: boolean;
  artifacts: boolean;
  workspaceConfig: boolean;
  workspaceKnowledgeEditing: boolean;
  questions: boolean;
}

/**
 * Supported nanocore SSE event family names.
 */
export type RuntimeEventFamily =
  | 'workspace.updated'
  | 'thread.created'
  | 'thread.updated'
  | 'turn.started'
  | 'turn.updated'
  | 'item.created'
  | 'item.delta'
  | 'item.completed'
  | 'approval.requested'
  | 'approval.resolved'
  | 'agent.session.updated'
  | 'artifact.created'
  | 'artifact.updated'
  | 'turn.completed'
  | 'error';

/**
 * Protocol item types that a runtime may emit.
 */
export type RuntimeItemType =
  | 'user-message'
  | 'assistant-message'
  | 'reasoning'
  | 'artifact-reference'
  | 'command-execution'
  | 'approval-request'
  | 'approval-decision'
  | 'user-input-request'
  | 'user-input-response'
  | 'file-change'
  | 'tool-call'
  | 'agent-handoff'
  | 'status'
  | 'plan'
  | 'knowledge-injection';

/**
 * Protocol item delta kinds that a runtime may emit.
 */
export type RuntimeItemDeltaKind =
  | 'text-delta'
  | 'indexed-text-delta'
  | 'part-started'
  | 'output-delta'
  | 'snapshot-updated'
  | 'progress-updated'
  | 'request-started'
  | 'request-resolved'
  | 'interaction-delta'
  | 'artifact-updated'
  | 'knowledge-injection-updated';

/**
 * UI approval decision forwarded to an agent runtime.
 */
export type ApprovalDecision = 'granted' | 'denied';

/**
 * Runtime approval request normalized from an agent protocol.
 */
export interface AgentApprovalRequestedEvent {
  type: 'approval-requested';
  turnId: string;
  approvalId: string;
  kind: 'permission' | 'destructive-action';
  title: string;
  description: string;
}

/**
 * Selectable option for one agent user-input question.
 */
export interface AgentUserInputQuestionOption {
  label: string;
  description: string;
}

/**
 * One question requested by an agent while a turn is paused.
 */
export interface AgentUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: AgentUserInputQuestionOption[] | null;
  isOther: boolean;
  isSecret: boolean;
}

/**
 * Runtime user-input request normalized from an agent protocol.
 */
export interface AgentUserInputRequestedEvent {
  type: 'user-input-requested';
  turnId: string;
  requestId: string;
  prompt: string;
  questions: AgentUserInputQuestion[];
}

/**
 * Abstraction used by the HTTP layer to execute and interrupt turns.
 */
export interface TurnExecutor {
  /**
   * Product-visible capability flags for the bound runtime.
   */
  readonly capabilities: RuntimeCapabilities;

  /**
   * SSE event families that this runtime may emit.
   */
  readonly eventFamilies: readonly RuntimeEventFamily[];

  /**
   * Protocol item types that this runtime may emit.
   */
  readonly itemTypes?: readonly RuntimeItemType[];

  /**
   * Protocol item delta kinds that this runtime may emit.
   */
  readonly itemDeltaKinds?: readonly RuntimeItemDeltaKind[];

  /**
   * Starts executing one turn.
   */
  startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context?: TurnStartRuntimeContext
  ): Promise<void>;

  /**
   * Interrupts one active turn.
   */
  interruptTurn(store: FsStore, turnId: string, context?: TurnCommandRuntimeContext): Promise<void>;

  /**
   * Sends one approval decision back to the active agent runtime.
   */
  respondApproval?(
    store: FsStore,
    approvalRequestId: string,
    decision: ApprovalDecision,
    context?: TurnCommandRuntimeContext
  ): Promise<z.infer<typeof ApprovalRequestSchema>>;

  /**
   * Sends one user-input answer back to the active agent runtime.
   */
  respondUserInput?(
    store: FsStore,
    turnId: string,
    input: string,
    context?: TurnCommandRuntimeContext
  ): Promise<unknown>;

  /**
   * Returns the agent session bound to one thread, if the runtime has materialized it.
   */
  getAgentSession?(
    store: FsStore,
    workspaceId: string,
    threadId: string
  ): AgentSessionReadModel | null;

  /**
   * Returns refreshed agent session read models for one workspace.
   */
  refreshAgentSessions?(store: FsStore, workspaceId: string): AgentSessionReadModel[];
}

/**
 * Internal agent-session lifecycle states used by the local Codex adapter.
 */
export type AgentSessionState =
  | 'starting'
  | 'idle'
  | 'bound'
  | 'running'
  | 'awaiting_input'
  | 'stopping'
  | 'exited'
  | 'failed';

/**
 * Product-safe app-local backend summary for one live agent session.
 */
export interface AgentSessionBackendSummary {
  /** Worker governance backend family selected for this session. */
  kind:
    | 'host'
    | 'openshell'
    | 'docker'
    | 'kubernetes'
    | 'vm'
    | 'managed-sandbox'
    | 'custom'
    | 'unknown';
  /** Best known backend health at read-model projection time. */
  health: 'ready' | 'unavailable' | 'unknown' | 'not-applicable';
  /** Worker control mode selected by the resolved Agent Environment Package. */
  controlMode: AgentEnvironmentPackage['control']['mode'] | null;
  /** Product-safe live worker control summary, when a control session is active. */
  control: AgentSessionBackendControlSummary | null;
  /** OpenShell gateway name when known and product-safe. */
  gatewayName: string | null;
  /** OpenShell gateway endpoint when known and product-safe. */
  gatewayEndpoint: string | null;
  /** Backend distribution version when known. */
  version: string | null;
  /** Product-safe sandbox name when known. */
  sandboxName: string | null;
}

/**
 * Product-safe live worker control summary for one backend session.
 */
export interface AgentSessionBackendControlSummary {
  /** Latest worker heartbeat summary, if any. */
  heartbeat: {
    /** Current worker lifecycle status. */
    status:
      | 'starting'
      | 'running'
      | 'idle'
      | 'awaiting_command'
      | 'stopping'
      | 'completed'
      | 'failed';
    /** Worker sequence number associated with the heartbeat. */
    sequence: number;
    /** Timestamp recorded by NanoCore when the heartbeat arrived. */
    lastHeartbeatAt: string;
  } | null;
  /** Count of live artifact notices received from the worker. */
  artifactNoticeCount: number;
  /** Count of commands queued for the worker. */
  queuedCommandCount: number;
  /** Count of commands delivered by a worker poll. */
  deliveredCommandCount: number;
  /** Count of terminal command results reported by the worker. */
  terminalResultCount: number;
  /** Last terminal command exit code, if any result has arrived. */
  lastTerminalExitCode: number | null;
  /** Timestamp for the latest terminal command result, if any. */
  lastTerminalCompletedAt: string | null;
}

/**
 * Product-visible session state projected into app read models.
 */
export interface AgentSessionReadModel {
  /** Runtime config version captured when the session was created. */
  configVersion: number | null;
  id: string;
  status: AgentSessionStatus;
  message: string | null;
  /** Workspace data roots captured when the session was created. */
  workspaceRoots: MaterializedWorkspaceRoot[];
  /** Whether the session was created from an older runtime config version. */
  stale: boolean;
  /** Product-safe sandbox summary derived from the session package workspace inputs. */
  sandboxSummary: ProtocolAgentSession['sandboxSummary'];
  /** Product-safe backend summary derived from the session package backend target. */
  backend: AgentSessionBackendSummary | null;
}

/**
 * Runtime context captured when one turn is accepted.
 */
export interface TurnStartRuntimeContext {
  /** Scheduler-owned agent session id used when a lease already reserved lineage. */
  agentSessionId?: string;
  /** Backend requirements resolved from authored agent setup. */
  backendRequirements?: {
    /** Backend kinds allowed by the authored setup. */
    allowedKinds: AgentEnvironmentPackage['backend']['allowedKinds'];
    /** Preferred backend kind, when declared. */
    preferred: AgentEnvironmentPackage['backend']['preferred'] | null;
    /** Backend capabilities required by the authored setup. */
    requiredCapabilities: AgentEnvironmentPackage['backend']['requiredCapabilities'];
  };
  /** Materialized workspace roots captured from the effective config snapshot. */
  workspaceRoots: MaterializedWorkspaceRoot[];
  /** Optional workspace data source catalog captured for sourceRef-backed roots. */
  workspaceDataSourceCatalog?: WorkspaceDataSourceCatalog;
  /** Optional root-id to sourceRef bindings captured for sourceRef-backed roots. */
  workspaceSourceRefs?: Record<string, string>;
  /** Scheduler-owned non-secret sandbox binding reference for worker-control auth. */
  sandboxBindingRef?: string;
  /** User-authored sandbox access declarations captured for this turn. */
  sandboxAccess?: WorkerSandboxAccess;
  /** Host-local worker working directory selected for this turn. */
  workspaceCwd?: string | null;
  /** Request id for the client command that accepted this turn. */
  requestId?: string | null;
}

/**
 * Runtime context captured for one turn-scoped command.
 */
export interface TurnCommandRuntimeContext {
  /** Request id for the client command that caused the emitted events. */
  requestId: string | null;
}

/**
 * Session state-change event emitted by agent sessions.
 */
export interface AgentSessionStateChangedEvent {
  type: 'session-state-changed';
  state: AgentSessionState;
  reason?: string;
}

/**
 * Notification that an agent turn has begun executing.
 */
export interface AgentTurnStartedEvent {
  type: 'turn-started';
  turnId: string;
  startedAt: string;
}

/**
 * Delta text streamed by the agent's assistant message.
 */
export interface AgentMessageDeltaEvent {
  type: 'agent-message-delta';
  turnId: string;
  itemId?: string;
  delta: string;
}

/**
 * Delta text streamed by the agent's command execution output.
 */
export interface AgentCommandOutputDeltaEvent {
  type: 'command-output-delta';
  turnId: string;
  itemId: string;
  delta: string;
}

/**
 * Normalized agent item snapshot that can be mapped to protocol items.
 */
export type AgentRuntimeItemSnapshot =
  | {
      kind: 'agent-message';
      itemId: string;
      text: string;
    }
  | {
      kind: 'command-execution';
      itemId: string;
      command: string;
      cwd: string;
      exitCode: number | null;
      durationMs: number | null;
    };

/**
 * Runtime item lifecycle event emitted when an agent starts a visible item.
 */
export interface AgentItemStartedEvent {
  type: 'agent-item-started';
  turnId: string;
  item: AgentRuntimeItemSnapshot;
}

/**
 * Runtime item lifecycle event emitted when an agent completes a visible item.
 */
export interface AgentItemCompletedEvent {
  type: 'agent-item-completed';
  turnId: string;
  item: AgentRuntimeItemSnapshot;
}

/**
 * Terminal turn result emitted by the agent session.
 */
export interface AgentTurnCompletedEvent {
  type: 'turn-completed';
  turnId: string;
  status: 'completed' | 'interrupted' | 'failed';
  stopReason: StopReason;
  completedAt: string;
  error?: {
    code: string | null;
    message: string;
  };
}

/**
 * Union of session events consumed by the local Codex adapter.
 */
export type AgentSessionEvent =
  | AgentSessionStateChangedEvent
  | AgentTurnStartedEvent
  | AgentMessageDeltaEvent
  | AgentCommandOutputDeltaEvent
  | AgentApprovalRequestedEvent
  | AgentUserInputRequestedEvent
  | AgentItemStartedEvent
  | AgentItemCompletedEvent
  | AgentTurnCompletedEvent;

/**
 * Parameters required to start a real agent session.
 */
export interface CreateAgentSessionInput {
  /** NanoCore-owned agent session id used for canonical lineage. */
  id: string;
  /** Resolved Agent Environment Package governing this session. */
  environmentPackage: AgentEnvironmentPackage;
  /** Workspace data roots captured for this session. */
  workspaceRoots: MaterializedWorkspaceRoot[];
  /** Host-local working directory selected for the session, when different from the agent default. */
  workspaceCwd?: string | null;
  workspaceId: string;
  threadId: string;
  agent: RuntimeAgent;
}

/**
 * Live session contract implemented by the host-agent transport.
 */
export interface AgentSession {
  /**
   * Stable internal session identifier.
   */
  readonly id: string;

  /**
   * Resolved package that governed creation of this session.
   */
  readonly environmentPackage: AgentEnvironmentPackage;

  /**
   * Local thread bound to this session.
   */
  readonly threadId: string;

  /**
   * Registers a session event listener.
   */
  onEvent(listener: (event: AgentSessionEvent) => void): () => void;

  /**
   * Starts one turn on the bound agent thread.
   */
  startTurn(turnId: string, input: string): Promise<void>;

  /**
   * Interrupts one in-flight turn.
   */
  interruptTurn(turnId: string): Promise<void>;

  /**
   * Responds to a pending agent approval request when supported.
   */
  respondApproval?(approvalId: string, decision: ApprovalDecision): Promise<void>;

  /**
   * Responds to a pending agent user-input request when supported.
   */
  respondUserInput?(requestId: string, answers: Record<string, string[]>): Promise<void>;

  /**
   * Closes the underlying agent resources.
   */
  close(): Promise<void>;

  /**
   * Returns the current lifecycle state.
   */
  getState(): AgentSessionState;
}

/**
 * Factory that creates new bound agent sessions.
 */
export interface AgentSessionFactory {
  /**
   * Creates an agent session for one thread.
   */
  createSession(input: CreateAgentSessionInput): Promise<AgentSession>;
}
