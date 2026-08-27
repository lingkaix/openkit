import { ThreadGoalSummaryResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { parseWorkspaceSharingError } from './app.js';
import { type CoreClient, createCoreClient } from './client.js';
import { ApiCallError, ProtocolValidationError } from './errors.js';
import { type SseEventEnvelope, subscribeTurnEvents } from './events.js';
import * as coreClientExports from './index.js';

const timestamp = '2026-05-28T00:00:00.000Z';
const requestId = '00000000-0000-4000-8000-000000000001';

interface RecordedRequest {
  readonly body: unknown;
  readonly hasBody: boolean;
  readonly headers: Record<string, string>;
  readonly method: string;
  readonly path: string;
}

interface RouteResponse {
  readonly body?: unknown;
  readonly status?: number;
}

type RouteMap = Record<string, RouteResponse | (() => RouteResponse)>;

/** Creates a JSON response for test fetchers. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

/** Creates a current protocol API error fixture. */
function apiError(code: string, message: string): Record<string, string> {
  return { protocolVersion: '0.5.0', code, message };
}

/** Creates a tiny SSE response from complete event payloads. */
function sseResponse(events: unknown[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Creates a client with a path-indexed fake fetch implementation. */
function createFakeClient(routes: RouteMap): {
  client: CoreClient;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    const method = init?.method ?? 'GET';
    const route = routes[`${method} ${path}`] ?? routes[path];
    let body: unknown = null;

    if (typeof init?.body === 'string') {
      body = JSON.parse(init.body) as unknown;
    }

    requests.push({
      body,
      hasBody: init?.body !== undefined,
      headers: headersToRecord(init?.headers),
      method,
      path,
    });

    if (!route) {
      return jsonResponse(apiError('not_found', path), 404);
    }

    const response = typeof route === 'function' ? route() : route;

    if (response.status === 204) {
      return new Response(null, { status: 204 });
    }

    return jsonResponse(response.body ?? null, response.status);
  };

  return {
    client: createCoreClient({ baseUrl: 'https://nanocore.test', fetch: fetcher }),
    requests,
  };
}

/** Normalizes request headers into a plain record for assertions. */
function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

/** Returns one valid workspace record. */
function workspace() {
  return {
    id: 'ws_demo',
    name: 'Demo',
    kind: 'general',
    status: 'active',
    counts: {
      artifactCount: 0,
      knowledgeEntryCount: 0,
      threadCount: 0,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Returns one authorized Workspace summary for sharing-client tests. */
function authorizedWorkspaceSummary() {
  return {
    effectiveRole: 'owner',
    membershipRevision: 1,
    ownerUserId: 'user_1',
    registryRevision: 1,
    workspace: workspace(),
  };
}

/** Returns one current Workspace member projection for sharing-client tests. */
function workspaceMember(status: 'active' | 'removed' = 'active') {
  return {
    accessLevel: 'editor',
    createdAt: timestamp,
    effectiveRole: status === 'active' ? ('editor' as const) : null,
    invitationId: 'invitation_1',
    joinedAt: timestamp,
    removedAt: status === 'removed' ? timestamp : null,
    revision: 1,
    status,
    updatedAt: timestamp,
    userId: 'user_2',
    workspaceId: 'ws_demo',
  };
}

/** Returns one pending Workspace invitation for sharing-client tests. */
function workspaceInvitation() {
  return {
    acceptedAt: null,
    createdAt: timestamp,
    declinedAt: null,
    effectiveStatus: 'pending',
    expiresAt: '2026-08-01T00:00:00.000Z',
    invitationId: 'invitation_1',
    inviteeUserId: 'user_2',
    inviterUserId: 'user_1',
    proposedAccessLevel: 'editor',
    revision: 1,
    revokedAt: null,
    updatedAt: timestamp,
    workspaceId: 'ws_demo',
  };
}

/** Returns one administrator-safe Workspace recovery projection. */
function workspaceAccessRecovery() {
  return {
    administratorRole: null,
    ownerUserId: 'user_1',
    registryRevision: 1,
    workspaceId: 'ws_demo',
  };
}

/** Returns one disabled canonical-user projection. */
function disabledUser() {
  return {
    disabledAt: timestamp,
    status: 'disabled',
    userId: 'user_2',
  };
}

/** Returns one valid thread record. */
function thread() {
  return {
    id: 'th_demo',
    workspaceId: 'ws_demo',
    name: 'Demo thread',
    preview: 'Demo thread',
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Returns one valid turn record. */
function turn() {
  return {
    id: 'turn_demo',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    triggerActor: { kind: 'user', id: 'user_1' },
    items: [],
    error: null,
    status: 'running',
    humanGate: null,
    configVersion: null,
    startedAt: timestamp,
    completedAt: null,
    durationMs: null,
  };
}

/** Returns one valid release-coupled Turn read projection. */
function turnReadProjection() {
  return {
    ...turn(),
    contextPackageDigest: `ctxpkg_sha256_${'a'.repeat(64)}`,
  };
}

/** Returns one valid artifact record. */
function artifact() {
  return {
    id: 'artifact_demo',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    turnId: 'turn_demo',
    kind: 'report',
    title: 'Demo artifact',
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'markdown', body: '# Demo' },
    contentDigest: `sha256:${'a'.repeat(64)}`,
    lastMutationRequestId: requestId,
    origin: {
      kind: 'turn-output',
      threadId: 'th_demo',
      turnId: 'turn_demo',
      requestId,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Returns one valid workspace synchronization review item. */
function workspaceSyncReview() {
  return {
    artifactId: 'ar_workspace_changes_1',
    changeSet: {
      id: 'wcs_1',
      materializationRecordId: 'wmr_1',
      inputSnapshotId: 'wis_1',
      workspaceId: 'ws_demo',
      resourceId: 'default',
      strategy: 'git',
      base: { commit: 'abc123', contentDigest: null },
      head: { commit: 'def456', contentDigest: null },
      changedPaths: [{ path: 'docs/spec.md', status: 'modified', binary: false }],
      patch: { ref: 'artifact://patch', digest: 'sha256:patch', bytes: 1200 },
      bundle: null,
      artifactIds: ['ar_workspace_changes_1'],
      evidenceRefs: [{ kind: 'worker', ref: 'turn_demo' }],
      redaction: { status: 'redacted', notes: [] },
      createdAt: timestamp,
    },
    patchPayload: {
      mediaType: 'text/x-diff',
      text: 'diff --git a/docs/spec.md b/docs/spec.md\n',
      digest: 'sha256:patch',
      bytes: 41,
    },
    review: {
      id: 'swr_1',
      changeSetId: 'wcs_1',
      workspaceId: 'ws_demo',
      status: 'pending',
      staging: {
        strategy: 'git_worktree',
        ref: 'staging://workspace/wcs_1',
        branch: 'openkit/review/swr_1',
      },
      diffSummary: { filesChanged: 1, additions: 0, deletions: 0 },
      riskSummary: '1 changed path staged for human review.',
      validation: [{ command: 'worker', status: 'passed', ref: 'turn_demo' }],
      actionCenterRowId: 'workspace-review:swr_1',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

/** Returns one durable workspace apply result. */
function workspaceApplyResult() {
  return {
    id: 'war_swr_1',
    workspaceId: 'ws_demo',
    reviewId: 'swr_1',
    changeSetId: 'wcs_1',
    status: 'applied',
    appliedPaths: ['docs/spec.md'],
    skippedPaths: [],
    conflictRecords: [],
    verification: [{ command: 'git apply --check', status: 'passed', ref: null }],
    commitIds: [],
    appliedAt: timestamp,
  };
}

/** Returns one redacted workspace repository resource. */
function repositoryResource() {
  return {
    workspaceId: 'ws_demo',
    resourceId: 'default',
    type: 'git_repository',
    displayName: 'OpenKit',
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
      resourceKind: 'git_repository',
      status: 'ready',
      summary: 'Repository is ready.',
      pathSummary: 'git repository ending in openkit',
    },
  };
}

/** Returns one redacted Git push record. */
function gitPushRecord() {
  return {
    id: 'gpr_1',
    workspaceId: 'ws_demo',
    repositoryResourceId: 'default',
    approvalRowId: 'har_1',
    policyDecisionId: 'pd_1',
    actorId: 'user_1',
    remoteSummary: 'GitHub repository openkit on origin',
    sourceRef: 'HEAD',
    targetBranch: 'main',
    commitIds: ['abc123'],
    reviewIds: ['swr_1'],
    remoteHeadBefore: 'def456',
    remoteHeadAfter: 'abc123',
    outcome: 'pushed',
    errorSummary: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Returns one redacted workspace repository diagnostic row. */
function repositoryDiagnostic() {
  return {
    workspaceId: 'ws_demo',
    resourceId: 'default',
    type: 'git_repository',
    displayName: 'OpenKit',
    diagnosticsStatus: 'ready',
    ready: true,
    summary: 'Repository is ready.',
    pathSummary: 'git repository ending in openkit',
    updatedAt: timestamp,
  };
}

/** Returns one runtime config status fixture. */
function runtimeConfigStatus() {
  return {
    currentVersion: 1,
    loadedAt: timestamp,
    lastReload: null,
    lastFailedReload: null,
    pendingRestart: [],
  };
}

/** Returns one runtime config reload plan fixture. */
function runtimeConfigPlan() {
  return {
    previousVersion: 1,
    nextVersion: 1,
    applied: [],
    deferred: [],
    requiresRestart: [],
    rejected: [],
    warnings: [],
  };
}

/** Returns one strict App Diagnostics fixture. */
function appDiagnostics() {
  return {
    service: 'nanocore',
    boot: bootReadiness(),
    gateway: { status: 'ok', endpoints: ['/v1/chat/completions'] },
    providers: {
      diagnostics: [
        {
          code: 'invalid-provider-profile',
          message: 'Provider profile could not be parsed.',
          profileId: 'provider_demo',
          source: 'config/providers/provider-demo.provider.jsonc',
          status: 'blocked',
        },
      ],
      registry: [
        {
          id: 'provider_demo',
          displayName: 'Provider Demo',
          gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
          kind: 'gateway',
          models: ['gpt-demo'],
        },
      ],
    },
    defaultProviders: {
      core: {
        configured: true,
        model: 'gpt-demo',
        origin: 'canonical',
        providerId: 'provider_demo',
      },
      gateway: {
        configured: false,
        origin: 'unset',
        reason: 'unset',
      },
    },
    defaults: {
      quickChat: { providerId: 'provider_demo', model: 'gpt-demo' },
      gateway: { providerId: null, model: null },
    },
    capabilities: ['core.questions'],
    runtimeConfig: runtimeConfigStatus(),
  };
}

/** Returns one strict boot readiness fixture. */
function bootReadiness() {
  return {
    bootId: 'boot_demo',
    acceptingProductWork: true,
    overall: 'ready',
    subsystems: {
      config: { state: 'ready', reasons: [] },
      storage: { state: 'ready', reasons: [] },
      policy: { state: 'ready', reasons: [] },
      vault: { state: 'ready', reasons: [] },
      scheduler: { state: 'ready', reasons: [] },
      llmGateway: { state: 'ready', reasons: [] },
      knowledgeIndex: { state: 'ready', reasons: [] },
    },
  };
}

/** Returns one valid Agent Catalog entry. */
function agent() {
  return {
    id: 'agent_demo',
    name: 'Demo Agent',
    kind: 'coder',
    status: 'enabled',
    modelId: null,
    skillIds: [],
    profiles: [],
    defaultProfileId: null,
    capabilities: [],
    sandboxSummary: null,
    health: {
      status: 'ready',
      message: null,
      checkedAt: timestamp,
    },
  };
}

/** Returns one valid knowledge entry. */
function knowledgeEntry() {
  return {
    id: 'mem_demo',
    kind: 'project-context',
    title: 'Demo knowledge',
    content: 'Shared context',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Returns one valid item log entry. */
function userMessageItem() {
  return {
    id: 'item_demo',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    turnId: 'turn_demo',
    type: 'user-message',
    status: 'completed',
    actor: { kind: 'user', id: 'user_1' },
    causationId: requestId,
    text: 'Hello',
    createdAt: timestamp,
    completedAt: timestamp,
  };
}

/** Returns one valid automation record. */
function automation() {
  return {
    id: 'auto_demo',
    name: 'Demo automation',
    workspaceId: 'ws_demo',
    cron: '0 9 * * *',
    prompt: 'Summarize status.',
    status: 'paused',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Returns one valid workspace dashboard read model. */
function workspaceDashboard() {
  return {
    workspace: workspace(),
    counts: {
      threadCount: 1,
      artifactCount: 1,
      knowledgeEntryCount: 1,
      providerCount: 1,
    },
    defaultContext: {
      modelId: null,
      agentId: 'agent_demo',
      skillIds: [],
    },
    agentHealth: [
      {
        agentId: 'agent_demo',
        status: 'ready',
        message: null,
        checkedAt: timestamp,
      },
    ],
    recentThreads: [thread()],
    activeWork: [],
    recentCompletions: [],
    attentionNeeded: [],
  };
}

/** Returns one valid thread dashboard read model. */
function threadDashboard() {
  return {
    thread: thread(),
    turns: [turn()],
    artifacts: [
      {
        id: 'artifact_demo',
        title: 'Demo artifact',
        status: 'ready',
        summary: null,
        updatedAt: timestamp,
      },
    ],
    workStatus: {
      currentMode: 'chat',
      selectedAgentId: 'agent_demo',
      activeTurnStatus: 'running',
      pendingApprovalCount: 0,
      pendingQuestionCount: 0,
      latestArtifact: null,
      routing: {
        decision: 'worker_turn',
        explanation: 'Route to the demo agent.',
        selectedAgentId: 'agent_demo',
        confidence: 1,
        requiredUserAction: null,
      },
    },
    composer: {
      disabled: false,
      defaultModelId: null,
      defaultAgentId: 'agent_demo',
    },
    itemLog: {
      href: '/api/app/workspaces/ws_demo/threads/th_demo/items',
    },
  };
}

/** Returns one valid thread goal summary read model. */
function threadGoalSummary() {
  return {
    goal: {
      goalId: 'goal_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      status: 'running',
      title: 'Ship release',
      objective: 'Make v0.0.6 ready.',
      currentTask: {
        taskId: 'task_demo',
        title: 'Run verification',
        status: 'running',
        orderIndex: 1,
      },
      taskCounts: {
        pending: 1,
        ready: 0,
        running: 1,
        reviewing: 0,
        completed: 2,
        blocked: 0,
        failed: 0,
      },
      pendingHumanAttention: {
        required: false,
        reason: null,
      },
      terminalState: null,
      updatedAt: timestamp,
    },
  };
}

/** Returns one valid thread goal summary read model for a given lifecycle status. */
function threadGoalSummaryForStatus(status: string) {
  const base = threadGoalSummary().goal!;

  if (status === 'no_goal') {
    return { goal: null };
  }

  if (status === 'planning') {
    return {
      goal: {
        ...base,
        status,
        currentTask: null,
        taskCounts: {
          pending: 0,
          ready: 0,
          running: 0,
          reviewing: 0,
          completed: 0,
          blocked: 0,
          failed: 0,
        },
      },
    };
  }

  if (status === 'awaiting_user') {
    return {
      goal: {
        ...base,
        status,
        currentTask: {
          taskId: 'task_demo',
          title: 'Answer release question',
          status: 'running',
          orderIndex: 1,
        },
        pendingHumanAttention: {
          required: true,
          reason: 'Worker needs release owner input.',
        },
      },
    };
  }

  if (status === 'completed') {
    return {
      goal: {
        ...base,
        status,
        currentTask: null,
        taskCounts: {
          pending: 0,
          ready: 0,
          running: 0,
          reviewing: 0,
          completed: 3,
          blocked: 0,
          failed: 0,
        },
        terminalState: {
          status: 'completed',
          stopReason: 'completed',
        },
        terminalSummary: {
          completedTaskIds: ['task_1', 'task_2', 'task_3'],
          blockedTaskIds: [],
          artifactIds: ['artifact_release_log'],
          verificationEvidence: [
            {
              verificationId: 'verify_release',
              status: 'passed',
              summary: 'Release verification passed.',
              command: 'pnpm -w verify:release',
              artifactIds: ['artifact_release_log'],
            },
          ],
          risks: [],
          suggestedNextWork: ['Publish v0.0.6.'],
        },
      },
    };
  }

  return {
    goal: {
      ...base,
      status,
    },
  };
}

/** Returns one valid deterministic goal plan payload. */
function goalPlanPayload() {
  return {
    schemaVersion: 1,
    goalSummary: 'Make v0.0.6 ready.',
    assumptions: ['The goal can be attempted as one bounded worker task.'],
    tasks: [
      {
        taskId: 'task_1',
        title: 'Ship release',
        objective: 'Make v0.0.6 ready.',
        acceptanceCriteria: ['The requested objective is implemented and verified.'],
        contextBudgetTokens: 12_000,
        resources: [
          {
            kind: 'repository',
            reference: 'linked workspace repository',
            reason: 'Default workspace context for the bounded worker task.',
          },
        ],
        expectedArtifacts: [
          {
            kind: 'artifact',
            description: 'Worker result summary and implementation evidence.',
          },
        ],
        verificationChecks: [
          {
            kind: 'manual',
            description: 'Review the worker output and confirm the objective is satisfied.',
          },
        ],
        reviewPolicy: {
          required: true,
          reviewers: ['human'],
          instructions: 'Review deterministic fallback output before continuing Goal Mode.',
        },
        dependsOnTaskIds: [],
        escalationConditions: [
          'Escalate if the objective needs decomposition into multiple tasks.',
        ],
      },
    ],
    risks: [
      'Deterministic fallback output is intentionally generic and may need human refinement.',
    ],
    questions: [],
    verificationApproach:
      'Use manual review for fallback-generated plans before worker execution begins.',
  };
}

/** Returns one valid setup diagnostics payload. */
function setupDiagnostics() {
  return {
    service: 'nanocore',
    server: {
      mode: 'local',
      dataRoot: 'configured',
      config: {
        schemaVersion: 1,
        defaults: {
          coreProviderId: null,
          gatewayProviderId: null,
        },
        gateway: {
          openaiCompatible: {
            enabled: null,
          },
        },
      },
    },
    providers: [],
    runtimeConfig: runtimeConfigStatus(),
    agents: [],
  };
}

/** Returns one storage layout report fixture. */
function storageLayoutReport() {
  return {
    dataRoot: '/tmp/openkit',
    serverDb: {
      path: 'server/db/core.sqlite',
      exists: true,
      appliedMigrations: ['core_0000_baseline'],
    },
    users: [],
    workspaces: [],
    quarantineEntries: [
      {
        scope: 'server',
        path: 'server/quarantine/1-core.sqlite',
        bytes: 4,
      },
    ],
  };
}

/** Returns one workspace export response fixture. */
function workspaceExportResponse() {
  return {
    exportId: 'wsexp_demo',
    workspaceId: 'ws_demo',
    manifest: {
      schemaVersion: 1,
      recordType: 'workspace-export',
      id: 'wsexp_demo',
      ownerScope: 'workspace',
      lineage: { workspaceId: 'ws_demo' },
      createdAt: timestamp,
      updatedAt: timestamp,
      contentDigest: 'sha256:manifest',
      redactionLevel: 'metadata',
      sensitivity: 'internal',
      requiredFeatures: [],
      extensions: {},
      sourceDeploymentId: 'dep_local',
      workspaceId: 'ws_demo',
      exportCreatedAt: timestamp,
      exportFormatVersion: 2,
      contentInventory: [
        {
          path: 'records/workspace.json',
          digest: 'sha256:ab4a13e5a040b76a82521f52dabddd42e7e4d4244c47e16ee8c6e1aa16233f3f',
          bytes: 16,
        },
      ],
    },
    fileCount: 1,
    totalBytes: 16,
    checkedFiles: ['records/workspace.json'],
  };
}

/** Returns one data-root backup response fixture. */
function dataRootBackupResponse() {
  return {
    backupId: 'drb_demo',
    manifest: {
      schemaVersion: 1,
      recordType: 'data-root-backup',
      id: 'drb_demo',
      ownerScope: 'server',
      lineage: {},
      createdAt: timestamp,
      updatedAt: timestamp,
      contentDigest: 'sha256:manifest',
      redactionLevel: 'metadata',
      sensitivity: 'internal',
      requiredFeatures: [],
      extensions: {},
      sourceDeploymentId: 'dep_local',
      backupStartedAt: timestamp,
      backupCompletedAt: timestamp,
      backupMode: 'hot',
      consistency: 'crash-consistent',
      backupFormatVersion: 1,
      contentInventory: [
        {
          path: 'server/db/core.sqlite',
          digest: 'sha256:ab4a13e5a040b76a82521f52dabddd42e7e4d4244c47e16ee8c6e1aa16233f3f',
          bytes: 16,
        },
      ],
    },
    fileCount: 1,
    totalBytes: 16,
    checkedFiles: ['server/db/core.sqlite'],
  };
}

/** Returns one redacted OpenKit access-token record. */
function accessTokenRecord(overrides: Record<string, unknown> = {}) {
  return {
    tokenId: 'tok_workspace',
    ownerUserId: 'user_owner',
    scope: 'workspace',
    workspaceIds: ['ws_demo'],
    status: 'active',
    issuedAt: timestamp,
    expiresAt: timestamp,
    revokedAt: null,
    predecessorTokenId: null,
    rotatedGraceExpiresAt: null,
    lastUsedAt: null,
    lastUsedChannel: null,
    lastUsedSource: null,
    ...overrides,
  };
}

/** Returns one redacted vault admin status fixture. */
function vaultAdminStatus(state = 'available') {
  return {
    backendKind: 'encrypted-file',
    diagnostic: `Vault backend is ${state}.`,
    state,
  };
}

/** Returns one capability usage response fixture. */
function capabilityUsageResponse() {
  return {
    capabilityCalls: [
      {
        id: 'cap_1',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        itemId: 'it_demo',
        agentId: 'assistant',
        agentSessionId: 'session_demo',
        packageSnapshotId: 'aep_snapshot_1',
        runtimeOriginRef: 'rto_0123456789abcdef01234567',
        runtimeCacheLineageRef: 'rcl_89abcdef0123456789abcdef',
        sourceIds: ['repo_default'],
        requestId: '00000000-0000-4000-8000-000000000911',
        capabilityId: 'llm.chat_completions',
        family: 'llm',
        operation: 'chat_completions',
        providerRef: 'openrouter',
        serviceRef: 'llm-gateway',
        redactionClass: 'metadata-only',
        status: 'succeeded',
        summary: 'LLM chat completion succeeded.',
        errorCode: null,
        startedAt: timestamp,
        completedAt: timestamp,
      },
    ],
    usageRecords: [
      {
        id: 'usage_1',
        workspaceId: 'ws_demo',
        responsibleUserId: 'user_1',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        itemId: 'it_demo',
        agentId: 'assistant',
        agentSessionId: 'session_demo',
        sourceIds: ['repo_default'],
        requestId: '00000000-0000-4000-8000-000000000911',
        capabilityCallId: 'cap_1',
        category: 'llm',
        unit: 'tokens',
        quantity: 12,
        modelId: 'openai/gpt-5.1',
        providerRef: 'openrouter',
        source: 'llm-gateway-adapter-reported:input',
        recordedAt: timestamp,
      },
    ],
    workspaceId: 'ws_demo',
  };
}

/** Returns one workspace evidence bundle response fixture. */
function workspaceEvidenceBundlesResponse() {
  return {
    workspaceId: 'ws_demo',
    evidenceBundles: [
      {
        id: 'evb_1',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        turnId: 'turn_demo',
        agentSessionId: null,
        backendType: null,
        sourceKind: 'manual',
        summary: 'Goal evidence is ready for review.',
        rawEvidenceRefs: [],
        redactedEvidenceRefs: [{ kind: 'artifact', ref: 'artifact_demo' }],
        contentDigests: ['sha256:9a0f3c8d4b7e5a6c9d2f1b0a3e4c5d6f7a8b9c0d1e2f3456789abcdef0123456'],
        retentionClass: 'turn-evidence',
        sensitivityClass: 'product-safe',
        importStatus: 'collected',
        requiredFeatures: ['evidence.bundle.v1'],
        createdAt: timestamp,
      },
    ],
  };
}

/** Returns one workspace runtime evidence response fixture. */
function workspaceRuntimeEvidenceResponse() {
  return {
    workspaceId: 'ws_demo',
    runtimeEvidence: [
      {
        id: 'rte_1',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        agentSessionId: 'session_demo',
        backendType: 'openshell',
        backendVersion: null,
        placement: 'local',
        phase: 'teardown',
        summary: 'Worker checkpoint terminal: completed.',
        policyDigest: null,
        workerImage: null,
        sandboxSummary: null,
        capabilitySummary: 'worker turn checkpoint',
        uploadManifest: [],
        downloadManifest: [],
        transcriptSummary: null,
        workspaceChangeSummary: null,
        controlSummary: null,
        outcome: 'succeeded',
        exitCode: 0,
        signal: null,
        stopReason: 'completed',
        errorCode: null,
        errorMessage: null,
        redactedStdoutSummary: null,
        redactedStderrSummary: null,
        evidenceBundleIds: [],
        contentDigests: ['sha256:runtime'],
        requiredFeatures: ['runtime.evidence.v1'],
        createdAt: timestamp,
        startedAt: null,
        completedAt: timestamp,
        collectedAt: timestamp,
      },
    ],
  };
}

/** Returns one workspace audit events response fixture. */
function workspaceAuditEventsResponse() {
  return {
    workspaceId: 'ws_demo',
    auditEvents: [
      {
        id: 'aud_1',
        workspaceId: 'ws_demo',
        protocolVersion: '0.5.0',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        itemId: null,
        capabilityCallId: null,
        permissionDecisionId: null,
        vaultGrantId: null,
        requestId: '00000000-0000-4000-8000-000000000001',
        actor: null,
        subject: null,
        agentId: null,
        agentSessionId: null,
        category: 'system',
        action: 'goal.create',
        resource: 'goal:goal_1',
        resourceRevision: null,
        outcome: 'succeeded',
        severity: 'info',
        summary: 'Goal created.',
        errorCode: null,
        createdAt: timestamp,
        occurredAt: timestamp,
      },
    ],
  };
}

/** Returns one server audit events response fixture. */
function serverAuditEventsResponse() {
  return {
    auditEvents: [
      {
        id: 'aud_server_1',
        workspaceId: null,
        protocolVersion: '0.5.0',
        threadId: null,
        turnId: null,
        itemId: null,
        capabilityCallId: null,
        permissionDecisionId: null,
        vaultGrantId: null,
        requestId,
        actor: null,
        subject: null,
        agentId: null,
        agentSessionId: null,
        category: 'system',
        action: 'server.config.update',
        resource: 'server:runtime-config',
        resourceRevision: null,
        outcome: 'succeeded',
        severity: 'info',
        summary: 'Runtime config updated.',
        errorCode: null,
        createdAt: timestamp,
        occurredAt: timestamp,
      },
    ],
  };
}

/** Returns one workspace permission decisions response fixture. */
function workspacePermissionDecisionsResponse() {
  return {
    workspaceId: 'ws_demo',
    permissionDecisions: [
      {
        decisionId: 'pd_1',
        ownerScope: 'workspace',
        workspaceId: 'ws_demo',
        policyEngineVersion: 'nanocore-worker-policy:v1',
        policySnapshotId: 'worker_turn_launch_policy',
        subjectSummary: { kind: 'nanocore', id: 'worker-coordinator' },
        action: 'runtime.launch',
        resourceSummary: { kind: 'worker-turn', turnId: 'turn_demo' },
        contextSummary: {
          requestId: '00000000-0000-4000-8000-00000000d791',
          threadId: 'th_demo',
          turnId: 'turn_demo',
        },
        result: 'allow',
        reasonCode: 'worker_turn_start_allowed',
        enforcementPoint: 'runtime.worker_turn_loop.start',
        requiredApprovalKind: null,
        approvalId: null,
        auditEventId: 'aud_1',
        createdAt: timestamp,
      },
    ],
  };
}

/** Returns one server permission decisions response fixture. */
function serverPermissionDecisionsResponse() {
  return {
    permissionDecisions: [
      {
        decisionId: 'pd_server_1',
        ownerScope: 'server',
        workspaceId: null,
        policyEngineVersion: 'nanocore-gateway-policy:v1',
        policySnapshotId: 'runtime_config_gateway_policy',
        subjectSummary: { kind: 'gateway-client', id: 'openai-compatible' },
        action: 'llm.gateway.chat_completions',
        resourceSummary: { kind: 'llm-provider', providerId: 'openrouter' },
        contextSummary: { route: '/v1/chat/completions' },
        result: 'allow',
        reasonCode: 'gateway_allowed',
        enforcementPoint: 'llm.gateway.policy',
        requiredApprovalKind: null,
        approvalId: null,
        auditEventId: null,
        createdAt: timestamp,
      },
    ],
  };
}

/** Returns one workspace vault use records response fixture. */
function workspaceVaultUseRecordsResponse() {
  return {
    workspaceId: 'ws_demo',
    vaultUseRecords: [
      {
        useId: 'use_1',
        ownerScope: 'workspace',
        workspaceId: 'ws_demo',
        vaultReferenceId: 'vault_github',
        materialVersion: 1,
        backendKind: 'encrypted-file',
        resolvingPath: 'grant',
        grantId: 'grant_github',
        planId: null,
        receiptId: null,
        agentSessionId: 'as_1',
        capabilityCallId: null,
        outcome: 'succeeded',
        failureCode: null,
        auditEventId: 'aud_1',
        usedAt: timestamp,
      },
    ],
  };
}

/** Returns one workspace vault grant metadata response fixture. */
function workspaceVaultGrantsResponse() {
  return {
    workspaceId: 'ws_demo',
    items: [
      {
        grantId: 'grant_github',
        vaultReferenceId: 'vault_github',
        ownerScope: 'workspace',
        workspaceId: 'ws_demo',
        userId: null,
        subjectSummary: null,
        targetAgentId: null,
        targetAgentSessionId: 'as_1',
        targetCapabilityId: null,
        allowedInjectionPaths: ['backend-provider'],
        lifetime: 'turn',
        policyDecisionId: 'pd_1',
        approvalId: null,
        status: 'active',
        createdAt: timestamp,
        expiresAt: null,
      },
    ],
  };
}

/** Returns one workspace injection plan metadata response fixture. */
function workspaceInjectionPlansResponse() {
  return {
    workspaceId: 'ws_demo',
    items: [
      {
        planId: 'plan_github',
        grantId: 'grant_github',
        packageSnapshotId: 'aepsnap_1',
        capabilityId: null,
        injectionVisibility: 'backend-provider',
        targetPath: null,
        targetEnvVarName: null,
        expirationBehavior: 'Expires with turn grant.',
        revocationBehavior: 'Detach provider.',
        redactionRule: 'Do not expose token.',
        backendCapabilityRequirement: 'OpenShell provider attachment.',
        status: 'active',
        createdAt: timestamp,
      },
    ],
  };
}

/** Returns one workspace injection receipt metadata response fixture. */
function workspaceInjectionReceiptsResponse() {
  return {
    workspaceId: 'ws_demo',
    items: [
      {
        receiptId: 'receipt_github',
        planId: 'plan_github',
        grantId: 'grant_github',
        agentSessionId: 'as_1',
        capabilityCallId: null,
        backendSummary: 'OpenShell provider github attached.',
        injectedAt: timestamp,
        expiresAt: null,
        revocationStatus: 'active',
        auditEventId: null,
      },
    ],
  };
}

/** Returns one server vault use records response fixture. */
function serverVaultUseRecordsResponse() {
  return {
    vaultUseRecords: [
      {
        useId: 'use_server_1',
        ownerScope: 'server',
        workspaceId: null,
        vaultReferenceId: 'vault_openrouter',
        materialVersion: 1,
        backendKind: 'encrypted-file',
        resolvingPath: 'provider',
        grantId: null,
        planId: null,
        receiptId: null,
        agentSessionId: null,
        capabilityCallId: null,
        outcome: 'failed',
        failureCode: 'backend-locked',
        auditEventId: 'aud_server_1',
        usedAt: timestamp,
      },
    ],
  };
}

/** Returns one workspace import dry-run response fixture. */
function workspaceImportDryRunResponse() {
  return {
    mode: 'dry-run',
    exportId: 'wsexp_demo',
    sourceWorkspaceId: 'ws_demo',
    exportedWorkspaceId: 'ws_demo',
    manifest: workspaceExportResponse().manifest,
    verification: { fileCount: 1, totalBytes: 16, checkedFiles: ['records/workspace.json'] },
    collision: {
      status: 'collides',
      workspaceId: 'ws_demo',
      suggestedWorkspaceId: 'ws_imported_ws_demo',
    },
  };
}

/** Returns one workspace import response fixture. */
function workspaceImportResponse() {
  return {
    mode: 'imported',
    requestId: 'req_import',
    exportId: 'wsexp_demo',
    sourceWorkspaceId: 'ws_demo',
    exportedWorkspaceId: 'ws_demo',
    importedWorkspaceId: 'ws_imported_ws_demo',
    manifest: workspaceExportResponse().manifest,
    verification: { fileCount: 1, totalBytes: 16, checkedFiles: ['records/workspace.json'] },
    collision: {
      status: 'collides',
      workspaceId: 'ws_demo',
      suggestedWorkspaceId: 'ws_imported_ws_demo',
    },
    workspace: {
      id: 'ws_imported_ws_demo',
      name: 'Imported workspace',
      kind: 'general',
      status: 'active',
      defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
      counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

/** Returns one interrupted worker recovery row. */
function interruptedWorkerState() {
  return {
    kind: 'interrupted_worker_state',
    checkpointId: 'ws_demo:th_demo:turn_worker',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    turnId: 'turn_worker',
    goalId: null,
    taskId: null,
    workerSessionId: null,
    stage: 'running_worker',
    iteration: 0,
    contextDigest: null,
    contextAssembly: null,
    stopReason: null,
    diagnosticsSummary: 'Interrupted before terminal save.',
    replayInstruction: false,
    choices: [
      {
        kind: 'inspect',
        label: 'Inspect interrupted worker evidence',
        recommended: true,
      },
      {
        kind: 'retry',
        label: 'Retry interrupted worker turn',
      },
      {
        kind: 'request_human',
        label: 'Ask the user how to recover this worker turn',
      },
    ],
    materializedAt: timestamp,
    sourceUpdatedAt: timestamp,
  };
}

/** Returns one valid turn event envelope. */
function turnEvent(sequence: number, event = 'turn.started') {
  return {
    protocolVersion: '0.5.0',
    event,
    sequence,
    requestId,
    timestamp,
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    turnId: 'turn_demo',
    data:
      event === 'turn.completed'
        ? {
            type: 'turn-completed',
            stopReason: 'completed',
            turn: { ...turn(), status: 'completed', completedAt: timestamp },
          }
        : { type: 'turn-started', turnId: 'turn_demo', status: 'running' },
  };
}

/** Returns one internal-only AgentSession stream event. */
function agentSessionEvent(sequence: number) {
  return {
    protocolVersion: '0.5.0',
    event: 'agent.session.updated',
    sequence,
    requestId,
    timestamp,
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    turnId: 'turn_demo',
    data: {
      type: 'agent-session-updated',
      agentSession: {
        id: 'as_demo',
        agentId: 'agent_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        status: 'busy',
        message: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  } as const;
}

const pseudoTerminalCases = [
  [
    'turn-completed data under another event',
    { ...turnEvent(5, 'turn.completed'), event: 'error' },
  ],
  ['another known data type under turn.completed', { ...turnEvent(5), event: 'turn.completed' }],
  [
    'forward-compatible unknown data under turn.completed',
    { ...turnEvent(5, 'turn.completed'), data: { type: 'future-terminal-event' } },
  ],
  [
    'a running Turn under turn.completed',
    {
      ...turnEvent(5, 'turn.completed'),
      data: { ...turnEvent(5, 'turn.completed').data, turn: turn() },
    },
  ],
  [
    'a pending Turn under turn.completed',
    {
      ...turnEvent(5, 'turn.completed'),
      data: {
        ...turnEvent(5, 'turn.completed').data,
        turn: { ...turn(), status: 'pending', startedAt: null },
      },
    },
  ],
  [
    'a mismatched envelope Workspace',
    { ...turnEvent(5, 'turn.completed'), workspaceId: 'ws_other' },
  ],
  ['a mismatched envelope Thread', { ...turnEvent(5, 'turn.completed'), threadId: 'th_other' }],
  ['a mismatched envelope Turn', { ...turnEvent(5, 'turn.completed'), turnId: 'turn_other' }],
  [
    'a mismatched payload Workspace',
    {
      ...turnEvent(5, 'turn.completed'),
      data: {
        ...turnEvent(5, 'turn.completed').data,
        turn: {
          ...turn(),
          status: 'completed',
          completedAt: timestamp,
          workspaceId: 'ws_other',
        },
      },
    },
  ],
  [
    'a mismatched payload Thread',
    {
      ...turnEvent(5, 'turn.completed'),
      data: {
        ...turnEvent(5, 'turn.completed').data,
        turn: { ...turn(), status: 'completed', completedAt: timestamp, threadId: 'th_other' },
      },
    },
  ],
  [
    'a mismatched payload Turn',
    {
      ...turnEvent(5, 'turn.completed'),
      data: {
        ...turnEvent(5, 'turn.completed').data,
        turn: { ...turn(), status: 'completed', completedAt: timestamp, id: 'turn_other' },
      },
    },
  ],
] as const;

/** Minimal EventSource test double for reconnect and delivery assertions. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  readonly url: string;
  closed = false;

  /** Records one opened EventSource URL for deterministic assertions. */
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  /** Registers a listener for one EventSource event type. */
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** Marks this EventSource instance as closed. */
  close(): void {
    this.closed = true;
  }

  /** Delivers one JSON-encoded event payload to registered listeners. */
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }
}

describe('createCoreClient', () => {
  it('exports only the ordinary product SSE envelope type', () => {
    // @ts-expect-error AgentSession events are internal and cannot inhabit the ordinary SSE type.
    const internalOnlyEvent: SseEventEnvelope = agentSessionEvent(1);

    expect(internalOnlyEvent.data.type).toBe('agent-session-updated');
  });

  it('exposes composed sub-clients without deprecated flat aliases', () => {
    const { client } = createFakeClient({});
    const providerSubscriptions = Reflect.get(client, 'providerSubscriptions') as
      | Record<string, unknown>
      | undefined;

    expect(client.core).toBeDefined();
    expect(client.app).toBeDefined();
    expect(client.runtimeConfig).toBeDefined();
    expect(client.auth.email).toBeDefined();
    expect(client.capabilities).toBeDefined();
    expect(client.agents).toBeDefined();
    expect(client.actionCenter).toBeDefined();
    expect(client.repositories).toBeDefined();
    expect('updateArtifactMetadata' in client.core).toBe(false);
    expect(client.app.listArtifactReviews).toBeTypeOf('function');
    expect(client.app.submitArtifactReviewDecision).toBeTypeOf('function');
    expect('refreshAgentHealth' in client.app).toBe(false);

    for (const alias of [
      'getMeta',
      'createKnowledgeEntry',
      'updateKnowledgeEntry',
      'respondToApproval',
      'subscribeToTurn',
      'getAppDiagnostics',
      'reloadRuntimeConfig',
    ]) {
      expect(alias in client).toBe(false);
    }

    expect.soft('oauth' in client).toBe(false);
    expect.soft('createOpenAICodexOAuthClient' in coreClientExports).toBe(false);
    expect.soft(providerSubscriptions).toBeDefined();

    for (const alias of [
      'listProviders',
      'listAccounts',
      'createAccount',
      'updateAccount',
      'deleteAccount',
      'getAccountStatus',
      'startAccountLogin',
      'cancelAccountLogin',
      'logoutAccount',
      'getAccountQuota',
    ]) {
      expect(alias in client).toBe(false);
    }

    if (providerSubscriptions) {
      expect(Object.keys(providerSubscriptions)).toEqual([
        'listProviders',
        'listAccounts',
        'createAccount',
        'updateAccount',
        'deleteAccount',
        'getAccountStatus',
        'startAccountLogin',
        'cancelAccountLogin',
        'logoutAccount',
        'getAccountQuota',
      ]);
    }

    for (const removedEvidenceOperation of [
      'createEvidenceBundle',
      'listWorkspaceSyncEvidenceBundles',
    ]) {
      expect(removedEvidenceOperation in client.app).toBe(false);
    }
  });

  it.each([
    [
      'Quick Chat',
      (client: CoreClient) =>
        client.app.quickChat({ input: 'Hello', providerId: 'caller-provider' } as never),
    ],
    [
      'Chat Mode',
      (client: CoreClient) =>
        client.app.startChatMode('ws_demo', 'th_demo', {
          input: 'Hello',
          model: 'caller-model',
        } as never),
    ],
  ])('rejects caller provider or model authority before %s transport', (_name, invoke) => {
    const { client, requests } = createFakeClient({});

    expect(() => invoke(client)).toThrow();
    expect(requests).toEqual([]);
  });

  it('routes core protocol calls through the core sub-client', async () => {
    const { client, requests } = createFakeClient({
      'GET /api/workspaces': { body: { items: [workspace()] } },
      'POST /api/workspaces': { body: workspace() },
      'GET /api/workspaces/ws_demo/resources': {
        body: { agents: [agent()], knowledge: [], models: [], skills: [] },
      },
      'POST /api/workspaces/ws_demo/threads': { body: thread() },
      'POST /api/turns': { body: turn() },
      'GET /api/workspaces/ws_demo/artifacts/artifact_demo': { body: artifact() },
    });

    await expect(client.core.listWorkspaces()).resolves.toEqual({ items: [workspace()] });
    await client.core.createWorkspace({ name: 'Demo' });
    await client.core.getWorkspaceResources('ws_demo');
    await client.core.createThread({ workspaceId: 'ws_demo', name: 'Demo thread' });
    await client.core.startTurn({ workspaceId: 'ws_demo', threadId: 'th_demo', input: 'Run' });
    await client.core.startTurn({
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      answers: { branch: ['main'] },
    });
    await expect(client.core.getArtifact('ws_demo', 'artifact_demo')).resolves.toEqual(artifact());

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /api/workspaces',
      'POST /api/workspaces',
      'GET /api/workspaces/ws_demo/resources',
      'POST /api/workspaces/ws_demo/threads',
      'POST /api/turns',
      'POST /api/turns',
      'GET /api/workspaces/ws_demo/artifacts/artifact_demo',
    ]);
    expect(requests[1]?.body).toMatchObject({ name: 'Demo', requestId: expect.any(String) });
    expect(requests[3]?.body).toMatchObject({ name: 'Demo thread', requestId: expect.any(String) });
    expect(requests[4]?.body).toMatchObject({ input: 'Run', requestId: expect.any(String) });
    expect(requests[5]?.body).toMatchObject({
      turnId: 'tu_demo',
      answers: { branch: ['main'] },
      requestId: expect.any(String),
    });
  });

  it('routes remaining core methods through validated protocol paths', async () => {
    const knowledge = knowledgeEntry();
    const item = userMessageItem();
    const { client, requests } = createFakeClient({
      'GET /api/meta': {
        body: {
          protocolVersion: '0.5.0',
          capabilities: [],
          eventFamilies: [],
        },
      },
      'GET /api/workspaces/ws_demo': { body: workspace() },
      'PATCH /api/workspaces/ws_demo': { body: workspace() },
      'GET /api/workspaces/ws_demo/knowledge': { body: { items: [knowledge] } },
      'POST /api/workspaces/ws_demo/knowledge': { body: knowledge },
      'PATCH /api/workspaces/ws_demo/knowledge/mem_demo': { body: knowledge },
      'DELETE /api/workspaces/ws_demo/knowledge/mem_demo': { status: 204 },
      'GET /api/workspaces/ws_demo/threads': { body: { items: [thread()] } },
      'GET /api/workspaces/ws_demo/threads/th_demo': { body: thread() },
      'PATCH /api/workspaces/ws_demo/threads/th_demo': { body: thread() },
      'POST /api/workspaces/ws_demo/threads/th_demo/archive': { body: thread() },
      'GET /api/workspaces/ws_demo/threads/th_demo/turns/turn_demo': {
        body: turnReadProjection(),
      },
      'POST /api/workspaces/ws_demo/threads/th_demo/turns/turn_demo/interrupt': {
        body: turn(),
      },
      'GET /api/workspaces/ws_demo/artifacts': { body: { items: [artifact()] } },
      'GET /api/app/workspaces/ws_demo/workspace-sync/reviews': {
        body: { items: [workspaceSyncReview()] },
      },
      'GET /api/app/workspaces/ws_demo/workspace-sync/reviews/swr_1': {
        body: workspaceSyncReview(),
      },
      'POST /api/app/workspaces/ws_demo/workspace-sync/reviews/swr_1/decision': {
        body: {
          review: { ...workspaceSyncReview().review, status: 'needs_refinement' },
          workspaceApplyResult: null,
        },
      },
      'POST /api/app/workspaces/ws_demo/workspace-sync/reconciliation-records/wrr_1/decision': {
        body: {
          reconciliationRecord: {
            id: 'wrr_1',
            workspaceId: 'ws_demo',
            triggerReason: 'manual',
            affectedRecordIds: ['wmr_1'],
            backendHandleSummary: {},
            backendReachability: {
              status: 'unavailable',
              checkedAt: timestamp,
              detail: null,
            },
            collectedOutputManifestIds: [],
            evidenceBundleIds: [],
            stateBefore: 'requires-human',
            stateAfter: 'quarantined',
            quarantineRefs: [],
            requiredHumanDecision: null,
            retentionDecision: 'retain-backend',
            startedAt: timestamp,
            finishedAt: timestamp,
          },
        },
      },
      'GET /api/app/workspaces/ws_demo/workspace-sync/input-snapshots': {
        body: {
          items: [
            {
              id: 'wis_1',
              workspaceId: 'ws_demo',
              resourceId: 'default',
              resourceKind: 'git_repository',
              strategy: 'git',
              pathScope: ['default'],
              writableRoots: ['default'],
              ignoredPaths: [],
              generatedFiles: [],
              base: { commit: 'abc123', contentDigest: null },
              backend: {
                kind: 'openshell',
                label: 'OpenShell',
                capabilitySummary: ['git-materialization'],
              },
              createdAt: timestamp,
            },
          ],
        },
      },
      'GET /api/app/workspaces/ws_demo/workspace-sync/materialization-records': {
        body: {
          items: [
            {
              id: 'wmr_1',
              inputSnapshotId: 'wis_1',
              workspaceId: 'ws_demo',
              backendKind: 'openshell',
              packageSnapshotId: 'aepsnap_1',
              workerSessionId: 'session_1',
              strategy: 'git',
              materializedRootRef: 'workspace://ws_demo/default',
              base: { commit: 'abc123', contentDigest: null },
              policyDigest: 'sha256:policy',
              readinessEvidence: [],
              createdAt: timestamp,
            },
          ],
        },
      },
      'GET /api/app/workspaces/ws_demo/workspace-sync/backend-handles': {
        body: {
          items: [
            {
              id: 'bwh_wmr_1',
              workspaceId: 'ws_demo',
              materializationRecordId: 'wmr_1',
              backendKind: 'openshell',
              packageSnapshotId: 'aepsnap_1',
              workerSessionId: 'session_1',
              transportRefs: [{ kind: 'materialized-root', ref: 'workspace://ws_demo/default' }],
              cleanupStatus: 'pending',
              retention: 'until-reconciliation',
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        },
      },
      'GET /api/app/workspaces/ws_demo/workspace-sync/output-manifests': {
        body: {
          items: [
            {
              id: 'wom_1',
              workspaceId: 'ws_demo',
              materializationRecordId: 'wmr_1',
              inputSnapshotId: 'wis_1',
              workerSessionId: 'session_1',
              backendKind: 'openshell',
              strategy: 'git',
              changedPaths: [{ path: 'docs/spec.md', status: 'modified', binary: false }],
              artifactIds: ['ar_patch'],
              logRefs: [],
              testOutputRefs: [],
              ignoredOutputs: [],
              evidenceRefs: [],
              collectedAt: timestamp,
            },
          ],
        },
      },
      'GET /api/app/workspaces/ws_demo/workspace-sync/change-sets': {
        body: { items: [workspaceSyncReview().changeSet] },
      },
      'GET /api/app/workspaces/ws_demo/workspace-sync/staged-reviews': {
        body: { items: [workspaceSyncReview().review] },
      },
      'GET /api/app/workspaces/ws_demo/workspace-sync/apply-plans': {
        body: {
          items: [
            {
              id: 'wap_swr_1',
              workspaceId: 'ws_demo',
              reviewId: 'swr_1',
              changeSetId: 'wcs_1',
              strategy: 'git',
              approvalState: 'approved',
              plannedWrites: ['docs/spec.md'],
              baselineChecks: [{ command: 'git apply --check', status: 'passed', ref: null }],
              pathConflicts: [],
              binaryRisks: [],
              permissionChanges: [],
              policyChecks: [{ command: 'workspace review accepted', status: 'passed', ref: null }],
              createdAt: timestamp,
            },
          ],
        },
      },
      'GET /api/app/workspaces/ws_demo/workspace-sync/reconciliation-records': {
        body: {
          items: [
            {
              id: 'wrr_1',
              workspaceId: 'ws_demo',
              triggerReason: 'restart',
              affectedRecordIds: ['wmr_1', 'bwh_wmr_1'],
              backendHandleSummary: {
                backendKind: 'openshell',
                handleId: 'bwh_wmr_1',
                workerSessionId: 'session_1',
                cleanupStatus: 'pending',
              },
              backendReachability: { status: 'unavailable', checkedAt: timestamp, detail: null },
              collectedOutputManifestIds: ['wom_1'],
              evidenceBundleIds: [],
              stateBefore: 'ready',
              stateAfter: 'requires-human',
              quarantineRefs: [],
              requiredHumanDecision: 'inspect_recovery',
              retentionDecision: 'retain-backend',
              startedAt: timestamp,
              finishedAt: null,
            },
          ],
        },
      },
      'GET /api/app/workspaces/ws_demo/workspace-sync/quarantine-records': {
        body: {
          items: [
            {
              id: 'wqr_1',
              workspaceId: 'ws_demo',
              lifecycleRecordIds: ['wrr_1', 'wom_1'],
              failureKind: 'digest_mismatch',
              storageRef: 'quarantine/workspace-sync/wqr_1',
              retentionClass: 'restricted-evidence',
              requiredHumanDecision: 'inspect_quarantined_output',
              resolution: 'pending',
              createdAt: timestamp,
              updatedAt: timestamp,
              resolvedAt: null,
            },
          ],
        },
      },
      'GET /api/app/workspaces/ws_demo/workspace-sync/apply-results': {
        body: { items: [workspaceApplyResult()] },
      },
      'GET /api/app/workspaces/ws_demo/workspace-sync/apply-results/war_swr_1': {
        body: workspaceApplyResult(),
      },
      'GET /api/app/workspaces/ws_demo/agent-environment/snapshots': {
        body: {
          items: [
            {
              snapshotId: 'aepsnap_1',
              workspaceId: 'ws_demo',
              turnId: 'turn_demo',
              threadId: 'th_demo',
              agentSessionId: 'as_demo',
              agentId: 'agent_codex',
              packageId: 'aepkg_1',
              runtimeKind: 'coder',
              backendKind: 'openshell',
              contentDigest: '0123456789abcdef',
              snapshot: { snapshotId: 'aepsnap_1' },
              createdAt: timestamp,
            },
          ],
        },
      },
      'GET /api/app/workspaces/ws_demo/agent-environment/snapshots/aepsnap_1': {
        body: {
          snapshotId: 'aepsnap_1',
          workspaceId: 'ws_demo',
          turnId: 'turn_demo',
          threadId: 'th_demo',
          agentSessionId: 'as_demo',
          agentId: 'agent_codex',
          packageId: 'aepkg_1',
          runtimeKind: 'coder',
          backendKind: 'openshell',
          contentDigest: '0123456789abcdef',
          snapshot: { snapshotId: 'aepsnap_1' },
          createdAt: timestamp,
        },
      },
      'GET /api/app/workspaces/ws_demo/threads/th_demo/items?since=4&limit=10': {
        body: { items: [item], nextCursor: null },
      },
    });

    await expect(client.core.meta()).resolves.toMatchObject({ protocolVersion: '0.5.0' });
    await expect(client.core.getWorkspace('ws_demo')).resolves.toEqual(workspace());
    await expect(client.core.updateWorkspace('ws_demo', { status: 'archived' })).resolves.toEqual(
      workspace()
    );
    await expect(client.core.listKnowledge('ws_demo')).resolves.toEqual({ items: [knowledge] });
    await expect(client.core.createKnowledge('ws_demo', knowledge)).resolves.toEqual(knowledge);
    await expect(
      client.core.updateKnowledge('ws_demo', 'mem_demo', { title: 'Updated' })
    ).resolves.toEqual(knowledge);
    await expect(client.core.deleteKnowledge('ws_demo', 'mem_demo')).resolves.toBeUndefined();
    await expect(client.core.listThreads('ws_demo')).resolves.toEqual({ items: [thread()] });
    await expect(client.core.getThread('ws_demo', 'th_demo')).resolves.toEqual(thread());
    await expect(
      client.core.updateThread({ workspaceId: 'ws_demo', threadId: 'th_demo', name: 'Renamed' })
    ).resolves.toEqual(thread());
    await expect(
      client.core.archiveThread({ workspaceId: 'ws_demo', threadId: 'th_demo' })
    ).resolves.toEqual(thread());
    await expect(client.core.getTurn('ws_demo', 'th_demo', 'turn_demo')).resolves.toEqual(
      turnReadProjection()
    );
    await expect(
      client.core.interruptTurn({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
      })
    ).resolves.toEqual(turn());
    await expect(client.core.listArtifacts('ws_demo')).resolves.toEqual({ items: [artifact()] });
    await expect(client.app.listWorkspaceSyncReviews('ws_demo')).resolves.toEqual({
      items: [workspaceSyncReview()],
    });
    await expect(client.app.getWorkspaceSyncReview('ws_demo', 'swr_1')).resolves.toEqual(
      workspaceSyncReview()
    );
    await expect(
      client.app.submitWorkspaceSyncReviewDecision('ws_demo', 'swr_1', {
        decision: 'needs_refinement',
      })
    ).resolves.toMatchObject({
      review: { id: 'swr_1', status: 'needs_refinement' },
      workspaceApplyResult: null,
    });
    await expect(
      client.app.submitWorkspaceRecoveryDecision('ws_demo', 'wrr_1', {
        decision: 'quarantine',
      })
    ).resolves.toMatchObject({
      reconciliationRecord: { id: 'wrr_1', stateAfter: 'quarantined' },
    });
    await expect(client.app.listWorkspaceInputSnapshots('ws_demo')).resolves.toMatchObject({
      items: [{ id: 'wis_1', strategy: 'git' }],
    });
    await expect(client.app.listWorkspaceMaterializationRecords('ws_demo')).resolves.toMatchObject({
      items: [{ id: 'wmr_1', inputSnapshotId: 'wis_1' }],
    });
    await expect(client.app.listBackendWorkspaceHandles('ws_demo')).resolves.toMatchObject({
      items: [{ id: 'bwh_wmr_1', materializationRecordId: 'wmr_1' }],
    });
    await expect(client.app.listWorkerOutputManifests('ws_demo')).resolves.toMatchObject({
      items: [{ id: 'wom_1', materializationRecordId: 'wmr_1' }],
    });
    await expect(client.app.listWorkspaceChangeSets('ws_demo')).resolves.toEqual({
      items: [workspaceSyncReview().changeSet],
    });
    await expect(client.app.listStagedWorkspaceReviews('ws_demo')).resolves.toEqual({
      items: [workspaceSyncReview().review],
    });
    await expect(client.app.listWorkspaceApplyPlans('ws_demo')).resolves.toMatchObject({
      items: [{ id: 'wap_swr_1', reviewId: 'swr_1' }],
    });
    await expect(client.app.listWorkspaceReconciliationRecords('ws_demo')).resolves.toMatchObject({
      items: [{ id: 'wrr_1', triggerReason: 'restart', stateAfter: 'requires-human' }],
    });
    await expect(client.app.listWorkspaceQuarantineRecords('ws_demo')).resolves.toMatchObject({
      items: [{ id: 'wqr_1', failureKind: 'digest_mismatch', resolution: 'pending' }],
    });
    await expect(client.app.listWorkspaceApplyResults('ws_demo')).resolves.toEqual({
      items: [workspaceApplyResult()],
    });
    await expect(client.app.getWorkspaceApplyResult('ws_demo', 'war_swr_1')).resolves.toEqual(
      workspaceApplyResult()
    );
    await expect(client.app.listAgentEnvironmentPackageSnapshots('ws_demo')).resolves.toMatchObject(
      {
        items: [{ snapshotId: 'aepsnap_1' }],
      }
    );
    await expect(
      client.app.getAgentEnvironmentPackageSnapshot('ws_demo', 'aepsnap_1')
    ).resolves.toMatchObject({
      snapshotId: 'aepsnap_1',
      snapshot: { snapshotId: 'aepsnap_1' },
    });
    await expect(
      client.core.listThreadItems('ws_demo', 'th_demo', { since: 4, limit: 10 })
    ).resolves.toEqual({ items: [item], nextCursor: null });

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /api/meta',
      'GET /api/workspaces/ws_demo',
      'PATCH /api/workspaces/ws_demo',
      'GET /api/workspaces/ws_demo/knowledge',
      'POST /api/workspaces/ws_demo/knowledge',
      'PATCH /api/workspaces/ws_demo/knowledge/mem_demo',
      'DELETE /api/workspaces/ws_demo/knowledge/mem_demo',
      'GET /api/workspaces/ws_demo/threads',
      'GET /api/workspaces/ws_demo/threads/th_demo',
      'PATCH /api/workspaces/ws_demo/threads/th_demo',
      'POST /api/workspaces/ws_demo/threads/th_demo/archive',
      'GET /api/workspaces/ws_demo/threads/th_demo/turns/turn_demo',
      'POST /api/workspaces/ws_demo/threads/th_demo/turns/turn_demo/interrupt',
      'GET /api/workspaces/ws_demo/artifacts',
      'GET /api/app/workspaces/ws_demo/workspace-sync/reviews',
      'GET /api/app/workspaces/ws_demo/workspace-sync/reviews/swr_1',
      'POST /api/app/workspaces/ws_demo/workspace-sync/reviews/swr_1/decision',
      'POST /api/app/workspaces/ws_demo/workspace-sync/reconciliation-records/wrr_1/decision',
      'GET /api/app/workspaces/ws_demo/workspace-sync/input-snapshots',
      'GET /api/app/workspaces/ws_demo/workspace-sync/materialization-records',
      'GET /api/app/workspaces/ws_demo/workspace-sync/backend-handles',
      'GET /api/app/workspaces/ws_demo/workspace-sync/output-manifests',
      'GET /api/app/workspaces/ws_demo/workspace-sync/change-sets',
      'GET /api/app/workspaces/ws_demo/workspace-sync/staged-reviews',
      'GET /api/app/workspaces/ws_demo/workspace-sync/apply-plans',
      'GET /api/app/workspaces/ws_demo/workspace-sync/reconciliation-records',
      'GET /api/app/workspaces/ws_demo/workspace-sync/quarantine-records',
      'GET /api/app/workspaces/ws_demo/workspace-sync/apply-results',
      'GET /api/app/workspaces/ws_demo/workspace-sync/apply-results/war_swr_1',
      'GET /api/app/workspaces/ws_demo/agent-environment/snapshots',
      'GET /api/app/workspaces/ws_demo/agent-environment/snapshots/aepsnap_1',
      'GET /api/app/workspaces/ws_demo/threads/th_demo/items?since=4&limit=10',
    ]);
    expect(requests[2]?.body).toMatchObject({ status: 'archived', requestId: expect.any(String) });
    expect(requests[6]?.body).toMatchObject({ requestId: expect.any(String) });
  });

  it('keeps approval response mutation on the core approval command path', async () => {
    const approval = {
      id: 'approval_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'turn_demo',
      kind: 'permission',
      status: 'granted',
      title: 'Run command',
      description: 'Allow command execution.',
      createdAt: timestamp,
      resolvedAt: timestamp,
    };
    const { client, requests } = createFakeClient({
      'POST /api/approvals/approval_demo/respond': { body: approval },
    });

    await client.core.respondApproval('approval_demo', {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'turn_demo',
      decision: 'granted',
    });

    expect(requests[0]?.body).toMatchObject({
      approvalRequestId: 'approval_demo',
      decision: 'granted',
      requestId: expect.any(String),
    });
  });

  it('routes the Stage 2 Artifact and Material surface through client.app', async () => {
    const contentDigest = `sha256:${'a'.repeat(64)}`;
    const material = {
      workspaceId: 'ws_demo',
      materialId: 'material_demo',
      title: 'Demo material',
      kind: 'markdown',
      currentRevisionId: 'revision_demo',
      sensitivity: 'internal',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const revision = {
      workspaceId: 'ws_demo',
      materialId: 'material_demo',
      revisionId: 'revision_demo',
      parentRevisionId: null,
      mediaType: 'text/markdown',
      contentDigest,
      authorId: 'user_demo',
      createdAt: timestamp,
    };
    const threadMaterial = {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      resource: material,
      currentRevision: revision,
      inclusionState: 'included',
      latestQueuedRevisionId: 'revision_demo',
      lastWorkerSeenRevisionId: null,
      currentTurnRevisionId: null,
      activeDelivery: null,
    };
    const routeCases = [
      [
        'POST /api/app/workspaces/ws_demo/artifacts/imports',
        { artifactId: 'artifact_demo', artifactVersion: 1 },
        201,
      ],
      [
        'POST /api/app/workspaces/ws_demo/threads/th_demo/artifacts/artifact_demo/introductions',
        {
          artifactId: 'artifact_demo',
          artifactVersion: 1,
          turnId: 'turn_introduction',
          itemId: 'item_introduction',
        },
        201,
      ],
      ['GET /api/app/workspaces/ws_demo/materials', { materials: [material] }, 200],
      ['POST /api/app/workspaces/ws_demo/materials', { materialId: 'material_demo' }, 201],
      ['GET /api/app/workspaces/ws_demo/materials/material_demo', { material }, 200],
      [
        'GET /api/app/workspaces/ws_demo/materials/material_demo/revisions',
        { revisions: [revision] },
        200,
      ],
      [
        'POST /api/app/workspaces/ws_demo/materials/material_demo/revisions',
        { materialId: 'material_demo', revisionId: 'revision_demo' },
        201,
      ],
      [
        'GET /api/app/workspaces/ws_demo/materials/material_demo/revisions/revision_demo',
        { revision: { ...revision, content: '# Demo material' } },
        200,
      ],
      [
        'GET /api/app/workspaces/ws_demo/threads/th_demo/material',
        { material: threadMaterial },
        200,
      ],
      [
        'POST /api/app/workspaces/ws_demo/threads/th_demo/materials/material_demo/bind',
        { materialId: 'material_demo', threadId: 'th_demo', outcome: 'bound' },
        200,
      ],
      [
        'POST /api/app/workspaces/ws_demo/threads/th_demo/materials/material_demo/unbind',
        { materialId: 'material_demo', threadId: 'th_demo', outcome: 'unbound' },
        200,
      ],
      [
        'POST /api/app/workspaces/ws_demo/threads/th_demo/materials/material_demo/exclude',
        { materialId: 'material_demo', threadId: 'th_demo', outcome: 'excluded' },
        200,
      ],
      [
        'POST /api/app/workspaces/ws_demo/threads/th_demo/materials/material_demo/restore',
        { materialId: 'material_demo', threadId: 'th_demo', outcome: 'included' },
        200,
      ],
    ] as const;
    const { client, requests } = createFakeClient(
      Object.fromEntries(routeCases.map(([path, body, status]) => [path, { body, status }]))
    );

    const responses = [
      await client.app.importWorkspaceArtifact('ws_demo', {
        title: 'Imported artifact',
        mediaType: 'text/markdown',
        contentDigest,
        content: '# Imported artifact',
      }),
      await client.app.introduceWorkspaceArtifact('ws_demo', 'th_demo', 'artifact_demo', {
        expectedArtifactVersion: 1,
      }),
      await client.app.listWorkspaceMaterials('ws_demo'),
      await client.app.createWorkspaceMaterial('ws_demo', {
        title: 'Demo material',
        kind: 'markdown',
        sensitivity: 'internal',
      }),
      await client.app.getWorkspaceMaterial('ws_demo', 'material_demo'),
      await client.app.listWorkspaceMaterialRevisions('ws_demo', 'material_demo'),
      await client.app.saveWorkspaceMaterialRevision('ws_demo', 'material_demo', {
        expectedRevisionId: null,
        contentDigest,
        content: '# Demo material',
      }),
      await client.app.getWorkspaceMaterialRevision('ws_demo', 'material_demo', 'revision_demo'),
      await client.app.getThreadMaterial('ws_demo', 'th_demo'),
      await client.app.bindThreadMaterial('ws_demo', 'th_demo', 'material_demo', {
        expectedBindingState: 'not_bound',
      }),
      await client.app.unbindThreadMaterial('ws_demo', 'th_demo', 'material_demo', {
        expectedBindingState: 'bound',
      }),
      await client.app.excludeThreadMaterial('ws_demo', 'th_demo', 'material_demo', {
        expectedBindingState: 'bound',
        expectedInclusionState: 'included',
        expectedQueuedRevisionId: 'revision_demo',
      }),
      await client.app.restoreThreadMaterial('ws_demo', 'th_demo', 'material_demo', {
        expectedBindingState: 'bound',
        expectedInclusionState: 'excluded',
      }),
    ];

    expect(responses).toEqual(routeCases.map(([, body]) => body));
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual(
      routeCases.map(([path]) => path)
    );
    expect(requests.map(({ body }) => body)).toEqual([
      {
        requestId: expect.any(String),
        title: 'Imported artifact',
        mediaType: 'text/markdown',
        contentDigest,
        content: '# Imported artifact',
      },
      { requestId: expect.any(String), expectedArtifactVersion: 1 },
      null,
      {
        requestId: expect.any(String),
        title: 'Demo material',
        kind: 'markdown',
        sensitivity: 'internal',
      },
      null,
      null,
      {
        requestId: expect.any(String),
        expectedRevisionId: null,
        contentDigest,
        content: '# Demo material',
      },
      null,
      null,
      { requestId: expect.any(String), expectedBindingState: 'not_bound' },
      { requestId: expect.any(String), expectedBindingState: 'bound' },
      {
        requestId: expect.any(String),
        expectedBindingState: 'bound',
        expectedInclusionState: 'included',
        expectedQueuedRevisionId: 'revision_demo',
      },
      {
        requestId: expect.any(String),
        expectedBindingState: 'bound',
        expectedInclusionState: 'excluded',
      },
    ]);
  });

  it('routes the Stage 4 Artifact Review surface through client.app', async () => {
    const contentDigest = `sha256:${'a'.repeat(64)}`;
    const review = {
      workspaceId: 'ws_demo',
      reviewId: 'review_demo',
      artifactId: 'artifact_demo',
      artifactVersion: 1,
      contentDigest,
      sourceThreadId: 'th_demo',
      sourceTurnId: 'turn_demo',
      sourceAgentId: 'agent_demo',
      materialProposal: null,
      decision: null,
      decisionActorId: null,
      feedback: null,
      decidedAt: null,
      followUpTurnId: null,
      appliedMaterialRevisionId: null,
      createdAt: timestamp,
    };
    const decision = {
      reviewId: review.reviewId,
      artifactId: review.artifactId,
      artifactVersion: review.artifactVersion,
      decision: 'accepted',
      followUpTurnId: null,
    };
    const { client, requests } = createFakeClient({
      'GET /api/app/workspaces/ws_demo/artifacts/artifact_demo/reviews': {
        body: { reviews: [review] },
      },
      'POST /api/app/workspaces/ws_demo/artifacts/artifact_demo/versions/1/review/decision': {
        body: decision,
      },
    });

    await expect(client.app.listArtifactReviews('ws_demo', 'artifact_demo')).resolves.toEqual({
      reviews: [review],
    });
    await expect(
      client.app.submitArtifactReviewDecision('ws_demo', 'artifact_demo', 1, {
        decision: 'accepted',
      })
    ).resolves.toEqual(decision);
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /api/app/workspaces/ws_demo/artifacts/artifact_demo/reviews',
      'POST /api/app/workspaces/ws_demo/artifacts/artifact_demo/versions/1/review/decision',
    ]);
    expect(requests[1]?.body).toEqual({ decision: 'accepted', requestId: expect.any(String) });
  });

  it('routes the exact closed Workspace sharing surface through client.app', async () => {
    const invitation = workspaceInvitation();
    const member = workspaceMember();
    const removedMember = workspaceMember('removed');
    const recovery = workspaceAccessRecovery();
    const summary = authorizedWorkspaceSummary();
    const user = disabledUser();
    const cases: Array<{
      body: unknown;
      invoke: (client: CoreClient) => Promise<unknown>;
      methodPath: string;
      response: unknown;
      status?: number;
    }> = [
      {
        body: null,
        invoke: (client) => client.app.listAuthorizedWorkspaces(),
        methodPath: 'GET /api/app/workspaces',
        response: { items: [summary] },
      },
      {
        body: null,
        invoke: (client) => client.app.listWorkspaceMembers('ws_demo'),
        methodPath: 'GET /api/app/workspaces/ws_demo/members',
        response: { items: [member] },
      },
      {
        body: null,
        invoke: (client) => client.app.listWorkspaceInvitations('ws_demo'),
        methodPath: 'GET /api/app/workspaces/ws_demo/invitations',
        response: { items: [invitation] },
      },
      {
        body: {
          inviteeEmail: 'invitee@example.com',
          proposedAccessLevel: 'editor',
          requestId,
        },
        invoke: (client) =>
          client.app.createWorkspaceInvitation('ws_demo', {
            inviteeEmail: 'invitee@example.com',
            proposedAccessLevel: 'editor',
            requestId,
          }),
        methodPath: 'POST /api/app/workspaces/ws_demo/invitations',
        response: { invitation },
        status: 201,
      },
      {
        body: null,
        invoke: (client) => client.app.listMyWorkspaceInvitations(),
        methodPath: 'GET /api/app/workspace-invitations',
        response: { items: [invitation] },
      },
      {
        body: { expectedRevision: 1, requestId },
        invoke: (client) =>
          client.app.acceptWorkspaceInvitation('invitation_1', {
            expectedRevision: 1,
            requestId,
          }),
        methodPath: 'POST /api/app/workspace-invitations/invitation_1/accept',
        response: { invitation },
      },
      {
        body: { expectedRevision: 1, requestId },
        invoke: (client) =>
          client.app.declineWorkspaceInvitation('invitation_1', {
            expectedRevision: 1,
            requestId,
          }),
        methodPath: 'POST /api/app/workspace-invitations/invitation_1/decline',
        response: { invitation },
      },
      {
        body: { expectedRevision: 1, requestId },
        invoke: (client) =>
          client.app.revokeWorkspaceInvitation('ws_demo', 'invitation_1', {
            expectedRevision: 1,
            requestId,
          }),
        methodPath: 'POST /api/app/workspaces/ws_demo/invitations/invitation_1/revoke',
        response: { invitation },
      },
      {
        body: { accessLevel: 'viewer', expectedRevision: 1, requestId },
        invoke: (client) =>
          client.app.changeWorkspaceMemberAccess('ws_demo', 'user_2', {
            accessLevel: 'viewer',
            expectedRevision: 1,
            requestId,
          }),
        methodPath: 'PATCH /api/app/workspaces/ws_demo/members/user_2',
        response: { member },
      },
      {
        body: { expectedRevision: 1, requestId },
        invoke: (client) =>
          client.app.removeWorkspaceMember('ws_demo', 'user_2', {
            expectedRevision: 1,
            requestId,
          }),
        methodPath: 'POST /api/app/workspaces/ws_demo/members/user_2/remove',
        response: { member: removedMember },
      },
      {
        body: { expectedRevision: 1, requestId },
        invoke: (client) =>
          client.app.leaveWorkspace('ws_demo', { expectedRevision: 1, requestId }),
        methodPath: 'POST /api/app/workspaces/ws_demo/leave',
        response: { member: removedMember },
      },
      {
        body: { expectedRegistryRevision: 1, requestId, targetUserId: 'user_2' },
        invoke: (client) =>
          client.app.transferWorkspaceOwnership('ws_demo', {
            expectedRegistryRevision: 1,
            requestId,
            targetUserId: 'user_2',
          }),
        methodPath: 'POST /api/app/workspaces/ws_demo/ownership/transfer',
        response: { workspace: summary },
      },
      {
        body: null,
        invoke: (client) => client.app.getWorkspaceAccessRecoveryState('ws_demo'),
        methodPath: 'GET /api/app/workspaces/ws_demo/access-recovery',
        response: { recovery },
      },
      {
        body: {
          action: 'add-self-as-editor',
          expectedRegistryRevision: 1,
          requestId,
        },
        invoke: (client) =>
          client.app.recoverWorkspaceAccess('ws_demo', {
            action: 'add-self-as-editor',
            expectedRegistryRevision: 1,
            requestId,
          }),
        methodPath: 'POST /api/app/workspaces/ws_demo/access-recovery',
        response: { recovery },
      },
      {
        body: { requestId },
        invoke: (client) => client.app.disableUser('user_2', { requestId }),
        methodPath: 'POST /api/app/users/user_2/disable',
        response: { user },
      },
    ];
    const routes = Object.fromEntries(
      cases.map((testCase) => [
        testCase.methodPath,
        { body: testCase.response, ...(testCase.status ? { status: testCase.status } : {}) },
      ])
    );
    const { client, requests } = createFakeClient(routes);

    for (const testCase of cases) {
      await expect(testCase.invoke(client)).resolves.toEqual(testCase.response);
    }

    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual(
      cases.map((testCase) => testCase.methodPath)
    );
    expect(requests.map(({ body }) => body)).toEqual(cases.map((testCase) => testCase.body));
  });

  it('narrows only schema-valid Workspace sharing revision conflicts', () => {
    const validConflict = new ApiCallError(409, 'Workspace membership revision changed.', {
      code: 'revision_conflict',
      details: { current: workspaceMember(), resource: 'membership' },
      requestId,
    });
    const malformedConflict = new ApiCallError(409, 'Workspace membership revision changed.', {
      code: 'revision_conflict',
      details: {
        current: { ...workspaceMember(), revision: 0 },
        resource: 'membership',
      },
      requestId,
    });
    const genericRecovery = new ApiCallError(409, 'Recovery is required.', {
      code: 'recovery_required',
      requestId,
    });

    expect(parseWorkspaceSharingError(validConflict)).toEqual({
      code: 'revision_conflict',
      details: { current: workspaceMember(), resource: 'membership' },
      message: 'Workspace membership revision changed.',
      protocolVersion: '0.5.0',
      requestId,
    });
    expect(parseWorkspaceSharingError(malformedConflict)).toBeNull();
    expect(parseWorkspaceSharingError(genericRecovery)).toBeNull();
  });

  it('routes the exact Stage 3 Goal steering commands through client.app', async () => {
    const contentDigest = `sha256:${'a'.repeat(64)}`;
    const queued = {
      state: 'queued',
      pendingTurnId: 'pending_goal_steering',
      requestId: 'req_send',
      contentItemId: 'it_goal_steering',
      goalId: 'goal_demo',
      activeTurnId: 'turn_worker',
    } as const;
    const followUp = {
      state: 'follow-up',
      pendingTurnId: queued.pendingTurnId,
      requestId: 'req_follow_up',
      sourceRequestId: queued.requestId,
      contentItemId: queued.contentItemId,
      goalId: queued.goalId,
      activeTurnId: queued.activeTurnId,
      followUpTurnId: 'turn_follow_up',
      followUpItemId: 'it_follow_up',
    } as const;
    const cancelled = {
      state: 'cancelled',
      pendingTurnId: queued.pendingTurnId,
      requestId: 'req_cancel',
      sourceRequestId: queued.requestId,
      contentItemId: queued.contentItemId,
      goalId: queued.goalId,
      activeTurnId: queued.activeTurnId,
    } as const;
    const { client, requests } = createFakeClient({
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/steering': { body: queued },
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/steering/pending_goal_steering/follow-up':
        {
          body: followUp,
        },
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/steering/pending_goal_steering/cancel':
        {
          body: cancelled,
        },
    });

    await expect(
      client.app.submitThreadGoalSteering('ws_demo', 'th_demo', {
        requestId: queued.requestId,
        materialId: 'material_demo',
        revisionId: 'revision_demo',
        contentDigest,
        note: 'Use this exact revision.',
      })
    ).resolves.toEqual(queued);
    await expect(
      client.app.convertGoalSteeringToFollowUp('ws_demo', 'th_demo', queued.pendingTurnId, {
        requestId: followUp.requestId,
      })
    ).resolves.toEqual(followUp);
    await expect(
      client.app.cancelGoalSteering('ws_demo', 'th_demo', queued.pendingTurnId, {
        requestId: cancelled.requestId,
      })
    ).resolves.toEqual(cancelled);

    expect(requests.map(({ path }) => path)).toEqual([
      '/api/app/workspaces/ws_demo/threads/th_demo/goal/steering',
      '/api/app/workspaces/ws_demo/threads/th_demo/goal/steering/pending_goal_steering/follow-up',
      '/api/app/workspaces/ws_demo/threads/th_demo/goal/steering/pending_goal_steering/cancel',
    ]);
    expect(requests.map(({ body }) => body)).toEqual([
      {
        requestId: queued.requestId,
        materialId: 'material_demo',
        revisionId: 'revision_demo',
        contentDigest,
        note: 'Use this exact revision.',
      },
      { requestId: followUp.requestId },
      { requestId: cancelled.requestId },
    ]);
  });

  it('routes NanoCore App API calls through app-owned schemas', async () => {
    const retrievalTraceId = 'krt_123e4567-e89b-42d3-a456-426614174000';
    const retrievalRequestDigest = `sha256:${'b'.repeat(64)}`;
    const retrievedPageDigest = `sha256:${'c'.repeat(64)}`;
    const proposalSourceReference = `source:ks_123e4567-e89b-42d3-a456-426614174000@sha256:${'d'.repeat(64)}`;
    const proposalPageBytes = [
      '---',
      'type: "KnowledgePage"',
      'title: "Release review"',
      'schema_version: "openkit-workspace-knowledge-schema-v1"',
      'status: "active"',
      'scope: "workspace"',
      `source_refs: ${JSON.stringify([proposalSourceReference])}`,
      'review_state: "accepted"',
      'sensitivity: "normal"',
      'freshness: "current"',
      `created_at: ${JSON.stringify(timestamp)}`,
      `updated_at: ${JSON.stringify(timestamp)}`,
      'openkit_entry_kind: "project-context"',
      'openkit_entry_id: "lessons/release-review"',
      '---',
      'Release reviews happen every Friday.',
      '',
    ].join('\n');
    const proposalPageDigest = `sha256:${'e'.repeat(64)}`;
    const { client, requests } = createFakeClient({
      'GET /api/app/diagnostics': { body: appDiagnostics() },
      'GET /api/app/storage/layout-report': { body: storageLayoutReport() },
      'POST /api/app/data-root/backups': { body: dataRootBackupResponse() },
      'POST /api/app/auth/bootstrap/consume': {
        body: {
          token: 'okt_owner_secret',
          record: {
            tokenId: 'tok_owner',
            ownerUserId: 'user_owner',
            scope: 'server-admin',
            workspaceIds: [],
            status: 'active',
            issuedAt: timestamp,
            expiresAt: timestamp,
            revokedAt: null,
            predecessorTokenId: null,
            rotatedGraceExpiresAt: null,
            lastUsedAt: null,
            lastUsedChannel: null,
            lastUsedSource: null,
          },
        },
      },
      'POST /api/app/data-root/backups/drb_demo/verify': { body: dataRootBackupResponse() },
      'POST /api/app/workspaces/ws_demo/export': { body: workspaceExportResponse() },
      'POST /api/app/workspace-imports/dry-run': { body: workspaceImportDryRunResponse() },
      'POST /api/app/workspace-imports': { body: workspaceImportResponse() },
      'POST /api/app/workspaces/ws_demo/vault/references/vault_imported/rebind': {
        body: {
          backendKind: 'encrypted-file',
          currentVersion: 1,
          ownerScope: 'workspace',
          referenceId: 'vault_imported',
          secretKind: 'api-token',
          status: 'active',
          workspaceId: 'ws_demo',
        },
      },
      'GET /api/app/workspaces/ws_demo/vault/references': {
        body: {
          items: [
            {
              backendKind: 'encrypted-file',
              currentVersion: 0,
              ownerScope: 'workspace',
              referenceId: 'vault_imported',
              secretKind: 'api-token',
              status: 'unbound',
              workspaceId: 'ws_demo',
            },
          ],
          workspaceId: 'ws_demo',
        },
      },
      'GET /api/app/workspaces/ws_demo/vault/grants': {
        body: workspaceVaultGrantsResponse(),
      },
      'GET /api/app/workspaces/ws_demo/vault/injection-plans': {
        body: workspaceInjectionPlansResponse(),
      },
      'GET /api/app/workspaces/ws_demo/vault/injection-receipts': {
        body: workspaceInjectionReceiptsResponse(),
      },
      'GET /api/app/workspaces/ws_demo/vault/use-records': {
        body: workspaceVaultUseRecordsResponse(),
      },
      'POST /api/app/quick-chat': {
        body: {
          id: 'quick_demo',
          status: 'completed',
          workspaceId: 'ws_demo',
          providerId: 'provider_demo',
          model: 'gpt-demo',
          content: 'Answer',
        },
      },
      'POST /api/app/workspaces/ws_demo/threads/th_demo/task': {
        body: {
          state: 'running',
          turn: turn(),
          evidence: {
            itemIds: ['it_task_status'],
            artifactIds: [],
          },
        },
      },
      'POST /api/app/workspaces/ws_demo/threads/th_demo/chat': {
        body: {
          outcome: 'answered',
          explanation: 'The Assistant answered directly.',
          turn: turn(),
          item: {
            id: 'it_chat_answer',
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: 'turn_demo',
            type: 'assistant-message',
            status: 'completed',
            text: 'Answer',
            createdAt: timestamp,
            completedAt: timestamp,
          },
          handoff: null,
        },
      },
      'POST /api/app/workspaces/ws_demo/knowledge/manager/answer': {
        body: {
          operationId: 'km_answer_demo',
          operation: 'answer',
          workspaceId: 'ws_demo',
          caller: 'app-api',
          query: 'release cadence',
          retrievalTraceId,
          outcome: 'answered',
          answer: 'Release cadence is weekly.',
          citations: [
            {
              knowledgeEntryId: 'mem_demo',
              kind: 'project-context',
              title: 'Release plan',
              excerpt: 'Release cadence is weekly.',
            },
          ],
          confidence: 0.65,
          uncertainty: null,
        },
      },
      'POST /api/app/workspaces/ws_demo/knowledge/sources': {
        body: {
          source: {
            id: 'ks_demo',
            workspaceId: 'ws_demo',
            kind: 'document',
            title: 'Release notes',
            uri: 'file://release.md',
            contentDigest: 'sha256:abc123',
            originatingThreadId: 'th_demo',
            originatingTurnId: null,
            originatingFileId: null,
            capturedAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          derivedRepresentations: [
            {
              id: 'ks_demo:text',
              workspaceId: 'ws_demo',
              sourceId: 'ks_demo',
              kind: 'text',
              path: 'sources/derived/ks_demo/text.json',
              materialPath: 'sources/materials/ks_demo/content.txt',
              contentDigest: 'sha256:abc123',
              sourceContentDigest: 'sha256:abc123',
              createdAt: timestamp,
            },
          ],
        },
      },
      'GET /api/app/workspaces/ws_demo/knowledge/sources': {
        body: {
          items: [
            {
              id: 'ks_demo',
              workspaceId: 'ws_demo',
              kind: 'document',
              title: 'Release notes',
              uri: 'file://release.md',
              contentDigest: 'sha256:abc123',
              originatingThreadId: 'th_demo',
              originatingTurnId: null,
              originatingFileId: null,
              capturedAt: timestamp,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        },
      },
      'GET /api/app/workspaces/ws_demo/knowledge/sources/ks_demo': {
        body: {
          source: {
            id: 'ks_demo',
            workspaceId: 'ws_demo',
            kind: 'document',
            title: 'Release notes',
            uri: 'file://release.md',
            contentDigest: 'sha256:abc123',
            originatingThreadId: 'th_demo',
            originatingTurnId: null,
            originatingFileId: null,
            capturedAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          derivedRepresentations: [
            {
              id: 'ks_demo:text',
              workspaceId: 'ws_demo',
              sourceId: 'ks_demo',
              kind: 'text',
              path: 'sources/derived/ks_demo/text.json',
              materialPath: 'sources/materials/ks_demo/content.txt',
              contentDigest: 'sha256:abc123',
              sourceContentDigest: 'sha256:abc123',
              createdAt: timestamp,
            },
          ],
        },
      },
      'GET /api/app/workspaces/ws_demo/knowledge/indexes': {
        body: {
          linkGraph: {
            schemaVersion: 1,
            workspaceId: 'ws_demo',
            rebuiltAt: timestamp,
            edges: [{ fromId: 'alpha', target: '/beta.md', toId: 'beta', resolved: true }],
          },
          validation: {
            schemaVersion: 1,
            workspaceId: 'ws_demo',
            rebuiltAt: timestamp,
            records: [
              {
                conceptId: 'alpha',
                path: 'knowledge/pages/alpha.md',
                title: 'Alpha',
                conformance: 'Workspace-schema-valid',
                active: true,
                indexed: true,
                errors: [],
              },
            ],
          },
          sourceReferences: {
            schemaVersion: 1,
            workspaceId: 'ws_demo',
            rebuiltAt: timestamp,
            references: [
              {
                conceptId: 'alpha',
                path: 'knowledge/pages/alpha.md',
                reference: 'source:ks_demo',
                kind: 'registered-source',
                targetId: 'ks_demo',
                resolved: true,
              },
            ],
          },
          fullText: {
            schemaVersion: 1,
            workspaceId: 'ws_demo',
            rebuiltAt: timestamp,
            tokenizer: 'unicode-simple-v1',
            terms: [
              {
                term: 'alpha',
                postings: [
                  {
                    conceptId: 'alpha',
                    fields: ['title', 'body'],
                    occurrences: 2,
                  },
                ],
              },
            ],
          },
        },
      },
      'POST /api/app/workspaces/ws_demo/knowledge/observations': {
        body: {
          observation: {
            id: 'ko_demo',
            workspaceId: 'ws_demo',
            kind: 'retrieval',
            summary: 'Worker repeatedly needed release cadence context.',
            sourceReferences: ['knowledge:kn_demo', 'source:ks_demo'],
            scope: 'workspace',
            producer: 'knowledge-manager',
            confidence: 0.75,
            freshness: 'current',
            status: 'retained',
            observedAt: timestamp,
            createdAt: timestamp,
          },
        },
      },
      'GET /api/app/workspaces/ws_demo/knowledge/observations': {
        body: {
          items: [
            {
              id: 'ko_demo',
              workspaceId: 'ws_demo',
              kind: 'retrieval',
              summary: 'Worker repeatedly needed release cadence context.',
              sourceReferences: ['knowledge:kn_demo', 'source:ks_demo'],
              scope: 'workspace',
              producer: 'knowledge-manager',
              confidence: 0.75,
              freshness: 'current',
              status: 'retained',
              observedAt: timestamp,
              createdAt: timestamp,
            },
          ],
        },
      },
      'POST /api/app/workspaces/ws_demo/knowledge/claims': {
        body: {
          claim: {
            id: 'kc_demo',
            workspaceId: 'ws_demo',
            statement: 'Release cadence is weekly.',
            sourceReferences: ['knowledge:release-plan', 'source:ks_release'],
            scope: 'workspace',
            producer: 'knowledge-manager',
            confidence: 0.8,
            freshness: 'current',
            reviewState: 'needs-review',
            conflictStatus: 'none',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
      },
      'GET /api/app/workspaces/ws_demo/knowledge/claims': {
        body: {
          items: [
            {
              id: 'kc_demo',
              workspaceId: 'ws_demo',
              statement: 'Release cadence is weekly.',
              sourceReferences: ['knowledge:release-plan', 'source:ks_release'],
              scope: 'workspace',
              producer: 'knowledge-manager',
              confidence: 0.8,
              freshness: 'current',
              reviewState: 'needs-review',
              conflictStatus: 'none',
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        },
      },
      'POST /api/app/workspaces/ws_demo/knowledge/conflicts': {
        body: {
          conflict: {
            id: 'kf_demo',
            workspaceId: 'ws_demo',
            subjectReferences: ['knowledge:release-plan', 'claim:kc_release'],
            sourceReferences: ['source:ks_release', 'source:ks_correction'],
            status: 'conflicting',
            summary: 'Release cadence has contradictory source evidence.',
            suggestedActions: ['Ask the user which source is authoritative.'],
            producer: 'knowledge-manager',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
      },
      'GET /api/app/workspaces/ws_demo/knowledge/conflicts': {
        body: {
          items: [
            {
              id: 'kf_demo',
              workspaceId: 'ws_demo',
              subjectReferences: ['knowledge:release-plan', 'claim:kc_release'],
              sourceReferences: ['source:ks_release', 'source:ks_correction'],
              status: 'conflicting',
              summary: 'Release cadence has contradictory source evidence.',
              suggestedActions: ['Ask the user which source is authoritative.'],
              producer: 'knowledge-manager',
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        },
      },
      'POST /api/app/workspaces/ws_demo/knowledge/conflicts/kf_demo/resolution': {
        body: {
          conflict: {
            id: 'kf_demo',
            workspaceId: 'ws_demo',
            subjectReferences: ['knowledge:release-plan', 'claim:kc_release'],
            sourceReferences: ['source:ks_release', 'source:ks_correction'],
            status: 'resolved',
            summary: 'Release cadence has contradictory source evidence.',
            suggestedActions: ['Ask the user which source is authoritative.'],
            producer: 'knowledge-manager',
            resolution: 'Friday release reviews are authoritative.',
            resolvedAt: timestamp,
            resolvedBy: 'knowledge-manager',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
      },
      'POST /api/app/workspaces/ws_demo/knowledge/retrievals': {
        body: {
          traceId: retrievalTraceId,
          workspaceId: 'ws_demo',
          caller: 'app-api',
          requestDigest: retrievalRequestDigest,
          retrievalParameters: {
            limit: 1,
            pinnedConceptIds: [],
          },
          createdAt: timestamp,
          selected: [
            {
              knowledgePageId: 'release-plan',
              contentDigest: retrievedPageDigest,
              score: 4,
              sourceReferences: ['source:ks_demo'],
            },
          ],
          excluded: [
            {
              knowledgePageId: 'old-plan',
              contentDigest: null,
              reason: 'sensitive_content',
            },
          ],
        },
      },
      'POST /api/app/workspaces/ws_demo/knowledge/manager/context': {
        body: {
          operationId: 'km_context_demo',
          operation: 'prepare-context-material',
          workspaceId: 'ws_demo',
          caller: 'app-api',
          retrievalTraceId,
          outcome: 'prepared',
          selected: [
            {
              knowledgePageId: 'release-plan',
              contentDigest: retrievedPageDigest,
              score: 4,
              sourceReferences: ['source:ks_demo'],
            },
          ],
          excluded: [
            {
              knowledgePageId: 'old-plan',
              contentDigest: null,
              reason: 'sensitive_content',
            },
          ],
        },
      },
      'POST /api/app/workspaces/ws_demo/knowledge/manager/proposals': {
        body: {
          operationId: 'km_proposal_demo',
          operation: 'draft-proposal',
          workspaceId: 'ws_demo',
          caller: 'app-api',
          proposal: {
            id: 'kp_demo',
            workspaceId: 'ws_demo',
            operation: 'create',
            knowledgePageId: 'lessons/release-review',
            canonicalPageBytes: proposalPageBytes,
            contentDigest: proposalPageDigest,
            sourceReferences: [proposalSourceReference],
            rationale: 'This evidence supports one reusable release-review rule.',
            confidence: 0.75,
            producer: {
              kind: 'agent',
              id: 'knowledge-manager',
              responsibleUserId: 'user_demo',
            },
            status: 'pending',
            createdAt: timestamp,
          },
          validation: {
            conformance: 'Workspace-schema-valid',
            generatedFromCompletedWorkHistory: false,
          },
        },
      },
      'POST /api/app/workspaces/ws_demo/knowledge/manager/repairs': {
        body: {
          operationId: 'km_repair_demo',
          operation: 'suggest-repair',
          workspaceId: 'ws_demo',
          caller: 'app-api',
          outcome: 'suggested',
          suggestions: [
            {
              id: 'repair_duplicate_title_release_plan',
              kind: 'duplicate-title',
              title: 'Duplicate title: Release plan',
              detail: '2 knowledge entries share the same normalized title.',
              affectedKnowledgeEntryIds: ['kn_1', 'kn_2'],
              autoApplicable: false,
              reviewRequired: true,
            },
          ],
        },
      },
      'POST /api/app/workspaces/ws_demo/knowledge/manager/health': {
        body: {
          operationId: 'km_health_demo',
          operation: 'health-check',
          workspaceId: 'ws_demo',
          caller: 'app-api',
          outcome: 'needs-attention',
          summary: 'Knowledge Manager found 1 repair suggestion.',
          checks: [
            {
              code: 'knowledge-present',
              status: 'pass',
              detail: '2 knowledge entries are available.',
            },
            {
              code: 'repair-suggestions',
              status: 'warn',
              detail: '1 review-required repair suggestion was found.',
            },
          ],
          repairSuggestions: [
            {
              id: 'repair_duplicate_title_release_plan',
              kind: 'duplicate-title',
              title: 'Duplicate title: Release plan',
              detail: '2 knowledge entries share the same normalized title.',
              affectedKnowledgeEntryIds: ['kn_1', 'kn_2'],
              autoApplicable: false,
              reviewRequired: true,
            },
          ],
        },
      },
      'GET /api/app/search?q=protocol%20design': {
        body: { items: [{ kind: 'workspace', id: 'ws_demo', title: 'Demo' }] },
      },
      'POST /api/app/workspaces/ws_demo/agents/health/refresh': {
        body: { items: [], sessions: [] },
      },
      'GET /api/app/agents': { body: { items: [agent()] } },
      'GET /api/app/agents/agent_demo': { body: agent() },
      'GET /api/app/workspaces/ws_demo/action-center': { body: { items: [] } },
      'GET /api/app/recovery/interrupted-workers': {
        body: { items: [interruptedWorkerState()] },
      },
      'POST /api/app/workspaces/ws_demo/threads/th_demo/recovery/interrupted-worker/turn_worker/retry':
        {
          body: {
            outcome: 'released_for_retry',
            turnId: 'turn_worker',
          },
        },
      'POST /api/app/workspaces/ws_demo/scheduler/admissions/queue_denied/retry': {
        body: { retried: true },
      },
      'POST /api/app/workspaces/ws_demo/scheduler/admissions/queue_queued/cancel': {
        body: { cancelled: true },
      },
      'GET /api/app/workspaces/ws_demo/scheduler/admissions': {
        body: {
          items: [
            {
              queueEntryId: 'queue_1',
              requestId: null,
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              turnId: 'turn_scheduler',
              requestedAgentId: 'agent_codex_host',
              profileRef: 'agent_codex_host',
              priorityClass: 'interactive',
              enqueuedAt: timestamp,
              effectivePriorityAt: timestamp,
              firstCapDeferredAt: null,
              requiredPoolConstraints: ['openshell.local'],
              status: 'queued',
              denialReason: null,
              queuePosition: 1,
            },
          ],
        },
      },
      'GET /api/app/workspaces/ws_demo/capability-usage': {
        body: capabilityUsageResponse(),
      },
      'GET /api/app/workspaces/ws_demo/evidence-bundles': {
        body: workspaceEvidenceBundlesResponse(),
      },
      'GET /api/app/workspaces/ws_demo/runtime-evidence': {
        body: workspaceRuntimeEvidenceResponse(),
      },
      'GET /api/app/workspaces/ws_demo/audit/events': {
        body: workspaceAuditEventsResponse(),
      },
      'GET /api/app/audit/events': {
        body: serverAuditEventsResponse(),
      },
      'GET /api/app/workspaces/ws_demo/permission-decisions': {
        body: workspacePermissionDecisionsResponse(),
      },
      'GET /api/app/permission-decisions': {
        body: serverPermissionDecisionsResponse(),
      },
      'GET /api/app/vault/use-records': {
        body: serverVaultUseRecordsResponse(),
      },
    });

    await expect(client.app.getDiagnostics()).resolves.toEqual(appDiagnostics());
    await expect(client.app.getStorageLayoutReport()).resolves.toEqual(storageLayoutReport());
    await expect(client.app.createDataRootBackup()).resolves.toEqual(dataRootBackupResponse());
    await expect(
      client.app.consumeBootstrapToken({
        displayName: 'Owner',
        ownerUserId: 'user_owner',
        token: 'okt_bootstrap_secret',
        tokenExpiresAt: timestamp,
      })
    ).resolves.toMatchObject({
      token: 'okt_owner_secret',
      record: { ownerUserId: 'user_owner', scope: 'server-admin' },
    });
    await expect(client.app.verifyDataRootBackup('drb_demo')).resolves.toEqual(
      dataRootBackupResponse()
    );
    await expect(client.app.exportWorkspace('ws_demo')).resolves.toEqual(workspaceExportResponse());
    await expect(
      client.app.dryRunWorkspaceImport({ sourceWorkspaceId: 'ws_demo', exportId: 'wsexp_demo' })
    ).resolves.toEqual(workspaceImportDryRunResponse());
    await expect(
      client.app.importWorkspace({
        sourceWorkspaceId: 'ws_demo',
        exportId: 'wsexp_demo',
        requestId: 'req_import',
      })
    ).resolves.toEqual(workspaceImportResponse());
    await expect(
      client.app.rebindWorkspaceVaultReference('ws_demo', 'vault_imported', {
        materialBase64: Buffer.from('workspace-secret').toString('base64'),
      })
    ).resolves.toMatchObject({
      referenceId: 'vault_imported',
      status: 'active',
    });
    await expect(client.app.listWorkspaceVaultReferences('ws_demo')).resolves.toMatchObject({
      items: [{ referenceId: 'vault_imported', status: 'unbound' }],
      workspaceId: 'ws_demo',
    });
    await expect(client.app.listWorkspaceVaultGrants('ws_demo')).resolves.toEqual(
      workspaceVaultGrantsResponse()
    );
    await expect(client.app.listWorkspaceVaultInjectionPlans('ws_demo')).resolves.toEqual(
      workspaceInjectionPlansResponse()
    );
    await expect(client.app.listWorkspaceVaultInjectionReceipts('ws_demo')).resolves.toEqual(
      workspaceInjectionReceiptsResponse()
    );
    await expect(client.app.listWorkspaceVaultUseRecords('ws_demo')).resolves.toEqual(
      workspaceVaultUseRecordsResponse()
    );
    await expect(client.app.listServerVaultUseRecords()).resolves.toEqual(
      serverVaultUseRecordsResponse()
    );
    await expect(client.app.getCapabilityUsage('ws_demo')).resolves.toEqual(
      capabilityUsageResponse()
    );
    await expect(client.app.listWorkspaceEvidenceBundles('ws_demo')).resolves.toEqual(
      workspaceEvidenceBundlesResponse()
    );
    await expect(client.app.listWorkspaceRuntimeEvidence('ws_demo')).resolves.toEqual(
      workspaceRuntimeEvidenceResponse()
    );
    await expect(client.app.listWorkspaceAuditEvents('ws_demo')).resolves.toEqual(
      workspaceAuditEventsResponse()
    );
    await expect(client.app.listServerAuditEvents()).resolves.toEqual(serverAuditEventsResponse());
    await expect(client.app.listWorkspacePermissionDecisions('ws_demo')).resolves.toEqual(
      workspacePermissionDecisionsResponse()
    );
    await expect(client.app.listServerPermissionDecisions()).resolves.toEqual(
      serverPermissionDecisionsResponse()
    );
    await expect(client.app.quickChat({ input: 'Hi' })).resolves.toMatchObject({
      content: 'Answer',
      status: 'completed',
    });
    await expect(
      client.app.startTaskMode('ws_demo', 'th_demo', { input: 'Implement the focused fix.' })
    ).resolves.toMatchObject({
      state: 'running',
    });
    await expect(
      client.app.startChatMode('ws_demo', 'th_demo', { input: 'What is OpenKit?' })
    ).resolves.toMatchObject({
      outcome: 'answered',
      item: { type: 'assistant-message', text: 'Answer' },
    });
    await expect(
      client.app.answerKnowledgeManager('ws_demo', { query: 'release cadence' })
    ).resolves.toMatchObject({
      outcome: 'answered',
      retrievalTraceId,
      citations: [{ knowledgeEntryId: 'mem_demo' }],
    });
    await expect(
      client.app.registerKnowledgeSource('ws_demo', {
        requestId: 'req_source',
        kind: 'document',
        title: 'Release notes',
        uri: 'file://release.md',
        content: 'Release cadence is weekly.',
        originatingThreadId: 'th_demo',
      })
    ).resolves.toMatchObject({
      source: { id: 'ks_demo', title: 'Release notes' },
      derivedRepresentations: [{ sourceId: 'ks_demo', kind: 'text' }],
    });
    await expect(client.app.listKnowledgeSources('ws_demo')).resolves.toMatchObject({
      items: [{ id: 'ks_demo', title: 'Release notes' }],
    });
    await expect(client.app.readKnowledgeSource('ws_demo', 'ks_demo')).resolves.toMatchObject({
      source: { id: 'ks_demo', title: 'Release notes' },
      derivedRepresentations: [{ sourceId: 'ks_demo', kind: 'text' }],
    });
    await expect(client.app.readKnowledgeIndexes('ws_demo')).resolves.toMatchObject({
      linkGraph: { edges: [{ fromId: 'alpha', resolved: true }] },
      validation: { records: [{ conceptId: 'alpha', indexed: true }] },
      sourceReferences: { references: [{ reference: 'source:ks_demo', resolved: true }] },
      fullText: { tokenizer: 'unicode-simple-v1', terms: [{ term: 'alpha' }] },
    });
    await expect(
      client.app.recordKnowledgeObservation('ws_demo', {
        requestId: 'req_observation',
        kind: 'retrieval',
        summary: 'Worker repeatedly needed release cadence context.',
        sourceReferences: ['knowledge:kn_demo', 'source:ks_demo'],
        producer: 'knowledge-manager',
        confidence: 0.75,
      })
    ).resolves.toMatchObject({
      observation: { id: 'ko_demo', kind: 'retrieval', status: 'retained' },
    });
    await expect(client.app.listKnowledgeObservations('ws_demo')).resolves.toMatchObject({
      items: [{ id: 'ko_demo', kind: 'retrieval' }],
    });
    await expect(
      client.app.recordKnowledgeClaim('ws_demo', {
        requestId: 'req_claim',
        statement: 'Release cadence is weekly.',
        sourceReferences: ['knowledge:release-plan', 'source:ks_release'],
        producer: 'knowledge-manager',
        confidence: 0.8,
      })
    ).resolves.toMatchObject({
      claim: { id: 'kc_demo', statement: 'Release cadence is weekly.' },
    });
    await expect(client.app.listKnowledgeClaims('ws_demo')).resolves.toMatchObject({
      items: [{ id: 'kc_demo', statement: 'Release cadence is weekly.' }],
    });
    await expect(
      client.app.recordKnowledgeConflict('ws_demo', {
        requestId: 'req_conflict',
        subjectReferences: ['knowledge:release-plan', 'claim:kc_release'],
        sourceReferences: ['source:ks_release', 'source:ks_correction'],
        summary: 'Release cadence has contradictory source evidence.',
        producer: 'knowledge-manager',
      })
    ).resolves.toMatchObject({
      conflict: { id: 'kf_demo', status: 'conflicting' },
    });
    await expect(client.app.listKnowledgeConflicts('ws_demo')).resolves.toMatchObject({
      items: [{ id: 'kf_demo', status: 'conflicting' }],
    });
    await expect(
      client.app.resolveKnowledgeConflict('ws_demo', 'kf_demo', {
        requestId: 'req_resolve_conflict',
        resolution: 'Friday release reviews are authoritative.',
        resolvedBy: 'knowledge-manager',
      })
    ).resolves.toMatchObject({
      conflict: { id: 'kf_demo', status: 'resolved' },
    });
    await expect(
      client.app.retrieveKnowledge('ws_demo', { query: 'release cadence', limit: 1 })
    ).resolves.toEqual({
      traceId: retrievalTraceId,
      workspaceId: 'ws_demo',
      caller: 'app-api',
      requestDigest: retrievalRequestDigest,
      retrievalParameters: {
        limit: 1,
        pinnedConceptIds: [],
      },
      createdAt: timestamp,
      selected: [
        {
          knowledgePageId: 'release-plan',
          contentDigest: retrievedPageDigest,
          score: 4,
          sourceReferences: ['source:ks_demo'],
        },
      ],
      excluded: [
        {
          knowledgePageId: 'old-plan',
          contentDigest: null,
          reason: 'sensitive_content',
        },
      ],
    });
    await expect(
      client.app.prepareKnowledgeContext('ws_demo', {
        query: 'release cadence',
        limit: 1,
      })
    ).resolves.toEqual({
      operationId: 'km_context_demo',
      operation: 'prepare-context-material',
      workspaceId: 'ws_demo',
      caller: 'app-api',
      retrievalTraceId,
      outcome: 'prepared',
      selected: [
        {
          knowledgePageId: 'release-plan',
          contentDigest: retrievedPageDigest,
          score: 4,
          sourceReferences: ['source:ks_demo'],
        },
      ],
      excluded: [
        {
          knowledgePageId: 'old-plan',
          contentDigest: null,
          reason: 'sensitive_content',
        },
      ],
    });
    expect(client.app).not.toHaveProperty('readKnowledgeContextPackageTrace');
    expect(client.app).not.toHaveProperty('materializeKnowledgeContextPackage');
    expect(client.app).not.toHaveProperty('readKnowledgeContextPackageMaterialization');
    const requestedMethodPaths = requests.map(({ method, path }) => `${method} ${path}`);
    for (const removedMethodPath of [
      'GET /api/app/workspaces/ws_demo/knowledge/manager/context/ctxpkg_km_context_demo',
      'POST /api/app/workspaces/ws_demo/knowledge/manager/context/ctxpkg_km_context_demo/materialization',
      'GET /api/app/workspaces/ws_demo/knowledge/manager/context/ctxpkg_km_context_demo/materialization',
    ]) {
      expect(requestedMethodPaths).not.toContain(removedMethodPath);
    }
    await expect(
      client.app.draftKnowledgeProposal('ws_demo', {
        requestId: '00000000-0000-4000-8000-000000000621',
        knowledgePageId: 'lessons/release-review',
        canonicalPageBytes: proposalPageBytes,
        contentDigest: proposalPageDigest,
        sourceReferences: [proposalSourceReference],
        rationale: 'This evidence supports one reusable release-review rule.',
        confidence: 0.75,
      })
    ).resolves.toMatchObject({
      operation: 'draft-proposal',
      proposal: {
        id: 'kp_demo',
        knowledgePageId: 'lessons/release-review',
        contentDigest: proposalPageDigest,
        status: 'pending',
      },
    });
    await expect(client.app.suggestKnowledgeRepairs('ws_demo', {})).resolves.toMatchObject({
      operation: 'suggest-repair',
      suggestions: [{ kind: 'duplicate-title' }],
    });
    await expect(client.app.checkKnowledgeHealth('ws_demo', {})).resolves.toMatchObject({
      operation: 'health-check',
      outcome: 'needs-attention',
      repairSuggestions: [{ kind: 'duplicate-title' }],
    });
    for (const path of [
      '/api/app/workspaces/ws_demo/knowledge/manager/answer',
      '/api/app/workspaces/ws_demo/knowledge/manager/context',
      '/api/app/workspaces/ws_demo/knowledge/manager/proposals',
      '/api/app/workspaces/ws_demo/knowledge/manager/repairs',
      '/api/app/workspaces/ws_demo/knowledge/manager/health',
      '/api/app/workspaces/ws_demo/knowledge/sources',
    ]) {
      expect(requests.find((request) => request.path === path)?.body).not.toHaveProperty('caller');
    }
    await expect(client.app.search('protocol design')).resolves.toEqual({
      items: [{ kind: 'workspace', id: 'ws_demo', title: 'Demo' }],
    });
    await expect(client.agents.refreshHealth('ws_demo')).resolves.not.toHaveProperty('sessions');
    await expect(client.agents.list()).resolves.toEqual({ items: [agent()] });
    await expect(client.agents.get('agent_demo')).resolves.toEqual(agent());
    await expect(client.actionCenter.listHumanAttention('ws_demo')).resolves.toEqual({
      items: [],
    });
    await expect(client.app.listInterruptedWorkers()).resolves.toEqual({
      items: [interruptedWorkerState()],
    });
    expect(client.app).not.toHaveProperty('listRecoveryPendingUserTurns');
    expect(client.app).not.toHaveProperty('cancelRecoveryPendingUserTurn');
    expect(client.app).not.toHaveProperty('convertRecoveryPendingUserTurnToFollowUp');
    expect(client.app).not.toHaveProperty('editRecoveryPendingUserTurn');
    expect(client.app).not.toHaveProperty('promoteRecoveryPendingUserTurnToInterrupt');
    await expect(
      client.app.retryInterruptedWorkerCheckpoint('ws_demo', 'th_demo', 'turn_worker', {
        requestId: 'req_worker_retry',
      })
    ).resolves.toEqual({
      outcome: 'released_for_retry',
      turnId: 'turn_worker',
    });
    expect(
      requests.find(
        (request) =>
          request.path ===
          '/api/app/workspaces/ws_demo/threads/th_demo/recovery/interrupted-worker/turn_worker/retry'
      )?.body
    ).toEqual({ requestId: 'req_worker_retry' });
    await expect(client.app.retrySchedulerAdmission('ws_demo', 'queue_denied')).resolves.toEqual({
      retried: true,
    });
    await expect(client.app.cancelSchedulerAdmission('ws_demo', 'queue_queued')).resolves.toEqual({
      cancelled: true,
    });
    await expect(client.app.listSchedulerAdmissions('ws_demo')).resolves.toMatchObject({
      items: [{ queueEntryId: 'queue_1', queuePosition: 1 }],
    });

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /api/app/diagnostics',
      'GET /api/app/storage/layout-report',
      'POST /api/app/data-root/backups',
      'POST /api/app/auth/bootstrap/consume',
      'POST /api/app/data-root/backups/drb_demo/verify',
      'POST /api/app/workspaces/ws_demo/export',
      'POST /api/app/workspace-imports/dry-run',
      'POST /api/app/workspace-imports',
      'POST /api/app/workspaces/ws_demo/vault/references/vault_imported/rebind',
      'GET /api/app/workspaces/ws_demo/vault/references',
      'GET /api/app/workspaces/ws_demo/vault/grants',
      'GET /api/app/workspaces/ws_demo/vault/injection-plans',
      'GET /api/app/workspaces/ws_demo/vault/injection-receipts',
      'GET /api/app/workspaces/ws_demo/vault/use-records',
      'GET /api/app/vault/use-records',
      'GET /api/app/workspaces/ws_demo/capability-usage',
      'GET /api/app/workspaces/ws_demo/evidence-bundles',
      'GET /api/app/workspaces/ws_demo/runtime-evidence',
      'GET /api/app/workspaces/ws_demo/audit/events',
      'GET /api/app/audit/events',
      'GET /api/app/workspaces/ws_demo/permission-decisions',
      'GET /api/app/permission-decisions',
      'POST /api/app/quick-chat',
      'POST /api/app/workspaces/ws_demo/threads/th_demo/task',
      'POST /api/app/workspaces/ws_demo/threads/th_demo/chat',
      'POST /api/app/workspaces/ws_demo/knowledge/manager/answer',
      'POST /api/app/workspaces/ws_demo/knowledge/sources',
      'GET /api/app/workspaces/ws_demo/knowledge/sources',
      'GET /api/app/workspaces/ws_demo/knowledge/sources/ks_demo',
      'GET /api/app/workspaces/ws_demo/knowledge/indexes',
      'POST /api/app/workspaces/ws_demo/knowledge/observations',
      'GET /api/app/workspaces/ws_demo/knowledge/observations',
      'POST /api/app/workspaces/ws_demo/knowledge/claims',
      'GET /api/app/workspaces/ws_demo/knowledge/claims',
      'POST /api/app/workspaces/ws_demo/knowledge/conflicts',
      'GET /api/app/workspaces/ws_demo/knowledge/conflicts',
      'POST /api/app/workspaces/ws_demo/knowledge/conflicts/kf_demo/resolution',
      'POST /api/app/workspaces/ws_demo/knowledge/retrievals',
      'POST /api/app/workspaces/ws_demo/knowledge/manager/context',
      'POST /api/app/workspaces/ws_demo/knowledge/manager/proposals',
      'POST /api/app/workspaces/ws_demo/knowledge/manager/repairs',
      'POST /api/app/workspaces/ws_demo/knowledge/manager/health',
      'GET /api/app/search?q=protocol%20design',
      'POST /api/app/workspaces/ws_demo/agents/health/refresh',
      'GET /api/app/agents',
      'GET /api/app/agents/agent_demo',
      'GET /api/app/workspaces/ws_demo/action-center',
      'GET /api/app/recovery/interrupted-workers',
      'POST /api/app/workspaces/ws_demo/threads/th_demo/recovery/interrupted-worker/turn_worker/retry',
      'POST /api/app/workspaces/ws_demo/scheduler/admissions/queue_denied/retry',
      'POST /api/app/workspaces/ws_demo/scheduler/admissions/queue_queued/cancel',
      'GET /api/app/workspaces/ws_demo/scheduler/admissions',
    ]);
    expect(requests[3]?.body).toEqual({
      displayName: 'Owner',
      ownerUserId: 'user_owner',
      token: 'okt_bootstrap_secret',
      tokenExpiresAt: timestamp,
    });
    expect(requests[8]?.body).toEqual({
      materialBase64: Buffer.from('workspace-secret').toString('base64'),
    });
    expect(requests.at(-6)?.body).toBeNull();
    expect(requests.at(-5)?.body).toBeNull();
    expect(requests.at(-4)?.body).toEqual({ requestId: 'req_worker_retry' });
    expect(requests.at(-3)?.body).toEqual({});
    expect(requests.at(-2)?.body).toEqual({});
    expect(requests.at(-1)?.body).toBeNull();
  });

  it('routes OpenKit access-token administration through app-owned schemas', async () => {
    const { client, requests } = createFakeClient({
      'GET /api/app/auth/tokens': { body: { items: [accessTokenRecord()] } },
      'POST /api/app/auth/tokens': {
        body: { token: 'okt_workspace_secret', record: accessTokenRecord() },
        status: 201,
      },
      'POST /api/app/auth/tokens/tok_workspace/revoke': {
        body: { record: accessTokenRecord({ status: 'revoked', revokedAt: timestamp }) },
      },
      'POST /api/app/auth/tokens/tok_workspace/rotate': {
        body: {
          token: 'okt_rotated_secret',
          record: accessTokenRecord({ status: 'rotated', rotatedGraceExpiresAt: timestamp }),
          rotatedRecord: accessTokenRecord({
            predecessorTokenId: 'tok_workspace',
            tokenId: 'tok_rotated',
          }),
        },
      },
    });

    await expect(client.app.listOpenKitAccessTokens()).resolves.toMatchObject({
      items: [{ tokenId: 'tok_workspace', workspaceIds: ['ws_demo'] }],
    });
    await expect(
      client.app.createOpenKitAccessToken({
        expiresAt: timestamp,
        scope: 'workspace',
        workspaceIds: ['ws_demo'],
      })
    ).resolves.toMatchObject({
      token: 'okt_workspace_secret',
      record: { tokenId: 'tok_workspace' },
    });
    await expect(client.app.revokeOpenKitAccessToken('tok_workspace')).resolves.toMatchObject({
      record: { status: 'revoked' },
    });
    await expect(
      client.app.rotateOpenKitAccessToken('tok_workspace', { graceSeconds: 60 })
    ).resolves.toMatchObject({
      token: 'okt_rotated_secret',
      rotatedRecord: { predecessorTokenId: 'tok_workspace' },
    });

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /api/app/auth/tokens',
      'POST /api/app/auth/tokens',
      'POST /api/app/auth/tokens/tok_workspace/revoke',
      'POST /api/app/auth/tokens/tok_workspace/rotate',
    ]);
    expect(requests[1]?.body).toEqual({
      expiresAt: timestamp,
      scope: 'workspace',
      workspaceIds: ['ws_demo'],
    });
    expect(requests[3]?.body).toEqual({ graceSeconds: 60 });
  });

  it('routes vault admin operations through app-owned schemas', async () => {
    const authJsonBase64 = Buffer.from('{"tokens":{"openai":"secret"}}').toString('base64');
    const masterKeyBase64 = Buffer.alloc(32, 1).toString('base64');
    const { client, requests } = createFakeClient({
      'GET /api/app/vault/status': { body: vaultAdminStatus('locked') },
      'POST /api/app/vault/unlock': { body: vaultAdminStatus('available') },
      'POST /api/app/vault/lock': { body: vaultAdminStatus('locked') },
      'POST /api/app/vault/bootstrap/codex-auth-json': {
        body: {
          backendKind: 'encrypted-file',
          expiresAt: null,
          grantId: 'grant_codex_auth_json',
          grantScope: 'agent-session',
          referenceId: 'vault_codex_auth_json',
          secretKind: 'codex-auth-json',
          targetPath: '/sandbox/.codex/auth.json',
        },
      },
    });

    await expect(client.app.getVaultAdminStatus()).resolves.toMatchObject({
      backendKind: 'encrypted-file',
      state: 'locked',
    });
    await expect(client.app.unlockVaultAdminBackend({ masterKeyBase64 })).resolves.toMatchObject({
      state: 'available',
    });
    await expect(client.app.lockVaultAdminBackend()).resolves.toMatchObject({
      state: 'locked',
    });
    await expect(
      client.app.bootstrapCodexAuthJsonVaultReference({ authJsonBase64 })
    ).resolves.toMatchObject({
      grantId: 'grant_codex_auth_json',
      referenceId: 'vault_codex_auth_json',
    });

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /api/app/vault/status',
      'POST /api/app/vault/unlock',
      'POST /api/app/vault/lock',
      'POST /api/app/vault/bootstrap/codex-auth-json',
    ]);
    expect(requests[1]?.body).toEqual({ masterKeyBase64 });
    expect(requests[3]?.body).toEqual({ authJsonBase64 });
  });

  it('rejects an obsolete os-keychain vault response as a protocol violation', async () => {
    const { client } = createFakeClient({
      'GET /api/app/vault/status': {
        body: { ...vaultAdminStatus('available'), backendKind: 'os-keychain' },
      },
    });

    await expect(client.app.getVaultAdminStatus()).rejects.toBeInstanceOf(ProtocolValidationError);
  });

  it('routes workspace repository resource calls through repository sub-client', async () => {
    const { client, requests } = createFakeClient({
      'GET /api/app/workspaces/ws_demo/repositories': {
        body: {
          items: [repositoryResource()],
          defaultResourceId: 'default',
          defaultResource: repositoryResource(),
        },
      },
      'GET /api/app/workspaces/ws_demo/repositories/diagnostics': {
        body: {
          workspaceId: 'ws_demo',
          defaultResourceId: 'default',
          defaultResource: repositoryDiagnostic(),
          resources: [repositoryDiagnostic()],
        },
      },
      'GET /api/app/workspaces/ws_demo/repositories/git-push-records': {
        body: { items: [gitPushRecord()] },
      },
      'GET /api/app/workspaces/ws_demo/repositories/git-push-records/gpr_1': {
        body: gitPushRecord(),
      },
      'POST /api/app/workspaces/ws_demo/repositories/repo_default/git-push/approval': {
        body: {
          approval: {
            id: 'ap_git_push_1',
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: 'tu_demo',
            kind: 'permission',
            status: 'pending',
            title: 'Approve Git push to main',
            description: 'Publish abc123 from HEAD to main on GitHub repository openkit on origin.',
            createdAt: timestamp,
            resolvedAt: null,
          },
          approvalItemId: 'it_git_push_approval_1',
          policyDecisionId: 'pd_git_push_approval_1',
        },
      },
      'POST /api/app/workspaces/ws_demo/repositories/repo_default/git-push': {
        body: gitPushRecord(),
      },
      'PUT /api/app/workspaces/ws_demo/repositories/default': {
        body: { repository: repositoryResource() },
      },
    });

    await expect(client.repositories.list('ws_demo')).resolves.toMatchObject({
      defaultResourceId: 'default',
    });
    await expect(client.repositories.diagnostics('ws_demo')).resolves.toMatchObject({
      workspaceId: 'ws_demo',
    });
    await expect(client.repositories.listGitPushRecords('ws_demo')).resolves.toMatchObject({
      items: [{ id: 'gpr_1' }],
    });
    await expect(client.repositories.getGitPushRecord('ws_demo', 'gpr_1')).resolves.toMatchObject({
      id: 'gpr_1',
    });
    await expect(
      client.repositories.requestGitPushApproval('ws_demo', 'repo_default', {
        requestId: '00000000-0000-4000-8000-000000000024',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        sourceRef: 'HEAD',
        targetBranch: 'main',
        commitIds: ['abc123'],
      })
    ).resolves.toMatchObject({ approval: { id: 'ap_git_push_1' } });
    await expect(
      client.repositories.executeGitPush('ws_demo', 'repo_default', {
        requestId: '00000000-0000-4000-8000-000000000026',
        approvalRequestId: 'ap_git_push_1',
      })
    ).resolves.toMatchObject({ id: 'gpr_1', outcome: 'pushed' });
    await expect(
      client.repositories.setDefault('ws_demo', {
        displayName: 'OpenKit',
        localPath: '/Users/m5pro/Documents/AI/openkit',
      })
    ).resolves.toMatchObject({ repository: { resourceId: 'default' } });

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /api/app/workspaces/ws_demo/repositories',
      'GET /api/app/workspaces/ws_demo/repositories/diagnostics',
      'GET /api/app/workspaces/ws_demo/repositories/git-push-records',
      'GET /api/app/workspaces/ws_demo/repositories/git-push-records/gpr_1',
      'POST /api/app/workspaces/ws_demo/repositories/repo_default/git-push/approval',
      'POST /api/app/workspaces/ws_demo/repositories/repo_default/git-push',
      'PUT /api/app/workspaces/ws_demo/repositories/default',
    ]);
    expect(requests[4]?.body).toEqual({
      commitIds: ['abc123'],
      requestId: '00000000-0000-4000-8000-000000000024',
      sourceRef: 'HEAD',
      targetBranch: 'main',
      threadId: 'th_demo',
      turnId: 'tu_demo',
    });
    expect(requests[5]?.body).toEqual({
      approvalRequestId: 'ap_git_push_1',
      requestId: '00000000-0000-4000-8000-000000000026',
    });
    expect(requests[6]?.body).toEqual({
      displayName: 'OpenKit',
      localPath: '/Users/m5pro/Documents/AI/openkit',
    });
  });

  it('routes remaining App API and feedback methods through sub-clients', async () => {
    const goalPlan = goalPlanPayload();
    const proposalPageDigest = `sha256:${'e'.repeat(64)}`;
    const proposalDigest = `sha256:${'f'.repeat(64)}`;
    const { client, requests } = createFakeClient({
      'GET /api/app/workspaces/ws_demo/dashboard': { body: workspaceDashboard() },
      'GET /api/app/workspaces/ws_demo/threads/th_demo/dashboard': { body: threadDashboard() },
      'GET /api/app/workspaces/ws_demo/threads/th_demo/goal': { body: threadGoalSummary() },
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal': {
        body: { ...threadGoalSummary(), objectiveItemId: 'it_goal_objective' },
      },
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/plan': {
        body: {
          status: 'awaiting_plan_approval',
          goal: { ...threadGoalSummary().goal, status: 'awaiting_plan_approval' },
          planItemId: 'it_goal_plan_goal_demo',
          planner: {
            mode: 'goal',
            sourceAgentId: 'worker-coordinator',
            confidence: 0.84,
            rationale: 'Workflow Coordinator drafted a reviewable Goal Mode plan.',
            contextRefs: [
              { kind: 'workspace', id: 'ws_demo' },
              { kind: 'thread', id: 'th_demo' },
            ],
            requiredApprovals: ['plan_approval'],
            plan: goalPlan,
          },
          plan: goalPlan,
        },
      },
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/plan/approve': {
        body: {
          goal: threadGoalSummary().goal,
          readyTasks: [{ taskId: 'task_1', status: 'ready' }],
          startsWorkerTurn: false,
        },
      },
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/plan/revise': {
        body: {
          goal: { ...threadGoalSummary().goal, status: 'planning' },
          revisionItemId: 'it_goal_plan_revision_goal_demo',
          startsWorkerTurn: false,
        },
      },
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/pause': {
        body: {
          outcome: 'paused',
          goal: { ...threadGoalSummary().goal, status: 'paused' },
        },
      },
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/resume': {
        body: {
          outcome: 'resumed',
          goal: threadGoalSummary().goal,
        },
      },
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/step': {
        body: {
          goal: {
            ...threadGoalSummary().goal,
            status: 'reviewing',
            currentTask: {
              taskId: 'task_1',
              title: 'Ship release',
              status: 'reviewing',
              orderIndex: 0,
            },
            pendingHumanAttention: {
              required: true,
              reason: 'Worker result needs review.',
            },
          },
        },
      },
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/steering': {
        body: {
          state: 'queued',
          pendingTurnId: 'pending_goal_steering',
          requestId: 'req_goal_steering',
          contentItemId: 'it_goal_steering',
          goalId: 'goal_demo',
          activeTurnId: 'turn_worker',
        },
      },
      'POST /api/app/workspaces/ws_demo/knowledge/proposals/kp_demo/decision': {
        body: {
          review: {
            reviewId: 'kr_demo',
            proposalId: 'kp_demo',
            workspaceId: 'ws_demo',
            decision: 'accepted',
            actor: { kind: 'user', id: 'user_demo' },
            proposalDigest,
            decidedAt: timestamp,
            requestId: '00000000-0000-4000-8000-000000000622',
            knowledgePageId: 'lessons/release-review',
            contentDigest: proposalPageDigest,
            targetAbsentAtDecision: true,
          },
          application: {
            knowledgePageId: 'lessons/release-review',
            contentDigest: proposalPageDigest,
            present: true,
          },
        },
      },
      'POST /api/app/workspaces/ws_demo/knowledge/proposals/kp_demo/reversal': {
        body: {
          proposalId: 'kp_demo',
          reviewId: 'kr_demo',
          application: {
            knowledgePageId: 'lessons/release-review',
            contentDigest: proposalPageDigest,
            present: false,
          },
        },
      },
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goals/goal_demo/reviews/review_demo/decision':
        {
          body: {
            review: {
              reviewId: 'review_demo',
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              goalId: 'goal_demo',
              taskId: 'task_demo',
              turnId: 'turn_demo',
              itemIds: ['item_demo'],
              artifactIds: ['artifact_demo'],
              verificationEvidence: [],
              prompt: 'Review the worker evidence against the accepted Task.',
              createdByRequestId: 'goal-step-request-1',
              verdict: 'retry',
              reason: 'Retry with stronger verification.',
              revisionInstruction: null,
              createdAt: timestamp,
              updatedAt: timestamp,
              resolvedAt: timestamp,
              resolutionRequestId: 'goal-review-request-1',
              resolvedByActorId: 'user_demo',
            },
            advance: {
              outcome: 'retry',
              task: { taskId: 'task_demo', status: 'ready' },
              goal: {
                goalId: 'goal_demo',
                status: 'running',
                currentTaskId: null,
                terminalStopReason: null,
              },
              nextReadyTaskId: 'task_demo',
            },
          },
        },
      'GET /api/setup/diagnostics': { body: setupDiagnostics() },
      'GET /api/app/automations': { body: { items: [automation()] } },
      'POST /api/app/automations': { body: automation() },
      'PATCH /api/app/automations/auto_demo': { body: { ...automation(), status: 'enabled' } },
      'POST /api/turns/turn_demo/feedback': {
        body: {
          turnId: 'turn_demo',
          agentId: 'agent_demo',
          rating: 'good',
          note: null,
          createdAt: timestamp,
        },
      },
    });

    await expect(client.app.getWorkspaceDashboard('ws_demo')).resolves.toEqual(
      workspaceDashboard()
    );
    await expect(client.app.getThreadDashboard('ws_demo', 'th_demo')).resolves.not.toHaveProperty(
      'activeSession'
    );
    await expect(client.app.getThreadGoalSummary('ws_demo', 'th_demo')).resolves.toEqual(
      threadGoalSummary()
    );
    await expect(
      client.app.startThreadGoal('ws_demo', 'th_demo', {
        objective: 'Make v0.0.6 ready to publish.',
        title: 'Ship v0.0.6',
      })
    ).resolves.toEqual({ ...threadGoalSummary(), objectiveItemId: 'it_goal_objective' });
    await expect(
      client.app.createThreadGoalPlan('ws_demo', 'th_demo', {
        requestId: 'req_goal_plan_create',
      })
    ).resolves.toMatchObject({
      status: 'awaiting_plan_approval',
      planItemId: 'it_goal_plan_goal_demo',
      planner: { plan: { tasks: [{ taskId: 'task_1' }] } },
      plan: { tasks: [{ taskId: 'task_1' }] },
    });
    await expect(
      client.app.approveThreadGoalPlan('ws_demo', 'th_demo', {
        requestId: 'req_goal_plan_approve',
        planItemId: 'it_goal_plan_goal_demo',
      })
    ).resolves.toEqual({
      goal: threadGoalSummary().goal,
      readyTasks: [{ taskId: 'task_1', status: 'ready' }],
      startsWorkerTurn: false,
    });
    await expect(
      client.app.reviseThreadGoalPlan('ws_demo', 'th_demo', {
        requestId: 'req_goal_plan_revise',
        revision: 'Split the plan into safer review gates.',
      })
    ).resolves.toEqual({
      goal: { ...threadGoalSummary().goal, status: 'planning' },
      revisionItemId: 'it_goal_plan_revision_goal_demo',
      startsWorkerTurn: false,
    });
    await expect(
      client.app.pauseThreadGoal('ws_demo', 'th_demo', { requestId: 'req_goal_pause' })
    ).resolves.toEqual({
      outcome: 'paused',
      goal: { ...threadGoalSummary().goal, status: 'paused' },
    });
    await expect(client.app.resumeThreadGoal('ws_demo', 'th_demo')).resolves.toEqual({
      outcome: 'resumed',
      goal: threadGoalSummary().goal,
    });
    await expect(
      client.app.runThreadGoalStep('ws_demo', 'th_demo', {
        requestId: 'req_goal_step_1',
      })
    ).resolves.toMatchObject({
      goal: {
        goalId: 'goal_demo',
        status: 'reviewing',
        currentTask: {
          taskId: 'task_1',
          status: 'reviewing',
        },
      },
    });
    expect('runThreadGoalTestSuperviseStep' in client.app).toBe(false);
    await expect(
      client.app.submitThreadGoalSteering('ws_demo', 'th_demo', {
        message: 'Focus on release notes.',
      })
    ).resolves.toMatchObject({
      state: 'queued',
      pendingTurnId: 'pending_goal_steering',
      requestId: 'req_goal_steering',
      contentItemId: 'it_goal_steering',
      goalId: 'goal_demo',
      activeTurnId: 'turn_worker',
    });
    await expect(
      client.app.submitGoalReviewDecision('ws_demo', 'th_demo', 'goal_demo', 'review_demo', {
        verdict: 'retry',
        reason: 'Retry with stronger verification.',
      })
    ).resolves.toMatchObject({
      review: {
        reviewId: 'review_demo',
        verdict: 'retry',
        resolvedAt: timestamp,
      },
      advance: {
        outcome: 'retry',
        task: { taskId: 'task_demo', status: 'ready' },
        goal: {
          goalId: 'goal_demo',
          status: 'running',
          currentTaskId: null,
          terminalStopReason: null,
        },
        nextReadyTaskId: 'task_demo',
      },
    });
    await expect(
      client.app.submitKnowledgeProposalDecision('ws_demo', 'kp_demo', {
        requestId: '00000000-0000-4000-8000-000000000622',
        decision: 'accepted',
      })
    ).resolves.toEqual({
      review: {
        reviewId: 'kr_demo',
        proposalId: 'kp_demo',
        workspaceId: 'ws_demo',
        decision: 'accepted',
        actor: { kind: 'user', id: 'user_demo' },
        proposalDigest,
        decidedAt: timestamp,
        requestId: '00000000-0000-4000-8000-000000000622',
        knowledgePageId: 'lessons/release-review',
        contentDigest: proposalPageDigest,
        targetAbsentAtDecision: true,
      },
      application: {
        knowledgePageId: 'lessons/release-review',
        contentDigest: proposalPageDigest,
        present: true,
      },
    });
    await expect(
      client.app.reverseKnowledgeProposal('ws_demo', 'kp_demo', {
        requestId: '00000000-0000-4000-8000-000000000623',
        reviewId: 'kr_demo',
        knowledgePageId: 'lessons/release-review',
        expectedContentDigest: proposalPageDigest,
      })
    ).resolves.toEqual({
      proposalId: 'kp_demo',
      reviewId: 'kr_demo',
      application: {
        knowledgePageId: 'lessons/release-review',
        contentDigest: proposalPageDigest,
        present: false,
      },
    });
    await expect(client.app.getSetupDiagnostics()).resolves.toEqual(setupDiagnostics());
    await expect(client.app.listAutomations()).resolves.toEqual({ items: [automation()] });
    await expect(
      client.app.createAutomation({
        name: 'Demo automation',
        workspaceId: 'ws_demo',
        cron: '0 9 * * *',
        prompt: 'Summarize status.',
      })
    ).resolves.toEqual(automation());
    await expect(client.app.updateAutomation('auto_demo', { status: 'enabled' })).resolves.toEqual({
      ...automation(),
      status: 'enabled',
    });
    await expect(
      client.app.submitTurnFeedback('turn_demo', { rating: 'good', note: null })
    ).resolves.toMatchObject({ turnId: 'turn_demo', rating: 'good' });

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /api/app/workspaces/ws_demo/dashboard',
      'GET /api/app/workspaces/ws_demo/threads/th_demo/dashboard',
      'GET /api/app/workspaces/ws_demo/threads/th_demo/goal',
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal',
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/plan',
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/plan/approve',
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/plan/revise',
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/pause',
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/resume',
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/step',
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goal/steering',
      'POST /api/app/workspaces/ws_demo/threads/th_demo/goals/goal_demo/reviews/review_demo/decision',
      'POST /api/app/workspaces/ws_demo/knowledge/proposals/kp_demo/decision',
      'POST /api/app/workspaces/ws_demo/knowledge/proposals/kp_demo/reversal',
      'GET /api/setup/diagnostics',
      'GET /api/app/automations',
      'POST /api/app/automations',
      'PATCH /api/app/automations/auto_demo',
      'POST /api/turns/turn_demo/feedback',
    ]);
    expect(requests.find((request) => request.path.endsWith('/goal/steering'))?.body).toMatchObject(
      {
        message: 'Focus on release notes.',
        requestId: expect.any(String),
      }
    );
    expect(
      requests.find((request) => request.path.endsWith('/goal/plan') && request.method === 'POST')
        ?.body
    ).toEqual({
      requestId: 'req_goal_plan_create',
    });
    expect(requests.find((request) => request.path.endsWith('/goal/plan/approve'))?.body).toEqual({
      requestId: 'req_goal_plan_approve',
      planItemId: 'it_goal_plan_goal_demo',
    });
    expect(requests.find((request) => request.path.endsWith('/goal/pause'))?.body).toEqual({
      requestId: 'req_goal_pause',
    });
    expect(requests.find((request) => request.path.endsWith('/goal/resume'))?.body).toEqual({
      requestId: expect.any(String),
    });
    expect(requests.find((request) => request.path.endsWith('/goal/step'))?.body).toEqual({
      requestId: 'req_goal_step_1',
    });
    expect(
      requests.find(
        (request) => request.path.endsWith('/threads/th_demo/goal') && request.method === 'POST'
      )?.body
    ).toMatchObject({
      objective: 'Make v0.0.6 ready to publish.',
      title: 'Ship v0.0.6',
      requestId: expect.any(String),
    });
    expect(
      requests.find((request) => request.path.endsWith('/reviews/review_demo/decision'))?.body
    ).toEqual({
      requestId: expect.any(String),
      verdict: 'retry',
      reason: 'Retry with stronger verification.',
    });
    expect(
      requests.find((request) => request.path.endsWith('/knowledge/proposals/kp_demo/decision'))
        ?.body
    ).toEqual({
      decision: 'accepted',
      requestId: '00000000-0000-4000-8000-000000000622',
    });
    expect(
      requests.find((request) => request.path.endsWith('/knowledge/proposals/kp_demo/reversal'))
        ?.body
    ).toEqual({
      requestId: '00000000-0000-4000-8000-000000000623',
      reviewId: 'kr_demo',
      knowledgePageId: 'lessons/release-review',
      expectedContentDigest: proposalPageDigest,
    });
  });

  it('routes and validates the exact provider-subscription client surface', async () => {
    const providers = {
      providers: [
        {
          subscriptionProviderId: 'openai-codex',
          displayName: 'OpenAI Codex',
          loginModes: ['device_code'],
          quotaCapability: 'available',
        },
        {
          subscriptionProviderId: 'xai',
          displayName: 'xAI',
          loginModes: ['device_code'],
          quotaCapability: 'unsupported',
        },
      ],
    };
    const loggedOutAccount = {
      subscriptionProviderId: 'openai-codex',
      accountSlotId: 'default',
      boundProviderIds: ['provider_primary'],
      createdAt: timestamp,
      updatedAt: timestamp,
      displayName: 'Default',
      status: 'logged_out',
    };
    const loggedInAccount = {
      subscriptionProviderId: 'xai',
      accountSlotId: 'team_slot',
      boundProviderIds: ['provider_xai'],
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'logged_in',
    };
    const pendingAccount = {
      ...loggedOutAccount,
      status: 'pending',
      interaction: {
        mode: 'device_code',
        interactionId: 'interaction_demo',
        verificationUrl: 'https://auth.openai.test/device',
        userCode: 'OPEN-KIT',
        expiresAt: timestamp,
      },
    };
    const quota = {
      subscriptionProviderId: 'xai',
      accountSlotId: 'team_slot',
      availability: 'unsupported',
      observedAt: timestamp,
    };
    const encodedStatusPath =
      '/api/app/provider-subscriptions/xai%2Fpreview/accounts/slot%20%EF%BF%BD%2Fa/status';
    const leadingBomDeletePath =
      '/api/app/provider-subscriptions/openai-codex/accounts/%EF%BB%BFdefault';
    const operations = [
      {
        args: [],
        body: null,
        method: 'listProviders',
        request: 'GET /api/app/provider-subscriptions',
        response: providers,
        route: { body: providers },
      },
      {
        args: ['xai'],
        body: null,
        method: 'listAccounts',
        request: 'GET /api/app/provider-subscriptions/xai/accounts',
        response: { accounts: [loggedInAccount] },
        route: { body: { accounts: [loggedInAccount] } },
      },
      {
        args: ['xai', { accountSlotId: 'team_slot', displayName: 'Team' }],
        body: { accountSlotId: 'team_slot', displayName: 'Team' },
        method: 'createAccount',
        request: 'POST /api/app/provider-subscriptions/xai/accounts',
        response: loggedInAccount,
        route: { body: loggedInAccount },
      },
      {
        args: ['openai-codex', 'default', { displayName: 'Default' }],
        body: { displayName: 'Default' },
        method: 'updateAccount',
        request: 'PATCH /api/app/provider-subscriptions/openai-codex/accounts/default',
        response: loggedOutAccount,
        route: { body: loggedOutAccount },
      },
      {
        args: ['openai-codex', 'default'],
        body: null,
        method: 'deleteAccount',
        request: 'DELETE /api/app/provider-subscriptions/openai-codex/accounts/default',
        response: undefined,
        route: { status: 204 },
      },
      {
        args: ['openai-codex', 'default'],
        body: null,
        method: 'getAccountStatus',
        request: 'GET /api/app/provider-subscriptions/openai-codex/accounts/default/status',
        response: loggedOutAccount,
        route: { body: loggedOutAccount },
      },
      {
        args: ['openai-codex', 'default', { mode: 'device_code' }],
        body: { mode: 'device_code' },
        method: 'startAccountLogin',
        request: 'POST /api/app/provider-subscriptions/openai-codex/accounts/default/login',
        response: pendingAccount,
        route: { body: pendingAccount },
      },
      {
        args: ['openai-codex', 'default', { interactionId: 'interaction_demo' }],
        body: { interactionId: 'interaction_demo' },
        method: 'cancelAccountLogin',
        request: 'POST /api/app/provider-subscriptions/openai-codex/accounts/default/login/cancel',
        response: loggedOutAccount,
        route: { body: loggedOutAccount },
      },
      {
        args: ['openai-codex', 'default'],
        body: null,
        method: 'logoutAccount',
        request: 'POST /api/app/provider-subscriptions/openai-codex/accounts/default/logout',
        response: loggedOutAccount,
        route: { body: loggedOutAccount },
      },
      {
        args: ['xai', 'team_slot'],
        body: null,
        method: 'getAccountQuota',
        request: 'GET /api/app/provider-subscriptions/xai/accounts/team_slot/quota',
        response: quota,
        route: { body: quota },
      },
    ] as const;
    const routes = Object.fromEntries(
      operations.map((operation) => [operation.request, operation.route])
    ) as RouteMap;
    routes[`GET ${encodedStatusPath}`] = { body: loggedOutAccount };
    routes[`DELETE ${leadingBomDeletePath}`] = { status: 204 };
    const { client, requests } = createFakeClient(routes);
    const providerSubscriptions = Reflect.get(client, 'providerSubscriptions') as
      | Record<
          | 'listProviders'
          | 'listAccounts'
          | 'createAccount'
          | 'updateAccount'
          | 'deleteAccount'
          | 'getAccountStatus'
          | 'startAccountLogin'
          | 'cancelAccountLogin'
          | 'logoutAccount'
          | 'getAccountQuota',
          (...args: unknown[]) => Promise<unknown>
        >
      | undefined;

    expect(providerSubscriptions).toBeDefined();

    if (!providerSubscriptions) {
      return;
    }

    for (const operation of operations) {
      const method = providerSubscriptions[operation.method];
      await expect(Reflect.apply(method, providerSubscriptions, operation.args)).resolves.toEqual(
        operation.response
      );
    }

    await expect(
      providerSubscriptions.getAccountStatus('xai/preview', 'slot \uD800/a')
    ).resolves.toEqual(loggedOutAccount);
    await expect(
      providerSubscriptions.deleteAccount('openai-codex', '\uFEFFdefault')
    ).resolves.toBeUndefined();

    expect(
      requests.slice(0, operations.length).map((request) => `${request.method} ${request.path}`)
    ).toEqual(operations.map((operation) => operation.request));
    expect(requests.slice(0, operations.length).map((request) => request.body)).toEqual(
      operations.map((operation) => operation.body)
    );
    expect(
      requests.find((request) => request.path.endsWith('/accounts/default/logout'))?.hasBody
    ).toBe(false);
    expect(requests.at(-2)).toMatchObject({
      body: null,
      method: 'GET',
      path: encodedStatusPath,
    });
    expect(requests.at(-1)).toMatchObject({
      body: null,
      hasBody: false,
      method: 'DELETE',
      path: leadingBomDeletePath,
    });

    const malformedCases = [
      {
        args: [],
        method: 'listProviders',
        request: 'GET /api/app/provider-subscriptions',
        route: { body: { ...providers, legacyProvider: 'openai_codex' } },
      },
      {
        args: ['xai'],
        method: 'listAccounts',
        request: 'GET /api/app/provider-subscriptions/xai/accounts',
        route: { body: { accounts: [], defaultAccountSlotId: 'default' } },
      },
      {
        args: ['xai', { accountSlotId: 'team_slot', displayName: 'Team' }],
        method: 'createAccount',
        request: 'POST /api/app/provider-subscriptions/xai/accounts',
        route: { body: { ...loggedOutAccount, credential: 'secret' } },
      },
      {
        args: ['openai-codex', 'default', { displayName: 'Default' }],
        method: 'updateAccount',
        request: 'PATCH /api/app/provider-subscriptions/openai-codex/accounts/default',
        route: { body: { ...loggedOutAccount, credential: 'secret' } },
      },
      {
        args: ['openai-codex', 'default'],
        method: 'getAccountStatus',
        request: 'GET /api/app/provider-subscriptions/openai-codex/accounts/default/status',
        route: { body: { ...loggedOutAccount, credential: 'secret' } },
      },
      {
        args: ['openai-codex', 'default', { mode: 'device_code' }],
        method: 'startAccountLogin',
        request: 'POST /api/app/provider-subscriptions/openai-codex/accounts/default/login',
        route: { body: { ...loggedOutAccount, credential: 'secret' } },
      },
      {
        args: ['openai-codex', 'default', { interactionId: 'interaction_demo' }],
        method: 'cancelAccountLogin',
        request: 'POST /api/app/provider-subscriptions/openai-codex/accounts/default/login/cancel',
        route: { body: { ...loggedOutAccount, credential: 'secret' } },
      },
      {
        args: ['openai-codex', 'default'],
        method: 'logoutAccount',
        request: 'POST /api/app/provider-subscriptions/openai-codex/accounts/default/logout',
        route: { body: { ...loggedOutAccount, credential: 'secret' } },
      },
      {
        args: ['xai', 'team_slot'],
        method: 'getAccountQuota',
        request: 'GET /api/app/provider-subscriptions/xai/accounts/team_slot/quota',
        route: { body: { ...quota, rawQuota: {} } },
      },
    ] as const;
    const { client: malformedClient } = createFakeClient(
      Object.fromEntries(
        malformedCases.map((testCase) => [testCase.request, testCase.route])
      ) as RouteMap
    );
    const malformedProviderSubscriptions = Reflect.get(
      malformedClient,
      'providerSubscriptions'
    ) as NonNullable<typeof providerSubscriptions>;

    for (const testCase of malformedCases) {
      await expect(
        Reflect.apply(
          malformedProviderSubscriptions[testCase.method],
          malformedProviderSubscriptions,
          testCase.args
        )
      ).rejects.toBeInstanceOf(ProtocolValidationError);
    }
  });

  it('parses Goal Mode read model states consumed by Web', () => {
    for (const status of ['no_goal', 'planning', 'running', 'awaiting_user', 'completed']) {
      const payload = threadGoalSummaryForStatus(status);

      expect(ThreadGoalSummaryResponseSchema.parse(payload)).toEqual(payload);
    }
  });

  it('rejects malformed Goal Mode status values before Web consumes them', async () => {
    const invalidSummary = {
      ...threadGoalSummary(),
      goal: {
        ...threadGoalSummary().goal,
        status: 'almost_done',
      },
    };
    const { client } = createFakeClient({
      'GET /api/app/workspaces/ws_demo/threads/th_demo/goal': {
        body: invalidSummary,
      },
    });

    expect(ThreadGoalSummaryResponseSchema.safeParse(invalidSummary).success).toBe(false);
    await expect(client.app.getThreadGoalSummary('ws_demo', 'th_demo')).rejects.toBeInstanceOf(
      ProtocolValidationError
    );
  });

  it('rejects raw native runtime refs in capability usage', async () => {
    for (const [field, value] of [
      ['runtimeOriginRef', 'native_thread_0190'],
      ['runtimeCacheLineageRef', 'native_cache_0190'],
    ] as const) {
      const payload = capabilityUsageResponse();
      payload.capabilityCalls[0] = { ...payload.capabilityCalls[0], [field]: value };
      const { client } = createFakeClient({
        'GET /api/app/workspaces/ws_demo/capability-usage': { body: payload },
      });

      await expect(client.app.getCapabilityUsage('ws_demo')).rejects.toBeInstanceOf(
        ProtocolValidationError
      );
    }
  });

  it('uses the strict diagnostics schema without unsupported response shapes', async () => {
    const { client } = createFakeClient({
      'GET /api/app/diagnostics': {
        body: {
          ...appDiagnostics(),
          providers: [],
        },
      },
    });

    await expect(client.app.getDiagnostics()).rejects.toBeInstanceOf(ProtocolValidationError);
  });

  it('validates email auth responses with concrete schemas', async () => {
    const { client } = createFakeClient({
      'POST /api/auth/sign-up/email': {
        body: {
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
        },
      },
      'POST /api/auth/sign-in/email': { body: { user: { id: 1 } } },
      'POST /api/auth/sign-out': { body: { success: true } },
    });

    await expect(
      client.auth.email.signUp({
        email: 'user@example.com',
        name: 'Demo User',
        password: 'password',
      })
    ).resolves.toMatchObject({ user: { id: 'user_demo' } });
    await expect(
      client.auth.email.signIn({ email: 'user@example.com', password: 'password' })
    ).rejects.toBeInstanceOf(ProtocolValidationError);
    await expect(client.auth.email.signOut()).resolves.toEqual({ success: true });
  });

  it('rejects placeholder email auth response shapes', async () => {
    const { client } = createFakeClient({
      'POST /api/auth/sign-up/email': {
        body: {
          user: { id: 'user_demo', email: 'user@example.com' },
          session: { id: 'session_demo' },
        },
      },
    });

    await expect(
      client.auth.email.signUp({
        email: 'user@example.com',
        name: 'Demo User',
        password: 'password',
      })
    ).rejects.toBeInstanceOf(ProtocolValidationError);
  });

  it('routes runtime config calls and treats empty delete success explicitly', async () => {
    const file = {
      file: {
        id: 'server',
        kind: 'server',
        path: '/config/server.jsonc',
        exists: true,
        revision: 'rev_1',
        updatedAt: timestamp,
      },
      content: '{}',
    };
    const { client } = createFakeClient({
      'POST /api/admin/config/reload': {
        body: {
          status: 'dry-run',
          runtimeConfig: runtimeConfigStatus(),
          plan: runtimeConfigPlan(),
        },
      },
      'GET /api/admin/config/files': { body: { files: [file.file] } },
      'GET /api/admin/config/file?id=server': { body: file },
      'PUT /api/admin/config/file': { body: { file: file.file, diagnostics: [] } },
      'POST /api/admin/config/validate': {
        body: {
          valid: true,
          diagnostics: [],
          runtimeConfig: runtimeConfigStatus(),
          plan: runtimeConfigPlan(),
        },
      },
      'GET /api/admin/config/schemas': {
        body: { schemas: [{ kind: 'server', title: 'Server config', schema: {} }] },
      },
      'DELETE /api/app/automations/auto_demo': { status: 204 },
    });

    await expect(
      client.runtimeConfig.reload({ dryRun: true, mode: 'safe' })
    ).resolves.toMatchObject({
      status: 'dry-run',
    });
    await expect(client.runtimeConfig.listFiles()).resolves.toEqual({ files: [file.file] });
    await expect(client.runtimeConfig.getFile('server')).resolves.toEqual(file);
    await expect(
      client.runtimeConfig.updateFile({ id: 'server', kind: 'server', content: '{}' })
    ).resolves.toEqual({
      file: file.file,
      diagnostics: [],
    });
    await expect(client.runtimeConfig.validate({ files: [] })).resolves.toMatchObject({
      diagnostics: [],
    });
    await expect(client.runtimeConfig.getSchemas()).resolves.toEqual({
      schemas: [{ kind: 'server', title: 'Server config', schema: {} }],
    });
    expect(client.runtimeConfig).not.toHaveProperty('restartStaleSession');
    await expect(client.app.deleteAutomation('auto_demo')).resolves.toBeUndefined();
  });

  it('preserves typed API errors for delete failures', async () => {
    const { client } = createFakeClient({
      'DELETE /api/app/automations/auto_demo': {
        body: {
          ...apiError('automation_not_found', 'Automation not found.'),
          details: { automationId: 'auto_demo' },
          path: ['automationId'],
          requestId,
        },
        status: 404,
      },
    });

    await expect(client.app.deleteAutomation('auto_demo')).rejects.toMatchObject({
      code: 'automation_not_found',
      details: { automationId: 'auto_demo' },
      message: 'Automation not found.',
      path: ['automationId'],
      requestId,
      status: 404,
    } satisfies Partial<ApiCallError>);
  });

  it('exposes first-class capability discovery helpers', async () => {
    const { client } = createFakeClient({
      'GET /api/meta': {
        body: {
          protocolVersion: '0.5.0',
          capabilities: ['core.questions'],
          eventFamilies: ['turn.started', 'turn.completed'],
        },
      },
    });

    expect(client.capabilities.snapshot()).toBeNull();
    expect(client.capabilities.supports('core.questions')).toBe(false);

    await client.capabilities.refresh();

    expect(client.capabilities.snapshot()?.capabilities).toEqual(['core.questions']);
    expect(client.capabilities.supports('core.questions')).toBe(true);
    expect(() => client.capabilities.require('core.questions')).not.toThrow();
    expect(() => client.capabilities.require('core.unknown')).toThrow(
      'Capability is not supported'
    );
  });

  it('uses explicit EventSource for composed turn SSE while HTTP keeps the supplied fetch', async () => {
    FakeEventSource.instances = [];
    const fetchCalls: string[] = [];
    const client = createCoreClient({
      baseUrl: 'https://nanocore.test',
      eventSource: FakeEventSource,
      fetch: async (input) => {
        const url = String(input);
        fetchCalls.push(url);

        if (url.includes('/events?')) {
          return sseResponse([turnEvent(1, 'turn.completed')]);
        }

        return jsonResponse({
          protocolVersion: '0.5.0',
          capabilities: [],
          eventFamilies: [],
        });
      },
    });

    await client.core.meta();
    const iterator = client.core
      .subscribeTurnEvents({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
      })
      [Symbol.asyncIterator]();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(fetchCalls).toEqual(['https://nanocore.test/api/meta']);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe(
      'https://nanocore.test/api/workspaces/ws_demo/threads/th_demo/events?turnId=turn_demo&since=0'
    );

    source.emit('message', turnEvent(1, 'turn.completed'));
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { event: 'turn.completed', sequence: 1 },
    });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(fetchCalls).toEqual(['https://nanocore.test/api/meta']);
  });

  it('withholds AgentSession events and projects embedded Turns over fetch SSE', async () => {
    const terminal = turnEvent(2, 'turn.completed');
    const iterator = subscribeTurnEvents({
      baseUrl: 'https://nanocore.test',
      fetch: async () =>
        sseResponse([
          agentSessionEvent(1),
          {
            ...terminal,
            data: {
              ...terminal.data,
              turn: {
                ...turn(),
                agentSessionId: 'as_demo',
                status: 'completed',
                completedAt: timestamp,
              },
            },
          },
        ]),
      threadId: 'th_demo',
      turnId: 'turn_demo',
      workspaceId: 'ws_demo',
    })[Symbol.asyncIterator]();

    const result = await iterator.next();

    expect(result).toMatchObject({
      done: false,
      value: { event: 'turn.completed', sequence: 2 },
    });
    expect(result.value).not.toHaveProperty('data.turn.agentSessionId');
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('withholds AgentSession events and projects embedded Turns over EventSource SSE', async () => {
    FakeEventSource.instances = [];
    const terminal = turnEvent(2, 'turn.completed');
    const iterator = subscribeTurnEvents({
      baseUrl: '',
      eventSource: FakeEventSource,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      workspaceId: 'ws_demo',
    })[Symbol.asyncIterator]();
    const source = FakeEventSource.instances[0]!;

    source.emit('message', agentSessionEvent(1));
    source.emit('message', {
      ...terminal,
      data: {
        ...terminal.data,
        turn: {
          ...turn(),
          agentSessionId: 'as_demo',
          status: 'completed',
          completedAt: timestamp,
        },
      },
    });
    const result = await iterator.next();

    expect(result).toMatchObject({
      done: false,
      value: { event: 'turn.completed', sequence: 2 },
    });
    expect(result.value).not.toHaveProperty('data.turn.agentSessionId');
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(source.closed).toBe(true);
  });

  it.each([
    [
      'an invalid outer envelope',
      {
        ...turnEvent(1, 'turn.completed'),
        sequence: 'not-a-number',
      },
    ],
    [
      'an unparseable known turn-completed payload',
      {
        ...turnEvent(1, 'turn.completed'),
        data: {
          ...turnEvent(1, 'turn.completed').data,
          turn: { ...turn(), status: 'future-terminal' },
        },
      },
    ],
  ])('surfaces %s through the fetch iterator', async (_label, invalidEvent) => {
    const fetcher: typeof fetch = async () => sseResponse([invalidEvent]);
    const client = createCoreClient({ baseUrl: 'https://nanocore.test', fetch: fetcher });
    const iterator = client.core
      .subscribeTurnEvents({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
      })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toBeInstanceOf(ProtocolValidationError);
  });

  it('terminates fetch without reconnecting when an outer SSE frame contains malformed JSON', async () => {
    let activeSignal: AbortSignal | null | undefined;
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(String(input));
      activeSignal = init?.signal;
      return new Response('data: {\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    const iterator = subscribeTurnEvents({
      baseUrl: 'https://nanocore.test',
      fetch: fetcher,
      since: 4,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      workspaceId: 'ws_demo',
    })[Symbol.asyncIterator]();
    let delivered = false;
    let failure: unknown;

    try {
      delivered = !(await iterator.next()).done;
    } catch (error) {
      failure = error;
    }

    expect({
      aborted: activeSignal?.aborted,
      delivered,
      failureIsProtocolValidationError: failure instanceof ProtocolValidationError,
      next: await iterator.next(),
      requests,
    }).toEqual({
      aborted: true,
      delivered: false,
      failureIsProtocolValidationError: true,
      next: { value: undefined, done: true },
      requests: [
        'https://nanocore.test/api/workspaces/ws_demo/threads/th_demo/events?turnId=turn_demo&since=4',
      ],
    });
  });

  it('discards queued fetch events when protocol validation fails', async () => {
    let activeSignal: AbortSignal | null | undefined;
    let fetchCalls = 0;
    let resolveAbort = (): void => {};
    const aborted = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const fetcher: typeof fetch = async (_input, init) => {
      fetchCalls += 1;
      activeSignal = init?.signal;
      activeSignal?.addEventListener('abort', resolveAbort, { once: true });
      return sseResponse([turnEvent(1), { ...turnEvent(2), sequence: 'bad' }, turnEvent(3)]);
    };
    const iterator = subscribeTurnEvents({
      baseUrl: 'https://nanocore.test',
      fetch: fetcher,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      workspaceId: 'ws_demo',
    })[Symbol.asyncIterator]();

    await aborted;
    await expect(iterator.next()).rejects.toBeInstanceOf(ProtocolValidationError);
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(activeSignal?.aborted).toBe(true);
    expect(fetchCalls).toBe(1);
  });

  it.each([
    ['completed', 'completed'],
    ['interrupted', 'aborted'],
    ['cancelled', 'aborted'],
    ['failed', 'error'],
  ] as const)('stops fetch delivery on a canonical %s Turn', async (status, stopReason) => {
    const terminalEvent = turnEvent(2, 'turn.completed');
    const fetcher: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(
        'https://nanocore.test/api/workspaces/ws_demo/threads/th_demo/events?turnId=turn_demo&since=0'
      );
      expect(headersToRecord(init?.headers)).toEqual({ accept: 'text/event-stream' });
      return sseResponse([
        turnEvent(1),
        turnEvent(1),
        {
          ...terminalEvent,
          data: {
            ...terminalEvent.data,
            stopReason,
            turn: { ...turn(), status, completedAt: timestamp },
          },
        },
      ]);
    };
    const client = createCoreClient({ baseUrl: 'https://nanocore.test/', fetch: fetcher });
    const iterator = client.core
      .subscribeTurnEvents({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
      })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { sequence: 1 },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { sequence: 2, event: 'turn.completed' },
    });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it.each(
    pseudoTerminalCases
  )('withholds %s and reconnects fetch with its sequence', async (_label, pseudoTerminal) => {
    let fetchCalls = 0;
    const fetcher: typeof fetch = async (input) => {
      fetchCalls += 1;
      expect(String(input)).toContain(`since=${fetchCalls === 1 ? 4 : 5}`);

      return fetchCalls === 1
        ? sseResponse([pseudoTerminal])
        : sseResponse([turnEvent(6, 'turn.completed')]);
    };
    const iterator = subscribeTurnEvents({
      baseUrl: 'https://nanocore.test',
      fetch: fetcher,
      since: 4,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      workspaceId: 'ws_demo',
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { event: 'turn.completed', sequence: 6 },
    });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(fetchCalls).toBe(2);
  });

  it('applies configured HTTP headers to JSON requests and fetch SSE requests', async () => {
    const jsonRequests: RecordedRequest[] = [];
    const jsonClient = createCoreClient({
      baseUrl: 'https://nanocore.test',
      fetch: async (_input, init) => {
        jsonRequests.push({
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
          hasBody: init?.body !== undefined,
          headers: headersToRecord(init?.headers),
          method: init?.method ?? 'GET',
          path: '/api/meta',
        });

        return jsonResponse({
          protocolVersion: '0.5.0',
          capabilities: [],
          eventFamilies: [],
        });
      },
      headers: {
        authorization: 'Bearer deployment-token',
        cookie: 'better-auth.session_token=session-value',
      },
    });

    await jsonClient.core.meta();

    expect(jsonRequests[0]?.headers).toMatchObject({
      authorization: 'Bearer deployment-token',
      cookie: 'better-auth.session_token=session-value',
    });

    const sseClient = createCoreClient({
      baseUrl: 'https://nanocore.test',
      fetch: async (_input, init) => {
        expect(headersToRecord(init?.headers)).toMatchObject({
          accept: 'text/event-stream',
          authorization: 'Bearer deployment-token',
          cookie: 'better-auth.session_token=session-value',
        });

        return sseResponse([turnEvent(1, 'turn.completed')]);
      },
      headers: {
        authorization: 'Bearer deployment-token',
        cookie: 'better-auth.session_token=session-value',
      },
    });

    const iterator = sseClient.core
      .subscribeTurnEvents({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
      })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { sequence: 1, event: 'turn.completed' },
    });
  });

  it('handles fetch SSE empty completion and API failures through iterator results', async () => {
    const emptyClient = createCoreClient({
      baseUrl: 'https://nanocore.test',
      fetch: async () => new Response(null, { status: 204 }),
    });
    const failingClient = createCoreClient({
      baseUrl: 'https://nanocore.test',
      fetch: async () => jsonResponse(apiError('stream_failed', 'Stream failed.'), 503),
    });
    const rejectedClient = createCoreClient({
      baseUrl: 'https://nanocore.test',
      fetch: async () => {
        throw new TypeError('network failed');
      },
    });

    await expect(
      emptyClient.core
        .subscribeTurnEvents({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
        })
        [Symbol.asyncIterator]()
        .next()
    ).resolves.toEqual({ value: undefined, done: true });
    await expect(
      failingClient.core
        .subscribeTurnEvents({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
        })
        [Symbol.asyncIterator]()
        .next()
    ).rejects.toMatchObject({ code: 'stream_failed', status: 503 });
    await expect(
      rejectedClient.core
        .subscribeTurnEvents({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
        })
        [Symbol.asyncIterator]()
        .next()
    ).rejects.toThrow('network failed');
  });

  it.each([
    ['an invalid outer envelope', { ...turnEvent(2), sequence: 'bad' }],
    [
      'an unparseable known turn-completed payload',
      {
        ...turnEvent(2, 'turn.completed'),
        data: {
          ...turnEvent(2, 'turn.completed').data,
          turn: { ...turn(), status: 'future-terminal' },
        },
      },
    ],
  ])('surfaces %s without advancing the EventSource cursor', async (_label, invalidEvent) => {
    FakeEventSource.instances = [];
    const stream = subscribeTurnEvents({
      baseUrl: '',
      eventSource: FakeEventSource,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      workspaceId: 'ws_demo',
    });
    const iterator = stream[Symbol.asyncIterator]();
    const source = FakeEventSource.instances[0]!;

    expect(source.url).toBe(
      '/api/workspaces/ws_demo/threads/th_demo/events?turnId=turn_demo&since=0'
    );

    source.emit('message', turnEvent(1));
    source.emit('message', turnEvent(1));
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { sequence: 1 },
    });
    source.emit('message', invalidEvent);
    await expect(iterator.next()).rejects.toBeInstanceOf(ProtocolValidationError);
    expect(source.closed).toBe(true);
    source.emit('error', null);
    expect(FakeEventSource.instances).toHaveLength(1);
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('terminates EventSource without reconnecting when an outer SSE frame contains malformed JSON', async () => {
    FakeEventSource.instances = [];
    const iterator = subscribeTurnEvents({
      baseUrl: '',
      eventSource: FakeEventSource,
      since: 4,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      workspaceId: 'ws_demo',
    })[Symbol.asyncIterator]();
    const source = FakeEventSource.instances[0]!;

    source.listeners.get('message')![0]!({ data: '{' } as MessageEvent<string>);
    source.emit('error', null);
    let delivered = false;
    let failure: unknown;

    try {
      delivered = !(await iterator.next()).done;
    } catch (error) {
      failure = error;
    }

    expect({
      closed: source.closed,
      delivered,
      failureIsProtocolValidationError: failure instanceof ProtocolValidationError,
      instanceCount: FakeEventSource.instances.length,
      next: await iterator.next(),
      url: source.url,
    }).toEqual({
      closed: true,
      delivered: false,
      failureIsProtocolValidationError: true,
      instanceCount: 1,
      next: { value: undefined, done: true },
      url: '/api/workspaces/ws_demo/threads/th_demo/events?turnId=turn_demo&since=4',
    });
  });

  it('discards queued EventSource events when embedded Turn validation fails', async () => {
    FakeEventSource.instances = [];
    const iterator = subscribeTurnEvents({
      baseUrl: '',
      eventSource: FakeEventSource,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      workspaceId: 'ws_demo',
    })[Symbol.asyncIterator]();
    const source = FakeEventSource.instances[0]!;
    const invalidEvent = turnEvent(2, 'turn.completed');

    source.emit('message', turnEvent(1));
    source.emit('message', {
      ...invalidEvent,
      data: {
        ...invalidEvent.data,
        turn: { ...turn(), status: 'future-terminal' },
      },
    });
    const closedAfterValidation = source.closed;
    source.emit('message', turnEvent(3));
    source.emit('error', null);

    await expect(iterator.next()).rejects.toBeInstanceOf(ProtocolValidationError);
    expect({
      closedAfterValidation,
      instanceCount: FakeEventSource.instances.length,
      next: await iterator.next(),
    }).toEqual({
      closedAfterValidation: true,
      instanceCount: 1,
      next: { value: undefined, done: true },
    });
  });

  it.each(
    pseudoTerminalCases
  )('withholds %s and reconnects EventSource with its sequence', async (_label, pseudoTerminal) => {
    FakeEventSource.instances = [];
    const stream = subscribeTurnEvents({
      baseUrl: 'https://nanocore.test',
      eventSource: FakeEventSource,
      since: 4,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      workspaceId: 'ws_demo',
    });
    const iterator = stream[Symbol.asyncIterator]();
    const source = FakeEventSource.instances[0]!;
    source.emit('message', pseudoTerminal);
    source.emit('error', null);
    const reopenedSource = FakeEventSource.instances[1]!;
    expect(reopenedSource.url).toBe(
      'https://nanocore.test/api/workspaces/ws_demo/threads/th_demo/events?turnId=turn_demo&since=5'
    );
    reopenedSource.emit('message', turnEvent(6, 'turn.completed'));

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { event: 'turn.completed', sequence: 6 },
    });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(reopenedSource.closed).toBe(true);
  });

  it('discards queued EventSource events when replacement construction fails', async () => {
    const constructionError = new Error('replacement EventSource construction failed');
    let constructionCount = 0;

    /** EventSource fake whose replacement construction fails. */
    class FailingReplacementEventSource extends FakeEventSource {
      /** Opens the initial source and rejects its replacement. */
      constructor(url: string) {
        constructionCount += 1;

        if (constructionCount > 1) {
          throw constructionError;
        }

        super(url);
      }
    }

    FakeEventSource.instances = [];
    const iterator = subscribeTurnEvents({
      baseUrl: 'https://nanocore.test',
      eventSource: FailingReplacementEventSource,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      workspaceId: 'ws_demo',
    })[Symbol.asyncIterator]();
    const source = FakeEventSource.instances[0]!;

    source.emit('message', turnEvent(1));
    expect(() => source.emit('error', null)).not.toThrow();
    source.emit('message', turnEvent(2));
    source.emit('error', null);

    await expect(iterator.next()).rejects.toBe(constructionError);
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect({
      constructionCount,
      instances: FakeEventSource.instances,
      sourceClosed: source.closed,
    }).toEqual({
      constructionCount: 2,
      instances: [source],
      sourceClosed: true,
    });
  });

  it('ignores callbacks from a superseded EventSource transport', async () => {
    FakeEventSource.instances = [];
    const iterator = subscribeTurnEvents({
      baseUrl: 'https://nanocore.test',
      eventSource: FakeEventSource,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      workspaceId: 'ws_demo',
    })[Symbol.asyncIterator]();
    const supersededSource = FakeEventSource.instances[0]!;

    supersededSource.emit('error', null);
    const currentSource = FakeEventSource.instances[1]!;
    supersededSource.emit('message', turnEvent(9));
    supersededSource.emit('error', null);
    currentSource.emit('error', null);
    const canonicalSource = FakeEventSource.instances.at(-1)!;
    canonicalSource.emit('message', turnEvent(1, 'turn.completed'));

    const first = await iterator.next();
    await iterator.return?.();
    expect({
      first,
      instanceCount: FakeEventSource.instances.length,
      url: canonicalSource.url,
    }).toEqual({
      first: {
        done: false,
        value: expect.objectContaining({ event: 'turn.completed', sequence: 1 }),
      },
      instanceCount: 3,
      url: 'https://nanocore.test/api/workspaces/ws_demo/threads/th_demo/events?turnId=turn_demo&since=0',
    });
  });

  it('isolates synchronous callbacks while superseding an EventSource transport', async () => {
    /** EventSource fake that emits one final callback pair synchronously from close. */
    class SynchronousCloseEventSource extends FakeEventSource {
      private emittedCloseCallbacks = false;

      /** Closes the source and emits the transport's final synchronous callbacks once. */
      override close(): void {
        super.close();

        if (this.emittedCloseCallbacks) {
          return;
        }

        this.emittedCloseCallbacks = true;
        this.emit('message', turnEvent(9));
        this.emit('error', null);
      }
    }

    FakeEventSource.instances = [];
    const iterator = subscribeTurnEvents({
      baseUrl: 'https://nanocore.test',
      eventSource: SynchronousCloseEventSource,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      workspaceId: 'ws_demo',
    })[Symbol.asyncIterator]();
    const supersededSource = FakeEventSource.instances[0]!;

    supersededSource.emit('error', null);
    const stateBeforeReturn = FakeEventSource.instances.map(({ closed, url }) => ({ closed, url }));
    await iterator.return?.();

    expect(stateBeforeReturn).toEqual([
      {
        closed: true,
        url: 'https://nanocore.test/api/workspaces/ws_demo/threads/th_demo/events?turnId=turn_demo&since=0',
      },
      {
        closed: false,
        url: 'https://nanocore.test/api/workspaces/ws_demo/threads/th_demo/events?turnId=turn_demo&since=0',
      },
    ]);
  });

  it.each([
    ['completed', 'completed'],
    ['interrupted', 'aborted'],
    ['cancelled', 'aborted'],
    ['failed', 'error'],
  ] as const)('stops EventSource delivery on a canonical %s Turn', async (status, stopReason) => {
    FakeEventSource.instances = [];
    const terminalEvent = turnEvent(1, 'turn.completed');
    const iterator = subscribeTurnEvents({
      baseUrl: '',
      eventSource: FakeEventSource,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      workspaceId: 'ws_demo',
    })[Symbol.asyncIterator]();
    const source = FakeEventSource.instances[0]!;
    source.emit('message', {
      ...terminalEvent,
      data: {
        ...terminalEvent.data,
        stopReason,
        turn: { ...turn(), status, completedAt: timestamp },
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { data: { turn: { status } }, event: 'turn.completed', sequence: 1 },
    });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(source.closed).toBe(true);
  });

  it('ignores a second EventSource terminal event received before iterator drain', async () => {
    FakeEventSource.instances = [];
    const iterator = subscribeTurnEvents({
      baseUrl: '',
      eventSource: FakeEventSource,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      workspaceId: 'ws_demo',
    })[Symbol.asyncIterator]();
    const source = FakeEventSource.instances[0]!;

    source.emit('message', turnEvent(1, 'turn.completed'));
    source.emit('message', turnEvent(2, 'turn.completed'));

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { event: 'turn.completed', sequence: 1 },
    });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(source.closed).toBe(true);
  });
});
