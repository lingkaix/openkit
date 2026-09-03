import type { MaterializedWorkspaceRoot } from '@openkit/app-api-schemas';
import type {
  AgentEnvironmentPackage,
  WorkspaceDataSourceCatalog,
  WorkspaceMcpServerCatalog,
} from '@openkit/config-schema';
import type {
  ActorRef,
  AgentSchema,
  AgentSessionStatus,
  ApprovalRequestSchema,
  AgentSession as ProtocolAgentSession,
  TurnSchema,
  UserInputResponseItemSchema,
} from '@openkit/protocol';
import type { z } from 'zod';
import type { ResolvedAgentSetup } from '../agents/setup-resolver.js';
import type { FsStore } from '../lib/store.js';

type Agent = z.infer<typeof AgentSchema>;

/** Product agent record selected before resolving its separate AgentManifest. */
export type RuntimeAgent = Agent;

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

  /** Previews exact AgentSession reuse or replacement without Store or backend effects. */
  prepareAgentSessionForTurn?(
    store: FsStore,
    input: PrepareAgentSessionForTurnInput
  ): Promise<PreparedAgentSessionForTurn>;

  /** Revalidates a prepared AgentSession decision after lease acquisition and commits replacement. */
  commitPreparedAgentSessionForTurn?(
    store: FsStore,
    input: CommitPreparedAgentSessionForTurnInput
  ): Promise<void>;

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
    context: HumanResponseCommandRuntimeContext
  ): Promise<z.infer<typeof ApprovalRequestSchema>>;

  /**
   * Sends one user-input answer back to the active agent runtime.
   */
  respondUserInput?(
    store: FsStore,
    turnId: string,
    answers: z.infer<typeof UserInputResponseItemSchema>['answers'],
    context: HumanResponseCommandRuntimeContext
  ): Promise<unknown>;

  /**
   * Returns the AgentSession bound to one thread, if the runtime has materialized it.
   */
  getAgentSession?(
    store: FsStore,
    workspaceId: string,
    threadId: string
  ): AgentSessionReadModel | null;
}

/** Static future-Turn inputs required for pre-lease AgentSession preparation. */
export interface PrepareAgentSessionForTurnInput {
  /** Complete selected agent setup used by the final AEP resolution. */
  readonly agentSetup: ResolvedAgentSetup;
  /** Fresh AgentSession id reserved for replacement or first creation. */
  readonly freshAgentSessionId: string;
  /** Client request id associated with the future Turn. */
  readonly requestId: string | null;
  /** Non-durable future Turn scope used by static AEP planning. */
  readonly turn: z.infer<typeof TurnSchema>;
  /** Exact input that the future Turn will execute. */
  readonly turnInput: string;
  /** Host-local cwd selected for the future worker. */
  readonly workspaceCwd: string | null;
  /** Materialized roots captured by scheduler admission. */
  readonly workspaceRoots: MaterializedWorkspaceRoot[];
  /** Optional data-source catalog for sourceRef-backed roots. */
  readonly workspaceDataSourceCatalog?: WorkspaceDataSourceCatalog;
  /** Optional MCP server catalog captured for the selected Agent. */
  readonly workspaceMcpServerCatalog?: WorkspaceMcpServerCatalog;
  /** Optional sourceRef bindings captured by admission. */
  readonly workspaceSourceRefs?: Record<string, string>;
}

/** Immutable current AgentSession fields retained for post-dispatch compare-and-set validation. */
export interface PreparedCurrentAgentSession {
  /** Stable current AgentSession identity. */
  readonly id: string;
  /** Agent identity selected when the current AgentSession was created. */
  readonly agentId: string;
  /** Launch-policy snapshot required for exact reuse. */
  readonly policySnapshotId: string | null;
  /** Compatibility key retained by the current AgentSession. */
  readonly sessionCompatibilityKey: string | null;
  /** Whether durable configuration invalidated the current AgentSession. */
  readonly stale: boolean;
  /** Current lifecycle status observed before dispatch. */
  readonly status: AgentSessionStatus;
  /** Last durable mutation timestamp used as the compare-and-set token. */
  readonly updatedAt: string;
}

/** Runtime-owned AgentSession identity and exact key accepted before lease acquisition. */
export interface PreparedAgentSessionForTurn {
  /** Reused or fresh AgentSession id authorized for the future Turn. */
  readonly agentSessionId: string;
  /** Current predecessor snapshot, or null when the Thread had no current AgentSession. */
  readonly currentAgentSession: PreparedCurrentAgentSession | null;
  /** Whether post-dispatch commit must close the current predecessor before starting the Turn. */
  readonly replacementRequired: boolean;
  /** Exact SessionCompatibilityKey that the lease and final AEP must retain. */
  readonly sessionCompatibilityKey: string;
}

/** Post-dispatch input for exact AgentSession revalidation and replacement commit. */
export interface CommitPreparedAgentSessionForTurnInput {
  /** Exact scheduler lease acquired from the prepared identity and key. */
  readonly leaseId: string;
  /** Read-only decision and compare-and-set token produced before dispatch. */
  readonly prepared: PreparedAgentSessionForTurn;
  /** Original static inputs whose compatibility key must remain unchanged. */
  readonly preparation: PrepareAgentSessionForTurnInput;
}

/**
 * Product-safe app-local backend summary for one live AgentSession.
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
  /** NanoHost runtime target that owns the active sandbox session. */
  runtimeTargetId: string | null;
  /** Opaque NanoHost sandbox binding for the active worker session. */
  sandboxBindingRef: string | null;
  /** Backend distribution version when known. */
  version: string | null;
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
  /** Scheduler-owned AgentSession id used when a lease already reserved lineage. */
  agentSessionId?: string;
  /** Complete selected manifest and resolved provider inputs for governed workers. */
  agentSetup?: ResolvedAgentSetup;
  /** Materialized workspace roots captured from the effective config snapshot. */
  workspaceRoots: MaterializedWorkspaceRoot[];
  /** Optional workspace data source catalog captured for sourceRef-backed roots. */
  workspaceDataSourceCatalog?: WorkspaceDataSourceCatalog;
  /** Optional Workspace MCP server catalog captured for the selected Agent. */
  workspaceMcpServerCatalog?: WorkspaceMcpServerCatalog;
  /** Optional root-id to sourceRef bindings captured for sourceRef-backed roots. */
  workspaceSourceRefs?: Record<string, string>;
  /** Scheduler-owned non-secret sandbox binding reference for worker-control auth. */
  sandboxBindingRef?: string;
  /** Exact pre-lease SessionCompatibilityKey committed to the scheduler lease. */
  sessionCompatibilityKey?: string;
  /** Host-local worker working directory selected for this turn. */
  workspaceCwd?: string | null;
  /** Request id for the client command that accepted this turn. */
  requestId?: string | null;
  /** Exact actor whose action triggered this turn. */
  triggerActor: ActorRef;
}

/**
 * Runtime context captured for one turn-scoped command.
 */
export interface TurnCommandRuntimeContext {
  /** Request id for the client command that caused the emitted events. */
  requestId: string | null;
}

/** Runtime context for one human response that must retain the authenticated user actor. */
export interface HumanResponseCommandRuntimeContext extends TurnCommandRuntimeContext {
  /** Exact authenticated human who submitted the decision or answer. */
  actor: Extract<ActorRef, { readonly kind: 'user' }>;
}
