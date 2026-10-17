import type { AutomationRecord } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { parseWorkspaceSharingError } from './app.js';
import { type CoreClient, createCoreClient } from './client.js';
import { ApiCallError, ProtocolValidationError } from './errors.js';
import { type SseEventEnvelope, subscribeTurnEvents } from './events.js';
import * as coreClientExports from './index.js';

const timestamp = '2026-05-28T00:00:00.000Z';
const requestId = '00000000-0000-4000-8000-000000000001';
const notebookBaseRevision = '1'.repeat(40);
const notebookCandidateRevision = '2'.repeat(40);
const notebookReverseRevision = '3'.repeat(40);

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
  return { protocolVersion: '0.6.0', code, message };
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
    id: 'ws_00000000-0000-7000-8000-000000000001',
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
    membershipStatus: 'active',
    accessCause: 'membership',
    isOwner: true,
    membershipRevision: 1,
    ownerUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
    registryRevision: 1,
    workspace: workspace(),
  };
}

/** Returns one current Workspace member projection for sharing-client tests. */
function workspaceMember(status: 'active' | 'removed' = 'active') {
  return {
    createdAt: timestamp,
    isOwner: false,
    invitationId: 'inv_01890f3e-0000-7000-8000-000000000071',
    joinedAt: timestamp,
    removedAt: status === 'removed' ? timestamp : null,
    revision: 1,
    status,
    updatedAt: timestamp,
    userId: 'usr_00000000-0000-7a71-a8b1-dcc65a83481f',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
    invitationId: 'inv_01890f3e-0000-7000-8000-000000000071',
    inviteeUserId: 'usr_00000000-0000-7a71-a8b1-dcc65a83481f',
    inviterUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',

    revision: 1,
    revokedAt: null,
    updatedAt: timestamp,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  };
}

/** Returns one administrator-safe Workspace recovery projection. */
function workspaceAccessRecovery() {
  return {
    administratorMembershipStatus: null,
    ownerUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
    registryRevision: 1,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  };
}

/** Returns one disabled canonical-user projection. */
function disabledUser() {
  return {
    disabledAt: timestamp,
    status: 'disabled',
    userId: 'usr_00000000-0000-7a71-a8b1-dcc65a83481f',
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
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    },
  };
}

