import { icons as remixIcons } from '@iconify-json/ri';
import {
  ApiCallError,
  type CodexOAuthLoginMode,
  type CodexOAuthStatusPayload,
  type CoreClient,
} from '@openkit/core-client';
import { addCollection } from 'iconify-icon';
import {
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from 'solid-js';
import { createStore } from 'solid-js/store';

import './App.css';
import { AgentStatusBadge } from './components/AgentStatusBadge';
import { ArtifactView } from './components/ArtifactView';
import { ChatComposer, type ChatComposerMode } from './components/ChatComposer';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import {
  type CreateKnowledgeInput,
  KnowledgePanel,
  type UpdateKnowledgeInput,
} from './components/KnowledgePanel';
import { RuntimeConfigPanel } from './components/RuntimeConfigPanel';
import type { RuntimeConfigReloadInput } from './components/SetupReadinessPanel';
import { ThreadList } from './components/ThreadList';
import { reconcileTurnItems, ThreadWorkbench } from './components/ThreadWorkbench';
import { TurnFeedback, type TurnFeedbackInput } from './components/TurnFeedback';
import { WorkspaceDashboard } from './components/WorkspaceDashboard';
import type {
  AppProps,
  ApprovalRequest,
  AppSearchResult,
  AppState,
  Artifact,
  ArtifactReviewDecision,
  HumanAttentionRow,
  Item,
  RuntimeConfigFileDiagnostic,
  RuntimeConfigFileRead,
  RuntimeConfigFileSummary,
  RuntimeConfigReload,
  RuntimeConfigSchemaCatalog,
  RuntimeConfigValidation,
  Thread,
  ThreadDashboard,
  ThreadGoalSummaryResponse,
  ThreadSessionState,
  Turn,
  TurnEvent,
  Workspace,
  WorkspaceRepositoryDiagnostics,
  WorkspaceRepositoryList,
  WorkspaceResources,
  WorkspaceSummary,
  WorkspaceSyncReviewDecision,
  WorkspaceVaultReferenceList,
} from './lib/app-types';
import { createEmptyThreadSessionState } from './lib/app-types';
import { createDefaultClient } from './lib/default-client';

addCollection(remixIcons);

declare module 'solid-js' {
  namespace JSX {
    interface IntrinsicElements {
      'iconify-icon': {
        class?: string;
        icon: string;
      };
    }
  }
}

const STORAGE_KEYS = {
  workspaceId: 'openkit.web.workspaceId',
  threadId: 'openkit.web.threadId',
  inspectMode: 'openkit.web.inspectMode',
  theme: 'openkit.web.theme',
} as const;

const APP_THEMES = [
  'light',
  'dark',
  'cupcake',
  'bumblebee',
  'emerald',
  'corporate',
  'synthwave',
  'retro',
  'cyberpunk',
  'valentine',
  'halloween',
  'garden',
  'forest',
  'aqua',
  'lofi',
  'pastel',
  'fantasy',
  'wireframe',
  'black',
  'luxury',
  'dracula',
  'cmyk',
  'autumn',
  'business',
  'acid',
  'lemonade',
  'night',
  'coffee',
  'winter',
  'dim',
  'nord',
  'sunset',
  'caramellatte',
  'abyss',
  'silk',
] as const;

/**
 * Runtime config validation draft bound to one selected file.
 */
interface RuntimeConfigValidationDraft {
  /** Runtime config file id to validate. */
  fileId: string;
  /** Unsaved source content to validate for the file. */
  content: string;
}

/**
 * Starter prompts that can seed a new chat thread.
 */
const CHAT_STARTER_SUGGESTIONS = [
  { icon: 'ri:road-map-line', title: 'Plan a road trip' },
  { icon: 'ri:search-eye-line', title: 'Research a buying decision' },
  { icon: 'ri:mail-line', title: 'Summarize my unread emails and draft responses' },
  { icon: 'ri:function-line', title: 'Connect Computer Use to OpenKit' },
] as const;

/**
 * Top-level page selected from the primary workspace sidebar.
 */
type AppPage =
  | 'chat'
  | 'dashboard'
  | 'action-center'
  | 'automation'
  | 'new-workspace'
  | 'workspace'
  | 'thread'
  | 'artifact'
  | 'settings';
type AppTheme = (typeof APP_THEMES)[number];
/**
 * Settings category selected from the primary left sidebar.
 */
type SettingsSection =
  | 'general'
  | 'appearance'
  | 'configuration'
  | 'runtime-config'
  | 'knowledge'
  | 'portability'
  | 'diagnostics';
type ApprovalDecision = 'granted' | 'denied';

/**
 * Minimal approval target fields needed for a response request.
 */
interface ApprovalResponseTarget {
  approvalRequestId: string;
  workspaceId: string;
  threadId: string;
  turnId: string;
}

/**
 * Minimal user-input request fields needed for an answer request.
 */
interface UserInputResponseTarget {
  workspaceId: string;
  threadId: string;
  turnId: string;
}

type ApprovalStreamEventData =
  | Extract<TurnEvent['data'], { type: 'approval-requested' }>
  | Extract<TurnEvent['data'], { type: 'approval-resolved' }>;
type AgentSessionStreamEventData = Extract<TurnEvent['data'], { type: 'agent-session-updated' }>;
type ArtifactStreamEventData =
  | Extract<TurnEvent['data'], { type: 'artifact-created' }>
  | Extract<TurnEvent['data'], { type: 'artifact-updated' }>;
type TurnUpdatedStreamEventData = Extract<TurnEvent['data'], { type: 'turn-updated' }>;
type TurnCompletedStreamEventData = Extract<TurnEvent['data'], { type: 'turn-completed' }>;

/**
 * Workspace and thread identifiers parsed from the current browser route.
 */
interface WorkspaceRoute {
  workspaceId: string | null;
  threadId: string | null;
  artifactId: string | null;
}

/**
 * Renders one local Remix Icon through the Iconify web component.
 */
function RemixIcon(props: { icon: string }): JSX.Element {
  return (
    <span aria-hidden="true" class="remix-icon">
      <iconify-icon icon={props.icon} />
    </span>
  );
}

/**
 * Formats one daisyUI theme name for compact theme cards.
 */
function formatThemeName(theme: AppTheme): string {
  return theme;
}

/**
 * Reads a persisted local storage value when available.
 */
function readStoredValue(key: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.localStorage.getItem(key);
}

/**
 * Reads the locally persisted daisyUI theme and falls back to the default design theme.
 */
function readStoredTheme(): AppTheme {
  const storedTheme = readStoredValue(STORAGE_KEYS.theme);

  if (APP_THEMES.includes(storedTheme as AppTheme)) {
    return storedTheme as AppTheme;
  }

  return 'light';
}

/**
 * Persists a local storage value when running in the browser.
 */
function writeStoredValue(key: string, value: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }

  if (value === null) {
    window.localStorage.removeItem(key);
    return;
  }

  window.localStorage.setItem(key, value);
}

/**
 * Checks whether the loaded meta response advertises one protocol capability flag.
 */
function hasCapability(capabilities: readonly string[] | undefined, flag: string): boolean {
  return capabilities?.includes(flag) ?? false;
}

/**
 * Checks whether a tolerant stream payload carries a strict approval event.
 */
function isApprovalStreamEventData(data: TurnEvent['data']): data is ApprovalStreamEventData {
  return (
    (data.type === 'approval-requested' || data.type === 'approval-resolved') && 'approval' in data
  );
}

/**
 * Checks whether a tolerant stream payload carries a strict agent session update.
 */
function isAgentSessionStreamEventData(
  data: TurnEvent['data']
): data is AgentSessionStreamEventData {
  return data.type === 'agent-session-updated' && 'agentSession' in data;
}

/**
 * Checks whether a tolerant stream payload carries a strict artifact event.
 */
function isArtifactStreamEventData(data: TurnEvent['data']): data is ArtifactStreamEventData {
  return (
    (data.type === 'artifact-created' || data.type === 'artifact-updated') && 'artifact' in data
  );
}

/**
 * Checks whether a tolerant stream payload carries a strict turn update.
 */
function isTurnUpdatedStreamEventData(data: TurnEvent['data']): data is TurnUpdatedStreamEventData {
  return data.type === 'turn-updated' && 'turn' in data;
}

/**
 * Checks whether a tolerant stream payload carries a strict turn completion.
 */
function isTurnCompletedStreamEventData(
  data: TurnEvent['data']
): data is TurnCompletedStreamEventData {
  return data.type === 'turn-completed' && 'turn' in data;
}

/**
 * Formats an ISO timestamp for compact UI display.
 */
function formatTimestamp(timestamp: string | null | undefined): string {
  if (!timestamp) {
    return 'pending';
  }

  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

/**
 * Returns a user-facing label for a turn status.
 */
function formatTurnStatus(status: Turn['status'] | undefined): string {
  switch (status) {
    case 'awaiting_human':
      return 'Awaiting human';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'interrupted':
      return 'Interrupted';
    case 'pending':
      return 'Pending';
    default:
      return 'Idle';
  }
}

/**
 * Returns a user-facing label for an approval state.
 */
function formatApprovalStatus(status: ApprovalRequest['status']): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'granted':
      return 'Granted';
    case 'denied':
      return 'Denied';
    case 'expired':
      return 'Expired';
    case 'superseded':
      return 'Superseded';
    case 'withdrawn':
      return 'Withdrawn';
  }
}

/**
 * Upserts an entity by `id` while preserving stable order.
 */
function upsertById<TItem extends { id: string }>(items: TItem[], nextItem: TItem): TItem[] {
  const currentIndex = items.findIndex((item) => item.id === nextItem.id);

  if (currentIndex === -1) {
    return [...items, nextItem];
  }

  return items.map((item) => (item.id === nextItem.id ? nextItem : item));
}

/**
 * Upserts a thread session snapshot in the store.
 */
function updateThreadSession(
  sessions: Record<string, ThreadSessionState>,
  threadId: string,
  updater: (session: ThreadSessionState) => ThreadSessionState
): Record<string, ThreadSessionState> {
  return {
    ...sessions,
    [threadId]: updater(sessions[threadId] ?? createEmptyThreadSessionState()),
  };
}

/**
 * Picks a valid workspace from the available summaries and local storage.
 */
function chooseWorkspace(
  workspaces: WorkspaceSummary[],
  preferredWorkspaceId: string | null
): string | null {
  if (
    preferredWorkspaceId &&
    workspaces.some((workspace) => workspace.id === preferredWorkspaceId)
  ) {
    return preferredWorkspaceId;
  }

  return workspaces[0]?.id ?? null;
}

/**
 * Reads the workspace and thread ids encoded in the current browser path.
 */
function readWorkspaceRouteFromLocation(): WorkspaceRoute {
  if (typeof window === 'undefined') {
    return { workspaceId: null, threadId: null, artifactId: null };
  }

  const match = window.location.pathname.match(
    /^\/workspaces\/([^/]+)(?:(?:\/threads\/([^/]+))|(?:\/artifacts\/([^/]+)))?$/
  );

  return {
    workspaceId: match?.[1] ? decodeURIComponent(match[1]) : null,
    threadId: match?.[2] ? decodeURIComponent(match[2]) : null,
    artifactId: match?.[3] ? decodeURIComponent(match[3]) : null,
  };
}

/**
 * Writes the selected workspace into the browser URL.
 */
function writeWorkspaceLocation(workspaceId: string, threadId?: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }

  const nextPath = threadId
    ? `/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}`
    : `/workspaces/${encodeURIComponent(workspaceId)}`;

  if (window.location.pathname !== nextPath) {
    window.history.replaceState(null, '', nextPath);
  }
}

/**
 * Writes the selected artifact into the browser URL.
 */
function writeArtifactLocation(workspaceId: string, artifactId: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  const nextPath = `/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(
    artifactId
  )}`;

  if (window.location.pathname !== nextPath) {
    window.history.replaceState(null, '', nextPath);
  }
}

/**
 * Creates a client-side request correlation id for turn starts.
 */
function createRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Returns whether a turn status ends local turn activity.
 */
function isTerminalTurnStatus(status: Turn['status']): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'interrupted' ||
    status === 'cancelled'
  );
}

/**
 * Builds the default worker routing explanation used before NanoCore returns a thread dashboard.
 */
function workerRoutingExplanation(agentId: string | null): string {
  if (!agentId) {
    return 'NanoCore cannot route this thread until a worker agent is selected.';
  }

  return 'NanoCore routes thread prompts through WorkerCoordinator to the selected worker agent because automation changes workspace state.';
}

/**
 * Builds an idle thread work status for optimistic thread creation.
 */
function createIdleThreadWorkStatus(agentId: string | null): ThreadDashboard['workStatus'] {
  return {
    currentMode: 'automation',
    selectedAgentId: agentId,
    activeTurnStatus: 'idle',
    pendingApprovalCount: 0,
    pendingQuestionCount: 0,
    latestArtifact: null,
    routing: {
      decision: agentId ? 'worker_turn' : 'unsupported',
      explanation: workerRoutingExplanation(agentId),
      selectedAgentId: agentId,
      confidence: 1,
      requiredUserAction: agentId ? null : 'Select a worker agent before starting a turn.',
    },
  };
}

/**
 * Picks a valid thread from the available thread list and local storage.
 */
function chooseThread(threads: Thread[], preferredThreadId: string | null): string | null {
  if (preferredThreadId && threads.some((thread) => thread.id === preferredThreadId)) {
    return preferredThreadId;
  }

  return threads[0]?.id ?? null;
}

/**
 * Parses a compact terminal command draft into argv tokens.
 *
 * @param value Terminal command draft from the active-session command input.
 * @returns Command argv tokens split on whitespace.
 */
function parseTerminalCommandDraft(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

/**
 * Returns a badge class for an agent session or turn status.
 */
function statusBadgeClass(status: string): string {
  switch (status) {
    case 'completed':
    case 'granted':
    case 'enabled':
    case 'active':
      return 'badge-success';
    case 'awaiting_human':
    case 'waiting':
    case 'pending':
      return 'badge-warning';
    case 'failed':
    case 'denied':
    case 'archived':
      return 'badge-error';
    default:
      return 'badge-info';
  }
}

/**
 * Returns a compact label for one Human Attention row kind.
 */
function humanAttentionKindLabel(kind: HumanAttentionRow['kind']): string {
  return kind.replaceAll('_', ' ');
}

/**
 * Returns a badge class for one Human Attention severity.
 */
function humanAttentionSeverityClass(severity: HumanAttentionRow['severity']): string {
  switch (severity) {
    case 'blocked':
      return 'badge-error';
    case 'risk':
      return 'badge-warning';
    case 'needs_input':
      return 'badge-info';
    case 'info':
      return 'badge-outline';
    default:
      return 'badge-outline';
  }
}

/**
 * Converts one artifact review Action Center action into an app-local decision.
 */
function artifactDecisionForAction(
  kind: HumanAttentionRow['actions'][number]['kind']
): ArtifactReviewDecision | null {
  switch (kind) {
    case 'accept_review':
      return 'accepted';
    case 'request_refinement':
      return 'needs_refinement';
    case 'retry_work':
      return 'redo';
    case 'mark_blocked':
      return 'rejected';
    case 'defer':
      return 'deferred';
    default:
      return null;
  }
}

/**
 * Converts one durable workspace review Action Center action into an app-local decision.
 */
function workspaceSyncReviewDecisionForAction(
  kind: HumanAttentionRow['actions'][number]['kind']
): WorkspaceSyncReviewDecision | null {
  switch (kind) {
    case 'accept_review':
      return 'accepted';
    case 'request_refinement':
      return 'needs_refinement';
    case 'mark_blocked':
      return 'rejected';
    case 'defer':
      return 'blocked';
    default:
      return null;
  }
}

/**
 * Returns whether a workspace resource payload can run agent-backed turns.
 */
function hasEnabledAgent(resources: WorkspaceResources | null): boolean {
  if (!resources) {
    return true;
  }

  return (resources?.agents ?? []).some((agent) => agent.status === 'enabled');
}

/**
 * Resolves the selected composer model from a draft, workspace default, and enabled options.
 */
function resolveComposerModelId(
  draftModelId: string | null,
  workspace: Workspace | WorkspaceSummary | null,
  models: WorkspaceResources['models']
): string | null {
  if (draftModelId && models.some((model) => model.id === draftModelId && model.enabled)) {
    return draftModelId;
  }

  const defaultModelId = workspace?.defaults?.defaultModelId ?? null;
  if (defaultModelId && models.some((model) => model.id === defaultModelId && model.enabled)) {
    return defaultModelId;
  }

  return models.find((model) => model.enabled)?.id ?? null;
}

/**
 * Maps a workspace model selection to the provider model string used by quick chat.
 */
function resolveQuickChatModel(
  modelId: string | null,
  appDiagnostics: AppState['appDiagnostics']
): string | null {
  if (modelId && !modelId.startsWith('model_')) {
    return modelId;
  }

  return appDiagnostics?.defaults.quickChat.model ?? modelId;
}

/**
 * Formats application errors for user-facing alerts.
 */
function formatUserError(error: unknown): string {
  if (error instanceof ApiCallError && error.status === 429) {
    return `${error.message} The provider is rate limited; wait before retrying.`;
  }

  return error instanceof Error ? error.message : 'The request failed.';
}

/**
 * Returns compact item-log detail text for any product-visible item shape.
 */
function itemLogContent(item: Item): string {
  switch (item.type) {
    case 'user-message':
    case 'assistant-message':
      return item.text;
    case 'reasoning':
      return [...item.summary, ...item.content].join('\n');
    case 'command-execution':
      return [item.command, item.cwd, item.output, item.exitCode === null ? null : item.exitCode]
        .filter((value) => value !== null && value !== '')
        .join('\n');
    case 'file-change':
      return `${item.changeKind}: ${item.path}`;
    case 'artifact-reference':
      return [item.title, item.summary].filter(Boolean).join('\n');
    case 'approval-request':
      return `${item.title}\n${item.description}`;
    case 'approval-decision':
      return item.decision;
    case 'user-input-request':
      return item.prompt;
    case 'user-input-response':
      return JSON.stringify(item.answers);
    case 'tool-call':
      return [item.tool, item.error, item.result].filter(Boolean).join('\n');
    case 'agent-handoff':
      return [item.fromAgentId, item.toAgentId, item.reason].filter(Boolean).join('\n');
    case 'status':
      return [item.title, item.summary].filter(Boolean).join('\n');
    case 'plan':
      return [
        item.title,
        item.summary,
        ...item.steps.map((step) => `${step.status}: ${step.title}`),
      ]
        .filter(Boolean)
        .join('\n');
    case 'knowledge-injection':
      return [item.summary, item.policySummary, ...item.knowledgeEntryIds]
        .filter(Boolean)
        .join('\n');
  }
}

/**
 * Returns the active settings navigation class for one category.
 */
function settingsNavItemClass(section: SettingsSection, activeSection: SettingsSection): string {
  return `settings-nav-item ${section === activeSection ? 'settings-nav-item-active' : ''}`;
}

/**
 * Encodes browser text input as base64 for vault rebind requests.
 */
function encodeTextBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return globalThis.btoa(binary);
}

