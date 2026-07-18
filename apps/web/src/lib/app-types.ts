import type { CoreClient, SseEventEnvelope } from '@openkit/core-client';
import type {
  AgentSessionSchema,
  ApprovalRequestSchema,
  ArtifactSchema,
  ItemSchema,
  KnowledgeEntrySchema,
  ListWorkspacesResponseSchema,
  MetaResponseSchema,
  ThreadSchema,
  TurnSchema,
  WorkspaceRecordSchema,
  WorkspaceResourcesSchema,
} from '@openkit/protocol';
import type { z } from 'zod';

/**
 * Workspace summary row displayed in the workspace rail.
 */
export type WorkspaceSummary = z.infer<typeof ListWorkspacesResponseSchema>['items'][number];

/**
 * Workspace object used by the editor and dashboard panels.
 */
export type Workspace = z.infer<typeof WorkspaceRecordSchema>;

/**
 * Separately fetched workspace resources used by setup panels.
 */
export type WorkspaceResources = z.infer<typeof WorkspaceResourcesSchema>;

/**
 * Workspace knowledge entry displayed in the knowledge panel.
 */
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

/**
 * Thread item rendered in the thread rail.
 */
export type Thread = z.infer<typeof ThreadSchema>;

/**
 * Turn object shown in the composer and execution status UI.
 */
export type Turn = z.infer<typeof TurnSchema>;

/**
 * Streamed item shown in the conversation timeline.
 */
export type Item = z.infer<typeof ItemSchema>;

/**
 * Approval object rendered in the approval queue.
 */
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/**
 * Agent session state rendered in the execution panel.
 */
export type AgentSession = z.infer<typeof AgentSessionSchema>;

/**
 * Artifact shown in the artifact inventory.
 */
export type Artifact = z.infer<typeof ArtifactSchema>;

/**
 * Metadata response used for capability display.
 */
export type MetaResponse = z.infer<typeof MetaResponseSchema>;

/**
 * Workspace dashboard read model returned by nanocore app APIs.
 */
export type WorkspaceDashboard = Awaited<ReturnType<CoreClient['app']['getWorkspaceDashboard']>>;

/**
 * Thread dashboard read model returned by nanocore app APIs.
 */
export type ThreadDashboard = Awaited<ReturnType<CoreClient['app']['getThreadDashboard']>>;

/**
 * App API active session read model returned in thread dashboards.
 */
export type AgentSessionReadModel = NonNullable<ThreadDashboard['activeSession']>;

/**
 * App API backend summary attached to a thread dashboard active session.
 */
export type AgentSessionBackendSummary = NonNullable<AgentSessionReadModel['backend']>;

/**
 * Thread Goal Mode summary response returned by nanocore app APIs.
 */
export type ThreadGoalSummaryResponse = Awaited<
  ReturnType<CoreClient['app']['getThreadGoalSummary']>
>;

/**
 * Active Thread Goal Mode summary displayed in the workbench.
 */
export type ThreadGoalSummary = NonNullable<ThreadGoalSummaryResponse['goal']>;

/**
 * Goal Mode plan review response displayed in the workbench.
 */
export type ThreadGoalPlanReview = Awaited<ReturnType<CoreClient['app']['createThreadGoalPlan']>>;

/**
 * Settings diagnostics read model returned by nanocore app APIs.
 */
export type AppDiagnostics = Awaited<ReturnType<CoreClient['app']['getDiagnostics']>>;

/**
 * Setup diagnostics read model returned by nanocore app APIs.
 */
export type SetupDiagnostics = Awaited<ReturnType<CoreClient['app']['getSetupDiagnostics']>>;

/**
 * Runtime config file list returned by nanocore admin APIs.
 */
export type RuntimeConfigFileList = Awaited<ReturnType<CoreClient['runtimeConfig']['listFiles']>>;

/**
 * Runtime config file summary displayed in the Settings file tree.
 */
export type RuntimeConfigFileSummary = RuntimeConfigFileList['files'][number];

/**
 * Runtime config file read model returned by nanocore admin APIs.
 */
export type RuntimeConfigFileRead = Awaited<ReturnType<CoreClient['runtimeConfig']['getFile']>>;