/** Returns one valid thread record. */
function thread() {
  return {
    id: 'th_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
    id: 'tu_00000000-0000-77e3-bfde-66477d556f64',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b' },
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
    id: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      requestId,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Returns one valid workspace synchronization review item. */
function workspaceSyncReview() {
  return {
    artifactId: 'ar_00000000-0000-7e93-b881-32f3f8c0b14a',
    changeSet: {
      id: 'wcs_1',
      materializationRecordId: 'wmr_1',
      inputSnapshotId: 'wis_1',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      resourceId: 'default',
      strategy: 'git',
      base: { commit: 'abc123', contentDigest: null },
      head: { commit: 'def456', contentDigest: null },
      changedPaths: [{ path: 'docs/spec.md', status: 'modified', binary: false }],
      patch: { ref: 'artifact://patch', digest: 'sha256:patch', bytes: 1200 },
      bundle: null,
      artifactIds: ['ar_00000000-0000-7e93-b881-32f3f8c0b14a'],
      evidenceRefs: [{ kind: 'worker', ref: 'tu_00000000-0000-77e3-bfde-66477d556f64' }],
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
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      status: 'pending',
      staging: {
        strategy: 'git_worktree',
        ref: 'staging://workspace/wcs_1',
        branch: 'openkit/review/swr_1',
      },
      diffSummary: { filesChanged: 1, additions: 0, deletions: 0 },
      riskSummary: '1 changed path staged for human review.',
      validation: [
        { command: 'worker', status: 'passed', ref: 'tu_00000000-0000-77e3-bfde-66477d556f64' },
      ],
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
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
    deploymentId: 'dep_01890f3e-0000-7000-8000-000000000071',
    connectionGeneration: 3,
    physicalEpoch: 'a'.repeat(64),
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
    build: { releaseTag: null, sourceCommit: null },
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
    id: 'it_00000000-0000-7167-b408-becd17a436db',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
    type: 'user-message',
    status: 'completed',
    actor: { kind: 'user', id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b' },
    causationId: requestId,
    text: 'Hello',
    createdAt: timestamp,
    completedAt: timestamp,
  };
}

/** Returns one paused schedule with its immutable automation actor. */
function automation(): AutomationRecord {
  return {
    id: 'auto_00000000-0000-7934-bc11-14512d3a737a',
    name: 'Demo automation',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7723-8254-2805c5537655',
    intervalSeconds: 3600,
    prompt: 'Summarize status.',
    responsibleUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
    actor: {
      kind: 'automation',
      id: 'auto_00000000-0000-7934-bc11-14512d3a737a',
      responsibleUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
    },
    status: 'paused',
    revision: 1,
    nextScheduledAt: null,
    greatestAccountedScheduledAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
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
    viewerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    participants: [],
    thread: thread(),
    turns: [turn()],
    taskInputs: [
      {
        itemId: 'it_00000000-0000-7ee9-904f-46bd403270cc',
        objective: 'Inspect the linked repository.',
      },
    ],
    artifacts: [
      {
        id: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
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
      href: '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/items',
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
    exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    manifest: {
      schemaVersion: 1,
      recordType: 'workspace-export',
      id: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      ownerScope: 'workspace',
      lineage: { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      createdAt: timestamp,
      updatedAt: timestamp,
      contentDigest: 'sha256:manifest',
      redactionLevel: 'metadata',
      sensitivity: 'internal',
      requiredFeatures: [],
      extensions: {},
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      exportCreatedAt: timestamp,
      exportFormatVersion: 3,
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
    backupId: 'drb_00000000-0000-795e-9322-0c2b42caa5d0',
    manifest: {
      schemaVersion: 1,
      recordType: 'data-root-backup',
      id: 'drb_00000000-0000-795e-9322-0c2b42caa5d0',
      ownerScope: 'server',
      lineage: {},
      createdAt: timestamp,
      updatedAt: timestamp,
      contentDigest: 'sha256:manifest',
      redactionLevel: 'metadata',
      sensitivity: 'internal',
      requiredFeatures: [],
      extensions: {},
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
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
  const expectedCurrentImageId = `sha256:${'b'.repeat(64)}`;
  const source = {
    appDigest: `sha256:${'b'.repeat(64)}`,
    sourceCommit: 'a'.repeat(40),
    tag: 'v0.1.0',
  };
  return {
    approvalSummary: {
      targetRelease: source,
      expectedCurrentImageId,
      observedCurrentImageId: expectedCurrentImageId,
      interruptionScope: 'NanoCore, Web, and active client connections.',
      safetyEvidence: {
        deploymentBindings: true,
        preflight: {
          observedAt: timestamp,
          workspaceCount: 1,
          counts: {
            runningTurns: 0,
            pendingTurns: 0,
            queuedAdmissions: 0,
            openAttempts: 0,
            closingAttempts: 0,
            inFlightCommands: 0,
          },
          state: 'idle',
        },
      },
      recoveryLimitations: ['No migration rollback, automatic resume, or interrupted-work replay.'],
    },
    helperSha256: 'c'.repeat(64),
    preparedHelperSha256: 'c'.repeat(64),
    expectedCurrentImageId,
    preparedAt: timestamp,
    requestId: '11111111-1111-4111-8111-111111111111',
    source,
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
    tokenId: 'tok_00000000-0000-7530-a268-adac6fe06bd8',
    ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
    scope: 'workspace',
    workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
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
        id: 'cap_00000000-0000-7d4f-884e-ab4fdf8dc968',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        itemId: 'it_00000000-0000-7d53-9abb-fba003a3df39',
        agentId: 'assistant',
        agentSessionId: 'as_00000000-0000-78be-889a-02eee50dd060',
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
        id: 'use_00000000-0000-7bad-8061-11b8ce86e984',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        responsibleUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        itemId: 'it_00000000-0000-7d53-9abb-fba003a3df39',
        agentId: 'assistant',
        agentSessionId: 'as_00000000-0000-78be-889a-02eee50dd060',
        sourceIds: ['repo_default'],
        requestId: '00000000-0000-4000-8000-000000000911',
        capabilityCallId: 'cap_00000000-0000-7d4f-884e-ab4fdf8dc968',
        category: 'llm',
        unit: 'tokens',
        quantity: 12,
        modelId: 'openai/gpt-5.1',
        providerRef: 'openrouter',
        source: 'llm-gateway-adapter-reported:input',
        recordedAt: timestamp,
      },
    ],
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  };
}

/** Returns one workspace evidence bundle response fixture. */
function workspaceEvidenceBundlesResponse() {
  return {
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    evidenceBundles: [
      {
        id: 'evb_1',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        goalId: 'goal_demo',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        agentSessionId: null,
        backendType: null,
        sourceKind: 'manual',
        summary: 'Goal evidence is ready for review.',
        rawEvidenceRefs: [],
        redactedEvidenceRefs: [
          { kind: 'artifact', ref: 'ar_00000000-0000-78f7-9fad-58a15c7011af' },
        ],
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
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    runtimeEvidence: [
      {
        id: 'rte_1',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        agentSessionId: 'as_00000000-0000-78be-889a-02eee50dd060',
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
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    auditEvents: [
      {
        id: 'aud_00000000-0000-72f4-8dcc-8c92fd4028d3',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        protocolVersion: '0.6.0',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
        id: 'aud_00000000-0000-726b-8ee2-162b4bf37c24',
        workspaceId: null,
        protocolVersion: '0.6.0',
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
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    permissionDecisions: [
      {
        decisionId: 'pd_00000000-0000-7a55-84b6-910265042f6b',
        ownerScope: 'workspace',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        policyEngineVersion: 'nanocore-worker-policy:v1',
        policySnapshotId: 'worker_turn_launch_policy',
        subjectSummary: { kind: 'nanocore', id: 'worker-coordinator' },
        action: 'runtime.launch',
        resourceSummary: { kind: 'worker-turn', turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64' },
        contextSummary: {
          requestId: '00000000-0000-4000-8000-00000000d791',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        },
        result: 'allow',
        reasonCode: 'worker_turn_start_allowed',
        enforcementPoint: 'runtime.worker_turn_loop.start',
        requiredApprovalKind: null,
        approvalId: null,
        auditEventId: 'aud_00000000-0000-72f4-8dcc-8c92fd4028d3',
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
        decisionId: 'pd_00000000-0000-77a3-8707-815ac642840b',
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
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    vaultUseRecords: [
      {
        useId: 'vu_00000000-0000-7de7-8524-24839a742ee9',
        ownerScope: 'workspace',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        materialVersion: 1,
        backendKind: 'encrypted-file',
        resolvingPath: 'grant',
        grantId: 'grant_00000000-0000-7fe9-9377-b84721e910b4',
        planId: null,
        receiptId: null,
        agentSessionId: 'as_00000000-0000-7b98-8803-ea4242ad797b',
        capabilityCallId: null,
        outcome: 'succeeded',
        failureCode: null,
        auditEventId: 'aud_00000000-0000-72f4-8dcc-8c92fd4028d3',
        usedAt: timestamp,
      },
    ],
  };
}

/** Returns one workspace vault grant metadata response fixture. */
function workspaceVaultGrantsResponse() {
  return {
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    items: [
      {
        issuance: 'target',
        grantId: 'grant_00000000-0000-7fe9-9377-b84721e910b4',
        vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        ownerScope: 'workspace',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        userId: null,
        subjectSummary: null,
        targetAgentId: null,
        targetAgentSessionId: 'as_00000000-0000-7b98-8803-ea4242ad797b',
        targetCapabilityId: null,
        allowedInjectionPaths: ['backend-provider'],
        lifetime: 'turn',
        policyDecisionId: 'pd_00000000-0000-7a55-84b6-910265042f6b',
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
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    items: [
      {
        planId: 'plan_github',
        grantId: 'grant_00000000-0000-7fe9-9377-b84721e910b4',
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
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    items: [
      {
        receiptId: 'receipt_github',
        planId: 'plan_github',
        grantId: 'grant_00000000-0000-7fe9-9377-b84721e910b4',
        agentSessionId: 'as_00000000-0000-7b98-8803-ea4242ad797b',
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
        useId: 'vu_00000000-0000-7da1-80dc-838273b4bd8d',
        ownerScope: 'server',
        workspaceId: null,
        vaultReferenceId: 'vault_00000000-0000-7c76-ac2c-1aa2ef4a94c5',
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
        auditEventId: 'aud_00000000-0000-726b-8ee2-162b4bf37c24',
        usedAt: timestamp,
      },
    ],
  };
}

/** Returns one workspace import dry-run response fixture. */
function workspaceImportDryRunResponse() {
  return {
    mode: 'dry-run',
    exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
    sourceWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    exportedWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    manifest: workspaceExportResponse().manifest,
    verification: { fileCount: 1, totalBytes: 16, checkedFiles: ['records/workspace-record.json'] },
    collision: {
      status: 'collides',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      suggestedWorkspaceId: 'ws_00000000-0000-7089-bb95-d4e3b1944597',
    },
  };
}

/** Returns one workspace import response fixture. */
function workspaceImportResponse() {
  return {
    mode: 'imported',
    requestId: 'req_import',
    exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
    sourceWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    exportedWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    importedWorkspaceId: 'ws_00000000-0000-7089-bb95-d4e3b1944597',
    manifest: workspaceExportResponse().manifest,
    verification: { fileCount: 1, totalBytes: 16, checkedFiles: ['records/workspace-record.json'] },
    collision: {
      status: 'collides',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      suggestedWorkspaceId: 'ws_00000000-0000-7089-bb95-d4e3b1944597',
    },
    workspace: {
      id: 'ws_00000000-0000-7089-bb95-d4e3b1944597',
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
      recoveryExportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      sourceWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    },
  };
}

/** Returns one interrupted worker recovery row. */
function interruptedWorkerState() {
  return {
    kind: 'interrupted_worker_state',
    checkpointId:
      'ws_00000000-0000-7000-8000-000000000001:th_00000000-0000-7000-8000-000000000001:tu_00000000-0000-721e-b9c7-66142de81c58',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId: 'tu_00000000-0000-721e-b9c7-66142de81c58',
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
    protocolVersion: '0.6.0',
    event,
    sequence,
    requestId,
    timestamp,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
    data:
      event === 'turn.completed'
        ? {
            type: 'turn-completed',
            stopReason: 'completed',
            turn: { ...turn(), status: 'completed', completedAt: timestamp },
          }
        : {
            type: 'turn-started',
            turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
            status: 'running',
          },
  };
}

/** Returns one internal-only AgentSession stream event. */
function agentSessionEvent(sequence: number) {
  return {
    protocolVersion: '0.6.0',
    event: 'agent.session.updated',
    sequence,
    requestId,
    timestamp,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
    data: {
      type: 'agent-session-updated',
      agentSession: {
        id: 'as_00000000-0000-7860-9e37-d1a60b30c856',
        agentId: 'agent_demo',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
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
    { ...turnEvent(5, 'turn.completed'), workspaceId: 'ws_00000000-0000-71f5-922f-6fd42f52f580' },
  ],
  [
    'a mismatched envelope Thread',
    { ...turnEvent(5, 'turn.completed'), threadId: 'th_00000000-0000-78ce-b458-8347d12d1da2' },
  ],
  [
    'a mismatched envelope Turn',
    { ...turnEvent(5, 'turn.completed'), turnId: 'tu_00000000-0000-7e18-a597-336d92a699e9' },
  ],
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
          workspaceId: 'ws_00000000-0000-71f5-922f-6fd42f52f580',
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
        turn: {
          ...turn(),
          status: 'completed',
          completedAt: timestamp,
          threadId: 'th_00000000-0000-78ce-b458-8347d12d1da2',
        },
      },
    },
  ],
  [
    'a mismatched payload Turn',
    {
      ...turnEvent(5, 'turn.completed'),
      data: {
        ...turnEvent(5, 'turn.completed').data,
        turn: {
          ...turn(),
          status: 'completed',
          completedAt: timestamp,
          id: 'tu_00000000-0000-7e18-a597-336d92a699e9',
        },
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

    const downloaded = await client.app.downloadWorkspaceExportArchive(
      'ws_00000000-0000-7000-8000-000000000001',
      'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4'
    );
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
        path: '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/exports/wsexp_00000000-0000-7693-ae39-6c3f6020c3c4/archive',
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
      'Chat Mode',
      (client: CoreClient) =>
        client.operations['conversation.submit']({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
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
              membershipStatus: 'active',
              accessCause: 'membership',
              isOwner: true,
              membershipRevision: 1,
              ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
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
    await client.operations['workspace.resources']({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    await client.operations['thread.create']({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      name: 'Demo thread',
    });
    await client.operations['turn.start']({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      input: 'Run',
    });
    await expect(
      client.operations['turn.start']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-7bde-8e11-bbfbdf1c1bf6',
        answers: { branch: ['main'] },
      } as never)
    ).rejects.toThrow();
    await expect(
      client.operations['artifact.read']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
      })
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
    expect(requests[3]?.body).toMatchObject({
      name: 'Demo thread',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
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
          protocolVersion: '0.6.0',
          capabilities: [],
          eventFamilies: [],
        },
      },
      'POST /api/app/operations/workspace.read': {
        body: {
          ...workspace(),
          ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
          membershipStatus: 'active',
          accessCause: 'membership',
        },
      },
      'POST /api/app/operations/workspace.update': { body: workspace() },
      'POST /api/app/operations/knowledge.list': {
        body: {
          notebookRevision: notebookBaseRevision,
          items: [{ ...knowledge, contentDigest: `sha256:${'a'.repeat(64)}` }],
        },
      },
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
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              backendKind: 'openshell',
              packageSnapshotId: 'aepsnap_1',
              workerSessionId: 'as_00000000-0000-7fee-81f4-cfcfc003f25f',
              strategy: 'git',
              materializedRootRef: 'workspace://ws_00000000-0000-7000-8000-000000000001/default',
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
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              materializationRecordId: 'wmr_1',
              backendKind: 'openshell',
              packageSnapshotId: 'aepsnap_1',
              workerSessionId: 'as_00000000-0000-7fee-81f4-cfcfc003f25f',
              transportRefs: [
                {
                  kind: 'materialized-root',
                  ref: 'workspace://ws_00000000-0000-7000-8000-000000000001/default',
                },
              ],
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
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              materializationRecordId: 'wmr_1',
              inputSnapshotId: 'wis_1',
              workerSessionId: 'as_00000000-0000-7fee-81f4-cfcfc003f25f',
              backendKind: 'openshell',
              strategy: 'git',
              changedPaths: [{ path: 'docs/spec.md', status: 'modified', binary: false }],
              artifactIds: ['ar_00000000-0000-7f26-8292-8ac950dddeba'],
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
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              triggerReason: 'restart',
              affectedRecordIds: ['wmr_1', 'bwh_wmr_1'],
              backendHandleSummary: {
                backendKind: 'openshell',
                handleId: 'bwh_wmr_1',
                workerSessionId: 'as_00000000-0000-7fee-81f4-cfcfc003f25f',
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
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
              threadId: 'th_00000000-0000-7000-8000-000000000001',
              agentSessionId: 'as_00000000-0000-7860-9e37-d1a60b30c856',
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          agentSessionId: 'as_00000000-0000-7860-9e37-d1a60b30c856',
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

    await expect(client.core.meta()).resolves.toMatchObject({ protocolVersion: '0.6.0' });
    await expect(
      client.operations['workspace.read']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual({
      ...workspace(),
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      membershipStatus: 'active',
      accessCause: 'membership',
    });
    await expect(
      client.operations['workspace.update']({
        ...{ status: 'archived' },
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual(workspace());
    await expect(
      client.operations['knowledge.list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual({
      notebookRevision: notebookBaseRevision,
      items: [{ ...knowledge, contentDigest: `sha256:${'a'.repeat(64)}` }],
    });
    await expect(
      client.operations['knowledge.create']({
        baseRevision: notebookBaseRevision,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        knowledgePageId: knowledge.id,
        kind: knowledge.kind,
        title: knowledge.title,
        content: knowledge.content,
      })
    ).resolves.toEqual(knowledge);
    await expect(
      client.operations['knowledge.update']({
        baseRevision: notebookBaseRevision,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        knowledgeEntryId: 'mem_demo',
        ...{ title: 'Updated' },
      })
    ).resolves.toEqual(knowledge);
    await expect(
      client.operations['knowledge.delete']({
        baseRevision: notebookBaseRevision,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        knowledgeEntryId: 'mem_demo',
        expectedContentDigest: `sha256:${'a'.repeat(64)}`,
        confirmRemoval: true,
      })
    ).resolves.toBeNull();
    await expect(
      client.operations['thread.list']({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001' })
    ).resolves.toEqual({
      items: [thread()],
    });
    await expect(
      client.operations['thread.read']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual(thread());
    await expect(
      client.operations['thread.update']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        name: 'Renamed',
      })
    ).resolves.toEqual(thread());
    await expect(
      client.operations['thread.archive']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual(thread());
    await expect(
      client.operations['turn.read']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      })
    ).resolves.toEqual(turnReadProjection());
    await expect(
      client.operations['turn.interrupt']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      })
    ).resolves.toEqual(turn());
    await expect(
      client.operations['artifact.list']({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001' })
    ).resolves.toEqual({
      items: [artifact()],
    });
    await expect(
      client.operations['sync.review-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual({
      items: [workspaceSyncReview()],
    });
    await expect(
      client.operations['sync.review-read']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        reviewId: 'swr_1',
      })
    ).resolves.toEqual(workspaceSyncReview());
    await expect(
      client.operations['sync.review-decide']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        reconciliationRecordId: 'wrr_1',
        ...{
          decision: 'quarantine',
        },
      })
    ).resolves.toMatchObject({
      reconciliationRecord: { id: 'wrr_1', stateAfter: 'quarantined' },
    });
    await expect(
      client.operations['sync.input-snapshot-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toMatchObject({
      items: [{ id: 'wis_1', strategy: 'git' }],
    });
    await expect(
      client.operations['sync.materialization-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toMatchObject({
      items: [{ id: 'wmr_1', inputSnapshotId: 'wis_1' }],
    });
    await expect(
      client.operations['sync.backend-handle-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toMatchObject({
      items: [{ id: 'bwh_wmr_1', materializationRecordId: 'wmr_1' }],
    });
    await expect(
      client.operations['sync.output-manifest-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toMatchObject({
      items: [{ id: 'wom_1', materializationRecordId: 'wmr_1' }],
    });
    await expect(
      client.operations['sync.change-set-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual({
      items: [workspaceSyncReview().changeSet],
    });
    await expect(
      client.operations['sync.staged-review-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual({
      items: [workspaceSyncReview().review],
    });
    await expect(
      client.operations['sync.apply-plan-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toMatchObject({
      items: [{ id: 'wap_swr_1', reviewId: 'swr_1' }],
    });
    await expect(
      client.operations['sync.reconciliation-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toMatchObject({
      items: [{ id: 'wrr_1', triggerReason: 'restart', stateAfter: 'requires-human' }],
    });
    await expect(
      client.operations['sync.quarantine-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toMatchObject({
      items: [{ id: 'wqr_1', failureKind: 'digest_mismatch', resolution: 'pending' }],
    });
    await expect(
      client.operations['sync.apply-result-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual({
      items: [workspaceApplyResult()],
    });
    await expect(
      client.operations['sync.apply-result-read']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        applyResultId: 'war_swr_1',
      })
    ).resolves.toEqual(workspaceApplyResult());
    await expect(
      client.operations['environment.snapshot-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toMatchObject({
      items: [{ snapshotId: 'aepsnap_1' }],
    });
    await expect(
      client.operations['environment.snapshot-read']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        snapshotId: 'aepsnap_1',
      })
    ).resolves.toMatchObject({
      snapshotId: 'aepsnap_1',
      snapshot: { snapshotId: 'aepsnap_1' },
    });
    await expect(
      client.operations['thread.items']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
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
    expect(requests[6]?.body).toEqual({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      knowledgeEntryId: 'mem_demo',
      baseRevision: notebookBaseRevision,
      expectedContentDigest: `sha256:${'a'.repeat(64)}`,
      confirmRemoval: true,
    });
    expect(requests[6]?.headers['x-openkit-request-id']).toEqual(expect.any(String));
  });

  it('derives approval response JSON and request identity from the operation definition', async () => {
    const approval = {
      id: 'approval_demo',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
      title: 'Demo material',
      kind: 'markdown',
      currentRevisionId: 'mrev_00000000-0000-7444-8d8f-e35a7aaa68ab',
      sensitivity: 'internal',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const revision = {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
      revisionId: 'mrev_00000000-0000-7444-8d8f-e35a7aaa68ab',
      parentRevisionId: null,
      mediaType: 'text/markdown',
      contentDigest,
      authorId: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0',
      createdAt: timestamp,
    };
    const threadMaterial = {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      resource: material,
      currentRevision: revision,
      inclusionState: 'included',
      latestQueuedRevisionId: 'mrev_00000000-0000-7444-8d8f-e35a7aaa68ab',
      lastWorkerSeenRevisionId: null,
      currentTurnRevisionId: null,
      activeDelivery: null,
    };
    const routeCases = [
      [
        'POST /api/app/operations/artifact.introduce',
        {
          artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
          artifactVersion: 1,
          turnId: 'tu_00000000-0000-7819-9015-eac73267a43b',
          itemId: 'it_00000000-0000-72a0-9302-f07cea82e3ac',
        },
        201,
      ],
      ['POST /api/app/operations/material.list', { materials: [material] }, 200],
      [
        'POST /api/app/operations/material.create',
        { materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3' },
        201,
      ],
      ['POST /api/app/operations/material.read', { material }, 200],
      ['POST /api/app/operations/material.revision-list', { revisions: [revision] }, 200],
      [
        'POST /api/app/operations/material.revision-save',
        {
          materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
          revisionId: 'mrev_00000000-0000-7444-8d8f-e35a7aaa68ab',
        },
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
        {
          materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          outcome: 'bound',
        },
        200,
      ],
      [
        'POST /api/app/operations/material.unbind',
        {
          materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          outcome: 'unbound',
        },
        200,
      ],
      [
        'POST /api/app/operations/material.exclude',
        {
          materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          outcome: 'excluded',
        },
        200,
      ],
      [
        'POST /api/app/operations/material.restore',
        {
          materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          outcome: 'included',
        },
        200,
      ],
    ] as const;
    const { client, requests } = createFakeClient(
      Object.fromEntries(routeCases.map(([path, body, status]) => [path, { body, status }]))
    );

    const responses = [
      await client.operations['artifact.introduce']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
        ...{
          expectedArtifactVersion: 1,
        },
      }),
      await client.operations['material.list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      }),
      await client.operations['material.create']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        title: 'Demo material',
        kind: 'markdown',
        sensitivity: 'internal',
      }),
      await client.operations['material.read']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
      }),
      await client.operations['material.revision-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
      }),
      await client.operations['material.revision-save']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
        expectedRevisionId: null,
        contentDigest,
        content: '# Demo material',
      }),
      await client.operations['material.revision-read']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
        revisionId: 'mrev_00000000-0000-7444-8d8f-e35a7aaa68ab',
      }),
      await client.operations['material.thread-read']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
      }),
      await client.operations['material.bind']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
        expectedBindingState: 'not_bound',
      }),
      await client.operations['material.unbind']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
        expectedBindingState: 'bound',
      }),
      await client.operations['material.exclude']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
        expectedBindingState: 'bound',
        expectedInclusionState: 'included',
        expectedQueuedRevisionId: 'mrev_00000000-0000-7444-8d8f-e35a7aaa68ab',
      }),
      await client.operations['material.restore']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
        expectedBindingState: 'bound',
        expectedInclusionState: 'excluded',
      }),
    ];

    // Binary bindings have their own exact-byte transport suite; generated JSON methods cannot publish file bodies.
    expect(client.operations).not.toHaveProperty('artifact.import');
    expect(client.operations).not.toHaveProperty('artifact.download');
    expect(requests[0]?.headers['x-openkit-request-id']).toEqual(expect.any(String));
    expect(responses).toEqual(routeCases.map(([, body]) => body));
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual(
      routeCases.map(([path]) => path)
    );
    expect(requests.map(({ body }) => body)).toEqual([
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
        expectedArtifactVersion: 1,
      },
      { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        title: 'Demo material',
        kind: 'markdown',
        sensitivity: 'internal',
      },
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
      },
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
      },
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
        expectedRevisionId: null,
        contentDigest,
        content: '# Demo material',
      },
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
        revisionId: 'mrev_00000000-0000-7444-8d8f-e35a7aaa68ab',
      },
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
      },
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
        expectedBindingState: 'not_bound',
      },
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
        expectedBindingState: 'bound',
      },
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
        expectedBindingState: 'bound',
        expectedInclusionState: 'included',
        expectedQueuedRevisionId: 'mrev_00000000-0000-7444-8d8f-e35a7aaa68ab',
      },
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
        expectedBindingState: 'bound',
        expectedInclusionState: 'excluded',
      },
    ]);
  });

  it('routes Artifact Review through derived operations', async () => {
    const contentDigest = `sha256:${'a'.repeat(64)}`;
    const review = {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      reviewId: 'arev_00000000-0000-5000-8000-000000000001',
      artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
      artifactVersion: 1,
      contentDigest,
      sourceThreadId: 'th_00000000-0000-7000-8000-000000000001',
      sourceTurnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
      })
    ).resolves.toEqual({
      reviews: [{ ...review, candidateSelections: [] }],
    });
    await expect(
      client.operations['artifact.review.decide']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
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
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
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
        body: { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        invoke: (client) =>
          client.operations['workspace.member-list']({
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          }),
        methodPath: 'POST /api/app/operations/workspace.member-list',
        response: { items: [member] },
      },
      {
        body: { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        invoke: (client) =>
          client.operations['workspace.invitation-list']({
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          }),
        methodPath: 'POST /api/app/operations/workspace.invitation-list',
        response: { items: [invitation] },
      },
      {
        body: {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          inviteeEmail: 'invitee@example.com',
        },
        invoke: (client) =>
          client.operations['workspace.invitation-create']({
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            ...{
              inviteeEmail: 'invitee@example.com',

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
        body: { invitationId: 'inv_01890f3e-0000-7000-8000-000000000071', expectedRevision: 1 },
        invoke: (client) =>
          client.operations['workspace.my-invitation-accept']({
            invitationId: 'inv_01890f3e-0000-7000-8000-000000000071',
            ...{
              expectedRevision: 1,
              requestId,
            },
          }),
        methodPath: 'POST /api/app/operations/workspace.my-invitation-accept',
        response: { invitation },
      },
      {
        body: { invitationId: 'inv_01890f3e-0000-7000-8000-000000000071', expectedRevision: 1 },
        invoke: (client) =>
          client.operations['workspace.my-invitation-decline']({
            invitationId: 'inv_01890f3e-0000-7000-8000-000000000071',
            ...{
              expectedRevision: 1,
              requestId,
            },
          }),
        methodPath: 'POST /api/app/operations/workspace.my-invitation-decline',
        response: { invitation },
      },
      {
        body: {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          invitationId: 'inv_01890f3e-0000-7000-8000-000000000071',
          expectedRevision: 1,
        },
        invoke: (client) =>
          client.operations['workspace.invitation-revoke']({
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            invitationId: 'inv_01890f3e-0000-7000-8000-000000000071',
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          targetUserId: 'usr_00000000-0000-7a71-a8b1-dcc65a83481f',
          expectedRevision: 1,
        },
        invoke: (client) =>
          client.operations['workspace.member-remove']({
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            targetUserId: 'usr_00000000-0000-7a71-a8b1-dcc65a83481f',
            ...{
              expectedRevision: 1,
              requestId,
            },
          }),
        methodPath: 'POST /api/app/operations/workspace.member-remove',
        response: { member: removedMember },
      },
      {
        body: { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', expectedRevision: 1 },
        invoke: (client) =>
          client.operations['workspace.leave']({
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            ...{ expectedRevision: 1, requestId },
          }),
        methodPath: 'POST /api/app/operations/workspace.leave',
        response: { member: removedMember },
      },
      {
        body: {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          expectedRegistryRevision: 1,
          targetUserId: 'usr_00000000-0000-7a71-a8b1-dcc65a83481f',
        },
        invoke: (client) =>
          client.operations['workspace.ownership-transfer']({
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            ...{
              expectedRegistryRevision: 1,
              requestId,
              targetUserId: 'usr_00000000-0000-7a71-a8b1-dcc65a83481f',
            },
          }),
        methodPath: 'POST /api/app/operations/workspace.ownership-transfer',
        response: { workspace: summary },
      },
      {
        body: { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        invoke: (client) =>
          client.operations['workspace.access-recovery-read']({
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          }),
        methodPath: 'POST /api/app/operations/workspace.access-recovery-read',
        response: { recovery },
      },
      {
        body: {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          action: 'add-self-as-member',
          expectedRegistryRevision: 1,
        },
        invoke: (client) =>
          client.operations['workspace.access-recover']({
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            ...{
              action: 'add-self-as-member',
              expectedRegistryRevision: 1,
              requestId,
            },
          }),
        methodPath: 'POST /api/app/operations/workspace.access-recover',
        response: { recovery },
      },
      {
        body: { targetUserId: 'usr_00000000-0000-7a71-a8b1-dcc65a83481f' },
        invoke: (client) =>
          client.operations['user.disable']({
            targetUserId: 'usr_00000000-0000-7a71-a8b1-dcc65a83481f',
            ...{ requestId },
          }),
        methodPath: 'POST /api/app/operations/user.disable',
        response: { user },
      },
      {
        body: {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          confirmation: 'permanently-delete-workspace:ws_00000000-0000-7000-8000-000000000001:1',
          expectedRegistryRevision: 1,
        },
        invoke: (client) =>
          client.operations['workspace.delete']({
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            ...{
              confirmation:
                'permanently-delete-workspace:ws_00000000-0000-7000-8000-000000000001:1',
              expectedRegistryRevision: 1,
              requestId,
            },
          }),
        methodPath: 'POST /api/app/operations/workspace.delete',
        response: workspaceDeletionResponse(),
        status: 202,
      },
      {
        body: {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          deletionRequestId: '00000000-0000-4000-8000-000000000002',
        },
        invoke: (client) =>
          client.operations['workspace.deleted-recover']({
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      protocolVersion: '0.6.0',
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
    const retrievalRequestDigest = `sha256:${'b'.repeat(64)}`;
    const retrievedPageDigest = `sha256:${'c'.repeat(64)}`;
    const knowledgePageScopeId = 'page/workspace/ws_00000000-0000-7000-8000-000000000001';
    const knowledgeQueryContext = {
      serverId: 'dep_00000000-0000-7f8a-b255-5b390b0a86da',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    } as const;
    const proposalSourceReference = `source:ks_00000000-0000-7e28-9211-1f67fd14ca84@sha256:${'d'.repeat(64)}`;
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
            tokenId: 'tok_00000000-0000-7194-b4f8-8fa26eda7175',
            ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
          referenceId: 'vault_00000000-0000-7f9a-ae09-1112bc878c49',
          secretKind: 'api-token',
          status: 'active',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        },
      },
      'POST /api/app/operations/vault.reference-list': {
        body: {
          items: [
            {
              backendKind: 'encrypted-file',
              currentVersion: 0,
              ownerScope: 'workspace',
              referenceId: 'vault_00000000-0000-7f9a-ae09-1112bc878c49',
              secretKind: 'api-token',
              status: 'unbound',
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            },
          ],
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      'POST /api/app/operations/task.start': {
        body: {
          state: 'running',
          turn: turn(),
          evidence: {
            itemIds: ['it_00000000-0000-7fb0-9f78-7d56c297c2eb'],
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
            id: 'it_00000000-0000-7865-a4d8-ae16913048ac',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
            type: 'assistant-message',
            status: 'completed',
            text: 'Answer',
            createdAt: timestamp,
            completedAt: timestamp,
          },
          handoff: null,
          originatingWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          originatingThreadId: 'th_00000000-0000-7000-8000-000000000001',
          receivingWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          receivingThreadId: 'th_00000000-0000-7000-8000-000000000001',
          targetRef: 'assistant',
          logicalModelId: null,
        },
      },
      'POST /api/app/operations/knowledge.answer': {
        body: {
          operationId: 'km_answer_demo',
          operation: 'answer',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          caller: 'app-api',
          query: 'release cadence',
          outcome: 'answered',
          answer: 'Release cadence is weekly.',
          citations: [
            {
              reference: { scopeId: knowledgePageScopeId, objectId: 'mem_demo' },
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
            id: 'ks_00000000-0000-7ef0-a551-80b39073108f',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            kind: 'document',
            title: 'Release notes',
            uri: 'file://release.md',
            contentDigest: 'sha256:abc123',
            originatingThreadId: 'th_00000000-0000-7000-8000-000000000001',
            originatingTurnId: null,
            originatingFileId: null,
            capturedAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          derivedRepresentations: [
            {
              id: 'ks_00000000-0000-7ef0-a551-80b39073108f:text',
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              sourceId: 'ks_00000000-0000-7ef0-a551-80b39073108f',
              kind: 'text',
              path: 'sources/derived/ks_00000000-0000-7ef0-a551-80b39073108f/text.json',
              materialPath: 'sources/materials/ks_00000000-0000-7ef0-a551-80b39073108f/content.txt',
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
              id: 'ks_00000000-0000-7ef0-a551-80b39073108f',
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              kind: 'document',
              title: 'Release notes',
              uri: 'file://release.md',
              contentDigest: 'sha256:abc123',
              originatingThreadId: 'th_00000000-0000-7000-8000-000000000001',
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
            id: 'ks_00000000-0000-7ef0-a551-80b39073108f',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            kind: 'document',
            title: 'Release notes',
            uri: 'file://release.md',
            contentDigest: 'sha256:abc123',
            originatingThreadId: 'th_00000000-0000-7000-8000-000000000001',
            originatingTurnId: null,
            originatingFileId: null,
            capturedAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          derivedRepresentations: [
            {
              id: 'ks_00000000-0000-7ef0-a551-80b39073108f:text',
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              sourceId: 'ks_00000000-0000-7ef0-a551-80b39073108f',
              kind: 'text',
              path: 'sources/derived/ks_00000000-0000-7ef0-a551-80b39073108f/text.json',
              materialPath: 'sources/materials/ks_00000000-0000-7ef0-a551-80b39073108f/content.txt',
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
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            rebuiltAt: timestamp,
            edges: [{ fromId: 'alpha', target: '/beta.md', toId: 'beta', resolved: true }],
          },
          validation: {
            schemaVersion: 1,
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            rebuiltAt: timestamp,
            records: [
              {
                conceptId: 'alpha',
                path: 'knowledge/pages/alpha.md',
                title: 'Alpha',
                conformance: 'scope-schema-valid',
                active: true,
                indexed: true,
                errors: [],
              },
            ],
          },
          sourceReferences: {
            schemaVersion: 1,
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            rebuiltAt: timestamp,
            references: [
              {
                conceptId: 'alpha',
                path: 'knowledge/pages/alpha.md',
                reference: 'source:ks_00000000-0000-7ef0-a551-80b39073108f',
                kind: 'registered-source',
                targetId: 'ks_00000000-0000-7ef0-a551-80b39073108f',
                resolved: true,
              },
            ],
          },
          fullText: {
            schemaVersion: 1,
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
            id: 'ko_00000000-0000-7998-bb5a-f6e99a870e41',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            kind: 'retrieval',
            summary: 'Worker repeatedly needed release cadence context.',
            sourceReferences: [
              'knowledge:kn_demo',
              'source:ks_00000000-0000-7ef0-a551-80b39073108f',
            ],
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
              id: 'ko_00000000-0000-7998-bb5a-f6e99a870e41',
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              kind: 'retrieval',
              summary: 'Worker repeatedly needed release cadence context.',
              sourceReferences: [
                'knowledge:kn_demo',
                'source:ks_00000000-0000-7ef0-a551-80b39073108f',
              ],
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
            id: 'kc_00000000-0000-7120-8707-e527057f1dd9',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            statement: 'Release cadence is weekly.',
            sourceReferences: [
              'knowledge:release-plan',
              'source:ks_00000000-0000-7b52-90c5-8003864b63f9',
            ],
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
              id: 'kc_00000000-0000-7120-8707-e527057f1dd9',
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              statement: 'Release cadence is weekly.',
              sourceReferences: [
                'knowledge:release-plan',
                'source:ks_00000000-0000-7b52-90c5-8003864b63f9',
              ],
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
            id: 'kf_00000000-0000-7b22-b99c-14cb0ba3c7ef',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            subjectReferences: [
              'knowledge:release-plan',
              'claim:kc_00000000-0000-78d1-ade0-e140ee38bc7a',
            ],
            sourceReferences: [
              'source:ks_00000000-0000-7b52-90c5-8003864b63f9',
              'source:ks_00000000-0000-7cfe-8f5a-5c42a2b55641',
            ],
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
              id: 'kf_00000000-0000-7b22-b99c-14cb0ba3c7ef',
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              subjectReferences: [
                'knowledge:release-plan',
                'claim:kc_00000000-0000-78d1-ade0-e140ee38bc7a',
              ],
              sourceReferences: [
                'source:ks_00000000-0000-7b52-90c5-8003864b63f9',
                'source:ks_00000000-0000-7cfe-8f5a-5c42a2b55641',
              ],
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
            id: 'kf_00000000-0000-7b22-b99c-14cb0ba3c7ef',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            subjectReferences: [
              'knowledge:release-plan',
              'claim:kc_00000000-0000-78d1-ade0-e140ee38bc7a',
            ],
            sourceReferences: [
              'source:ks_00000000-0000-7b52-90c5-8003864b63f9',
              'source:ks_00000000-0000-7cfe-8f5a-5c42a2b55641',
            ],
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
          queryContext: knowledgeQueryContext,
          sourceScope: knowledgePageScopeId,
          notebookRevision: null,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          caller: 'app-api',
          requestDigest: retrievalRequestDigest,
          retrievalParameters: {
            limit: 1,
            pinnedReferences: [],
            states: ['active'],
            sourceScope: 'workspace',
          },
          createdAt: timestamp,
          selected: [
            {
              reference: { scopeId: knowledgePageScopeId, objectId: 'release-plan' },
              revision: retrievedPageDigest,
              contentDigest: retrievedPageDigest,
              score: 4,
              sourceReferences: ['source:ks_00000000-0000-7ef0-a551-80b39073108f'],
            },
          ],
          excluded: [
            {
              reference: { scopeId: knowledgePageScopeId, objectId: 'old-plan' },
              revision: null,
              contentDigest: null,
              sourceReferences: [],
              reason: 'sensitive_content',
            },
          ],
        },
      },
      'POST /api/app/operations/knowledge.context.prepare': {
        body: {
          operationId: 'km_context_demo',
          operation: 'prepare-context-material',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          caller: 'app-api',
          outcome: 'prepared',
          selected: [
            {
              reference: { scopeId: knowledgePageScopeId, objectId: 'release-plan' },
              revision: retrievedPageDigest,
              contentDigest: retrievedPageDigest,
              score: 4,
              sourceReferences: ['source:ks_00000000-0000-7ef0-a551-80b39073108f'],
            },
          ],
          excluded: [
            {
              reference: { scopeId: knowledgePageScopeId, objectId: 'old-plan' },
              revision: null,
              contentDigest: null,
              sourceReferences: [],
              reason: 'sensitive_content',
            },
          ],
        },
      },
      'POST /api/app/operations/knowledge.proposal.draft': {
        body: {
          operationId: 'km_proposal_demo',
          operation: 'draft-proposal',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          caller: 'app-api',
          proposal: {
            id: 'kp_demo',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            operation: 'notebook-change',
            ownerScope: {
              kind: 'workspace',
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            },
            baseRevision: notebookBaseRevision,
            candidateRevision: notebookCandidateRevision,
            knowledgePageId: 'lessons/release-review',
            canonicalPageBytes: proposalPageBytes,
            contentDigest: proposalPageDigest,
            sourceReferences: [proposalSourceReference],
            rationale: 'This evidence supports one reusable release-review rule.',
            confidence: 0.75,
            producer: {
              kind: 'agent',
              id: 'knowledge-manager',
              responsibleUserId: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0',
            },
            status: 'pending',
            createdAt: timestamp,
          },
          validation: {
            conformance: 'scope-schema-valid',
            generatedFromCompletedWorkHistory: false,
          },
        },
      },
      'POST /api/app/operations/knowledge.repair.suggest': {
        body: {
          operationId: 'km_repair_demo',
          operation: 'suggest-repair',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
        body: {
          items: [
            { kind: 'workspace', id: 'ws_00000000-0000-7000-8000-000000000001', title: 'Demo' },
          ],
        },
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
          turnId: 'tu_00000000-0000-721e-b9c7-66142de81c58',
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
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              threadId: 'th_00000000-0000-7000-8000-000000000001',
              turnId: 'tu_00000000-0000-77ce-a313-434e52e312f6',
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
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        password: 'password123456',
        token: 'okt_bootstrap_secret',
        tokenExpiresAt: timestamp,
      })
    ).resolves.toMatchObject({
      token: 'okt_owner_secret',
      record: { ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f', scope: 'server-admin' },
    });
    await expect(
      client.operations['backup.verify']({ backupId: 'drb_00000000-0000-795e-9322-0c2b42caa5d0' })
    ).resolves.toEqual(dataRootBackupResponse());
    await expect(
      client.operations['workspace.export']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual(workspaceExportResponse());
    await expect(
      client.operations['workspace.import-dry-run']({
        sourceWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      })
    ).resolves.toEqual(workspaceImportDryRunResponse());
    await expect(
      client.operations['workspace.import']({
        sourceWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
        requestId: 'req_import',
      })
    ).resolves.toEqual(workspaceImportResponse());
    expect(
      requests.find(({ path }) => path === '/api/app/operations/workspace.export')?.body
    ).toEqual({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001' });
    const importRequest = requests.find(
      ({ path }) => path === '/api/app/operations/workspace.import'
    );
    expect(importRequest?.headers['x-openkit-request-id']).toBe('req_import');
    expect(importRequest?.body).toEqual({
      sourceWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
    });
    await expect(
      client.operations['vault.reference-rebind']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        referenceId: 'vault_00000000-0000-7f9a-ae09-1112bc878c49',
        ...{
          materialBase64: Buffer.from('ws_00000000-0000-7610-8fe3-da032db53ed3').toString('base64'),
        },
      })
    ).resolves.toMatchObject({
      referenceId: 'vault_00000000-0000-7f9a-ae09-1112bc878c49',
      status: 'active',
    });
    await expect(
      client.operations['vault.reference-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toMatchObject({
      items: [{ referenceId: 'vault_00000000-0000-7f9a-ae09-1112bc878c49', status: 'unbound' }],
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    await expect(
      client.operations['vault.grant-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual(workspaceVaultGrantsResponse());
    await expect(
      client.operations['vault.injection-plan-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual(workspaceInjectionPlansResponse());
    await expect(
      client.operations['vault.injection-receipt-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual(workspaceInjectionReceiptsResponse());
    await expect(
      client.operations['vault.use-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual(workspaceVaultUseRecordsResponse());
    await expect(client.operations['vault.server-use-list']({})).resolves.toEqual(
      serverVaultUseRecordsResponse()
    );
    await expect(
      client.operations['usage.read']({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001' })
    ).resolves.toEqual(capabilityUsageResponse());
    await expect(
      client.operations['evidence.bundle-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual(workspaceEvidenceBundlesResponse());
    await expect(
      client.operations['evidence.runtime-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual(workspaceRuntimeEvidenceResponse());
    await expect(
      client.operations['audit.workspace-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual(workspaceAuditEventsResponse());
    await expect(client.operations['audit.server-list']({})).resolves.toEqual(
      serverAuditEventsResponse()
    );
    await expect(
      client.operations['permission.workspace-list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual(workspacePermissionDecisionsResponse());
    await expect(client.operations['permission.server-list']({})).resolves.toEqual(
      serverPermissionDecisionsResponse()
    );
    await expect(
      client.operations['task.start']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        ...{ input: 'Implement the focused fix.' },
      })
    ).resolves.toMatchObject({
      state: 'running',
    });
    await expect(
      client.operations['conversation.submit']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
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
    const knowledgeAnswer = await client.operations['knowledge.answer']({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      ...{ query: 'release cadence' },
    });
    expect(knowledgeAnswer).toMatchObject({
      outcome: 'answered',
      citations: [{ reference: { scopeId: knowledgePageScopeId, objectId: 'mem_demo' } }],
    });
    expect(knowledgeAnswer).not.toHaveProperty('retrievalTraceRef');
    expect(knowledgeAnswer).not.toHaveProperty('retrievalTraceId');
    await expect(
      client.operations['knowledge.source.register']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ...{
          requestId: 'req_source',
          kind: 'document',
          title: 'Release notes',
          uri: 'file://release.md',
          content: 'Release cadence is weekly.',
          originatingThreadId: 'th_00000000-0000-7000-8000-000000000001',
        },
      })
    ).resolves.toMatchObject({
      source: { id: 'ks_00000000-0000-7ef0-a551-80b39073108f', title: 'Release notes' },
      derivedRepresentations: [
        { sourceId: 'ks_00000000-0000-7ef0-a551-80b39073108f', kind: 'text' },
      ],
    });
    await expect(
      client.operations['knowledge.source.list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toMatchObject({
      items: [{ id: 'ks_00000000-0000-7ef0-a551-80b39073108f', title: 'Release notes' }],
    });
    await expect(
      client.operations['knowledge.source.read']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        sourceId: 'ks_00000000-0000-7ef0-a551-80b39073108f',
      })
    ).resolves.toMatchObject({
      source: { id: 'ks_00000000-0000-7ef0-a551-80b39073108f', title: 'Release notes' },
      derivedRepresentations: [
        { sourceId: 'ks_00000000-0000-7ef0-a551-80b39073108f', kind: 'text' },
      ],
    });
    await expect(
      client.operations['knowledge.indexes']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toMatchObject({
      linkGraph: { edges: [{ fromId: 'alpha', resolved: true }] },
      validation: { records: [{ conceptId: 'alpha', indexed: true }] },
      sourceReferences: {
        references: [
          { reference: 'source:ks_00000000-0000-7ef0-a551-80b39073108f', resolved: true },
        ],
      },
    });
    await expect(
      client.operations['knowledge.observation.record']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ...{
          requestId: 'req_observation',
          kind: 'retrieval',
          summary: 'Worker repeatedly needed release cadence context.',
          sourceReferences: ['knowledge:kn_demo', 'source:ks_00000000-0000-7ef0-a551-80b39073108f'],
          producer: 'knowledge-manager',
          confidence: 0.75,
        },
      })
    ).resolves.toMatchObject({
      observation: {
        id: 'ko_00000000-0000-7998-bb5a-f6e99a870e41',
        kind: 'retrieval',
        status: 'retained',
      },
    });
    await expect(
      client.operations['knowledge.observation.list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toMatchObject({
      items: [{ id: 'ko_00000000-0000-7998-bb5a-f6e99a870e41', kind: 'retrieval' }],
    });
    await expect(
      client.operations['knowledge.claim.record']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ...{
          requestId: 'req_claim',
          statement: 'Release cadence is weekly.',
          sourceReferences: [
            'knowledge:release-plan',
            'source:ks_00000000-0000-7b52-90c5-8003864b63f9',
          ],
          producer: 'knowledge-manager',
          confidence: 0.8,
        },
      })
    ).resolves.toMatchObject({
      claim: {
        id: 'kc_00000000-0000-7120-8707-e527057f1dd9',
        statement: 'Release cadence is weekly.',
      },
    });
    await expect(
      client.operations['knowledge.claim.list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toMatchObject({
      items: [
        { id: 'kc_00000000-0000-7120-8707-e527057f1dd9', statement: 'Release cadence is weekly.' },
      ],
    });
    await expect(
      client.operations['knowledge.conflict.record']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ...{
          requestId: 'req_conflict',
          subjectReferences: [
            'knowledge:release-plan',
            'claim:kc_00000000-0000-78d1-ade0-e140ee38bc7a',
          ],
          sourceReferences: [
            'source:ks_00000000-0000-7b52-90c5-8003864b63f9',
            'source:ks_00000000-0000-7cfe-8f5a-5c42a2b55641',
          ],
          summary: 'Release cadence has contradictory source evidence.',
          producer: 'knowledge-manager',
        },
      })
    ).resolves.toMatchObject({
      conflict: { id: 'kf_00000000-0000-7b22-b99c-14cb0ba3c7ef', status: 'conflicting' },
    });
    await expect(
      client.operations['knowledge.conflict.list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toMatchObject({
      items: [{ id: 'kf_00000000-0000-7b22-b99c-14cb0ba3c7ef', status: 'conflicting' }],
    });
    await expect(
      client.operations['knowledge.conflict.resolve']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        conflictId: 'kf_00000000-0000-7b22-b99c-14cb0ba3c7ef',
        ...{
          requestId: 'req_resolve_conflict',
          resolution: 'Friday release reviews are authoritative.',
          resolvedBy: 'knowledge-manager',
        },
      })
    ).resolves.toMatchObject({
      conflict: { id: 'kf_00000000-0000-7b22-b99c-14cb0ba3c7ef', status: 'resolved' },
    });
    await expect(
      client.operations['knowledge.retrieval']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ...{ query: 'release cadence', limit: 1 },
      })
    ).resolves.toEqual({
      queryContext: knowledgeQueryContext,
      sourceScope: knowledgePageScopeId,
      notebookRevision: null,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      caller: 'app-api',
      requestDigest: retrievalRequestDigest,
      retrievalParameters: {
        limit: 1,
        pinnedReferences: [],
        states: ['active'],
        sourceScope: 'workspace',
      },
      createdAt: timestamp,
      selected: [
        {
          reference: { scopeId: knowledgePageScopeId, objectId: 'release-plan' },
          revision: retrievedPageDigest,
          contentDigest: retrievedPageDigest,
          score: 4,
          sourceReferences: ['source:ks_00000000-0000-7ef0-a551-80b39073108f'],
        },
      ],
      excluded: [
        {
          reference: { scopeId: knowledgePageScopeId, objectId: 'old-plan' },
          revision: null,
          contentDigest: null,
          sourceReferences: [],
          reason: 'sensitive_content',
        },
      ],
    });
    await expect(
      client.operations['knowledge.context.prepare']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ...{
          query: 'release cadence',
          limit: 1,
        },
      })
    ).resolves.toEqual({
      operationId: 'km_context_demo',
      operation: 'prepare-context-material',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      caller: 'app-api',
      outcome: 'prepared',
      selected: [
        {
          reference: { scopeId: knowledgePageScopeId, objectId: 'release-plan' },
          revision: retrievedPageDigest,
          contentDigest: retrievedPageDigest,
          score: 4,
          sourceReferences: ['source:ks_00000000-0000-7ef0-a551-80b39073108f'],
        },
      ],
      excluded: [
        {
          reference: { scopeId: knowledgePageScopeId, objectId: 'old-plan' },
          revision: null,
          contentDigest: null,
          sourceReferences: [],
          reason: 'sensitive_content',
        },
      ],
    });
    expect(client.app).not.toHaveProperty('readKnowledgeContextPackageTrace');
    expect(client.app).not.toHaveProperty('materializeKnowledgeContextPackage');
    expect(client.app).not.toHaveProperty('readKnowledgeContextPackageMaterialization');
    const requestedMethodPaths = requests.map(({ method, path }) => `${method} ${path}`);
    for (const removedMethodPath of [
      'GET /api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/manager/context/ctxpkg_km_context_demo',
      'POST /api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/manager/context/ctxpkg_km_context_demo/materialization',
      'GET /api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/manager/context/ctxpkg_km_context_demo/materialization',
    ]) {
      expect(requestedMethodPaths).not.toContain(removedMethodPath);
    }
    await expect(
      client.operations['knowledge.proposal.draft']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ...{
          requestId: '00000000-0000-4000-8000-000000000621',
          baseRevision: notebookBaseRevision,
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
      client.operations['knowledge.repair.suggest']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ...{},
      })
    ).resolves.toMatchObject({
      operation: 'suggest-repair',
      suggestions: [{ kind: 'duplicate-title' }],
    });
    await expect(
      client.operations['knowledge.health.check']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ...{},
      })
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
      items: [{ kind: 'workspace', id: 'ws_00000000-0000-7000-8000-000000000001', title: 'Demo' }],
    });
    await expect(
      client.operations['agent.health-refresh']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.not.toHaveProperty('sessions');
    await expect(client.operations['agent.list']({})).resolves.toEqual({ items: [agent()] });
    await expect(client.operations['agent.read']({ agentId: 'agent_demo' })).resolves.toEqual(
      agent()
    );
    await expect(
      client.operations['attention.list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual({
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-721e-b9c7-66142de81c58',
        requestId: 'req_worker_retry',
      })
    ).resolves.toEqual({
      outcome: 'released_for_retry',
      turnId: 'tu_00000000-0000-721e-b9c7-66142de81c58',
    });
    expect(
      requests.find((request) => request.path === '/api/app/operations/recovery.checkpoint-retry')
        ?.body
    ).toEqual({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-721e-b9c7-66142de81c58',
    });
    expect(
      requests.find((request) => request.path === '/api/app/operations/recovery.checkpoint-retry')
        ?.headers['x-openkit-request-id']
    ).toBe('req_worker_retry');
    await expect(
      client.operations['scheduler.retry']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        queueEntryId: 'queue_denied',
      })
    ).resolves.toEqual({
      retried: true,
    });
    await expect(
      client.operations['scheduler.cancel']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        queueEntryId: 'queue_queued',
      })
    ).resolves.toEqual({
      cancelled: true,
    });
    await expect(
      client.operations['scheduler.list']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
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
      ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
      password: 'password123456',
      token: 'okt_bootstrap_secret',
      tokenExpiresAt: timestamp,
    });
    expect(requests[11]?.body).toEqual({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      referenceId: 'vault_00000000-0000-7f9a-ae09-1112bc878c49',
      materialBase64: Buffer.from('ws_00000000-0000-7610-8fe3-da032db53ed3').toString('base64'),
    });
    expect(requests.at(-6)?.body).toEqual({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    expect(requests.at(-5)?.body).toEqual({});
    expect(requests.at(-4)?.body).toEqual({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-721e-b9c7-66142de81c58',
    });
    expect(requests.at(-3)?.body).toEqual({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      queueEntryId: 'queue_denied',
    });
    expect(requests.at(-2)?.body).toEqual({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      queueEntryId: 'queue_queued',
    });
    expect(requests.at(-1)?.body).toEqual({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
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
            predecessorTokenId: 'tok_00000000-0000-7530-a268-adac6fe06bd8',
            tokenId: 'tok_00000000-0000-70a5-901d-30e32504f846',
          }),
        },
      },
      'POST /api/app/operations/token.my-admin-list': {
        body: {
          defaultTokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629',
          items: [
            accessTokenRecord({
              tokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629',
              scope: 'server-admin',
              workspaceIds: [],
            }),
          ],
        },
      },
      'POST /api/app/operations/token.my-admin-default': {
        body: {
          defaultTokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629',
          items: [
            accessTokenRecord({
              tokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629',
              scope: 'server-admin',
              workspaceIds: [],
            }),
          ],
        },
      },
    });

    await expect(client.operations['token.list']({})).resolves.toMatchObject({
      items: [
        {
          tokenId: 'tok_00000000-0000-7530-a268-adac6fe06bd8',
          workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
        },
      ],
    });
    await expect(
      client.operations['token.create']({
        expiresAt: timestamp,
        scope: 'workspace',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
      })
    ).resolves.toMatchObject({
      token: 'okt_workspace_secret',
      record: { tokenId: 'tok_00000000-0000-7530-a268-adac6fe06bd8' },
    });
    await expect(
      client.operations['token.revoke']({ tokenId: 'tok_00000000-0000-7530-a268-adac6fe06bd8' })
    ).resolves.toMatchObject({
      record: { status: 'revoked' },
    });
    await expect(
      client.operations['token.rotate']({
        tokenId: 'tok_00000000-0000-7530-a268-adac6fe06bd8',
        ...{ graceSeconds: 60 },
      })
    ).resolves.toMatchObject({
      token: 'okt_rotated_secret',
      rotatedRecord: { predecessorTokenId: 'tok_00000000-0000-7530-a268-adac6fe06bd8' },
    });
    await expect(client.operations['token.my-admin-list']({})).resolves.toMatchObject({
      defaultTokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629',
      items: [{ tokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629', scope: 'server-admin' }],
    });
    await expect(
      client.operations['token.my-admin-default']({
        tokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629',
      })
    ).resolves.toMatchObject({
      defaultTokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629',
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
      workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
    });
    expect(requests[3]?.body).toEqual({
      tokenId: 'tok_00000000-0000-7530-a268-adac6fe06bd8',
      graceSeconds: 60,
    });
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
          grantId: 'grant_00000000-0000-79cb-b598-745f38b7a39a',
          grantScope: 'agent-session',
          referenceId: 'vault_00000000-0000-72d1-b90a-e14fea8ea955',
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
      grantId: 'grant_00000000-0000-79cb-b598-745f38b7a39a',
      referenceId: 'vault_00000000-0000-72d1-b90a-e14fea8ea955',
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
            reviewId: 'kr_00000000-0000-7612-9103-c189935bbc75',
            proposalId: 'kp_demo',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            decision: 'accepted',
            ownerScope: {
              kind: 'workspace',
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            },
            baseRevision: notebookBaseRevision,
            candidateRevision: notebookCandidateRevision,
            actor: { kind: 'user', id: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0' },
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
            notebookRevision: notebookCandidateRevision,
          },
        },
      },
      'POST /api/app/operations/knowledge.proposal.reverse': {
        body: {
          proposalId: 'kp_demo',
          reviewId: 'kr_00000000-0000-7612-9103-c189935bbc75',
          application: {
            knowledgePageId: 'lessons/release-review',
            contentDigest: proposalPageDigest,
            present: false,
            notebookRevision: notebookReverseRevision,
          },
        },
      },
      'POST /api/app/operations/diagnostics.setup': { body: setupDiagnostics() },
      'POST /api/app/operations/automation.list': { body: { items: [automation()] } },
      'POST /api/app/operations/automation.create': { body: automation(), status: 201 },
      'POST /api/app/operations/automation.update': {
        body: { ...automation(), status: 'active', revision: 2, nextScheduledAt: timestamp },
      },
      'POST /api/app/operations/turn.feedback': {
        body: {
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
          agentId: 'agent_demo',
          rating: 'good',
          note: null,
          createdAt: timestamp,
          history: [],
        },
      },
    });

    await expect(
      client.operations['workspace.dashboard']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual(workspaceDashboard());
    const dashboard = await client.operations['thread.dashboard']({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
    });
    expect(dashboard).not.toHaveProperty('activeSession');
    expect(dashboard.workStatus).toEqual(threadDashboard().workStatus);
    expect(dashboard.taskInputs).toEqual(threadDashboard().taskInputs);
    expect('runThreadGoalTestSuperviseStep' in client.app).toBe(false);
    await expect(
      client.operations['knowledge.proposal.decide']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        proposalId: 'kp_demo',
        ...{
          requestId: '00000000-0000-4000-8000-000000000622',
          proposalDigest,
          baseRevision: notebookBaseRevision,
          candidateRevision: notebookCandidateRevision,
          decision: 'accepted',
        },
      })
    ).resolves.toEqual({
      review: {
        reviewId: 'kr_00000000-0000-7612-9103-c189935bbc75',
        proposalId: 'kp_demo',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        decision: 'accepted',
        ownerScope: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        baseRevision: notebookBaseRevision,
        candidateRevision: notebookCandidateRevision,
        actor: { kind: 'user', id: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0' },
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
        notebookRevision: notebookCandidateRevision,
      },
    });
    await expect(
      client.operations['knowledge.proposal.reverse']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        proposalId: 'kp_demo',
        ...{
          requestId: '00000000-0000-4000-8000-000000000623',
          baseRevision: notebookCandidateRevision,
          confirmRemoval: true,
          reviewId: 'kr_00000000-0000-7612-9103-c189935bbc75',
          knowledgePageId: 'lessons/release-review',
          expectedContentDigest: proposalPageDigest,
        },
      })
    ).resolves.toEqual({
      proposalId: 'kp_demo',
      reviewId: 'kr_00000000-0000-7612-9103-c189935bbc75',
      application: {
        knowledgePageId: 'lessons/release-review',
        contentDigest: proposalPageDigest,
        present: false,
        notebookRevision: notebookReverseRevision,
      },
    });
    await expect(client.operations['diagnostics.setup']({})).resolves.toEqual(setupDiagnostics());
    await expect(client.operations['automation.list']({})).resolves.toEqual({
      items: [automation()],
    });
    await expect(
      client.operations['automation.create']({
        name: 'Demo automation',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: automation().threadId,
        intervalSeconds: 3600,
        prompt: 'Summarize status.',
      })
    ).resolves.toEqual(automation());
    await expect(
      client.operations['automation.update']({
        automationId: 'auto_00000000-0000-7934-bc11-14512d3a737a',
        expectedRevision: 1,
        status: 'active',
        scheduledAt: timestamp,
      })
    ).resolves.toEqual({
      ...automation(),
      status: 'active',
      revision: 2,
      nextScheduledAt: timestamp,
    });
    await expect(
      client.operations['turn.feedback']({
        ...{ rating: 'good', note: null },
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      })
    ).resolves.toMatchObject({ turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64', rating: 'good' });
    expect(
      requests.find((request) =>
        request.path.endsWith('/api/app/operations/knowledge.proposal.decide')
      )?.body
    ).toEqual({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      proposalId: 'kp_demo',
      decision: 'accepted',
      proposalDigest,
      baseRevision: notebookBaseRevision,
      candidateRevision: notebookCandidateRevision,
    });
    expect(
      requests.find((request) =>
        request.path.endsWith('/api/app/operations/knowledge.proposal.reverse')
      )?.body
    ).toEqual({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      proposalId: 'kp_demo',
      reviewId: 'kr_00000000-0000-7612-9103-c189935bbc75',
      knowledgePageId: 'lessons/release-review',
      expectedContentDigest: proposalPageDigest,
      baseRevision: notebookCandidateRevision,
      confirmRemoval: true,
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
        client.operations['usage.read']({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001' })
      ).rejects.toBeInstanceOf(ProtocolValidationError);
    }
  });

  it('accepts App Diagnostics when an older server omits release identity', async () => {
    const { build: _build, ...withoutBuild } = appDiagnostics();
    const { client } = createFakeClient({
      'POST /api/app/operations/diagnostics.app': { body: withoutBuild },
    });

    await expect(client.operations['diagnostics.app']({})).resolves.toEqual(withoutBuild);
  });

  it('drops an additive release-identity annotation instead of returning it', async () => {
    const { client } = createFakeClient({
      'POST /api/app/operations/diagnostics.app': {
        body: {
          ...appDiagnostics(),
          build: { releaseTag: null, sourceCommit: null, note: 'inert future metadata' },
        },
      },
    });

    const result = await client.operations['diagnostics.app']({});
    expect(result.build).toEqual({ releaseTag: null, sourceCommit: null });
    expect(result.build).not.toHaveProperty('note');
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
          token: 'as_00000000-0000-78f3-bdfb-13f04d6a5a83',
          user: {
            id: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0',
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
    ).resolves.toMatchObject({ user: { id: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0' } });
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
          session: { id: 'as_00000000-0000-78be-889a-02eee50dd060' },
          user: {
            id: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0',
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
      user: { id: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0' },
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
          user: { id: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0', email: 'user@example.com' },
          session: { id: 'as_00000000-0000-78be-889a-02eee50dd060' },
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
      client.operations['automation.delete']({
        automationId: 'auto_00000000-0000-7934-bc11-14512d3a737a',
      })
    ).resolves.toBeNull();
  });

  it('preserves typed API errors for delete failures', async () => {
    const { client } = createFakeClient({
      'POST /api/app/operations/automation.delete': {
        body: {
          ...apiError('automation_not_found', 'Automation not found.'),
          details: { automationId: 'auto_00000000-0000-7934-bc11-14512d3a737a' },
          path: ['automationId'],
          requestId,
        },
        status: 404,
      },
    });

    await expect(
      client.operations['automation.delete']({
        automationId: 'auto_00000000-0000-7934-bc11-14512d3a737a',
      })
    ).rejects.toMatchObject({
      code: 'automation_not_found',
      details: { automationId: 'auto_00000000-0000-7934-bc11-14512d3a737a' },
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
          protocolVersion: '0.6.0',
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
          protocolVersion: '0.6.0',
          capabilities: [],
          eventFamilies: [],
        });
      },
    });

    await client.core.meta();
    const iterator = client.core
      .subscribeTurnEvents({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      })
      [Symbol.asyncIterator]();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(fetchCalls).toEqual(['https://nanocore.test/api/meta']);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe(
      'https://nanocore.test/api/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/events?turnId=tu_00000000-0000-77e3-bfde-66477d556f64&since=0'
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
                agentSessionId: 'as_00000000-0000-7860-9e37-d1a60b30c856',
                status: 'completed',
                completedAt: timestamp,
              },
            },
          },
        ]),
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    })[Symbol.asyncIterator]();
    const source = FakeEventSource.instances[0]!;

    source.emit('message', agentSessionEvent(1));
    source.emit('message', {
      ...terminal,
      data: {
        ...terminal.data,
        turn: {
          ...turn(),
          agentSessionId: 'as_00000000-0000-7860-9e37-d1a60b30c856',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
        'https://nanocore.test/api/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/events?turnId=tu_00000000-0000-77e3-bfde-66477d556f64&since=4',
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
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
        'https://nanocore.test/api/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/events?turnId=tu_00000000-0000-77e3-bfde-66477d556f64&since=0'
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
          protocolVersion: '0.6.0',
          capabilities: [],
          eventFamilies: [],
        });
      },
      headers: {
        authorization: 'Bearer deployment-token',
        cookie: 'better-auth.as_00000000-0000-78f3-bdfb-13f04d6a5a83=session-value',
      },
    });

    await jsonClient.core.meta();

    expect(jsonRequests[0]?.headers).toMatchObject({
      authorization: 'Bearer deployment-token',
      cookie: 'better-auth.as_00000000-0000-78f3-bdfb-13f04d6a5a83=session-value',
    });

    const sseClient = createCoreClient({
      baseUrl: 'https://nanocore.test',
      fetch: async (_input, init) => {
        expect(headersToRecord(init?.headers)).toMatchObject({
          accept: 'text/event-stream',
          authorization: 'Bearer deployment-token',
          cookie: 'better-auth.as_00000000-0000-78f3-bdfb-13f04d6a5a83=session-value',
        });

        return sseResponse([turnEvent(1, 'turn.completed')]);
      },
      headers: {
        authorization: 'Bearer deployment-token',
        cookie: 'better-auth.as_00000000-0000-78f3-bdfb-13f04d6a5a83=session-value',
      },
    });

    const iterator = sseClient.core
      .subscribeTurnEvents({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        })
        [Symbol.asyncIterator]()
        .next()
    ).resolves.toEqual({ value: undefined, done: true });
    await expect(
      failingClient.core
        .subscribeTurnEvents({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        })
        [Symbol.asyncIterator]()
        .next()
    ).rejects.toMatchObject({ code: 'stream_failed', status: 503 });
    await expect(
      rejectedClient.core
        .subscribeTurnEvents({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const iterator = stream[Symbol.asyncIterator]();
    const source = FakeEventSource.instances[0]!;

    expect(source.url).toBe(
      '/api/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/events?turnId=tu_00000000-0000-77e3-bfde-66477d556f64&since=0'
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
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      url: '/api/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/events?turnId=tu_00000000-0000-77e3-bfde-66477d556f64&since=4',
    });
  });

  it('discards queued EventSource events when embedded Turn validation fails', async () => {
    FakeEventSource.instances = [];
    const iterator = subscribeTurnEvents({
      baseUrl: '',
      eventSource: FakeEventSource,
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const iterator = stream[Symbol.asyncIterator]();
    const source = FakeEventSource.instances[0]!;
    source.emit('message', pseudoTerminal);
    source.emit('error', null);
    const reopenedSource = FakeEventSource.instances[1]!;
    expect(reopenedSource.url).toBe(
      'https://nanocore.test/api/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/events?turnId=tu_00000000-0000-77e3-bfde-66477d556f64&since=5'
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
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      url: 'https://nanocore.test/api/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/events?turnId=tu_00000000-0000-77e3-bfde-66477d556f64&since=0',
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
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    })[Symbol.asyncIterator]();
    const supersededSource = FakeEventSource.instances[0]!;

    supersededSource.emit('error', null);
    const stateBeforeReturn = FakeEventSource.instances.map(({ closed, url }) => ({ closed, url }));
    await iterator.return?.();

    expect(stateBeforeReturn).toEqual([
      {
        closed: true,
        url: 'https://nanocore.test/api/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/events?turnId=tu_00000000-0000-77e3-bfde-66477d556f64&since=0',
      },
      {
        closed: false,
        url: 'https://nanocore.test/api/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/events?turnId=tu_00000000-0000-77e3-bfde-66477d556f64&since=0',
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
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      referenceId: 'vault_00000000-0000-7be8-b8c8-3d3005ec3f3c',
      secretKind: 'github-token',
      status: 'active',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    };
    const grant = workspaceVaultGrantsResponse().items[0]!;
    const { client, requests } = createFakeClient({
      'POST /api/app/operations/vault.secret-create': { body: reference },
      'POST /api/app/operations/vault.secret-rotate': {
        body: { ...reference, currentVersion: 2 },
      },
      'POST /api/app/operations/vault.secret-revoke': {
        body: { ...reference, status: 'revoked' },
      },
      'POST /api/app/operations/vault.grant-create': { body: grant },
      'POST /api/app/operations/vault.grant-revoke': { body: { ...grant, status: 'revoked' } },
    });
    await expect(
      client.operations['vault.secret-create']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ...{
          secretKind: 'github-token',
          material: 'test-canary',
        },
      })
    ).resolves.toEqual(reference);
    await expect(
      client.operations['vault.secret-rotate']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        referenceId: 'vault_00000000-0000-7be8-b8c8-3d3005ec3f3c',
        ...{ material: 'next-canary' },
      })
    ).resolves.toMatchObject({ currentVersion: 2 });
    await client.operations['vault.grant-create']({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      ...{ referenceId: 'vault_00000000-0000-7be8-b8c8-3d3005ec3f3c' },
    });
    await client.operations['vault.grant-revoke']({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      grantId: 'grant_00000000-0000-7fe9-9377-b84721e910b4',
    });
    await client.operations['vault.secret-revoke']({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      referenceId: 'vault_00000000-0000-7be8-b8c8-3d3005ec3f3c',
    });
    expect(requests[0]?.body).toEqual({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
    await expect(
      client.operations['usage.read']({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001' })
    ).resolves.toEqual(payload);
  });
});
