/// <reference types="node" />

import '@testing-library/jest-dom/vitest';

import { readFileSync } from 'node:fs';
import { ApiCallError, type CoreClient, type SseEventEnvelope } from '@openkit/core-client';
import type {
  ApprovalRequestSchema,
  ArtifactSchema,
  ItemSchema,
  MetaResponseSchema,
  ThreadSchema,
  TurnSchema,
  WorkspaceRecordSchema,
  WorkspaceResourcesSchema,
} from '@openkit/protocol';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import App from './App';
import appSource from './App.tsx?raw';

type Workspace = z.infer<typeof WorkspaceRecordSchema>;
type Thread = z.infer<typeof ThreadSchema>;
type Turn = z.infer<typeof TurnSchema>;
type Item = z.infer<typeof ItemSchema>;
type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
type Artifact = z.infer<typeof ArtifactSchema>;
type MetaResponse = z.infer<typeof MetaResponseSchema>;
type WorkspaceResources = z.infer<typeof WorkspaceResourcesSchema>;
type HumanAttentionRow = Awaited<
  ReturnType<CoreClient['actionCenter']['listHumanAttention']>
>['items'][number];
type ApprovalResponseInput = Parameters<CoreClient['core']['respondApproval']>[1] & {
  approvalRequestId: string;
};
/**
 * Runtime config file summary fixture shape.
 */
type RuntimeConfigFileSummary = Awaited<
  ReturnType<CoreClient['runtimeConfig']['listFiles']>
>['files'][number];
/**
 * Runtime config file read fixture shape.
 */
type RuntimeConfigFileRead = Awaited<ReturnType<CoreClient['runtimeConfig']['getFile']>>;
/**
 * Runtime config file write fixture shape.
 */
type RuntimeConfigFileWriteResponse = Awaited<
  ReturnType<CoreClient['runtimeConfig']['updateFile']>
>;
/**
 * Runtime config validation fixture shape.
 */
type RuntimeConfigValidation = Awaited<ReturnType<CoreClient['runtimeConfig']['validate']>>;
/**
 * Runtime config schema catalog fixture shape.
 */
type RuntimeConfigSchemaCatalog = Awaited<ReturnType<CoreClient['runtimeConfig']['getSchemas']>>;
/**
 * Runtime config status fixture shape.
 */
type RuntimeConfigStatus = Awaited<
  ReturnType<CoreClient['runtimeConfig']['reload']>
>['runtimeConfig'];
/**
 * Thread Goal Mode summary fixture shape.
 */
type ThreadGoalSummaryResponse = Awaited<ReturnType<CoreClient['app']['getThreadGoalSummary']>>;
type ThreadGoalSummary = NonNullable<ThreadGoalSummaryResponse['goal']>;
type ThreadGoalPlan = Awaited<ReturnType<CoreClient['app']['createThreadGoalPlan']>>['plan'];
type TurnEvent = SseEventEnvelope;

/**
 * Creates an empty Goal Mode steering fixture.
 */
function emptyGoalSteering(): ThreadGoalSummary['steering'] {
  return {
    pendingSteeringCount: 0,
    pendingFollowUpCount: 0,
    appliedSteeringCount: 0,
  };
}

/**
 * Creates runtime config stale-session recovery choices for diagnostics fixtures.
 */
function runtimeConfigStaleSessionChoices(): RuntimeConfigStatus['staleSessions'][number]['choices'] {
  return [
    { kind: 'inspect', label: 'Inspect session', recommended: true },
    { kind: 'restart_session', label: 'Restart session' },
    { kind: 'request_human', label: 'Request human review' },
  ];
}

/**
 * Creates an all-ready boot readiness snapshot for diagnostics fixtures.
 */
function bootReadiness(): Awaited<ReturnType<CoreClient['app']['getDiagnostics']>>['boot'] {
  const ready = { state: 'ready' as const, reasons: [] };

  return {
    bootId: 'boot_web_test',
    acceptingProductWork: true,
    overall: 'ready',
    subsystems: {
      config: ready,
      storage: ready,
      policy: ready,
      vault: ready,
      scheduler: ready,
      llmGateway: ready,
      knowledgeIndex: ready,
    },
  };
}

/**
 * Creates a Goal Mode planner summary fixture.
 */
function goalPlannerSummary(): Awaited<
  ReturnType<CoreClient['app']['createThreadGoalPlan']>
>['planner'] {
  return {
    mode: 'goal',
    sourceAgentId: 'worker-coordinator',
    confidence: 0.84,
    rationale: 'Worker Coordinator drafted a reviewable Goal Mode plan.',
    contextRefs: [
      { kind: 'workspace', id: 'ws_demo' },
      { kind: 'thread', id: 'th_demo' },
    ],
    requiredApprovals: ['plan_approval'],
  };
}

/**
 * Creates a Goal Mode worker context assembly fixture.
 */
function goalStepContextAssembly(): Awaited<
  ReturnType<CoreClient['app']['runThreadGoalStep']>
>['contextAssembly'] {
  return {
    contextDigest: 'ctxpkg_sha256_demo',
    contextRefs: [
      { kind: 'workspace', id: 'ws_demo' },
      { kind: 'thread', id: 'th_demo' },
      { kind: 'item', id: 'it_context' },
    ],
    repositoryResourceId: 'repo_default',
    steeringMessageCount: 1,
    followUpInputCount: 0,
  };
}

/**
 * Creates a Goal Mode coordinator decision fixture.
 */
function goalStepCoordinator(): Awaited<
  ReturnType<CoreClient['app']['runThreadGoalStep']>
>['coordinator'] {
  return {
    mode: 'goal',
    sourceAgentId: 'worker-coordinator',
    worker: {
      agentId: 'codex',
      displayName: 'Codex',
      runtime: 'codex',
    },
    confidence: 0.86,
    rationale: 'The Goal Mode step needs bounded worker execution and Codex is ready.',
    requiredApprovals: [],
    expectedStopCondition: 'one bounded worker turn',
    escalationRecommended: false,
    contextRefs: [
      { kind: 'workspace', id: 'ws_demo' },
      { kind: 'thread', id: 'th_demo' },
    ],
  };
}

const META_RESPONSE: MetaResponse = {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: [
    'core.approvals',
    'core.artifacts',
    'core.interrupt',
    'core.knowledge.edit',
    'core.agent_session.visible',
    'core.stream.replay',
  ],
  eventFamilies: [
    'workspace.updated',
    'thread.created',
    'turn.started',
    'turn.updated',
    'item.created',
    'item.delta',
    'approval.requested',
    'approval.resolved',
    'agent.session.updated',
    'artifact.created',
    'turn.completed',
  ],
};