/**
 * Runtime config validation read model returned by nanocore admin APIs.
 */
export type RuntimeConfigValidation = Awaited<ReturnType<CoreClient['runtimeConfig']['validate']>>;

/**
 * Runtime config file diagnostic displayed beside the source editor.
 */
export type RuntimeConfigFileDiagnostic = RuntimeConfigValidation['diagnostics'][number];

/**
 * Runtime config schema catalog returned by nanocore admin APIs.
 */
export type RuntimeConfigSchemaCatalog = Awaited<
  ReturnType<CoreClient['runtimeConfig']['getSchemas']>
>;

/**
 * Runtime config reload response returned by nanocore admin APIs.
 */
export type RuntimeConfigReload = Awaited<ReturnType<CoreClient['runtimeConfig']['reload']>>;

/**
 * Workspace repository list returned by NanoCore repository APIs.
 */
export type WorkspaceRepositoryList = Awaited<ReturnType<CoreClient['repositories']['list']>>;

/**
 * Workspace repository diagnostics returned by NanoCore repository APIs.
 */
export type WorkspaceRepositoryDiagnostics = Awaited<
  ReturnType<CoreClient['repositories']['diagnostics']>
>;

/**
 * Workspace vault reference list returned by NanoCore vault App APIs.
 */
export type WorkspaceVaultReferenceList = Awaited<
  ReturnType<CoreClient['app']['listWorkspaceVaultReferences']>
>;

/**
 * Automation row returned by nanocore app APIs.
 */
export type Automation = Awaited<ReturnType<CoreClient['app']['listAutomations']>>['items'][number];

/**
 * Search result returned by nanocore app search.
 */
export type AppSearchResult = Awaited<ReturnType<CoreClient['app']['search']>>['items'][number];

/**
 * Unified Action Center row returned by nanocore app APIs.
 */
export type HumanAttentionRow = Awaited<
  ReturnType<CoreClient['actionCenter']['listHumanAttention']>
>['items'][number];

/**
 * Durable workspace review decision sent from Action Center controls.
 */
export type WorkspaceSyncReviewDecision = Parameters<
  CoreClient['app']['submitWorkspaceSyncReviewDecision']
>[2]['decision'];

/**
 * Parsed SSE envelope emitted by the core server.
 */
export type TurnEvent = SseEventEnvelope;

/**
 * Per-thread client-side session cache.
 */
export interface ThreadSessionState {
  turns: Turn[];
  activeTurnId: string | null;
  items: Item[];
  approvals: ApprovalRequest[];
  agentSessions: AgentSession[];
  events: TurnEvent[];
}

/**
 * Top-level application state stored in the SPA.
 */
export interface AppState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  authRequired: boolean;
  errorMessage: string | null;
  meta: MetaResponse | null;
  workspaces: WorkspaceSummary[];
  selectedWorkspaceId: string | null;
  workspace: Workspace | null;
  workspaceDashboard: WorkspaceDashboard | null;
  workspaceResources: WorkspaceResources | null;
  threads: Thread[];
  selectedThreadId: string | null;
  threadDashboard: ThreadDashboard | null;
  threadGoalSummary: ThreadGoalSummaryResponse | null;
  threadGoalPlan: ThreadGoalPlanReview | null;
  artifacts: Artifact[];
  humanAttention: HumanAttentionRow[];
  appDiagnostics: AppDiagnostics | null;
  setupDiagnostics: SetupDiagnostics | null;
  automations: Automation[];
  quickChatResponse: string | null;
  sessions: Record<string, ThreadSessionState>;
  isCreatingWorkspace: boolean;
  isSavingWorkspace: boolean;
  isSavingKnowledge: boolean;
  isCreatingThread: boolean;
  isStartingTurn: boolean;
  isRespondingToApproval: boolean;
  isAuthSubmitting: boolean;
  inspectMode: 'product' | 'protocol';
}

/**
 * Public props for the root app component.
 */
export interface AppProps {
  client?: CoreClient;
}

/**
 * Creates an empty per-thread session cache.
 */
export function createEmptyThreadSessionState(): ThreadSessionState {
  return {
    turns: [],
    activeTurnId: null,
    items: [],
    approvals: [],
    agentSessions: [],
    events: [],
  };
}
