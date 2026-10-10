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

/** Creates one reusable single-chunk byte stream. */
function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
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

/** Returns one safe in-progress Workspace deletion projection. */
function workspaceDeletionResponse() {
  return {
    deletion: {
      closureId: null,
      phase: 'fenced',
      recoveryExportId: null,
      requestId,
      retainedStaging: false,
      status: 'active',
      workspaceId: 'ws_demo',
    },
  };
}

/** Returns one valid thread record. */
function thread() {
  return {
    id: 'th_demo',
    workspaceId: 'ws_demo',
    name: 'Demo thread',
    preview: 'Demo thread',
    entryPath: 'conversation',
    visibility: 'workspace',
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

/** Returns one exact public NanoHost RuntimeTarget admin response. */
function nanoHostRuntimeTargetStatus() {
  return {
    identityId: 'integration_nanohost_primary',
    deploymentId: 'deploy_primary',
    connectionGeneration: 3,
    predecessorFenced: true,
    ready: true,
    freshEmpty: true,
    observedAt: timestamp,
  };
}

/** Returns one strict App Diagnostics fixture. */
function appDiagnostics() {
  return {
    service: 'nanocore',
    boot: bootReadiness(),
    process: {
      observedAt: timestamp,
      nodeVersion: 'v24.0.0',
      uptimeSeconds: 1.5,
      memory: {
        rssBytes: 1,
        heapUsedBytes: 1,
        heapTotalBytes: 1,
      },
      telemetry: {
        enabled: false,
        exportConfigured: false,
      },
    },
    gateway: {
      status: 'ok',
      endpoints: ['/v1/chat/completions'],
      defaultModelId: 'default',
      models: [{ id: 'default', displayName: 'Default', capabilities: ['chat'] }],
    },
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
      agentId: 'agent_demo',
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
    viewerUserId: 'user_local',
    participants: [],
    thread: thread(),
    turns: [turn()],
    taskInputs: [{ itemId: 'item_request', objective: 'Inspect the linked repository.' }],
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
      selectedAgentId: 'agent_demo',
      activeTurnStatus: 'running',
      pendingApprovalCount: 0,
      pendingQuestionCount: 0,
      latestArtifact: null,
    },
    composer: {
      disabled: false,
      defaultAgentId: 'agent_demo',
    },
    itemLog: {
      href: '/api/app/workspaces/ws_demo/threads/th_demo/items',
    },
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
        defaultAgentId: 'agent_codex_host',
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
      appliedMigrations: ['core_0000_setup'],
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
          path: 'records/workspace-record.json',
          digest: 'sha256:ab4a13e5a040b76a82521f52dabddd42e7e4d4244c47e16ee8c6e1aa16233f3f',
          bytes: 16,
        },
      ],
    },
    fileCount: 1,
    totalBytes: 16,
    checkedFiles: ['records/workspace-record.json'],
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

/** Returns one prepared App-update review fixture. */
function appUpdatePrepared() {
  return {
    expectedCurrentImageId: `sha256:${'b'.repeat(64)}`,
    preparedAt: timestamp,
    requestId: '11111111-1111-4111-8111-111111111111',
    source: {
      appDigest: `sha256:${'b'.repeat(64)}`,
      sourceCommit: 'a'.repeat(40),
      tag: 'v0.1.0',
    },
    stage: 'prepared' as const,
  };
}