/**
 * Root application component for the workspace protocol demo.
 */
export default function App(props: AppProps) {
  const client = props.client ?? createDefaultClient();
  const turnSubscriptions = new Map<string, () => void>();
  const [state, setState] = createStore<AppState>({
    status: 'idle',
    authRequired: false,
    errorMessage: null,
    meta: null,
    workspaces: [],
    selectedWorkspaceId: null,
    workspace: null,
    workspaceDashboard: null,
    workspaceResources: null,
    threads: [],
    selectedThreadId: null,
    threadDashboard: null,
    threadGoalSummary: null,
    threadGoalPlan: null,
    artifacts: [],
    humanAttention: [],
    appDiagnostics: null,
    setupDiagnostics: null,
    automations: [],
    quickChatResponse: null,
    sessions: {},
    isCreatingWorkspace: false,
    isSavingWorkspace: false,
    isSavingKnowledge: false,
    isCreatingThread: false,
    isStartingTurn: false,
    isRespondingToApproval: false,
    isAuthSubmitting: false,
    inspectMode: readStoredValue(STORAGE_KEYS.inspectMode) === 'protocol' ? 'protocol' : 'product',
  });
  const [newWorkspaceName, setNewWorkspaceName] = createSignal('');
  const [workspaceNameDraft, setWorkspaceNameDraft] = createSignal('');
  const [workspaceStatusDraft, setWorkspaceStatusDraft] =
    createSignal<Workspace['status']>('active');
  const [defaultModelIdDraft, setDefaultModelIdDraft] = createSignal('');
  const [defaultAgentIdDraft, setDefaultAgentIdDraft] = createSignal('');
  const [selectedSkillIds, setSelectedSkillIds] = createSignal<string[]>([]);
  const [appSearchQuery, setAppSearchQuery] = createSignal('');
  const [appSearchResults, setAppSearchResults] = createSignal<AppSearchResult[]>([]);
  const [isSearchingApp, setIsSearchingApp] = createSignal(false);
  const [automationNameDraft, setAutomationNameDraft] = createSignal('');
  const [automationCronDraft, setAutomationCronDraft] = createSignal('');
  const [automationPromptDraft, setAutomationPromptDraft] = createSignal('');
  const [isCreatingAutomation, setIsCreatingAutomation] = createSignal(false);
  const [threadTitleDraft, setThreadTitleDraft] = createSignal('');
  const [activePage, setActivePage] = createSignal<AppPage>('chat');
  const [activeSettingsSection, setActiveSettingsSection] =
    createSignal<SettingsSection>('general');
  const [selectedTheme, setSelectedTheme] = createSignal<AppTheme>(readStoredTheme());
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = createSignal<string[]>([]);
  const [itemLogOpen, setItemLogOpen] = createSignal(false);
  const [interruptingTurnId, setInterruptingTurnId] = createSignal<string | null>(null);
  const [isAnsweringUserInput, setIsAnsweringUserInput] = createSignal(false);
  const [isApprovingGoalPlan, setIsApprovingGoalPlan] = createSignal(false);
  const [isCreatingGoalPlan, setIsCreatingGoalPlan] = createSignal(false);
  const [isStartingGoal, setIsStartingGoal] = createSignal(false);
  const [goalPlanFeedback, setGoalPlanFeedback] = createSignal<string | null>(null);
  const [isRunningGoalStep, setIsRunningGoalStep] = createSignal(false);
  const [goalExecutionFeedback, setGoalExecutionFeedback] = createSignal<string | null>(null);
  const [isRefreshingAgentHealth, setIsRefreshingAgentHealth] = createSignal(false);
  const [terminalCommandDraft, setTerminalCommandDraft] = createSignal('pwd');
  const [isQueueingTerminalCommand, setIsQueueingTerminalCommand] = createSignal(false);
  const [activeHumanAttentionActionId, setActiveHumanAttentionActionId] = createSignal<
    string | null
  >(null);
  const [isUpdatingCodexOAuth, setIsUpdatingCodexOAuth] = createSignal(false);
  const [isReloadingRuntimeConfig, setIsReloadingRuntimeConfig] = createSignal(false);
  const [isRefreshingSetupDiagnostics, setIsRefreshingSetupDiagnostics] = createSignal(false);
  const [runtimeConfigFiles, setRuntimeConfigFiles] = createSignal<RuntimeConfigFileSummary[]>([]);
  const [selectedRuntimeConfigFile, setSelectedRuntimeConfigFile] =
    createSignal<RuntimeConfigFileRead | null>(null);
  const [runtimeConfigDraft, setRuntimeConfigDraft] = createSignal('');
  const [runtimeConfigDiagnostics, setRuntimeConfigDiagnostics] = createSignal<
    RuntimeConfigFileDiagnostic[]
  >([]);
  const [runtimeConfigValidation, setRuntimeConfigValidation] =
    createSignal<RuntimeConfigValidation | null>(null);
  const [runtimeConfigReloadResult, setRuntimeConfigReloadResult] =
    createSignal<RuntimeConfigReload | null>(null);
  const [runtimeConfigSchemas, setRuntimeConfigSchemas] =
    createSignal<RuntimeConfigSchemaCatalog | null>(null);
  const [workspaceRepositories, setWorkspaceRepositories] =
    createSignal<WorkspaceRepositoryList | null>(null);
  const [workspaceRepositoryDiagnostics, setWorkspaceRepositoryDiagnostics] =
    createSignal<WorkspaceRepositoryDiagnostics | null>(null);
  const [workspaceVaultReferences, setWorkspaceVaultReferences] =
    createSignal<WorkspaceVaultReferenceList | null>(null);
  const [repositoryPathDraft, setRepositoryPathDraft] = createSignal('');
  const [selectedVaultReferenceId, setSelectedVaultReferenceId] = createSignal('');
  const [vaultSecretDraft, setVaultSecretDraft] = createSignal('');
  const [repositoryFeedback, setRepositoryFeedback] = createSignal<string | null>(null);
  const [vaultReferenceFeedback, setVaultReferenceFeedback] = createSignal<string | null>(null);
  const [isLoadingWorkspaceRepositories, setIsLoadingWorkspaceRepositories] = createSignal(false);
  const [isSavingWorkspaceRepository, setIsSavingWorkspaceRepository] = createSignal(false);
  const [isRebindingVaultReference, setIsRebindingVaultReference] = createSignal(false);
  const [isLoadingRuntimeConfigFiles, setIsLoadingRuntimeConfigFiles] = createSignal(false);
  const [isSavingRuntimeConfigFile, setIsSavingRuntimeConfigFile] = createSignal(false);
  const [isValidatingRuntimeConfig, setIsValidatingRuntimeConfig] = createSignal(false);
  const [runtimeConfigEditorMode, setRuntimeConfigEditorMode] =
    createSignal<RuntimeConfigReloadInput['mode']>('safe');
  const [artifactDetail, setArtifactDetail] = createSignal<Artifact | null>(null);
  const [serverAuthEnabled, setServerAuthEnabled] = createSignal(false);
  const [authMode, setAuthMode] = createSignal<'sign-in' | 'sign-up'>('sign-in');
  const [authEmail, setAuthEmail] = createSignal('');
  const [authPassword, setAuthPassword] = createSignal('');
  const [authName, setAuthName] = createSignal('OpenKit User');
  const [chatComposerMode, setChatComposerMode] = createSignal<ChatComposerMode>('agent');
  const [threadComposerMode, setThreadComposerMode] = createSignal<ChatComposerMode>('agent');
  const [chatModelId, setChatModelId] = createSignal<string | null>(null);
  const [threadModelId, setThreadModelId] = createSignal<string | null>(null);
  let runtimeConfigValidationTimer: ReturnType<typeof setTimeout> | null = null;
  let runtimeConfigValidationRequestId = 0;
  const codexOAuthPollingTimers = new Map<string, ReturnType<typeof setInterval>>();

  const selectedWorkspace = createMemo(() => state.workspace);
  const activeWorkspaceSummary = createMemo(
    () =>
      (selectedWorkspace()?.id === state.selectedWorkspaceId ? selectedWorkspace() : null) ??
      state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId) ??
      state.workspaces[0] ??
      null
  );
  const selectedWorkspaceResources = createMemo<WorkspaceResources | null>(
    () => state.workspaceResources
  );
  const visibleWorkspaces = createMemo(() =>
    state.workspaces.filter((workspace) => workspace.id !== 'ws_quick_chat')
  );
  const composerModels = createMemo(() => selectedWorkspaceResources()?.models ?? []);
  const quickChatConfigured = createMemo(
    () =>
      !!state.appDiagnostics?.defaults.quickChat.providerId &&
      !!state.appDiagnostics.defaults.quickChat.model
  );
  const selectedChatModelId = createMemo(() =>
    resolveComposerModelId(chatModelId(), activeWorkspaceSummary(), composerModels())
  );
  const selectedThreadModelId = createMemo(() =>
    resolveComposerModelId(threadModelId(), selectedWorkspace(), composerModels())
  );
  const selectedThread = createMemo(
    () => state.threads.find((thread) => thread.id === state.selectedThreadId) ?? null
  );
  const selectedSession = createMemo<ThreadSessionState>(() => {
    if (!state.selectedThreadId) {
      return createEmptyThreadSessionState();
    }

    return state.sessions[state.selectedThreadId] ?? createEmptyThreadSessionState();
  });
  const activeTurn = createMemo<Turn | null>(() => {
    const session = selectedSession();

    if (!session.activeTurnId) {
      return session.turns.at(-1) ?? null;
    }

    return (
      session.turns.find((turn) => turn.id === session.activeTurnId) ?? session.turns.at(-1) ?? null
    );
  });
  const mostRecentCompletedTurn = createMemo<Turn | null>(() => {
    return selectedSession().turns.findLast((turn) => turn.status === 'completed') ?? null;
  });
  const pendingApprovals = createMemo(() =>
    selectedSession().approvals.filter((approval) => approval.status === 'pending')
  );
  const canSaveWorkspace = createMemo(() => {
    const workspace = selectedWorkspace();

    return workspace !== null && workspaceNameDraft().trim().length > 0 && !state.isSavingWorkspace;
  });
  const canCreateThread = createMemo(() => {
    return (
      selectedWorkspace() !== null &&
      threadTitleDraft().trim().length > 0 &&
      !state.isCreatingThread
    );
  });
  const selectedWorkspaceHasEnabledAgent = createMemo(() =>
    hasEnabledAgent(selectedWorkspaceResources())
  );
  const canStartTurn = createMemo(() => {
    const currentTurn = activeTurn();
    const currentStatus = currentTurn?.status;
    const turnIsBusy =
      currentStatus === 'running' ||
      currentStatus === 'awaiting_human' ||
      currentStatus === 'pending';

    return (
      selectedWorkspace() !== null &&
      selectedThread() !== null &&
      selectedWorkspaceHasEnabledAgent() &&
      !state.isStartingTurn &&
      !turnIsBusy
    );
  });
  const activeThreadAgentId = createMemo(
    () =>
      state.threadDashboard?.composer.defaultAgentId ??
      selectedWorkspace()?.defaults?.defaultAgentId ??
      null
  );
  const threadWorkStatus = createMemo(() => state.threadDashboard?.workStatus ?? null);
  const threadWorkMode = createMemo(() =>
    threadComposerMode() === 'quick' ? 'chat' : (threadWorkStatus()?.currentMode ?? 'automation')
  );
  const threadWorkAgentId = createMemo(() =>
    threadComposerMode() === 'quick'
      ? 'quick-chat'
      : (threadWorkStatus()?.selectedAgentId ?? activeThreadAgentId())
  );
  const threadRoutingExplanation = createMemo(() => {
    if (threadComposerMode() === 'quick') {
      return state.quickChatResponse
        ? 'NanoCore routed the last prompt to QuickChatAgent for a lightweight answer without starting a worker turn.'
        : 'NanoCore will route this prompt to QuickChatAgent for a lightweight answer without starting a worker turn.';
    }

    return (
      threadWorkStatus()?.routing.explanation ?? workerRoutingExplanation(activeThreadAgentId())
    );
  });
  const activeThreadAgentHealth = createMemo(() => {
    const agentId = activeThreadAgentId();

    if (!agentId) {
      return null;
    }

    return (
      selectedWorkspaceResources()?.agents.find((agent) => agent.id === agentId)?.health ?? null
    );
  });
  const agentSessionStatus = createMemo(() => {
    return state.threadDashboard?.activeSession?.status ?? 'created';
  });
  const agentSessionId = createMemo(() => state.threadDashboard?.activeSession?.id ?? null);
  const currentRuntimeConfigVersion = createMemo(
    () =>
      state.setupDiagnostics?.runtimeConfig?.currentVersion ??
      state.appDiagnostics?.runtimeConfig?.currentVersion ??
      null
  );

  /**
   * Reconciles workspace-derived form drafts after a workspace load.
   */
  function syncWorkspaceDrafts(workspace: Workspace | null): void {
    setWorkspaceNameDraft(workspace?.name ?? '');
    setWorkspaceStatusDraft(workspace?.status ?? 'active');
    setDefaultModelIdDraft(workspace?.defaults?.defaultModelId ?? '');
    setDefaultAgentIdDraft(workspace?.defaults?.defaultAgentId ?? '');
    setSelectedSkillIds(workspace?.defaults?.defaultSkillIds ?? []);
  }

  /**
   * Selects a workspace and loads its dependent data.
   */
  async function selectWorkspace(workspaceId: string): Promise<void> {
    setState('errorMessage', null);
    setState('quickChatResponse', null);
    writeStoredValue(STORAGE_KEYS.workspaceId, workspaceId);
    writeWorkspaceLocation(workspaceId);
    setState('selectedWorkspaceId', workspaceId);

    try {
      const [
        workspace,
        workspaceResources,
        threadsResponse,
        artifactsResponse,
        workspaceDashboard,
        humanAttention,
      ] = await Promise.all([
        client.core.getWorkspace(workspaceId),
        client.core.getWorkspaceResources(workspaceId),
        client.core.listThreads(workspaceId),
        client.core.listArtifacts(workspaceId),
        client.app.getWorkspaceDashboard(workspaceId),
        client.actionCenter.listHumanAttention(workspaceId),
      ]);
      const nextThreadId = chooseThread(
        threadsResponse.items,
        readStoredValue(STORAGE_KEYS.threadId)
      );

      setState('workspace', workspace);
      setState('workspaceDashboard', workspaceDashboard);
      setState('workspaceResources', workspaceResources);
      setState('threads', threadsResponse.items);
      setState('artifacts', artifactsResponse.items);
      setState('humanAttention', humanAttention.items);
      setState('selectedThreadId', nextThreadId);
      setState('threadDashboard', null);
      setState('threadGoalSummary', null);
      setState('threadGoalPlan', null);
      setArtifactDetail(null);
      syncWorkspaceDrafts(workspace);
      writeStoredValue(STORAGE_KEYS.threadId, nextThreadId);
      setState('status', 'ready');
    } catch (error) {
      setState('status', 'error');
      setState('errorMessage', (error as Error).message);
    }
  }

  /**
   * Reloads workspace summaries and preserves the current selection when possible.
   */
  async function refreshWorkspaces(preferredWorkspaceId?: string): Promise<void> {
    const workspacesResponse = await client.core.listWorkspaces();
    const nextWorkspaceId = chooseWorkspace(
      workspacesResponse.items,
      preferredWorkspaceId ?? state.selectedWorkspaceId
    );

    setState('workspaces', workspacesResponse.items);

    if (nextWorkspaceId) {
      await selectWorkspace(nextWorkspaceId);
    } else {
      setState('workspace', null);
      setState('workspaceDashboard', null);
      setState('workspaceResources', null);
      setState('threads', []);
      setState('artifacts', []);
      setState('humanAttention', []);
      setState('selectedWorkspaceId', null);
      setState('selectedThreadId', null);
      setState('threadDashboard', null);
      setState('threadGoalSummary', null);
      setState('threadGoalPlan', null);
      setArtifactDetail(null);
      syncWorkspaceDrafts(null);
      setState('status', 'ready');
    }
  }

  /**
   * Reloads the unified Human Attention read model for the selected workspace.
   */
  async function refreshHumanAttention(): Promise<void> {
    const workspaceId = state.selectedWorkspaceId;

    if (!workspaceId) {
      setState('humanAttention', []);
      return;
    }

    const response = await client.actionCenter.listHumanAttention(workspaceId);

    setState('humanAttention', response.items);
  }

  /**
   * Opens the most specific product destination for one Human Attention row.
   */
  async function openHumanAttentionRow(row: HumanAttentionRow): Promise<void> {
    if (row.artifactId && row.workspaceId) {
      await openArtifactDetail(row.workspaceId, row.artifactId);
      return;
    }

    if (row.threadId) {
      await openThreadDashboard(row.threadId);
    }
  }

  /**
   * Executes one enabled Human Attention row action.
   */
  async function runHumanAttentionAction(
    row: HumanAttentionRow,
    action: HumanAttentionRow['actions'][number]
  ): Promise<void> {
    if (action.disabled) {
      return;
    }

    setActiveHumanAttentionActionId(`${row.id}:${action.kind}`);
    setState('errorMessage', null);

    try {
      if (
        action.kind === 'open_thread' ||
        action.kind === 'open_turn' ||
        action.kind === 'answer_question' ||
        action.kind === 'review_goal_plan'
      ) {
        await openHumanAttentionRow(row);
        return;
      }

      if (action.kind === 'open_artifact') {
        if (row.artifactId) {
          await openArtifactDetail(row.workspaceId, row.artifactId);
        }
        return;
      }

      if (
        row.source.type === 'approval' &&
        (action.kind === 'grant_approval' || action.kind === 'deny_approval')
      ) {
        await client.core.respondApproval(row.source.approvalRequestId, {
          workspaceId: row.workspaceId,
          threadId: row.source.threadId,
          turnId: row.source.turnId,
          decision: action.kind === 'grant_approval' ? 'granted' : 'denied',
        });
        await refreshHumanAttention();
        return;
      }

      if (action.kind === 'refresh_agent_readiness') {
        await refreshAgentHealth();
        await refreshHumanAttention();
        return;
      }

      if (row.source.type === 'goal_review') {
        let input: Parameters<CoreClient['app']['submitGoalReviewDecision']>[4] | null = null;

        if (action.kind === 'accept_review') {
          input = { verdict: 'accept' };
        } else if (action.kind === 'request_refinement') {
          const revisionInstruction = window.prompt('Describe the required refinement.');
          if (!revisionInstruction?.trim()) {
            return;
          }
          input = { verdict: 'refine', revisionInstruction: revisionInstruction.trim() };
        } else if (action.kind === 'retry_work' || action.kind === 'abort') {
          const reason = window.prompt(
            action.kind === 'retry_work'
              ? 'Why should this work be retried?'
              : 'Why abort this Goal?'
          );
          if (!reason?.trim()) {
            return;
          }
          input = {
            verdict: action.kind === 'retry_work' ? 'retry' : 'abort',
            reason: reason.trim(),
          };
        }

        if (input) {
          await client.app.submitGoalReviewDecision(
            row.source.workspaceId,
            row.source.threadId,
            row.source.goalId,
            row.source.reviewId,
            input
          );
          await Promise.all([
            refreshHumanAttention(),
            row.threadId === state.selectedThreadId
              ? refreshSelectedThreadDashboard()
              : Promise.resolve(),
          ]);
        }
        return;
      }

      const artifactDecision = artifactDecisionForAction(action.kind);

      if (row.source.type === 'artifact' && artifactDecision && row.artifactId) {
        await client.app.submitArtifactReviewDecision(row.workspaceId, row.artifactId, {
          decision: artifactDecision,
        });
        await Promise.all([refreshHumanAttention(), refreshWorkspaceArtifacts(row.workspaceId)]);
        return;
      }

      const workspaceSyncReviewDecision = workspaceSyncReviewDecisionForAction(action.kind);

      if (row.source.type === 'workspace_review' && workspaceSyncReviewDecision) {
        await client.app.submitWorkspaceSyncReviewDecision(row.workspaceId, row.source.reviewId, {
          decision: workspaceSyncReviewDecision,
        });
        await refreshHumanAttention();
        return;
      }

      await openHumanAttentionRow(row);
    } catch (error) {
      setState('errorMessage', formatUserError(error));
    } finally {
      setActiveHumanAttentionActionId(null);
    }
  }

  /**
   * Loads the initial metadata and workspace selection on startup.
   */
  async function initializeApp(): Promise<void> {
    setState('status', 'loading');
    setState('errorMessage', null);

    try {
      const [
        metaResult,
        workspacesResult,
        appDiagnosticsResult,
        setupDiagnosticsResult,
        automationsResult,
      ] = await Promise.allSettled([
        client.core.meta(),
        client.core.listWorkspaces(),
        client.app.getDiagnostics(),
        client.app.getSetupDiagnostics(),
        client.app.listAutomations(),
      ]);

      for (const result of [
        metaResult,
        workspacesResult,
        appDiagnosticsResult,
        setupDiagnosticsResult,
        automationsResult,
      ]) {
        if (result.status === 'rejected' && isUnauthenticatedError(result.reason)) {
          setServerAuthEnabled(true);
          setState('authRequired', true);
          setState('status', 'idle');
          setState('errorMessage', null);
          return;
        }
      }

      if (metaResult.status === 'fulfilled') {
        setState('meta', metaResult.value);
      }

      if (appDiagnosticsResult.status === 'fulfilled') {
        setState('appDiagnostics', appDiagnosticsResult.value);
        updateOpenAICodexOAuthPollingFromDiagnostics(appDiagnosticsResult.value);
      }

      if (setupDiagnosticsResult.status === 'fulfilled') {
        setState('setupDiagnostics', setupDiagnosticsResult.value);
      }

      if (automationsResult.status === 'fulfilled') {
        setState('automations', automationsResult.value.items);
      }

      const startupError = [
        metaResult,
        workspacesResult,
        appDiagnosticsResult,
        setupDiagnosticsResult,
        automationsResult,
      ].find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined;

      if (startupError) {
        setState('errorMessage', (startupError.reason as Error).message);
      }

      if (workspacesResult.status === 'rejected') {
        setState('workspaces', []);
        setState('workspace', null);
        setState('workspaceDashboard', null);
        setState('workspaceResources', null);
        setState('threads', []);
        setState('artifacts', []);
        setState('humanAttention', []);
        setState('selectedWorkspaceId', null);
        setState('selectedThreadId', null);
        setState('threadDashboard', null);
        setState('threadGoalSummary', null);
        setState('threadGoalPlan', null);
        setArtifactDetail(null);
        syncWorkspaceDrafts(null);
        setState('status', 'ready');
        return;
      }

      const route = readWorkspaceRouteFromLocation();
      const preferredWorkspaceId = chooseWorkspace(
        workspacesResult.value.items,
        route.workspaceId ?? readStoredValue(STORAGE_KEYS.workspaceId)
      );

      setState('workspaces', workspacesResult.value.items);

      if (!preferredWorkspaceId) {
        setState('status', 'ready');
        return;
      }

      await selectWorkspace(preferredWorkspaceId);

      if (route.threadId) {
        await openThreadDashboard(route.threadId);
      } else if (route.artifactId) {
        await openArtifactDetail(preferredWorkspaceId, route.artifactId);
      }
    } catch (error) {
      setState('status', 'error');
      setState('errorMessage', (error as Error).message);
    }
  }

  /**
   * Returns whether an error represents a server-mode authentication challenge.
   */
  function isUnauthenticatedError(error: unknown): boolean {
    return error instanceof ApiCallError && error.status === 401;
  }

  /**
   * Clears user-scoped app state after sign-out.
   */
  function resetAuthenticatedState(): void {
    setState('workspaces', []);
    setState('selectedWorkspaceId', null);
    setState('workspace', null);
    setState('workspaceDashboard', null);
    setState('workspaceResources', null);
    setState('threads', []);
    setState('selectedThreadId', null);
    setState('threadDashboard', null);
    setState('threadGoalSummary', null);
    setState('threadGoalPlan', null);
    setState('artifacts', []);
    setState('humanAttention', []);
    setState('automations', []);
    setState('sessions', {});
    setArtifactDetail(null);
  }

  /**
   * Submits the current email/password auth form.
   */
  async function submitAuth(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setState('isAuthSubmitting', true);
    setState('errorMessage', null);

    try {
      if (authMode() === 'sign-up') {
        await client.auth.email.signUp({
          email: authEmail().trim(),
          name: authName().trim(),
          password: authPassword(),
        });
      } else {
        await client.auth.email.signIn({
          email: authEmail().trim(),
          password: authPassword(),
        });
      }

      setServerAuthEnabled(true);
      setState('authRequired', false);
      await initializeApp();
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    } finally {
      setState('isAuthSubmitting', false);
    }
  }

  /**
   * Signs out of server mode and returns to the auth form.
   */
  async function signOut(): Promise<void> {
    setState('errorMessage', null);

    try {
      await client.auth.email.signOut();
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    } finally {
      resetAuthenticatedState();
      setServerAuthEnabled(true);
      setAuthMode('sign-in');
      setState('authRequired', true);
      setState('status', 'idle');
    }
  }

  /**
   * Updates one thread session in the global store.
   */
  function mutateThreadSession(
    threadId: string,
    updater: (session: ThreadSessionState) => ThreadSessionState
  ): void {
    setState('sessions', (sessions) => updateThreadSession(sessions, threadId, updater));
  }

  /**
   * Stores the selected thread in memory and local storage.
   */
  function selectThread(threadId: string | null): void {
    setState('selectedThreadId', threadId);
    writeStoredValue(STORAGE_KEYS.threadId, threadId);
  }

  /**
   * Opens the selected workspace dashboard from the sidebar.
   */
  async function openWorkspaceDashboard(workspaceId: string): Promise<void> {
    setItemLogOpen(false);
    setArtifactDetail(null);
    selectAppPage('workspace');
    await selectWorkspace(workspaceId);
  }

  /**
   * Opens one thread dashboard from the nested workspace list.
   */
  async function openThreadDashboard(threadId: string): Promise<void> {
    const thread = state.threads.find((candidate) => candidate.id === threadId);

    if (!thread) {
      return;
    }

    if (thread.workspaceId !== state.selectedWorkspaceId) {
      await selectWorkspace(thread.workspaceId);
    }

    setState('errorMessage', null);
    setArtifactDetail(null);
    selectThread(threadId);
    writeWorkspaceLocation(thread.workspaceId, threadId);

    try {
      const [threadDashboard, threadItems, threadGoalSummary] = await Promise.all([
        client.app.getThreadDashboard(thread.workspaceId, threadId),
        client.core.listThreadItems(thread.workspaceId, threadId),
        client.app.getThreadGoalSummary(thread.workspaceId, threadId),
      ]);

      setState('threadDashboard', threadDashboard);
      setState('threadGoalSummary', threadGoalSummary);
      setState('threadGoalPlan', null);
      setGoalPlanFeedback(null);
      mutateThreadSession(threadId, (session) => ({
        ...session,
        turns: threadDashboard.turns,
        activeTurnId:
          threadDashboard.turns.findLast((turn) => !isTerminalTurnStatus(turn.status))?.id ?? null,
        items: threadItems.items,
      }));
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    }

    setItemLogOpen(false);
    selectAppPage('thread');
  }

  /**
   * Opens one artifact detail view from the selected workspace.
   */
  async function openArtifactDetail(workspaceId: string, artifactId: string): Promise<void> {
    setState('errorMessage', null);

    try {
      const artifact = await client.core.getArtifact(workspaceId, artifactId);
      setState('artifacts', (artifacts) => upsertById(artifacts, artifact));
      setArtifactDetail(artifact);
      writeArtifactLocation(workspaceId, artifactId);
      setItemLogOpen(false);
      selectAppPage('artifact');
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    }
  }

  /**
   * Reloads artifact inventory for one workspace.
   */
  async function refreshWorkspaceArtifacts(workspaceId: string): Promise<void> {
    const response = await client.core.listArtifacts(workspaceId);

    setState('artifacts', response.items);
  }

  /**
   * Toggles whether a workspace shows its nested thread list.
   */
  function toggleWorkspaceThreads(workspaceId: string): void {
    const collapsedIds = collapsedWorkspaceIds();

    if (collapsedIds.includes(workspaceId)) {
      setCollapsedWorkspaceIds(collapsedIds.filter((id) => id !== workspaceId));
      return;
    }

    setCollapsedWorkspaceIds([...collapsedIds, workspaceId]);
  }

  /**
   * Returns whether the workspace thread list is collapsed.
   */
  function workspaceThreadsCollapsed(workspaceId: string): boolean {
    return collapsedWorkspaceIds().includes(workspaceId);
  }

  /**
   * Applies one streamed turn event to the local view model.
   */
  function handleTurnEvent(threadId: string, event: TurnEvent): void {
    mutateThreadSession(threadId, (session) => {
      const nextSession: ThreadSessionState = {
        ...session,
        events: [...session.events, event],
      };

      nextSession.items = reconcileTurnItems(nextSession.items, event);

      if (isApprovalStreamEventData(event.data)) {
        nextSession.approvals = upsertById(nextSession.approvals, event.data.approval);
        return nextSession;
      }

      if (isAgentSessionStreamEventData(event.data)) {
        if (state.selectedThreadId === threadId && state.threadDashboard?.thread.id === threadId) {
          setState('threadDashboard', 'activeSession', event.data.agentSession);
        }

        nextSession.agentSessions = upsertById(nextSession.agentSessions, event.data.agentSession);
        return nextSession;
      }

      if (isArtifactStreamEventData(event.data)) {
        const artifact = event.data.artifact;
        setState('artifacts', (artifacts) => upsertById(artifacts, artifact));
        return nextSession;
      }

      if (isTurnUpdatedStreamEventData(event.data)) {
        nextSession.turns = upsertById(nextSession.turns, event.data.turn);
        nextSession.activeTurnId = isTerminalTurnStatus(event.data.turn.status)
          ? null
          : event.data.turn.id;
        return nextSession;
      }

      if (isTurnCompletedStreamEventData(event.data)) {
        nextSession.turns = upsertById(nextSession.turns, event.data.turn);
        nextSession.activeTurnId = null;
        return nextSession;
      }

      return nextSession;
    });

    if (
      (isTurnCompletedStreamEventData(event.data) ||
        (isTurnUpdatedStreamEventData(event.data) &&
          isTerminalTurnStatus(event.data.turn.status))) &&
      event.turnId
    ) {
      if (interruptingTurnId() === event.turnId) {
        setInterruptingTurnId(null);
      }
      turnSubscriptions.get(event.turnId)?.();
      turnSubscriptions.delete(event.turnId);
    }
  }

  /**
   * Creates a new workspace and switches the app to it.
   */
  async function submitWorkspaceCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const name = newWorkspaceName().trim();

    if (!name) {
      return;
    }

    setState('isCreatingWorkspace', true);
    setState('errorMessage', null);

    try {
      const workspace = await client.core.createWorkspace({ name });
      setNewWorkspaceName('');
      await refreshWorkspaces(workspace.id);
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    } finally {
      setState('isCreatingWorkspace', false);
    }
  }

  /**
   * Saves workspace configuration edits back to the server.
   */
  async function submitWorkspaceUpdate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const workspace = selectedWorkspace();

    if (!workspace) {
      return;
    }

    setState('isSavingWorkspace', true);
    setState('errorMessage', null);

    try {
      const updatedWorkspace = await client.core.updateWorkspace(workspace.id, {
        name: workspaceNameDraft().trim(),
        status: workspaceStatusDraft(),
        defaults: {
          defaultModelId: defaultModelIdDraft() || null,
          defaultAgentId: defaultAgentIdDraft() || null,
          defaultSkillIds: selectedSkillIds(),
        },
      });

      setState('workspace', updatedWorkspace);
      setState('workspaces', (workspaces) =>
        workspaces.map((item) =>
          item.id === updatedWorkspace.id
            ? {
                ...item,
                name: updatedWorkspace.name,
                status: updatedWorkspace.status,
                updatedAt: updatedWorkspace.updatedAt,
              }
            : item
        )
      );
      syncWorkspaceDrafts(updatedWorkspace);
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    } finally {
      setState('isSavingWorkspace', false);
    }
  }

  /**
   * Toggles one workspace skill in the configuration form.
   */
  function toggleSelectedSkill(skillId: string): void {
    const currentSelection = selectedSkillIds();

    if (currentSelection.includes(skillId)) {
      setSelectedSkillIds(currentSelection.filter((id) => id !== skillId));
      return;
    }

    setSelectedSkillIds([...currentSelection, skillId]);
  }

  /**
   * Creates one workspace knowledge entry through the core client.
   */
  async function createKnowledge(input: CreateKnowledgeInput): Promise<void> {
    const workspace = selectedWorkspace();

    if (!workspace) {
      return;
    }

    setState('isSavingKnowledge', true);
    setState('errorMessage', null);

    try {
      const createdEntry = await client.core.createKnowledge(workspace.id, input);

      if (state.workspaceResources) {
        setState('workspaceResources', 'knowledge', (entries) => [...entries, createdEntry]);
      }
    } catch (error) {
      setState('errorMessage', (error as Error).message);
      throw error;
    } finally {
      setState('isSavingKnowledge', false);
    }
  }

  /**
   * Updates one workspace knowledge entry optimistically and reverts on failure.
   */
  async function updateKnowledge(
    knowledgeEntryId: string,
    input: UpdateKnowledgeInput
  ): Promise<void> {
    const workspace = selectedWorkspace();
    const previousEntries = state.workspaceResources?.knowledge ?? [];
    const currentEntry = previousEntries.find((entry) => entry.id === knowledgeEntryId);

    if (!workspace || !currentEntry) {
      return;
    }

    const optimisticEntry = {
      ...currentEntry,
      ...input,
      updatedAt: new Date().toISOString(),
    };

    setState('isSavingKnowledge', true);
    setState('errorMessage', null);
    setState('workspaceResources', 'knowledge', (entries) => upsertById(entries, optimisticEntry));

    try {
      const updatedEntry = await client.core.updateKnowledge(workspace.id, knowledgeEntryId, input);

      setState('workspaceResources', 'knowledge', (entries) => upsertById(entries, updatedEntry));
    } catch (error) {
      setState('workspaceResources', 'knowledge', previousEntries);
      setState('errorMessage', (error as Error).message);
      throw error;
    } finally {
      setState('isSavingKnowledge', false);
    }
  }

  /**
   * Deletes one workspace knowledge entry optimistically and reverts on failure.
   */
  async function deleteKnowledge(knowledgeEntryId: string): Promise<void> {
    const workspace = selectedWorkspace();
    const previousEntries = state.workspaceResources?.knowledge ?? [];

    if (!workspace) {
      return;
    }

    setState('isSavingKnowledge', true);
    setState('errorMessage', null);
    setState('workspaceResources', 'knowledge', (entries) =>
      entries.filter((entry) => entry.id !== knowledgeEntryId)
    );

    try {
      await client.core.deleteKnowledge(workspace.id, knowledgeEntryId);
    } catch (error) {
      setState('workspaceResources', 'knowledge', previousEntries);
      setState('errorMessage', (error as Error).message);
      throw error;
    } finally {
      setState('isSavingKnowledge', false);
    }
  }

  /**
   * Refreshes visible agent health for the selected workspace.
   */
  async function refreshAgentHealth(): Promise<void> {
    const workspace = selectedWorkspace();

    if (!workspace) {
      return;
    }

    setIsRefreshingAgentHealth(true);
    setState('errorMessage', null);

    try {
      const response = await client.agents.refreshHealth(workspace.id);

      if (state.workspaceResources) {
        setState('workspaceResources', 'agents', (agents) =>
          agents.map((agent) => {
            const refreshed = response.items.find((item) => item.agentId === agent.id);

            if (!refreshed) {
              return agent;
            }

            return {
              ...agent,
              health: {
                status: refreshed.status as typeof agent.health.status,
                message: refreshed.message,
                checkedAt: refreshed.checkedAt,
              },
            };
          })
        );
      }

      if (state.workspaceDashboard) {
        setState('workspaceDashboard', 'agentHealth', response.items);
      }

      if (state.threadDashboard?.activeSession) {
        const refreshedSession = response.sessions.find(
          (session) => session.id === state.threadDashboard?.activeSession?.id
        );

        if (refreshedSession) {
          setState('threadDashboard', 'activeSession', refreshedSession);
        }
      }

      await refreshHumanAttention();
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    } finally {
      setIsRefreshingAgentHealth(false);
    }
  }

  /**
   * Queues one terminal command for the active thread-bound agent session.
   *
   * @returns Promise that resolves after the command is queued and the dashboard is refreshed.
   */
  async function queueActiveSessionTerminalCommand(): Promise<void> {
    const workspaceId = state.selectedWorkspaceId;
    const threadId = state.selectedThreadId;
    const activeSession = state.threadDashboard?.activeSession;
    const argv = parseTerminalCommandDraft(terminalCommandDraft());

    if (!workspaceId || !threadId || !activeSession?.backend?.control || argv.length === 0) {
      return;
    }

    setIsQueueingTerminalCommand(true);
    setState('errorMessage', null);

    try {
      await client.app.queueAgentSessionTerminalCommand(workspaceId, threadId, activeSession.id, {
        requestId: `terminal-${Date.now()}`,
        argv,
        cwd: null,
      });
      await openThreadDashboard(threadId);
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    } finally {
      setIsQueueingTerminalCommand(false);
    }
  }

  /**
   * Reloads setup diagnostics for the settings readiness panel.
   */
  async function refreshSetupDiagnostics(): Promise<void> {
    setIsRefreshingSetupDiagnostics(true);
    setState('errorMessage', null);

    try {
      setState('setupDiagnostics', await client.app.getSetupDiagnostics());
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    } finally {
      setIsRefreshingSetupDiagnostics(false);
    }
  }

  /**
   * Loads portable workspace resources for the selected workspace.
   */
  async function loadWorkspaceRepositories(): Promise<void> {
    const workspaceId = state.selectedWorkspaceId;

    if (!workspaceId) {
      return;
    }

    setIsLoadingWorkspaceRepositories(true);
    setRepositoryFeedback(null);
    setVaultReferenceFeedback(null);
    setState('errorMessage', null);

    try {
      const [repositories, diagnostics, vaultReferences] = await Promise.all([
        client.repositories.list(workspaceId),
        client.repositories.diagnostics(workspaceId),
        client.app.listWorkspaceVaultReferences(workspaceId),
      ]);
      setWorkspaceRepositories(repositories);
      setWorkspaceRepositoryDiagnostics(diagnostics);
      setWorkspaceVaultReferences(vaultReferences);
      setSelectedVaultReferenceId(
        vaultReferences.items.find((reference) => reference.status === 'unbound')?.referenceId ?? ''
      );
    } catch (error) {
      const message = (error as Error).message;
      setRepositoryFeedback(message);
      setState('errorMessage', message);
    } finally {
      setIsLoadingWorkspaceRepositories(false);
    }
  }

  /**
   * Rebinds the selected workspace to a local Git repository path.
   *
   * @param event Form submit event from the portability settings panel.
   */
  async function saveWorkspaceRepository(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const workspace = activeWorkspaceSummary();
    const localPath = repositoryPathDraft().trim();

    if (!workspace || !localPath) {
      return;
    }

    setIsSavingWorkspaceRepository(true);
    setRepositoryFeedback(null);
    setState('errorMessage', null);

    try {
      await client.repositories.setDefault(workspace.id, {
        displayName: `${workspace.name} repository`,
        localPath,
      });
      setRepositoryPathDraft('');
      await loadWorkspaceRepositories();
      setRepositoryFeedback('Repository rebound.');
    } catch (error) {
      const message = (error as Error).message;
      setRepositoryFeedback(message);
      setState('errorMessage', message);
    } finally {
      setIsSavingWorkspaceRepository(false);
    }
  }

  /**
   * Rebinds one imported workspace vault reference to local secret material.
   *
   * @param event Form submit event from the portability settings panel.
   */
  async function saveWorkspaceVaultReference(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const workspaceId = state.selectedWorkspaceId;
    const referenceId = selectedVaultReferenceId();
    const material = vaultSecretDraft();

    if (!workspaceId || !referenceId || !material) {
      return;
    }

    setIsRebindingVaultReference(true);
    setVaultReferenceFeedback(null);
    setState('errorMessage', null);

    try {
      await client.app.rebindWorkspaceVaultReference(workspaceId, referenceId, {
        materialBase64: encodeTextBase64(material),
      });
      setVaultSecretDraft('');
      await loadWorkspaceRepositories();
      setVaultReferenceFeedback('Vault reference rebound.');
    } catch (error) {
      const message = (error as Error).message;
      setVaultReferenceFeedback(message);
      setState('errorMessage', message);
    } finally {
      setIsRebindingVaultReference(false);
    }
  }

  /**
   * Applies one Codex ChatGPT login status to existing app diagnostics state.
   *
   * @param status Sanitized Codex OAuth status returned by nanocore.
   */
  function applyOpenAICodexOAuthStatus(status: CodexOAuthStatusPayload): void {
    setState('appDiagnostics', (current) =>
      current
        ? {
            ...current,
            oauth: {
              ...current.oauth,
              openaiCodexAccounts: {
                ...current.oauth.openaiCodexAccounts,
                accounts: current.oauth.openaiCodexAccounts.accounts.map((account) =>
                  account.accountSlotId === status.accountSlotId
                    ? { ...account, ...status }
                    : account
                ),
              },
            },
          }
        : current
    );
  }

  /**
   * Stops one or all Codex ChatGPT login status polling loops.
   */
  function stopOpenAICodexOAuthPolling(accountSlotId?: string): void {
    if (!accountSlotId) {
      for (const timer of codexOAuthPollingTimers.values()) {
        clearInterval(timer);
      }

      codexOAuthPollingTimers.clear();
      return;
    }

    const timer = codexOAuthPollingTimers.get(accountSlotId);

    if (timer) {
      clearInterval(timer);
      codexOAuthPollingTimers.delete(accountSlotId);
    }
  }

  /**
   * Refreshes only the Codex ChatGPT login status.
   */
  async function refreshOpenAICodexOAuthStatus(accountSlotId: string): Promise<void> {
    try {
      const status = await client.oauth.openaiCodex.getAccountStatus(accountSlotId);
      applyOpenAICodexOAuthStatus(status);

      if (status.status !== 'pending') {
        stopOpenAICodexOAuthPolling(status.accountSlotId);
      }
    } catch (error) {
      stopOpenAICodexOAuthPolling(accountSlotId);
      setState('errorMessage', (error as Error).message);
    }
  }

  /**
   * Starts polling while a Codex ChatGPT login remains pending.
   *
   * @param status Latest Codex OAuth status.
   */
  function updateOpenAICodexOAuthPolling(status: CodexOAuthStatusPayload): void {
    const accountSlotId = status.accountSlotId;

    if (status.status !== 'pending') {
      stopOpenAICodexOAuthPolling(accountSlotId);
      return;
    }

    if (codexOAuthPollingTimers.has(accountSlotId)) {
      return;
    }

    codexOAuthPollingTimers.set(
      accountSlotId,
      setInterval(() => {
        void refreshOpenAICodexOAuthStatus(accountSlotId);
      }, 3000)
    );
  }

  /**
   * Starts polling for every pending Codex ChatGPT account in diagnostics.
   *
   * @param appDiagnostics Latest diagnostics payload.
   */
  function updateOpenAICodexOAuthPollingFromDiagnostics(
    appDiagnostics: NonNullable<typeof state.appDiagnostics>
  ): void {
    for (const account of appDiagnostics.oauth.openaiCodexAccounts.accounts) {
      updateOpenAICodexOAuthPolling(account);
    }
  }

  /**
   * Starts a Codex app-server ChatGPT login and refreshes diagnostics.
   *
   * @param mode Browser or device-code login mode.
   */
  async function startOpenAICodexOAuth(
    mode: CodexOAuthLoginMode,
    accountSlotId: string
  ): Promise<void> {
    setIsUpdatingCodexOAuth(true);
    setState('errorMessage', null);

    try {
      const status = await client.oauth.openaiCodex.startAccount(accountSlotId, { mode });
      applyOpenAICodexOAuthStatus(status);
      updateOpenAICodexOAuthPolling(status);

      const appDiagnostics = await client.app.getDiagnostics();
      setState('appDiagnostics', appDiagnostics);
      updateOpenAICodexOAuthPollingFromDiagnostics(appDiagnostics);
    } finally {
      setIsUpdatingCodexOAuth(false);
    }
  }

  /**
   * Cancels a pending Codex app-server ChatGPT login and refreshes diagnostics.
   *
   * @param loginId Optional Codex login identifier returned by start.
   */
  async function cancelOpenAICodexOAuth(
    loginId: string | undefined,
    accountSlotId: string
  ): Promise<void> {
    setIsUpdatingCodexOAuth(true);
    setState('errorMessage', null);

    try {
      stopOpenAICodexOAuthPolling(accountSlotId);
      applyOpenAICodexOAuthStatus(
        await client.oauth.openaiCodex.cancelAccount(accountSlotId, { loginId })
      );
      setState('appDiagnostics', await client.app.getDiagnostics());
    } finally {
      setIsUpdatingCodexOAuth(false);
    }
  }

  /**
   * Logs out the Codex app-server ChatGPT account and refreshes diagnostics.
   */
  async function logoutOpenAICodexOAuth(accountSlotId: string): Promise<void> {
    setIsUpdatingCodexOAuth(true);
    setState('errorMessage', null);

    try {
      stopOpenAICodexOAuthPolling(accountSlotId);
      applyOpenAICodexOAuthStatus(await client.oauth.openaiCodex.logoutAccount(accountSlotId));
      setState('appDiagnostics', await client.app.getDiagnostics());
    } finally {
      setIsUpdatingCodexOAuth(false);
    }
  }

  /**
   * Creates a server-owned Codex ChatGPT account slot.
   *
   * @param input Account creation input.
   */
  async function createOpenAICodexOAuthAccount(input: {
    accountSlotId: string;
    displayName?: string;
  }): Promise<void> {
    setIsUpdatingCodexOAuth(true);
    setState('errorMessage', null);

    try {
      await client.oauth.openaiCodex.createAccount(input);
      setState('appDiagnostics', await client.app.getDiagnostics());
    } finally {
      setIsUpdatingCodexOAuth(false);
    }
  }

  /**
   * Renames a server-owned Codex ChatGPT account slot.
   *
   * @param accountSlotId Account slot id.
   * @param input Account update input.
   */
  async function updateOpenAICodexOAuthAccount(
    accountSlotId: string,
    input: { displayName: string }
  ): Promise<void> {
    setIsUpdatingCodexOAuth(true);
    setState('errorMessage', null);

    try {
      await client.oauth.openaiCodex.updateAccount(accountSlotId, input);
      setState('appDiagnostics', await client.app.getDiagnostics());
    } finally {
      setIsUpdatingCodexOAuth(false);
    }
  }

  /**
   * Deletes a server-owned Codex ChatGPT account slot.
   *
   * @param accountSlotId Account slot id.
   */
  async function deleteOpenAICodexOAuthAccount(accountSlotId: string): Promise<void> {
    setIsUpdatingCodexOAuth(true);
    setState('errorMessage', null);

    try {
      stopOpenAICodexOAuthPolling(accountSlotId);
      await client.oauth.openaiCodex.deleteAccount(accountSlotId);
      setState('appDiagnostics', await client.app.getDiagnostics());
    } finally {
      setIsUpdatingCodexOAuth(false);
    }
  }

  /**
   * Refreshes the selected thread dashboard without changing the active page.
   */
  async function refreshSelectedThreadDashboard(): Promise<void> {
    const threadId = state.selectedThreadId;
    const thread = threadId ? state.threads.find((candidate) => candidate.id === threadId) : null;

    if (!thread) {
      return;
    }

    const [threadDashboard, threadItems, threadGoalSummary] = await Promise.all([
      client.app.getThreadDashboard(thread.workspaceId, thread.id),
      client.core.listThreadItems(thread.workspaceId, thread.id),
      client.app.getThreadGoalSummary(thread.workspaceId, thread.id),
    ]);

    setState('threadDashboard', threadDashboard);
    setState('threadGoalSummary', threadGoalSummary);
    setState('threadGoalPlan', null);
    setGoalPlanFeedback(null);
    mutateThreadSession(thread.id, (session) => ({
      ...session,
      activeTurnId:
        threadDashboard.turns.findLast((turn) => !isTerminalTurnStatus(turn.status))?.id ?? null,
      items: threadItems.items,
      turns: threadDashboard.turns,
    }));
  }

  /**
   * Reloads NanoCore runtime config and refreshes visible diagnostics.
   */
  async function reloadRuntimeConfig(input: RuntimeConfigReloadInput): Promise<void> {
    setIsReloadingRuntimeConfig(true);
    setState('errorMessage', null);

    try {
      const reloadResult = await client.runtimeConfig.reload(input);
      const [appDiagnostics, setupDiagnostics] = await Promise.all([
        client.app.getDiagnostics(),
        client.app.getSetupDiagnostics(),
      ]);

      setRuntimeConfigReloadResult(reloadResult);
      setState('appDiagnostics', appDiagnostics);
      setState('setupDiagnostics', setupDiagnostics);
      await refreshSelectedThreadDashboard();
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    } finally {
      setIsReloadingRuntimeConfig(false);
    }
  }

  /**
   * Clears pending runtime config draft validation.
   */
  function clearRuntimeConfigValidationTimer(): void {
    runtimeConfigValidationRequestId += 1;

    if (!runtimeConfigValidationTimer) {
      return;
    }

    clearTimeout(runtimeConfigValidationTimer);
    runtimeConfigValidationTimer = null;
  }

  /**
   * Checks whether one runtime config validation request still owns the visible editor state.
   */
  function isCurrentRuntimeConfigValidation(requestId: number, fileId: string): boolean {
    return (
      requestId === runtimeConfigValidationRequestId &&
      selectedRuntimeConfigFile()?.file.id === fileId
    );
  }

  /**
   * Loads runtime config file summaries and schema hints.
   */
  async function loadRuntimeConfigFiles(selectId?: string): Promise<void> {
    setIsLoadingRuntimeConfigFiles(true);
    setState('errorMessage', null);

    try {
      const [files, schemas] = await Promise.all([
        client.runtimeConfig.listFiles(),
        client.runtimeConfig.getSchemas(),
      ]);
      setRuntimeConfigFiles(files.files);
      setRuntimeConfigSchemas(schemas);

      const nextId = selectId ?? selectedRuntimeConfigFile()?.file.id ?? files.files[0]?.id ?? null;

      if (nextId) {
        await selectRuntimeConfigFile(nextId);
      }
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    } finally {
      setIsLoadingRuntimeConfigFiles(false);
    }
  }

  /**
   * Selects and reads one runtime config source file.
   */
  async function selectRuntimeConfigFile(id: string): Promise<void> {
    clearRuntimeConfigValidationTimer();
    setIsLoadingRuntimeConfigFiles(true);
    setState('errorMessage', null);

    try {
      const file = await client.runtimeConfig.getFile(id);
      setSelectedRuntimeConfigFile(file);
      setRuntimeConfigDraft(file.content);
      setRuntimeConfigDiagnostics([]);
      setRuntimeConfigValidation(null);
      setRuntimeConfigReloadResult(null);
      await validateRuntimeConfigDraft({ fileId: file.file.id, content: file.content });
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    } finally {
      setIsLoadingRuntimeConfigFiles(false);
    }
  }

  /**
   * Updates the selected runtime config draft and schedules validation.
   */
  function updateRuntimeConfigDraft(content: string): void {
    const selectedFile = selectedRuntimeConfigFile();

    setRuntimeConfigDraft(content);
    setRuntimeConfigReloadResult(null);

    clearRuntimeConfigValidationTimer();

    if (selectedFile) {
      runtimeConfigValidationTimer = setTimeout(() => {
        void validateRuntimeConfigDraft({ fileId: selectedFile.file.id, content });
      }, 800);
    }
  }

  /**
   * Validates the selected runtime config draft through NanoCore.
   */
  async function validateRuntimeConfigDraft(input?: RuntimeConfigValidationDraft): Promise<void> {
    const selectedFile = selectedRuntimeConfigFile();
    const draft =
      input ??
      (selectedFile ? { fileId: selectedFile.file.id, content: runtimeConfigDraft() } : null);

    if (!draft) {
      return;
    }

    setIsValidatingRuntimeConfig(true);
    runtimeConfigValidationRequestId += 1;
    const requestId = runtimeConfigValidationRequestId;

    try {
      const validation = await client.runtimeConfig.validate({
        files: [{ id: draft.fileId, content: draft.content }],
        mode: runtimeConfigEditorMode(),
      });
      if (!isCurrentRuntimeConfigValidation(requestId, draft.fileId)) {
        return;
      }
      setRuntimeConfigValidation(validation);
      setRuntimeConfigDiagnostics(validation.diagnostics);
    } catch (error) {
      if (!isCurrentRuntimeConfigValidation(requestId, draft.fileId)) {
        return;
      }
      setState('errorMessage', (error as Error).message);
    } finally {
      if (isCurrentRuntimeConfigValidation(requestId, draft.fileId)) {
        setIsValidatingRuntimeConfig(false);
      }
    }
  }

  /**
   * Saves the selected runtime config draft with revision protection.
   */
  async function saveRuntimeConfigFile(): Promise<void> {
    const selectedFile = selectedRuntimeConfigFile();

    if (!selectedFile) {
      return;
    }

    clearRuntimeConfigValidationTimer();
    setIsSavingRuntimeConfigFile(true);
    setState('errorMessage', null);

    try {
      const result = await client.runtimeConfig.updateFile({
        id: selectedFile.file.id,
        kind: selectedFile.file.kind,
        content: runtimeConfigDraft(),
        expectedRevision: selectedFile.file.revision,
      });
      const refreshed = await client.runtimeConfig.getFile(result.file.id);
      setSelectedRuntimeConfigFile(refreshed);
      setRuntimeConfigDraft(refreshed.content);
      setRuntimeConfigDiagnostics(result.diagnostics);
      await loadRuntimeConfigFiles(result.file.id);
      const [appDiagnostics, setupDiagnostics] = await Promise.all([
        client.app.getDiagnostics(),
        client.app.getSetupDiagnostics(),
      ]);
      setState('appDiagnostics', appDiagnostics);
      setState('setupDiagnostics', setupDiagnostics);
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    } finally {
      setIsSavingRuntimeConfigFile(false);
    }
  }

  /**
   * Creates a provider, agent, or workspace runtime config file from a server-owned template.
   */
  async function createRuntimeConfigFile(
    kind: 'provider' | 'agent' | 'workspace',
    name: string
  ): Promise<void> {
    const trimmedName = name.trim();
    const id =
      kind === 'workspace'
        ? `workspaces/${trimmedName
            .replace(/^workspaces\//, '')
            .replace(/\/workspace\.jsonc$/, '')}/workspace.jsonc`
        : (() => {
            const suffix = kind === 'provider' ? '.provider.jsonc' : '.agent.jsonc';
            const directory = kind === 'provider' ? 'providers' : 'agents';
            const fileName = trimmedName.endsWith(suffix) ? trimmedName : `${trimmedName}${suffix}`;

            return `${directory}/${fileName}`;
          })();

    setState('errorMessage', null);

    try {
      await client.runtimeConfig.createFile({ id, kind });
      await loadRuntimeConfigFiles(id);
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    }
  }

  /**
   * Discards local runtime config source edits.
   */
  function discardRuntimeConfigDraft(): void {
    const selectedFile = selectedRuntimeConfigFile();

    if (!selectedFile) {
      return;
    }

    clearRuntimeConfigValidationTimer();
    setRuntimeConfigDraft(selectedFile.content);
    setRuntimeConfigDiagnostics([]);
    void validateRuntimeConfigDraft({
      fileId: selectedFile.file.id,
      content: selectedFile.content,
    });
  }

  /**
   * Creates a new thread in a workspace and opens its dashboard route.
   */
  async function createWorkspaceThread(workspaceId: string, title: string): Promise<void> {
    const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);

    if (!workspace || !title.trim()) {
      return;
    }

    if (state.selectedWorkspaceId !== workspaceId) {
      await selectWorkspace(workspaceId);
    }

    setState('isCreatingThread', true);
    setState('errorMessage', null);

    try {
      const thread = await client.core.createThread({ workspaceId, name: title.trim() });

      setState('threads', (threads) => [...threads, thread]);
      setState('workspaces', (workspaces) =>
        workspaces.map((item) =>
          item.id === workspaceId
            ? {
                ...item,
                counts: {
                  ...item.counts,
                  threadCount: item.counts.threadCount + 1,
                },
              }
            : item
        )
      );
      mutateThreadSession(thread.id, (session) => session);
      selectThread(thread.id);
      writeWorkspaceLocation(workspaceId, thread.id);
      await openThreadDashboard(thread.id);
    } catch (error) {
      setState('errorMessage', (error as Error).message);
      throw error;
    } finally {
      setState('isCreatingThread', false);
    }
  }

  /**
   * Creates a new thread in the current workspace and selects it.
   */
  async function submitThreadCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const workspace = selectedWorkspace();
    const title = threadTitleDraft().trim();

    if (!workspace || !title) {
      return;
    }

    try {
      await createWorkspaceThread(workspace.id, title);
      setThreadTitleDraft('');
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    }
  }

  /**
   * Starts a turn for the supplied thread and attaches the live protocol stream.
   */
  async function startTurnForThread(
    workspace: Workspace,
    thread: Thread,
    prompt: string,
    modelId: string | null = null
  ): Promise<Turn> {
    const requestId = createRequestId();
    const turn = await client.core.startTurn({
      workspaceId: workspace.id,
      threadId: thread.id,
      input: prompt,
      requestId,
      ...(modelId ? { modelId } : {}),
    });

    mutateThreadSession(thread.id, (session) => ({
      ...session,
      turns: upsertById(session.turns, turn),
      activeTurnId: turn.id,
    }));

    turnSubscriptions.get(turn.id)?.();
    const iterator = client.core
      .subscribeTurnEvents({
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
      })
      [Symbol.asyncIterator]();
    let stopped = false;
    turnSubscriptions.set(turn.id, () => {
      stopped = true;
      void iterator.return?.();
    });
    void (async () => {
      try {
        while (!stopped) {
          const next = await iterator.next();

          if (next.done) {
            return;
          }

          handleTurnEvent(thread.id, next.value);
        }
      } catch (error) {
        setState('errorMessage', (error as Error).message);
      }
    })();

    return turn;
  }

  /**
   * Selects the homepage composer workspace without leaving the chat surface.
   */
  async function selectComposerWorkspace(workspaceId: string): Promise<void> {
    await selectWorkspace(workspaceId);
    selectAppPage('chat');
  }

  /**
   * Submits the centered chat starter through agent chat or quick chat.
   */
  async function submitChatStarter(
    input: string,
    mode: ChatComposerMode,
    workspaceId: string,
    modelId: string | null
  ): Promise<void> {
    const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;

    if (!workspace || !input) {
      return;
    }

    if (state.selectedWorkspaceId !== workspace.id) {
      await selectComposerWorkspace(workspace.id);
    }

    if (mode === 'agent') {
      if (!selectedWorkspaceHasEnabledAgent()) {
        setState(
          'errorMessage',
          'No enabled agent is configured for this workspace. Open Settings and select an agent before starting an agent-backed chat.'
        );
        return;
      }

      setState('isCreatingThread', true);
      setState('isStartingTurn', true);
      setState('errorMessage', null);

      try {
        const thread = await client.core.createThread({ workspaceId: workspace.id, name: input });

        setState('threads', (threads) => [...threads, thread]);
        setState('workspaces', (workspaces) =>
          workspaces.map((item) =>
            item.id === workspace.id
              ? {
                  ...item,
                  counts: {
                    ...item.counts,
                    threadCount: item.counts.threadCount + 1,
                  },
                }
              : item
          )
        );
        mutateThreadSession(thread.id, (session) => session);
        selectThread(thread.id);
        setState('threadDashboard', {
          thread,
          activeSession: null,
          turns: [],
          artifacts: [],
          workStatus: createIdleThreadWorkStatus(workspace.defaults?.defaultAgentId ?? null),
          composer: {
            disabled: false,
            defaultModelId: workspace.defaults?.defaultModelId ?? null,
            defaultAgentId: workspace.defaults?.defaultAgentId ?? null,
          },
          itemLog: {
            href: `/api/app/workspaces/${workspace.id}/threads/${thread.id}/items`,
          },
        });
        setState('threadGoalSummary', { goal: null });
        setState('threadGoalPlan', null);
        setGoalPlanFeedback(null);
        selectAppPage('thread');
        await startTurnForThread(workspace, thread, input, modelId);
        setThreadTitleDraft('');
      } catch (error) {
        setState('errorMessage', formatUserError(error));
      } finally {
        setState('isCreatingThread', false);
        setState('isStartingTurn', false);
      }
      return;
    }

    setState('isCreatingThread', true);
    setState('errorMessage', null);
    setState('quickChatResponse', null);

    try {
      const quickChatModel = resolveQuickChatModel(modelId, state.appDiagnostics);
      const response = await client.app.quickChat({
        input,
        workspaceId: workspace.id,
        ...(quickChatModel ? { model: quickChatModel } : {}),
      });
      setState('quickChatResponse', response.content);
      setThreadTitleDraft('');
    } catch (error) {
      setState('errorMessage', formatUserError(error));
    } finally {
      setState('isCreatingThread', false);
    }
  }

  /**
   * Searches nanocore app records from the dashboard surface.
   */
  async function submitAppSearch(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const query = appSearchQuery().trim();

    if (!query) {
      setAppSearchResults([]);
      return;
    }

    setIsSearchingApp(true);
    setState('errorMessage', null);

    try {
      const response = await client.app.search(query);
      setAppSearchResults(response.items);
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    } finally {
      setIsSearchingApp(false);
    }
  }

  /**
   * Creates a scheduled automation for the selected workspace.
   */
  async function submitAutomationCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const workspace = activeWorkspaceSummary();
    const name = automationNameDraft().trim();
    const cron = automationCronDraft().trim();
    const prompt = automationPromptDraft().trim();

    if (!workspace || !name || !cron || !prompt) {
      return;
    }

    setIsCreatingAutomation(true);
    setState('errorMessage', null);

    try {
      const automation = await client.app.createAutomation({
        workspaceId: workspace.id,
        name,
        cron,
        prompt,
      });
      setState('automations', (automations) => [...automations, automation]);
      setAutomationNameDraft('');
      setAutomationCronDraft('');
      setAutomationPromptDraft('');
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    } finally {
      setIsCreatingAutomation(false);
    }
  }

  /**
   * Updates the status for one scheduled automation.
   */
  async function updateAutomationStatus(
    automationId: string,
    status: 'paused' | 'enabled'
  ): Promise<void> {
    setState('errorMessage', null);

    try {
      const automation = await client.app.updateAutomation(automationId, { status });

      setState('automations', (automations) => upsertById(automations, automation));
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    }
  }

  /**
   * Deletes one scheduled automation.
   */
  async function deleteAutomation(automationId: string): Promise<void> {
    const previousAutomations = state.automations;

    setState('errorMessage', null);
    setState('automations', (automations) =>
      automations.filter((automation) => automation.id !== automationId)
    );

    try {
      await client.app.deleteAutomation(automationId);
    } catch (error) {
      setState('automations', previousAutomations);
      setState('errorMessage', (error as Error).message);
    }
  }

  /**
   * Starts a new turn and subscribes to its event stream.
   */
  async function submitTurnPrompt(prompt: string, modelId: string | null): Promise<void> {
    const workspace = selectedWorkspace();
    const thread = selectedThread();

    if (!workspace || !thread || !prompt) {
      return;
    }

    if (!selectedWorkspaceHasEnabledAgent()) {
      setState(
        'errorMessage',
        'No enabled agent is configured for this workspace. Open Settings and select an agent before sending a turn.'
      );
      return;
    }

    setState('isStartingTurn', true);
    setState('errorMessage', null);
    setInterruptingTurnId(null);

    try {
      await startTurnForThread(workspace, thread, prompt, modelId);
    } catch (error) {
      setState('errorMessage', formatUserError(error));
    } finally {
      setState('isStartingTurn', false);
    }
  }

  /**
   * Sends a thread-scoped prompt through quick chat without creating an agent turn.
   */
  async function submitThreadQuickChat(prompt: string, modelId: string | null): Promise<void> {
    const workspace = selectedWorkspace();

    if (!workspace || !prompt) {
      return;
    }

    setState('isCreatingThread', true);
    setState('errorMessage', null);
    setState('quickChatResponse', null);

    try {
      const quickChatModel = resolveQuickChatModel(modelId, state.appDiagnostics);
      const response = await client.app.quickChat({
        input: prompt,
        workspaceId: workspace.id,
        ...(quickChatModel ? { model: quickChatModel } : {}),
      });
      setState('quickChatResponse', response.content);
    } catch (error) {
      setState('errorMessage', formatUserError(error));
    } finally {
      setState('isCreatingThread', false);
    }
  }

  /**
   * Starts Goal Mode for the selected thread.
   */
  async function startThreadGoal(objective: string): Promise<void> {
    const workspace = selectedWorkspace();
    const thread = selectedThread();
    const trimmedObjective = objective.trim();

    if (!workspace || !thread || !trimmedObjective) {
      return;
    }

    setIsStartingGoal(true);
    setState('errorMessage', null);

    try {
      const response = await client.app.startThreadGoal(workspace.id, thread.id, {
        objective: trimmedObjective,
      });
      const summary: ThreadGoalSummaryResponse = { goal: response.goal };

      setState('threadGoalSummary', summary);
      setState('threadGoalPlan', null);
      setGoalPlanFeedback(null);
      setGoalExecutionFeedback(null);
    } catch (error) {
      setState('errorMessage', formatUserError(error));
    } finally {
      setIsStartingGoal(false);
    }
  }

  /**
   * Creates a reviewable Goal Mode plan for the selected thread.
   */
  async function createThreadGoalPlan(): Promise<void> {
    const workspace = selectedWorkspace();
    const thread = selectedThread();

    if (!workspace || !thread) {
      return;
    }

    setIsCreatingGoalPlan(true);
    setState('errorMessage', null);
    setGoalPlanFeedback(null);

    try {
      const response = await client.app.createThreadGoalPlan(workspace.id, thread.id, {
        requestId: createRequestId(),
      });

      setState('threadGoalPlan', response);
      setState('threadGoalSummary', { goal: response.goal });
      setGoalExecutionFeedback(null);
    } catch (error) {
      setState('errorMessage', formatUserError(error));
    } finally {
      setIsCreatingGoalPlan(false);
    }
  }

  /**
   * Approves the current Goal Mode plan without starting a worker turn.
   */
  async function approveThreadGoalPlan(): Promise<void> {
    const workspace = selectedWorkspace();
    const thread = selectedThread();
    const planReview = state.threadGoalPlan;

    if (!workspace || !thread || !planReview) {
      return;
    }

    setIsApprovingGoalPlan(true);
    setState('errorMessage', null);
    setGoalPlanFeedback(null);

    try {
      const response = await client.app.approveThreadGoalPlan(workspace.id, thread.id, {
        requestId: createRequestId(),
        planItemId: planReview.planItemId,
      });

      setState('threadGoalSummary', { goal: response.goal });
      setState('threadGoalPlan', null);
      setGoalPlanFeedback('Plan approved. Tasks are ready for supervised work.');
      setGoalExecutionFeedback(null);
    } catch (error) {
      setState('errorMessage', formatUserError(error));
    } finally {
      setIsApprovingGoalPlan(false);
    }
  }

  /**
   * Persists one Goal Mode plan revision through NanoCore.
   */
  async function reviseThreadGoalPlan(revision: string): Promise<void> {
    const workspace = selectedWorkspace();
    const thread = selectedThread();

    if (!workspace || !thread || !state.threadGoalPlan) {
      return;
    }

    setIsApprovingGoalPlan(true);
    setState('errorMessage', null);
    setGoalPlanFeedback(null);

    try {
      const response = await client.app.reviseThreadGoalPlan(workspace.id, thread.id, {
        requestId: createRequestId(),
        revision,
      });

      setState('threadGoalSummary', { goal: response.goal });
      setState('threadGoalPlan', null);
      setGoalPlanFeedback('Plan revision recorded. Draft a new plan when ready.');
      setGoalExecutionFeedback(null);
    } catch (error) {
      setState('errorMessage', formatUserError(error));
    } finally {
      setIsApprovingGoalPlan(false);
    }
  }

  /**
   * Records plan rejection as a request for a replacement plan.
   */
  function rejectThreadGoalPlan(): void {
    void reviseThreadGoalPlan('Reject this plan and draft a new plan.');
  }

  /**
   * Runs one real bounded Goal Mode worker step for the selected thread.
   */
  async function runThreadGoalStep(): Promise<void> {
    const workspace = selectedWorkspace();
    const thread = selectedThread();

    if (!workspace || !thread || isRunningGoalStep()) {
      return;
    }

    setIsRunningGoalStep(true);
    setState('errorMessage', null);
    setGoalExecutionFeedback(null);

    try {
      const response = await client.app.runThreadGoalStep(workspace.id, thread.id);

      setState('threadGoalSummary', { goal: response.goal });
      setGoalExecutionFeedback(
        response.goal.pendingHumanAttention.reason ??
          `Worker step ended with ${response.result.outcome}.`
      );
    } catch (error) {
      setState('errorMessage', formatUserError(error));
    } finally {
      setIsRunningGoalStep(false);
    }
  }

  /**
   * Interrupts the active running turn.
   */
  async function interruptTurn(): Promise<void> {
    const workspace = selectedWorkspace();
    const thread = selectedThread();
    const turn = activeTurn();

    if (!workspace || !thread || !turn) {
      return;
    }

    setState('errorMessage', null);
    setInterruptingTurnId(turn.id);

    try {
      await client.core.interruptTurn({
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        requestId: createRequestId(),
      });
    } catch (error) {
      setInterruptingTurnId(null);
      setState('errorMessage', (error as Error).message);
    }
  }

  /**
   * Sends an approval decision for the selected pending request.
   */
  async function submitApprovalDecision(
    approval: ApprovalResponseTarget,
    decision: ApprovalDecision
  ): Promise<void> {
    setState('isRespondingToApproval', true);
    setState('errorMessage', null);

    try {
      await client.core.respondApproval(approval.approvalRequestId, {
        workspaceId: approval.workspaceId,
        threadId: approval.threadId,
        turnId: approval.turnId,
        decision,
        requestId: createRequestId(),
      });
      await refreshHumanAttention();
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    } finally {
      setState('isRespondingToApproval', false);
    }
  }

  /**
   * Sends one inline agent-question answer to the active turn.
   */
  async function submitUserInputAnswer(
    item: UserInputResponseTarget,
    answer: string
  ): Promise<void> {
    setIsAnsweringUserInput(true);
    setState('errorMessage', null);

    try {
      await client.core.startTurn({
        workspaceId: item.workspaceId,
        threadId: item.threadId,
        turnId: item.turnId,
        input: answer,
        requestId: createRequestId(),
      });
      await refreshHumanAttention();
    } catch (error) {
      setState('errorMessage', (error as Error).message);
    } finally {
      setIsAnsweringUserInput(false);
    }
  }

  /**
   * Stores dogfooding feedback for one completed turn.
   */
  async function submitTurnFeedback(turnId: string, input: TurnFeedbackInput): Promise<void> {
    setState('errorMessage', null);
    await client.app.submitTurnFeedback(turnId, input);
  }

  /**
   * Switches the diagnostics panel between product and protocol modes.
   */
  function setInspectMode(mode: AppState['inspectMode']): void {
    setState('inspectMode', mode);
    writeStoredValue(STORAGE_KEYS.inspectMode, mode);
  }

  /**
   * Switches the active product page in the primary sidebar.
   */
  function selectAppPage(page: AppPage): void {
    setActivePage(page);
  }

  /**
   * Applies a daisyUI theme and persists the user's preference locally.
   */
  function selectTheme(theme: AppTheme): void {
    setSelectedTheme(theme);
    writeStoredValue(STORAGE_KEYS.theme, theme);
  }

  onMount(() => {
    void initializeApp();
  });

  onCleanup(() => {
    clearRuntimeConfigValidationTimer();
    stopOpenAICodexOAuthPolling();
  });

  return (
    <div
      class="command-shell min-h-screen text-base-content"
      data-testid="app-root"
      data-theme={selectedTheme()}
    >
      <div class="app-frame app-frame-edge flex min-h-screen flex-col" data-testid="app-frame">
        <Show when={state.errorMessage}>
          <div role="alert" class="alert alert-error shadow-lg">
            <span>{state.errorMessage}</span>
          </div>
        </Show>

        <Show when={state.authRequired}>
          <main class="flex min-h-screen items-center justify-center p-6">
            <section aria-label="Authentication" class="workspace-panel w-full max-w-md">
              <div class="main-panel-head main-panel-head-stacked">
                <div class="space-y-2">
                  <p class="eyebrow">Server Mode</p>
                  <h1 class="font-display text-2xl font-semibold text-base-content">
                    {authMode() === 'sign-up' ? 'Create account' : 'Sign in'}
                  </h1>
                </div>
              </div>
              <form class="mt-4 grid gap-3" onSubmit={(event) => void submitAuth(event)}>
                <label class="form-control ui-field">
                  <span class="label-text">Email</span>
                  <input
                    autocomplete="email"
                    class="input input-bordered"
                    name="email"
                    onInput={(event) => setAuthEmail(event.currentTarget.value)}
                    type="email"
                    value={authEmail()}
                  />
                </label>
                <Show when={authMode() === 'sign-up'}>
                  <label class="form-control ui-field">
                    <span class="label-text">Name</span>
                    <input
                      autocomplete="name"
                      class="input input-bordered"
                      name="name"
                      onInput={(event) => setAuthName(event.currentTarget.value)}
                      value={authName()}
                    />
                  </label>
                </Show>
                <label class="form-control ui-field">
                  <span class="label-text">Password</span>
                  <input
                    autocomplete={authMode() === 'sign-up' ? 'new-password' : 'current-password'}
                    class="input input-bordered"
                    name="password"
                    onInput={(event) => setAuthPassword(event.currentTarget.value)}
                    type="password"
                    value={authPassword()}
                  />
                </label>
                <button class="btn btn-neutral" disabled={state.isAuthSubmitting} type="submit">
                  {authMode() === 'sign-up' ? 'Create account' : 'Sign in'}
                </button>
              </form>
              <button
                class="btn btn-ghost mt-3 w-full"
                onClick={() => setAuthMode(authMode() === 'sign-up' ? 'sign-in' : 'sign-up')}
                type="button"
              >
                {authMode() === 'sign-up' ? 'Use existing account' : 'Create an account'}
              </button>
            </section>
          </main>
        </Show>
        <main
          class={`app-shell-two-column app-shell-soft ${itemLogOpen() ? 'app-shell-with-log' : ''}`}
          data-testid="workbench-shell"
          hidden={state.authRequired}
        >
          <aside
            aria-label="Primary workspace navigation"
            class="primary-sidebar primary-sidebar-sticky primary-sidebar-compact primary-sidebar-scroll-safe surface-separated-column"
          >
            <Switch>
              <Match when={activePage() === 'settings'}>
                <div class="sidebar-section primary-brand-section">
                  <button
                    aria-label="Back to app"
                    class="btn btn-ghost sidebar-command"
                    onClick={() => selectAppPage('chat')}
                    title="Back to app"
                    type="button"
                  >
                    <RemixIcon icon="ri:arrow-left-line" />
                    <span>Back to app</span>
                  </button>
                </div>

                <nav
                  aria-label="Settings sections"
                  class="settings-sidebar settings-sidebar-primary"
                >
                  <button
                    aria-current={activeSettingsSection() === 'general' ? 'page' : undefined}
                    class={settingsNavItemClass('general', activeSettingsSection())}
                    onClick={() => setActiveSettingsSection('general')}
                    type="button"
                  >
                    <RemixIcon icon="ri:settings-3-line" />
                    <span>General</span>
                  </button>
                  <button
                    aria-current={activeSettingsSection() === 'appearance' ? 'page' : undefined}
                    class={settingsNavItemClass('appearance', activeSettingsSection())}
                    onClick={() => setActiveSettingsSection('appearance')}
                    type="button"
                  >
                    <RemixIcon icon="ri:sun-line" />
                    <span>Appearance</span>
                  </button>
                  <button
                    aria-current={activeSettingsSection() === 'configuration' ? 'page' : undefined}
                    class={settingsNavItemClass('configuration', activeSettingsSection())}
                    onClick={() => setActiveSettingsSection('configuration')}
                    type="button"
                  >
                    <RemixIcon icon="ri:shield-user-line" />
                    <span>Configuration</span>
                  </button>
                  <button
                    aria-current={activeSettingsSection() === 'runtime-config' ? 'page' : undefined}
                    class={settingsNavItemClass('runtime-config', activeSettingsSection())}
                    onClick={() => {
                      setActiveSettingsSection('runtime-config');
                      void loadRuntimeConfigFiles();
                    }}
                    type="button"
                  >
                    <RemixIcon icon="ri:file-code-line" />
                    <span>Runtime config</span>
                  </button>
                  <button
                    aria-current={activeSettingsSection() === 'knowledge' ? 'page' : undefined}
                    class={settingsNavItemClass('knowledge', activeSettingsSection())}
                    onClick={() => setActiveSettingsSection('knowledge')}
                    type="button"
                  >
                    <RemixIcon icon="ri:brain-line" />
                    <span>Knowledge</span>
                  </button>
                  <button
                    aria-current={activeSettingsSection() === 'portability' ? 'page' : undefined}
                    class={settingsNavItemClass('portability', activeSettingsSection())}
                    onClick={() => {
                      setActiveSettingsSection('portability');
                      void loadWorkspaceRepositories();
                    }}
                    type="button"
                  >
                    <RemixIcon icon="ri:folder-transfer-line" />
                    <span>Portability</span>
                  </button>
                  <button
                    aria-current={activeSettingsSection() === 'diagnostics' ? 'page' : undefined}
                    class={settingsNavItemClass('diagnostics', activeSettingsSection())}
                    onClick={() => setActiveSettingsSection('diagnostics')}
                    type="button"
                  >
                    <RemixIcon icon="ri:pulse-line" />
                    <span>Diagnostics</span>
                  </button>
                </nav>
              </Match>

              <Match when={activePage() !== 'settings'}>
                <div class="sidebar-section primary-brand-section">
                  <div class="sidebar-app-title">
                    <span class="font-display text-lg font-semibold text-primary">OpenKit</span>
                  </div>
                  <nav aria-label="Workspace shortcuts" class="workspace-shortcuts">
                    <button
                      class="btn btn-ghost sidebar-command"
                      onClick={() => selectAppPage('chat')}
                      type="button"
                    >
                      <RemixIcon icon="ri:chat-1-line" />
                      <span>Chat</span>
                    </button>
                    <button
                      class="btn btn-ghost sidebar-command"
                      onClick={() => selectAppPage('dashboard')}
                      type="button"
                    >
                      <RemixIcon icon="ri:dashboard-3-line" />
                      <span>Dashboard</span>
                    </button>
                    <button
                      class="btn btn-ghost sidebar-command"
                      onClick={() => {
                        selectAppPage('action-center');
                        void refreshHumanAttention();
                      }}
                      type="button"
                    >
                      <RemixIcon icon="ri:notification-3-line" />
                      <span>Action Center</span>
                      <Show when={state.humanAttention.length > 0}>
                        <span class="badge badge-sm badge-info">{state.humanAttention.length}</span>
                      </Show>
                    </button>
                    <button
                      class="btn btn-ghost sidebar-command"
                      onClick={() => selectAppPage('automation')}
                      type="button"
                    >
                      <RemixIcon icon="ri:calendar-schedule-line" />
                      <span>Automations</span>
                    </button>
                    <button
                      class="btn btn-ghost sidebar-command"
                      onClick={() => selectAppPage('new-workspace')}
                      type="button"
                    >
                      <RemixIcon icon="ri:add-box-line" />
                      <span>New workspace</span>
                    </button>
                  </nav>
                </div>

                <div class="sidebar-section sidebar-workspace-section">
                  <div class="ui-section-header mb-4 flex flex-wrap items-center justify-between gap-3">
                    <h2 class="font-display text-lg font-semibold text-base-content">Workspaces</h2>
                    <span class="badge badge-outline">{state.workspaces.length}</span>
                  </div>

                  <div class="space-y-2">
                    <For each={state.workspaces}>
                      {(workspace) => (
                        <ThreadList
                          collapsed={
                            workspace.id !== state.selectedWorkspaceId ||
                            workspaceThreadsCollapsed(workspace.id)
                          }
                          isCreating={state.isCreatingThread}
                          selectedThreadId={state.selectedThreadId}
                          selectedWorkspaceId={state.selectedWorkspaceId}
                          showCreateForm={activePage() !== 'thread'}
                          threads={state.threads.filter(
                            (thread) => thread.workspaceId === workspace.id
                          )}
                          workspace={workspace}
                          onCreateThread={createWorkspaceThread}
                          onOpenThread={(threadId) => void openThreadDashboard(threadId)}
                          onOpenWorkspace={(workspaceId) =>
                            void openWorkspaceDashboard(workspaceId)
                          }
                          onToggle={toggleWorkspaceThreads}
                        />
                      )}
                    </For>
                  </div>
                </div>

                <footer class="sidebar-settings-footer">
                  <button
                    class="btn btn-ghost sidebar-command sidebar-settings-command"
                    onClick={() => selectAppPage('settings')}
                    type="button"
                  >
                    <RemixIcon icon="ri:settings-3-line" />
                    <span>Settings</span>
                  </button>
                  <Show when={serverAuthEnabled()}>
                    <button
                      class="btn btn-ghost sidebar-command sidebar-settings-command"
                      onClick={() => void signOut()}
                      type="button"
                    >
                      <RemixIcon icon="ri:logout-box-r-line" />
                      <span>Sign out</span>
                    </button>
                  </Show>
                </footer>
              </Match>
            </Switch>
          </aside>

          <section
            aria-label="Conversation workspace"
            class={`conversation-workspace main-workspace-centered main-workspace-full-rail surface-separated-column ${
              activePage() === 'settings' ? 'settings-main-single-column' : ''
            }`}
          >
            <Switch>
              <Match when={activePage() === 'dashboard'}>
                <div class="workspace-panel">
                  <div class="main-panel-head main-panel-head-stacked">
                    <div class="space-y-2">
                      <p class="eyebrow">Dashboard</p>
                      <h2 class="font-display text-2xl font-semibold text-base-content">
                        Workspace Status
                      </h2>
                    </div>
                  </div>
                  <div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div class="metric-tile">
                      <span class="metric-label">Workspaces</span>
                      <span class="metric-value">{state.workspaces.length}</span>
                    </div>
                    <div class="metric-tile">
                      <span class="metric-label">Threads</span>
                      <span class="metric-value">{state.threads.length}</span>
                    </div>
                    <div class="metric-tile">
                      <span class="metric-label">Artifacts</span>
                      <span class="metric-value">{state.artifacts.length}</span>
                    </div>
                    <div class="metric-tile">
                      <span class="metric-label">Status</span>
                      <span class="metric-value">{state.status}</span>
                    </div>
                  </div>
                  <search aria-label="Search app records" class="mt-4 block">
                    <form
                      class="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]"
                      onSubmit={(event) => void submitAppSearch(event)}
                    >
                      <label class="sr-only" for="app-record-search">
                        Search app records
                      </label>
                      <input
                        id="app-record-search"
                        class="input input-bordered w-full"
                        name="appSearch"
                        onInput={(event) => setAppSearchQuery(event.currentTarget.value)}
                        placeholder="Search workspaces, threads, knowledge, artifacts, and items"
                        type="search"
                        value={appSearchQuery()}
                      />
                      <button class="btn btn-neutral" disabled={isSearchingApp()} type="submit">
                        Search
                      </button>
                    </form>
                  </search>
                  <Show when={appSearchResults().length > 0}>
                    <div class="mt-4 space-y-2">
                      <For each={appSearchResults()}>
                        {(result) => (
                          <article class="artifact-row">
                            <div>
                              <p class="text-xs uppercase tracking-[0.18em] opacity-60">
                                {result.kind}
                              </p>
                              <h3 class="font-semibold">{result.title}</h3>
                            </div>
                            <span class="badge badge-outline">{result.id}</span>
                          </article>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Match>

              <Match when={activePage() === 'action-center'}>
                <div class="workspace-panel">
                  <div class="main-panel-head main-panel-head-stacked">
                    <div class="space-y-2">
                      <p class="eyebrow">Action Center</p>
                      <h2 class="font-display text-2xl font-semibold text-base-content">
                        Human Attention
                      </h2>
                      <p class="max-w-2xl text-sm leading-7 opacity-70">
                        Workspace-level approvals, questions, recovery rows, review decisions, and
                        blocked runtime states.
                      </p>
                    </div>
                    <button
                      class="btn btn-outline btn-sm"
                      onClick={() => void refreshHumanAttention()}
                      type="button"
                    >
                      <RemixIcon icon="ri:refresh-line" />
                      <span>Refresh</span>
                    </button>
                  </div>

                  <div class="mt-4 grid gap-3 md:grid-cols-4">
                    <div class="metric-tile">
                      <span class="metric-label">Total</span>
                      <span class="metric-value">{state.humanAttention.length}</span>
                    </div>
                    <div class="metric-tile">
                      <span class="metric-label">Needs input</span>
                      <span class="metric-value">
                        {
                          state.humanAttention.filter((row) => row.severity === 'needs_input')
                            .length
                        }
                      </span>
                    </div>
                    <div class="metric-tile">
                      <span class="metric-label">Blocked</span>
                      <span class="metric-value">
                        {state.humanAttention.filter((row) => row.severity === 'blocked').length}
                      </span>
                    </div>
                    <div class="metric-tile">
                      <span class="metric-label">Risk</span>
                      <span class="metric-value">
                        {state.humanAttention.filter((row) => row.severity === 'risk').length}
                      </span>
                    </div>
                  </div>

                  <div class="mt-4 space-y-3">
                    <Show
                      when={state.humanAttention.length > 0}
                      fallback={<div class="empty-state">No workspace attention is pending.</div>}
                    >
                      <For each={state.humanAttention}>
                        {(row) => (
                          <article class="artifact-row">
                            <div class="min-w-0 space-y-2">
                              <div class="flex flex-wrap items-center gap-2">
                                <span class={`badge ${humanAttentionSeverityClass(row.severity)}`}>
                                  {row.severity.replaceAll('_', ' ')}
                                </span>
                                <span class="badge badge-outline">
                                  {humanAttentionKindLabel(row.kind)}
                                </span>
                                <span class="text-xs opacity-60">
                                  {formatTimestamp(row.createdAt)}
                                </span>
                              </div>
                              <div>
                                <h3 class="font-semibold">{row.title}</h3>
                                <p class="text-sm opacity-70">{row.summary}</p>
                                <Show when={row.recommendedAction}>
                                  <p class="text-xs opacity-60">{row.recommendedAction}</p>
                                </Show>
                              </div>
                            </div>
                            <div class="flex flex-wrap justify-end gap-2">
                              <For each={row.actions}>
                                {(action) => (
                                  <button
                                    class="btn btn-outline btn-xs"
                                    disabled={
                                      action.disabled ||
                                      activeHumanAttentionActionId() === `${row.id}:${action.kind}`
                                    }
                                    onClick={() => void runHumanAttentionAction(row, action)}
                                    title={action.reason}
                                    type="button"
                                  >
                                    {action.label}
                                  </button>
                                )}
                              </For>
                            </div>
                          </article>
                        )}
                      </For>
                    </Show>
                  </div>
                </div>
              </Match>

              <Match when={activePage() === 'automation'}>
                <div class="workspace-panel">
                  <div class="main-panel-head main-panel-head-stacked">
                    <div class="space-y-2">
                      <p class="eyebrow">Automations</p>
                      <h2 class="font-display text-2xl font-semibold text-base-content">
                        Scheduled Work
                      </h2>
                      <p class="max-w-2xl text-sm leading-7 opacity-70">
                        Cron jobs and scheduled workspace runs from nanocore.
                      </p>
                    </div>
                  </div>
                  <form
                    class="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,1.4fr)_auto]"
                    onSubmit={(event) => void submitAutomationCreate(event)}
                  >
                    <label class="form-control ui-field">
                      <span class="label-text">Automation name</span>
                      <input
                        class="input input-bordered"
                        name="automationName"
                        onInput={(event) => setAutomationNameDraft(event.currentTarget.value)}
                        placeholder="Daily workspace brief"
                        value={automationNameDraft()}
                      />
                    </label>
                    <label class="form-control ui-field">
                      <span class="label-text">Cron schedule</span>
                      <input
                        class="input input-bordered"
                        name="automationCron"
                        onInput={(event) => setAutomationCronDraft(event.currentTarget.value)}
                        placeholder="0 9 * * *"
                        value={automationCronDraft()}
                      />
                    </label>
                    <label class="form-control ui-field">
                      <span class="label-text">Automation prompt</span>
                      <input
                        class="input input-bordered"
                        name="automationPrompt"
                        onInput={(event) => setAutomationPromptDraft(event.currentTarget.value)}
                        placeholder="Summarize current workspace status."
                        value={automationPromptDraft()}
                      />
                    </label>
                    <div class="flex items-end">
                      <button
                        class="btn btn-neutral w-full"
                        disabled={isCreatingAutomation()}
                        type="submit"
                      >
                        Create automation
                      </button>
                    </div>
                  </form>
                  <div class="mt-4 space-y-3">
                    <Show
                      when={state.automations.length > 0}
                      fallback={<div class="empty-state">No automations are configured yet.</div>}
                    >
                      <For each={state.automations}>
                        {(automation) => (
                          <article class="artifact-row">
                            <div>
                              <h3 class="font-semibold">{automation.name}</h3>
                              <p class="text-xs opacity-70">
                                {automation.cron} · {automation.prompt}
                              </p>
                            </div>
                            <div class="flex flex-wrap items-center justify-end gap-2">
                              <span class={`badge ${statusBadgeClass(automation.status)}`}>
                                {automation.status}
                              </span>
                              <button
                                aria-label={`${automation.status === 'enabled' ? 'Pause' : 'Enable'} ${automation.name}`}
                                class="btn btn-outline btn-xs"
                                onClick={() =>
                                  void updateAutomationStatus(
                                    automation.id,
                                    automation.status === 'enabled' ? 'paused' : 'enabled'
                                  )
                                }
                                type="button"
                              >
                                {automation.status === 'enabled' ? 'Pause' : 'Enable'}
                              </button>
                              <button
                                aria-label={`Delete ${automation.name}`}
                                class="btn btn-ghost btn-xs"
                                onClick={() => void deleteAutomation(automation.id)}
                                type="button"
                              >
                                Delete
                              </button>
                            </div>
                          </article>
                        )}
                      </For>
                    </Show>
                  </div>
                </div>
              </Match>

              <Match when={activePage() === 'new-workspace'}>
                <div class="workspace-panel">
                  <div class="main-panel-head main-panel-head-stacked">
                    <div class="space-y-2">
                      <p class="eyebrow">Workspace</p>
                      <h2 class="font-display text-2xl font-semibold text-base-content">
                        New Workspace
                      </h2>
                    </div>
                  </div>
                  <form
                    class="mt-4 grid gap-3"
                    onSubmit={(event) => void submitWorkspaceCreate(event)}
                  >
                    <label class="form-control ui-field">
                      <span class="label-text">New workspace</span>
                      <input
                        class="input input-bordered w-full"
                        name="newWorkspaceName"
                        value={newWorkspaceName()}
                        onInput={(event) => setNewWorkspaceName(event.currentTarget.value)}
                        placeholder="Proto Lab"
                      />
                    </label>
                    <button
                      class="btn btn-neutral w-full md:w-auto"
                      disabled={state.isCreatingWorkspace}
                      type="submit"
                    >
                      Create workspace
                    </button>
                  </form>
                </div>
              </Match>

              <Match when={activePage() === 'workspace'}>
                <WorkspaceDashboard
                  dashboard={state.workspaceDashboard}
                  workspace={selectedWorkspace()}
                />
              </Match>

              <Match when={activePage() === 'chat'}>
                <section aria-label="Chat starter" class="chat-starter chat-starter-centered">
                  <h2 class="chat-starter-title">What should we work on?</h2>
                  <ChatComposer
                    ariaLabel="Chat starter"
                    canSubmit={threadTitleDraft().trim().length > 0 && !state.isCreatingThread}
                    inputLabel="Thread title"
                    isSubmitting={state.isCreatingThread}
                    mode={chatComposerMode()}
                    models={composerModels()}
                    onInput={setThreadTitleDraft}
                    onModeChange={setChatComposerMode}
                    onModelChange={setChatModelId}
                    onSubmit={(input) =>
                      void submitChatStarter(
                        input.input,
                        input.mode,
                        input.workspaceId,
                        input.modelId
                      )
                    }
                    onWorkspaceChange={(workspaceId) => void selectComposerWorkspace(workspaceId)}
                    placeholder="Ask OpenKit anything. @ to use plugins or mention files"
                    quickChatDisabledMessage="Quick chat requires a configured provider and model."
                    quickChatEnabled={quickChatConfigured()}
                    selectedModelId={selectedChatModelId()}
                    selectedWorkspaceId={activeWorkspaceSummary()?.id ?? null}
                    submitLabel="Start thread"
                    value={threadTitleDraft()}
                    workspaceLocked={false}
                    workspaces={visibleWorkspaces()}
                  />
                  <Show
                    when={
                      chatComposerMode() === 'agent' &&
                      selectedWorkspaceResources() !== null &&
                      !selectedWorkspaceHasEnabledAgent()
                    }
                  >
                    <p class="text-sm text-warning">
                      No enabled agent is configured for this workspace. Open Settings and select a
                      agent before starting an agent-backed chat.
                    </p>
                  </Show>
                  <Show when={state.quickChatResponse}>
                    <article class="conversation-item conversation-item-assistant">
                      <span class="badge badge-outline badge-sm">quick-chat</span>
                      <p class="mt-3 whitespace-pre-wrap text-sm leading-7 text-base-content">
                        {state.quickChatResponse}
                      </p>
                    </article>
                  </Show>
                  <div class="chat-starter-suggestions">
                    <For each={CHAT_STARTER_SUGGESTIONS}>
                      {(suggestion) => (
                        <button
                          class="chat-suggestion-row"
                          onClick={() => setThreadTitleDraft(suggestion.title)}
                          type="button"
                        >
                          <RemixIcon icon={suggestion.icon} />
                          <span>{suggestion.title}</span>
                        </button>
                      )}
                    </For>
                  </div>
                </section>
              </Match>

              <Match when={activePage() === 'artifact'}>
                <Show
                  when={artifactDetail()}
                  fallback={
                    <div class="empty-state">Select an artifact to inspect its output.</div>
                  }
                >
                  {(artifact) => (
                    <ArtifactView
                      artifact={artifact()}
                      onBack={() => {
                        const workspace = selectedWorkspace();

                        if (workspace) {
                          writeWorkspaceLocation(workspace.id);
                          selectAppPage('workspace');
                        }
                      }}
                    />
                  )}
                </Show>
              </Match>

              <Match when={activePage() === 'thread'}>
                <div class="workspace-panel">
                  <div class="main-panel-head main-panel-head-stacked">
                    <div class="space-y-2">
                      <p class="text-xs uppercase tracking-[0.2em] opacity-60">
                        {selectedWorkspace()?.name ?? 'No workspace'}
                      </p>
                      <h2 class="font-display text-2xl font-semibold text-base-content">
                        {selectedThread()?.name ?? 'Thread'} Dashboard
                      </h2>
                      <p class="max-w-2xl text-sm leading-7 opacity-70">
                        {selectedThread()?.preview ??
                          'Use the composer to drive the protocol through a real execution path.'}
                      </p>
                    </div>

                    <div class="main-panel-meta">
                      <AgentStatusBadge
                        healthStatus={activeThreadAgentHealth()?.status ?? null}
                        isRefreshing={isRefreshingAgentHealth()}
                        sessionId={agentSessionId()}
                        stale={state.threadDashboard?.activeSession?.stale ?? false}
                        status={agentSessionStatus()}
                        agentId={activeThreadAgentId()}
                        backend={state.threadDashboard?.activeSession?.backend ?? null}
                        configVersion={state.threadDashboard?.activeSession?.configVersion ?? null}
                        currentConfigVersion={currentRuntimeConfigVersion()}
                        terminalCommand={terminalCommandDraft()}
                        isQueueingTerminalCommand={isQueueingTerminalCommand()}
                        onRefresh={refreshAgentHealth}
                        onQueueTerminalCommand={
                          state.threadDashboard?.activeSession?.backend?.control
                            ? queueActiveSessionTerminalCommand
                            : undefined
                        }
                        onTerminalCommandChange={setTerminalCommandDraft}
                      />
                      <span class={`badge ${statusBadgeClass(activeTurn()?.status ?? 'pending')}`}>
                        {formatTurnStatus(activeTurn()?.status)}
                      </span>
                      <span class="badge badge-outline">
                        {formatTimestamp(activeTurn()?.completedAt ?? selectedThread()?.updatedAt)}
                      </span>
                    </div>
                  </div>

                  <form
                    class="mt-6 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]"
                    onSubmit={(event) => void submitThreadCreate(event)}
                  >
                    <label class="form-control ui-field">
                      <span class="label-text">Thread title</span>
                      <input
                        class="input input-bordered"
                        name="threadTitle"
                        value={threadTitleDraft()}
                        onInput={(event) => setThreadTitleDraft(event.currentTarget.value)}
                        placeholder="Approval path validation"
                      />
                    </label>
                    <div class="flex items-end">
                      <button
                        class="btn btn-neutral w-full md:w-auto"
                        disabled={!canCreateThread()}
                        type="submit"
                      >
                        New Thread
                      </button>
                    </div>
                  </form>
                </div>

                <ThreadWorkbench
                  activeTurnStatus={activeTurn()?.status ?? 'idle'}
                  canInterrupt={
                    !!activeTurn() &&
                    !isTerminalTurnStatus(activeTurn()!.status) &&
                    interruptingTurnId() !== activeTurn()?.id
                  }
                  canQuickChat={quickChatConfigured()}
                  canStartTurn={canStartTurn()}
                  composerMode={threadComposerMode()}
                  goal={state.threadGoalSummary?.goal ?? null}
                  goalPlan={state.threadGoalPlan}
                  goalPlanFeedback={goalPlanFeedback()}
                  goalExecutionFeedback={goalExecutionFeedback()}
                  isApprovingGoalPlan={isApprovingGoalPlan()}
                  isAnsweringUserInput={isAnsweringUserInput()}
                  isCreatingGoalPlan={isCreatingGoalPlan()}
                  isInterrupting={interruptingTurnId() === activeTurn()?.id}
                  isRespondingToApproval={state.isRespondingToApproval}
                  isRunningGoalStep={isRunningGoalStep()}
                  isStartingGoal={isStartingGoal()}
                  isStartingTurn={state.isStartingTurn}
                  items={selectedSession().items}
                  currentMode={threadWorkMode()}
                  latestArtifact={threadWorkStatus()?.latestArtifact ?? null}
                  models={composerModels()}
                  pendingApprovalCount={
                    threadWorkStatus()?.pendingApprovalCount ?? pendingApprovals().length
                  }
                  pendingQuestionCount={threadWorkStatus()?.pendingQuestionCount ?? 0}
                  quickChatDisabledMessage="Quick chat requires a configured provider and model."
                  quickChatResponse={state.quickChatResponse}
                  routingExplanation={threadRoutingExplanation()}
                  selectedAgentId={threadWorkAgentId()}
                  selectedModelId={selectedThreadModelId()}
                  selectedWorkspaceId={selectedWorkspace()?.id ?? null}
                  threadArtifacts={state.threadDashboard?.artifacts ?? []}
                  workerConnectionStatus={agentSessionStatus()}
                  workspaceName={selectedWorkspace()?.name ?? 'Current workspace'}
                  onApproveGoalPlan={approveThreadGoalPlan}
                  onCreateGoalPlan={createThreadGoalPlan}
                  onInterrupt={interruptTurn}
                  onModelChange={setThreadModelId}
                  onModeChange={setThreadComposerMode}
                  onOpenActionCenter={() => {
                    selectAppPage('action-center');
                    void refreshHumanAttention();
                  }}
                  onOpenArtifact={(artifactId) => {
                    const workspace = selectedWorkspace();

                    if (workspace) {
                      void openArtifactDetail(workspace.id, artifactId);
                    }
                  }}
                  onOpenItemLog={() => setItemLogOpen(true)}
                  onRejectGoalPlan={rejectThreadGoalPlan}
                  onReviseGoalPlan={reviseThreadGoalPlan}
                  onRunGoalStep={runThreadGoalStep}
                  onStartGoal={startThreadGoal}
                  onSubmitQuickChat={submitThreadQuickChat}
                  onRespondApproval={submitApprovalDecision}
                  onSubmitUserInput={submitUserInputAnswer}
                  onSubmitTurn={submitTurnPrompt}
                />

                <TurnFeedback onSubmit={submitTurnFeedback} turn={mostRecentCompletedTurn()} />

                <div class="workspace-panel">
                  <div class="ui-section-header mb-4 flex flex-wrap items-center justify-between gap-3">
                    <h2 class="font-display text-xl font-semibold text-base-content">Approvals</h2>
                    <span class="badge badge-outline">{pendingApprovals().length} pending</span>
                  </div>

                  <div class="space-y-3">
                    <Show
                      when={selectedSession().approvals.length > 0}
                      fallback={<div class="empty-state">No approvals yet for this thread.</div>}
                    >
                      <For each={selectedSession().approvals}>
                        {(approval) => (
                          <article class="approval-placeholder">
                            <div class="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <h3 class="font-semibold">{approval.title}</h3>
                                <p class="text-sm opacity-70">{approval.description}</p>
                              </div>
                              <span class={`badge ${statusBadgeClass(approval.status)}`}>
                                {formatApprovalStatus(approval.status)}
                              </span>
                            </div>
                          </article>
                        )}
                      </For>
                    </Show>
                  </div>
                </div>

                <div class="workspace-panel">
                  <div class="ui-section-header mb-4 flex flex-wrap items-center justify-between gap-3">
                    <h2 class="font-display text-xl font-semibold text-base-content">Artifacts</h2>
                    <span class="badge badge-outline">{state.artifacts.length} live</span>
                  </div>

                  <div class="space-y-3">
                    <Show
                      when={state.artifacts.length > 0}
                      fallback={<div class="empty-state">No artifacts yet for this workspace.</div>}
                    >
                      <For each={state.artifacts}>
                        {(artifact) => (
                          <article class="artifact-row">
                            <div>
                              <h3 class="font-semibold">{artifact.title}</h3>
                              <p class="text-xs opacity-70">
                                {artifact.kind} · {artifact.status}
                              </p>
                            </div>
                            <div class="flex flex-wrap items-center gap-2">
                              <span class="badge badge-outline badge-sm">v{artifact.version}</span>
                              <button
                                class="btn btn-outline btn-xs"
                                onClick={() =>
                                  void openArtifactDetail(artifact.workspaceId, artifact.id)
                                }
                                type="button"
                              >
                                View artifact
                              </button>
                            </div>
                          </article>
                        )}
                      </For>
                    </Show>
                  </div>
                </div>
              </Match>

              <Match when={activePage() === 'settings'}>
                <div class="workspace-panel settings-page">
                  <div class="main-panel-head main-panel-head-stacked">
                    <div>
                      <p class="eyebrow">Settings</p>
                      <h2 class="font-display text-2xl font-semibold">Workspace Settings</h2>
                    </div>
                    <span class="badge badge-outline">Local workspace</span>
                  </div>

                  <div class="settings-content">
                    <Switch>
                      <Match when={activeSettingsSection() === 'general'}>
                        <form
                          class="support-card"
                          onSubmit={(event) => void submitWorkspaceUpdate(event)}
                        >
                          <h3 class="font-display text-lg font-semibold">General settings</h3>
                          <div class="mt-4 grid gap-3">
                            <label class="form-control ui-field">
                              <span class="label-text">Workspace name</span>
                              <input
                                class="input input-bordered"
                                name="settingsWorkspaceName"
                                value={workspaceNameDraft()}
                                onInput={(event) =>
                                  setWorkspaceNameDraft(event.currentTarget.value)
                                }
                              />
                            </label>

                            <label class="form-control ui-field">
                              <span class="label-text">Status</span>
                              <select
                                class="select select-bordered"
                                name="settingsWorkspaceStatus"
                                value={workspaceStatusDraft()}
                                onChange={(event) =>
                                  setWorkspaceStatusDraft(
                                    event.currentTarget.value as Workspace['status']
                                  )
                                }
                              >
                                <option value="active">active</option>
                                <option value="archived">archived</option>
                              </select>
                            </label>

                            <label class="form-control ui-field">
                              <span class="label-text">Default model</span>
                              <select
                                class="select select-bordered"
                                name="settingsDefaultModelId"
                                value={defaultModelIdDraft()}
                                onChange={(event) =>
                                  setDefaultModelIdDraft(event.currentTarget.value)
                                }
                              >
                                <option value="">No default model</option>
                                <For each={selectedWorkspaceResources()?.models ?? []}>
                                  {(model) => <option value={model.id}>{model.name}</option>}
                                </For>
                              </select>
                            </label>

                            <label class="form-control ui-field">
                              <span class="label-text">Default agent</span>
                              <select
                                class="select select-bordered"
                                name="settingsDefaultAgentId"
                                value={defaultAgentIdDraft()}
                                onChange={(event) =>
                                  setDefaultAgentIdDraft(event.currentTarget.value)
                                }
                              >
                                <option value="">No default agent</option>
                                <For each={selectedWorkspaceResources()?.agents ?? []}>
                                  {(agent) => <option value={agent.id}>{agent.name}</option>}
                                </For>
                              </select>
                            </label>
                          </div>

                          <fieldset class="mt-4 space-y-2">
                            <legend class="text-sm font-medium">Default skills</legend>
                            <For each={selectedWorkspaceResources()?.skills ?? []}>
                              {(skill) => (
                                <label class="flex items-center justify-between rounded-lg bg-base-100 px-3 py-2">
                                  <span class="text-sm font-medium">{skill.name}</span>
                                  <input
                                    checked={selectedSkillIds().includes(skill.id)}
                                    class="checkbox checkbox-sm checkbox-primary"
                                    name="settingsDefaultSkillIds"
                                    onChange={() => toggleSelectedSkill(skill.id)}
                                    type="checkbox"
                                  />
                                </label>
                              )}
                            </For>
                          </fieldset>

                          <button
                            class="btn btn-primary mt-4"
                            disabled={!canSaveWorkspace()}
                            type="submit"
                          >
                            Save changes
                          </button>
                        </form>
                      </Match>

                      <Match when={activeSettingsSection() === 'appearance'}>
                        <fieldset
                          aria-label="Theme selector"
                          class="support-card theme-selector-panel"
                        >
                          <legend class="font-display text-lg font-semibold">Theme selector</legend>
                          <h3 class="sr-only">Theme presets</h3>
                          <div class="theme-preview-grid mt-4">
                            <For each={APP_THEMES}>
                              {(theme) => (
                                <button
                                  aria-label={`Theme ${formatThemeName(theme)}`}
                                  class={`theme-preview ${
                                    selectedTheme() === theme ? 'theme-preview-active' : ''
                                  }`}
                                  data-theme={theme}
                                  onClick={() => selectTheme(theme)}
                                  type="button"
                                >
                                  <span class="theme-preview-rail" aria-hidden="true">
                                    <i class="bg-base-200" />
                                    <i class="bg-base-300" />
                                  </span>
                                  <span class="theme-preview-body">
                                    <span class="theme-preview-title">
                                      {formatThemeName(theme)}
                                    </span>
                                    <span class="theme-preview-strip">
                                      <i class="theme-swatch bg-primary text-primary-content">A</i>
                                      <i class="theme-swatch bg-secondary text-secondary-content">
                                        A
                                      </i>
                                      <i class="theme-swatch bg-accent text-accent-content">A</i>
                                      <i class="theme-swatch bg-neutral text-neutral-content">A</i>
                                    </span>
                                  </span>
                                </button>
                              )}
                            </For>
                          </div>
                        </fieldset>
                      </Match>

                      <Match when={activeSettingsSection() === 'configuration'}>
                        <section class="support-card settings-content-panel">
                          <h3 class="font-display text-lg font-semibold">Configuration</h3>
                          <div class="settings-status-strip mt-4">
                            <span>Protocol {state.meta?.protocolVersion ?? 'loading'}</span>
                            <span>Debug {state.inspectMode}</span>
                            <span>Connection {state.status}</span>
                            <div class="join">
                              <button
                                class={`btn join-item btn-xs ${
                                  state.inspectMode === 'product' ? 'btn-neutral' : 'btn-outline'
                                }`}
                                onClick={() => setInspectMode('product')}
                                type="button"
                              >
                                Product
                              </button>
                              <button
                                class={`btn join-item btn-xs ${
                                  state.inspectMode === 'protocol' ? 'btn-neutral' : 'btn-outline'
                                }`}
                                onClick={() => setInspectMode('protocol')}
                                type="button"
                              >
                                Protocol
                              </button>
                            </div>
                          </div>
                          <div class="mt-4 grid gap-3">
                            <div class="metric-tile">
                              <span class="metric-label">Approvals</span>
                              <span class="metric-value">
                                {hasCapability(state.meta?.capabilities, 'core.approvals')
                                  ? 'enabled'
                                  : 'disabled'}
                              </span>
                            </div>
                            <div class="metric-tile">
                              <span class="metric-label">Artifacts</span>
                              <span class="metric-value">
                                {hasCapability(state.meta?.capabilities, 'core.artifacts')
                                  ? 'enabled'
                                  : 'disabled'}
                              </span>
                            </div>
                            <div class="metric-tile">
                              <span class="metric-label">Interrupts</span>
                              <span class="metric-value">
                                {hasCapability(state.meta?.capabilities, 'core.interrupt')
                                  ? 'enabled'
                                  : 'disabled'}
                              </span>
                            </div>
                          </div>
                        </section>
                      </Match>

                      <Match when={activeSettingsSection() === 'runtime-config'}>
                        <RuntimeConfigPanel
                          currentVersion={
                            state.setupDiagnostics?.runtimeConfig?.currentVersion ??
                            state.appDiagnostics?.runtimeConfig?.currentVersion ??
                            null
                          }
                          diagnostics={runtimeConfigDiagnostics()}
                          draftContent={runtimeConfigDraft()}
                          files={runtimeConfigFiles()}
                          isLoading={isLoadingRuntimeConfigFiles()}
                          isReloading={isReloadingRuntimeConfig()}
                          isSaving={isSavingRuntimeConfigFile()}
                          isValidating={isValidatingRuntimeConfig()}
                          onCreateFile={createRuntimeConfigFile}
                          onDiscard={discardRuntimeConfigDraft}
                          onDraftChange={updateRuntimeConfigDraft}
                          onDryRunReload={() =>
                            reloadRuntimeConfig({
                              dryRun: true,
                              mode: runtimeConfigEditorMode(),
                            })
                          }
                          onReload={() =>
                            reloadRuntimeConfig({
                              dryRun: false,
                              mode: runtimeConfigEditorMode(),
                            })
                          }
                          onReloadFile={() => {
                            const selectedFile = selectedRuntimeConfigFile();

                            if (selectedFile) {
                              void selectRuntimeConfigFile(selectedFile.file.id);
                              return;
                            }

                            void loadRuntimeConfigFiles();
                          }}
                          onReloadModeChange={setRuntimeConfigEditorMode}
                          onSave={saveRuntimeConfigFile}
                          onSelectFile={selectRuntimeConfigFile}
                          onValidate={() => validateRuntimeConfigDraft()}
                          reloadMode={runtimeConfigEditorMode()}
                          reloadResult={runtimeConfigReloadResult()}
                          schemaCatalog={runtimeConfigSchemas()}
                          selectedFile={selectedRuntimeConfigFile()}
                          validation={runtimeConfigValidation()}
                        />
                      </Match>

                      <Match when={activeSettingsSection() === 'knowledge'}>
                        <KnowledgePanel
                          entries={selectedWorkspaceResources()?.knowledge ?? []}
                          errorMessage={state.errorMessage}
                          isSaving={state.isSavingKnowledge}
                          onCreate={createKnowledge}
                          onDelete={deleteKnowledge}
                          onUpdate={updateKnowledge}
                        />
                      </Match>

                      <Match when={activeSettingsSection() === 'portability'}>
                        <section class="support-card settings-content-panel">
                          <h3 class="font-display text-lg font-semibold">Portability</h3>
                          <div class="settings-status-strip mt-4">
                            <span>
                              {workspaceRepositories()?.defaultResource
                                ? 'repository linked'
                                : 'repository unbound'}
                            </span>
                            <span>
                              {workspaceRepositoryDiagnostics()?.defaultResource
                                ?.diagnosticsStatus ?? 'unknown'}
                            </span>
                            <span>
                              {isLoadingWorkspaceRepositories()
                                ? 'refreshing'
                                : `${workspaceRepositories()?.items.length ?? 0} resources`}
                            </span>
                          </div>

                          <Show
                            fallback={
                              <div class="metric-tile mt-4">
                                <span class="metric-label">Default repository</span>
                                <span class="metric-value">No repository resource linked</span>
                              </div>
                            }
                            when={workspaceRepositories()?.defaultResource}
                          >
                            {(repository) => (
                              <div class="metric-tile mt-4">
                                <span class="metric-label">{repository().displayName}</span>
                                <span class="metric-value">{repository().diagnosticsStatus}</span>
                                <p class="text-xs opacity-70">{repository().pathSummary}</p>
                              </div>
                            )}
                          </Show>

                          <Show when={workspaceRepositoryDiagnostics()?.defaultResource}>
                            {(diagnostic) => (
                              <p class="mt-3 text-sm opacity-80">{diagnostic().summary}</p>
                            )}
                          </Show>

                          <form
                            class="mt-4 grid gap-3"
                            onSubmit={(event) => void saveWorkspaceRepository(event)}
                          >
                            <label class="form-control ui-field">
                              <span class="label-text">Repository path</span>
                              <input
                                class="input input-bordered"
                                name="settingsRepositoryPath"
                                onInput={(event) =>
                                  setRepositoryPathDraft(event.currentTarget.value)
                                }
                                value={repositoryPathDraft()}
                              />
                            </label>

                            <button
                              class="btn btn-primary"
                              disabled={
                                !repositoryPathDraft().trim() || isSavingWorkspaceRepository()
                              }
                              type="submit"
                            >
                              {isSavingWorkspaceRepository()
                                ? 'Rebinding repository'
                                : 'Rebind repository'}
                            </button>
                          </form>

                          <div class="mt-6 grid gap-3">
                            <div class="settings-status-strip">
                              <span>vault references</span>
                              <span>{workspaceVaultReferences()?.items.length ?? 0}</span>
                            </div>

                            <Show
                              fallback={
                                <div class="metric-tile">
                                  <span class="metric-label">Vault references</span>
                                  <span class="metric-value">No workspace vault references</span>
                                </div>
                              }
                              when={(workspaceVaultReferences()?.items.length ?? 0) > 0}
                            >
                              <For each={workspaceVaultReferences()?.items ?? []}>
                                {(reference) => (
                                  <div class="metric-tile">
                                    <span class="metric-label">{reference.referenceId}</span>
                                    <span class="metric-value">{reference.status}</span>
                                    <p class="text-xs opacity-70">
                                      {reference.secretKind} via {reference.backendKind}
                                    </p>
                                  </div>
                                )}
                              </For>
                            </Show>

                            <form
                              class="grid gap-3"
                              onSubmit={(event) => void saveWorkspaceVaultReference(event)}
                            >
                              <label class="form-control ui-field">
                                <span class="label-text">Vault reference</span>
                                <select
                                  class="select select-bordered"
                                  disabled={
                                    (workspaceVaultReferences()?.items ?? []).every(
                                      (reference) => reference.status !== 'unbound'
                                    ) || isRebindingVaultReference()
                                  }
                                  onChange={(event) =>
                                    setSelectedVaultReferenceId(event.currentTarget.value)
                                  }
                                  value={selectedVaultReferenceId()}
                                >
                                  <For
                                    each={(workspaceVaultReferences()?.items ?? []).filter(
                                      (reference) => reference.status === 'unbound'
                                    )}
                                  >
                                    {(reference) => (
                                      <option value={reference.referenceId}>
                                        {reference.referenceId}
                                      </option>
                                    )}
                                  </For>
                                </select>
                              </label>

                              <label class="form-control ui-field">
                                <span class="label-text">Secret material</span>
                                <input
                                  class="input input-bordered"
                                  name="settingsVaultSecretMaterial"
                                  onInput={(event) =>
                                    setVaultSecretDraft(event.currentTarget.value)
                                  }
                                  type="password"
                                  value={vaultSecretDraft()}
                                />
                              </label>

                              <button
                                class="btn btn-primary"
                                disabled={
                                  !selectedVaultReferenceId() ||
                                  !vaultSecretDraft() ||
                                  isRebindingVaultReference()
                                }
                                type="submit"
                              >
                                {isRebindingVaultReference()
                                  ? 'Rebinding vault reference'
                                  : 'Rebind vault reference'}
                              </button>
                            </form>
                          </div>

                          <Show when={repositoryFeedback()}>
                            {(message) => <p class="mt-3 text-sm opacity-80">{message()}</p>}
                          </Show>
                          <Show when={vaultReferenceFeedback()}>
                            {(message) => <p class="mt-3 text-sm opacity-80">{message()}</p>}
                          </Show>
                        </section>
                      </Match>

                      <Match when={activeSettingsSection() === 'diagnostics'}>
                        <DiagnosticsPanel
                          appDiagnostics={state.appDiagnostics}
                          events={selectedSession().events}
                          inspectMode={state.inspectMode}
                          isUpdatingCodexOAuth={isUpdatingCodexOAuth()}
                          isReloadingRuntimeConfig={isReloadingRuntimeConfig()}
                          isRefreshingSetupDiagnostics={isRefreshingSetupDiagnostics()}
                          meta={state.meta}
                          onCancelCodexOAuth={cancelOpenAICodexOAuth}
                          onCreateCodexOAuthAccount={createOpenAICodexOAuthAccount}
                          onDeleteCodexOAuthAccount={deleteOpenAICodexOAuthAccount}
                          onLogoutCodexOAuth={logoutOpenAICodexOAuth}
                          onRefreshSetupDiagnostics={refreshSetupDiagnostics}
                          onReloadRuntimeConfig={reloadRuntimeConfig}
                          onStartCodexOAuth={startOpenAICodexOAuth}
                          onUpdateCodexOAuthAccount={updateOpenAICodexOAuthAccount}
                          setupDiagnostics={state.setupDiagnostics}
                          turns={selectedSession().turns}
                        />
                      </Match>
                    </Switch>
                  </div>
                </div>
              </Match>
            </Switch>
          </section>
          <Show when={itemLogOpen()}>
            <aside
              aria-label="Item log"
              class="item-log-sidebar item-log-sidebar-sticky item-log-sidebar-scrollable surface-separated-column"
            >
              <div class="item-log-header">
                <div>
                  <p class="eyebrow">Items</p>
                  <h2 class="font-display text-lg font-semibold">Item Log</h2>
                </div>
                <button
                  aria-label="Close item log"
                  class="icon-button"
                  onClick={() => setItemLogOpen(false)}
                  type="button"
                >
                  <RemixIcon icon="ri:close-line" />
                </button>
              </div>
              <div class="item-log-body">
                <Show
                  when={selectedSession().items.length > 0}
                  fallback={<div class="empty-state">No conversation items yet.</div>}
                >
                  <For each={selectedSession().items}>
                    {(item) => (
                      <article class="event-line">
                        <div class="flex items-center justify-between gap-3">
                          <span class="badge badge-outline badge-sm">{item.type}</span>
                          <span class="text-xs opacity-60">{item.status}</span>
                        </div>
                        <Show when={itemLogContent(item)}>
                          {(content) => (
                            <p class="mt-2 whitespace-pre-wrap text-sm leading-6">{content()}</p>
                          )}
                        </Show>
                      </article>
                    )}
                  </For>
                </Show>
              </div>
            </aside>
          </Show>
        </main>
      </div>
    </div>
  );
}
