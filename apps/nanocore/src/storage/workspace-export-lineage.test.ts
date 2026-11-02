import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RuntimeEvidenceRecordSchema } from '@openkit/app-api-schemas';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import {
  ArtifactSchema,
  ArtifactVersionRecordSchema,
  canonicalJsonText,
  PROTOCOL_VERSION,
  writeRetainedV1,
} from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { serializeArtifactReviewFollowUpRequest } from '../artifact-review-follow-up.js';
import {
  deriveArtifactReviewFollowUpTurnId,
  deriveArtifactReviewId,
  deriveArtifactReviewWorkerRequestId,
} from '../artifact-reviews.js';
import {
  importWorkspaceCapabilityUsageLedger,
  listWorkspaceCapabilityCalls,
} from '../capability/usage-ledger.js';
import { parseJsoncObject } from '../config/jsonc.js';
import {
  buildWorkerContextPackageWorkspaceInput,
  createWorkerContextPackageFiles,
  createWorkerContextPackagePolicyDigest,
  createWorkerContextPackageTrace,
  parseWorkerContextPackageTrace,
  serializeWorkerContextPackageTrace,
} from '../context/worker-context-package.js';
import {
  createStructuredWorkerDelegationRequest,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from '../knowledge/okf.js';
import { snapshotDigest } from '../runtime/aep-snapshot-ledger.js';
import {
  canonicalMcpToolSchemas,
  mcpToolSchemaContentDigest,
} from '../runtime/mcp-tool-schema-snapshots.js';
import { createWorkerRuntimeProvenanceEvidenceId } from '../runtime/runtime-evidence.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import {
  knowledgePageFixture,
  serializeKnowledgePageFixture,
} from '../test-support/knowledge-page.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { publishArtifactVersionRecord } from './artifacts/artifact-version-records.js';
import { openWorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';
import {
  verifyWorkspaceExportTree,
  WORKSPACE_EXPORT_MANIFEST_FILE,
  type WriteWorkspaceExportTreeInput,
  writeWorkspaceExportTree,
} from './workspace-export.js';
import { artifactReferenceItemId, parseOwnedKnowledgePage } from './workspace-file-records.js';
import { writeWorkspacePortableFileState } from './workspace-portable-file-state.js';

const timestamp = '2026-07-12T00:00:00.000Z';
/** Reopens the compact trace through the same exact manifest bytes carried by portability. */
function readRetainedContextTrace(text: string, files: ReadonlyMap<string, string>) {
  const trace = JSON.parse(text);
  const path = `threads/${trace.threadId}/turns/${trace.turnId}/context-package/package.json`;
  const manifest = files.get(path);
  if (manifest === undefined) throw new Error('The retained Context manifest is missing.');
  return parseWorkerContextPackageTrace(trace, Buffer.from(manifest, 'utf8'));
}

const source = {
  approvalId: 'apr_source',
  approvalItemId: 'it_00000000-0000-75b1-b567-8dba93fffe22',
  artifactId: 'ar_00000000-0000-7e0d-8050-96f36ec9a01f',
  goalId: 'goal_source',
  grantId: 'grant_00000000-0000-71be-bfe5-1605cc1e0b9b',
  itemId: 'it_00000000-0000-7cab-8553-ff29f1f63940',
  knowledgeBaseId: 'kb_00000000-0000-7000-8000-000000000003',
  intentItemId: 'it_00000000-0000-7142-be4d-40072e2d9c43',
  planItemId: 'it_00000000-0000-71d5-ae7d-8065ab8c1eac',
  sessionId: 'as_00000000-0000-7d81-8a02-21a51fa74819',
  taskId: 'task_source',
  threadId: 'th_00000000-0000-76e4-9cab-bf0f18349249',
  turnId: 'tu_00000000-0000-72a5-8d51-50bb4c19b084',
  workspaceId: 'ws_00000000-0000-71b1-9af2-985861a05396',
} as const;

/** Extends fixed descriptive source objects; the declared backend summary remains an open consumed map. */
function annotateSyncSource(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(annotateSyncSource);
  if (value && typeof value === 'object')
    return Object.fromEntries([
      ...Object.entries(value).map(([key, child]) => [
        key,
        key === 'backendHandleSummary' ? child : annotateSyncSource(child),
      ]),
      ['futureAnnotation', 'portable observation'],
    ]);
  return value;
}

/** Publishes an explicitly created fixture v1 through the immutable version owner before any export. */
function retainInitialArtifact(workspaceRoot: string, value: unknown, actor: unknown): void {
  const artifact = ArtifactSchema.parse(value);
  if (artifact.version !== 1) throw new Error('The fixture producer requires an initial Artifact.');
  publishArtifactVersionRecord({
    workspaceRoot,
    record: ArtifactVersionRecordSchema.parse({
      artifact,
      version: {
        parentVersion: null,
        actor: artifact.origin.kind === 'imported' ? artifact.origin.actor : actor,
        threadId: artifact.threadId,
        turnId: artifact.turnId,
        requestId: artifact.lastMutationRequestId,
        recordedAt: artifact.updatedAt,
      },
    }),
  });
}

/** Builds one export containing every auxiliary record family that refers to canonical history. */
async function createLineageExportInput(
  missing?:
    | 'aep-item'
    | 'aep-session'
    | 'capability-thread'
    | 'checkpoint-turn'
    | 'evidence-goal'
    | 'git-approval'
    | 'goal-item'
    | 'permission-approval'
    | 'repository-grant'
    | 'resolved-turn'
    | 'runtime-turn'
    | 'sync-artifact'
    | 'usage-session'
    | 'vault-approval'
    | 'vault-session',
  captureValue: 'off' | 'on' = 'off',
  artifactContent: { format: 'markdown' | 'text'; body: string } = {
    format: 'markdown',
    body: '# Portable',
  }
): Promise<WriteWorkspaceExportTreeInput> {
  const agentSetup = createTestAgentSetup();
  const item = {
    id: source.itemId,
    owner: { kind: 'workspace', workspaceId: source.workspaceId },
    threadId: source.threadId,
    turnId: source.turnId,
    type: 'assistant-message',
    status: 'completed',
    text: 'Portable lineage.',
    createdAt: timestamp,
    completedAt: timestamp,
  };
  const approvalItem = {
    id: source.approvalItemId,
    owner: { kind: 'workspace', workspaceId: source.workspaceId },
    threadId: source.threadId,
    turnId: source.turnId,
    type: 'approval-request',
    status: 'completed',
    causationId: source.itemId,
    approvalRequestId: source.approvalId,
    title: 'Approve portable lineage',
    description: 'Approve the portable operation.',
    kind: 'permission',
    createdAt: timestamp,
    completedAt: timestamp,
  };
  const intentItem = {
    id: source.intentItemId,
    owner: { kind: 'workspace', workspaceId: source.workspaceId },
    threadId: source.threadId,
    turnId: source.turnId,
    type: 'user-message',
    actor: { kind: 'user', id: 'usr_00000000-0000-7431-921d-ea7bcc58a6f2' },
    status: 'completed',
    text: 'Keep lineage portable.',
    createdAt: timestamp,
    completedAt: timestamp,
  };
  const artifact = {
    id: source.artifactId,
    workspaceId: source.workspaceId,
    threadId: source.threadId,
    turnId: source.turnId,
    kind: 'summary',
    title: 'Portable artifact',
    status: 'ready',
    summary: 'Portable artifact.',
    version: 1,
    content: artifactContent,
    contentDigest: `sha256:${createHash('sha256').update(artifactContent.body, 'utf8').digest('hex')}`,
    lastMutationRequestId: 'request_source',
    origin: {
      kind: 'turn-output',
      threadId: source.threadId,
      turnId: source.turnId,
      requestId: 'request_source',
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const artifactReferenceItem = {
    id: artifactReferenceItemId(source.artifactId, source.turnId),
    owner: { kind: 'workspace', workspaceId: source.workspaceId },
    threadId: source.threadId,
    turnId: source.turnId,
    type: 'artifact-reference',
    status: 'completed',
    artifactId: artifact.id,
    artifactVersion: artifact.version,
    lastMutationRequestId: artifact.lastMutationRequestId,
    title: artifact.title,
    summary: artifact.summary,
    createdAt: timestamp,
    completedAt: timestamp,
  };
  const planItem = {
    id: source.planItemId,
    owner: { kind: 'workspace', workspaceId: source.workspaceId },
    threadId: source.threadId,
    turnId: source.turnId,
    type: 'plan',
    status: 'completed',
    title: 'Portable goal plan',
    summary: 'Keep lineage portable.',
    steps: [{ id: source.taskId, title: 'Portable task', status: 'pending' }],
    createdAt: timestamp,
    completedAt: timestamp,
  };
  const turn = {
    id: source.turnId,
    owner: { kind: 'workspace', workspaceId: source.workspaceId },
    threadId: source.threadId,
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const,
    items: [item, planItem, artifactReferenceItem, approvalItem, intentItem],
    status: 'completed',
    error: null,
    configVersion: null,
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 1,
  };
  const environmentPackage = await resolveAgentEnvironmentPackage({
    captureCoverage: { scope: 'server', value: captureValue },
    agent: {
      id: 'agent_codex_host',
      name: 'Codex Agent',
      kind: 'coder',
      status: 'enabled',
      modelId: null,
      skillIds: [],
      profiles: [
        {
          id: 'default',
          displayName: 'Default',
          instructionsRef: null,
          modelId: null,
          skillIds: [],
          capabilityIds: [],
        },
      ],
      defaultProfileId: 'default',
      capabilities: [],
      sandboxSummary: null,
      config: {
        adapterType: 'codex',
        command: null,
        baseUrl: null,
        workspaceRoot: '/workspace',
        environment: {},
        capabilities: [],
      },
    },
    agentSetup,
    agentSessionId: source.sessionId,
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    userId: 'usr_00000000-0000-7000-8000-000000000001',
    backend: {
      kind: 'openshell',
    },
    requestId: 'request_source',
    turn,
    turnInput: 'Verify portability.',
    workspaceCwd: '/workspace',
    workspaceRoots: [],
  });
  environmentPackage.scope.itemId =
    missing === 'aep-item' ? 'it_00000000-0000-7cd6-8d25-15aa6e49eadb' : source.itemId;
  const session = {
    id: source.sessionId,
    agentId: 'agent_codex_host',
    workspaceId: source.workspaceId,
    threadId: source.threadId,
    status: 'idle',
    message: null,
    sandboxSummary: {
      access: 'read-write',
      workspaceRootRefs: ['repo'],
      summary: 'Source host workspace.',
    },
    configVersion: 7,
    environmentPackageSnapshotId: environmentPackage.snapshotId,
    policySnapshotId: 'policy_source',
    sessionCompatibilityKey: 'sha256:source-session-compatibility',
    stale: false,
    workspaceRoots: [
      {
        id: 'repo',
        sourceKind: 'host-dir',
        sourcePath: '/private/source/workspace',
        workerPath: '/workspace/repo',
        access: 'read-write',
      },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-lineage-'));
  const sourceWorkspaceRoot = join(fixtureRoot, 'source');
  retainInitialArtifact(sourceWorkspaceRoot, artifact, turn.triggerActor);
  onTestFinished(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  return {
    exportRoot: join(fixtureRoot, 'export'),
    sourceWorkspaceRoot,
    exportId: 'wsexp_00000000-0000-79ba-8f8a-90eaf5674095',
    sourceDeploymentId: 'dep_00000000-0000-7737-8fe7-61ca07c79d45',
    createdAt: timestamp,
    workspace: {
      id: source.workspaceId,
      name: 'Lineage workspace',
      kind: 'general',
      status: 'active',
      counts: { threadCount: 1, artifactCount: 1, knowledgeEntryCount: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    portableFileState: {
      nativeKnowledgePages: new Map(),
      retrievalTraceFiles: new Map(),
      workerContextPackageFiles: new Map(),
      workspaceConfig: JSON.stringify({
        schemaVersion: 1,
        workspace: {
          name: 'Lineage workspace',
          defaultAgentId: null,
          defaultKnowledgeBaseId: source.knowledgeBaseId,
          knowledgeMounts: [
            {
              name: 'raw',
              knowledgeBaseId: source.knowledgeBaseId,
              default: true,
              backend: 'local',
              root: 'raw',
            },
          ],
        },
      }),
      workspaceSchema: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
    },
    threads: [
      {
        id: source.threadId,
        owner: { kind: 'workspace', workspaceId: source.workspaceId },
        name: 'Lineage thread',
        preview: 'Lineage thread',
        entryPath: 'conversation',
        visibility: 'workspace',
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    turns: [turn],
    knowledge: [],
    dataSourceCatalog: {
      schemaVersion: 1,
      requiredFeatures: [],
      extensions: {},
      sources: [
        {
          id: 'portable-repository',
          kind: 'git',
          displayName: 'Portable repository source',
          locator: { url: 'https://example.com/openkit.git' },
          access: 'read-only',
          sensitivity: 'internal',
          vaultGrantRef: source.grantId,
          allowedSlotKinds: ['worktree'],
          syncHints: {},
          status: 'active',
          requiredFeatures: [],
          extensions: {},
        },
      ],
    },
    itemRevisions: [item, planItem, artifactReferenceItem, approvalItem, intentItem],
    artifacts: [artifact],
    artifactReviews: [],
    threadMaterialBindings: [],
    workspaceMaterialRevisions: [],
    workspaceMaterials: [],
    agentSessions: [session],
    turnEvents: [],
    resolvedAgentSetups: [
      {
        id: 'ras_source',
        workspaceId: source.workspaceId,
        turnId:
          missing === 'resolved-turn' ? 'tu_00000000-0000-7577-9378-7e96d0d15fd2' : source.turnId,
        requestId: 'request_source',
        agentId: 'agent_codex_host',
        logicalModelId: agentSetup.logicalModels.preferredLogicalModelId,
        runtimeKind: 'codex',
        runtimeAdapter: 'codex-app-server',
        requiredFeatures: [],
        setup: {
          manifest: {
            id: agentSetup.manifest.id,
            requiredFeatures: agentSetup.manifest.requiredFeatures,
            runtime: agentSetup.manifest.runtime,
            sandbox: {
              credentialDeclarations: agentSetup.manifest.sandbox.credentialDeclarations,
              network: agentSetup.manifest.sandbox.network,
            },
          },
          logicalModels: {
            preferredLogicalModelId: agentSetup.logicalModels.preferredLogicalModelId,
            allowed: agentSetup.logicalModels.allowed.map((model) => ({
              id: model.id,
              capabilities: model.capabilities,
              modelFamilyId: model.modelFamilyId,
            })),
          },
        },
        createdAt: timestamp,
      },
    ],
    agentEnvironmentPackageSnapshots: [
      {
        snapshotId: environmentPackage.snapshotId,
        workspaceId: source.workspaceId,
        turnId: source.turnId,
        threadId: source.threadId,
        agentSessionId:
          missing === 'aep-session' ? 'as_00000000-0000-7fdd-8f71-4a23eb7a922b' : source.sessionId,
        agentId: environmentPackage.agent.agentId,
        packageId: environmentPackage.packageId,
        runtimeKind: environmentPackage.agent.runtimeKind,
        backendKind: environmentPackage.backend.preferred,
        contentDigest: createHash('sha256')
          .update(JSON.stringify(environmentPackage))
          .digest('hex'),
        snapshot: environmentPackage,
        createdAt: timestamp,
      },
    ],
    capabilityCalls: [
      {
        id: 'cap_00000000-0000-711a-9c64-db220d6b90dc',
        owner: { kind: 'workspace', workspaceId: source.workspaceId },
        threadId:
          missing === 'capability-thread'
            ? 'th_00000000-0000-70ca-938d-c2a0530f9882'
            : source.threadId,
        turnId: source.turnId,
        itemId: source.itemId,
        agentId: 'agent_codex_host',
        agentSessionId: source.sessionId,
        requestId: null,
        sourceIds: [],
        capabilityId: 'runtime.worker_turn',
        status: 'succeeded',
        summary: 'Portable capability call.',
        errorCode: null,
        startedAt: timestamp,
        completedAt: timestamp,
        family: 'runtime',
        operation: 'worker.checkpoint.terminal',
        providerRef: null,
        serviceRef: null,
        redactionClass: 'metadata-only',
      },
    ],
    usageRecords: [
      {
        id: 'use_00000000-0000-7833-a8fc-60af429f21b9',
        workspaceId: source.workspaceId,
        responsibleUserId: 'usr_00000000-0000-7431-921d-ea7bcc58a6f2',
        threadId: source.threadId,
        turnId: source.turnId,
        itemId: source.itemId,
        capabilityCallId: 'cap_00000000-0000-711a-9c64-db220d6b90dc',
        requestId: null,
        agentId: 'agent_codex_host',
        agentSessionId:
          missing === 'usage-session'
            ? 'as_00000000-0000-7fdd-8f71-4a23eb7a922b'
            : source.sessionId,
        sourceIds: [],
        category: 'runtime',
        unit: 'sandbox_sessions',
        quantity: 1,
        modelId: null,
        providerRef: null,
        source: 'worker-checkpoint-terminal',
        recordedAt: timestamp,
      },
    ],
    evidenceBundles: [
      {
        id: 'evb_source',
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        goalId: missing === 'evidence-goal' ? 'goal_missing' : source.goalId,
        turnId: source.turnId,
        agentSessionId: source.sessionId,
        backendType: 'openshell',
        sourceKind: 'worker',
        summary: 'Portable evidence bundle.',
        rawEvidenceRefs: [
          { kind: 'thread', ref: source.threadId },
          { kind: 'turn', ref: source.turnId },
          {
            kind: 'goal',
            ref: missing === 'evidence-goal' ? 'goal_missing' : source.goalId,
          },
          { kind: 'artifact', ref: source.artifactId },
        ],
        redactedEvidenceRefs: [{ kind: 'worker', ref: source.turnId }],
        contentDigests: ['sha256:evidence'],
        retentionClass: 'turn-evidence',
        sensitivityClass: 'product-safe',
        importStatus: 'verified',
        requiredFeatures: ['evidence.bundle.v1'],
        createdAt: timestamp,
      },
    ],
    runtimeEvidence: [
      {
        id: 'rte_source',
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        turnId:
          missing === 'runtime-turn' ? 'tu_00000000-0000-7577-9378-7e96d0d15fd2' : source.turnId,
        goalId: source.goalId,
        taskId: null,
        agentSessionId: source.sessionId,
        backendType: 'openshell',
        backendVersion: null,
        placement: 'local',
        phase: 'teardown',
        summary: 'Portable runtime evidence.',
        policyDigest: null,
        workerImage: null,
        sandboxSummary: null,
        capabilitySummary: null,
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
        startedAt: timestamp,
        completedAt: timestamp,
        collectedAt: timestamp,
      },
    ],
    workerCheckpoints: [
      {
        checkpointId: `${source.workspaceId}:${source.threadId}:${source.turnId}`,
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        turnId:
          missing === 'checkpoint-turn' ? 'tu_00000000-0000-7577-9378-7e96d0d15fd2' : source.turnId,
        goalId: null,
        taskId: null,
        requestId: 'request_source',
        requestInputHash: 'sha256:request-source',
        stage: 'running_worker',
        iteration: 1,
        workerSessionId: missing ? null : source.sessionId,
        contextDigest: 'sha256:context',
        stopReason: null,
        diagnosticsSummary: null,
        replayInstruction: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    gitPushRecords: [
      {
        id: 'gpr_source',
        workspaceId: source.workspaceId,
        repositoryResourceId: 'repo_source',
        approvalRowId: missing === 'git-approval' ? 'apr_missing' : source.approvalId,
        policyDecisionId: 'pd_00000000-0000-71e9-8af0-d6fdfffbf30e',
        actorId: 'usr_00000000-0000-7000-8000-000000000001',
        remoteSummary: 'Portable repository origin',
        sourceRef: 'HEAD',
        targetBranch: 'main',
        commitIds: ['abc123'],
        reviewIds: [],
        remoteHeadBefore: 'abc000',
        remoteHeadAfter: 'abc123',
        outcome: 'pushed',
        errorSummary: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        requestId: '00000000-0000-4000-8000-000000000001',
      },
    ],
    permissionDecisions: [
      {
        action: 'runtime.launch',
        approvalId: missing === 'permission-approval' ? 'apr_missing' : source.approvalId,
        auditEventId: null,
        contextSummary: {},
        createdAt: timestamp,
        decisionId: 'pd_00000000-0000-71e9-8af0-d6fdfffbf30e',
        enforcementPoint: 'worker.launch',
        ownerScope: 'workspace',
        policyEngineVersion: 'nanocore-policy:v1',
        policySnapshotId: 'policy_source',
        reasonCode: 'approved',
        requiredApprovalKind: 'permission',
        resourceSummary: {},
        result: 'allow',
        subjectSummary: {},
        workspaceId: source.workspaceId,
      },
    ],
    workspaceRepositories: [
      {
        resourceId: 'repo_source',
        type: 'git_repository',
        displayName: 'Portable repository',
        git: {
          authorEmail: null,
          authorName: null,
          allowedPushTargets: ['main'],
          commitOnApply: true,
          protectedBranchPatterns: ['main'],
          requireReviewLinkage: true,
          stagingStrategy: 'staging-root',
          vaultGrantRef:
            missing === 'repository-grant'
              ? 'grant_00000000-0000-7278-b714-46e2d53cb316'
              : source.grantId,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    workerOutputManifests: [
      {
        id: 'wom_source',
        workspaceId: source.workspaceId,
        materializationRecordId: 'wmr_source',
        inputSnapshotId: 'wis_source',
        workerSessionId: 'worker_source',
        backendKind: 'openshell',
        strategy: 'git',
        changedPaths: [],
        artifactIds: [
          missing === 'sync-artifact'
            ? 'ar_00000000-0000-7aa2-bfd7-c36b2d13b35a'
            : source.artifactId,
        ],
        logRefs: [],
        testOutputRefs: [],
        ignoredOutputs: [],
        evidenceRefs: [{ kind: 'worker', ref: source.turnId }],
        collectedAt: timestamp,
      },
    ],
    workspaceChangeSets: [
      {
        id: 'wcs_source',
        materializationRecordId: 'wmr_source',
        inputSnapshotId: 'wis_source',
        workspaceId: source.workspaceId,
        resourceId: 'repo_source',
        strategy: 'git',
        base: { commit: 'abc000', contentDigest: null },
        head: { commit: 'abc123', contentDigest: null },
        changedPaths: [],
        patch: null,
        bundle: null,
        artifactIds: [
          missing === 'sync-artifact'
            ? 'ar_00000000-0000-7aa2-bfd7-c36b2d13b35a'
            : source.artifactId,
        ],
        evidenceRefs: [{ kind: 'worker', ref: source.turnId }],
        redaction: { status: 'no-sensitive-content-found', notes: [] },
        createdAt: timestamp,
      },
    ],
    vaultReferences: [
      {
        sourceReferenceId: 'vault_00000000-0000-7845-abcc-649025182be0',
        displayName: 'Portable secret',
        secretKind: 'api-key',
        backendKind: 'encrypted-file',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    vaultGrants: [
      {
        grantId: source.grantId,
        issuance: 'target',
        vaultReferenceId: 'vault_00000000-0000-7845-abcc-649025182be0',
        ownerScope: 'workspace',
        workspaceId: source.workspaceId,
        userId: null,
        subjectSummary: null,
        targetAgentId: null,
        targetAgentSessionId:
          missing === 'vault-session'
            ? 'as_00000000-0000-7fdd-8f71-4a23eb7a922b'
            : source.sessionId,
        targetCapabilityId: null,
        allowedInjectionPaths: [],
        lifetime: 'agent-session',
        policyDecisionId: null,
        approvalId: missing === 'vault-approval' ? 'apr_missing' : source.approvalId,
        status: 'active',
        createdAt: timestamp,
        expiresAt: null,
      },
    ],
  };
}

/**
 * Builds one complete source Material, Review, and S39 portability graph.
 *
 * @param followUp Optional exact Artifact Review follow-up fixture.
 * @param sourceSnapshotRoot Optional original snapshot fixture root.
 * @param retainRepresentation Whether the binary source retains a separate UTF-8 representation.
 * @param knowledgeExcerpt Whether to retain an excerpt of the selected Knowledge page.
 * @param includeKnowledgeOverview Whether to retain the Workspace-only index overview delivery.
 * @param artifactFormat Actual initial media used by the proposal compatibility fixture.
 * @returns Complete export fixture covering the accepted work-resource lineage.
 * @throws Error when the structured worker request or package fixture cannot be built.
 */
async function createWorkResourceLineageExportInput(
  followUp?: {
    artifactMediaType?: 'text/markdown' | 'text/plain' | 'application/json';
    decisionRequestId?: string;
  },
  sourceSnapshotRoot?: string,
  retainRepresentation = false,
  knowledgeExcerpt = false,
  includeKnowledgeOverview = false,
  artifactFormat: 'markdown' | 'text' = 'markdown',
  knowledgeExclusion?: 'current' | 'legacy'
): Promise<WriteWorkspaceExportTreeInput> {
  const appliedContent = '# Portable\n';
  const input = await createLineageExportInput(undefined, 'off', {
    format: artifactFormat,
    body: appliedContent,
  });
  const materialId = 'mat_00000000-0000-7807-b767-6378f3fcdcf3';
  const baseRevisionId = 'mrev_00000000-0000-72e5-99f1-5042ef903012';
  const appliedRevisionId = 'mrev_00000000-0000-713f-80f9-10c92c9be966';
  const baseContent = '# Portable base\n';
  const baseContentDigest = `sha256:${createHash('sha256').update(baseContent).digest('hex')}`;
  const appliedContentDigest = `sha256:${createHash('sha256').update(appliedContent).digest('hex')}`;
  const knowledgePageId = 'knowledge_portable_source';
  const knowledgeSourceRefs: string[] = [];
  const knowledgeContent = serializeKnowledgePageFixture(
    {
      title: 'Retained portable Knowledge',
      content:
        '# Retained portable knowledge\n\nUse the retained package bytes.\n' +
        (knowledgeExcerpt ? 'Omitted canonical Knowledge body.\n'.repeat(3000) : ''),
      sourceReferences: knowledgeSourceRefs,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    { kind: 'workspace', workspaceId: source.workspaceId }
  );
  const knowledgeContentDigest = `sha256:${createHash('sha256')
    .update(knowledgeContent)
    .digest('hex')}`;
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(
      sourceSnapshotRoot ?? join(dirname(input.exportRoot), 'source'),
      'knowledge',
      'notebook.git'
    ),
  });
  const notebookRevision = notebook.initialize({
    files: { [`${knowledgePageId}.md`]: knowledgeContent },
    metadata: {
      summary: 'Current Notebook archive fixture',
      producer: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
      authority: { kind: 'direct', instructionReference: 'test:current-notebook-s39' },
      changeRequest: { requestId: randomUUID(), inputDigest: knowledgeContentDigest },
      sourceReferences: knowledgeSourceRefs,
    },
  });
  const notebookFiles = notebook.readRevision(notebookRevision).files;
  onTestFinished(() => rmSync(dirname(input.exportRoot), { recursive: true, force: true }));
  input.knowledge = [
    parseOwnedKnowledgePage(`${knowledgePageId}.md`, knowledgePageId, knowledgeContent),
  ];
  input.workspace = {
    ...input.workspace,
    counts: { ...input.workspace.counts, knowledgeEntryCount: input.knowledge.length },
  };
  const retrievalTraceId = 'krt_00000000-0000-780e-b78f-51422afca1e9';
  const workerRequest = serializeStructuredWorkerDelegationRequest(
    createStructuredWorkerDelegationRequest({
      acceptanceCriteria: ['Preserve the portable Material graph.'],
      constraints: { maxContextTokens: 4_096, maxWorkerIterations: 1 },
      contextRefs: [
        { kind: 'workspace', id: source.workspaceId },
        { kind: 'thread', id: source.threadId },
      ],
      escalationConditions: [],
      expectedArtifacts: [{ kind: 'artifact', description: 'Portable proposal.' }],
      objective: 'Produce one portable Material proposal.',
      resources: [
        { kind: 'artifact', reference: source.artifactId, reason: 'Proposal output.' },
        {
          kind: 'policy',
          resource: {
            kind: 'mcp-tool',
            workspaceId: source.workspaceId,
            serverId: 'sis',
            toolName: 'read',
          },
          reason: 'Retain the exact Tool selector without an imported grant.',
        },
        {
          kind: 'policy',
          resource: {
            kind: 'container',
            container: {
              owner: { kind: 'workspace', workspaceId: source.workspaceId },
              kind: 'thread',
              id: source.threadId,
            },
          },
          reason: 'Retain the exact Thread selector.',
        },
        {
          kind: 'policy',
          resource: {
            kind: 'container',
            container: {
              owner: { kind: 'workspace', workspaceId: source.workspaceId },
              kind: 'turn',
              id: source.turnId,
            },
          },
          reason: 'Retain the exact Turn selector.',
        },
      ],
      reviewContext: null,
      reviewPolicy: {
        instructions: 'Review the exact proposal.',
        required: true,
        reviewers: ['human'],
      },
      verification: [{ kind: 'manual', description: 'Inspect the imported graph.' }],
    })
  );
  input.threads = input.threads.map((thread) => ({ ...thread, preview: workerRequest }));
  const sourceThread = input.threads[0]!;
  const requestItem = {
    ...(input.itemRevisions.find(
      (candidate) => (candidate as { id?: string }).id === source.itemId
    ) as Record<string, unknown>),
    type: 'user-message',
    actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    text: workerRequest,
  };
  input.itemRevisions = input.itemRevisions.map((candidate) =>
    (candidate as { id?: string }).id === source.itemId ? requestItem : candidate
  );
  input.turns = input.turns.map((candidate) => ({
    ...(candidate as Record<string, unknown>),
    agentId: 'agent_codex_host',
    agentSessionId: source.sessionId,
    items: (candidate as { items: Array<Record<string, unknown>> }).items.map((item) =>
      item.id === source.itemId ? requestItem : item
    ),
  }));
  input.turnEvents = [
    [
      source.turnId,
      [
        {
          protocolVersion: PROTOCOL_VERSION,
          event: 'thread.created',
          sequence: 1,
          requestId: null,
          timestamp,
          workspaceId: source.workspaceId,
          threadId: source.threadId,
          turnId: source.turnId,
          data: { type: 'thread-created', thread: sourceThread },
        },
        {
          protocolVersion: PROTOCOL_VERSION,
          event: 'thread.updated',
          sequence: 2,
          requestId: null,
          timestamp,
          workspaceId: source.workspaceId,
          threadId: source.threadId,
          turnId: source.turnId,
          data: { type: 'thread-updated', thread: sourceThread },
        },
        {
          protocolVersion: PROTOCOL_VERSION,
          event: 'item.completed',
          sequence: 3,
          requestId: null,
          timestamp,
          workspaceId: source.workspaceId,
          threadId: source.threadId,
          turnId: source.turnId,
          data: { type: 'item-completed', itemId: source.itemId, item: requestItem },
        },
        {
          protocolVersion: PROTOCOL_VERSION,
          event: 'item.delta',
          sequence: 4,
          requestId: null,
          timestamp,
          workspaceId: source.workspaceId,
          threadId: source.threadId,
          turnId: source.turnId,
          data: {
            type: 'item-delta',
            itemId: artifactReferenceItemId(source.artifactId, source.turnId),
            itemType: 'artifact-reference',
            deltaKind: 'artifact-updated',
            artifactId: source.artifactId,
          },
        },
      ],
    ],
  ];
  const binaryOriginal = Buffer.from([0, 255, 10, 128, 65]);
  const binaryDigest = `sha256:${createHash('sha256').update(binaryOriginal).digest('hex')}`;
  const materialPreview = '# Portable';
  const materialProjection = {
    kind: 'excerpt' as const,
    sourceRevision: baseRevisionId,
    representationId: 'original-utf8',
    representationDigest: baseContentDigest,
    representationByteLength: Buffer.byteLength(baseContent),
    deliveredDigest: `sha256:${createHash('sha256').update(materialPreview).digest('hex')}`,
    ranges: [{ start: 0, end: Buffer.byteLength(materialPreview) }],
    byteLength: Buffer.byteLength(materialPreview),
    truncated: true,
    availability: 'incomplete' as const,
  };
  const representation = `Retained representation preview\n${'Later extracted text\n'.repeat(8)}`;
  const inputDescriptor = retainRepresentation
    ? 'Retained representation preview'
    : JSON.stringify({
        status: 'unavailable',
        reason: 'unsupported',
        source: {
          scopeId: `input/turn/${source.workspaceId}/${source.threadId}/${source.turnId}`,
          objectId: '0',
        },
        originalDigest: binaryDigest,
        byteLength: binaryOriginal.byteLength,
        mediaType: 'application/octet-stream',
      });
  if (sourceSnapshotRoot) {
    cpSync(join(input.sourceWorkspaceRoot!, 'artifacts'), join(sourceSnapshotRoot, 'artifacts'), {
      recursive: true,
    });
    input.sourceWorkspaceRoot = sourceSnapshotRoot;
    input.turns = input.turns.map((turn) => ({
      ...(turn as Record<string, unknown>),
      fileInputs: [
        {
          name: 'binary.dat',
          mediaType: 'application/octet-stream',
          sizeBytes: binaryOriginal.byteLength,
          contentDigest: binaryDigest,
        },
      ],
    }));
    for (const [path, bytes] of [
      [`threads/${source.threadId}/turns/${source.turnId}/inputs/0/payload`, binaryOriginal],
    ] as const) {
      mkdirSync(dirname(join(sourceSnapshotRoot, path)), { recursive: true });
      writeFileSync(join(sourceSnapshotRoot, path), bytes, { mode: 0o444 });
    }
  }
  const packageFiles = createWorkerContextPackageFiles({
    contextBudgetTokens: 4_096,
    includedItemIds: [source.itemId],
    ...(includeKnowledgeOverview
      ? {
          knowledgeOverview: `<knowledge_overviews>${JSON.stringify({
            overviews: [
              {
                scope: `workspace:${source.workspaceId}`,
                knowledgeBaseId: source.knowledgeBaseId,
                path: 'index.md',
                notebookRevision,
                contentDigest: `sha256:${createHash('sha256').update(notebookFiles['index.md']!).digest('hex')}`,
                deliveredDigest: `sha256:${createHash('sha256').update(notebookFiles['index.md']!).digest('hex')}`,
                truncated: false,
                content: notebookFiles['index.md'],
              },
            ],
          })}</knowledge_overviews>`,
        }
      : {}),
    knowledgeSelections: knowledgeExclusion
      ? []
      : [
          {
            content: knowledgeContent,
            contentDigest: knowledgeContentDigest,
            knowledgeBaseId: source.knowledgeBaseId,
            knowledgePageId,
            notebookRevision,
            ...(knowledgeExcerpt
              ? {
                  deliveredContent: knowledgeContent.slice(0, 2048),
                  projection: {
                    kind: 'excerpt' as const,
                    sourceRevision: notebookRevision,
                    representationId: 'original-utf8',
                    representationDigest: knowledgeContentDigest,
                    representationByteLength: Buffer.byteLength(knowledgeContent),
                    deliveredDigest: `sha256:${createHash('sha256').update(knowledgeContent.slice(0, 2048)).digest('hex')}`,
                    ranges: [{ start: 0, end: 2048 }],
                    byteLength: 2048,
                    truncated: true,
                    availability: 'incomplete' as const,
                  },
                }
              : {}),
            sourceRefs: knowledgeSourceRefs,
          },
        ],
    materialSelections: [
      {
        bindingMutationRequestId: 'request_material_bind',
        content: baseContent,
        ...(sourceSnapshotRoot
          ? { deliveredContent: materialPreview, projection: materialProjection }
          : {}),
        contentDigest: baseContentDigest,
        inclusionReason: 'thread_binding',
        materialId,
        mediaType: 'text/markdown',
        parentRevisionId: null,
        revisionId: baseRevisionId,
        sensitivity: 'internal',
      },
    ],
    ...(sourceSnapshotRoot
      ? {
          sourceFiles: [
            {
              source: {
                kind: 'material' as const,
                reference: {
                  scopeId: `material/workspace/${source.workspaceId}`,
                  objectId: materialId,
                },
                revisionId: baseRevisionId,
              },
              originalDigest: baseContentDigest,
              byteLength: Buffer.byteLength(baseContent),
              mediaType: 'text/markdown',

              packagePath: `workspace/materials/${materialId}/${baseRevisionId}.md`,
              projection: materialProjection,
              deliveredBytes: Buffer.from(materialPreview),
              async *open() {
                yield Buffer.from(baseContent);
              },
              assertUnchanged() {},
            },
            {
              source: {
                kind: 'turn-input' as const,
                reference: {
                  scopeId: `input/turn/${source.workspaceId}/${source.threadId}/${source.turnId}`,
                  objectId: '0',
                },
              },
              originalDigest: binaryDigest,
              byteLength: binaryOriginal.byteLength,
              mediaType: 'application/octet-stream',

              packagePath: 'sources/turn-inputs/0.txt',
              projection: {
                kind: retainRepresentation ? ('excerpt' as const) : ('descriptor' as const),
                sourceRevision: '0',
                representationId: retainRepresentation
                  ? 'retained-text-fixture-v1'
                  : 'unavailable-original-view-v1',
                representationDigest: retainRepresentation
                  ? `sha256:${createHash('sha256').update(representation).digest('hex')}`
                  : binaryDigest,
                representationByteLength: retainRepresentation
                  ? Buffer.byteLength(representation)
                  : binaryOriginal.byteLength,
                deliveredDigest: `sha256:${createHash('sha256').update(inputDescriptor).digest('hex')}`,
                ranges: retainRepresentation
                  ? [{ start: 0, end: Buffer.byteLength(inputDescriptor) }]
                  : [],
                byteLength: Buffer.byteLength(inputDescriptor),
                truncated: true,
                availability: retainRepresentation
                  ? ('incomplete' as const)
                  : ('unavailable' as const),
              },
              deliveredBytes: Buffer.from(inputDescriptor),
              ...(retainRepresentation
                ? {
                    async *openRepresentation() {
                      yield Buffer.from(representation);
                    },
                  }
                : {}),
              async *open() {
                yield binaryOriginal;
              },
              assertUnchanged() {},
            },
          ],
        }
      : {}),
    threadId: source.threadId,
    turnId: source.turnId,
    workerRequestBytes: workerRequest,
    workerRequestItemId: source.itemId,
    workspaceId: source.workspaceId,
  });
  const snapshotRecord = input.agentEnvironmentPackageSnapshots?.[0];
  if (!snapshotRecord) {
    throw new Error('Work-resource fixture requires one AEP snapshot.');
  }
  const sourceSnapshot = AgentEnvironmentPackageSchema.parse(snapshotRecord.snapshot);
  const snapshot = AgentEnvironmentPackageSchema.parse({
    ...sourceSnapshot,
    workspace: {
      ...sourceSnapshot.workspace,
      inputs: [
        buildWorkerContextPackageWorkspaceInput({
          agentSessionId: source.sessionId,
          packageRootDigest: packageFiles.packageRootDigest,
          threadId: source.threadId,
          turnId: source.turnId,
        }),
      ],
    },
  });
  input.agentEnvironmentPackageSnapshots = [
    {
      ...snapshotRecord,
      contentDigest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
      snapshot,
    },
  ];
  const trace = createWorkerContextPackageTrace({
    agentSessionId: source.sessionId,
    excludedItems: [],
    goalId: null,
    knowledgeSelectionInput: {
      retrievalTraceRef: {
        scopeId: `retrieval-trace/turn/${source.workspaceId}/${source.threadId}/${source.turnId}`,
        objectId: retrievalTraceId,
      },
    },
    knowledgeExclusions: knowledgeExclusion
      ? [
          {
            knowledgeBaseId: source.knowledgeBaseId,
            knowledgePageId,
            contentDigest: knowledgeContentDigest,
            reason: 'budget_exceeded',
            ...(knowledgeExclusion === 'current' ? { notebookRevision } : {}),
          },
        ]
      : [],
    packageFiles,
    packageSnapshotId: snapshot.snapshotId,
    requestId: 'request_source',
    taskId: null,
  });
  const workspaceInputSnapshot = {
    backend: {
      capabilitySummary: [...snapshot.backend.requiredCapabilities],
      kind: 'openshell' as const,
      label: 'openshell worker backend',
    },
    base: { commit: null, contentDigest: packageFiles.packageRootDigest },
    createdAt: timestamp,
    generatedFiles: [],
    id: trace.workspaceInputSnapshotId,
    ignoredPaths: [],
    pathScope: [`context_${source.turnId}`],
    resourceId: `context_${source.turnId}`,
    resourceKind: 'filesystem' as const,
    strategy: 'filesystem' as const,
    workspaceId: source.workspaceId,
    writableRoots: [],
  };
  const workerSessionId = 'worker_source';
  input.workspaceInputSnapshots = [workspaceInputSnapshot];
  input.workspaceMaterializationRecords = [
    {
      backendKind: 'openshell',
      base: workspaceInputSnapshot.base,
      createdAt: timestamp,
      id: trace.workspaceMaterializationRecordId,
      inputSnapshotId: trace.workspaceInputSnapshotId,
      materializedRootRef: `/openkit/sessions/${source.sessionId}/context`,
      packageSnapshotId: snapshot.snapshotId,
      policyDigest: createWorkerContextPackagePolicyDigest({
        backendKind: 'openshell',
        packageSnapshotId: snapshot.snapshotId,
        requiredCapabilities: snapshot.backend.requiredCapabilities,
      }),
      readinessEvidence: [
        { kind: 'backend.ready', ref: 'version:0.0.80' },
        { kind: 'sandbox.created', ref: workerSessionId },
      ],
      strategy: 'filesystem',
      workerSessionId,
      workspaceId: source.workspaceId,
    },
  ];
  input.workspaceMaterials = [
    {
      createdAt: timestamp,
      currentRevisionId: appliedRevisionId,
      kind: 'markdown',
      lastMutationRequestId: 'request_review_accept',
      materialId,
      sensitivity: 'internal',
      title: 'Portable Material',
      updatedAt: timestamp,
      workspaceId: source.workspaceId,
    },
  ];
  input.workspaceMaterialRevisions = [
    {
      authorId: 'usr_00000000-0000-7000-8000-000000000001',
      content: baseContent,
      contentDigest: baseContentDigest,
      createdAt: timestamp,
      createdByRequestId: 'request_material_base',
      materialId,
      mediaType: 'text/markdown',
      parentRevisionId: null,
      revisionId: baseRevisionId,
      workspaceId: source.workspaceId,
    },
    {
      authorId: 'usr_00000000-0000-7000-8000-000000000001',
      content: appliedContent,
      contentDigest: appliedContentDigest,
      createdAt: timestamp,
      createdByRequestId: 'request_review_accept',
      materialId,
      mediaType: 'text/markdown',
      parentRevisionId: baseRevisionId,
      revisionId: appliedRevisionId,
      workspaceId: source.workspaceId,
    },
  ];
  input.threadMaterialBindings = [
    {
      bindingState: 'bound',
      createdAt: timestamp,
      inclusionState: 'included',
      lastMutationRequestId: 'request_review_accept',
      latestQueuedRevisionId: appliedRevisionId,
      materialId,
      threadId: source.threadId,
      updatedAt: timestamp,
      workspaceId: source.workspaceId,
    },
  ];
  input.artifactReviews = [
    {
      appliedMaterialRevisionId: appliedRevisionId,
      artifactId: source.artifactId,
      artifactVersion: 1,
      contentDigest: appliedContentDigest,
      createdAt: timestamp,
      decidedAt: timestamp,
      decision: 'accepted',
      decisionActorId: 'usr_00000000-0000-7000-8000-000000000001',
      decisionRequestId: 'request_review_accept',
      feedback: null,
      rangeFeedback: {
        materialId,
        revisionId: baseRevisionId,
        contentDigest: baseContentDigest,
        start: 2,
        end: 15,
        originalText: 'Portable base',
      },
      judgements: ['first', 'second'].map((ordinal) =>
        writeRetainedV1({
          workspaceId: source.workspaceId,
          requestId: `choose-${ordinal}`,
          actor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
          recordedAt: timestamp,
          note: `Keep the ${ordinal} reason.`,
          extensions: {},
          kind: 'select' as const,
          target: {
            kind: 'artifact-version' as const,
            artifactId: source.artifactId,
            artifactVersion: 1,
            contentDigest: appliedContentDigest,
          },
          choice: {
            artifactId: source.artifactId,
            artifactVersion: 1,
            contentDigest: appliedContentDigest,
          },
        })
      ),
      followUpTurnId: null,
      materialProposal: { materialId, baseRevisionId, baseContentDigest },
      reviewId: deriveArtifactReviewId(source.workspaceId, source.artifactId, 1),
      sourceAgentId: 'agent_codex_host',
      sourceThreadId: source.threadId,
      sourceTurnId: source.turnId,
      workspaceId: source.workspaceId,
    },
  ];
  input.portableFileState = {
    notebookRevision,
    nativeKnowledgePages: new Map(
      Object.entries(notebookFiles).map(([path, content]) => [`knowledge/pages/${path}`, content])
    ),
    retrievalTraceFiles: new Map([
      [
        `threads/${source.threadId}/turns/${source.turnId}/retrieval-traces/${retrievalTraceId}.json`,
        {
          caller: 'task-mode',
          createdAt: timestamp,
          excluded: [],
          notebookRevision,
          queryContext: {
            serverId: 'dep_00000000-0000-7737-8fe7-61ca07c79d45',
            workspaceId: source.workspaceId,
            actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
            threadId: source.threadId,
            turnId: source.turnId,
          },
          requestDigest: `sha256:${createHash('sha256')
            .update('portable Knowledge retrieval')
            .digest('hex')}`,
          retrievalParameters: {
            limit: 5,
            pinnedReferences: [],
            states: ['active'],
            sourceScope: 'workspace',
          },
          selected: [
            {
              contentDigest: knowledgeContentDigest,
              reference: {
                scopeId: `page/workspace/${source.workspaceId}/${source.knowledgeBaseId}`,
                objectId: knowledgePageId,
              },
              revision: notebookRevision,
              sourceReferences: knowledgeSourceRefs,
            },
          ],
          sourceScope: `page/workspace/${source.workspaceId}/${source.knowledgeBaseId}`,
          traceId: retrievalTraceId,
        },
      ],
    ]),
    workerContextPackageFiles: new Map([
      ...packageFiles.files.map(
        (file) =>
          [
            `threads/${source.threadId}/turns/${source.turnId}/context-package/${file.path}`,
            Buffer.from(file.bytes).toString('utf8'),
          ] as const
      ),
      [
        `threads/${source.threadId}/turns/${source.turnId}/context-package.json`,
        serializeWorkerContextPackageTrace(trace),
      ],
    ]),
    workspaceConfig: JSON.stringify({
      schemaVersion: 1,
      workspace: {
        name: 'Lineage workspace',
        defaultAgentId: null,
        defaultKnowledgeBaseId: source.knowledgeBaseId,
        knowledgeMounts: [
          {
            name: 'raw',
            knowledgeBaseId: source.knowledgeBaseId,
            default: true,
            backend: 'local',
            root: 'raw',
          },
        ],
      },
    }),
    workspaceSchema: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
  };
  if (followUp) {
    const decisionRequestId = followUp.decisionRequestId ?? 'request_review_redo';
    const prefixedImportRequest = decisionRequestId.startsWith('import-lineage:');
    const followUpTurnId = prefixedImportRequest
      ? 'tu_00000000-0000-79a4-aa5f-28ed1f60437c'
      : deriveArtifactReviewFollowUpTurnId(
          source.workspaceId,
          source.artifactId,
          1,
          decisionRequestId
        );
    const workerRequestId = prefixedImportRequest
      ? 'request_follow_up_source'
      : deriveArtifactReviewWorkerRequestId(decisionRequestId);
    const followUpItemId = 'it_00000000-0000-7698-af18-5a72021d626f';
    const followUpRequest = serializeArtifactReviewFollowUpRequest({
      kind: 'artifact-review-follow-up',
      workspaceId: source.workspaceId,
      reviewId: deriveArtifactReviewId(source.workspaceId, source.artifactId, 1),
      artifactId: source.artifactId,
      artifactVersion: 1,
      contentDigest: appliedContentDigest,
      artifactContent: appliedContent,
      artifactMediaType: followUp.artifactMediaType ?? 'text/markdown',
      sourceThreadId: source.threadId,
      sourceTurnId: source.turnId,
      sourceAgentId: 'agent_codex_host',
      materialProposal: { materialId, baseRevisionId, baseContentDigest },
      rangeFeedback: {
        materialId,
        revisionId: baseRevisionId,
        contentDigest: baseContentDigest,
        start: 2,
        end: 15,
        originalText: 'Portable base',
      },
      decision: 'redo',
      feedback: 'Try again.',
      decisionRequestId,
      workerRequestId,
    });
    const followUpItem = {
      id: followUpItemId,
      owner: { kind: 'workspace', workspaceId: source.workspaceId },
      threadId: source.threadId,
      turnId: followUpTurnId,
      type: 'user-message',
      status: 'completed',
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      text: followUpRequest,
      createdAt: timestamp,
      completedAt: timestamp,
    };
    input.itemRevisions = [...input.itemRevisions, followUpItem];
    input.turns = [
      ...input.turns,
      {
        id: followUpTurnId,
        owner: { kind: 'workspace', workspaceId: source.workspaceId },
        threadId: source.threadId,
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        items: [followUpItem],
        status: 'completed',
        error: null,
        configVersion: null,
        agentId: 'agent_codex_host',
        agentSessionId: source.sessionId,
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 1,
      },
    ];
    const followUpPackage = createWorkerContextPackageFiles({
      contextBudgetTokens: 4_096,
      includedItemIds: [followUpItemId],
      materialSelections: [
        {
          bindingMutationRequestId: 'request_material_bind',
          content: baseContent,
          contentDigest: baseContentDigest,
          inclusionReason: 'thread_binding',
          materialId,
          mediaType: 'text/markdown',
          parentRevisionId: null,
          revisionId: baseRevisionId,
          sensitivity: 'internal',
        },
      ],
      threadId: source.threadId,
      turnId: followUpTurnId,
      workerRequestBytes: followUpRequest,
      workerRequestItemId: followUpItemId,
      workspaceId: source.workspaceId,
    });
    const followUpSnapshot = AgentEnvironmentPackageSchema.parse({
      ...snapshot,
      snapshotId: 'aepsnap_follow_up_source',
      packageId: 'aepkg_follow_up_source',
      scope: {
        ...snapshot.scope,
        requestId: workerRequestId,
        itemId: followUpItemId,
        turnId: followUpTurnId,
      },
      workspace: {
        ...snapshot.workspace,
        inputs: [
          buildWorkerContextPackageWorkspaceInput({
            agentSessionId: source.sessionId,
            packageRootDigest: followUpPackage.packageRootDigest,
            threadId: source.threadId,
            turnId: followUpTurnId,
          }),
        ],
      },
    });
    input.agentEnvironmentPackageSnapshots = [
      ...(input.agentEnvironmentPackageSnapshots ?? []),
      {
        ...snapshotRecord,
        snapshotId: followUpSnapshot.snapshotId,
        packageId: followUpSnapshot.packageId,
        turnId: followUpTurnId,
        contentDigest: createHash('sha256').update(JSON.stringify(followUpSnapshot)).digest('hex'),
        snapshot: followUpSnapshot,
      },
    ];
    const followUpTrace = createWorkerContextPackageTrace({
      agentSessionId: source.sessionId,
      excludedItems: [],
      goalId: null,
      packageFiles: followUpPackage,
      packageSnapshotId: followUpSnapshot.snapshotId,
      requestId: workerRequestId,
      taskId: null,
    });
    const followUpInputSnapshot = {
      ...workspaceInputSnapshot,
      base: { commit: null, contentDigest: followUpPackage.packageRootDigest },
      id: followUpTrace.workspaceInputSnapshotId,
      pathScope: [`context_${followUpTurnId}`],
      resourceId: `context_${followUpTurnId}`,
    };
    input.workspaceInputSnapshots = [
      ...(input.workspaceInputSnapshots ?? []),
      followUpInputSnapshot,
    ];
    input.workspaceMaterializationRecords = [
      ...(input.workspaceMaterializationRecords ?? []),
      {
        ...(input.workspaceMaterializationRecords?.[0] as Record<string, unknown>),
        base: followUpInputSnapshot.base,
        id: followUpTrace.workspaceMaterializationRecordId,
        inputSnapshotId: followUpTrace.workspaceInputSnapshotId,
        packageSnapshotId: followUpSnapshot.snapshotId,
        policyDigest: createWorkerContextPackagePolicyDigest({
          backendKind: 'openshell',
          packageSnapshotId: followUpSnapshot.snapshotId,
          requiredCapabilities: followUpSnapshot.backend.requiredCapabilities,
        }),
        readinessEvidence: [
          { kind: 'backend.ready', ref: 'version:0.0.80' },
          { kind: 'sandbox.created', ref: 'worker_follow_up_source' },
        ],
        workerSessionId: 'worker_follow_up_source',
      },
    ];
    input.workspaceMaterials = input.workspaceMaterials.map((material) => ({
      ...(material as Record<string, unknown>),
      currentRevisionId: baseRevisionId,
      lastMutationRequestId: 'request_material_base',
    }));
    input.workspaceMaterialRevisions = [input.workspaceMaterialRevisions[0]!];
    input.threadMaterialBindings = input.threadMaterialBindings.map((binding) => ({
      ...(binding as Record<string, unknown>),
      latestQueuedRevisionId: baseRevisionId,
      lastMutationRequestId: 'request_material_base',
    }));
    input.artifactReviews = input.artifactReviews.map((review) => ({
      ...(review as Record<string, unknown>),
      appliedMaterialRevisionId: null,
      decision: 'redo',
      decisionRequestId,
      feedback: 'Try again.',
      followUpTurnId,
    }));
    for (const file of followUpPackage.files) {
      input.portableFileState.workerContextPackageFiles.set(
        `threads/${source.threadId}/turns/${followUpTurnId}/context-package/${file.path}`,
        Buffer.from(file.bytes).toString('utf8')
      );
    }
    input.portableFileState.workerContextPackageFiles.set(
      `threads/${source.threadId}/turns/${followUpTurnId}/context-package.json`,
      serializeWorkerContextPackageTrace(followUpTrace)
    );
  }
  // The exporter requires the SQL selection tuple. This fixture's Notebook is the Git commit above.
  input.sourceNotebookSelection = {
    workspaceRoot: input.sourceWorkspaceRoot!,
    head: {
      workspaceId: source.workspaceId,
      notebookCommit: notebookRevision,
    },
    notebook,
    scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
    scopeSchema: {},
  } as NonNullable<WriteWorkspaceExportTreeInput['sourceNotebookSelection']>;
  return input;
}

describe('workspace auxiliary lineage export', () => {
  it('exports annotated synchronization source rows in their record families', async () => {
    const input = await createLineageExportInput();
    const base = { commit: 'abc000', contentDigest: null };
    input.workspaceInputSnapshots = [
      {
        id: 'wis_source',
        workspaceId: source.workspaceId,
        resourceId: 'repo_source',
        resourceKind: 'git_repository',
        strategy: 'git',
        pathScope: ['src'],
        writableRoots: ['src'],
        ignoredPaths: [],
        generatedFiles: [{ id: 'generated', target: 'src/generated.txt' }],
        base,
        backend: { kind: 'openshell', label: 'Worker', capabilitySummary: [] },
        createdAt: timestamp,
      },
    ];
    input.workspaceMaterializationRecords = [
      {
        id: 'wmr_source',
        inputSnapshotId: 'wis_source',
        workspaceId: source.workspaceId,
        backendKind: 'openshell',
        packageSnapshotId: input.agentEnvironmentPackageSnapshots![0]!.snapshotId,
        workerSessionId: 'worker_source',
        strategy: 'git',
        materializedRootRef: `workspace:${source.workspaceId}/staging`,
        base,
        policyDigest: 'sha256:policy',
        readinessEvidence: [{ kind: 'backend.ready', ref: 'version:1' }],
        createdAt: timestamp,
      },
    ];
    input.backendWorkspaceHandles = [
      {
        id: 'bwh_source',
        workspaceId: source.workspaceId,
        materializationRecordId: 'wmr_source',
        backendKind: 'openshell',
        packageSnapshotId: input.agentEnvironmentPackageSnapshots![0]!.snapshotId,
        workerSessionId: 'worker_source',
        transportRefs: [{ kind: 'workspace', ref: `workspace:${source.workspaceId}/staging` }],
        cleanupStatus: 'pending',
        retention: 'until-reconciliation',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];
    input.stagedWorkspaceReviews = [
      {
        artifactId: source.artifactId,
        patchPayload: null,
        review: {
          id: 'swr_source',
          workspaceId: source.workspaceId,
          changeSetId: 'wcs_source',
          staging: {
            strategy: 'git_worktree',
            ref: `workspace:${source.workspaceId}/staging`,
            branch: null,
          },
          status: 'pending',
          diffSummary: { filesChanged: 0, additions: 0, deletions: 0 },
          riskSummary: 'No risks',
          validation: [{ command: 'pnpm test', status: 'passed', ref: null }],
          actionCenterRowId: 'acr_source',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    ];
    input.workspaceApplyResults = [
      {
        id: 'war_source',
        workspaceId: source.workspaceId,
        reviewId: 'swr_source',
        changeSetId: 'wcs_source',
        status: 'applied',
        appliedPaths: ['src/file.ts'],
        skippedPaths: [],
        conflictRecords: [],
        verification: [{ command: 'pnpm test', status: 'passed', ref: null }],
        commitIds: [],
        appliedAt: timestamp,
        requestId: 'request_apply_source',
      },
    ];
    input.workspaceReconciliationRecords = [
      {
        id: 'wrr_source',
        workspaceId: source.workspaceId,
        triggerReason: 'restart',
        affectedRecordIds: ['wmr_source', 'bwh_source'],
        backendHandleSummary: { handleId: 'bwh_source' },
        backendReachability: { status: 'unknown', checkedAt: timestamp, detail: null },
        collectedOutputManifestIds: ['wom_source'],
        evidenceBundleIds: ['evb_source'],
        stateBefore: 'ready',
        stateAfter: 'requires-human',
        quarantineRefs: [],
        requiredHumanDecision: 'inspect',
        retentionDecision: 'retain-backend',
        startedAt: timestamp,
        finishedAt: null,
      },
    ];
    const families = [
      ['workspaceInputSnapshots', 'workspace-input-snapshots'],
      ['workspaceMaterializationRecords', 'workspace-materialization-records'],
      ['backendWorkspaceHandles', 'backend-workspace-handles'],
      ['workerOutputManifests', 'worker-output-manifests'],
      ['workspaceChangeSets', 'workspace-change-sets'],
      ['stagedWorkspaceReviews', 'staged-workspace-reviews'],
      ['workspaceApplyResults', 'workspace-apply-results'],
      ['workspaceReconciliationRecords', 'workspace-reconciliation-records'],
    ] as const;
    for (const [property] of families) input[property] = input[property]!.map(annotateSyncSource);
    const verified = writeWorkspaceExportTree(input);
    for (const [property, file] of families) {
      const records = input[property]!;
      expect(verified.fileContents.get(`records/${file}.jsonl`)).toBe(
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
      );
    }
  });

  it('exports Turn observations and Item anchors without rewriting content identities', async () => {
    const input = await createLineageExportInput();
    const rows = [
      {
        v: 1,
        type: 'runtime.observed',
        id: 'observation_source',
        ts: timestamp,
        seq: 1,
        obs: 'worker-shim',
        turnId: source.turnId,
        parent: source.itemId,
        corr: 'call_source',
        payload: {
          observationId: 'observation_source',
          sourceRef: 'source_1',
          sourceSequence: 1,
          observedAt: timestamp,
          fact: { kind: 'origin', phase: 'started', runtimeOriginRef: `rto_${'a'.repeat(24)}` },
          content: { state: 'off' },
        },
      },
      {
        v: 1,
        type: 'runtime.observed',
        id: 'observation_followup',
        ts: timestamp,
        seq: 2,
        obs: 'worker-shim',
        turnId: source.turnId,
        parent: 'observation_source',
        corr: 'call_source',
        payload: {
          observationId: 'observation_followup',
          sourceRef: 'source_1',
          sourceSequence: 2,
          observedAt: timestamp,
          fact: { kind: 'origin', phase: 'running', runtimeOriginRef: `rto_${'a'.repeat(24)}` },
          content: { state: 'off' },
        },
      },
    ];
    const externalRefs = [
      {
        kind: 'sandbox-image',
        scope: { ownerScope: 'server', deploymentId: 'dep_00000000-0000-7eae-88cf-8a657760c635' },
        locator: 'sha256:source-image',
        edge: 'association',
      },
      {
        kind: 'artifact',
        scope: {
          workspaceId: source.workspaceId,
          deploymentId: 'dep_00000000-0000-7eae-88cf-8a657760c635',
        },
        locator: source.artifactId,
        edge: 'association',
      },
    ];
    const text = `${rows.map((row) => JSON.stringify({ ...row, refs: externalRefs })).join('\n')}\n`;
    const verified = writeWorkspaceExportTree({
      ...input,
      turnCaptureCoverage: new Map([[source.turnId, { scope: 'server', value: 'off' }]]),
      turnObservations: new Map([[source.turnId, text]]),
    });
    const path = `workspace-files/threads/${source.threadId}/turns/${source.turnId}/observations.jsonl`;
    expect(verified.fileContents.get(path)).toBe(text);
  });

  it('exports one exact child-origin with Gateway calls and no provenance index', async () => {
    const input = await createLineageExportInput();
    const packageSnapshotId = input.agentEnvironmentPackageSnapshots![0]!.snapshotId;
    const rootRef = `rto_${'a'.repeat(24)}`;
    const childRef = `rto_${'b'.repeat(24)}`;
    input.capabilityCalls = input.capabilityCalls!.map((call) => ({
      ...(call as Record<string, unknown>),
      packageSnapshotId,
      runtimeOriginRef: childRef,
    }));
    const row = {
      v: 1,
      id: 'child_observation',
      type: 'runtime.observed',
      ts: timestamp,
      seq: 1,
      obs: 'worker-shim',
      turnId: source.turnId,
      payload: {
        observationId: 'child_observation',
        sourceRef: 'source_1',
        sourceSequence: 1,
        observedAt: timestamp,
        fact: {
          kind: 'origin',
          phase: 'started',
          runtimeOriginRef: childRef,
          parentRuntimeOriginRef: rootRef,
        },
        content: { state: 'off' },
      },
    };
    const verified = writeWorkspaceExportTree({
      ...input,
      turnCaptureCoverage: new Map([[source.turnId, { scope: 'server', value: 'off' }]]),
      turnObservations: new Map([[source.turnId, `${JSON.stringify(row)}\n`]]),
    });
    const observationPath = `workspace-files/threads/${source.threadId}/turns/${source.turnId}/observations.jsonl`;
    expect(verified.fileContents.get(observationPath)).toBe(`${JSON.stringify(row)}\n`);
    const calls = verified.fileContents
      .get('records/capability-calls.jsonl')!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { packageSnapshotId?: string; runtimeOriginRef?: string });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.runtimeOriginRef).toBe(childRef);
      expect(call.packageSnapshotId).toBe(packageSnapshotId);
    }
    expect(
      [...verified.fileContents.keys()].some((path) => path.endsWith('runtime-origin-index.jsonl'))
    ).toBe(false);
  });

  it('exports restricted observation bytes and their exact publication references', async () => {
    const input = await createLineageExportInput(undefined, 'on');
    const bytes = Buffer.from('  original é\n');
    const digest = createHash('sha256').update(bytes).digest('hex');
    input.evidenceBundles = [
      {
        id: 'evb_observation',
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        turnId: source.turnId,
        goalId: null,
        agentSessionId: null,
        backendType: 'internal',
        sourceKind: 'work-observation-body',
        summary: 'Restricted observation content.',
        rawEvidenceRefs: [{ kind: 'work-observation-body', ref: 'raw/content' }],
        redactedEvidenceRefs: [],
        contentDigests: [digest],
        retentionClass: 'restricted-raw',
        sensitivityClass: 'restricted',
        importStatus: 'promoted',
        requiredFeatures: ['evidence.bundle.v1', 'openkit.work-observations.v1'],
        createdAt: timestamp,
      },
    ];
    const initial = {
      v: 1,
      id: 'observation_initial',
      type: 'runtime.observed',
      ts: timestamp,
      seq: 1,
      obs: 'worker-shim',
      turnId: source.turnId,
      payload: {
        observationId: 'observation_initial',
        sourceRef: 'source_1',
        sourceSequence: 1,
        observedAt: timestamp,
        fact: {
          kind: 'assistant',
          phase: 'completed',
          runtimeOriginRef: null,
          messageRef: 'message_1',
          representation: 'snapshot',
        },
        content: {
          state: 'expected',
          sha256: `sha256:${digest}`,
          bytes: Buffer.byteLength('  original é\n'),
          mediaType: 'text/plain',
          boundary: 'assistant.text',
          chunkCount: 1,
        },
      },
    };
    const row = {
      v: 1,
      id: 'observation_body',
      type: 'content.published',
      ts: timestamp,
      seq: 2,
      obs: 'worker-shim',
      turnId: source.turnId,
      parent: initial.id,
      refs: [
        {
          kind: 'evidence-bundle',
          scope: { workspaceId: source.workspaceId, pathClass: 'backend' },
          locator: 'evb_observation',
          digest,
          edge: 'publication',
        },
      ],
      payload: {
        bodies: [
          {
            id: 'body_1',
            bundleId: 'evb_observation',
            sha256: digest,
            bytes: Buffer.byteLength('  original é\n'),
            mediaType: 'text/plain',
            boundary: 'assistant.text',
          },
        ],
      },
    };
    const verified = writeWorkspaceExportTree({
      ...input,
      restrictedEvidenceFiles: new Map([['evb_observation/raw/content', bytes]]),
      turnCaptureCoverage: new Map([[source.turnId, { scope: 'server', value: 'on' }]]),
      turnObservations: new Map([
        [source.turnId, `${JSON.stringify(initial)}\n${JSON.stringify(row)}\n`],
      ]),
    });
    expect(verified.manifest.requiredFeatures).toContain('openkit.work-observations.v1');
    expect(
      verified.binaryFileContents.get(
        'workspace-files/evidence/backend/evb_observation/raw/content'
      )
    ).toEqual(bytes);
    const bundles = verified.fileContents
      .get('records/evidence-bundles.jsonl')!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id?: string });
    expect(bundles.find((bundle) => bundle.id === 'evb_observation')).toMatchObject({
      importStatus: 'promoted',
      rawEvidenceRefs: [{ kind: 'work-observation-body', ref: 'raw/content' }],
      redactedEvidenceRefs: [],
      contentDigests: [digest],
    });
    expect(
      verified.fileContents.get(
        `workspace-files/threads/${source.threadId}/turns/${source.turnId}/observations.jsonl`
      )
    ).toBe(`${JSON.stringify(initial)}\n${JSON.stringify(row)}\n`);
  });

  it('exports accepted Knowledge Page Context Package references with the source digest', async () => {
    const input = await createWorkResourceLineageExportInput();
    const sourceTraceText = [...input.portableFileState!.workerContextPackageFiles.entries()].find(
      ([path]) => path.endsWith('/context-package.json')
    )?.[1];
    const sourceTrace = readRetainedContextTrace(
      sourceTraceText ?? '{}',
      input.portableFileState!.workerContextPackageFiles
    );
    const sourceReferences = [
      `context-package:${source.turnId}@${sourceTrace.contextPackageDigest}`,
    ];
    const fixturePage = knowledgePageFixture(
      {
        id: 'mem_1',
        title: 'Portable work history',
        content: 'Reuse the accepted Context Package.',
        sourceReferences,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      { kind: 'workspace', workspaceId: input.workspace.id }
    );
    const pageBytes = fixturePage.content
      .replace(
        `source_refs: ${JSON.stringify(sourceReferences)}`,
        `source_refs:\n  - ${JSON.stringify(sourceReferences[0])}`
      )
      .replace(
        `scope: ${JSON.stringify({ kind: 'workspace', workspaceId: source.workspaceId })}`,
        `scope: ${JSON.stringify({ kind: 'workspace', workspaceId: source.workspaceId })}\nsources:\n  - id: retained-source\n    credibility:\n      author: human:owner`
      );
    const knowledge = parseOwnedKnowledgePage(fixturePage.path, fixturePage.id, pageBytes);

    input.knowledge = [...input.knowledge, knowledge];
    input.workspace = {
      ...input.workspace,
      counts: { ...input.workspace.counts, knowledgeEntryCount: input.knowledge.length },
    };
    input.portableFileState!.nativeKnowledgePages.set(
      `knowledge/pages/${knowledge.path}`,
      pageBytes
    );

    const verified = writeWorkspaceExportTree(input);
    for (const [path, bytes] of input.portableFileState!.workerContextPackageFiles) {
      expect(verified.fileContents.get(`workspace-files/${path}`)).toBe(bytes);
    }
    expect(verified.fileContents.get(`workspace-files/knowledge/pages/${knowledge.path}`)).toBe(
      pageBytes
    );
    expect(pageBytes).toContain(sourceTrace.contextPackageDigest);
    expect(
      verified.fileContents.get(
        `workspace-files/threads/${source.threadId}/turns/${source.turnId}/context-package.json`
      )
    ).toContain(sourceTrace.contextPackageDigest);
  });

  it('exports populated portable runtime and MCP descriptions and verifies the annotated inventory', async () => {
    const input = await createWorkResourceLineageExportInput();
    const tools = [{ name: 'inspect', inputSchema: { type: 'object', properties: {} } }];
    const sourceExport = writeWorkspaceExportTree({
      ...input,
      runtimeEvidence: input.runtimeEvidence?.map((row) => ({
        ...RuntimeEvidenceRecordSchema.parse(row),
        uploadManifest: [
          {
            path: 'upload.txt',
            size: 6,
            digest: `sha256:${createHash('sha256').update('upload').digest('hex')}`,
          },
        ],
        downloadManifest: [
          {
            path: 'download.txt',
            size: 8,
            digest: `sha256:${createHash('sha256').update('download').digest('hex')}`,
          },
        ],
      })),
      mcpToolSchemaSnapshots: [
        {
          capturedAt: timestamp,
          catalogEntryId: 'mcp_source',
          contentDigest: mcpToolSchemaContentDigest(tools),
          toolsJson: canonicalJsonText(canonicalMcpToolSchemas(tools)),
          schemaSnapshotId: 'mcp_snapshot_source',
          serverVersion: '1.0.0',
          source: 'live',
          sourceRef: null,
          tools,
          workspaceId: source.workspaceId,
        },
      ],
    });
    const manifestPath = join(input.exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const canonical = (value: unknown): string => {
      const sort = (entry: unknown): unknown => {
        if (Array.isArray(entry)) return entry.map(sort);
        if (entry && typeof entry === 'object')
          return Object.fromEntries(
            Object.entries(entry)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, sort(item)])
          );
        return entry;
      };
      return JSON.stringify(sort(value));
    };
    const packagePath = `workspace-files/threads/${source.threadId}/turns/${source.turnId}/context-package/package.json`;
    const tracePath = `workspace-files/threads/${source.threadId}/turns/${source.turnId}/context-package.json`;
    const sourceTrace = JSON.parse(
      JSON.stringify(
        parseWorkerContextPackageTrace(
          JSON.parse(readFileSync(join(input.exportRoot, tracePath), 'utf8')),
          readFileSync(join(input.exportRoot, packagePath))
        )
      )
    );
    const packageManifest = JSON.parse(readFileSync(join(input.exportRoot, packagePath), 'utf8'));
    packageManifest.annotation = { '10': 'ten', '2': 'two' };
    packageManifest.materialSelections[0].annotation = 'source Material selection';
    packageManifest.knowledgeSelections[0].annotation = 'source Knowledge selection';
    const packageBytes = canonical(packageManifest);
    sourceTrace.annotation = 'source trace';
    sourceTrace.materialSelections = structuredClone(packageManifest.materialSelections);
    sourceTrace.knowledgeSelections = structuredClone(packageManifest.knowledgeSelections);
    sourceTrace.knowledgeSelectionInput.annotation = 'source retrieval';
    const packageEntry = sourceTrace.fileInventory.find(
      (entry: { path: string }) => entry.path === 'package.json'
    );
    packageEntry.byteLength = Buffer.byteLength(packageBytes);
    packageEntry.contentDigest = `sha256:${createHash('sha256').update(packageBytes).digest('hex')}`;
    const { contextPackageDigest: _originalDigest, ...traceWithoutDigest } = sourceTrace;
    sourceTrace.contextPackageDigest = `ctxpkg_sha256_${createHash('sha256').update(canonical(traceWithoutDigest)).digest('hex')}`;
    const packageRootDigest = `sha256:${createHash('sha256').update(canonical(sourceTrace.fileInventory)).digest('hex')}`;
    for (const [path, bytes] of [
      [packagePath, packageBytes],
      [tracePath, serializeWorkerContextPackageTrace(sourceTrace)],
    ]) {
      writeFileSync(join(input.exportRoot, path!), bytes!);
      const entry = manifest.contentInventory.find(
        (entry: { path: string }) => entry.path === path
      );
      entry.bytes = Buffer.byteLength(bytes!);
      entry.digest = `sha256:${createHash('sha256').update(bytes!).digest('hex')}`;
    }
    const paths = [
      'records/workspace-materials.jsonl',
      'records/workspace-material-revisions.jsonl',
      'records/thread-material-bindings.jsonl',
      'records/artifact-reviews.jsonl',
      'records/agent-environment-package-snapshots.jsonl',
      'records/resolved-agent-setups.jsonl',
      'records/worker-turn-checkpoints.jsonl',
      'records/mcp-tool-schema-snapshots.jsonl',
      'records/capability-calls.jsonl',
      'records/evidence-bundles.jsonl',
      'records/runtime-evidence.jsonl',
      'records/usage-records.jsonl',
      'records/workspace-repositories.jsonl',
      'records/workspace-input-snapshots.jsonl',
      'records/workspace-materialization-records.jsonl',
    ];
    const changed: string[] = [];
    for (const path of paths) {
      const entry = manifest.contentInventory.find(
        (entry: { path: string }) => entry.path === path
      );
      if (!entry) continue;
      const rows = readFileSync(join(input.exportRoot, path), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((text) => JSON.parse(text));
      if (rows.length === 0) continue;
      for (const row of rows) {
        if (row.base) row.base.contentDigest = packageRootDigest;
        else row.annotation = 'portable';
        if (row.git) row.git.annotation = 'archived repository configuration';
        for (const tool of row.tools ?? []) tool.annotation = 'descriptive Tool snapshot';
        if (row.materialProposal) row.materialProposal.annotation = 'proposal';
        for (const ref of row.redactedEvidenceRefs ?? []) ref.annotation = 'reference';
        for (const ref of row.rawEvidenceRefs ?? []) ref.annotation = 'reference';
        for (const ref of row.uploadManifest ?? []) ref.annotation = 'upload';
        for (const ref of row.downloadManifest ?? []) ref.annotation = 'download';
        if (row.snapshot) {
          row.snapshot.workspace.inputs.find(
            (input: { materialization?: { slotId: string } }) =>
              input.materialization?.slotId === 'context'
          ).materialization.contentDigest = packageRootDigest;
          row.snapshot.control.transcript.annotation = 'transcript';
          row.snapshot.scope.annotation = JSON.parse('{"__proto__":"inert"}');
          row.snapshot.scope.triggerActor.annotation = 'actor';
          row.snapshot.agent.annotation = 'agent';
          row.contentDigest = snapshotDigest(row.snapshot);
        }
      }
      const text = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
      writeFileSync(join(input.exportRoot, path), text);
      entry.bytes = Buffer.byteLength(text);
      entry.digest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
      changed.push(path);
    }
    expect(changed).toEqual(paths);
    manifest.contentDigest = `sha256:${createHash('sha256').update(JSON.stringify(manifest.contentInventory)).digest('hex')}`;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const verified = verifyWorkspaceExportTree({ exportRoot: input.exportRoot });
    expect(verified.manifest.contentDigest).not.toBe(sourceExport.manifest.contentDigest);
    const snapshotFile = join(
      input.exportRoot,
      'records/agent-environment-package-snapshots.jsonl'
    );
    const safeSnapshotBytes = readFileSync(snapshotFile, 'utf8');
    const safeManifestBytes = readFileSync(manifestPath, 'utf8');
    const safeSnapshot = JSON.parse(safeSnapshotBytes.trim());
    expect(verified.manifestDigest).toBe(
      `sha256:${createHash('sha256').update(safeManifestBytes).digest('hex')}`
    );
    expect(safeSnapshot.contentDigest).toBe(snapshotDigest(safeSnapshot.snapshot));
    for (const path of changed) {
      expect(verified.fileContents.get(path)).toBe(
        readFileSync(join(input.exportRoot, path), 'utf8')
      );
    }
    expect(verified.fileContents.get(packagePath)).toBe(packageBytes);
    expect(verified.fileContents.get(tracePath)).toBe(
      serializeWorkerContextPackageTrace(sourceTrace)
    );
  });

  it.each([
    false,
    true,
  ])('round trips source references and exact delivered previews with representation metadata=%s', async (retainRepresentation) => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-source-snapshot-portability-'));
    let fixtureParent: string | undefined;
    try {
      const sourceRoot = join(root, 'source');
      mkdirSync(sourceRoot);
      const input = await createWorkResourceLineageExportInput(
        undefined,
        sourceRoot,
        retainRepresentation
      );
      fixtureParent = dirname(input.exportRoot);
      input.exportRoot = join(root, 'export');
      writeWorkspacePortableFileState(sourceRoot, input.portableFileState!);
      expect(
        [...input.portableFileState.workerContextPackageFiles.keys()].some((path) =>
          path.includes('/originals/')
        )
      ).toBe(false);
      const verified = writeWorkspaceExportTree(input);
      expect(
        [...verified.artifactPayloadFiles.keys()].filter((path) =>
          path.includes('/context-package/originals/')
        )
      ).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (fixtureParent) rmSync(fixtureParent, { recursive: true, force: true });
    }
  });

  it('exports Knowledge exclusion revisions against the source Notebook and preserves historical absence', async () => {
    // Current exclusions carry the source Notebook revision. Legacy exclusions omit it.
    for (const version of ['legacy', 'current'] as const) {
      const input = await createWorkResourceLineageExportInput(
        undefined,
        undefined,
        false,
        false,
        false,
        'markdown',
        version
      );
      const verified = writeWorkspaceExportTree(input);
      const sourceRevision = verified.manifest.knowledgeNotebookRevision;
      const tracePath = `threads/${source.threadId}/turns/${source.turnId}/context-package.json`;
      const traceText = input.portableFileState!.workerContextPackageFiles.get(tracePath)!;
      expect(verified.fileContents.get(`workspace-files/${tracePath}`)).toBe(traceText);
      const trace = readRetainedContextTrace(
        traceText,
        input.portableFileState!.workerContextPackageFiles
      );
      expect(trace.knowledgeExclusions).toEqual([
        expect.objectContaining({
          knowledgeBaseId: source.knowledgeBaseId,
          knowledgePageId: 'knowledge_portable_source',
          reason: 'budget_exceeded',
        }),
      ]);
      if (version === 'current') {
        expect(trace.knowledgeExclusions[0]!.notebookRevision).toBe(sourceRevision);
      } else {
        expect(trace.knowledgeExclusions[0]).not.toHaveProperty('notebookRevision');
      }
    }
  });

  it('exports an S39 selection pinned to the current Notebook commit and its Workspace overview', async () => {
    // Current Knowledge selections carry the source Notebook revision in the export.
    const input = await createWorkResourceLineageExportInput(
      undefined,
      undefined,
      false,
      true,
      true
    );
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(dirname(input.exportRoot), 'source', 'knowledge', 'notebook.git'),
    });
    const sourceRevision = notebook.publishedRevision();
    const content = notebook.readRevision(sourceRevision).files['knowledge_portable_source.md'];
    const verified = writeWorkspaceExportTree(input);
    expect(notebook.publishedRevision()).toBe(sourceRevision);
    expect(verified.manifest.knowledgeNotebookRevision).toBe(sourceRevision);
    expect(
      parseJsoncObject(verified.fileContents.get('workspace-files/config/workspace.jsonc')!)
    ).toMatchObject({ workspace: { defaultKnowledgeBaseId: source.knowledgeBaseId } });
    const sourceManifestPath = `workspace-files/threads/${source.threadId}/turns/${source.turnId}/context-package/package.json`;
    const sourceManifestText = verified.fileContents.get(sourceManifestPath)!;
    const sourceOverviewPath = `workspace-files/threads/${source.threadId}/turns/${source.turnId}/context-package/knowledge-overview.md`;
    const sourceOverviewText = verified.fileContents.get(sourceOverviewPath)!;
    const sourceOverview = JSON.parse(
      sourceOverviewText.slice('<knowledge_overviews>'.length, -'</knowledge_overviews>'.length)
    );
    expect(sourceOverview.overviews).toEqual([
      expect.objectContaining({
        scope: `workspace:${source.workspaceId}`,
        knowledgeBaseId: source.knowledgeBaseId,
        path: 'index.md',
        notebookRevision: sourceRevision,
      }),
    ]);
    expect(JSON.parse(sourceManifestText).fileInventory).toContainEqual({
      path: 'knowledge-overview.md',
      byteLength: Buffer.byteLength(sourceOverviewText),
      contentDigest: `sha256:${createHash('sha256').update(sourceOverviewText).digest('hex')}`,
    });
    expect(JSON.parse(sourceManifestText).knowledgeSelections).toEqual([
      expect.objectContaining({
        knowledgeBaseId: source.knowledgeBaseId,
        notebookRevision: sourceRevision,
      }),
    ]);
    expect(verified.fileContents.get(sourceManifestPath)).toBe(sourceManifestText);
    expect(verified.fileContents.get(sourceOverviewPath)).toBe(sourceOverviewText);
    expect(JSON.parse(sourceManifestText).knowledgeSelections[0].notebookRevision).toBe(
      sourceRevision
    );
    expect(notebook.readRevision(sourceRevision).files['knowledge_portable_source.md']).toBe(
      content
    );
  });

  it('exports one complete Material, Review, and S39 history graph', async () => {
    const input = await createWorkResourceLineageExportInput(undefined, undefined, false, true);
    const sourceKnowledgeContent = input.portableFileState!.nativeKnowledgePages.get(
      'knowledge/pages/knowledge_portable_source.md'
    )!;
    const sourceKnowledgeExcerpt = input.portableFileState!.workerContextPackageFiles.get(
      `threads/${source.threadId}/turns/${source.turnId}/context-package/knowledge/pages/knowledge_portable_source.md`
    )!;
    expect(sourceKnowledgeContent).toBeDefined();
    expect(sourceKnowledgeExcerpt).toBeDefined();
    const verified = writeWorkspaceExportTree(input);
    expect(verified.fileContents.get('records/workspace-materials.jsonl')).toBe(
      `${input.workspaceMaterials.map((record) => JSON.stringify(record)).join('\n')}\n`
    );
    const revisions = [...input.workspaceMaterialRevisions].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
    expect(verified.fileContents.get('records/workspace-material-revisions.jsonl')).toBe(
      `${revisions.map((record) => JSON.stringify(record)).join('\n')}\n`
    );
    expect(verified.fileContents.get('records/artifact-reviews.jsonl')).toBe(
      `${input.artifactReviews.map((record) => JSON.stringify(record)).join('\n')}\n`
    );
    for (const [path, bytes] of input.portableFileState!.workerContextPackageFiles) {
      expect(verified.fileContents.get(`workspace-files/${path}`)).toBe(bytes);
    }
  });

  it('exports exact binary runtime provenance alongside its product-safe index', async () => {
    const input = await createLineageExportInput();
    const packageSnapshotId = input.agentEnvironmentPackageSnapshots![0]!.snapshotId;
    const rawBundleId = 'evb_runtime_raw_source';
    const indexBundleId = 'evb_runtime_index_source';
    const runtimeEvidenceId = 'rte_runtime_source';
    const rawBytes = Buffer.from([0, 255, 128, 10, 13, 0, 254]);
    const rawDigest = `sha256:${createHash('sha256').update(rawBytes).digest('hex')}`;
    const rawPath = `workspace-files/evidence/backend/${rawBundleId}/raw/native-canary.bin`;
    const sourceOriginRef = `rto_${'a'.repeat(24)}`;
    const sourceTurnRef = `rtt_${'b'.repeat(24)}`;
    const indexText = `${JSON.stringify(
      writeRetainedV1({
        lineage: {
          workspaceId: source.workspaceId,
          threadId: source.threadId,
          turnId: source.turnId,
          agentSessionId: source.sessionId,
          packageSnapshotId,
          requestId: 'request_source',
        },
        streamRef: 'stream-0000.jsonl',
        frameSequence: 0,
        byteOffset: 0,
        byteLength: 24,
        frameSha256: `sha256:${'1'.repeat(64)}`,
        eventKind: 'thread.started',
        parseStatus: 'parsed',
        runtimeOriginRef: sourceOriginRef,
        parentRuntimeOriginRef: null,
        runtimeTurnRef: sourceTurnRef,
        runtimeRole: 'worker',
        runtimeDepth: 0,
      })
    )}\n`;
    const indexDigest = `sha256:${createHash('sha256').update(indexText).digest('hex')}`;
    input.evidenceBundles = [
      {
        id: rawBundleId,
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        goalId: null,
        turnId: source.turnId,
        agentSessionId: source.sessionId,
        backendType: 'openshell',
        sourceKind: 'worker-runtime-provenance-raw',
        summary: 'Restricted runtime provenance.',
        rawEvidenceRefs: [
          { kind: 'worker-runtime-provenance-stream', ref: 'raw/native-canary.bin' },
        ],
        redactedEvidenceRefs: [],
        contentDigests: [rawDigest],
        retentionClass: 'restricted-raw',
        sensitivityClass: 'restricted',
        importStatus: 'promoted',
        requiredFeatures: ['worker.runtime-provenance.v1'],
        createdAt: timestamp,
      },
      {
        id: indexBundleId,
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        goalId: null,
        turnId: source.turnId,
        agentSessionId: source.sessionId,
        backendType: 'openshell',
        sourceKind: 'worker-runtime-provenance-index',
        summary: 'Product-safe runtime provenance.',
        rawEvidenceRefs: [],
        redactedEvidenceRefs: [
          { kind: 'worker-runtime-provenance-index', ref: 'runtime-origin-index.jsonl' },
        ],
        contentDigests: [indexDigest],
        retentionClass: 'turn-evidence',
        sensitivityClass: 'product-safe',
        importStatus: 'promoted',
        requiredFeatures: ['worker.runtime-provenance.v1'],
        createdAt: timestamp,
      },
    ];
    input.runtimeEvidence = [
      {
        id: runtimeEvidenceId,
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        turnId: source.turnId,
        goalId: null,
        taskId: null,
        agentSessionId: source.sessionId,
        backendType: 'openshell',
        backendVersion: '0.0.80',
        placement: 'local',
        phase: 'transcript-collection',
        summary: 'Portable runtime provenance.',
        policyDigest: null,
        workerImage: null,
        sandboxSummary: null,
        capabilitySummary: null,
        uploadManifest: [],
        downloadManifest: [],
        transcriptSummary: null,
        workspaceChangeSummary: null,
        controlSummary: null,
        outcome: 'succeeded',
        exitCode: null,
        signal: null,
        stopReason: null,
        errorCode: null,
        errorMessage: null,
        redactedStdoutSummary: null,
        redactedStderrSummary: null,
        evidenceBundleIds: [rawBundleId, indexBundleId],
        contentDigests: [rawDigest, indexDigest],
        requiredFeatures: ['worker.runtime-provenance.v1'],
        createdAt: timestamp,
        startedAt: null,
        completedAt: null,
        collectedAt: timestamp,
      },
    ];
    input.runtimeProvenanceIndexes = new Map([[indexBundleId, indexText]]);
    input.restrictedEvidenceFiles = new Map([[`${rawBundleId}/raw/native-canary.bin`, rawBytes]]);
    const sourceCacheLineageRef = `rcl_${'c'.repeat(24)}`;
    input.capabilityCalls = [
      {
        ...(input.capabilityCalls?.[0] as Record<string, unknown>),
        packageSnapshotId,
        runtimeOriginRef: sourceOriginRef,
        runtimeCacheLineageRef: sourceCacheLineageRef,
      },
      {
        ...(input.capabilityCalls?.[0] as Record<string, unknown>),
        id: 'cap_00000000-0000-7571-b976-68dc4eb78315',
        packageSnapshotId,
        runtimeOriginRef: sourceOriginRef,
        runtimeCacheLineageRef: sourceCacheLineageRef,
      },
    ];

    const verified = writeWorkspaceExportTree(input);
    const exportedBundles = readFileSync(
      join(input.exportRoot, 'records', 'evidence-bundles.jsonl'),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(exportedBundles.find((bundle) => bundle.id === rawBundleId)).toMatchObject({
      id: rawBundleId,
      importStatus: 'promoted',
      rawEvidenceRefs: [{ kind: 'worker-runtime-provenance-stream', ref: 'raw/native-canary.bin' }],
      redactedEvidenceRefs: [],
      contentDigests: [rawDigest],
    });
    expect(verified.binaryFileContents.get(rawPath)).toEqual(rawBytes);
    expect(readFileSync(join(input.exportRoot, rawPath))).toEqual(rawBytes);
    expect(
      verified.manifest.contentInventory.find((entry) => entry.path === rawPath)
    ).toMatchObject({
      bytes: rawBytes.byteLength,
      digest: rawDigest,
    });
    expect(
      verified.fileContents.get(
        `workspace-files/evidence/bundles/${indexBundleId}/runtime-origin-index.jsonl`
      )
    ).toBe(indexText);
    const failedRaw = writeWorkspaceExportTree({
      ...input,
      exportRoot: join(mkdtempSync(join(tmpdir(), 'openkit-provenance-failed-')), 'export'),
      evidenceBundles: [
        { ...(input.evidenceBundles![0] as Record<string, unknown>), importStatus: 'quarantined' },
      ],
      runtimeEvidence: [
        {
          ...(input.runtimeEvidence![0] as Record<string, unknown>),
          id: createWorkerRuntimeProvenanceEvidenceId(packageSnapshotId),
          evidenceBundleIds: [rawBundleId],
          contentDigests: [rawDigest],
          outcome: 'failed',
          errorCode: 'worker_runtime_provenance_invalid',
          errorMessage: 'Worker runtime provenance verification failed.',
        },
      ],
      runtimeProvenanceIndexes: new Map(),
      capabilityCalls: (await createLineageExportInput()).capabilityCalls,
    });
    expect(failedRaw.binaryFileContents.get(rawPath)).toEqual(rawBytes);
  });
});

// This fixture supplies confirmed image evidence; the production resolver and subject checks still run.
vi.mock('../runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    '../test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});

describe('slice 1d portable call fields', () => {
  it('preserves route extensions and present or absent system-prompt digests through archive export', async () => {
    const input = await createLineageExportInput();
    const digest = `sha256:${'b'.repeat(64)}`;
    const lineage = {
      logicalModelId: 'tier',
      entries: [
        {
          kind: 'attempt',
          routeMemberId: 'primary',
          providerProfileId: 'profile',
          providerModel: 'native',
          selectionReason: 'primary',
          attemptOrder: 0,
          retryIndex: 0,
          outputBegan: true,
          terminalResult: 'succeeded',
          usageRecordIds: ['use_00000000-0000-7833-a8fc-60af429f21b9'],
        },
      ],
    };
    input.capabilityCalls = [
      {
        ...input.capabilityCalls![0],
        capabilityId: 'llm.responses',
        family: 'llm',
        systemPromptDigest: digest,
        extensions: {
          'openkit.gateway/routeLineage': lineage,
          'future.example/evidence': { label: 'retained' },
        },
      },
      { ...input.capabilityCalls![0], id: 'cap_00000000-0000-7ff2-b713-d35db1d00ca0' },
    ];
    const sourceDb = openWorkspaceDb(
      mkdtempSync(join(tmpdir(), 'gateway-call-source-')),
      source.workspaceId
    );
    try {
      applyScopedMigrations(sourceDb, undefined, 'pre-knowledge');
      importWorkspaceCapabilityUsageLedger({
        workspaceDb: sourceDb,
        capabilityCalls: input.capabilityCalls as never,
        usageRecords: [],
      });
      sourceDb.sqlite
        .prepare('UPDATE capability_calls SET extensions_json = ? WHERE call_id = ?')
        .run(
          JSON.stringify({
            'openkit.gateway/routeLineage': lineage,
            'future.example/evidence': { label: 'retained' },
          }),
          'cap_00000000-0000-711a-9c64-db220d6b90dc'
        );
      input.capabilityCalls = listWorkspaceCapabilityCalls(sourceDb, source.workspaceId);
    } finally {
      sourceDb.sqlite.close();
    }
    const exportRoot = join(mkdtempSync(join(tmpdir(), 'gateway-call-export-')), 'export');
    const verified = writeWorkspaceExportTree({ ...input, exportRoot });
    const calls = verified.fileContents
      .get('records/capability-calls.jsonl')!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id?: string });
    expect(
      calls.find((call) => call.id === 'cap_00000000-0000-711a-9c64-db220d6b90dc')
    ).toMatchObject({
      systemPromptDigest: digest,
      extensions: {
        'openkit.gateway/routeLineage': lineage,
        'future.example/evidence': { label: 'retained' },
      },
    });
    const absent = calls.find((call) => call.id === 'cap_00000000-0000-7ff2-b713-d35db1d00ca0');
    expect(absent).not.toHaveProperty('systemPromptDigest');
    expect(absent).not.toHaveProperty('extensions');
  });
});