/** Returns one App-update status fixture. */
function appUpdateStatus() {
  return {
    ...appUpdatePrepared(),
    candidateBoot: null,
    candidateImageId: null,
    completedAt: null,
    error: null,
    jobId: 'job_app-update.service',
    outcome: 'running' as const,
    predicates: null,
    previousAppRestored: null,
    previousBoot: null,
    previousImageId: null,
    stage: 'launching' as const,
    startedAt: timestamp,
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
        schemaSnapshotId: null,
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
    verification: { fileCount: 1, totalBytes: 16, checkedFiles: ['records/workspace-record.json'] },
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
    verification: { fileCount: 1, totalBytes: 16, checkedFiles: ['records/workspace-record.json'] },
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
      counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

/** Returns one safe deleted-Workspace recovery projection. */
function deletedWorkspaceRecoveryResponse() {
  return {
    recovery: {
      closureId: 'closure_demo',
      deletionRequestId: '00000000-0000-4000-8000-000000000002',
      import: workspaceImportResponse(),
      recoveryExportId: 'wsexp_demo',
      sourceWorkspaceId: 'ws_demo',
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
  it('sends exact revision-bound Provider deletion JSON and validates before transport', async () => {
    const { client, requests } = createFakeClient({
      'POST /api/app/operations/runtime.file-delete': { status: 204 },
    });
    const input = {
      id: 'providers/exact.provider.jsonc',
      kind: 'provider' as const,
      expectedRevision: 'exact-revision',
    };
    await expect(client.operations['runtime.file-delete'](input)).resolves.toBeNull();
    expect(requests).toEqual([
      expect.objectContaining({
        body: input,
        method: 'POST',
        path: '/api/app/operations/runtime.file-delete',
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    await expect(
      client.operations['runtime.file-delete']({ ...input, expectedRevision: '' })
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
  it('streams portable Workspace archive downloads and uploads without JSON encoding', async () => {
    const archive = new Uint8Array([40, 181, 47, 253]);
    const requests: Array<{ body: Uint8Array; headers: Headers; method: string; path: string }> =
      [];
    const client = createCoreClient({
      baseUrl: 'https://nanocore.test',
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const body = init?.body
          ? new Uint8Array(await new Response(init.body).arrayBuffer())
          : new Uint8Array();
        requests.push({
          body,
          headers: new Headers(init?.headers),
          method: init?.method ?? 'GET',
          path,
        });
        if (init?.method === 'GET') {
          return new Response(archive, {
            headers: {
              'content-type': 'application/vnd.openkit.workspace-export+tar.zstd',
            },
          });
        }
        return jsonResponse(
          path.endsWith('import-dry-run')
            ? workspaceImportDryRunResponse()
            : workspaceImportResponse()
        );
      },
    });

    const downloaded = await client.app.downloadWorkspaceExportArchive('ws_demo', 'wsexp_demo');
    expect(new Uint8Array(await new Response(downloaded).arrayBuffer())).toEqual(archive);
    await expect(client.app.dryRunWorkspaceArchiveImport(byteStream(archive))).resolves.toEqual(
      workspaceImportDryRunResponse()
    );
    await expect(
      client.app.importWorkspaceArchive(byteStream(archive), requestId)
    ).resolves.toEqual(workspaceImportResponse());
    expect(requests).toMatchObject([
      {
        body: new Uint8Array(),
        method: 'GET',
        path: '/api/app/workspaces/ws_demo/exports/wsexp_demo/archive',
      },
      {
        body: archive,
        method: 'POST',
        path: '/api/app/workspace-archives/import-dry-run',
      },
      {
        body: archive,
        method: 'POST',
        path: '/api/app/workspace-archives/import',
      },
    ]);
    expect(requests[1]?.headers.get('content-type')).toBe(
      'application/vnd.openkit.workspace-export+tar.zstd'
    );
    expect(requests[2]?.headers.get('x-openkit-request-id')).toBe(requestId);
  });

  it('exports only the ordinary product SSE envelope type', () => {
    // @ts-expect-error AgentSession events are internal and cannot inhabit the ordinary SSE type.
    const internalOnlyEvent: SseEventEnvelope = agentSessionEvent(1);

    expect(internalOnlyEvent.data.type).toBe('agent-session-updated');
  });

  it('exposes composed sub-clients without deprecated flat aliases', () => {
    const { client } = createFakeClient({});

    expect(client.core).toBeDefined();
    expect(client.app).toBeDefined();
    expect('runtimeConfig' in client).toBe(false);
    expect(client.auth.email).toBeDefined();
    expect(client.capabilities).toBeDefined();
    expect(client).not.toHaveProperty('agents');
    expect(client.operations['agent.list']).toBeTypeOf('function');
    expect('actionCenter' in client).toBe(false);
    expect(client.operations['attention.list']).toBeTypeOf('function');
    expect(client).not.toHaveProperty('catalog');
    expect(client.operations['catalog.read']).toBeTypeOf('function');
    expect('repositories' in client).toBe(false);
    expect('updateArtifactMetadata' in client.core).toBe(false);
    expect(client.operations['artifact.review-list']).toBeTypeOf('function');
    expect(client.operations['artifact.review.decide']).toBeTypeOf('function');
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
    expect('providerSubscriptions' in client).toBe(false);

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
      'getAccountAutoTopup',
    ]) {
      expect(alias in client).toBe(false);
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
        client.operations['chat.quick']({ input: 'Hello', providerId: 'caller-provider' } as never),
    ],
    [
      'Chat Mode',
      (client: CoreClient) =>
        client.operations['conversation.submit']({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          ...({
            input: 'Hello',
            model: 'caller-model',
          } as never),
        }),
    ],
  ])('rejects caller provider or model authority before %s transport', async (_name, invoke) => {
    const { client, requests } = createFakeClient({});

    await expect(invoke(client)).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it('routes workspace.create, thread.create and turn.start through definition-derived methods', async () => {
    const { client, requests } = createFakeClient({
      'POST /api/app/operations/workspace.list': {
        body: {
          items: [
            {
              workspace: workspace(),
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_local',
              registryRevision: 1,
            },
          ],
        },
      },
      'POST /api/app/operations/workspace.create': { body: workspace() },
      'POST /api/app/operations/workspace.resources': {
        body: { agents: [agent()], knowledge: [], models: [], skills: [] },
      },
      'POST /api/app/operations/thread.create': { body: thread() },
      'POST /api/app/operations/turn.start': { body: turn() },
      'POST /api/app/operations/artifact.read': { body: artifact() },
    });

    await expect(client.operations['workspace.list']({})).resolves.toMatchObject({
      items: [{ workspace: workspace() }],
    });
    await client.operations['workspace.create']({ name: 'Demo' });
    await client.operations['workspace.resources']({ workspaceId: 'ws_demo' });
    await client.operations['thread.create']({ workspaceId: 'ws_demo', name: 'Demo thread' });
    await client.operations['turn.start']({
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      input: 'Run',
    });
    await expect(
      client.operations['turn.start']({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        answers: { branch: ['main'] },
      } as never)
    ).rejects.toThrow();
    await expect(
      client.operations['artifact.read']({ workspaceId: 'ws_demo', artifactId: 'artifact_demo' })
    ).resolves.toEqual(artifact());

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /api/app/operations/workspace.list',
      'POST /api/app/operations/workspace.create',
      'POST /api/app/operations/workspace.resources',
      'POST /api/app/operations/thread.create',
      'POST /api/app/operations/turn.start',
      'POST /api/app/operations/artifact.read',
    ]);
    expect(requests[1]?.body).toMatchObject({ name: 'Demo' });
    expect(requests[1]?.headers['x-openkit-request-id']).toEqual(expect.any(String));
    expect(requests[3]?.body).toMatchObject({ name: 'Demo thread', workspaceId: 'ws_demo' });
    expect(requests[3]?.headers['x-openkit-request-id']).toEqual(expect.any(String));
    expect(requests[4]?.body).toMatchObject({ input: 'Run' });
    expect(requests[4]?.headers['x-openkit-request-id']).toEqual(expect.any(String));
  });

  it('routes remaining product operations through validated definition-derived paths', async () => {
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
      'POST /api/app/operations/workspace.read': { body: workspace() },
      'POST /api/app/operations/workspace.update': { body: workspace() },
      'POST /api/app/operations/knowledge.list': { body: { items: [knowledge] } },
      'POST /api/app/operations/knowledge.create': { body: knowledge },
      'POST /api/app/operations/knowledge.update': { body: knowledge },
      'POST /api/app/operations/knowledge.delete': { body: null },
      'POST /api/app/operations/thread.list': { body: { items: [thread()] } },
      'POST /api/app/operations/thread.read': { body: thread() },
      'POST /api/app/operations/thread.update': { body: thread() },
      'POST /api/app/operations/thread.archive': { body: thread() },
      'POST /api/app/operations/turn.read': {
        body: turnReadProjection(),
      },
      'POST /api/app/operations/turn.interrupt': {
        body: turn(),
      },
      'POST /api/app/operations/artifact.list': { body: { items: [artifact()] } },
      'POST /api/app/operations/sync.review-list': {
        body: { items: [workspaceSyncReview()] },
      },
      'POST /api/app/operations/sync.review-read': {
        body: workspaceSyncReview(),
      },
      'POST /api/app/operations/sync.review-decide': {
        body: {
          review: { ...workspaceSyncReview().review, status: 'needs_refinement' },
          workspaceApplyResult: null,
        },
      },
      'POST /api/app/operations/sync.recovery-decide': {
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
      'POST /api/app/operations/sync.input-snapshot-list': {
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
      'POST /api/app/operations/sync.materialization-list': {
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
      'POST /api/app/operations/sync.backend-handle-list': {
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
      'POST /api/app/operations/sync.output-manifest-list': {
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
      'POST /api/app/operations/sync.change-set-list': {
        body: { items: [workspaceSyncReview().changeSet] },
      },
      'POST /api/app/operations/sync.staged-review-list': {
        body: { items: [workspaceSyncReview().review] },
      },
      'POST /api/app/operations/sync.apply-plan-list': {
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
      'POST /api/app/operations/sync.reconciliation-list': {
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
      'POST /api/app/operations/sync.quarantine-list': {
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
      'POST /api/app/operations/sync.apply-result-list': {
        body: { items: [workspaceApplyResult()] },
      },
      'POST /api/app/operations/sync.apply-result-read': {
        body: workspaceApplyResult(),
      },
      'POST /api/app/operations/environment.snapshot-list': {
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
      'POST /api/app/operations/environment.snapshot-read': {
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
      'POST /api/app/operations/thread.items': {
        body: { items: [item], nextCursor: null },
      },
    });

    await expect(client.core.meta()).resolves.toMatchObject({ protocolVersion: '0.5.0' });
    await expect(client.operations['workspace.read']({ workspaceId: 'ws_demo' })).resolves.toEqual(
      workspace()
    );
    await expect(
      client.operations['workspace.update']({ ...{ status: 'archived' }, workspaceId: 'ws_demo' })
    ).resolves.toEqual(workspace());
    await expect(client.operations['knowledge.list']({ workspaceId: 'ws_demo' })).resolves.toEqual({
      items: [knowledge],
    });
    await expect(
      client.operations['knowledge.create']({
        workspaceId: 'ws_demo',
        kind: knowledge.kind,
        title: knowledge.title,
        content: knowledge.content,
      })
    ).resolves.toEqual(knowledge);
    await expect(
      client.operations['knowledge.update']({
        workspaceId: 'ws_demo',
        knowledgeEntryId: 'mem_demo',
        ...{ title: 'Updated' },
      })
    ).resolves.toEqual(knowledge);
    await expect(
      client.operations['knowledge.delete']({
        workspaceId: 'ws_demo',
        knowledgeEntryId: 'mem_demo',
      })
    ).resolves.toBeNull();
    await expect(client.operations['thread.list']({ workspaceId: 'ws_demo' })).resolves.toEqual({
      items: [thread()],
    });
    await expect(
      client.operations['thread.read']({ workspaceId: 'ws_demo', threadId: 'th_demo' })
    ).resolves.toEqual(thread());
    await expect(
      client.operations['thread.update']({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        name: 'Renamed',
      })
    ).resolves.toEqual(thread());
    await expect(
      client.operations['thread.archive']({ workspaceId: 'ws_demo', threadId: 'th_demo' })
    ).resolves.toEqual(thread());
    await expect(
      client.operations['turn.read']({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
      })
    ).resolves.toEqual(turnReadProjection());
    await expect(
      client.operations['turn.interrupt']({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
      })
    ).resolves.toEqual(turn());
    await expect(client.operations['artifact.list']({ workspaceId: 'ws_demo' })).resolves.toEqual({
      items: [artifact()],
    });
    await expect(
      client.operations['sync.review-list']({ workspaceId: 'ws_demo' })
    ).resolves.toEqual({
      items: [workspaceSyncReview()],
    });
    await expect(
      client.operations['sync.review-read']({ workspaceId: 'ws_demo', reviewId: 'swr_1' })
    ).resolves.toEqual(workspaceSyncReview());
    await expect(
      client.operations['sync.review-decide']({
        workspaceId: 'ws_demo',
        reviewId: 'swr_1',
        ...{
          decision: 'needs_refinement',
        },
      })
    ).resolves.toMatchObject({
      review: { id: 'swr_1', status: 'needs_refinement' },
      workspaceApplyResult: null,
    });
    await expect(
      client.operations['sync.recovery-decide']({
        workspaceId: 'ws_demo',
        reconciliationRecordId: 'wrr_1',
        ...{
          decision: 'quarantine',
        },
      })
    ).resolves.toMatchObject({
      reconciliationRecord: { id: 'wrr_1', stateAfter: 'quarantined' },
    });
    await expect(
      client.operations['sync.input-snapshot-list']({ workspaceId: 'ws_demo' })
    ).resolves.toMatchObject({
      items: [{ id: 'wis_1', strategy: 'git' }],
    });
    await expect(
      client.operations['sync.materialization-list']({ workspaceId: 'ws_demo' })
    ).resolves.toMatchObject({
      items: [{ id: 'wmr_1', inputSnapshotId: 'wis_1' }],
    });
    await expect(
      client.operations['sync.backend-handle-list']({ workspaceId: 'ws_demo' })
    ).resolves.toMatchObject({
      items: [{ id: 'bwh_wmr_1', materializationRecordId: 'wmr_1' }],
    });
    await expect(
      client.operations['sync.output-manifest-list']({ workspaceId: 'ws_demo' })
    ).resolves.toMatchObject({
      items: [{ id: 'wom_1', materializationRecordId: 'wmr_1' }],
    });
    await expect(
      client.operations['sync.change-set-list']({ workspaceId: 'ws_demo' })
    ).resolves.toEqual({
      items: [workspaceSyncReview().changeSet],
    });
    await expect(
      client.operations['sync.staged-review-list']({ workspaceId: 'ws_demo' })
    ).resolves.toEqual({
      items: [workspaceSyncReview().review],
    });
    await expect(
      client.operations['sync.apply-plan-list']({ workspaceId: 'ws_demo' })
    ).resolves.toMatchObject({
      items: [{ id: 'wap_swr_1', reviewId: 'swr_1' }],
    });
    await expect(
      client.operations['sync.reconciliation-list']({ workspaceId: 'ws_demo' })
    ).resolves.toMatchObject({
      items: [{ id: 'wrr_1', triggerReason: 'restart', stateAfter: 'requires-human' }],
    });
    await expect(
      client.operations['sync.quarantine-list']({ workspaceId: 'ws_demo' })
    ).resolves.toMatchObject({
      items: [{ id: 'wqr_1', failureKind: 'digest_mismatch', resolution: 'pending' }],
    });
    await expect(
      client.operations['sync.apply-result-list']({ workspaceId: 'ws_demo' })
    ).resolves.toEqual({
      items: [workspaceApplyResult()],
    });
    await expect(
      client.operations['sync.apply-result-read']({
        workspaceId: 'ws_demo',
        applyResultId: 'war_swr_1',
      })
    ).resolves.toEqual(workspaceApplyResult());
    await expect(
      client.operations['environment.snapshot-list']({ workspaceId: 'ws_demo' })
    ).resolves.toMatchObject({
      items: [{ snapshotId: 'aepsnap_1' }],
    });
    await expect(
      client.operations['environment.snapshot-read']({
        workspaceId: 'ws_demo',
        snapshotId: 'aepsnap_1',
      })
    ).resolves.toMatchObject({
      snapshotId: 'aepsnap_1',
      snapshot: { snapshotId: 'aepsnap_1' },
    });
    await expect(
      client.operations['thread.items']({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        ...{ since: 4, limit: 10 },
      })
    ).resolves.toEqual({ items: [item], nextCursor: null });

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /api/meta',
      'POST /api/app/operations/workspace.read',
      'POST /api/app/operations/workspace.update',
      'POST /api/app/operations/knowledge.list',
      'POST /api/app/operations/knowledge.create',
      'POST /api/app/operations/knowledge.update',
      'POST /api/app/operations/knowledge.delete',
      'POST /api/app/operations/thread.list',
      'POST /api/app/operations/thread.read',
      'POST /api/app/operations/thread.update',
      'POST /api/app/operations/thread.archive',
      'POST /api/app/operations/turn.read',
      'POST /api/app/operations/turn.interrupt',
      'POST /api/app/operations/artifact.list',
      'POST /api/app/operations/sync.review-list',
      'POST /api/app/operations/sync.review-read',
      'POST /api/app/operations/sync.review-decide',
      'POST /api/app/operations/sync.recovery-decide',
      'POST /api/app/operations/sync.input-snapshot-list',
      'POST /api/app/operations/sync.materialization-list',
      'POST /api/app/operations/sync.backend-handle-list',
      'POST /api/app/operations/sync.output-manifest-list',
      'POST /api/app/operations/sync.change-set-list',
      'POST /api/app/operations/sync.staged-review-list',
      'POST /api/app/operations/sync.apply-plan-list',
      'POST /api/app/operations/sync.reconciliation-list',
      'POST /api/app/operations/sync.quarantine-list',
      'POST /api/app/operations/sync.apply-result-list',
      'POST /api/app/operations/sync.apply-result-read',
      'POST /api/app/operations/environment.snapshot-list',
      'POST /api/app/operations/environment.snapshot-read',
      'POST /api/app/operations/thread.items',
    ]);
    expect(requests[2]?.body).toMatchObject({ status: 'archived' });
    expect(requests[2]?.headers['x-openkit-request-id']).toEqual(expect.any(String));
    expect(requests[6]?.body).toEqual({ workspaceId: 'ws_demo', knowledgeEntryId: 'mem_demo' });
    expect(requests[6]?.headers['x-openkit-request-id']).toEqual(expect.any(String));
  });

  it('derives approval response JSON and request identity from the operation definition', async () => {
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
      'POST /api/app/operations/approval.respond': { body: approval },
    });

    await client.operations['approval.respond']({
      approvalRequestId: 'approval_demo',
      ...{
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        decision: 'granted',
      },
    });

    expect(requests[0]?.body).toMatchObject({
      approvalRequestId: 'approval_demo',
      decision: 'granted',
    });
    expect(requests[0]?.headers['x-openkit-request-id']).toEqual(expect.any(String));
  });

  it('routes derived Artifact operations and the Stage 2 Material app surface', async () => {
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
        'POST /api/app/operations/artifact.import',
        { artifactId: 'artifact_demo', artifactVersion: 1 },
        201,
      ],
      [
        'POST /api/app/operations/artifact.introduce',
        {
          artifactId: 'artifact_demo',
          artifactVersion: 1,
          turnId: 'turn_introduction',
          itemId: 'item_introduction',
        },
        201,
      ],
      ['POST /api/app/operations/material.list', { materials: [material] }, 200],
      ['POST /api/app/operations/material.create', { materialId: 'material_demo' }, 201],
      ['POST /api/app/operations/material.read', { material }, 200],
      ['POST /api/app/operations/material.revision-list', { revisions: [revision] }, 200],
      [
        'POST /api/app/operations/material.revision-save',
        { materialId: 'material_demo', revisionId: 'revision_demo' },
        201,
      ],
      [
        'POST /api/app/operations/material.revision-read',
        { revision: { ...revision, content: '# Demo material' } },
        200,
      ],
      ['POST /api/app/operations/material.thread-read', { material: threadMaterial }, 200],
      [
        'POST /api/app/operations/material.bind',
        { materialId: 'material_demo', threadId: 'th_demo', outcome: 'bound' },
        200,
      ],
      [
        'POST /api/app/operations/material.unbind',
        { materialId: 'material_demo', threadId: 'th_demo', outcome: 'unbound' },
        200,
      ],
      [
        'POST /api/app/operations/material.exclude',
        { materialId: 'material_demo', threadId: 'th_demo', outcome: 'excluded' },
        200,
      ],
      [
        'POST /api/app/operations/material.restore',
        { materialId: 'material_demo', threadId: 'th_demo', outcome: 'included' },
        200,
      ],
    ] as const;
    const { client, requests } = createFakeClient(
      Object.fromEntries(routeCases.map(([path, body, status]) => [path, { body, status }]))
    );

    const responses = [
      await client.operations['artifact.import']({
        workspaceId: 'ws_demo',
        ...{
          title: 'Imported artifact',
          mediaType: 'text/markdown',
          contentDigest,
          content: '# Imported artifact',
        },
      }),
      await client.operations['artifact.introduce']({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        artifactId: 'artifact_demo',
        ...{
          expectedArtifactVersion: 1,
        },
      }),
      await client.operations['material.list']({ workspaceId: 'ws_demo' }),
      await client.operations['material.create']({
        workspaceId: 'ws_demo',
        title: 'Demo material',
        kind: 'markdown',
        sensitivity: 'internal',
      }),
      await client.operations['material.read']({
        workspaceId: 'ws_demo',
        materialId: 'material_demo',
      }),
      await client.operations['material.revision-list']({
        workspaceId: 'ws_demo',
        materialId: 'material_demo',
      }),
      await client.operations['material.revision-save']({
        workspaceId: 'ws_demo',
        materialId: 'material_demo',
        expectedRevisionId: null,
        contentDigest,
        content: '# Demo material',
      }),
      await client.operations['material.revision-read']({
        workspaceId: 'ws_demo',
        materialId: 'material_demo',
        revisionId: 'revision_demo',
      }),
      await client.operations['material.thread-read']({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
      }),
      await client.operations['material.bind']({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        materialId: 'material_demo',
        expectedBindingState: 'not_bound',
      }),
      await client.operations['material.unbind']({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        materialId: 'material_demo',
        expectedBindingState: 'bound',
      }),
      await client.operations['material.exclude']({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        materialId: 'material_demo',
        expectedBindingState: 'bound',
        expectedInclusionState: 'included',
        expectedQueuedRevisionId: 'revision_demo',
      }),
      await client.operations['material.restore']({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        materialId: 'material_demo',
        expectedBindingState: 'bound',
        expectedInclusionState: 'excluded',
      }),
    ];

    expect(requests.slice(0, 2).map(({ headers }) => headers['x-openkit-request-id'])).toEqual([
      expect.any(String),
      expect.any(String),
    ]);
    expect(responses).toEqual(routeCases.map(([, body]) => body));
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual(
      routeCases.map(([path]) => path)
    );
    expect(requests.map(({ body }) => body)).toEqual([
      {
        workspaceId: 'ws_demo',
        title: 'Imported artifact',
        mediaType: 'text/markdown',
        contentDigest,
        content: '# Imported artifact',
      },
      {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        artifactId: 'artifact_demo',
        expectedArtifactVersion: 1,
      },
      { workspaceId: 'ws_demo' },
      { workspaceId: 'ws_demo', title: 'Demo material', kind: 'markdown', sensitivity: 'internal' },
      { workspaceId: 'ws_demo', materialId: 'material_demo' },
      { workspaceId: 'ws_demo', materialId: 'material_demo' },
      {
        workspaceId: 'ws_demo',
        materialId: 'material_demo',
        expectedRevisionId: null,
        contentDigest,
        content: '# Demo material',
      },
      { workspaceId: 'ws_demo', materialId: 'material_demo', revisionId: 'revision_demo' },
      { workspaceId: 'ws_demo', threadId: 'th_demo' },
      {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        materialId: 'material_demo',
        expectedBindingState: 'not_bound',
      },
      {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        materialId: 'material_demo',
        expectedBindingState: 'bound',
      },
      {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        materialId: 'material_demo',
        expectedBindingState: 'bound',
        expectedInclusionState: 'included',
        expectedQueuedRevisionId: 'revision_demo',
      },
      {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        materialId: 'material_demo',
        expectedBindingState: 'bound',
        expectedInclusionState: 'excluded',
      },
    ]);
  });

  it('routes Artifact Review through derived operations', async () => {
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
      'POST /api/app/operations/artifact.review-list': {
        body: { reviews: [review] },
      },
      'POST /api/app/operations/artifact.review.decide': {
        body: decision,
      },
    });

    await expect(
      client.operations['artifact.review-list']({
        workspaceId: 'ws_demo',
        artifactId: 'artifact_demo',
      })
    ).resolves.toEqual({
      reviews: [review],
    });
    await expect(
      client.operations['artifact.review.decide']({
        workspaceId: 'ws_demo',
        artifactId: 'artifact_demo',
        artifactVersion: 1,
        ...{
          decision: 'accepted',
        },
      })
    ).resolves.toEqual(decision);
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /api/app/operations/artifact.review-list',
      'POST /api/app/operations/artifact.review.decide',
    ]);
    expect(requests[1]?.headers['x-openkit-request-id']).toEqual(expect.any(String));
    expect(requests[1]?.body).toEqual({
      workspaceId: 'ws_demo',
      artifactId: 'artifact_demo',
      artifactVersion: 1,
      decision: 'accepted',
    });
  });

  it('routes the exact closed Workspace lifecycle surface through client.operations', async () => {
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
        body: {},
        invoke: (client) => client.operations['workspace.list']({}),
        methodPath: 'POST /api/app/operations/workspace.list',
        response: { items: [summary] },
      },
      {
        body: { workspaceId: 'ws_demo' },
        invoke: (client) => client.operations['workspace.member-list']({ workspaceId: 'ws_demo' }),
        methodPath: 'POST /api/app/operations/workspace.member-list',
        response: { items: [member] },
      },
      {
        body: { workspaceId: 'ws_demo' },
        invoke: (client) =>
          client.operations['workspace.invitation-list']({ workspaceId: 'ws_demo' }),
        methodPath: 'POST /api/app/operations/workspace.invitation-list',
        response: { items: [invitation] },
      },
      {
        body: {
          workspaceId: 'ws_demo',
          inviteeEmail: 'invitee@example.com',
          proposedAccessLevel: 'editor',
        },
        invoke: (client) =>
          client.operations['workspace.invitation-create']({
            workspaceId: 'ws_demo',
            ...{
              inviteeEmail: 'invitee@example.com',
              proposedAccessLevel: 'editor',
              requestId,
            },
          }),
        methodPath: 'POST /api/app/operations/workspace.invitation-create',
        response: { invitation },
        status: 201,
      },
      {
        body: {},
        invoke: (client) => client.operations['workspace.my-invitation-list']({}),
        methodPath: 'POST /api/app/operations/workspace.my-invitation-list',
        response: { items: [invitation] },
      },
      {
        body: { invitationId: 'invitation_1', expectedRevision: 1 },
        invoke: (client) =>
          client.operations['workspace.my-invitation-accept']({
            invitationId: 'invitation_1',
            ...{
              expectedRevision: 1,
              requestId,
            },
          }),
        methodPath: 'POST /api/app/operations/workspace.my-invitation-accept',
        response: { invitation },
      },
      {
        body: { invitationId: 'invitation_1', expectedRevision: 1 },
        invoke: (client) =>
          client.operations['workspace.my-invitation-decline']({
            invitationId: 'invitation_1',
            ...{
              expectedRevision: 1,
              requestId,
            },
          }),
        methodPath: 'POST /api/app/operations/workspace.my-invitation-decline',
        response: { invitation },
      },
      {
        body: { workspaceId: 'ws_demo', invitationId: 'invitation_1', expectedRevision: 1 },
        invoke: (client) =>
          client.operations['workspace.invitation-revoke']({
            workspaceId: 'ws_demo',
            invitationId: 'invitation_1',
            ...{
              expectedRevision: 1,
              requestId,
            },
          }),
        methodPath: 'POST /api/app/operations/workspace.invitation-revoke',
        response: { invitation },
      },
      {
        body: {
          workspaceId: 'ws_demo',
          targetUserId: 'user_2',
          accessLevel: 'viewer',
          expectedRevision: 1,
        },
        invoke: (client) =>
          client.operations['workspace.member-access-change']({
            workspaceId: 'ws_demo',
            targetUserId: 'user_2',
            ...{
              accessLevel: 'viewer',
              expectedRevision: 1,
              requestId,
            },
          }),
        methodPath: 'POST /api/app/operations/workspace.member-access-change',
        response: { member },
      },
      {
        body: { workspaceId: 'ws_demo', targetUserId: 'user_2', expectedRevision: 1 },
        invoke: (client) =>
          client.operations['workspace.member-remove']({
            workspaceId: 'ws_demo',
            targetUserId: 'user_2',
            ...{
              expectedRevision: 1,
              requestId,
            },
          }),
        methodPath: 'POST /api/app/operations/workspace.member-remove',
        response: { member: removedMember },
      },
      {
        body: { workspaceId: 'ws_demo', expectedRevision: 1 },
        invoke: (client) =>
          client.operations['workspace.leave']({
            workspaceId: 'ws_demo',
            ...{ expectedRevision: 1, requestId },
          }),
        methodPath: 'POST /api/app/operations/workspace.leave',
        response: { member: removedMember },
      },
      {
        body: { workspaceId: 'ws_demo', expectedRegistryRevision: 1, targetUserId: 'user_2' },
        invoke: (client) =>
          client.operations['workspace.ownership-transfer']({
            workspaceId: 'ws_demo',
            ...{
              expectedRegistryRevision: 1,
              requestId,
              targetUserId: 'user_2',
            },
          }),
        methodPath: 'POST /api/app/operations/workspace.ownership-transfer',
        response: { workspace: summary },
      },
      {
        body: { workspaceId: 'ws_demo' },
        invoke: (client) =>
          client.operations['workspace.access-recovery-read']({ workspaceId: 'ws_demo' }),
        methodPath: 'POST /api/app/operations/workspace.access-recovery-read',
        response: { recovery },
      },
      {
        body: { workspaceId: 'ws_demo', action: 'add-self-as-editor', expectedRegistryRevision: 1 },
        invoke: (client) =>
          client.operations['workspace.access-recover']({
            workspaceId: 'ws_demo',
            ...{
              action: 'add-self-as-editor',
              expectedRegistryRevision: 1,
              requestId,
            },
          }),
        methodPath: 'POST /api/app/operations/workspace.access-recover',
        response: { recovery },
      },
      {
        body: { targetUserId: 'user_2' },
        invoke: (client) =>
          client.operations['user.disable']({ targetUserId: 'user_2', ...{ requestId } }),
        methodPath: 'POST /api/app/operations/user.disable',
        response: { user },
      },
      {
        body: {
          workspaceId: 'ws_demo',
          confirmation: 'permanently-delete-workspace:ws_demo:1',
          expectedRegistryRevision: 1,
        },
        invoke: (client) =>
          client.operations['workspace.delete']({
            workspaceId: 'ws_demo',
            ...{
              confirmation: 'permanently-delete-workspace:ws_demo:1',
              expectedRegistryRevision: 1,
              requestId,
            },
          }),
        methodPath: 'POST /api/app/operations/workspace.delete',
        response: workspaceDeletionResponse(),
        status: 202,
      },
      {
        body: { workspaceId: 'ws_demo', deletionRequestId: '00000000-0000-4000-8000-000000000002' },
        invoke: (client) =>
          client.operations['workspace.deleted-recover']({
            workspaceId: 'ws_demo',
            ...{
              deletionRequestId: '00000000-0000-4000-8000-000000000002',
              requestId,
            },
          }),
        methodPath: 'POST /api/app/operations/workspace.deleted-recover',
        response: deletedWorkspaceRecoveryResponse(),
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

  it('reads retained release kind annotations without admitting commit-only update observations', async () => {
    const status = appUpdateStatus();
    const { client } = createFakeClient({
      'POST /api/app/operations/app-update.status': {
        body: { ...status, source: { ...status.source, kind: 'release' } },
      },
    });
    await expect(
      client.operations['app-update.status']({ requestId: status.requestId })
    ).resolves.toEqual(status);
    const invalid = createFakeClient({
      'POST /api/app/operations/app-update.status': {
        body: { ...status, source: { kind: 'commit', sourceCommit: status.source.sourceCommit } },
      },
    });
    await expect(
      invalid.client.operations['app-update.status']({ requestId: status.requestId })
    ).rejects.toThrow();
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
      'schema_version: "openkit-workspace-knowledge-schema-v2"',
      'openkit_status: "active"',
      'status: "stable"',
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
      'POST /api/app/operations/diagnostics.app': { body: appDiagnostics() },
      'POST /api/app/operations/storage.layout-report': { body: storageLayoutReport() },
      'POST /api/app/operations/backup.create': { body: dataRootBackupResponse() },
      'POST /api/app/operations/app-update.prepare': { body: appUpdatePrepared() },
      'POST /api/app/operations/app-update.start': { body: appUpdateStatus() },
      'POST /api/app/operations/app-update.status': { body: appUpdateStatus() },
      'POST /api/app/operations/bootstrap.consume': {
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
      'POST /api/app/operations/backup.verify': { body: dataRootBackupResponse() },
      'POST /api/app/operations/workspace.export': { body: workspaceExportResponse() },
      'POST /api/app/operations/workspace.import-dry-run': {
        body: workspaceImportDryRunResponse(),
      },
      'POST /api/app/operations/workspace.import': { body: workspaceImportResponse() },
      'POST /api/app/operations/vault.reference-rebind': {
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
      'POST /api/app/operations/vault.reference-list': {
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
      'POST /api/app/operations/vault.grant-list': {
        body: workspaceVaultGrantsResponse(),
      },
      'POST /api/app/operations/vault.injection-plan-list': {
        body: workspaceInjectionPlansResponse(),
      },
      'POST /api/app/operations/vault.injection-receipt-list': {
        body: workspaceInjectionReceiptsResponse(),
      },
      'POST /api/app/operations/vault.use-list': {
        body: workspaceVaultUseRecordsResponse(),
      },
      'POST /api/app/operations/chat.quick': {
        body: {
          id: 'quick_demo',
          status: 'completed',
          workspaceId: 'ws_demo',
          modelId: 'default',
          content: 'Answer',
        },
      },
      'POST /api/app/operations/task.start': {
        body: {
          state: 'running',
          turn: turn(),
          evidence: {
            itemIds: ['it_task_status'],
            artifactIds: [],
          },
        },
      },
      'POST /api/app/operations/conversation.submit': {
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
          originatingWorkspaceId: 'ws_demo',
          originatingThreadId: 'th_demo',
          receivingWorkspaceId: 'ws_demo',
          receivingThreadId: 'th_demo',
          targetRef: 'assistant',
          logicalModelId: null,
        },
      },
      'POST /api/app/operations/knowledge.answer': {
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
      'POST /api/app/operations/knowledge.source.register': {
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
      'POST /api/app/operations/knowledge.source.list': {
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
      'POST /api/app/operations/knowledge.source.read': {
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
      'POST /api/app/operations/knowledge.indexes': {
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
      'POST /api/app/operations/knowledge.observation.record': {
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
      'POST /api/app/operations/knowledge.observation.list': {
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
      'POST /api/app/operations/knowledge.claim.record': {
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
      'POST /api/app/operations/knowledge.claim.list': {
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
      'POST /api/app/operations/knowledge.conflict.record': {
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
      'POST /api/app/operations/knowledge.conflict.list': {
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
      'POST /api/app/operations/knowledge.conflict.resolve': {
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
      'POST /api/app/operations/knowledge.retrieval': {
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
      'POST /api/app/operations/knowledge.context.prepare': {
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
      'POST /api/app/operations/knowledge.proposal.draft': {
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
      'POST /api/app/operations/knowledge.repair.suggest': {
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
      'POST /api/app/operations/knowledge.health.check': {
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
      'POST /api/app/operations/app.search': {
        body: { items: [{ kind: 'workspace', id: 'ws_demo', title: 'Demo' }] },
      },
      'POST /api/app/operations/agent.health-refresh': {
        body: { items: [], sessions: [] },
      },
      'POST /api/app/operations/agent.list': { body: { items: [agent()] } },
      'POST /api/app/operations/agent.read': { body: agent() },
      'POST /api/app/operations/attention.list': { body: { items: [] } },
      'POST /api/app/operations/recovery.worker-list': {
        body: { items: [interruptedWorkerState()] },
      },
      'POST /api/app/operations/recovery.checkpoint-retry': {
        body: {
          outcome: 'released_for_retry',
          turnId: 'turn_worker',
        },
      },
      'POST /api/app/operations/scheduler.retry': {
        body: { retried: true },
      },
      'POST /api/app/operations/scheduler.cancel': {
        body: { cancelled: true },
      },
      'POST /api/app/operations/scheduler.list': {
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
              modelId: null,
              enqueuedAt: timestamp,
              status: 'queued',
              denialReason: null,
              queuePosition: 1,
            },
          ],
        },
      },
      'POST /api/app/operations/usage.read': {
        body: capabilityUsageResponse(),
      },
      'POST /api/app/operations/evidence.bundle-list': {
        body: workspaceEvidenceBundlesResponse(),
      },
      'POST /api/app/operations/evidence.runtime-list': {
        body: workspaceRuntimeEvidenceResponse(),
      },
      'POST /api/app/operations/audit.workspace-list': {
        body: workspaceAuditEventsResponse(),
      },
      'POST /api/app/operations/audit.server-list': {
        body: serverAuditEventsResponse(),
      },
      'POST /api/app/operations/permission.workspace-list': {
        body: workspacePermissionDecisionsResponse(),
      },
      'POST /api/app/operations/permission.server-list': {
        body: serverPermissionDecisionsResponse(),
      },
      'POST /api/app/operations/vault.server-use-list': {
        body: serverVaultUseRecordsResponse(),
      },
    });

    await expect(client.operations['diagnostics.app']({})).resolves.toEqual(appDiagnostics());
    await expect(client.operations['storage.layout-report']({})).resolves.toEqual(
      storageLayoutReport()
    );
    await expect(client.operations['backup.create']({})).resolves.toEqual(dataRootBackupResponse());
    await expect(
      client.operations['app-update.prepare']({
        expectedCurrentImageId: `sha256:${'b'.repeat(64)}`,
        source: {
          appDigest: `sha256:${'b'.repeat(64)}`,
          sourceCommit: 'a'.repeat(40),
          tag: 'v0.1.0',
        },
      })
    ).resolves.toEqual(appUpdatePrepared());
    await expect(
      client.operations['app-update.start']({
        maintenanceConsent: true,
        requestId: '11111111-1111-4111-8111-111111111111',
      })
    ).resolves.toEqual(appUpdateStatus());
    await expect(
      client.operations['app-update.status']({ requestId: '11111111-1111-4111-8111-111111111111' })
    ).resolves.toEqual(appUpdateStatus());
    await expect(
      client.operations['bootstrap.consume']({
        displayName: 'Owner',
        email: 'owner@example.com',
        ownerUserId: 'user_owner',
        password: 'password123456',
        token: 'okt_bootstrap_secret',
        tokenExpiresAt: timestamp,
      })
    ).resolves.toMatchObject({
      token: 'okt_owner_secret',
      record: { ownerUserId: 'user_owner', scope: 'server-admin' },
    });
    await expect(client.operations['backup.verify']({ backupId: 'drb_demo' })).resolves.toEqual(
      dataRootBackupResponse()
    );
    await expect(
      client.operations['workspace.export']({ workspaceId: 'ws_demo' })
    ).resolves.toEqual(workspaceExportResponse());
    await expect(
      client.operations['workspace.import-dry-run']({
        sourceWorkspaceId: 'ws_demo',
        exportId: 'wsexp_demo',
      })
    ).resolves.toEqual(workspaceImportDryRunResponse());
    await expect(
      client.operations['workspace.import']({
        sourceWorkspaceId: 'ws_demo',
        exportId: 'wsexp_demo',
        requestId: 'req_import',
      })
    ).resolves.toEqual(workspaceImportResponse());
    expect(
      requests.find(({ path }) => path === '/api/app/operations/workspace.export')?.body
    ).toEqual({ workspaceId: 'ws_demo' });
    const importRequest = requests.find(
      ({ path }) => path === '/api/app/operations/workspace.import'
    );
    expect(importRequest?.headers['x-openkit-request-id']).toBe('req_import');
    expect(importRequest?.body).toEqual({ sourceWorkspaceId: 'ws_demo', exportId: 'wsexp_demo' });
    await expect(
      client.operations['vault.reference-rebind']({
        workspaceId: 'ws_demo',
        referenceId: 'vault_imported',
        ...{
          materialBase64: Buffer.from('workspace-secret').toString('base64'),
        },
      })
    ).resolves.toMatchObject({
      referenceId: 'vault_imported',
      status: 'active',
    });
    await expect(
      client.operations['vault.reference-list']({ workspaceId: 'ws_demo' })
    ).resolves.toMatchObject({
      items: [{ referenceId: 'vault_imported', status: 'unbound' }],
      workspaceId: 'ws_demo',
    });
    await expect(
      client.operations['vault.grant-list']({ workspaceId: 'ws_demo' })
    ).resolves.toEqual(workspaceVaultGrantsResponse());
    await expect(
      client.operations['vault.injection-plan-list']({ workspaceId: 'ws_demo' })
    ).resolves.toEqual(workspaceInjectionPlansResponse());
    await expect(
      client.operations['vault.injection-receipt-list']({ workspaceId: 'ws_demo' })
    ).resolves.toEqual(workspaceInjectionReceiptsResponse());
    await expect(client.operations['vault.use-list']({ workspaceId: 'ws_demo' })).resolves.toEqual(
      workspaceVaultUseRecordsResponse()
    );
    await expect(client.operations['vault.server-use-list']({})).resolves.toEqual(
      serverVaultUseRecordsResponse()
    );
    await expect(client.operations['usage.read']({ workspaceId: 'ws_demo' })).resolves.toEqual(
      capabilityUsageResponse()
    );
    await expect(
      client.operations['evidence.bundle-list']({ workspaceId: 'ws_demo' })
    ).resolves.toEqual(workspaceEvidenceBundlesResponse());
    await expect(
      client.operations['evidence.runtime-list']({ workspaceId: 'ws_demo' })
    ).resolves.toEqual(workspaceRuntimeEvidenceResponse());
    await expect(
      client.operations['audit.workspace-list']({ workspaceId: 'ws_demo' })
    ).resolves.toEqual(workspaceAuditEventsResponse());
    await expect(client.operations['audit.server-list']({})).resolves.toEqual(
      serverAuditEventsResponse()
    );
    await expect(
      client.operations['permission.workspace-list']({ workspaceId: 'ws_demo' })
    ).resolves.toEqual(workspacePermissionDecisionsResponse());
    await expect(client.operations['permission.server-list']({})).resolves.toEqual(
      serverPermissionDecisionsResponse()
    );
    await expect(client.operations['chat.quick']({ input: 'Hi' })).resolves.toMatchObject({
      content: 'Answer',
      status: 'completed',
    });
    await expect(
      client.operations['task.start']({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        ...{ input: 'Implement the focused fix.' },
      })
    ).resolves.toMatchObject({
      state: 'running',
    });
    await expect(
      client.operations['conversation.submit']({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        ...{
          input: 'What is OpenKit?',
          targetRef: 'assistant',
          artifactRefs: [],
        },
      })
    ).resolves.toMatchObject({
      outcome: 'answered',
      item: { type: 'assistant-message', text: 'Answer' },
    });
    await expect(
      client.operations['knowledge.answer']({
        workspaceId: 'ws_demo',
        ...{ query: 'release cadence' },
      })
    ).resolves.toMatchObject({
      outcome: 'answered',
      retrievalTraceId,
      citations: [{ knowledgeEntryId: 'mem_demo' }],
    });
    await expect(
      client.operations['knowledge.source.register']({
        workspaceId: 'ws_demo',
        ...{
          requestId: 'req_source',
          kind: 'document',
          title: 'Release notes',
          uri: 'file://release.md',
          content: 'Release cadence is weekly.',
          originatingThreadId: 'th_demo',
        },
      })
    ).resolves.toMatchObject({
      source: { id: 'ks_demo', title: 'Release notes' },
      derivedRepresentations: [{ sourceId: 'ks_demo', kind: 'text' }],
    });
    await expect(
      client.operations['knowledge.source.list']({ workspaceId: 'ws_demo' })
    ).resolves.toMatchObject({
      items: [{ id: 'ks_demo', title: 'Release notes' }],
    });
    await expect(
      client.operations['knowledge.source.read']({ workspaceId: 'ws_demo', sourceId: 'ks_demo' })
    ).resolves.toMatchObject({
      source: { id: 'ks_demo', title: 'Release notes' },
      derivedRepresentations: [{ sourceId: 'ks_demo', kind: 'text' }],
    });
    await expect(
      client.operations['knowledge.indexes']({ workspaceId: 'ws_demo' })
    ).resolves.toMatchObject({
      linkGraph: { edges: [{ fromId: 'alpha', resolved: true }] },
      validation: { records: [{ conceptId: 'alpha', indexed: true }] },
      sourceReferences: { references: [{ reference: 'source:ks_demo', resolved: true }] },
      fullText: { tokenizer: 'unicode-simple-v1', terms: [{ term: 'alpha' }] },
    });
    await expect(
      client.operations['knowledge.observation.record']({
        workspaceId: 'ws_demo',
        ...{
          requestId: 'req_observation',
          kind: 'retrieval',
          summary: 'Worker repeatedly needed release cadence context.',
          sourceReferences: ['knowledge:kn_demo', 'source:ks_demo'],
          producer: 'knowledge-manager',
          confidence: 0.75,
        },
      })
    ).resolves.toMatchObject({
      observation: { id: 'ko_demo', kind: 'retrieval', status: 'retained' },
    });
    await expect(
      client.operations['knowledge.observation.list']({ workspaceId: 'ws_demo' })
    ).resolves.toMatchObject({
      items: [{ id: 'ko_demo', kind: 'retrieval' }],
    });
    await expect(
      client.operations['knowledge.claim.record']({
        workspaceId: 'ws_demo',
        ...{
          requestId: 'req_claim',
          statement: 'Release cadence is weekly.',
          sourceReferences: ['knowledge:release-plan', 'source:ks_release'],
          producer: 'knowledge-manager',
          confidence: 0.8,
        },
      })
    ).resolves.toMatchObject({
      claim: { id: 'kc_demo', statement: 'Release cadence is weekly.' },
    });
    await expect(
      client.operations['knowledge.claim.list']({ workspaceId: 'ws_demo' })
    ).resolves.toMatchObject({
      items: [{ id: 'kc_demo', statement: 'Release cadence is weekly.' }],
    });
    await expect(
      client.operations['knowledge.conflict.record']({
        workspaceId: 'ws_demo',
        ...{
          requestId: 'req_conflict',
          subjectReferences: ['knowledge:release-plan', 'claim:kc_release'],
          sourceReferences: ['source:ks_release', 'source:ks_correction'],
          summary: 'Release cadence has contradictory source evidence.',
          producer: 'knowledge-manager',
        },
      })
    ).resolves.toMatchObject({
      conflict: { id: 'kf_demo', status: 'conflicting' },
    });
    await expect(
      client.operations['knowledge.conflict.list']({ workspaceId: 'ws_demo' })
    ).resolves.toMatchObject({
      items: [{ id: 'kf_demo', status: 'conflicting' }],
    });
    await expect(
      client.operations['knowledge.conflict.resolve']({
        workspaceId: 'ws_demo',
        conflictId: 'kf_demo',
        ...{
          requestId: 'req_resolve_conflict',
          resolution: 'Friday release reviews are authoritative.',
          resolvedBy: 'knowledge-manager',
        },
      })
    ).resolves.toMatchObject({
      conflict: { id: 'kf_demo', status: 'resolved' },
    });
    await expect(
      client.operations['knowledge.retrieval']({
        workspaceId: 'ws_demo',
        ...{ query: 'release cadence', limit: 1 },
      })
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
      client.operations['knowledge.context.prepare']({
        workspaceId: 'ws_demo',
        ...{
          query: 'release cadence',
          limit: 1,
        },
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
      client.operations['knowledge.proposal.draft']({
        workspaceId: 'ws_demo',
        ...{
          requestId: '00000000-0000-4000-8000-000000000621',
          knowledgePageId: 'lessons/release-review',
          canonicalPageBytes: proposalPageBytes,
          contentDigest: proposalPageDigest,
          sourceReferences: [proposalSourceReference],
          rationale: 'This evidence supports one reusable release-review rule.',
          confidence: 0.75,
        },
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
    await expect(
      client.operations['knowledge.repair.suggest']({ workspaceId: 'ws_demo', ...{} })
    ).resolves.toMatchObject({
      operation: 'suggest-repair',
      suggestions: [{ kind: 'duplicate-title' }],
    });
    await expect(
      client.operations['knowledge.health.check']({ workspaceId: 'ws_demo', ...{} })
    ).resolves.toMatchObject({
      operation: 'health-check',
      outcome: 'needs-attention',
      repairSuggestions: [{ kind: 'duplicate-title' }],
    });
    for (const path of [
      '/api/app/operations/knowledge.answer',
      '/api/app/operations/knowledge.context.prepare',
      '/api/app/operations/knowledge.proposal.draft',
      '/api/app/operations/knowledge.repair.suggest',
      '/api/app/operations/knowledge.health.check',
      '/api/app/operations/knowledge.source.register',
    ]) {
      expect(requests.find((request) => request.path === path)?.body).not.toHaveProperty('caller');
    }
    await expect(client.operations['app.search']({ query: 'protocol design' })).resolves.toEqual({
      items: [{ kind: 'workspace', id: 'ws_demo', title: 'Demo' }],
    });
    await expect(
      client.operations['agent.health-refresh']({ workspaceId: 'ws_demo' })
    ).resolves.not.toHaveProperty('sessions');
    await expect(client.operations['agent.list']({})).resolves.toEqual({ items: [agent()] });
    await expect(client.operations['agent.read']({ agentId: 'agent_demo' })).resolves.toEqual(
      agent()
    );
    await expect(client.operations['attention.list']({ workspaceId: 'ws_demo' })).resolves.toEqual({
      items: [],
    });
    await expect(client.operations['recovery.worker-list']({})).resolves.toEqual({
      items: [interruptedWorkerState()],
    });
    expect(client.app).not.toHaveProperty('listRecoveryPendingUserTurns');
    expect(client.app).not.toHaveProperty('cancelRecoveryPendingUserTurn');
    expect(client.app).not.toHaveProperty('convertRecoveryPendingUserTurnToFollowUp');
    expect(client.app).not.toHaveProperty('editRecoveryPendingUserTurn');
    expect(client.app).not.toHaveProperty('promoteRecoveryPendingUserTurnToInterrupt');
    await expect(
      client.operations['recovery.checkpoint-retry']({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_worker',
        requestId: 'req_worker_retry',
      })
    ).resolves.toEqual({
      outcome: 'released_for_retry',
      turnId: 'turn_worker',
    });
    expect(
      requests.find((request) => request.path === '/api/app/operations/recovery.checkpoint-retry')
        ?.body
    ).toEqual({ workspaceId: 'ws_demo', threadId: 'th_demo', turnId: 'turn_worker' });
    expect(
      requests.find((request) => request.path === '/api/app/operations/recovery.checkpoint-retry')
        ?.headers['x-openkit-request-id']
    ).toBe('req_worker_retry');
    await expect(
      client.operations['scheduler.retry']({ workspaceId: 'ws_demo', queueEntryId: 'queue_denied' })
    ).resolves.toEqual({
      retried: true,
    });
    await expect(
      client.operations['scheduler.cancel']({
        workspaceId: 'ws_demo',
        queueEntryId: 'queue_queued',
      })
    ).resolves.toEqual({
      cancelled: true,
    });
    await expect(
      client.operations['scheduler.list']({ workspaceId: 'ws_demo' })
    ).resolves.toMatchObject({
      items: [{ queueEntryId: 'queue_1', queuePosition: 1 }],
    });

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /api/app/operations/diagnostics.app',
      'POST /api/app/operations/storage.layout-report',
      'POST /api/app/operations/backup.create',
      'POST /api/app/operations/app-update.prepare',
      'POST /api/app/operations/app-update.start',
      'POST /api/app/operations/app-update.status',
      'POST /api/app/operations/bootstrap.consume',
      'POST /api/app/operations/backup.verify',
      'POST /api/app/operations/workspace.export',
      'POST /api/app/operations/workspace.import-dry-run',
      'POST /api/app/operations/workspace.import',
      'POST /api/app/operations/vault.reference-rebind',
      'POST /api/app/operations/vault.reference-list',
      'POST /api/app/operations/vault.grant-list',
      'POST /api/app/operations/vault.injection-plan-list',
      'POST /api/app/operations/vault.injection-receipt-list',
      'POST /api/app/operations/vault.use-list',
      'POST /api/app/operations/vault.server-use-list',
      'POST /api/app/operations/usage.read',
      'POST /api/app/operations/evidence.bundle-list',
      'POST /api/app/operations/evidence.runtime-list',
      'POST /api/app/operations/audit.workspace-list',
      'POST /api/app/operations/audit.server-list',
      'POST /api/app/operations/permission.workspace-list',
      'POST /api/app/operations/permission.server-list',
      'POST /api/app/operations/chat.quick',
      'POST /api/app/operations/task.start',
      'POST /api/app/operations/conversation.submit',
      'POST /api/app/operations/knowledge.answer',
      'POST /api/app/operations/knowledge.source.register',
      'POST /api/app/operations/knowledge.source.list',
      'POST /api/app/operations/knowledge.source.read',
      'POST /api/app/operations/knowledge.indexes',
      'POST /api/app/operations/knowledge.observation.record',
      'POST /api/app/operations/knowledge.observation.list',
      'POST /api/app/operations/knowledge.claim.record',
      'POST /api/app/operations/knowledge.claim.list',
      'POST /api/app/operations/knowledge.conflict.record',
      'POST /api/app/operations/knowledge.conflict.list',
      'POST /api/app/operations/knowledge.conflict.resolve',
      'POST /api/app/operations/knowledge.retrieval',
      'POST /api/app/operations/knowledge.context.prepare',
      'POST /api/app/operations/knowledge.proposal.draft',
      'POST /api/app/operations/knowledge.repair.suggest',
      'POST /api/app/operations/knowledge.health.check',
      'POST /api/app/operations/app.search',
      'POST /api/app/operations/agent.health-refresh',
      'POST /api/app/operations/agent.list',
      'POST /api/app/operations/agent.read',
      'POST /api/app/operations/attention.list',
      'POST /api/app/operations/recovery.worker-list',
      'POST /api/app/operations/recovery.checkpoint-retry',
      'POST /api/app/operations/scheduler.retry',
      'POST /api/app/operations/scheduler.cancel',
      'POST /api/app/operations/scheduler.list',
    ]);
    expect(requests[6]?.body).toEqual({
      displayName: 'Owner',
      email: 'owner@example.com',
      ownerUserId: 'user_owner',
      password: 'password123456',
      token: 'okt_bootstrap_secret',
      tokenExpiresAt: timestamp,
    });
    expect(requests[11]?.body).toEqual({
      workspaceId: 'ws_demo',
      referenceId: 'vault_imported',
      materialBase64: Buffer.from('workspace-secret').toString('base64'),
    });
    expect(requests.at(-6)?.body).toEqual({ workspaceId: 'ws_demo' });
    expect(requests.at(-5)?.body).toEqual({});
    expect(requests.at(-4)?.body).toEqual({
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'turn_worker',
    });
    expect(requests.at(-3)?.body).toEqual({ workspaceId: 'ws_demo', queueEntryId: 'queue_denied' });
    expect(requests.at(-2)?.body).toEqual({ workspaceId: 'ws_demo', queueEntryId: 'queue_queued' });
    expect(requests.at(-1)?.body).toEqual({ workspaceId: 'ws_demo' });
  });

  it('routes OpenKit access-token administration through canonical operation schemas', async () => {
    const { client, requests } = createFakeClient({
      'POST /api/app/operations/token.list': { body: { items: [accessTokenRecord()] } },
      'POST /api/app/operations/token.create': {
        body: { token: 'okt_workspace_secret', record: accessTokenRecord() },
        status: 201,
      },
      'POST /api/app/operations/token.revoke': {
        body: { record: accessTokenRecord({ status: 'revoked', revokedAt: timestamp }) },
      },
      'POST /api/app/operations/token.rotate': {
        body: {
          token: 'okt_rotated_secret',
          record: accessTokenRecord({ status: 'rotated', rotatedGraceExpiresAt: timestamp }),
          rotatedRecord: accessTokenRecord({
            predecessorTokenId: 'tok_workspace',
            tokenId: 'tok_rotated',
          }),
        },
      },
      'POST /api/app/operations/token.my-admin-list': {
        body: {
          defaultTokenId: 'tok_admin',
          items: [
            accessTokenRecord({ tokenId: 'tok_admin', scope: 'server-admin', workspaceIds: [] }),
          ],
        },
      },
      'POST /api/app/operations/token.my-admin-default': {
        body: {
          defaultTokenId: 'tok_admin',
          items: [
            accessTokenRecord({ tokenId: 'tok_admin', scope: 'server-admin', workspaceIds: [] }),
          ],
        },
      },
    });

    await expect(client.operations['token.list']({})).resolves.toMatchObject({
      items: [{ tokenId: 'tok_workspace', workspaceIds: ['ws_demo'] }],
    });
    await expect(
      client.operations['token.create']({
        expiresAt: timestamp,
        scope: 'workspace',
        workspaceIds: ['ws_demo'],
      })
    ).resolves.toMatchObject({
      token: 'okt_workspace_secret',
      record: { tokenId: 'tok_workspace' },
    });
    await expect(
      client.operations['token.revoke']({ tokenId: 'tok_workspace' })
    ).resolves.toMatchObject({
      record: { status: 'revoked' },
    });
    await expect(
      client.operations['token.rotate']({ tokenId: 'tok_workspace', ...{ graceSeconds: 60 } })
    ).resolves.toMatchObject({
      token: 'okt_rotated_secret',
      rotatedRecord: { predecessorTokenId: 'tok_workspace' },
    });
    await expect(client.operations['token.my-admin-list']({})).resolves.toMatchObject({
      defaultTokenId: 'tok_admin',
      items: [{ tokenId: 'tok_admin', scope: 'server-admin' }],
    });
    await expect(
      client.operations['token.my-admin-default']({ tokenId: 'tok_admin' })
    ).resolves.toMatchObject({
      defaultTokenId: 'tok_admin',
    });

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /api/app/operations/token.list',
      'POST /api/app/operations/token.create',
      'POST /api/app/operations/token.revoke',
      'POST /api/app/operations/token.rotate',
      'POST /api/app/operations/token.my-admin-list',
      'POST /api/app/operations/token.my-admin-default',
    ]);
    expect(requests[1]?.body).toEqual({
      expiresAt: timestamp,
      scope: 'workspace',
      workspaceIds: ['ws_demo'],
    });
    expect(requests[3]?.body).toEqual({ tokenId: 'tok_workspace', graceSeconds: 60 });
  });

  it('routes vault admin operations through app-owned schemas', async () => {
    const authJsonBase64 = Buffer.from('{"tokens":{"openai":"secret"}}').toString('base64');
    const masterKeyBase64 = Buffer.alloc(32, 1).toString('base64');
    const { client, requests } = createFakeClient({
      'POST /api/app/operations/vault.status': { body: vaultAdminStatus('locked') },
      'POST /api/app/operations/vault.unlock': { body: vaultAdminStatus('available') },
      'POST /api/app/operations/vault.lock': { body: vaultAdminStatus('locked') },
      'POST /api/app/operations/vault.bootstrap-codex-auth': {
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
      'POST /api/app/operations/vault.provider-api-key-set': {
        body: { configured: true, providerId: 'xai-api' },
      },
    });

    await expect(client.operations['vault.status']({})).resolves.toMatchObject({
      backendKind: 'encrypted-file',
      state: 'locked',
    });
    await expect(
      client.operations['vault.unlock']({ ...{ masterKeyBase64 } })
    ).resolves.toMatchObject({
      state: 'available',
    });
    await expect(client.operations['vault.lock']({})).resolves.toMatchObject({
      state: 'locked',
    });
    await expect(
      client.operations['vault.bootstrap-codex-auth']({ ...{ authJsonBase64 } })
    ).resolves.toMatchObject({
      grantId: 'grant_codex_auth_json',
      referenceId: 'vault_codex_auth_json',
    });
    await expect(
      client.operations['vault.provider-api-key-set']({
        providerId: 'xai-api',
        ...{ apiKey: 'xai-secret' },
      })
    ).resolves.toEqual({ configured: true, providerId: 'xai-api' });

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /api/app/operations/vault.status',
      'POST /api/app/operations/vault.unlock',
      'POST /api/app/operations/vault.lock',
      'POST /api/app/operations/vault.bootstrap-codex-auth',
      'POST /api/app/operations/vault.provider-api-key-set',
    ]);
    expect(requests[1]?.body).toEqual({ masterKeyBase64 });
    expect(requests[3]?.body).toEqual({ authJsonBase64 });
    expect(requests[4]?.body).toEqual({ providerId: 'xai-api', apiKey: 'xai-secret' });
  });

  it('rejects an obsolete os-keychain vault response as a protocol violation', async () => {
    const { client } = createFakeClient({
      'POST /api/app/operations/vault.status': {
        body: { ...vaultAdminStatus('available'), backendKind: 'os-keychain' },
      },
    });

    await expect(client.operations['vault.status']({})).rejects.toBeInstanceOf(
      ProtocolValidationError
    );
  });

  it('routes remaining App API and feedback methods through sub-clients', async () => {
    const proposalPageDigest = `sha256:${'e'.repeat(64)}`;
    const proposalDigest = `sha256:${'f'.repeat(64)}`;
    const { client, requests } = createFakeClient({
      'POST /api/app/operations/workspace.dashboard': { body: workspaceDashboard() },
      'POST /api/app/operations/thread.dashboard': { body: threadDashboard() },
      'POST /api/app/operations/knowledge.proposal.decide': {
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
      'POST /api/app/operations/knowledge.proposal.reverse': {
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
      'POST /api/app/operations/diagnostics.setup': { body: setupDiagnostics() },
      'POST /api/app/operations/automation.list': { body: { items: [automation()] } },
      'POST /api/app/operations/automation.create': { body: automation() },
      'POST /api/app/operations/automation.update': {
        body: { ...automation(), status: 'enabled' },
      },
      'POST /api/app/operations/turn.feedback': {
        body: {
          turnId: 'turn_demo',
          agentId: 'agent_demo',
          rating: 'good',
          note: null,
          createdAt: timestamp,
        },
      },
    });

    await expect(
      client.operations['workspace.dashboard']({ workspaceId: 'ws_demo' })
    ).resolves.toEqual(workspaceDashboard());
    const dashboard = await client.operations['thread.dashboard']({
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
    });
    expect(dashboard).not.toHaveProperty('activeSession');
    expect(dashboard.workStatus).toEqual(threadDashboard().workStatus);
    expect(dashboard.taskInputs).toEqual(threadDashboard().taskInputs);
    expect('runThreadGoalTestSuperviseStep' in client.app).toBe(false);
    await expect(
      client.operations['knowledge.proposal.decide']({
        workspaceId: 'ws_demo',
        proposalId: 'kp_demo',
        ...{
          requestId: '00000000-0000-4000-8000-000000000622',
          decision: 'accepted',
        },
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
      client.operations['knowledge.proposal.reverse']({
        workspaceId: 'ws_demo',
        proposalId: 'kp_demo',
        ...{
          requestId: '00000000-0000-4000-8000-000000000623',
          reviewId: 'kr_demo',
          knowledgePageId: 'lessons/release-review',
          expectedContentDigest: proposalPageDigest,
        },
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
    await expect(client.operations['diagnostics.setup']({})).resolves.toEqual(setupDiagnostics());
    await expect(client.operations['automation.list']({})).resolves.toEqual({
      items: [automation()],
    });
    await expect(
      client.operations['automation.create']({
        name: 'Demo automation',
        workspaceId: 'ws_demo',
        cron: '0 9 * * *',
        prompt: 'Summarize status.',
      })
    ).resolves.toEqual(automation());
    await expect(
      client.operations['automation.update']({
        automationId: 'auto_demo',
        status: 'enabled',
      })
    ).resolves.toEqual({
      ...automation(),
      status: 'enabled',
    });
    await expect(
      client.operations['turn.feedback']({ ...{ rating: 'good', note: null }, turnId: 'turn_demo' })
    ).resolves.toMatchObject({ turnId: 'turn_demo', rating: 'good' });
    expect(
      requests.find((request) =>
        request.path.endsWith('/api/app/operations/knowledge.proposal.decide')
      )?.body
    ).toEqual({ workspaceId: 'ws_demo', proposalId: 'kp_demo', decision: 'accepted' });
    expect(
      requests.find((request) =>
        request.path.endsWith('/api/app/operations/knowledge.proposal.reverse')
      )?.body
    ).toEqual({
      workspaceId: 'ws_demo',
      proposalId: 'kp_demo',
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
          quotaCapability: 'available',
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
      availability: 'available',
      observedAt: timestamp,
      planType: 'SuperGrok',
      windows: [
        {
          id: 'included',
          remainingPercent: 57.5,
          resetsAt: timestamp,
          usedPercent: 42.5,
        },
      ],
    };
    const autoTopup = {
      subscriptionProviderId: 'xai',
      accountSlotId: 'team_slot',
      observedAt: timestamp,
      availability: 'available',
      currency: 'USD',
      enabled: false,
      thresholdCents: 100,
      amountCents: 2500,
      monthlyCapCents: 10_000,
    };
    const operations = [
      {
        input: {},
        body: {},
        method: 'provider-subscription.provider-list',
        request: 'POST /api/app/operations/provider-subscription.provider-list',
        response: providers,
        route: { body: providers },
      },
      {
        input: { subscriptionProviderId: 'xai' },
        body: { subscriptionProviderId: 'xai' },
        method: 'provider-subscription.account-list',
        request: 'POST /api/app/operations/provider-subscription.account-list',
        response: { accounts: [loggedInAccount] },
        route: { body: { accounts: [loggedInAccount] } },
      },
      {
        input: {
          subscriptionProviderId: 'xai',
          ...{ accountSlotId: 'team_slot', displayName: 'Team' },
        },
        body: {
          subscriptionProviderId: 'xai',
          ...{ accountSlotId: 'team_slot', displayName: 'Team' },
        },
        method: 'provider-subscription.account-create',
        request: 'POST /api/app/operations/provider-subscription.account-create',
        response: loggedInAccount,
        route: { body: loggedInAccount },
      },
      {
        input: {
          subscriptionProviderId: 'openai-codex',
          accountSlotId: 'default',
          ...{ displayName: 'Default' },
        },
        body: {
          subscriptionProviderId: 'openai-codex',
          accountSlotId: 'default',
          ...{ displayName: 'Default' },
        },
        method: 'provider-subscription.account-update',
        request: 'POST /api/app/operations/provider-subscription.account-update',
        response: loggedOutAccount,
        route: { body: loggedOutAccount },
      },
      {
        input: { subscriptionProviderId: 'openai-codex', accountSlotId: 'default' },
        body: { subscriptionProviderId: 'openai-codex', accountSlotId: 'default' },
        method: 'provider-subscription.account-delete',
        request: 'POST /api/app/operations/provider-subscription.account-delete',
        response: null,
        route: { status: 204 },
      },
      {
        input: { subscriptionProviderId: 'openai-codex', accountSlotId: 'default' },
        body: { subscriptionProviderId: 'openai-codex', accountSlotId: 'default' },
        method: 'provider-subscription.account-status',
        request: 'POST /api/app/operations/provider-subscription.account-status',
        response: loggedOutAccount,
        route: { body: loggedOutAccount },
      },
      {
        input: {
          subscriptionProviderId: 'openai-codex',
          accountSlotId: 'default',
          ...{ mode: 'device_code' },
        },
        body: {
          subscriptionProviderId: 'openai-codex',
          accountSlotId: 'default',
          ...{ mode: 'device_code' },
        },
        method: 'provider-subscription.account-login-start',
        request: 'POST /api/app/operations/provider-subscription.account-login-start',
        response: pendingAccount,
        route: { body: pendingAccount },
      },
      {
        input: {
          subscriptionProviderId: 'openai-codex',
          accountSlotId: 'default',
          ...{ interactionId: 'interaction_demo' },
        },
        body: {
          subscriptionProviderId: 'openai-codex',
          accountSlotId: 'default',
          ...{ interactionId: 'interaction_demo' },
        },
        method: 'provider-subscription.account-login-cancel',
        request: 'POST /api/app/operations/provider-subscription.account-login-cancel',
        response: loggedOutAccount,
        route: { body: loggedOutAccount },
      },
      {
        input: { subscriptionProviderId: 'openai-codex', accountSlotId: 'default' },
        body: { subscriptionProviderId: 'openai-codex', accountSlotId: 'default' },
        method: 'provider-subscription.account-logout',
        request: 'POST /api/app/operations/provider-subscription.account-logout',
        response: loggedOutAccount,
        route: { body: loggedOutAccount },
      },
      {
        input: { subscriptionProviderId: 'xai', accountSlotId: 'team_slot' },
        body: { subscriptionProviderId: 'xai', accountSlotId: 'team_slot' },
        method: 'provider-subscription.account-quota',
        request: 'POST /api/app/operations/provider-subscription.account-quota',
        response: quota,
        route: { body: quota },
      },
      {
        input: { subscriptionProviderId: 'xai', accountSlotId: 'team_slot' },
        body: { subscriptionProviderId: 'xai', accountSlotId: 'team_slot' },
        method: 'provider-subscription.account-auto-topup',
        request: 'POST /api/app/operations/provider-subscription.account-auto-topup',
        response: autoTopup,
        route: { body: autoTopup },
      },
    ] as const;
    const routes = Object.fromEntries(
      operations.map((operation) => [operation.request, operation.route])
    ) as RouteMap;
    const { client, requests } = createFakeClient(routes);
    for (const operation of operations) {
      const method = client.operations[operation.method];
      await expect(Reflect.apply(method, client.operations, [operation.input])).resolves.toEqual(
        operation.response
      );
    }

    await expect(
      client.operations['provider-subscription.account-status']({
        subscriptionProviderId: 'xai/preview',
        accountSlotId: 'slot \uD800/a',
      })
    ).resolves.toEqual(loggedOutAccount);
    await expect(
      client.operations['provider-subscription.account-delete']({
        subscriptionProviderId: 'openai-codex',
        accountSlotId: '\uFEFFdefault',
      })
    ).resolves.toBeNull();

    expect(
      requests.slice(0, operations.length).map((request) => `${request.method} ${request.path}`)
    ).toEqual(operations.map((operation) => operation.request));
    expect(requests.slice(0, operations.length).map((request) => request.body)).toEqual(
      operations.map((operation) => operation.body)
    );
    expect(requests.at(-2)).toMatchObject({
      body: { subscriptionProviderId: 'xai/preview', accountSlotId: 'slot \uD800/a' },
      method: 'POST',
      path: '/api/app/operations/provider-subscription.account-status',
    });
    expect(requests.at(-1)).toMatchObject({
      body: { subscriptionProviderId: 'openai-codex', accountSlotId: '\uFEFFdefault' },
      hasBody: true,
      method: 'POST',
      path: '/api/app/operations/provider-subscription.account-delete',
    });

    const malformedCases = [
      {
        input: {},
        method: 'provider-subscription.provider-list',
        request: 'POST /api/app/operations/provider-subscription.provider-list',
        route: { body: { ...providers, legacyProvider: 'openai_codex' } },
      },
      {
        input: { subscriptionProviderId: 'xai' },
        method: 'provider-subscription.account-list',
        request: 'POST /api/app/operations/provider-subscription.account-list',
        route: { body: { accounts: [], defaultAccountSlotId: 'default' } },
      },
      {
        input: {
          subscriptionProviderId: 'xai',
          ...{ accountSlotId: 'team_slot', displayName: 'Team' },
        },
        method: 'provider-subscription.account-create',
        request: 'POST /api/app/operations/provider-subscription.account-create',
        route: { body: { ...loggedOutAccount, credential: 'secret' } },
      },
      {
        input: {
          subscriptionProviderId: 'openai-codex',
          accountSlotId: 'default',
          ...{ displayName: 'Default' },
        },
        method: 'provider-subscription.account-update',
        request: 'POST /api/app/operations/provider-subscription.account-update',
        route: { body: { ...loggedOutAccount, credential: 'secret' } },
      },
      {
        input: { subscriptionProviderId: 'openai-codex', accountSlotId: 'default' },
        method: 'provider-subscription.account-status',
        request: 'POST /api/app/operations/provider-subscription.account-status',
        route: { body: { ...loggedOutAccount, credential: 'secret' } },
      },
      {
        input: {
          subscriptionProviderId: 'openai-codex',
          accountSlotId: 'default',
          ...{ mode: 'device_code' },
        },
        method: 'provider-subscription.account-login-start',
        request: 'POST /api/app/operations/provider-subscription.account-login-start',
        route: { body: { ...loggedOutAccount, credential: 'secret' } },
      },
      {
        input: {
          subscriptionProviderId: 'openai-codex',
          accountSlotId: 'default',
          ...{ interactionId: 'interaction_demo' },
        },
        method: 'provider-subscription.account-login-cancel',
        request: 'POST /api/app/operations/provider-subscription.account-login-cancel',
        route: { body: { ...loggedOutAccount, credential: 'secret' } },
      },
      {
        input: { subscriptionProviderId: 'openai-codex', accountSlotId: 'default' },
        method: 'provider-subscription.account-logout',
        request: 'POST /api/app/operations/provider-subscription.account-logout',
        route: { body: { ...loggedOutAccount, credential: 'secret' } },
      },
      {
        input: { subscriptionProviderId: 'xai', accountSlotId: 'team_slot' },
        method: 'provider-subscription.account-quota',
        request: 'POST /api/app/operations/provider-subscription.account-quota',
        route: { body: { ...quota, rawQuota: {} } },
      },
      {
        input: { subscriptionProviderId: 'xai', accountSlotId: 'team_slot' },
        method: 'provider-subscription.account-auto-topup',
        request: 'POST /api/app/operations/provider-subscription.account-auto-topup',
        route: { body: { ...autoTopup, savedPaymentMethod: true } },
      },
    ] as const;
    const { client: malformedClient } = createFakeClient(
      Object.fromEntries(
        malformedCases.map((testCase) => [testCase.request, testCase.route])
      ) as RouteMap
    );

    for (const testCase of malformedCases) {
      await expect(
        Reflect.apply(malformedClient.operations[testCase.method], malformedClient.operations, [
          testCase.input,
        ])
      ).rejects.toBeInstanceOf(ProtocolValidationError);
    }
  });

  it('rejects raw native runtime refs in capability usage', async () => {
    for (const [field, value] of [
      ['runtimeOriginRef', 'native_thread_0190'],
      ['runtimeCacheLineageRef', 'native_cache_0190'],
    ] as const) {
      const payload = capabilityUsageResponse();
      payload.capabilityCalls[0] = { ...payload.capabilityCalls[0], [field]: value };
      const { client } = createFakeClient({
        'POST /api/app/operations/usage.read': { body: payload },
      });

      await expect(
        client.operations['usage.read']({ workspaceId: 'ws_demo' })
      ).rejects.toBeInstanceOf(ProtocolValidationError);
    }
  });

  it('uses the strict diagnostics schema without unsupported response shapes', async () => {
    const { client } = createFakeClient({
      'POST /api/app/operations/diagnostics.app': {
        body: {
          ...appDiagnostics(),
          providers: [],
        },
      },
    });

    await expect(client.operations['diagnostics.app']({})).rejects.toBeInstanceOf(
      ProtocolValidationError
    );
  });

  it('reads the exact public NanoHost RuntimeTarget admin response', async () => {
    const payload = nanoHostRuntimeTargetStatus();
    const { client, requests } = createFakeClient({
      'POST /api/app/operations/nanohost.runtime-target': { body: payload },
    });

    await expect(client.operations['nanohost.runtime-target']({})).resolves.toEqual(payload);
    expect(requests).toEqual([
      expect.objectContaining({
        hasBody: true,
        method: 'POST',
        path: '/api/app/operations/nanohost.runtime-target',
      }),
    ]);
  });

  it('rejects extra fields on the NanoHost RuntimeTarget admin response', async () => {
    const { client } = createFakeClient({
      'POST /api/app/operations/nanohost.runtime-target': {
        body: { ...nanoHostRuntimeTargetStatus(), targetId: 'caller-selected' },
      },
    });

    await expect(client.operations['nanohost.runtime-target']({})).rejects.toBeInstanceOf(
      ProtocolValidationError
    );
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

  it('reads the signed-in session user and accepts a null session', async () => {
    const timestamp = '2026-09-16T00:00:00.000Z';
    const { client, requests } = createFakeClient({
      'GET /api/auth/get-session': {
        body: {
          session: { id: 'session_demo' },
          user: {
            id: 'user_demo',
            email: 'user@example.com',
            name: 'Demo User',
            emailVerified: true,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
      },
    });

    await expect(client.auth.email.getSession()).resolves.toMatchObject({
      user: { id: 'user_demo' },
    });
    expect(requests).toEqual([
      expect.objectContaining({ method: 'GET', path: '/api/auth/get-session' }),
    ]);

    const absent = createFakeClient({
      'GET /api/auth/get-session': { body: null },
    });
    await expect(absent.client.auth.email.getSession()).resolves.toBeNull();
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
      'POST /api/app/operations/runtime.reload': {
        body: {
          status: 'dry-run',
          runtimeConfig: runtimeConfigStatus(),
          plan: runtimeConfigPlan(),
        },
      },
      'POST /api/app/operations/runtime.file-list': { body: { files: [file.file] } },
      'POST /api/app/operations/runtime.file-read': { body: file },
      'POST /api/app/operations/runtime.file-update': {
        body: { file: file.file, diagnostics: [] },
      },
      'POST /api/app/operations/runtime.validate': {
        body: {
          valid: true,
          diagnostics: [],
          runtimeConfig: runtimeConfigStatus(),
          plan: runtimeConfigPlan(),
        },
      },
      'POST /api/app/operations/runtime.schemas': {
        body: { schemas: [{ kind: 'server', title: 'Server config', schema: {} }] },
      },
      'POST /api/app/operations/runtime.file-delete': { status: 204 },
      'POST /api/app/operations/automation.delete': { status: 204 },
    });

    await expect(
      client.operations['runtime.reload']({ dryRun: true, mode: 'safe' })
    ).resolves.toMatchObject({
      status: 'dry-run',
    });
    await expect(client.operations['runtime.file-list']({})).resolves.toEqual({
      files: [file.file],
    });
    await expect(client.operations['runtime.file-read']({ id: 'server' })).resolves.toEqual(file);
    await expect(
      client.operations['runtime.file-update']({ id: 'server', kind: 'server', content: '{}' })
    ).resolves.toEqual({
      file: file.file,
      diagnostics: [],
    });
    await expect(client.operations['runtime.validate']({ files: [] })).resolves.toMatchObject({
      diagnostics: [],
    });
    await expect(client.operations['runtime.schemas']({})).resolves.toEqual({
      schemas: [{ kind: 'server', title: 'Server config', schema: {} }],
    });
    await expect(
      client.operations['runtime.file-delete']({
        id: 'providers/exact.provider.jsonc',
        kind: 'provider',
        expectedRevision: 'exact-revision',
      })
    ).resolves.toBeNull();
    expect('runtimeConfig' in client).toBe(false);
    await expect(
      client.operations['automation.delete']({ automationId: 'auto_demo' })
    ).resolves.toBeNull();
  });

  it('preserves typed API errors for delete failures', async () => {
    const { client } = createFakeClient({
      'POST /api/app/operations/automation.delete': {
        body: {
          ...apiError('automation_not_found', 'Automation not found.'),
          details: { automationId: 'auto_demo' },
          path: ['automationId'],
          requestId,
        },
        status: 404,
      },
    });

    await expect(
      client.operations['automation.delete']({ automationId: 'auto_demo' })
    ).rejects.toMatchObject({
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

  it.each([
    '',
    'https://nanocore.test/prefix/',
  ])('encodes SSE path and query identifiers on both transports with base %j', async (baseUrl) => {
    const options = {
      baseUrl,
      workspaceId: 'ws /?',
      threadId: 'th #/é',
      turnId: 'turn &?=+',
      since: 7,
    };
    const path =
      '/api/workspaces/ws%20%2F%3F/threads/th%20%23%2F%C3%A9/events?turnId=turn+%26%3F%3D%2B&since=7';
    const expected = baseUrl ? `https://nanocore.test${path}` : path;
    const fetchUrls: string[] = [];
    const iterator = subscribeTurnEvents({
      ...options,
      fetch: async (input) => {
        fetchUrls.push(String(input));
        return new Response(null, { status: 204 });
      },
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(fetchUrls).toEqual([expected]);

    FakeEventSource.instances = [];
    const eventSourceIterator = subscribeTurnEvents({
      ...options,
      eventSource: FakeEventSource,
    })[Symbol.asyncIterator]();
    try {
      expect(FakeEventSource.instances.map((source) => source.url)).toEqual([expected]);
    } finally {
      await eventSourceIterator.return?.();
    }
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

describe('workspace secret client', () => {
  it('posts secret input only in request bodies and validates redacted lifecycle results', async () => {
    const reference = {
      backendKind: 'encrypted-file',
      currentVersion: 1,
      ownerScope: 'workspace',
      referenceId: 'vault_test',
      secretKind: 'github-token',
      status: 'active',
      workspaceId: 'ws_demo',
    };
    const grant = workspaceVaultGrantsResponse().items[0]!;
    const { client, requests } = createFakeClient({
      ['POST /api/app/operations/vault.secret-create']: { body: reference },
      ['POST /api/app/operations/vault.secret-rotate']: {
        body: { ...reference, currentVersion: 2 },
      },
      ['POST /api/app/operations/vault.secret-revoke']: {
        body: { ...reference, status: 'revoked' },
      },
      ['POST /api/app/operations/vault.grant-create']: { body: grant },
      ['POST /api/app/operations/vault.grant-revoke']: { body: { ...grant, status: 'revoked' } },
    });
    await expect(
      client.operations['vault.secret-create']({
        workspaceId: 'ws_demo',
        ...{
          secretKind: 'github-token',
          material: 'test-canary',
        },
      })
    ).resolves.toEqual(reference);
    await expect(
      client.operations['vault.secret-rotate']({
        workspaceId: 'ws_demo',
        referenceId: 'vault_test',
        ...{ material: 'next-canary' },
      })
    ).resolves.toMatchObject({ currentVersion: 2 });
    await client.operations['vault.grant-create']({
      workspaceId: 'ws_demo',
      ...{ referenceId: 'vault_test' },
    });
    await client.operations['vault.grant-revoke']({
      workspaceId: 'ws_demo',
      grantId: 'grant_github',
    });
    await client.operations['vault.secret-revoke']({
      workspaceId: 'ws_demo',
      referenceId: 'vault_test',
    });
    expect(requests[0]?.body).toEqual({
      workspaceId: 'ws_demo',
      secretKind: 'github-token',
      material: 'test-canary',
    });
    expect(requests.map(({ path }) => path).join(' ')).not.toContain('canary');
  });
});

describe('Gateway audit route lineage consumer', () => {
  it('preserves the authorized redacted projection through the existing usage reader', async () => {
    const base = capabilityUsageResponse();
    const payload = {
      ...base,
      capabilityCalls: base.capabilityCalls.map((call) => ({
        ...call,
        routeLineage: {
          logicalModelId: 'tier',
          entries: [
            {
              kind: 'attempt',
              routeMemberId: 'backup',
              selectionReason: 'backup',
              attemptOrder: 1,
              retryIndex: 0,
              outputBegan: true,
              terminalResult: 'succeeded',
              released: true,
            },
          ],
        },
      })),
    };
    const { client } = createFakeClient({
      'POST /api/app/operations/usage.read': { body: payload },
    });
    await expect(client.operations['usage.read']({ workspaceId: 'ws_demo' })).resolves.toEqual(
      payload
    );
  });
});