const DAISYUI_THEMES = [
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
 * Optional hooks for deterministic fake client assertions.
 */
interface FakeClientOptions {
  authRequiredOnInit?: boolean;
  appDiagnosticsDefaultProviders?: Awaited<
    ReturnType<CoreClient['app']['getDiagnostics']>
  >['defaultProviders'];
  appDiagnosticsInternalAgents?: Awaited<
    ReturnType<CoreClient['app']['getDiagnostics']>
  >['internalAgents'];
  codexOAuthAccounts?: Awaited<ReturnType<CoreClient['oauth']['openaiCodex']['listAccounts']>>;
  createCodexOAuthAccountError?: Error;
  setupDiagnostics?: Awaited<ReturnType<CoreClient['app']['getSetupDiagnostics']>>;
  threadGoalSummary?: ThreadGoalSummaryResponse;
  humanAttention?: HumanAttentionRow[];
  emptyWorkspaceResources?: boolean;
  quickChatError?: Error;
  startThreadGoalError?: Error;
  workspaceListError?: Error;
  runtimeConfigConflictOnSave?: boolean;
  onSignIn?(input: Parameters<CoreClient['auth']['email']['signIn']>[0]): void;
  onApproval?(input: ApprovalResponseInput): void;
  onInterrupt?(input: Parameters<CoreClient['core']['interruptTurn']>[0]): void;
  onRefreshAgentHealth?(workspaceId: string): void;
  onReloadRuntimeConfig?(input: Parameters<CoreClient['runtimeConfig']['reload']>[0]): void;
  onSetupDiagnostics?(): void;
  onApproveThreadGoalPlan?(
    workspaceId: string,
    threadId: string,
    input: Parameters<CoreClient['app']['approveThreadGoalPlan']>[2]
  ): void;
  onCreateThreadGoalPlan?(workspaceId: string, threadId: string): void;
  onRunThreadGoalStep?(workspaceId: string, threadId: string): void;
  onSubmitThreadGoalSteering?(
    workspaceId: string,
    threadId: string,
    input: Parameters<CoreClient['app']['submitThreadGoalSteering']>[2]
  ): void;
  onSubmitArtifactReviewDecision?(
    workspaceId: string,
    artifactId: string,
    input: Parameters<CoreClient['app']['submitArtifactReviewDecision']>[2]
  ): void;
  onSubmitWorkspaceSyncReviewDecision?(
    workspaceId: string,
    reviewId: string,
    input: Parameters<CoreClient['app']['submitWorkspaceSyncReviewDecision']>[2]
  ): void;
  onSubmitGoalReviewDecision?(
    workspaceId: string,
    threadId: string,
    goalId: string,
    reviewId: string,
    input: NonNullable<Parameters<CoreClient['app']['submitGoalReviewDecision']>[4]>
  ): void;
  onQueueAgentSessionTerminalCommand?(
    workspaceId: string,
    threadId: string,
    agentSessionId: string,
    input: Parameters<CoreClient['app']['queueAgentSessionTerminalCommand']>[3]
  ): void;
  onStartThreadGoal?(
    workspaceId: string,
    threadId: string,
    input: Parameters<CoreClient['app']['startThreadGoal']>[2]
  ): void;
  onStartOpenAICodexOAuth?(
    accountSlotId: string,
    input: Parameters<CoreClient['oauth']['openaiCodex']['startAccount']>[1]
  ): void;
  onSetDefaultRepository?(
    workspaceId: string,
    input: Parameters<CoreClient['repositories']['setDefault']>[1]
  ): void;
  onRebindWorkspaceVaultReference?(
    workspaceId: string,
    referenceId: string,
    input: Parameters<CoreClient['app']['rebindWorkspaceVaultReference']>[2]
  ): void;
  onTurnInput?(input: Parameters<CoreClient['core']['startTurn']>[0]): void;
  onValidateRuntimeConfig?(
    input: Parameters<CoreClient['runtimeConfig']['validate']>[0]
  ): Promise<void> | void;
}

/**
 * Internal fake-client implementation used to assemble the composed test client.
 */
type FakeClientImplementations = CoreClient['core'] & {
  emailSignUp: CoreClient['auth']['email']['signUp'];
  emailSignIn: CoreClient['auth']['email']['signIn'];
  emailSignOut: CoreClient['auth']['email']['signOut'];
  workspaceDashboard: CoreClient['app']['getWorkspaceDashboard'];
  threadDashboard: CoreClient['app']['getThreadDashboard'];
  threadGoalSummary: CoreClient['app']['getThreadGoalSummary'];
  startThreadGoal: CoreClient['app']['startThreadGoal'];
  createThreadGoalPlan: CoreClient['app']['createThreadGoalPlan'];
  approveThreadGoalPlan: CoreClient['app']['approveThreadGoalPlan'];
  runThreadGoalStep: CoreClient['app']['runThreadGoalStep'];
  submitThreadGoalSteering: CoreClient['app']['submitThreadGoalSteering'];
  submitArtifactReviewDecision: CoreClient['app']['submitArtifactReviewDecision'];
  submitWorkspaceSyncReviewDecision: CoreClient['app']['submitWorkspaceSyncReviewDecision'];
  submitGoalReviewDecision: CoreClient['app']['submitGoalReviewDecision'];
  queueAgentSessionTerminalCommand: CoreClient['app']['queueAgentSessionTerminalCommand'];
  refreshAgentHealth: CoreClient['agents']['refreshHealth'];
  appDiagnostics: CoreClient['app']['getDiagnostics'];
  setupDiagnostics: CoreClient['app']['getSetupDiagnostics'];
  oauthAccounts: CoreClient['oauth']['openaiCodex']['listAccounts'];
  oauthCreateAccount: CoreClient['oauth']['openaiCodex']['createAccount'];
  oauthUpdateAccount: CoreClient['oauth']['openaiCodex']['updateAccount'];
  oauthDeleteAccount: CoreClient['oauth']['openaiCodex']['deleteAccount'];
  oauthAccountStatus: CoreClient['oauth']['openaiCodex']['getAccountStatus'];
  oauthStartAccount: CoreClient['oauth']['openaiCodex']['startAccount'];
  oauthCancelAccount: CoreClient['oauth']['openaiCodex']['cancelAccount'];
  oauthLogoutAccount: CoreClient['oauth']['openaiCodex']['logoutAccount'];
  runtimeReload: CoreClient['runtimeConfig']['reload'];
  runtimeListFiles: CoreClient['runtimeConfig']['listFiles'];
  runtimeGetFile: CoreClient['runtimeConfig']['getFile'];
  runtimeCreateFile: CoreClient['runtimeConfig']['createFile'];
  runtimeUpdateFile: CoreClient['runtimeConfig']['updateFile'];
  runtimeValidate: CoreClient['runtimeConfig']['validate'];
  runtimeSchemas: CoreClient['runtimeConfig']['getSchemas'];
  automationList: CoreClient['app']['listAutomations'];
  automationCreate: CoreClient['app']['createAutomation'];
  automationUpdate: CoreClient['app']['updateAutomation'];
  automationDelete: CoreClient['app']['deleteAutomation'];
  quickChat: CoreClient['app']['quickChat'];
  appSearch: CoreClient['app']['search'];
  turnFeedback: CoreClient['app']['submitTurnFeedback'];
  listHumanAttention: CoreClient['actionCenter']['listHumanAttention'];
};

/**
 * Builds a deterministic in-memory client used by the SPA tests.
 */
function createFakeClient(options: FakeClientOptions = {}): CoreClient {
  const timestamp = '2026-04-15T09:00:00.000Z';
  const workspace: Workspace = {
    id: 'ws_demo',
    name: 'Demo Workspace',
    kind: 'code',
    status: 'active',
    defaults: {
      defaultModelId: 'model_gpt_5_4',
      defaultAgentId: 'agent_planner',
      defaultSkillIds: ['skill_protocol'],
    },
    counts: {
      threadCount: 1,
      artifactCount: 0,
      knowledgeEntryCount: 1,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const workspaceResources: WorkspaceResources = {
    knowledge: [
      {
        id: 'kn_project',
        kind: 'project-context',
        title: 'Product focus',
        content: 'Validate the workspace protocol through a real SPA.',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    skills: [{ id: 'skill_protocol', name: 'Protocol Design', enabled: true }],
    agents: [
      {
        id: 'agent_planner',
        name: 'Planner',
        kind: 'planner',
        status: 'enabled',
        modelId: 'model_gpt_5_4',
        skillIds: ['skill_protocol'],
        profiles: [
          {
            id: 'default',
            displayName: 'Default Planning Profile',
            instructionsRef: null,
            modelId: null,
            skillIds: [],
            capabilityIds: [],
          },
        ],
        defaultProfileId: 'default',
        capabilities: [
          { id: 'turns', label: 'Turns', description: 'Can execute turn requests.' },
          { id: 'streaming', label: 'Streaming', description: null },
          { id: 'interrupts', label: 'Interrupts', description: null },
        ],
        sandboxSummary: {
          access: 'read-write',
          workspaceRootRefs: ['workspace'],
          summary: 'Workspace access is available.',
        },
        health: {
          status: 'ready',
          message: null,
          checkedAt: timestamp,
        },
      },
      {
        id: 'agent_opencode',
        name: 'OpenCode',
        kind: 'coder',
        status: 'enabled',
        modelId: 'model_opencode',
        skillIds: [],
        profiles: [
          {
            id: 'default',
            displayName: 'Default Coding Profile',
            instructionsRef: null,
            modelId: null,
            skillIds: [],
            capabilityIds: [],
          },
        ],
        defaultProfileId: 'default',
        capabilities: [
          { id: 'turns', label: 'Turns', description: 'Can execute turn requests.' },
          { id: 'streaming', label: 'Streaming', description: null },
        ],
        sandboxSummary: {
          access: 'read-write',
          workspaceRootRefs: ['workspace'],
          summary: 'Workspace access is available.',
        },
        health: {
          status: 'unknown',
          message: 'Not checked yet',
          checkedAt: null,
        },
      },
    ],
    models: [
      { id: 'model_gpt_5_4', name: 'GPT-5.4', enabled: true, isDefault: true },
      { id: 'model_opencode', name: 'OpenCode', enabled: true, isDefault: false },
    ],
  };
  const quickChatWorkspace: Workspace = {
    id: 'ws_quick_chat',
    name: 'Quick Chat',
    kind: 'general',
    status: 'active',
    defaults: {
      defaultModelId: null,
      defaultAgentId: null,
      defaultSkillIds: [],
    },
    counts: {
      threadCount: 0,
      artifactCount: 0,
      knowledgeEntryCount: 0,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const threads = new Map<string, Thread>([
    [
      'th_demo',
      {
        id: 'th_demo',
        workspaceId: workspace.id,
        name: 'Protocol design review',
        preview: 'Seeded design conversation.',
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  ]);
  const turns = new Map<string, Turn>();
  const artifacts = new Map<string, Artifact>();
  const replayItems = new Map<string, Item[]>([
    [
      'th_demo',
      [
        {
          id: 'it_replay_1',
          workspaceId: workspace.id,
          threadId: 'th_demo',
          turnId: 'tu_replay',
          type: 'assistant-message',
          status: 'completed',
          text: 'Restored from nanocore replay.',
          createdAt: timestamp,
          completedAt: timestamp,
        },
        {
          id: 'it_replay_failed_tool',
          workspaceId: workspace.id,
          threadId: 'th_demo',
          turnId: 'tu_replay',
          type: 'tool-call',
          status: 'failed',
          tool: 'provider.chat',
          server: null,
          arguments: null,
          result: null,
          error: 'Rate limit exceeded: 5 requests per minute.',
          durationMs: 123,
          createdAt: timestamp,
          completedAt: timestamp,
        },
      ],
    ],
  ]);
  const listeners = new Map<string, Set<(event: TurnEvent) => void>>();
  const eventHistory = new Map<string, TurnEvent[]>();
  const approvals = new Map<string, ApprovalRequest>();
  const turnInputs = new Map<string, string>();
  let currentWorkspace = workspace;
  let currentThreadGoalSummary: ThreadGoalSummaryResponse = options.threadGoalSummary ?? {
    goal: null,
  };
  let repositoryResource:
    | Awaited<ReturnType<CoreClient['repositories']['setDefault']>>['repository']
    | null = null;
  let vaultReferences: Awaited<
    ReturnType<CoreClient['app']['listWorkspaceVaultReferences']>
  >['items'] = [
    {
      workspaceId: 'ws_demo',
      referenceId: 'vault_imported',
      ownerScope: 'workspace',
      secretKind: 'api-token',
      backendKind: 'encrypted-file',
      status: 'unbound',
      currentVersion: 0,
    },
  ];
  let runtimeConfigVersion = 2;
  let activeSessionStale = false;
  let runtimeConfigRevisionCounter = 1;
  let runtimeConfigFiles: RuntimeConfigFileSummary[] = [
    {
      id: 'server.jsonc',
      kind: 'server',
      path: 'server.jsonc',
      exists: true,
      revision: 'sha256:server-v1',
      updatedAt: timestamp,
    },
    {
      id: 'workspaces/ws_demo/workspace.jsonc',
      kind: 'workspace',
      path: 'workspaces/ws_demo/workspace.jsonc',
      exists: true,
      revision: 'sha256:workspace-v1',
      updatedAt: timestamp,
    },
  ];
  const runtimeConfigContents = new Map<string, string>([
    [
      'server.jsonc',
      [
        '{',
        '  "schemaVersion": 1,',
        '  "defaults": {',
        '    "coreProviderId": "agent-openrouter"',
        '  }',
        '}',
        '',
      ].join('\n'),
    ],
    [
      'workspaces/ws_demo/workspace.jsonc',
      [
        '{',
        '  "schemaVersion": 1,',
        '  "workspace": {',
        '    "roots": [',
        '      { "id": "data", "kind": "host-dir", "path": "files/data", "access": "read-only" }',
        '    ]',
        '  }',
        '}',
        '',
      ].join('\n'),
    ],
  ]);
  const runtimeConfigSchemaCatalog: RuntimeConfigSchemaCatalog = {
    schemas: [
      { kind: 'server', title: 'Server config', schema: { type: 'object' } },
      { kind: 'provider', title: 'Provider profile', schema: { type: 'object' } },
      { kind: 'agent', title: 'Agent config', schema: { type: 'object' } },
      { kind: 'workspace', title: 'Workspace config', schema: { type: 'object' } },
    ],
  };

  /**
   * Builds one runtime config status fixture for fake diagnostics.
   */
  function runtimeConfigStatus() {
    return {
      currentVersion: runtimeConfigVersion,
      loadedAt: timestamp,
      lastReload:
        runtimeConfigVersion > 2
          ? {
              at: '2026-04-15T09:06:00.000Z',
              mode: 'safe' as const,
              dryRun: false,
              previousVersion: runtimeConfigVersion - 1,
              currentVersion: runtimeConfigVersion,
              status: 'applied' as const,
              message: null,
            }
          : null,
      lastFailedReload: null,
      pendingRestart: [],
      staleSessions: activeSessionStale
        ? [
            {
              sessionId: 'session_sim_th_demo',
              threadId: 'th_demo',
              agentId: 'agent_planner',
              capturedVersion: runtimeConfigVersion - 1,
              currentVersion: runtimeConfigVersion,
              reasons: ['session-scoped config changed'],
              choices: runtimeConfigStaleSessionChoices(),
            },
          ]
        : [],
    };
  }

  /**
   * Builds a fake source revision for an edited runtime config file.
   */
  function nextRuntimeConfigRevision(): string {
    runtimeConfigRevisionCounter += 1;
    return `sha256:web-test-${runtimeConfigRevisionCounter}`;
  }

  /**
   * Finds one runtime config file summary by id.
   */
  function findRuntimeConfigFile(id: string): RuntimeConfigFileSummary {
    const file = runtimeConfigFiles.find((candidate) => candidate.id === id);

    if (!file) {
      throw new ApiCallError(404, `Runtime config file not found: ${id}`, {
        code: 'config_file_not_found',
      });
    }

    return file;
  }

  /**
   * Creates one fake runtime config file read payload.
   */
  function readRuntimeConfigFile(id: string): RuntimeConfigFileRead {
    const file = findRuntimeConfigFile(id);

    return {
      file,
      content: runtimeConfigContents.get(id) ?? '',
    };
  }

  /**
   * Creates one redacted repository diagnostic row from the linked repository fixture.
   */
  function repositoryDiagnostic(
    workspaceId: string
  ): Awaited<ReturnType<CoreClient['repositories']['diagnostics']>>['resources'][number] | null {
    if (!repositoryResource) {
      return null;
    }

    const diagnosticsStatus =
      repositoryResource.diagnosticsStatus === 'unknown'
        ? 'missing'
        : repositoryResource.diagnosticsStatus;

    return {
      displayName: repositoryResource.displayName,
      diagnosticsStatus,
      pathSummary: repositoryResource.pathSummary,
      ready: diagnosticsStatus === 'ready',
      resourceId: repositoryResource.resourceId,
      summary: repositoryResource.validation?.summary ?? 'Repository is ready.',
      type: repositoryResource.type,
      updatedAt: repositoryResource.updatedAt,
      workspaceId,
    };
  }

  /**
   * Creates a minimal validation result for runtime config source tests.
   */
  function validateRuntimeConfigSource(content: string, fileId: string): RuntimeConfigValidation {
    const invalid = content.trim() === '{';

    return {
      valid: !invalid,
      diagnostics: invalid
        ? [
            {
              fileId,
              severity: 'error',
              code: 'jsonc_parse_error',
              message: 'Unexpected end of JSONC input.',
              source: 'nanocore',
              jsonPath: null,
              range: {
                startLine: 1,
                startColumn: 1,
                endLine: 1,
                endColumn: 2,
              },
            },
          ]
        : [],
      runtimeConfig: runtimeConfigStatus(),
      plan: {
        previousVersion: runtimeConfigVersion,
        nextVersion: runtimeConfigVersion + 1,
        applied: [],
        deferred: [],
        requiresRestart: [],
        rejected: [],
        warnings: [],
      },
    };
  }

  /**
   * Writes one runtime config source and returns a protocol-shaped response.
   */
  function writeRuntimeConfigFile(input: {
    id: string;
    kind: RuntimeConfigFileSummary['kind'];
    content?: string;
    expectedRevision?: string | null;
  }): RuntimeConfigFileWriteResponse {
    const current = findRuntimeConfigFile(input.id);
    const content = input.content ?? runtimeConfigContents.get(input.id) ?? '';

    if (input.expectedRevision !== current.revision) {
      throw new ApiCallError(409, 'Runtime config file changed on disk.', {
        code: 'config_revision_conflict',
      });
    }

    const validation = validateRuntimeConfigSource(content, input.id);

    if (!validation.valid) {
      throw new ApiCallError(400, 'Runtime config file is invalid.', {
        code: 'config_file_invalid',
      });
    }

    const file: RuntimeConfigFileSummary = {
      ...current,
      kind: input.kind,
      revision: nextRuntimeConfigRevision(),
      updatedAt: '2026-04-15T09:07:00.000Z',
    };
    runtimeConfigContents.set(input.id, content);
    runtimeConfigFiles = runtimeConfigFiles.map((candidate) =>
      candidate.id === input.id ? file : candidate
    );

    return { file, diagnostics: [] };
  }
  const extraWorkspaces = new Map<string, Workspace>();
  let knowledgeEntries = [...workspaceResources.knowledge];
  let authRequired = options.authRequiredOnInit ?? false;
  let threadCounter = threads.size + 1;
  let turnCounter = 1;
  let artifactCounter = 1;
  let automationRecords: Awaited<ReturnType<CoreClient['app']['listAutomations']>>['items'] = [
    {
      id: 'auto_1',
      name: 'Nightly protocol sweep',
      workspaceId: workspace.id,
      cron: '0 2 * * *',
      prompt: 'Summarize open workspace risks.',
      status: 'paused',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  let openAICodexOAuthStatus: Awaited<
    ReturnType<CoreClient['oauth']['openaiCodex']['getAccountStatus']>
  > = {
    providerId: 'openai_codex',
    accountSlotId: 'default',
    boundProviderIds: [],
    isDefault: true,
    status: 'logged_out',
  };

  /**
   * Emits one event to active turn listeners.
   */
  function emit(
    turnId: string,
    event: Omit<TurnEvent, 'protocolVersion' | 'requestId'> & {
      requestId?: TurnEvent['requestId'];
    }
  ): void {
    const envelope: TurnEvent = {
      ...event,
      protocolVersion: PROTOCOL_VERSION,
      requestId: event.requestId ?? null,
    };

    eventHistory.set(turnId, [...(eventHistory.get(turnId) ?? []), envelope]);

    for (const listener of listeners.get(turnId) ?? []) {
      listener(envelope);
    }
  }

  /**
   * Creates the deterministic event stream for a started turn.
   */
  function publishInitialTurnEvents(turn: Turn): void {
    const input = turnInputs.get(turn.id) ?? '';
    const userItem: Item = {
      id: `it_user_${turn.id}`,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'user-message',
      status: 'completed',
      text: input,
      createdAt: turn.startedAt ?? timestamp,
      completedAt: turn.startedAt ?? timestamp,
    };
    const assistantItem: Item = {
      id: `it_assistant_${turn.id}`,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'in_progress',
      text: '',
      createdAt: turn.startedAt ?? timestamp,
      completedAt: null,
    };
    const approval: ApprovalRequest = {
      id: `ap_${turn.id}`,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Approve workspace update',
      description: 'Allow the planner to create a protocol review artifact.',
      createdAt: turn.startedAt ?? timestamp,
      resolvedAt: null,
    };
    const approvalItem: Item = {
      id: `it_approval_request_${turn.id}`,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: approval.id,
      title: approval.title,
      description: approval.description,
      kind: approval.kind,
      createdAt: turn.startedAt ?? timestamp,
      completedAt: turn.startedAt ?? timestamp,
    };

    approvals.set(approval.id, approval);

    queueMicrotask(() => {
      emit(turn.id, {
        event: 'turn.started',
        sequence: 1,
        timestamp: turn.startedAt ?? timestamp,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        data: { type: 'turn-started', turnId: turn.id, status: 'running' },
      });
      emit(turn.id, {
        event: 'item.created',
        sequence: 2,
        timestamp: turn.startedAt ?? timestamp,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        data: { type: 'item-created', item: userItem },
      });
      emit(turn.id, {
        event: 'item.created',
        sequence: 3,
        timestamp: turn.startedAt ?? timestamp,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        data: { type: 'item-created', item: assistantItem },
      });
      emit(turn.id, {
        event: 'item.delta',
        sequence: 4,
        timestamp: turn.startedAt ?? timestamp,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        data: {
          type: 'item-delta',
          itemId: assistantItem.id,
          itemType: 'assistant-message',
          deltaKind: 'text-delta',
          delta: `Reviewing ${threads.get(turn.threadId)?.name ?? 'thread'}...`,
        },
      });
      const awaitingApprovalTurn: Turn = {
        ...turn,
        status: 'awaiting_human',
        humanGate: {
          kind: 'approval',
          approvalRequestId: approval.id,
          itemId: approvalItem.id,
        },
        items: [userItem, assistantItem, approvalItem],
      };
      turns.set(turn.id, awaitingApprovalTurn);
      emit(turn.id, {
        event: 'item.created',
        sequence: 5,
        timestamp: '2026-04-15T09:00:01.000Z',
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        data: { type: 'item-created', item: approvalItem },
      });
      emit(turn.id, {
        event: 'item.completed',
        sequence: 6,
        timestamp: '2026-04-15T09:00:01.000Z',
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        data: { type: 'item-completed', itemId: approvalItem.id, item: approvalItem },
      });
      emit(turn.id, {
        event: 'approval.requested',
        sequence: 7,
        timestamp: '2026-04-15T09:00:01.000Z',
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        data: { type: 'approval-requested', approval },
      });
      emit(turn.id, {
        event: 'turn.updated',
        sequence: 8,
        timestamp: '2026-04-15T09:00:01.000Z',
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        data: { type: 'turn-updated', turn: awaitingApprovalTurn },
      });
    });
  }

  /**
   * Publishes the deterministic completion branch after approval.
   */
  function publishApprovalResolution(
    approvalRequestId: string,
    decision: 'granted' | 'denied'
  ): ApprovalRequest {
    const approval = approvals.get(approvalRequestId);

    if (!approval) {
      throw new Error(`Approval not found: ${approvalRequestId}`);
    }

    const resolvedApproval: ApprovalRequest = {
      ...approval,
      status: decision,
      resolvedAt: '2026-04-15T09:00:02.000Z',
    };
    const existingTurn = turns.get(approval.turnId);

    if (!existingTurn) {
      throw new Error(`Turn not found: ${approval.turnId}`);
    }

    approvals.set(approvalRequestId, resolvedApproval);

    queueMicrotask(() => {
      const decisionItem: Item = {
        id: `it_approval_decision_${approvalRequestId}`,
        workspaceId: approval.workspaceId,
        threadId: approval.threadId,
        turnId: approval.turnId,
        type: 'approval-decision',
        status: 'completed',
        approvalRequestId,
        decision,
        createdAt: resolvedApproval.resolvedAt!,
        completedAt: resolvedApproval.resolvedAt!,
      };
      emit(approval.turnId, {
        event: 'item.created',
        sequence: 9,
        timestamp: resolvedApproval.resolvedAt!,
        workspaceId: approval.workspaceId,
        threadId: approval.threadId,
        turnId: approval.turnId,
        data: { type: 'item-created', item: decisionItem },
      });
      emit(approval.turnId, {
        event: 'item.completed',
        sequence: 10,
        timestamp: resolvedApproval.resolvedAt!,
        workspaceId: approval.workspaceId,
        threadId: approval.threadId,
        turnId: approval.turnId,
        data: { type: 'item-completed', itemId: decisionItem.id, item: decisionItem },
      });
      emit(approval.turnId, {
        event: 'approval.resolved',
        sequence: 11,
        timestamp: '2026-04-15T09:00:02.000Z',
        workspaceId: approval.workspaceId,
        threadId: approval.threadId,
        turnId: approval.turnId,
        data: { type: 'approval-resolved', approval: resolvedApproval },
      });
      if (decision === 'denied') {
        const failedTurn: Turn = {
          ...existingTurn,
          status: 'failed',
          humanGate: null,
          completedAt: '2026-04-15T09:00:03.000Z',
          durationMs: 3000,
        };
        turns.set(failedTurn.id, failedTurn);
        emit(approval.turnId, {
          event: 'turn.completed',
          sequence: 12,
          timestamp: failedTurn.completedAt!,
          workspaceId: approval.workspaceId,
          threadId: approval.threadId,
          turnId: approval.turnId,
          data: { type: 'turn-completed', turn: failedTurn },
        });
        return;
      }

      const questionItem: Item = {
        id: `it_user_input_request_${approval.turnId}`,
        workspaceId: approval.workspaceId,
        threadId: approval.threadId,
        turnId: approval.turnId,
        type: 'user-input-request',
        status: 'completed',
        userInputRequestId: `question_${approval.turnId}`,
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
        createdAt: '2026-04-15T09:00:03.000Z',
        completedAt: '2026-04-15T09:00:03.000Z',
      };
      const pausedTurn: Turn = {
        ...existingTurn,
        status: 'awaiting_human',
        humanGate: {
          kind: 'user-input',
          userInputRequestId: `question_${approval.turnId}`,
          itemId: questionItem.id,
        },
      };
      turns.set(pausedTurn.id, pausedTurn);
      emit(approval.turnId, {
        event: 'item.created',
        sequence: 12,
        timestamp: '2026-04-15T09:00:03.000Z',
        workspaceId: approval.workspaceId,
        threadId: approval.threadId,
        turnId: approval.turnId,
        data: { type: 'item-created', item: questionItem },
      });
      emit(approval.turnId, {
        event: 'item.completed',
        sequence: 13,
        timestamp: '2026-04-15T09:00:03.000Z',
        workspaceId: approval.workspaceId,
        threadId: approval.threadId,
        turnId: approval.turnId,
        data: { type: 'item-completed', itemId: questionItem.id, item: questionItem },
      });
      emit(approval.turnId, {
        event: 'turn.updated',
        sequence: 14,
        timestamp: '2026-04-15T09:00:03.000Z',
        workspaceId: approval.workspaceId,
        threadId: approval.threadId,
        turnId: approval.turnId,
        data: { type: 'turn-updated', turn: pausedTurn },
      });
    });

    return resolvedApproval;
  }

  /**
   * Publishes the deterministic answer branch after an agent question response.
   */
  function publishUserInputResponse(input: Parameters<CoreClient['core']['startTurn']>[0]): Turn {
    if (!input.turnId) {
      throw new Error('turnId is required for fake user-input responses');
    }

    const existingTurn = turns.get(input.turnId);

    if (!existingTurn) {
      throw new Error(`Turn not found: ${input.turnId}`);
    }

    const responseItem: Item = {
      id: `it_user_input_response_${input.turnId}`,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: input.turnId,
      type: 'user-input-response',
      status: 'completed',
      userInputRequestId: `question_${input.turnId}`,
      answers: { tone: [input.input] },
      createdAt: '2026-04-15T09:00:04.000Z',
      completedAt: '2026-04-15T09:00:04.000Z',
    };
    const artifact: Artifact = {
      id: `ar_${artifactCounter++}`,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: input.turnId,
      kind: 'summary',
      title: 'Protocol review summary',
      status: 'ready',
      summary: `Workspace protocol review completed with ${input.input}.`,
      version: 1,
      content: {
        format: 'text',
        body: `Workspace protocol review completed with ${input.input}.`,
      },
      createdAt: '2026-04-15T09:00:05.000Z',
      updatedAt: '2026-04-15T09:00:05.000Z',
    };
    const completedTurn: Turn = {
      ...existingTurn,
      status: 'completed',
      humanGate: null,
      completedAt: '2026-04-15T09:00:06.000Z',
      durationMs: 6000,
    };

    turns.set(completedTurn.id, completedTurn);
    artifacts.set(artifact.id, artifact);
    queueMicrotask(() => {
      emit(input.turnId!, {
        event: 'item.created',
        sequence: 15,
        timestamp: responseItem.createdAt,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: input.turnId!,
        data: { type: 'item-created', item: responseItem },
      });
      emit(input.turnId!, {
        event: 'item.completed',
        sequence: 16,
        timestamp: responseItem.completedAt!,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: input.turnId!,
        data: { type: 'item-completed', itemId: responseItem.id, item: responseItem },
      });
      emit(input.turnId!, {
        event: 'artifact.created',
        sequence: 17,
        timestamp: artifact.createdAt,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: input.turnId!,
        data: { type: 'artifact-created', artifact },
      });
      emit(input.turnId!, {
        event: 'turn.completed',
        sequence: 18,
        timestamp: completedTurn.completedAt!,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: input.turnId!,
        data: { type: 'turn-completed', turn: completedTurn },
      });
    });

    return completedTurn;
  }

  const createThread: CoreClient['core']['createThread'] = async (input) => {
    if (!input.name) {
      throw new Error('Thread name is required');
    }

    const thread: Thread = {
      id: `th_${threadCounter++}`,
      workspaceId: input.workspaceId,
      name: input.name,
      preview: input.name,
      status: 'active',
      createdAt: '2026-04-15T09:20:00.000Z',
      updatedAt: '2026-04-15T09:20:00.000Z',
    };
    threads.set(thread.id, thread);
    return thread;
  };

  const implementations: FakeClientImplementations = {
    emailSignUp: async () => ({
      token: 'session_token',
      user: {
        id: 'user_demo',
        email: 'user@example.com',
        name: 'Demo User',
        emailVerified: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        image: null,
      },
    }),
    emailSignIn: async (input) => {
      options.onSignIn?.(input);
      authRequired = false;
      return {
        redirect: false,
        token: 'session_token',
        url: null,
        user: {
          id: 'user_demo',
          email: input.email,
          name: 'Demo User',
          emailVerified: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          image: null,
        },
      };
    },
    emailSignOut: async () => {
      authRequired = true;
      return { success: true };
    },
    meta: async () => META_RESPONSE,
    listWorkspaces: async () => {
      if (authRequired) {
        throw new ApiCallError(401, 'Authentication required.', {
          code: 'core.auth.unauthenticated',
        });
      }

      if (options.workspaceListError) {
        throw options.workspaceListError;
      }

      return {
        items: [
          {
            ...(extraWorkspaces.has(currentWorkspace.id) ? workspace : currentWorkspace),
            counts: {
              ...(extraWorkspaces.has(currentWorkspace.id)
                ? workspace.counts
                : currentWorkspace.counts),
              threadCount: threads.size,
              artifactCount: artifacts.size,
              knowledgeEntryCount: knowledgeEntries.length,
            },
          },
          ...extraWorkspaces.values(),
          quickChatWorkspace,
        ],
      };
    },
    createWorkspace: async (input) => {
      const createdWorkspace: Workspace = {
        ...workspace,
        id: 'ws_created',
        name: input.name,
        defaults: {
          defaultModelId: 'model_gpt_5_4',
          defaultAgentId: 'agent_planner',
          defaultSkillIds: [],
        },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
      };
      extraWorkspaces.set(createdWorkspace.id, createdWorkspace);
      return createdWorkspace;
    },
    getWorkspace: async (workspaceId) => {
      currentWorkspace =
        workspaceId === quickChatWorkspace.id
          ? quickChatWorkspace
          : (extraWorkspaces.get(workspaceId) ?? workspace);
      return currentWorkspace;
    },
    getWorkspaceResources: async (workspaceId) =>
      workspaceId === quickChatWorkspace.id || options.emptyWorkspaceResources
        ? { knowledge: [], skills: [], agents: [], models: [] }
        : { ...workspaceResources, knowledge: knowledgeEntries },
    updateWorkspace: async (_, input) => {
      currentWorkspace = {
        ...currentWorkspace,
        name: input.name ?? currentWorkspace.name,
        status: input.status ?? currentWorkspace.status,
        defaults: input.defaults
          ? {
              defaultModelId:
                input.defaults.defaultModelId ?? currentWorkspace.defaults?.defaultModelId ?? null,
              defaultAgentId:
                input.defaults.defaultAgentId ?? currentWorkspace.defaults?.defaultAgentId ?? null,
              defaultSkillIds:
                input.defaults.defaultSkillIds ?? currentWorkspace.defaults?.defaultSkillIds ?? [],
            }
          : currentWorkspace.defaults,
        updatedAt: '2026-04-15T09:05:00.000Z',
      };
      return currentWorkspace;
    },
    listKnowledge: async () => ({ items: knowledgeEntries }),
    createKnowledge: async (_, input) => {
      const entry = {
        id: `kn_${knowledgeEntries.length + 1}`,
        ...input,
        createdAt: '2026-04-15T09:10:00.000Z',
        updatedAt: '2026-04-15T09:10:00.000Z',
      };
      knowledgeEntries = [...knowledgeEntries, entry];
      return entry;
    },
    updateKnowledge: async (_, knowledgeEntryId, input) => {
      const currentEntry = knowledgeEntries.find((entry) => entry.id === knowledgeEntryId);

      if (!currentEntry) {
        throw new Error(`Knowledge entry not found: ${knowledgeEntryId}`);
      }

      const updatedEntry = {
        ...currentEntry,
        title: input.title ?? currentEntry.title,
        content: input.content ?? currentEntry.content,
        updatedAt: '2026-04-15T09:11:00.000Z',
      };
      knowledgeEntries = knowledgeEntries.map((entry) =>
        entry.id === knowledgeEntryId ? updatedEntry : entry
      );
      return updatedEntry;
    },
    deleteKnowledge: async (_, knowledgeEntryId, _input) => {
      knowledgeEntries = knowledgeEntries.filter((entry) => entry.id !== knowledgeEntryId);
    },
    listThreads: async (workspaceId) => ({
      items: [...threads.values()].filter((thread) => thread.workspaceId === workspaceId),
    }),
    createThread,
    getThread: async (_, threadId) => {
      const thread = threads.get(threadId);

      if (!thread) {
        throw new Error(`Thread not found: ${threadId}`);
      }

      return thread;
    },
    updateThread: async (input) => {
      const thread = threads.get(input.threadId);

      if (!thread) {
        throw new Error(`Thread not found: ${input.threadId}`);
      }

      const updatedThread: Thread = {
        ...thread,
        name: input.name === undefined ? thread.name : input.name,
        status: input.status ?? thread.status,
        updatedAt: '2026-04-15T09:21:00.000Z',
      };
      threads.set(updatedThread.id, updatedThread);
      return updatedThread;
    },
    archiveThread: async (input) => {
      const thread = threads.get(input.threadId);

      if (!thread) {
        throw new Error(`Thread not found: ${input.threadId}`);
      }

      const archivedThread: Thread = {
        ...thread,
        status: 'archived',
        updatedAt: '2026-04-15T09:22:00.000Z',
      };
      threads.set(archivedThread.id, archivedThread);
      return archivedThread;
    },
    startTurn: async (input) => {
      options.onTurnInput?.(input);
      if (input.turnId) {
        return publishUserInputResponse(input);
      }

      const turn: Turn = {
        id: `tu_${turnCounter++}`,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        items: [],
        status: 'running',
        humanGate: null,
        error: null,
        startedAt: '2026-04-15T09:30:00.000Z',
        completedAt: null,
        durationMs: null,
        configVersion: runtimeConfigVersion,
      };
      turnInputs.set(turn.id, input.input);
      turns.set(turn.id, turn);
      publishInitialTurnEvents(turn);
      return turn;
    },
    getTurn: async (_, __, turnId) => {
      const turn = turns.get(turnId);

      if (!turn) {
        throw new Error(`Turn not found: ${turnId}`);
      }

      return turn;
    },
    interruptTurn: async (input) => {
      options.onInterrupt?.(input);
      const turn = turns.get(input.turnId);

      if (!turn) {
        throw new Error(`Turn not found: ${input.turnId}`);
      }

      const interruptedTurn: Turn = {
        ...turn,
        status: 'interrupted',
        humanGate: null,
        completedAt: '2026-04-15T09:31:00.000Z',
        durationMs: 60_000,
      };
      turns.set(interruptedTurn.id, interruptedTurn);
      queueMicrotask(() => {
        emit(interruptedTurn.id, {
          event: 'turn.updated',
          sequence: 7,
          timestamp: interruptedTurn.completedAt!,
          workspaceId: interruptedTurn.workspaceId,
          threadId: interruptedTurn.threadId,
          turnId: interruptedTurn.id,
          data: { type: 'turn-updated', turn: interruptedTurn },
        });
      });
      return interruptedTurn;
    },
    respondApproval: async (approvalRequestId, input) => {
      options.onApproval?.({ ...input, approvalRequestId });
      return publishApprovalResolution(approvalRequestId, input.decision);
    },
    listArtifacts: async (workspaceId) => ({
      items: [...artifacts.values()].filter((artifact) => artifact.workspaceId === workspaceId),
    }),
    getArtifact: async (_, artifactId) => {
      const artifact = artifacts.get(artifactId);

      if (!artifact) {
        throw new Error(`Artifact not found: ${artifactId}`);
      }

      return artifact;
    },
    updateArtifactMetadata: async (input) => {
      const artifact = artifacts.get(input.artifactId);

      if (!artifact) {
        throw new Error(`Artifact not found: ${input.artifactId}`);
      }

      const updatedArtifact: Artifact = {
        ...artifact,
        title: input.title ?? artifact.title,
        status: input.status ?? artifact.status,
        summary: input.summary === undefined ? artifact.summary : input.summary,
        updatedAt: '2026-04-15T09:41:00.000Z',
      };
      artifacts.set(updatedArtifact.id, updatedArtifact);
      return updatedArtifact;
    },
    workspaceDashboard: async (workspaceId) => ({
      workspace: workspaceId === quickChatWorkspace.id ? quickChatWorkspace : currentWorkspace,
      counts: {
        threadCount: workspaceId === quickChatWorkspace.id ? 0 : 7,
        artifactCount: workspaceId === quickChatWorkspace.id ? 0 : 3,
        knowledgeEntryCount: workspaceId === quickChatWorkspace.id ? 0 : 2,
        providerCount: 2,
      },
      defaultContext: {
        modelId: 'model_gpt_5_4',
        agentId: 'agent_planner',
        skillIds: ['skill_protocol'],
      },
      agentHealth: [
        {
          agentId: 'agent_planner',
          status: 'ready',
          message: null,
          checkedAt: timestamp,
        },
        {
          agentId: 'agent_opencode',
          status: 'unknown',
          message: 'Not checked yet',
          checkedAt: null,
        },
      ],
      recentThreads: [...threads.values()],
      activeWork: [],
      recentCompletions: [],
      attentionNeeded: [],
    }),
    threadDashboard: async (_, threadId) => {
      const thread = threads.get(threadId);

      if (!thread) {
        throw new Error(`Thread not found: ${threadId}`);
      }
      const threadTurns = [...turns.values()].filter((turn) => turn.threadId === threadId);
      const threadArtifacts = [...artifacts.values()]
        .filter((artifact) => artifact.threadId === threadId)
        .map((artifact) => ({
          id: artifact.id,
          title: artifact.title,
          status: artifact.status,
          summary: artifact.summary,
          updatedAt: artifact.updatedAt,
        }));
      const activeTurn = threadTurns.findLast(
        (turn) =>
          turn.status !== 'completed' &&
          turn.status !== 'failed' &&
          turn.status !== 'interrupted' &&
          turn.status !== 'cancelled'
      );

      return {
        thread,
        activeSession: {
          id: `session_sim_${threadId}`,
          status: 'idle',
          message: null,
          configVersion: activeSessionStale ? runtimeConfigVersion - 1 : runtimeConfigVersion,
          workspaceRoots: [],
          stale: activeSessionStale,
          sandboxSummary: null,
          backend: {
            kind: 'openshell',
            health: 'ready',
            controlMode: 'sidecar',
            control: {
              heartbeat: {
                status: 'running',
                sequence: 4,
                lastHeartbeatAt: timestamp,
              },
              artifactNoticeCount: 1,
              queuedCommandCount: 2,
              deliveredCommandCount: 1,
              terminalResultCount: 1,
              lastTerminalExitCode: 0,
              lastTerminalCompletedAt: timestamp,
            },
            gatewayName: 'openshell',
            gatewayEndpoint: 'https://127.0.0.1:17670',
            version: '0.0.63',
            sandboxName: 'openkit-session-sim',
          },
        },
        turns: threadTurns,
        artifacts: threadArtifacts,
        workStatus: {
          currentMode: 'automation',
          selectedAgentId: 'agent_planner',
          activeTurnStatus: activeTurn?.status ?? 'idle',
          pendingApprovalCount: 0,
          pendingQuestionCount: 0,
          latestArtifact: threadArtifacts[0] ?? null,
          routing: {
            decision: 'worker_turn',
            explanation:
              'NanoCore routes thread prompts through WorkerCoordinator to the selected worker agent because automation changes workspace state.',
            selectedAgentId: 'agent_planner',
            confidence: 1,
            requiredUserAction: null,
          },
        },
        composer: {
          disabled: false,
          defaultModelId: 'model_gpt_5_4',
          defaultAgentId: 'agent_planner',
        },
        itemLog: {
          href: `/api/app/workspaces/${workspace.id}/threads/${threadId}/items`,
        },
      };
    },
    threadGoalSummary: async () => currentThreadGoalSummary,
    startThreadGoal: async (workspaceId, threadId, input) => {
      if (options.startThreadGoalError) {
        throw options.startThreadGoalError;
      }

      options.onStartThreadGoal?.(workspaceId, threadId, input);
      const goal: ThreadGoalSummary = {
        goalId: `goal_${threadId}`,
        workspaceId,
        threadId,
        status: 'planning',
        title: input.title ?? 'Demo goal',
        objective: input.objective,
        currentTask: null,
        taskCounts: {
          pending: 0,
          ready: 0,
          running: 0,
          reviewing: 0,
          needsRevision: 0,
          completed: 0,
          blocked: 0,
          failed: 0,
          skipped: 0,
        },
        pendingHumanAttention: {
          required: false,
          reason: null,
        },
        terminalState: null,
        steering: emptyGoalSteering(),
        updatedAt: timestamp,
      } as const;
      currentThreadGoalSummary = { goal };
      return {
        goal,
        objectiveItemId: `it_goal_${threadId}`,
      };
    },
    createThreadGoalPlan: async (workspaceId, threadId) => {
      options.onCreateThreadGoalPlan?.(workspaceId, threadId);
      const goal: ThreadGoalSummary = {
        goalId: `goal_${threadId}`,
        workspaceId,
        threadId,
        status: 'awaiting_plan_approval',
        title: 'Demo goal',
        objective: 'Validate Goal Mode UI fixtures.',
        currentTask: null,
        taskCounts: {
          pending: 0,
          ready: 0,
          running: 0,
          reviewing: 0,
          needsRevision: 0,
          completed: 0,
          blocked: 0,
          failed: 0,
          skipped: 0,
        },
        pendingHumanAttention: {
          required: true,
          reason: 'Plan approval is required.',
        },
        terminalState: null,
        steering: emptyGoalSteering(),
        updatedAt: timestamp,
      };
      const plan: ThreadGoalPlan = {
        schemaVersion: 1,
        goalSummary: 'Validate Goal Mode UI fixtures.',
        assumptions: [],
        tasks: [
          {
            taskId: 'task_1',
            title: 'Demo task',
            objective: 'Complete the deterministic demo task.',
            acceptanceCriteria: ['Demo task is complete.'],
            contextBudgetTokens: 12_000,
            resources: [],
            expectedArtifacts: [
              {
                kind: 'test-result',
                description: 'Goal Mode fixture test result.',
              },
            ],
            verificationChecks: [
              {
                kind: 'test',
                description: 'Run the deterministic fixture check.',
              },
            ],
            reviewPolicy: {
              required: true,
              reviewers: ['human'],
              instructions: 'Review the deterministic fixture output.',
            },
            dependsOnTaskIds: [],
            escalationConditions: [],
          },
        ],
        risks: [],
        questions: [],
        verificationApproach: 'Run the deterministic fixture check.',
      };
      currentThreadGoalSummary = { goal };
      return {
        status: 'awaiting_plan_approval',
        goal,
        planItemId: `it_plan_${threadId}`,
        planner: goalPlannerSummary(),
        plan,
      };
    },
    approveThreadGoalPlan: async (workspaceId, threadId, input) => {
      options.onApproveThreadGoalPlan?.(workspaceId, threadId, input);
      const goal: ThreadGoalSummary = {
        goalId: `goal_${threadId}`,
        workspaceId,
        threadId,
        status: 'running',
        title: 'Demo goal',
        objective: 'Validate Goal Mode UI fixtures.',
        currentTask: null,
        taskCounts: {
          pending: 0,
          ready: 1,
          running: 0,
          reviewing: 0,
          needsRevision: 0,
          completed: 0,
          blocked: 0,
          failed: 0,
          skipped: 0,
        },
        pendingHumanAttention: {
          required: false,
          reason: null,
        },
        terminalState: null,
        steering: emptyGoalSteering(),
        updatedAt: timestamp,
      };
      currentThreadGoalSummary = { goal };
      return {
        goal,
        readyTasks: [{ taskId: 'task_1', status: 'ready' }],
        startsWorkerTurn: false,
      };
    },
    runThreadGoalStep: async (workspaceId, threadId) => {
      options.onRunThreadGoalStep?.(workspaceId, threadId);
      const goal: ThreadGoalSummary = {
        goalId: `goal_${threadId}`,
        workspaceId,
        threadId,
        status: 'reviewing',
        title: 'Demo goal',
        objective: 'Validate Goal Mode UI fixtures.',
        currentTask: {
          taskId: 'task_1',
          title: 'Demo task',
          status: 'reviewing',
          orderIndex: 0,
        },
        taskCounts: {
          pending: 0,
          ready: 0,
          running: 0,
          reviewing: 1,
          needsRevision: 0,
          completed: 0,
          blocked: 0,
          failed: 0,
          skipped: 0,
        },
        pendingHumanAttention: {
          required: true,
          reason: 'Worker result needs review.',
        },
        terminalState: null,
        steering: emptyGoalSteering(),
        updatedAt: timestamp,
      };
      currentThreadGoalSummary = { goal };

      return {
        goal,
        worker: {
          turnId: `tu_goal_${threadId}`,
          stopReason: 'completed',
          checkpointStage: 'completed',
          workerSessionId: null,
          evidence: {
            itemIds: [`it_goal_${threadId}`],
            artifactIds: ['artifact_goal_result'],
          },
        },
        contextAssembly: goalStepContextAssembly(),
        coordinator: goalStepCoordinator(),
        decision: {
          schemaVersion: 1,
          mode: 'goal',
          sourceAgentId: 'worker-coordinator',
          requestId: 'req_goal_step_web_test',
          outcome: 'review',
          shouldStop: true,
          stopReason: 'completed',
          rationale: 'Worker result needs review before Goal Mode continues.',
          contextRefs: [
            { kind: 'workspace', id: workspaceId },
            { kind: 'thread', id: threadId },
          ],
          evidence: {
            itemIds: [`it_goal_${threadId}`],
            artifactIds: ['artifact_goal_result'],
          },
        },
        pendingAttention: {
          kind: 'review',
          reason: 'Worker result needs review.',
          itemId: `it_goal_${threadId}`,
        },
      };
    },
    submitThreadGoalSteering: async (workspaceId, threadId, input) => {
      options.onSubmitThreadGoalSteering?.(workspaceId, threadId, input);
      const currentGoal = currentThreadGoalSummary.goal;

      if (!currentGoal) {
        throw new Error('Thread does not have an active goal.');
      }

      const blocked = currentGoal.pendingHumanAttention.required;
      const goal: ThreadGoalSummary = {
        ...currentGoal,
        steering: {
          ...currentGoal.steering,
          pendingFollowUpCount: currentGoal.steering.pendingFollowUpCount + (blocked ? 1 : 0),
          pendingSteeringCount: currentGoal.steering.pendingSteeringCount + (blocked ? 0 : 1),
        },
      };

      currentThreadGoalSummary = { goal };

      return {
        state: blocked ? 'blocked' : 'queued',
        goal,
      };
    },
    submitArtifactReviewDecision: async (workspaceId, artifactId, input) => {
      options.onSubmitArtifactReviewDecision?.(workspaceId, artifactId, input);

      return {
        review: {
          artifactId,
          workspaceId,
          threadId: 'th_demo',
          turnId: 'turn_demo',
          status: input.decision,
          message: input.message ?? null,
          decidedAt: timestamp,
          followUpTurnId:
            input.decision === 'needs_refinement' || input.decision === 'redo'
              ? 'turn_follow_up'
              : null,
        },
      };
    },
    submitWorkspaceSyncReviewDecision: async (workspaceId, reviewId, input) => {
      options.onSubmitWorkspaceSyncReviewDecision?.(workspaceId, reviewId, input);

      return {
        review: {
          id: reviewId,
          changeSetId: 'wcs_demo',
          workspaceId,
          status: input.decision,
          staging: {
            strategy: 'git_worktree',
            ref: `staging://workspace/${reviewId}`,
            branch: `openkit/review/${reviewId}`,
          },
          diffSummary: { filesChanged: 1, additions: 1, deletions: 0 },
          riskSummary: '1 changed path staged for human review.',
          validation: [{ command: 'worker', status: 'passed', ref: 'turn_demo' }],
          actionCenterRowId: `workspace-review:${reviewId}`,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        workspaceApplyResult: null,
      };
    },
    submitGoalReviewDecision: async (workspaceId, threadId, goalId, reviewId, input = {}) => {
      options.onSubmitGoalReviewDecision?.(workspaceId, threadId, goalId, reviewId, input);

      return {
        review: {
          reviewId,
          workspaceId,
          threadId,
          goalId,
          taskId: 'task_demo',
          turnId: 'turn_demo',
          itemIds: [],
          artifactIds: ['artifact_demo'],
          verificationEvidence: [],
          verdict: 'refine',
          reason: 'Refine with stronger evidence.',
          createdAt: timestamp,
          updatedAt: timestamp,
          resolvedAt: timestamp,
          resolutionRequestId: input.requestId ?? 'goal-review-request',
        },
        advance: {
          outcome: 'needs_revision',
          task: { taskId: 'task_demo', status: 'needs_revision' },
          goal: null,
          nextTask: null,
        },
      };
    },
    queueAgentSessionTerminalCommand: async (workspaceId, threadId, agentSessionId, input) => {
      options.onQueueAgentSessionTerminalCommand?.(workspaceId, threadId, agentSessionId, input);

      return {
        command: {
          commandId: input.requestId,
          kind: 'terminal-command',
          sequence: 3,
          queuedAt: timestamp,
          deliveredAt: null,
          argv: input.argv,
          cwd: input.cwd,
        },
      };
    },
    refreshAgentHealth: async (workspaceId) => {
      options.onRefreshAgentHealth?.(workspaceId);
      const refreshedAt = '2026-04-15T09:05:00.000Z';
      const items = workspaceResources.agents.map((agent) => ({
        agentId: agent.id,
        status: 'ready',
        message: null,
        checkedAt: refreshedAt,
      }));

      workspaceResources.agents = workspaceResources.agents.map((agent) => ({
        ...agent,
        health: {
          ...agent.health,
          status: 'ready',
          message: null,
          checkedAt: refreshedAt,
        },
      }));

      return {
        items,
        sessions: [...threads.values()]
          .filter((thread) => thread.workspaceId === workspaceId)
          .map((thread) => ({
            id: `session_sim_${thread.id}`,
            status: 'idle' as const,
            message: null,
            configVersion: activeSessionStale ? runtimeConfigVersion - 1 : runtimeConfigVersion,
            workspaceRoots: [],
            stale: activeSessionStale,
            sandboxSummary: null,
            backend: null,
          })),
      };
    },
    listThreadItems: async (_, threadId) => ({
      items: replayItems.get(threadId) ?? [],
      nextCursor: null,
    }),
    appDiagnostics: async () => ({
      service: 'nanocore',
      boot: bootReadiness(),
      gateway: {
        status: 'ok',
        endpoints: ['/health', '/v1/models', '/v1/chat/completions'],
      },
      providers: {
        diagnostics: [
          {
            code: 'invalid-provider-profile',
            message: '2 models available.',
            profileId: 'openai',
            source: 'config/providers/openai.provider.jsonc',
            status: 'blocked',
          },
        ],
        registry: [
          {
            id: 'openai',
            displayName: 'OpenAI',
            gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
            kind: 'gateway',
            models: ['gpt-5.4'],
          },
        ],
      },
      defaultProviders: options.appDiagnosticsDefaultProviders ?? {
        core: {
          configured: true,
          model: 'gpt-5.4',
          origin: 'canonical',
          providerId: 'openai',
        },
        gateway: {
          configured: false,
          origin: 'unset',
          reason: 'unset',
        },
      },
      defaults: {
        quickChat: { providerId: 'openai', model: 'gpt-5.4' },
        internalTasks: { providerId: null, model: null },
        gateway: { providerId: null, model: null },
      },
      oauth: {
        openaiCodexAccounts: options.codexOAuthAccounts ?? {
          accounts: [
            {
              ...openAICodexOAuthStatus,
            },
          ],
          defaultAccountSlotId: 'default',
        },
      },
      capabilities: META_RESPONSE.capabilities,
      runtimeConfig: runtimeConfigStatus(),
      internalAgents: options.appDiagnosticsInternalAgents ?? {
        agents: [],
        recentFailures: [],
        recentHookFailures: [],
      },
    }),
    oauthAccounts: async () =>
      options.codexOAuthAccounts ?? {
        accounts: [
          {
            ...openAICodexOAuthStatus,
          },
        ],
        defaultAccountSlotId: 'default',
      },
    oauthCreateAccount: async (input) => {
      if (options.createCodexOAuthAccountError) {
        throw options.createCodexOAuthAccountError;
      }

      return {
        accountSlotId: input.accountSlotId,
        boundProviderIds: [],
        displayName: input.displayName,
        isDefault: false,
        providerId: 'openai_codex',
        status: 'logged_out',
      };
    },
    oauthUpdateAccount: async (accountSlotId, input) => ({
      accountSlotId,
      boundProviderIds: [],
      displayName: input.displayName,
      isDefault: false,
      providerId: 'openai_codex',
      status: 'logged_out',
    }),
    oauthDeleteAccount: async () => undefined,
    oauthAccountStatus: async (accountSlotId) => ({
      ...openAICodexOAuthStatus,
      accountSlotId,
      boundProviderIds: [],
      isDefault: accountSlotId === 'default',
    }),
    oauthStartAccount: async (accountSlotId, input = {}) => {
      options.onStartOpenAICodexOAuth?.(accountSlotId, input);
      openAICodexOAuthStatus = {
        accountSlotId,
        authUrl: input.mode === 'device_code' ? undefined : 'https://chatgpt.com/auth/codex/login',
        boundProviderIds: [],
        isDefault: accountSlotId === 'default',
        loginId: `login_${accountSlotId}`,
        mode: input.mode ?? 'browser',
        providerId: 'openai_codex',
        status: 'pending',
        userCode: input.mode === 'device_code' ? 'OPEN-KIT' : undefined,
        verificationUrl: input.mode === 'device_code' ? 'https://chatgpt.com/activate' : undefined,
      };

      return openAICodexOAuthStatus;
    },
    oauthCancelAccount: async (accountSlotId) => {
      openAICodexOAuthStatus = {
        accountSlotId,
        boundProviderIds: [],
        isDefault: accountSlotId === 'default',
        providerId: 'openai_codex',
        status: 'logged_out',
      };
      return openAICodexOAuthStatus;
    },
    oauthLogoutAccount: async (accountSlotId) => {
      openAICodexOAuthStatus = {
        accountSlotId,
        boundProviderIds: [],
        isDefault: accountSlotId === 'default',
        providerId: 'openai_codex',
        status: 'logged_out',
      };
      return openAICodexOAuthStatus;
    },
    setupDiagnostics: async () => {
      options.onSetupDiagnostics?.();

      return (
        options.setupDiagnostics ?? {
          service: 'nanocore',
          server: {
            mode: 'local',
            dataRoot: 'configured',
            config: {
              schemaVersion: 1,
              defaults: {
                coreProviderId: 'agent-openrouter',
                gatewayProviderId: 'agent-openrouter',
              },
              gateway: {
                openaiCompatible: {
                  auth: { configured: false, marker: 'none', ref: null },
                  defaultModel: null,
                  defaultProviderId: 'agent-openrouter',
                  enabled: true,
                  route: '/v1',
                },
              },
            },
          },
          providers: [
            {
              id: 'agent-openrouter',
              displayName: 'Agent OpenRouter',
              kind: 'direct',
              vendor: 'openrouter',
              role: 'core+gateway',
              defaultModel: 'openai/gpt-5.2',
              secret: {
                configured: true,
                marker: 'secret-ref',
                ref: 'env:OPENROUTER_API_KEY',
              },
            },
          ],
          runtimeConfig: runtimeConfigStatus(),
          agents: [
            {
              id: 'agent_codex_host',
              displayName: 'Codex Host Agent',
              readiness: {
                status: 'ready',
                reasons: [],
              },
              setup: {
                status: 'ready',
                deploymentMode: 'host',
                providerId: 'agent-openrouter',
                diagnostics: [],
              },
            },
          ],
        }
      );
    },
    runtimeReload: async (input = {}) => {
      options.onReloadRuntimeConfig?.(input);
      const previousVersion = runtimeConfigVersion;
      const nextVersion = previousVersion + 1;
      const dryRun = input.dryRun ?? false;

      if (!dryRun) {
        runtimeConfigVersion = nextVersion;
        activeSessionStale = true;
      }

      return {
        status: dryRun ? 'dry-run' : 'applied',
        runtimeConfig: runtimeConfigStatus(),
        plan: {
          previousVersion,
          nextVersion,
          applied: dryRun
            ? []
            : [
                {
                  path: 'providers',
                  category: 'hot-swappable',
                  action: 'applied',
                  summary: 'Provider config changed.',
                },
              ],
          deferred: [],
          requiresRestart: [],
          rejected: [],
          warnings: [],
        },
      };
    },
    runtimeListFiles: async () => ({
      files: runtimeConfigFiles,
    }),
    runtimeGetFile: async (id) => readRuntimeConfigFile(id),
    runtimeCreateFile: async (input) => {
      if (runtimeConfigFiles.some((file) => file.id === input.id)) {
        throw new ApiCallError(409, 'Runtime config file already exists.', {
          code: 'config_file_exists',
        });
      }

      const content =
        input.content ??
        (input.kind === 'workspace'
          ? [
              '{',
              '  "schemaVersion": 1,',
              '  "workspace": {',
              '    "roots": []',
              '  }',
              '}',
              '',
            ].join('\n')
          : input.kind === 'provider'
            ? [
                '{',
                '  "id": "new-provider",',
                '  "displayName": "New Provider",',
                '  "secretRef": "env:NEW_PROVIDER_API_KEY"',
                '}',
                '',
              ].join('\n')
            : [
                '{',
                '  "id": "new-agent",',
                '  "displayName": "New Agent",',
                '  "providerId": "agent-openrouter"',
                '}',
                '',
              ].join('\n'));
      const file: RuntimeConfigFileSummary = {
        id: input.id,
        kind: input.kind,
        path: input.id,
        exists: true,
        revision: nextRuntimeConfigRevision(),
        updatedAt: '2026-04-15T09:07:00.000Z',
      };
      runtimeConfigFiles = [...runtimeConfigFiles, file];
      runtimeConfigContents.set(input.id, content);

      return { file, diagnostics: [] };
    },
    runtimeUpdateFile: async (input) => {
      if (options.runtimeConfigConflictOnSave) {
        throw new ApiCallError(409, 'Runtime config file changed on disk.', {
          code: 'config_revision_conflict',
        });
      }

      return writeRuntimeConfigFile(input);
    },
    runtimeValidate: async (input) => {
      await options.onValidateRuntimeConfig?.(input);
      const draft = input.files[0];

      if (!draft) {
        return validateRuntimeConfigSource('', 'server.jsonc');
      }

      return validateRuntimeConfigSource(draft.content, draft.id);
    },
    runtimeSchemas: async () => runtimeConfigSchemaCatalog,
    automationList: async () => ({
      items: automationRecords,
    }),
    automationCreate: async (input) => {
      const automation = {
        id: `auto_${automationRecords.length + 1}`,
        ...input,
        status: 'paused' as const,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      automationRecords = [...automationRecords, automation];
      return automation;
    },
    automationUpdate: async (automationId, input) => {
      const automation = automationRecords.find((item) => item.id === automationId);

      if (!automation) {
        throw new Error(`Automation not found: ${automationId}`);
      }

      const updatedAutomation = { ...automation, ...input, updatedAt: timestamp };
      automationRecords = automationRecords.map((item) =>
        item.id === automationId ? updatedAutomation : item
      );
      return updatedAutomation;
    },
    automationDelete: async (automationId) => {
      automationRecords = automationRecords.filter((item) => item.id !== automationId);
    },
    quickChat: async (input) => {
      if (options.quickChatError) {
        throw options.quickChatError;
      }

      return {
        id: 'chat_1',
        status: 'completed',
        workspaceId: input.workspaceId ?? 'ws_quick_chat',
        providerId: input.providerId ?? 'openai',
        model: input.model ?? 'gpt-5.4',
        content: `Quick response: ${input.input}`,
      };
    },
    appSearch: async (query) => ({
      items: query.toLowerCase().includes('protocol')
        ? [
            {
              kind: 'thread',
              id: 'th_demo',
              title: 'Protocol design review',
              workspaceId: workspace.id,
              threadId: 'th_demo',
            },
            {
              kind: 'knowledge',
              id: 'kn_project',
              title: 'Product focus',
              workspaceId: workspace.id,
            },
          ]
        : [],
    }),
    turnFeedback: async (turnId, input) => ({
      turnId,
      agentId: 'agent_planner',
      rating: input.rating,
      note: input.note,
      createdAt: timestamp,
    }),
    listHumanAttention: async () => ({ items: options.humanAttention ?? [] }),
    subscribeTurnEvents: ({ turnId }) => ({
      [Symbol.asyncIterator]: () => {
        let index = 0;
        let active = true;

        return {
          next: async () => {
            while (active) {
              const events = eventHistory.get(turnId) ?? [];

              if (index < events.length) {
                return { value: events[index++], done: false };
              }

              await new Promise<void>((resolve) => {
                const listener = () => {
                  listeners.get(turnId)?.delete(listener);
                  resolve();
                };
                const turnListeners =
                  listeners.get(turnId) ?? new Set<(event: TurnEvent) => void>();
                turnListeners.add(listener);
                listeners.set(turnId, turnListeners);
              });
            }

            return { value: undefined, done: true };
          },
          return: async () => {
            active = false;
            return { value: undefined, done: true };
          },
        };
      },
    }),
  };

  return {
    core: {
      meta: implementations.meta,
      listWorkspaces: implementations.listWorkspaces,
      createWorkspace: implementations.createWorkspace,
      getWorkspace: implementations.getWorkspace,
      getWorkspaceResources: implementations.getWorkspaceResources,
      updateWorkspace: implementations.updateWorkspace,
      listKnowledge: implementations.listKnowledge,
      createKnowledge: implementations.createKnowledge,
      updateKnowledge: implementations.updateKnowledge,
      deleteKnowledge: implementations.deleteKnowledge,
      listThreads: implementations.listThreads,
      createThread: implementations.createThread,
      getThread: implementations.getThread,
      updateThread: implementations.updateThread,
      archiveThread: implementations.archiveThread,
      startTurn: implementations.startTurn,
      getTurn: implementations.getTurn,
      interruptTurn: implementations.interruptTurn,
      respondApproval: implementations.respondApproval,
      listArtifacts: implementations.listArtifacts,
      getArtifact: implementations.getArtifact,
      updateArtifactMetadata: implementations.updateArtifactMetadata,
      listThreadItems: implementations.listThreadItems,
      subscribeTurnEvents: implementations.subscribeTurnEvents,
    },
    app: {
      getWorkspaceDashboard: implementations.workspaceDashboard,
      getThreadDashboard: implementations.threadDashboard,
      getThreadGoalSummary: implementations.threadGoalSummary,
      startThreadGoal: implementations.startThreadGoal,
      createThreadGoalPlan: implementations.createThreadGoalPlan,
      approveThreadGoalPlan: implementations.approveThreadGoalPlan,
      reviseThreadGoalPlan: async () => {
        throw new Error('Goal plan revision fixture not configured.');
      },
      pauseThreadGoal: async () => {
        throw new Error('Goal pause fixture not configured.');
      },
      resumeThreadGoal: async () => {
        throw new Error('Goal resume fixture not configured.');
      },
      runThreadGoalStep: implementations.runThreadGoalStep,
      startTaskMode: async () => {
        throw new Error('Task Mode fixture not configured.');
      },
      startChatMode: async () => {
        throw new Error('Chat Mode fixture not configured.');
      },
      answerKnowledgeManager: async () => {
        throw new Error('Knowledge Manager answer fixture not configured.');
      },
      registerKnowledgeSource: async () => {
        throw new Error('Knowledge source fixture not configured.');
      },
      listKnowledgeSources: async () => {
        throw new Error('Knowledge sources fixture not configured.');
      },
      readKnowledgeSource: async () => {
        throw new Error('Knowledge source fixture not configured.');
      },
      readKnowledgeIndexes: async () => {
        throw new Error('Knowledge indexes fixture not configured.');
      },
      retrieveKnowledge: async () => {
        throw new Error('Knowledge retrieval fixture not configured.');
      },
      recordKnowledgeObservation: async () => {
        throw new Error('Knowledge observation fixture not configured.');
      },
      listKnowledgeObservations: async () => {
        throw new Error('Knowledge observations fixture not configured.');
      },
      recordKnowledgeClaim: async () => {
        throw new Error('Knowledge claim fixture not configured.');
      },
      listKnowledgeClaims: async () => {
        throw new Error('Knowledge claims fixture not configured.');
      },
      promoteKnowledgeClaim: async () => {
        throw new Error('Knowledge claim promotion fixture not configured.');
      },
      recordKnowledgeConflict: async () => {
        throw new Error('Knowledge conflict fixture not configured.');
      },
      resolveKnowledgeConflict: async () => {
        throw new Error('Knowledge conflict resolution fixture not configured.');
      },
      listKnowledgeConflicts: async () => {
        throw new Error('Knowledge conflicts fixture not configured.');
      },
      prepareKnowledgeContext: async () => {
        throw new Error('Knowledge Manager context fixture not configured.');
      },
      readKnowledgeContextPackageTrace: async () => {
        throw new Error('Knowledge context package trace fixture not configured.');
      },
      materializeKnowledgeContextPackage: async () => {
        throw new Error('Knowledge context package materialization fixture not configured.');
      },
      readKnowledgeContextPackageMaterialization: async () => {
        throw new Error('Knowledge context package materialization fixture not configured.');
      },
      draftKnowledgeProposal: async () => {
        throw new Error('Knowledge proposal fixture not configured.');
      },
      suggestKnowledgeRepairs: async () => {
        throw new Error('Knowledge repair fixture not configured.');
      },
      checkKnowledgeHealth: async () => {
        throw new Error('Knowledge health fixture not configured.');
      },
      submitThreadGoalSteering: implementations.submitThreadGoalSteering,
      submitArtifactReviewDecision: implementations.submitArtifactReviewDecision,
      submitWorkspaceSyncReviewDecision: implementations.submitWorkspaceSyncReviewDecision,
      submitWorkspaceRecoveryDecision: async () => {
        throw new Error('Workspace recovery decision fixture not configured.');
      },
      submitGoalReviewDecision: implementations.submitGoalReviewDecision,
      submitKnowledgeProposalDecision: async () => {
        throw new Error('Knowledge proposal decision fixture not configured.');
      },
      listWorkspaceSyncReviews: async () => ({ items: [] }),
      getWorkspaceSyncReview: async () => {
        throw new Error('Workspace sync review fixture not found.');
      },
      listWorkspaceInputSnapshots: async () => ({ items: [] }),
      listWorkspaceMaterializationRecords: async () => ({ items: [] }),
      listBackendWorkspaceHandles: async () => ({ items: [] }),
      listWorkerOutputManifests: async () => ({ items: [] }),
      listWorkspaceChangeSets: async () => ({ items: [] }),
      listStagedWorkspaceReviews: async () => ({ items: [] }),
      listWorkspaceApplyPlans: async () => ({ items: [] }),
      listWorkspaceReconciliationRecords: async () => ({ items: [] }),
      listWorkspaceQuarantineRecords: async () => ({ items: [] }),
      listWorkspaceSyncEvidenceBundles: async () => ({ items: [] }),
      listWorkspaceApplyResults: async () => ({ items: [] }),
      getWorkspaceApplyResult: async () => {
        throw new Error('Workspace apply result fixture not found.');
      },
      listAgentEnvironmentPackageSnapshots: async () => ({ items: [] }),
      getAgentEnvironmentPackageSnapshot: async () => {
        throw new Error('Agent Environment Package snapshot fixture not found.');
      },
      queueAgentSessionTerminalCommand: implementations.queueAgentSessionTerminalCommand,
      refreshAgentHealth: implementations.refreshAgentHealth,
      getDiagnostics: implementations.appDiagnostics,
      getSetupDiagnostics: implementations.setupDiagnostics,
      getStorageLayoutReport: async () => {
        throw new Error('Storage layout fixture not configured.');
      },
      consumeBootstrapToken: async () => {
        throw new Error('Bootstrap token fixture not configured.');
      },
      listOpenKitAccessTokens: async () => ({ items: [] }),
      createOpenKitAccessToken: async () => {
        throw new Error('OpenKit access-token fixture not configured.');
      },
      revokeOpenKitAccessToken: async () => {
        throw new Error('OpenKit access-token revoke fixture not configured.');
      },
      rotateOpenKitAccessToken: async () => {
        throw new Error('OpenKit access-token rotation fixture not configured.');
      },
      getVaultAdminStatus: async () => {
        throw new Error('Vault admin fixture not configured.');
      },
      unlockVaultAdminBackend: async () => {
        throw new Error('Vault unlock fixture not configured.');
      },
      lockVaultAdminBackend: async () => {
        throw new Error('Vault lock fixture not configured.');
      },
      bootstrapCodexAuthJsonVaultReference: async () => {
        throw new Error('Vault bootstrap fixture not configured.');
      },
      getCapabilityUsage: async (workspaceId) => ({
        workspaceId,
        capabilityCalls: [],
        usageRecords: [],
      }),
      createEvidenceBundle: async () => {
        throw new Error('Evidence bundle fixture not configured.');
      },
      listWorkspaceEvidenceBundles: async (workspaceId) => ({ evidenceBundles: [], workspaceId }),
      listWorkspaceRuntimeEvidence: async (workspaceId) => ({ runtimeEvidence: [], workspaceId }),
      listWorkspaceAuditEvents: async (workspaceId) => ({ auditEvents: [], workspaceId }),
      listServerAuditEvents: async () => ({ auditEvents: [] }),
      listWorkspacePermissionDecisions: async (workspaceId) => ({
        permissionDecisions: [],
        workspaceId,
      }),
      listServerPermissionDecisions: async () => ({ permissionDecisions: [] }),
      createDataRootBackup: async () => {
        throw new Error('Data-root backup fixture not configured.');
      },
      verifyDataRootBackup: async () => {
        throw new Error('Data-root backup verification fixture not configured.');
      },
      exportWorkspace: async () => {
        throw new Error('Workspace export fixture not configured.');
      },
      dryRunWorkspaceImport: async () => {
        throw new Error('Workspace import dry-run fixture not configured.');
      },
      importWorkspace: async () => {
        throw new Error('Workspace import fixture not configured.');
      },
      listWorkspaceVaultReferences: async (workspaceId) => ({
        items: vaultReferences,
        workspaceId,
      }),
      listWorkspaceVaultGrants: async (workspaceId) => ({ items: [], workspaceId }),
      listWorkspaceInjectionPlans: async (workspaceId) => ({ items: [], workspaceId }),
      listWorkspaceInjectionReceipts: async (workspaceId) => ({ items: [], workspaceId }),
      listWorkspaceVaultUseRecords: async (workspaceId) => ({ vaultUseRecords: [], workspaceId }),
      listServerVaultUseRecords: async () => ({ vaultUseRecords: [] }),
      rebindWorkspaceVaultReference: async (workspaceId, referenceId, input) => {
        options.onRebindWorkspaceVaultReference?.(workspaceId, referenceId, input);
        const rebound = {
          workspaceId,
          referenceId,
          ownerScope: 'workspace' as const,
          secretKind: 'api-token',
          backendKind: 'encrypted-file' as const,
          status: 'active' as const,
          currentVersion: 1,
        };
        vaultReferences = vaultReferences.map((reference) =>
          reference.referenceId === referenceId ? rebound : reference
        );

        return rebound;
      },
      listAutomations: implementations.automationList,
      createAutomation: implementations.automationCreate,
      updateAutomation: implementations.automationUpdate,
      deleteAutomation: implementations.automationDelete,
      quickChat: implementations.quickChat,
      listInterruptedWorkers: async () => ({ items: [] }),
      listRecoveryPendingUserTurns: async () => ({ items: [] }),
      cancelRecoveryPendingUserTurn: async () => {
        throw new Error('Pending user-turn cancellation fixture not configured.');
      },
      editRecoveryPendingUserTurn: async () => {
        throw new Error('Pending user-turn edit fixture not configured.');
      },
      convertRecoveryPendingUserTurnToFollowUp: async () => {
        throw new Error('Pending user-turn follow-up fixture not configured.');
      },
      promoteRecoveryPendingUserTurnToInterrupt: async () => {
        throw new Error('Pending user-turn interrupt fixture not configured.');
      },
      clearInterruptedWorkerCheckpoint: async () => {
        throw new Error('Interrupted worker checkpoint fixture not configured.');
      },
      retryInterruptedWorkerCheckpoint: async () => {
        throw new Error('Interrupted worker checkpoint retry fixture not configured.');
      },
      retrySchedulerAdmission: async () => {
        throw new Error('Scheduler admission retry fixture not configured.');
      },
      cancelSchedulerAdmission: async () => {
        throw new Error('Scheduler admission cancellation fixture not configured.');
      },
      listSchedulerAdmissions: async () => ({ items: [] }),
      search: implementations.appSearch,
      submitTurnFeedback: implementations.turnFeedback,
    },
    runtimeConfig: {
      reload: implementations.runtimeReload,
      listFiles: implementations.runtimeListFiles,
      getFile: implementations.runtimeGetFile,
      createFile: implementations.runtimeCreateFile,
      updateFile: implementations.runtimeUpdateFile,
      validate: implementations.runtimeValidate,
      getSchemas: implementations.runtimeSchemas,
      restartStaleSession: async () => {
        throw new Error('Runtime stale-session restart fixture not configured.');
      },
    },
    oauth: {
      openaiCodex: {
        listAccounts: implementations.oauthAccounts,
        createAccount: implementations.oauthCreateAccount,
        updateAccount: implementations.oauthUpdateAccount,
        deleteAccount: implementations.oauthDeleteAccount,
        getAccountStatus: implementations.oauthAccountStatus,
        startAccount: implementations.oauthStartAccount,
        cancelAccount: implementations.oauthCancelAccount,
        logoutAccount: implementations.oauthLogoutAccount,
      },
    },
    auth: {
      email: {
        signUp: implementations.emailSignUp,
        signIn: implementations.emailSignIn,
        signOut: implementations.emailSignOut,
      },
    },
    capabilities: {
      refresh: implementations.meta,
      snapshot: () => META_RESPONSE,
      supports: (flag) => META_RESPONSE.capabilities.includes(flag),
      require: (flag) => {
        if (!META_RESPONSE.capabilities.includes(flag)) {
          throw new Error(`Capability is not supported by the test client: ${flag}`);
        }
      },
    },
    agents: {
      list: async () => ({ items: workspaceResources.agents }),
      get: async (agentId) => {
        const agent = workspaceResources.agents.find((item) => item.id === agentId);

        if (!agent) {
          throw new Error(`Agent not found: ${agentId}`);
        }

        return agent;
      },
      refreshHealth: implementations.refreshAgentHealth,
    },
    actionCenter: {
      listHumanAttention: implementations.listHumanAttention,
    },
    repositories: {
      list: async (workspaceId) => ({
        defaultResource: repositoryResource,
        defaultResourceId: repositoryResource?.resourceId ?? null,
        items: repositoryResource ? [repositoryResource] : [],
        workspaceId,
      }),
      diagnostics: async (workspaceId) => {
        const diagnostic = repositoryDiagnostic(workspaceId);

        return {
          defaultResource: diagnostic,
          defaultResourceId: repositoryResource?.resourceId ?? null,
          resources: diagnostic ? [diagnostic] : [],
          workspaceId,
        };
      },
      listGitPushRecords: async () => ({ items: [] }),
      getGitPushRecord: async () => {
        throw new Error('Git push record fixture not configured.');
      },
      requestGitPushApproval: async () => {
        throw new Error('Git push approval fixture not configured.');
      },
      executeGitPush: async () => {
        throw new Error('Git push execution fixture not configured.');
      },
      setDefault: async (workspaceId, input) => {
        options.onSetDefaultRepository?.(workspaceId, input);
        const resource: NonNullable<typeof repositoryResource> = {
          workspaceId,
          resourceId: 'default',
          type: 'git_repository',
          displayName: input.displayName,
          diagnosticsStatus: 'ready',
          createdAt: timestamp,
          updatedAt: timestamp,
          pathSummary: 'git repository ending in openkit',
          git: {
            authorEmail: null,
            authorName: null,
            allowedPushTargets: [],
            commitOnApply: false,
            protectedBranchPatterns: ['main', 'master', 'release/*', 'v*'],
            requireReviewLinkage: true,
            stagingStrategy: 'staging-root',
            vaultGrantRef: null,
          },
          validation: {
            ok: true,
            pathSummary: 'git repository ending in openkit',
            resourceKind: 'git_repository',
            status: 'ready',
            summary: 'Repository is ready.',
          },
        };
        repositoryResource = resource;

        return { repository: resource };
      },
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
});

describe('App', () => {
  it('renders the workspace and thread workflow shell', async () => {
    render(() => <App client={createFakeClient()} />);

    expect(await screen.findByRole('button', { name: /demo workspace/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^chat$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start thread/i })).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /protocol design review/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: /workspace threads/i })).toBeInTheDocument();
    expect(screen.queryByText(/not checked yet/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    expect(screen.getAllByRole('option', { name: /opencode/i }).length).toBeGreaterThan(0);
  });

  it('renders unified Action Center rows and dispatches artifact review actions', async () => {
    let artifactReviewInput:
      | Parameters<CoreClient['app']['submitArtifactReviewDecision']>[2]
      | null = null;
    const humanAttention: HumanAttentionRow[] = [
      {
        id: 'artifact:artifact_demo',
        kind: 'artifact_review',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        artifactId: 'artifact_demo',
        title: 'Review Worker report',
        summary: 'The artifact is ready for acceptance.',
        severity: 'needs_input',
        createdAt: '2026-04-15T09:00:00.000Z',
        source: {
          type: 'artifact',
          artifactId: 'artifact_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          reviewStatus: 'pending',
        },
        actions: [
          {
            kind: 'request_refinement',
            label: 'Refine',
            method: 'POST',
            href: '/api/app/workspaces/ws_demo/artifacts/artifact_demo/review',
          },
        ],
      },
    ];

    render(() => (
      <App
        client={createFakeClient({
          humanAttention,
          onSubmitArtifactReviewDecision: (_workspaceId, _artifactId, input) => {
            artifactReviewInput = input;
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(await screen.findByRole('button', { name: /action center/i }));

    expect(await screen.findByRole('heading', { name: /human attention/i })).toBeInTheDocument();
    expect(screen.getByText(/review worker report/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /refine/i }));

    await waitFor(() => expect(artifactReviewInput).not.toBeNull());
    expect(artifactReviewInput).toMatchObject({ decision: 'needs_refinement' });
  });

  it('dispatches durable workspace review Action Center actions through the workspace sync route', async () => {
    let artifactReviewCalls = 0;
    let workspaceReviewCall: {
      workspaceId: string;
      reviewId: string;
      input: Parameters<CoreClient['app']['submitWorkspaceSyncReviewDecision']>[2];
    } | null = null;
    const humanAttention: HumanAttentionRow[] = [
      {
        id: 'workspace-review:swr_demo',
        kind: 'workspace_review',
        workspaceId: 'ws_demo',
        artifactId: 'ar_missing_workspace_review',
        title: 'Review workspace changes',
        summary: '1 changed path staged for human review.',
        severity: 'needs_input',
        createdAt: '2026-04-15T09:00:00.000Z',
        source: {
          type: 'workspace_review',
          reviewId: 'swr_demo',
          changeSetId: 'wcs_demo',
          artifactId: 'ar_missing_workspace_review',
          workspaceId: 'ws_demo',
          status: 'pending',
        },
        actions: [
          {
            kind: 'request_refinement',
            label: 'Refine',
            method: 'POST',
            href: '/api/app/workspaces/ws_demo/workspace-sync/reviews/swr_demo/decision',
          },
        ],
      },
    ];

    render(() => (
      <App
        client={createFakeClient({
          humanAttention,
          onSubmitArtifactReviewDecision: () => {
            artifactReviewCalls += 1;
          },
          onSubmitWorkspaceSyncReviewDecision: (workspaceId, reviewId, input) => {
            workspaceReviewCall = { workspaceId, reviewId, input };
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(await screen.findByRole('button', { name: /action center/i }));
    fireEvent.click(await screen.findByRole('button', { name: /refine/i }));

    await waitFor(() => expect(workspaceReviewCall).not.toBeNull());
    expect(workspaceReviewCall).toEqual({
      workspaceId: 'ws_demo',
      reviewId: 'swr_demo',
      input: { decision: 'needs_refinement' },
    });
    expect(artifactReviewCalls).toBe(0);
  });

  it('dispatches goal review Action Center actions through the goal review client route', async () => {
    let artifactReviewCalls = 0;
    let goalReviewCall: {
      workspaceId: string;
      threadId: string;
      goalId: string;
      reviewId: string;
    } | null = null;
    const humanAttention: HumanAttentionRow[] = [
      {
        id: 'goal-review:ws_demo:th_demo:goal_demo:review_demo',
        kind: 'artifact_review',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        artifactId: 'artifact_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        title: 'Review worker output',
        summary: 'Worker output needs refinement.',
        severity: 'needs_input',
        createdAt: '2026-04-15T09:00:00.000Z',
        source: {
          type: 'goal_review',
          reviewId: 'review_demo',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          verdict: 'refine',
        },
        actions: [
          {
            kind: 'request_refinement',
            label: 'Request refinement',
            method: 'POST',
            href: '/api/app/workspaces/ws_demo/threads/th_demo/goals/goal_demo/reviews/review_demo/decision',
          },
        ],
      },
    ];

    render(() => (
      <App
        client={createFakeClient({
          humanAttention,
          onSubmitArtifactReviewDecision: () => {
            artifactReviewCalls += 1;
          },
          onSubmitGoalReviewDecision: (workspaceId, threadId, goalId, reviewId) => {
            goalReviewCall = { workspaceId, threadId, goalId, reviewId };
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(await screen.findByRole('button', { name: /action center/i }));
    fireEvent.click(await screen.findByRole('button', { name: /request refinement/i }));

    await waitFor(() => expect(goalReviewCall).not.toBeNull());
    expect(goalReviewCall).toEqual({
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      goalId: 'goal_demo',
      reviewId: 'review_demo',
    });
    expect(artifactReviewCalls).toBe(0);
  });

  it('shows server-mode auth and resumes after sign in', async () => {
    let signInInput: Parameters<CoreClient['auth']['email']['signIn']>[0] | null = null;

    render(() => (
      <App
        client={createFakeClient({
          authRequiredOnInit: true,
          onSignIn: (input) => {
            signInInput = input;
          },
        })}
      />
    ));

    expect(await screen.findByRole('heading', { name: /^sign in$/i })).toBeInTheDocument();
    fireEvent.input(screen.getByLabelText(/^email$/i), {
      target: { value: 'user@example.com' },
    });
    fireEvent.input(screen.getByLabelText(/^password$/i), {
      target: { value: 'password123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByRole('button', { name: /demo workspace/i })).toBeInTheDocument();
    expect(signInInput).toEqual({
      email: 'user@example.com',
      password: 'password123456',
    });
  });

  it('keeps the main workbench controls on responsive layout rails', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });

    expect(screen.getByRole('region', { name: /chat starter/i })).toHaveClass('chat-starter');
    expect(screen.getByRole('textbox', { name: /thread title/i })).toHaveClass('chat-thread-input');

    expect(await screen.findByRole('button', { name: /protocol design review/i })).toHaveClass(
      'thread-card-stacked'
    );

    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    expect(screen.getByText(/^Workspace name$/).closest('label')).toHaveClass('ui-field');

    const unnamedControls = [...document.querySelectorAll('input, select, textarea')].filter(
      (control) => !control.getAttribute('name')
    );
    expect(unnamedControls).toHaveLength(0);
  });

  it('renders a two-column shell with a centered main workspace', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });

    const shell = screen.getByTestId('workbench-shell');
    const primarySidebar = screen.getByRole('complementary', {
      name: /primary workspace navigation/i,
    });
    const conversationWorkspace = screen.getByRole('region', {
      name: /conversation workspace/i,
    });

    expect(shell).toHaveClass('app-shell-two-column');
    expect(primarySidebar).toHaveClass('primary-sidebar');
    expect(conversationWorkspace).toHaveClass('main-workspace-centered');
    expect(conversationWorkspace.querySelector('.chat-starter')).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: /auxiliary workspace panel/i })).toBeNull();
  });

  it('keeps the Chat starter centered across the full main rail on large screens', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });

    const conversationWorkspace = screen.getByRole('region', {
      name: /conversation workspace/i,
    });
    const chatStarter = screen.getByRole('region', { name: /chat starter/i });

    expect(conversationWorkspace).toHaveClass('main-workspace-full-rail');
    expect(chatStarter).toHaveClass('chat-starter-centered');
    const appStyles = readFileSync('src/App.css', 'utf8');
    expect(appStyles).toMatch(/\.main-workspace-full-rail\s*\{[^}]*width:\s*100%/s);
    expect(appStyles).toMatch(/\.chat-starter-centered\s*\{[^}]*margin-inline:\s*auto/s);
  });

  it('removes global header chrome and moves utility state into settings', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });

    const primarySidebar = screen.getByRole('complementary', {
      name: /primary workspace navigation/i,
    });

    expect(screen.queryByRole('banner')).toBeNull();
    expect(document.querySelector('.top-command-bar')).toBeNull();
    expect(primarySidebar).not.toHaveTextContent(new RegExp(`protocol ${PROTOCOL_VERSION}`, 'i'));
    expect(primarySidebar).not.toHaveTextContent(/debug product/i);
    expect(primarySidebar).toHaveTextContent(/threads/i);

    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    expect(screen.getByRole('navigation', { name: /settings sections/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^configuration$/i }));
    expect(screen.getByText(new RegExp(`protocol ${PROTOCOL_VERSION}`, 'i'))).toBeInTheDocument();
    expect(screen.getByText(/debug product/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^appearance$/i }));
    expect(screen.getByRole('group', { name: /theme selector/i })).toBeInTheDocument();
  });

  it('uses soft surface separation instead of dense grid lines', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });

    expect(screen.getByTestId('app-frame')).toHaveClass('app-frame-edge');
    expect(screen.getByTestId('workbench-shell')).toHaveClass('app-shell-soft');
    expect(
      screen.getByRole('complementary', { name: /primary workspace navigation/i })
    ).toHaveClass('surface-separated-column');
    expect(screen.getByRole('region', { name: /conversation workspace/i })).toHaveClass(
      'surface-separated-column'
    );
    expect(document.querySelectorAll('.line-separated-column')).toHaveLength(0);
  });

  it('uses Remix Iconify controls to compress explanatory chrome', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });

    const primarySidebar = screen.getByRole('complementary', {
      name: /primary workspace navigation/i,
    });
    const threadList = screen.getByRole('navigation', { name: /workspace threads/i });

    expect(primarySidebar).toHaveClass('primary-sidebar-compact');
    expect(primarySidebar).toHaveClass('primary-sidebar-scroll-safe');
    expect(
      primarySidebar.querySelectorAll('iconify-icon[icon^="ri:"]').length
    ).toBeGreaterThanOrEqual(4);
    await screen.findByRole('button', { name: /protocol design review/i });
    expect(threadList).toHaveTextContent(/protocol design review/i);
    expect(screen.getByRole('heading', { name: /workspaces/i })).not.toHaveClass('text-white');
  });

  it('keeps settings organized with its own section sidebar', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });

    const primarySidebar = screen.getByRole('complementary', {
      name: /primary workspace navigation/i,
    });
    expect(primarySidebar).not.toHaveTextContent(/agents/i);
    expect(primarySidebar).not.toHaveTextContent(/artifacts/i);
    expect(primarySidebar).not.toHaveTextContent(/approvals/i);
    expect(primarySidebar).not.toHaveTextContent(/inspector/i);
    expect(primarySidebar).not.toHaveTextContent(/workspace setup/i);
    expect(primarySidebar).not.toHaveTextContent(/knowledge kind/i);

    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    expect(screen.getByRole('heading', { name: /workspace settings/i })).toBeInTheDocument();
    const settingsSidebar = screen.getByRole('navigation', { name: /settings sections/i });
    expect(settingsSidebar).toHaveClass('settings-sidebar');
    expect(settingsSidebar).toHaveClass('settings-sidebar-primary');
    expect(primarySidebar).toHaveTextContent(/back to app/i);
    expect(primarySidebar).not.toHaveTextContent(/workspaces/i);
    expect(primarySidebar).not.toHaveTextContent(/threads/i);
    expect(screen.getByRole('button', { name: /^general$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^appearance$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^configuration$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^knowledge$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^diagnostics$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^general$/i })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(document.querySelector('.settings-layout')).toBeNull();
    expect(screen.getByRole('region', { name: /conversation workspace/i })).toHaveClass(
      'settings-main-single-column'
    );
    fireEvent.click(screen.getByRole('button', { name: /^appearance$/i }));
    expect(screen.getByText(/theme presets/i)).toBeInTheDocument();
  });

  it('switches settings sidebar categories to focused single-column sections', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));

    const settingsSidebar = screen.getByRole('navigation', { name: /settings sections/i });
    const appearanceButton = within(settingsSidebar).getByRole('button', { name: /^appearance$/i });
    const knowledgeButton = within(settingsSidebar).getByRole('button', { name: /^knowledge$/i });

    fireEvent.click(appearanceButton);

    expect(appearanceButton).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('group', { name: /theme selector/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/workspace name/i)).toBeNull();
    expect(screen.queryByLabelText(/knowledge title/i)).toBeNull();

    fireEvent.click(knowledgeButton);

    expect(knowledgeButton).toHaveAttribute('aria-current', 'page');
    expect(screen.getByLabelText(/knowledge title/i)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /theme selector/i })).toBeNull();
    expect(screen.queryByLabelText(/workspace name/i)).toBeNull();
  });

  it('rebinds the workspace repository from settings portability', async () => {
    let repositoryInput: Parameters<CoreClient['repositories']['setDefault']>[1] | null = null;
    render(() => (
      <App
        client={createFakeClient({
          onSetDefaultRepository: (_workspaceId, input) => {
            repositoryInput = input;
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^portability$/i }));

    expect(await screen.findByText(/No repository resource linked/i)).toBeInTheDocument();
    fireEvent.input(screen.getByLabelText(/Repository path/i), {
      target: { value: '/Users/m5pro/Documents/AI/openkit' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Rebind repository/i }));

    await waitFor(() => {
      expect(repositoryInput).toEqual({
        displayName: 'Demo Workspace repository',
        localPath: '/Users/m5pro/Documents/AI/openkit',
      });
    });
    expect(await screen.findByText(/git repository ending in openkit/i)).toBeInTheDocument();
    expect(screen.getByText(/Repository is ready/i)).toBeInTheDocument();
  });

  it('rebinds imported workspace vault references from settings portability', async () => {
    let rebindInput: Parameters<CoreClient['app']['rebindWorkspaceVaultReference']>[2] | null =
      null;
    render(() => (
      <App
        client={createFakeClient({
          onRebindWorkspaceVaultReference: (_workspaceId, _referenceId, input) => {
            rebindInput = input;
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^portability$/i }));

    expect(await screen.findAllByText(/vault_imported/i)).toHaveLength(2);
    expect(screen.getAllByText(/unbound/i).length).toBeGreaterThanOrEqual(1);
    fireEvent.input(screen.getByLabelText(/Secret material/i), {
      target: { value: 'workspace-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Rebind vault reference/i }));

    await waitFor(() => {
      expect(rebindInput).toEqual({
        materialBase64: Buffer.from('workspace-secret', 'utf8').toString('base64'),
      });
    });
    expect(await screen.findByText(/active/i)).toBeInTheDocument();
  });

  it('keeps diagnostics inside settings and removes stale mock workbench pages', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^diagnostics$/i }));

    expect(screen.getByRole('heading', { name: /^diagnostics$/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /api\/meta snapshot/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /latest event envelopes/i })).toBeNull();
    expect(screen.getByRole('heading', { name: /turn lifecycle timeline/i })).toBeInTheDocument();
    expect(screen.getByText(/0 turns/i)).toBeInTheDocument();
    expect(screen.queryByText(/mock ui/i)).toBeNull();
    expect(screen.queryByText(/mock preview/i)).toBeNull();
    expect(appSource).not.toMatch(/activePage\(\) === '(agents|artifacts|approvals|inspector)'/);
    expect(appSource).not.toMatch(/Mock UI|Mock preview|Policy placeholders|Placeholder queues/);
  });

  it('keeps a sticky full-height sidebar with top shortcuts and bottom settings', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });

    const sidebar = screen.getByRole('complementary', {
      name: /primary workspace navigation/i,
    });
    const shortcuts = screen.getByRole('navigation', { name: /workspace shortcuts/i });
    const settingsButton = screen.getByRole('button', { name: /^settings$/i });

    expect(sidebar).toHaveClass('primary-sidebar-sticky');
    expect(sidebar.querySelector('.sidebar-app-title .icon-button')).toBeNull();
    expect(within(shortcuts).getByRole('button', { name: /^chat$/i })).toBeInTheDocument();
    expect(within(shortcuts).getByRole('button', { name: /^dashboard$/i })).toBeInTheDocument();
    expect(within(shortcuts).getByRole('button', { name: /^automations$/i })).toBeInTheDocument();
    expect(within(shortcuts).getByRole('button', { name: /^new workspace$/i })).toBeInTheDocument();
    expect(settingsButton).toHaveClass('sidebar-settings-command');
  });

  it('opens Chat as the centered workspace starter for the selected workspace', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^chat$/i }));

    const chatStarter = screen.getByRole('region', { name: /chat starter/i });
    expect(chatStarter).toHaveClass('chat-starter');
    expect(screen.getByRole('heading', { name: /what should we work on/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /workspace/i })).toHaveValue('ws_demo');
    expect(screen.getByRole('textbox', { name: /thread title/i })).toBeInTheDocument();
  });

  it('creates a workspace, selects it, and restores selection from the URL on reload', async () => {
    const client = createFakeClient();

    window.history.replaceState(null, '', '/');
    render(() => <App client={client} />);

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^new workspace$/i }));
    fireEvent.input(screen.getByLabelText(/^new workspace$/i), {
      target: { value: 'Protocol Lab' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^create workspace$/i }));

    const createdWorkspaceButton = await screen.findByRole('button', { name: /protocol lab/i });
    expect(createdWorkspaceButton).toHaveClass('workspace-card-active');
    expect(window.location.pathname).toBe('/workspaces/ws_created');

    cleanup();
    render(() => <App client={client} />);

    const [restoredWorkspaceButton] = await screen.findAllByRole('button', {
      name: /protocol lab/i,
    });
    expect(restoredWorkspaceButton).toHaveClass('workspace-card-active');
  });

  it('starts a real workspace thread and first turn from Chat', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^chat$/i }));
    fireEvent.input(screen.getByRole('textbox', { name: /thread title/i }), {
      target: { value: 'Use the host agent from the web UI' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start thread/i }));

    expect(
      await screen.findByRole('heading', { name: /use the host agent from the web ui dashboard/i })
    ).toBeInTheDocument();
    expect(
      (await screen.findAllByText(/use the host agent from the web ui/i)).length
    ).toBeGreaterThan(0);
    expect(
      await screen.findByText(/reviewing use the host agent from the web ui/i)
    ).toBeInTheDocument();
  });

  it('sends the selected model override when starting agent chat from Chat', async () => {
    let turnInput: Parameters<CoreClient['core']['startTurn']>[0] | null = null;
    render(() => (
      <App
        client={createFakeClient({
          onTurnInput: (input) => {
            if (!input.turnId) {
              turnInput = input;
            }
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^chat$/i }));
    await screen.findByRole('option', { name: /opencode/i });
    fireEvent.change(screen.getByRole('combobox', { name: /^model$/i }), {
      target: { value: 'model_opencode' },
    });
    fireEvent.input(screen.getByRole('textbox', { name: /thread title/i }), {
      target: { value: 'Use OpenCode for this turn' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start thread/i }));

    await waitFor(() => {
      expect(turnInput).not.toBeNull();
    });
    const request = turnInput as Parameters<CoreClient['core']['startTurn']>[0] | null;
    expect(request?.modelId).toBe('model_opencode');
  });

  it('uses quick chat from the composer mode toggle', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^chat$/i }));
    const chatStarter = screen.getByRole('region', { name: /chat starter/i });
    fireEvent.click(within(chatStarter).getByRole('button', { name: /quick chat/i }));
    fireEvent.input(screen.getByRole('textbox', { name: /thread title/i }), {
      target: { value: 'How many threads are running?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start thread/i }));

    expect(
      await screen.findByText(/Quick response: How many threads are running/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /quick chat dashboard/i })
    ).not.toBeInTheDocument();
  });

  it('starts Goal Mode from the thread workbench', async () => {
    let goalInput: Parameters<CoreClient['app']['startThreadGoal']>[2] | null = null;

    render(() => (
      <App
        client={createFakeClient({
          threadGoalSummary: { goal: null },
          onStartThreadGoal: (_workspaceId, _threadId, input) => {
            goalInput = input;
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(await screen.findByRole('button', { name: /protocol design review/i }));
    const goalMode = await screen.findByRole('region', { name: /goal mode/i });

    fireEvent.input(within(goalMode).getByRole('textbox', { name: /goal objective/i }), {
      target: { value: 'Make v0.0.6 ready for end users.' },
    });
    fireEvent.click(within(goalMode).getByRole('button', { name: /start goal/i }));

    await waitFor(() => {
      expect(goalInput).toEqual({ objective: 'Make v0.0.6 ready for end users.' });
    });
    expect(goalMode).toHaveTextContent(/Planning/i);
    expect(goalMode).toHaveTextContent(/Make v0.0.6 ready for end users/i);
  });

  it('shows Goal Mode route errors in the thread workbench', async () => {
    render(() => (
      <App
        client={createFakeClient({
          threadGoalSummary: { goal: null },
          startThreadGoalError: new Error('Goal Mode route is unavailable.'),
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(await screen.findByRole('button', { name: /protocol design review/i }));
    const goalMode = await screen.findByRole('region', { name: /goal mode/i });

    fireEvent.input(within(goalMode).getByRole('textbox', { name: /goal objective/i }), {
      target: { value: 'Start a failing goal.' },
    });
    fireEvent.click(within(goalMode).getByRole('button', { name: /start goal/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/goal mode route is unavailable/i);
  });

  it('submits Goal Mode steering from the thread workbench', async () => {
    let steeringInput: Parameters<CoreClient['app']['submitThreadGoalSteering']>[2] | null = null;

    render(() => (
      <App
        client={createFakeClient({
          threadGoalSummary: {
            goal: {
              goalId: 'goal_th_demo',
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              status: 'running',
              title: 'Ship v0.0.6',
              objective: 'Make the release ready for end users.',
              currentTask: null,
              taskCounts: {
                pending: 0,
                ready: 1,
                running: 0,
                reviewing: 0,
                needsRevision: 0,
                completed: 0,
                blocked: 0,
                failed: 0,
                skipped: 0,
              },
              pendingHumanAttention: {
                required: false,
                reason: null,
              },
              terminalState: null,
              steering: emptyGoalSteering(),
              updatedAt: '2026-04-15T09:00:00.000Z',
            },
          },
          onSubmitThreadGoalSteering: (_workspaceId, _threadId, input) => {
            steeringInput = input;
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(await screen.findByRole('button', { name: /protocol design review/i }));
    const goalMode = await screen.findByRole('region', { name: /goal mode/i });

    fireEvent.input(within(goalMode).getByRole('textbox', { name: /steering input/i }), {
      target: { value: 'Prioritize release notes.' },
    });
    fireEvent.click(within(goalMode).getByRole('button', { name: /submit steering/i }));

    await waitFor(() => {
      expect(steeringInput?.message).toBe('Prioritize release notes.');
    });
    expect(goalMode).toHaveTextContent(/queued for the next safe point/i);
    expect(goalMode).toHaveTextContent(/queued steering: 1/i);
  });

  it('drafts and approves a Goal Mode plan without starting a worker', async () => {
    let createdPlanCount = 0;
    let approvedPlan: Parameters<CoreClient['app']['approveThreadGoalPlan']>[2] | null = null;
    let workerStepCount = 0;

    render(() => (
      <App
        client={createFakeClient({
          threadGoalSummary: { goal: null },
          onCreateThreadGoalPlan: () => {
            createdPlanCount += 1;
          },
          onApproveThreadGoalPlan: (_workspaceId, _threadId, input) => {
            approvedPlan = input;
          },
          onRunThreadGoalStep: () => {
            workerStepCount += 1;
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(await screen.findByRole('button', { name: /protocol design review/i }));
    const goalMode = await screen.findByRole('region', { name: /goal mode/i });

    fireEvent.input(within(goalMode).getByRole('textbox', { name: /goal objective/i }), {
      target: { value: 'Plan the release.' },
    });
    fireEvent.click(within(goalMode).getByRole('button', { name: /start goal/i }));

    const planReview = await screen.findByRole('region', { name: /goal plan review/i });
    fireEvent.click(within(planReview).getByRole('button', { name: /draft plan/i }));

    expect((await screen.findAllByText(/validate goal mode ui fixtures/i)).length).toBeGreaterThan(
      0
    );
    fireEvent.click(within(planReview).getByRole('button', { name: /approve plan/i }));

    await waitFor(() => {
      expect(createdPlanCount).toBe(1);
      expect(approvedPlan?.planItemId).toBe('it_plan_th_demo');
    });
    expect(workerStepCount).toBe(0);
  });

  it('runs a real Goal Mode worker step from the thread workbench', async () => {
    let workerStepCount = 0;

    render(() => (
      <App
        client={createFakeClient({
          threadGoalSummary: {
            goal: {
              goalId: 'goal_th_demo',
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              status: 'running',
              title: 'Demo goal',
              objective: 'Validate Goal Mode UI fixtures.',
              currentTask: null,
              taskCounts: {
                pending: 0,
                ready: 1,
                running: 0,
                reviewing: 0,
                needsRevision: 0,
                completed: 0,
                blocked: 0,
                failed: 0,
                skipped: 0,
              },
              pendingHumanAttention: {
                required: false,
                reason: null,
              },
              terminalState: null,
              steering: emptyGoalSteering(),
              updatedAt: '2026-04-15T09:00:00.000Z',
            },
          },
          onRunThreadGoalStep: () => {
            workerStepCount += 1;
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(await screen.findByRole('button', { name: /protocol design review/i }));
    const goalMode = await screen.findByRole('region', { name: /goal mode/i });

    fireEvent.click(within(goalMode).getByRole('button', { name: /run next step/i }));

    await waitFor(() => {
      expect(workerStepCount).toBe(1);
    });
    expect(goalMode).toHaveTextContent(/worker result needs review/i);
    expect(goalMode).toHaveTextContent(/reviewing/i);
  });

  it('explains provider rate limits when quick chat is throttled', async () => {
    render(() => (
      <App
        client={createFakeClient({
          quickChatError: new ApiCallError(429, 'Rate limit exceeded: 5 requests per minute.', {
            code: 'provider_rate_limited',
          }),
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^chat$/i }));
    const chatStarter = screen.getByRole('region', { name: /chat starter/i });
    fireEvent.click(within(chatStarter).getByRole('button', { name: /quick chat/i }));
    fireEvent.input(screen.getByRole('textbox', { name: /thread title/i }), {
      target: { value: 'How many threads are running?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start thread/i }));

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent(/rate limit exceeded/i);
    expect(alert).toHaveTextContent(/wait before retrying/i);
  });

  it('blocks agent chat submission when the selected workspace has no enabled agents', async () => {
    let turnInput: Parameters<CoreClient['core']['startTurn']>[0] | null = null;

    render(() => (
      <App
        client={createFakeClient({
          emptyWorkspaceResources: true,
          onTurnInput: (input) => {
            turnInput = input;
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^chat$/i }));
    await screen.findByText(/no enabled agent is configured for this workspace/i);
    fireEvent.input(screen.getByRole('textbox', { name: /thread title/i }), {
      target: { value: 'Start without agents' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start thread/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no enabled agent/i);
    expect(turnInput).toBeNull();
  });

  it('fills the chat starter from a suggestion chip', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^chat$/i }));
    fireEvent.click(screen.getByRole('button', { name: /research a buying decision/i }));

    expect(screen.getByRole('textbox', { name: /thread title/i })).toHaveValue(
      'Research a buying decision'
    );
  });

  it('renders automation records from nanocore app APIs', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^automations$/i }));

    expect(await screen.findByText(/Nightly protocol sweep/i)).toBeInTheDocument();
    expect(screen.getByText(/0 2 \* \* \*/i)).toBeInTheDocument();
    expect(screen.getByText(/paused/i)).toBeInTheDocument();
  });

  it('creates automations through nanocore app APIs', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^automations$/i }));
    fireEvent.input(screen.getByRole('textbox', { name: /^automation name$/i }), {
      target: { value: 'Daily workspace brief' },
    });
    fireEvent.input(screen.getByRole('textbox', { name: /^cron schedule$/i }), {
      target: { value: '0 9 * * *' },
    });
    fireEvent.input(screen.getByRole('textbox', { name: /^automation prompt$/i }), {
      target: { value: 'Summarize current workspace status.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^create automation$/i }));

    expect(await screen.findByText(/Daily workspace brief/i)).toBeInTheDocument();
    expect(screen.getByText(/0 9 \* \* \*/i)).toBeInTheDocument();
  });

  it('enables pauses and deletes automation records', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^automations$/i }));

    expect(await screen.findByText(/Nightly protocol sweep/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /enable nightly protocol sweep/i }));
    expect(await screen.findByText(/enabled/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /pause nightly protocol sweep/i }));
    expect(await screen.findByText(/paused/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /delete nightly protocol sweep/i }));
    expect(await screen.findByText(/No automations are configured yet/i)).toBeInTheDocument();
  });

  it('renders provider and gateway diagnostics from nanocore app APIs', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^diagnostics$/i }));

    expect(await screen.findByText(/nanocore/i)).toBeInTheDocument();
    expect(screen.getByText(/gateway ok/i)).toBeInTheDocument();
    expect(screen.getAllByText(/openai/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/blocked/i)).toBeInTheDocument();
  });

  it('renders account diagnostics even when workspace loading fails', async () => {
    render(() => (
      <App
        client={createFakeClient({
          workspaceListError: new ApiCallError(500, 'Workspace storage failed.', {
            code: 'workspace_list_failed',
          }),
          codexOAuthAccounts: {
            accounts: [
              {
                accountLabel: 'user@example.com',
                accountSlotId: 'default',
                boundProviderIds: [],
                displayName: 'hi-codex',
                isDefault: true,
                planType: 'prolite',
                providerId: 'openai_codex',
                status: 'logged_in',
              },
              {
                accountSlotId: 'ntd',
                boundProviderIds: [],
                displayName: 'codex-ntd',
                isDefault: false,
                providerId: 'openai_codex',
                status: 'logged_out',
              },
            ],
            defaultAccountSlotId: 'default',
          },
        })}
      />
    ));

    expect(await screen.findByRole('alert')).toHaveTextContent(/workspace storage failed/i);
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^diagnostics$/i }));

    expect(await screen.findByText('hi-codex')).toBeInTheDocument();
    expect(screen.getByText('user@example.com')).toBeInTheDocument();
    expect(screen.getByText('prolite')).toBeInTheDocument();
    expect(screen.getByText('codex-ntd')).toBeInTheDocument();
    expect(screen.getByText('logged_in')).toBeInTheDocument();
    expect(screen.getByText('logged_out')).toBeInTheDocument();
  });

  it('renders role default provider diagnostics from nanocore app APIs', async () => {
    render(() => (
      <App
        client={createFakeClient({
          appDiagnosticsDefaultProviders: {
            core: {
              configured: true,
              model: 'openai/gpt-5.4',
              origin: 'canonical',
              providerId: 'openrouter',
            },
            gateway: {
              configured: false,
              origin: 'unset',
              reason: 'unset',
            },
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^diagnostics$/i }));

    expect(await screen.findByText(/^Core default provider$/i)).toBeInTheDocument();
    expect(screen.getAllByText(/openrouter/i).length).toBeGreaterThan(0);
    expect(appSource).not.toContain('/api/diagnostics');
  });

  it('renders split default provider diagnostics from nanocore app APIs', async () => {
    render(() => (
      <App
        client={createFakeClient({
          appDiagnosticsDefaultProviders: {
            core: {
              configured: true,
              model: 'openai/gpt-5.4',
              origin: 'canonical',
              providerId: 'agent-openrouter',
            },
            gateway: {
              configured: true,
              model: 'openai/gpt-5.4',
              origin: 'canonical',
              providerId: 'gateway-openai',
            },
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^diagnostics$/i }));

    expect(await screen.findByText(/Core default provider/i)).toBeInTheDocument();
    expect(screen.getAllByText(/agent-openrouter/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Gateway default provider/i)).toBeInTheDocument();
    expect(screen.getByText(/gateway-openai/i)).toBeInTheDocument();
    expect(screen.getAllByText(/canonical/i).length).toBeGreaterThan(0);
  });

  it('renders internal agent diagnostics from nanocore app APIs without raw failure details', async () => {
    render(() => (
      <App
        client={createFakeClient({
          appDiagnosticsInternalAgents: {
            agents: [
              {
                allowedTools: ['readWorkspaceSummary', 'webSearch'],
                defaultProviderUse: 'quickChat',
                displayName: 'QuickChatAgent',
                id: 'quick-chat',
                provider: {
                  configured: true,
                  model: 'gpt-5.1',
                  providerId: 'openai',
                },
                supportedModes: ['chat'],
              },
              {
                allowedTools: ['readAgentReadiness', 'draftWorkerDelegation'],
                defaultProviderUse: 'internalTasks',
                displayName: 'WorkerCoordinatorAgent',
                id: 'worker-coordinator',
                provider: {
                  configured: false,
                  providerId: 'openrouter',
                  reason: 'model-missing',
                },
                supportedModes: ['automation', 'delegation', 'plan', 'review'],
              },
            ],
            recentFailures: [
              {
                agentId: 'quick-chat',
                code: 'internal_agent_failed',
                details: {
                  prompt: '[redacted]',
                  token: '[redacted]',
                },
                message: 'upstream Authorization: Bearer [redacted]',
                occurredAt: '2026-05-26T00:00:00.000Z',
                status: 'error',
                stopReason: 'error',
              },
            ],
            recentHookFailures: [],
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^diagnostics$/i }));

    expect(await screen.findByText(/Internal agents/i)).toBeInTheDocument();
    expect(screen.getByText('QuickChatAgent')).toBeInTheDocument();
    expect(screen.getByText('openai / gpt-5.1')).toBeInTheDocument();
    expect(screen.getByText('WorkerCoordinatorAgent')).toBeInTheDocument();
    expect(screen.getByText(/openrouter needs model/i)).toBeInTheDocument();
    expect(screen.getByText('internal_agent_failed')).toBeInTheDocument();
    expect(screen.getByText('upstream Authorization: Bearer [redacted]')).toBeInTheDocument();
    expect(screen.queryByText(/prompt/i)).not.toBeInTheDocument();
  });

  it('renders setup readiness diagnostics without raw secrets', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^diagnostics$/i }));

    expect(await screen.findByText(/Setup readiness/i)).toBeInTheDocument();
    expect(screen.getByText(/Agent OpenRouter/i)).toBeInTheDocument();
    expect(screen.getByText(/core\+gateway/i)).toBeInTheDocument();
    expect(screen.getByText(/Codex Host Agent/i)).toBeInTheDocument();
    expect(screen.queryByText(/sk-openkit-web-e2e-secret/i)).not.toBeInTheDocument();
  });

  it('refreshes setup diagnostics from settings', async () => {
    let setupDiagnosticsCalls = 0;
    render(() => (
      <App client={createFakeClient({ onSetupDiagnostics: () => (setupDiagnosticsCalls += 1) })} />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^diagnostics$/i }));
    fireEvent.click(screen.getByRole('button', { name: /refresh setup diagnostics/i }));

    await waitFor(() => {
      expect(setupDiagnosticsCalls).toBe(2);
    });
  });

  it('starts Codex ChatGPT login from settings diagnostics', async () => {
    let oauthAccountSlotId: string | null = null;
    let oauthInput: Parameters<CoreClient['oauth']['openaiCodex']['startAccount']>[1] | null = null;
    render(() => (
      <App
        client={createFakeClient({
          onStartOpenAICodexOAuth: (accountSlotId, input) => {
            oauthAccountSlotId = accountSlotId;
            oauthInput = input;
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^diagnostics$/i }));
    fireEvent.click(screen.getByRole('button', { name: /Continue with ChatGPT/i }));

    await waitFor(() => {
      expect(oauthAccountSlotId).toBe('default');
      expect(oauthInput).toEqual({ mode: 'browser' });
    });
    expect(await screen.findByRole('link', { name: /Open ChatGPT login/i })).toHaveAttribute(
      'href',
      'https://chatgpt.com/auth/codex/login'
    );
  });

  it('keeps Codex account creation errors local to settings diagnostics', async () => {
    const duplicateError = new Error('Codex OAuth account slot already exists: default');
    const { container } = render(() => (
      <App
        client={createFakeClient({
          createCodexOAuthAccountError: duplicateError,
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^diagnostics$/i }));
    fireEvent.input(screen.getByLabelText(/Slot\/folder ID/i), {
      target: { value: 'default' },
    });
    fireEvent.input(screen.getByLabelText(/^Display name$/i), {
      target: { value: 'SlotMeID' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add account/i }));

    expect(await screen.findByText(duplicateError.message)).toBeInTheDocument();
    expect(screen.getByLabelText(/Slot\/folder ID/i)).toHaveValue('default');
    expect(screen.getByLabelText(/^Display name$/i)).toHaveValue('SlotMeID');
    expect(container.querySelector('.alert.alert-error')).toBeNull();
  });

  it('reloads runtime config from settings and marks the active session stale', async () => {
    let reloadInput: Parameters<CoreClient['runtimeConfig']['reload']>[0] | null = null;
    render(() => (
      <App
        client={createFakeClient({
          onReloadRuntimeConfig: (input) => {
            reloadInput = input;
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(await screen.findByRole('button', { name: /protocol design review/i }));
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^diagnostics$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^reload runtime config$/i }));

    await waitFor(() => {
      expect(reloadInput).toEqual({ dryRun: false, mode: 'safe' });
    });

    expect(await screen.findByText(/v3/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /protocol design review/i }));
    expect(screen.getByText(/stale config/i)).toBeInTheDocument();
  });

  it('manages runtime config files from settings with validation and dry-run reload', async () => {
    let reloadInput: Parameters<CoreClient['runtimeConfig']['reload']>[0] | null = null;
    render(() => (
      <App
        client={createFakeClient({
          onReloadRuntimeConfig: (input) => {
            reloadInput = input;
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^runtime config$/i }));

    expect(await screen.findByRole('heading', { name: /^runtime config$/i })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /server\.jsonc/i })).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /workspaces\/ws_demo\/workspace\.jsonc/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/server: server config/i)).toBeInTheDocument();
    expect(screen.getByText(/workspace: Workspace config/i)).toBeInTheDocument();

    const editor = await screen.findByRole('textbox', { name: /runtime config source/i });
    expect((editor as HTMLTextAreaElement).value).toContain('"schemaVersion": 1');

    fireEvent.click(screen.getByRole('button', { name: /workspaces\/ws_demo\/workspace\.jsonc/i }));
    expect(await screen.findByText(/declared intent for host-worker v1/i)).toBeInTheDocument();

    fireEvent.input(screen.getByRole('textbox', { name: /new workspace config id/i }), {
      target: { value: 'ws_new' },
    });
    fireEvent.click(screen.getByRole('button', { name: /new workspace config/i }));

    expect(
      await screen.findByRole('button', { name: /workspaces\/ws_new\/workspace\.jsonc/i })
    ).toBeInTheDocument();

    fireEvent.input(screen.getByRole('textbox', { name: /new provider config name/i }), {
      target: { value: 'demo-provider' },
    });
    fireEvent.click(screen.getByRole('button', { name: /new provider profile/i }));

    expect(
      await screen.findByRole('button', { name: /providers\/demo-provider\.provider\.jsonc/i })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^validate$/i })).toBeInTheDocument();
    });

    fireEvent.input(editor, {
      target: {
        value: [
          '{',
          '  "schemaVersion": 1,',
          '  "defaults": { "coreProviderId": "agent-openrouter" }',
          '}',
          '',
        ].join('\n'),
      },
    });
    expect(screen.getByRole('button', { name: /^reload$/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /^validate$/i }));

    await waitFor(() => {
      expect(screen.getByText(/no diagnostics/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^reload$/i })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /dry run reload/i }));

    await waitFor(() => {
      expect(reloadInput).toEqual({ dryRun: true, mode: 'safe' });
    });
    expect(await screen.findByText(/dry-run/i)).toBeInTheDocument();
  });

  it('surfaces runtime config revision conflicts without overwriting local drafts', async () => {
    render(() => <App client={createFakeClient({ runtimeConfigConflictOnSave: true })} />);

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^runtime config$/i }));

    const editor = await screen.findByRole('textbox', { name: /runtime config source/i });
    fireEvent.input(editor, {
      target: {
        value: [
          '{',
          '  "schemaVersion": 1,',
          '  "defaults": { "coreProviderId": "conflicting-provider" }',
          '}',
          '',
        ].join('\n'),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload file from disk/i })).toBeInTheDocument();
    expect((editor as HTMLTextAreaElement).value).toContain('conflicting-provider');
  });

  it('does not validate a newly selected runtime config file with stale draft content', async () => {
    vi.useFakeTimers();
    const validationInputs: Parameters<CoreClient['runtimeConfig']['validate']>[0][] = [];

    try {
      render(() => (
        <App
          client={createFakeClient({
            onValidateRuntimeConfig: (input) => {
              validationInputs.push(input);
            },
          })}
        />
      ));

      await screen.findByRole('button', { name: /demo workspace/i });
      fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
      fireEvent.click(screen.getByRole('button', { name: /^runtime config$/i }));

      const editor = await screen.findByRole('textbox', { name: /runtime config source/i });
      validationInputs.length = 0;

      fireEvent.input(editor, {
        target: {
          value: [
            '{',
            '  "schemaVersion": 1,',
            '  "defaults": { "coreProviderId": "agent-openrouter" }',
            '}',
            '',
          ].join('\n'),
        },
      });
      fireEvent.click(
        screen.getByRole('button', { name: /workspaces\/ws_demo\/workspace\.jsonc/i })
      );

      await vi.advanceTimersByTimeAsync(800);

      expect(validationInputs).toEqual([
        expect.objectContaining({
          files: [
            expect.objectContaining({
              id: 'workspaces/ws_demo/workspace.jsonc',
              content: expect.stringContaining('"workspace"'),
            }),
          ],
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores stale runtime config validation failures after switching files', async () => {
    let shouldHoldServerValidation = false;
    let rejectHeldValidation: ((error: Error) => void) | null = null;
    let heldValidationSettled = false;

    render(() => (
      <App
        client={createFakeClient({
          onValidateRuntimeConfig: async (input) => {
            if (!shouldHoldServerValidation || input.files[0]?.id !== 'server.jsonc') {
              return;
            }

            try {
              await new Promise<void>((_, reject) => {
                rejectHeldValidation = reject;
              });
            } finally {
              heldValidationSettled = true;
            }
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^runtime config$/i }));
    await screen.findByRole('textbox', { name: /runtime config source/i });
    await screen.findByRole('button', { name: /^validate$/i });
    shouldHoldServerValidation = true;

    fireEvent.click(screen.getByRole('button', { name: /^validate$/i }));

    await waitFor(() => {
      expect(rejectHeldValidation).toBeTypeOf('function');
    });

    fireEvent.click(screen.getByRole('button', { name: /workspaces\/ws_demo\/workspace\.jsonc/i }));
    expect(await screen.findByText(/declared intent for host-worker v1/i)).toBeInTheDocument();

    const rejectValidation = rejectHeldValidation as ((error: Error) => void) | null;

    if (!rejectValidation) {
      throw new Error('Expected held validation rejection callback.');
    }

    rejectValidation(new Error('stale server validation failed'));

    await waitFor(() => {
      expect(heldValidationSettled).toBe(true);
    });
    expect(screen.queryByText(/stale server validation failed/i)).not.toBeInTheDocument();
  });

  it('searches nanocore app records from the workspace dashboard', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^dashboard$/i }));
    fireEvent.input(screen.getByRole('searchbox', { name: /search app records/i }), {
      target: { value: 'protocol' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

    expect(await screen.findByText(/Protocol design review/i)).toBeInTheDocument();
    expect(screen.getByText(/Product focus/i)).toBeInTheDocument();
  });

  it('nests collapsible thread access inside each workspace and opens dashboards', async () => {
    render(() => <App client={createFakeClient()} />);

    const workspaceButton = await screen.findByRole('button', { name: /demo workspace/i });
    expect(screen.getByRole('navigation', { name: /threads in demo workspace/i })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /collapse workspace threads/i }));
    expect(screen.queryByRole('navigation', { name: /threads in demo workspace/i })).toBeNull();

    fireEvent.click(workspaceButton);
    expect(
      await screen.findByRole('heading', { name: /demo workspace dashboard/i })
    ).toBeInTheDocument();
    expect(await screen.findByText(/7 threads/i)).toBeInTheDocument();
    expect(screen.getByText(/2 providers/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /expand workspace threads/i }));
    fireEvent.click(await screen.findByRole('button', { name: /protocol design review/i }));
    expect(
      await screen.findByRole('heading', { name: /protocol design review dashboard/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /agent session/i })).toBeInTheDocument();
    expect(screen.getByText(/Turn prompt/i)).toBeInTheDocument();
    expect(await screen.findByText(/Restored from nanocore replay/i)).toBeInTheDocument();
  });

  it('opens a right item log sidebar from the thread dashboard', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(await screen.findByRole('button', { name: /protocol design review/i }));
    fireEvent.click(await screen.findByRole('button', { name: /open item log/i }));

    const itemLog = screen.getByRole('complementary', { name: /item log/i });
    expect(itemLog).toBeInTheDocument();
    expect(itemLog).toHaveClass('item-log-sidebar-sticky');
    expect(itemLog).toHaveClass('item-log-sidebar-scrollable');
    expect(screen.getByRole('button', { name: /close item log/i })).toBeInTheDocument();
    expect(screen.getAllByText(/Restored from nanocore replay/i).length).toBeGreaterThanOrEqual(1);
    expect(
      within(itemLog).getByText(/Rate limit exceeded: 5 requests per minute/i)
    ).toBeInTheDocument();
    expect(screen.getByTestId('workbench-shell')).toHaveClass('app-shell-with-log');
  });

  it('lets the user switch daisyUI themes and persists the selected theme', async () => {
    const { unmount } = render(() => <App client={createFakeClient()} />);

    const root = await screen.findByTestId('app-root');
    expect(root).toHaveAttribute('data-theme', 'light');

    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^appearance$/i }));
    fireEvent.click(screen.getByRole('button', { name: /theme dark/i }));

    expect(root).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem('openkit.web.theme')).toBe('dark');

    unmount();
    render(() => <App client={createFakeClient()} />);

    expect(await screen.findByTestId('app-root')).toHaveAttribute('data-theme', 'dark');
  });

  it('supports all built-in daisyUI themes with compact preview cards', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^appearance$/i }));

    const themeSelector = screen.getByRole('group', { name: /theme selector/i });
    const themeButtons = [...themeSelector.querySelectorAll('button.theme-preview')];

    expect(themeSelector).toHaveClass('theme-selector-panel');
    expect(themeButtons).toHaveLength(DAISYUI_THEMES.length);
    for (const theme of DAISYUI_THEMES) {
      const button = screen.getByRole('button', { name: `Theme ${theme}` });
      expect(button).toHaveAttribute('data-theme', theme);
      expect(button.querySelector('.theme-preview-rail')).toBeInTheDocument();
      expect(button.querySelectorAll('.theme-swatch')).toHaveLength(4);
    }
  });

  it('keeps theme support token-based instead of hard-coded to one palette', () => {
    const cssSource = readFileSync('src/index.css', 'utf8');

    expect(cssSource).toContain('themes: all');
    expect(appSource).not.toMatch(/text-(stone|slate)-/);
  });

  it('sends a fresh request id when stopping the active turn', async () => {
    let interruptInput: Parameters<CoreClient['core']['interruptTurn']>[0] | null = null;
    render(() => (
      <App
        client={createFakeClient({
          onInterrupt: (input) => {
            interruptInput = input;
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(await screen.findByRole('button', { name: /protocol design review/i }));

    fireEvent.input(await screen.findByLabelText(/turn prompt/i), {
      target: { value: 'Review the workspace protocol.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send turn/i }));

    expect((await screen.findAllByText(/approve workspace update/i)).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /stop turn/i }));

    await waitFor(() => {
      expect(interruptInput).not.toBeNull();
    });
    const request = interruptInput as { requestId?: string } | null;
    expect(request?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('locks the thread composer workspace and sends the selected model override', async () => {
    let turnInput: Parameters<CoreClient['core']['startTurn']>[0] | null = null;
    render(() => (
      <App
        client={createFakeClient({
          onTurnInput: (input) => {
            if (!input.turnId) {
              turnInput = input;
            }
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(await screen.findByRole('button', { name: /protocol design review/i }));
    await screen.findByRole('heading', { name: /protocol design review dashboard/i });

    const turnComposer = screen.getByRole('region', { name: /turn composer/i });
    expect(within(turnComposer).queryByRole('combobox', { name: /workspace/i })).toBeNull();
    expect(within(turnComposer).getByText(/demo workspace/i)).toBeInTheDocument();

    fireEvent.change(within(turnComposer).getByRole('combobox', { name: /^model$/i }), {
      target: { value: 'model_opencode' },
    });
    fireEvent.input(within(turnComposer).getByLabelText(/turn prompt/i), {
      target: { value: 'Review the workspace protocol.' },
    });
    fireEvent.click(within(turnComposer).getByRole('button', { name: /send turn/i }));

    await waitFor(() => {
      expect(turnInput).not.toBeNull();
    });
    expect(turnInput).toMatchObject({
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      modelId: 'model_opencode',
    });
  });

  it('sends a fresh request id when approving an inline request', async () => {
    let approvalInput: ApprovalResponseInput | null = null;
    render(() => (
      <App
        client={createFakeClient({
          onApproval: (input) => {
            approvalInput = input;
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(await screen.findByRole('button', { name: /protocol design review/i }));

    fireEvent.input(await screen.findByLabelText(/turn prompt/i), {
      target: { value: 'Review the workspace protocol.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send turn/i }));

    expect((await screen.findAllByText(/approve workspace update/i)).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));

    await waitFor(() => {
      expect(approvalInput).not.toBeNull();
    });
    const request = approvalInput as { requestId?: string } | null;
    expect(request?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(await screen.findByText(/^granted$/i)).toBeInTheDocument();
  });

  it('sends a fresh request id when answering an inline agent question', async () => {
    let turnInput: Parameters<CoreClient['core']['startTurn']>[0] | null = null;
    render(() => (
      <App
        client={createFakeClient({
          onTurnInput: (input) => {
            if (input.turnId) {
              turnInput = input;
            }
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(await screen.findByRole('button', { name: /protocol design review/i }));

    fireEvent.input(await screen.findByLabelText(/turn prompt/i), {
      target: { value: 'Review the workspace protocol.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send turn/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }));

    expect(
      (await screen.findAllByText(/which summary tone should the simulator use/i)).length
    ).toBeGreaterThan(0);

    fireEvent.input(screen.getByLabelText(/answer/i), {
      target: { value: 'Concise' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));

    await waitFor(() => {
      expect(turnInput).not.toBeNull();
    });
    const request = turnInput as { requestId?: string; turnId?: string; input?: string } | null;
    expect(request?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(request).toMatchObject({
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_1',
      input: 'Concise',
    });
    expect(await screen.findByText(/concise/i)).toBeInTheDocument();
  });

  it('shows the thread agent session badge and refreshes agent health', async () => {
    let refreshedWorkspaceId: string | null = null;
    let queuedTerminalCommand: {
      workspaceId: string;
      threadId: string;
      agentSessionId: string;
      argv: string[];
    } | null = null;
    render(() => (
      <App
        client={createFakeClient({
          onRefreshAgentHealth: (workspaceId) => {
            refreshedWorkspaceId = workspaceId;
          },
          onQueueAgentSessionTerminalCommand: (workspaceId, threadId, agentSessionId, input) => {
            queuedTerminalCommand = {
              workspaceId,
              threadId,
              agentSessionId,
              argv: input.argv,
            };
          },
        })}
      />
    ));

    await screen.findByRole('button', { name: /demo workspace/i });
    fireEvent.click(await screen.findByRole('button', { name: /protocol design review/i }));

    const agentSession = await screen.findByRole('region', { name: /agent session/i });
    expect(agentSession).toHaveTextContent('session_sim_th_demo');
    expect(agentSession).toHaveTextContent('idle');
    expect(agentSession).toHaveTextContent('agent_planner');
    expect(agentSession).toHaveTextContent('health ready');
    expect(agentSession).toHaveTextContent('openshell ready');
    expect(agentSession).toHaveTextContent('control running');
    expect(agentSession).toHaveTextContent('terminal 1/2');

    fireEvent.input(screen.getByRole('textbox', { name: /terminal command/i }), {
      target: { value: 'git status' },
    });
    fireEvent.click(screen.getByRole('button', { name: /queue terminal/i }));

    await waitFor(() => {
      expect(queuedTerminalCommand).toMatchObject({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        agentSessionId: 'session_sim_th_demo',
        argv: ['git', 'status'],
      });
    });

    fireEvent.click(screen.getByRole('button', { name: /refresh agent health/i }));

    await waitFor(() => {
      expect(refreshedWorkspaceId).toBe('ws_demo');
    });
    expect(agentSession).toHaveTextContent('health ready');
  });

  it('lets the user create knowledge, create a thread, run a turn, and approve it', async () => {
    render(() => <App client={createFakeClient()} />);

    await screen.findByRole('button', { name: /demo workspace/i });

    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^knowledge$/i }));

    fireEvent.input(await screen.findByLabelText(/knowledge title/i), {
      target: { value: 'Decision log' },
    });
    fireEvent.input(screen.getByLabelText(/knowledge content/i), {
      target: { value: 'Keep approvals visible in the UI.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add knowledge/i }));

    expect(await screen.findByText(/decision log/i)).toBeInTheDocument();
    expect(screen.getByText(/keep approvals visible in the ui\./i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /back to app/i }));
    fireEvent.click(await screen.findByRole('button', { name: /protocol design review/i }));
    expect(
      await screen.findByRole('heading', { name: /protocol design review dashboard/i })
    ).toBeInTheDocument();

    fireEvent.input(await screen.findByLabelText(/thread title/i), {
      target: { value: 'Approval path validation' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^new thread$/i }));

    const threadButton = await screen.findByRole('button', {
      name: /approval path validation/i,
    });
    fireEvent.click(threadButton);

    fireEvent.input(await screen.findByLabelText(/turn prompt/i), {
      target: { value: 'Review the workspace protocol.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send turn/i }));

    expect(await screen.findByText(/review the workspace protocol\./i)).toBeInTheDocument();
    expect((await screen.findAllByText(/approve workspace update/i)).length).toBeGreaterThan(0);
    expect(screen.getByText(/reviewing approval path validation/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    expect(
      (await screen.findAllByText(/which summary tone should the simulator use/i)).length
    ).toBeGreaterThan(0);
    fireEvent.input(screen.getByLabelText(/answer/i), {
      target: { value: 'Concise' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));

    expect(await screen.findByText(/protocol review summary/i)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /view artifact/i })[0]!);

    await waitFor(() => {
      expect(window.location.pathname).toMatch(/\/workspaces\/ws_demo\/artifacts\/ar_/);
    });
    expect(
      (await screen.findAllByText(/workspace protocol review completed with concise/i)).length
    ).toBeGreaterThan(0);
  });
});
