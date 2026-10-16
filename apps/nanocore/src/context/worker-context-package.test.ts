// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import { deriveEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  createStructuredWorkerDelegationRequest,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import {
  commandInputHash,
  conversationTaskThreadId,
  conversationTaskTurnId,
} from '../runtime/idempotent-command.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import {
  buildWorkerContextPackageWorkspaceInput,
  createWorkerContextPackageFiles,
  createWorkerContextPackagePolicyDigest,
  createWorkerContextPackageTrace,
  parseWorkerContextPackageTrace,
  readPortableWorkerContextPackageTrace,
  readWorkerContextPackageTrace,
  serializeWorkerContextPackageTrace,
  verifyImportedWorkerContextPackageTrace,
  verifyPortableWorkerContextPackageTrace,
  verifyWorkerContextPackageTrace,
  type WorkerContextPackageAuthorityReader,
  type WorkerContextPackageFiles,
  WorkerContextPackageManifestSchema,
  type WorkerContextPackageTrace,
  writeWorkerContextPackageFiles,
  writeWorkerContextPackageTrace,
} from './worker-context-package.js';

/** Fixed timestamp shared by accepted-Turn authority fixtures. */
const TURN_STARTED_AT = '2026-07-18T00:00:00.000Z';

/** Exact structured worker request retained by the same-Turn request Item. */
const WORKER_REQUEST_BYTES = serializeStructuredWorkerDelegationRequest(
  createStructuredWorkerDelegationRequest({
    acceptanceCriteria: ['The S39 verifier remains fail closed.'],
    constraints: { maxContextTokens: 4_096, maxWorkerIterations: 1 },
    contextRefs: [
      { kind: 'workspace', id: 'ws_00000000-0000-7990-bde7-4411160ea0db' },
      { kind: 'thread', id: 'th_00000000-0000-7ba9-ab4a-4397e62aa2e5' },
      { kind: 'item', id: 'it_00000000-0000-767c-97eb-d0af46940f44' },
      { kind: 'item', id: 'it_00000000-0000-7d5c-b364-336c2c54fdf3' },
      { kind: 'item', id: 'it_00000000-0000-7a18-85bb-ebc66a6f69bc' },
    ],
    escalationConditions: [],
    expectedArtifacts: [],
    objective: 'Implement S39.',
    resources: [],
    reviewContext: null,
    reviewPolicy: {
      instructions: 'Review the exact S39 trace.',
      required: true,
      reviewers: ['human'],
    },
    verification: [
      {
        command: 'pnpm --filter @openkit/nanocore exec vitest run src/context',
        description: 'Run the focused Context Package tests.',
        kind: 'command',
      },
    ],
  })
);

/** Exact reviewed Knowledge Page bytes selected by the governed retrieval owner. */
const KNOWLEDGE_PAGE_BYTES = [
  '---',
  'type: "KnowledgePage"',
  'title: "Task Mode conventions"',
  'openkit_status: "active"',
  'status: "stable"',
  'scope: "workspace"',
  'source_refs: ["source:ks_00000000-0000-7971-9553-9dd821fd7f55", "source:ks_00000000-0000-7930-9f0d-0ed5d41a7410"]',
  'review_state: "accepted"',
  'sensitivity: "public"',
  'freshness: "current"',
  '---',
  'Use the existing direct Task worker path.',
  '',
].join('\n');

/** Computes the public SHA-256 format for exact UTF-8 bytes. */
function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/** Recomputes the canonical trace digest after a test changes immutable trace fields. */
function rewriteTrace(
  trace: WorkerContextPackageTrace,
  changes: Partial<Omit<WorkerContextPackageTrace, 'contextPackageDigest'>>
): WorkerContextPackageTrace {
  const { contextPackageDigest: _priorDigest, ...traceWithoutDigest } = { ...trace, ...changes };
  return {
    ...traceWithoutDigest,
    contextPackageDigest: `ctxpkg_sha256_${commandInputHash(traceWithoutDigest).slice('sha256:'.length)}`,
  };
}

/** Derives the fixture's receiving Thread and first Turn from the complete user handoff name. */
function fixtureChatTaskTurnId(
  actorId: string,
  workspaceId: string,
  originatingThreadId: string,
  requestId: string
): string {
  const actor = { kind: 'user' as const, id: actorId };
  const receivingThreadId = conversationTaskThreadId(
    actor,
    workspaceId,
    originatingThreadId,
    requestId
  );
  return conversationTaskTurnId(
    actor,
    workspaceId,
    originatingThreadId,
    receivingThreadId,
    requestId
  );
}

/** Creates deterministic package bytes for one worker Turn. */
function createPackage(
  workspaceRoot: string,
  writeFiles = true,
  turnId = 'tu_00000000-0000-71df-9e29-90f5b5578e47',
  threadId = 'th_00000000-0000-7ba9-ab4a-4397e62aa2e5'
): WorkerContextPackageFiles {
  const packageFiles = createWorkerContextPackageFiles({
    contextBudgetTokens: 4_096,
    includedItemIds: [
      'it_00000000-0000-7a3c-ae74-d9d096838a5d',
      'it_00000000-0000-767c-97eb-d0af46940f44',
      'it_00000000-0000-7d5c-b364-336c2c54fdf3',
      'it_00000000-0000-7a18-85bb-ebc66a6f69bc',
    ],
    materialSelections: [
      {
        bindingMutationRequestId: 'req_bind_2',
        content: 'Second material.\n',
        contentDigest: sha256('Second material.\n'),
        inclusionReason: 'thread_binding',
        materialId: 'mat_00000000-0000-71c3-b271-61d90d2cd29c',
        mediaType: 'text/plain',
        parentRevisionId: null,
        revisionId: 'mrev_00000000-0000-7000-8000-000000000003',
        sensitivity: 'internal',
      },
      {
        bindingMutationRequestId: 'req_bind_1',
        content: '# First material\n',
        contentDigest: sha256('# First material\n'),
        inclusionReason: 'thread_binding',
        materialId: 'mat_00000000-0000-7dff-bea7-c084ff4fb19f',
        mediaType: 'text/markdown',
        parentRevisionId: 'mrev_00000000-0000-7000-8000-000000000001',
        revisionId: 'mrev_00000000-0000-7000-8000-000000000002',
        sensitivity: 'public',
      },
    ],
    threadId,
    turnId,
    workerRequestBytes: WORKER_REQUEST_BYTES,
    workerRequestItemId: 'it_00000000-0000-7a3c-ae74-d9d096838a5d',
    workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
  });

  if (writeFiles) {
    writeWorkerContextPackageFiles(workspaceRoot, packageFiles);
  }
  return packageFiles;
}

/** Creates one resolved AEP carrying the exact dedicated generated context input. */
function createEnvironmentPackage(
  packageFiles: WorkerContextPackageFiles,
  requestId = 'req_context'
): AgentEnvironmentPackage {
  const unresolved = resolveAgentEnvironmentPackage({
    captureCoverage: { scope: 'server', value: 'off' },
    agent: {
      id: 'agent_context',
      name: 'Context Agent',
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
        baseUrl: null,
        capabilities: [],
        command: null,
        environment: {},
        workspaceRoot: '/workspace',
      },
    },
    agentSessionId: 'as_00000000-0000-77fe-a8c9-41ee91fa0b94',
    agentSetup: createTestAgentSetup(),
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    backend: {
      kind: 'openshell',
    },
    requestId,
    turn: {
      completedAt: null,
      configVersion: null,
      durationMs: null,
      error: null,
      id: packageFiles.turnId,
      items: [],
      startedAt: TURN_STARTED_AT,
      status: 'running',
      threadId: packageFiles.threadId,
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      workspaceId: packageFiles.workspaceId,
    },
    turnInput: WORKER_REQUEST_BYTES,
    userId: 'usr_00000000-0000-7696-a706-77197ba0ca6d',
    workspaceCwd: '/workspace',
    workspaceRoots: [],
  });

  return AgentEnvironmentPackageSchema.parse({
    ...unresolved,
    scope: { ...unresolved.scope, itemId: 'it_00000000-0000-7a3c-ae74-d9d096838a5d' },
    workspace: {
      ...unresolved.workspace,
      inputs: [
        buildWorkerContextPackageWorkspaceInput({
          agentSessionId: 'as_00000000-0000-77fe-a8c9-41ee91fa0b94',
          packageRootDigest: packageFiles.packageRootDigest,
          threadId: packageFiles.threadId,
          turnId: packageFiles.turnId,
        }),
      ],
    },
  });
}

/** Creates an accepted trace and every dependency used by the shared verifier. */
function createAcceptedFixture(
  workspaceRoot: string,
  options: {
    readonly requestId?: string;
    readonly turnId?: string;
    readonly threadId?: string;
    readonly knowledge?: boolean;
  } = {}
): {
  authorities: WorkerContextPackageAuthorityReader;
  packageFiles: WorkerContextPackageFiles;
  trace: WorkerContextPackageTrace;
} {
  const threadId = options.threadId ?? 'th_00000000-0000-7ba9-ab4a-4397e62aa2e5';
  const requestId = options.requestId ?? 'req_context';
  const turnId = options.turnId ?? 'tu_00000000-0000-71df-9e29-90f5b5578e47';
  let packageFiles = createPackage(workspaceRoot, !options.knowledge, turnId, threadId);
  if (options.knowledge) {
    packageFiles = createWorkerContextPackageFiles({
      contextBudgetTokens: 4_096,
      includedItemIds: packageFiles.includedItemIds,
      knowledgeSelections: [
        {
          content: KNOWLEDGE_PAGE_BYTES,
          contentDigest: sha256(KNOWLEDGE_PAGE_BYTES),
          knowledgePageId: 'lessons/task-mode',
          sourceRefs: [
            'source:ks_00000000-0000-7971-9553-9dd821fd7f55',
            'source:ks_00000000-0000-7930-9f0d-0ed5d41a7410',
          ],
        },
      ],
      materialSelections: packageFiles.materialSelections.map((selection) => ({
        ...selection,
        content:
          selection.materialId === 'mat_00000000-0000-7dff-bea7-c084ff4fb19f'
            ? '# First material\n'
            : 'Second material.\n',
      })),
      threadId,
      turnId,
      workerRequestBytes: WORKER_REQUEST_BYTES,
      workerRequestItemId: 'it_00000000-0000-7a3c-ae74-d9d096838a5d',
      workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
    });
    writeWorkerContextPackageFiles(workspaceRoot, packageFiles);
  }
  const environmentPackage = createEnvironmentPackage(packageFiles, requestId);
  const trace = createWorkerContextPackageTrace({
    agentSessionId: 'as_00000000-0000-77fe-a8c9-41ee91fa0b94',
    excludedItems: [
      { itemId: 'it_00000000-0000-7c65-bb19-0a17869ca8da', reason: 'policy_excluded' },
    ],
    goalId: options.knowledge ? null : 'goal_context',
    knowledgeSelectionInput: options.knowledge
      ? {
          retrievalTraceRef: {
            scopeId: `retrieval-trace/turn/ws_00000000-0000-7990-bde7-4411160ea0db/${threadId}/${turnId}`,
            objectId: 'krt_0190f4c8-0000-7000-8000-000000000399',
          },
        }
      : null,
    knowledgeExclusions: options.knowledge
      ? [
          {
            knowledgePageId: 'lessons/omitted',
            contentDigest: sha256('Omitted page'),
            reason: 'budget_exceeded',
          },
        ]
      : [],
    materialExclusions: [
      {
        materialId: 'mat_00000000-0000-7d3d-a336-0dbae085eb7e',
        reason: 'sensitive_content',
        revisionId: 'mrev_00000000-0000-7000-8000-000000000004',
        sensitivity: 'restricted',
      },
    ],
    packageFiles,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId,
    taskId: options.knowledge ? null : 'task_context',
  });
  const requiredCapabilities = environmentPackage.backend.requiredCapabilities;
  const workspaceInputSnapshot = {
    backend: {
      capabilitySummary: [...requiredCapabilities],
      kind: 'openshell' as const,
      label: 'openshell worker backend',
    },
    base: { commit: null, contentDigest: packageFiles.packageRootDigest },
    createdAt: TURN_STARTED_AT,
    generatedFiles: [],
    id: trace.workspaceInputSnapshotId,
    ignoredPaths: [],
    pathScope: [`context_${turnId}`],
    resourceId: `context_${turnId}`,
    resourceKind: 'filesystem' as const,
    strategy: 'filesystem' as const,
    workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
    writableRoots: [],
  };
  const readinessEvidence = [
    { kind: 'backend.ready', ref: 'version:0.0.80' },
    { kind: 'sandbox.created', ref: 'sandbox_context' },
  ];
  const workspaceMaterializationRecord = {
    backendKind: 'openshell' as const,
    base: workspaceInputSnapshot.base,
    createdAt: TURN_STARTED_AT,
    id: trace.workspaceMaterializationRecordId,
    inputSnapshotId: workspaceInputSnapshot.id,
    materializedRootRef: '/openkit/sessions/as_00000000-0000-77fe-a8c9-41ee91fa0b94/context',
    packageSnapshotId: environmentPackage.snapshotId,
    policyDigest: createWorkerContextPackagePolicyDigest({
      backendKind: 'openshell',
      packageSnapshotId: environmentPackage.snapshotId,
      requiredCapabilities,
    }),
    readinessEvidence,
    strategy: 'filesystem' as const,
    workerSessionId: 'sandbox_context',
    workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
  };
  const materials = new Map([
    ...packageFiles.materialSelections.map(
      (selection) =>
        [
          `${selection.materialId}:${selection.revisionId}`,
          {
            ...selection,
            content:
              selection.materialId === 'mat_00000000-0000-7dff-bea7-c084ff4fb19f'
                ? '# First material\n'
                : 'Second material.\n',
            workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
          },
        ] as const
    ),
    [
      'mat_00000000-0000-7d3d-a336-0dbae085eb7e:mrev_00000000-0000-7000-8000-000000000004',
      {
        content: 'Restricted material.\n',
        contentDigest: sha256('Restricted material.\n'),
        materialId: 'mat_00000000-0000-7d3d-a336-0dbae085eb7e',
        mediaType: 'text/plain',
        parentRevisionId: null,
        revisionId: 'mrev_00000000-0000-7000-8000-000000000004',
        sensitivity: 'restricted' as const,
        workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
      },
    ] as const,
  ]);
  const authorities: WorkerContextPackageAuthorityReader = {
    readAdmission: () => ({
      requestId,
      status: 'admitted',
      threadId,
      turnId,
      workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
    }),
    readAgentEnvironmentPackage: () => environmentPackage,
    readAgentSession: () => ({
      environmentPackageSnapshotId: environmentPackage.snapshotId,
      id: 'as_00000000-0000-77fe-a8c9-41ee91fa0b94',
      stale: false,
      threadId,
      workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
    }),
    readBackendHandoff: () => ({
      agentSessionId: 'as_00000000-0000-77fe-a8c9-41ee91fa0b94',
      backendKind: 'openshell',
      backendSessionId: 'sandbox_context',
      packageSnapshotId: environmentPackage.snapshotId,
      readinessEvidence,
      threadId,
      turnId,
      workspaceHandoffState: 'complete',
      workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
    }),
    readMaterialRevision: (_workspaceId, materialId, revisionId) =>
      materials.get(`${materialId}:${revisionId}`) ?? null,
    readThreadItems: () => [
      {
        id: 'it_00000000-0000-767c-97eb-d0af46940f44',
        status: 'completed',
        text: 'Prior context',
        threadId,
        turnId: 'tu_00000000-0000-744f-ab60-309003770eba',
        type: 'user-message',
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
      },
      {
        id: 'it_00000000-0000-7c65-bb19-0a17869ca8da',
        status: 'completed',
        text: 'Private diagnostic',
        threadId,
        turnId: 'tu_00000000-0000-744f-ab60-309003770eba',
        type: 'status',
        workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
      },
      {
        id: 'it_00000000-0000-7d5c-b364-336c2c54fdf3',
        status: 'completed',
        text: 'Approve the next attempt?',
        threadId,
        turnId: 'tu_00000000-0000-7dbb-847c-c60d46fbd63a',
        type: 'approval-request',
        workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
      },
      {
        id: 'it_00000000-0000-7a18-85bb-ebc66a6f69bc',
        status: 'completed',
        text: 'Approved',
        threadId,
        turnId: 'tu_00000000-0000-7dbb-847c-c60d46fbd63a',
        type: 'approval-decision',
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        causationId: 'it_00000000-0000-7d5c-b364-336c2c54fdf3',
        workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
      },
      {
        id: 'it_00000000-0000-7a3c-ae74-d9d096838a5d',
        status: 'completed',
        text: WORKER_REQUEST_BYTES,
        threadId,
        turnId,
        type: 'user-message',
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
      },
    ],
    readThreadParent: () => null,
    readTurn: () => ({
      agentSessionId: 'as_00000000-0000-77fe-a8c9-41ee91fa0b94',
      id: turnId,
      startedAt: TURN_STARTED_AT,
      threadId,
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
    }),
    readWorkspaceInputSnapshot: () => workspaceInputSnapshot,
    readWorkspaceImportedFrom: () => null,
    readWorkspaceMaterializationRecord: () => workspaceMaterializationRecord,
  };

  return { authorities, packageFiles, trace };
}

/**
 * Creates one reminted imported-history trace with matching portable owners and runtime lookalikes.
 *
 * @param workspaceRoot Temporary Workspace root that receives exact package files.
 * @param directLike Whether the portable trace omits Goal and Task lineage with null Knowledge.
 * @returns Imported trace authorities, trace, and a counter for forbidden runtime-owner reads.
 */
function createImportedHistoryFixture(
  workspaceRoot: string,
  directLike = false
): {
  authorities: WorkerContextPackageAuthorityReader;
  runtimeAuthorityReads: () => number;
  trace: WorkerContextPackageTrace;
} {
  const accepted = createAcceptedFixture(workspaceRoot);
  const requestId = `import-lineage:sha256:${'a'.repeat(64)}`;
  const packageSnapshotId = 'aepsnap_imported_ws_context_1';
  const agentSessionId = 'as_00000000-0000-7f31-8c50-7698630923dd';
  const historicalWorkerSessionId = `import-history-worker_${packageSnapshotId}`;
  const importedTrace = createWorkerContextPackageTrace({
    agentSessionId,
    excludedItems: accepted.trace.excludedItems,
    goalId: accepted.trace.goalId,
    materialExclusions: accepted.trace.materialExclusions,
    packageFiles: accepted.packageFiles,
    packageSnapshotId,
    requestId,
    taskId: accepted.trace.taskId,
  });
  const trace = directLike
    ? rewriteTrace(importedTrace, { goalId: null, taskId: null })
    : importedTrace;
  const sourceEnvironmentPackage = accepted.authorities.readAgentEnvironmentPackage(
    accepted.trace.workspaceId,
    accepted.trace.packageSnapshotId
  )!;
  const environmentPackage = {
    ...sourceEnvironmentPackage,
    snapshotId: packageSnapshotId,
    scope: {
      ...sourceEnvironmentPackage.scope,
      agentSessionId,
      requestId,
    },
    workspace: {
      ...sourceEnvironmentPackage.workspace,
      inputs: sourceEnvironmentPackage.workspace.inputs.map((input) => ({
        ...input,
        target: `/openkit/sessions/${agentSessionId}/context`,
      })),
    },
  };
  const sourceInputSnapshot = accepted.authorities.readWorkspaceInputSnapshot(
    accepted.trace.workspaceId,
    accepted.trace.workspaceInputSnapshotId
  )!;
  const workspaceInputSnapshot = {
    ...sourceInputSnapshot,
    id: trace.workspaceInputSnapshotId,
  };
  const sourceMaterialization = accepted.authorities.readWorkspaceMaterializationRecord(
    accepted.trace.workspaceId,
    accepted.trace.workspaceMaterializationRecordId
  )!;
  const readinessEvidence = [
    { kind: 'backend.ready', ref: 'version:0.0.80' },
    { kind: 'sandbox.created', ref: historicalWorkerSessionId },
  ];
  const workspaceMaterializationRecord = {
    ...sourceMaterialization,
    id: trace.workspaceMaterializationRecordId,
    materializedRootRef: `/openkit/sessions/${agentSessionId}/context`,
    inputSnapshotId: trace.workspaceInputSnapshotId,
    packageSnapshotId,
    policyDigest: createWorkerContextPackagePolicyDigest({
      backendKind: 'openshell',
      packageSnapshotId,
      requiredCapabilities: environmentPackage.backend.requiredCapabilities,
    }),
    readinessEvidence,
    workerSessionId: historicalWorkerSessionId,
  };
  let runtimeAuthorityReads = 0;

  return {
    authorities: {
      ...accepted.authorities,
      readAdmission: () => {
        runtimeAuthorityReads += 1;
        return null;
      },
      readAgentEnvironmentPackage: () => environmentPackage,
      readAgentSession: () => ({
        environmentPackageSnapshotId: packageSnapshotId,
        id: agentSessionId,
        stale: true,
        threadId: trace.threadId,
        workspaceId: trace.workspaceId,
      }),
      readBackendHandoff: () => {
        runtimeAuthorityReads += 1;
        return null;
      },
      readTurn: (...args) => {
        const turn = accepted.authorities.readTurn(...args);
        return turn ? { ...turn, agentSessionId } : null;
      },
      readWorkspaceInputSnapshot: () => workspaceInputSnapshot,
      readWorkspaceImportedFrom: () => ({
        exportCreatedAt: TURN_STARTED_AT,
        manifestDigest: `sha256:${'b'.repeat(64)}`,
        sourceDeploymentId: 'deployment_source',
        sourceWorkspaceId: 'ws_00000000-0000-71b1-9af2-985861a05396',
      }),
      readWorkspaceMaterializationRecord: () => workspaceMaterializationRecord,
    },
    runtimeAuthorityReads: () => runtimeAuthorityReads,
    trace,
  };
}

/**
 * Creates a complete live trace fixture whose structured request carries null Knowledge.
 *
 * @param workspaceRoot Temporary Workspace root that receives the package bytes.
 * @param options Exact Turn identity and persisted trigger actor.
 * @returns Strict-verifier authorities and a digest-valid null-Knowledge trace.
 */
function createLiveNullKnowledgeFixture(
  workspaceRoot: string,
  options: {
    readonly turnId: string;
    readonly triggerActor?: {
      readonly id: string;
      readonly kind: 'agent' | 'user';
      readonly responsibleUserId?: string | null;
    };
  }
): {
  authorities: WorkerContextPackageAuthorityReader;
  trace: WorkerContextPackageTrace;
} {
  const originatingThreadId = 'th_00000000-0000-7ba9-ab4a-4397e62aa2e5';
  const threadId = conversationTaskThreadId(
    { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    'ws_00000000-0000-7990-bde7-4411160ea0db',
    originatingThreadId,
    'req_context'
  );
  const fixture = createAcceptedFixture(workspaceRoot, { turnId: options.turnId, threadId });
  const triggerActor = options.triggerActor ?? {
    kind: 'user' as const,
    id: 'usr_00000000-0000-7000-8000-000000000001',
  };
  return {
    authorities: {
      ...fixture.authorities,
      readThreadParent: () => originatingThreadId,
      readTurn: (...args) => {
        const turn = fixture.authorities.readTurn(...args);
        return turn ? { ...turn, triggerActor } : null;
      },
    },
    trace: rewriteTrace(fixture.trace, { goalId: null, taskId: null }),
  };
}

describe('worker Context Package owner', () => {
  it.each([
    false,
    true,
  ])('verifies extended retained traces and manifests against original bytes, then reopens (Knowledge: %s)', (knowledge) => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-context-extended-'));
    const fixture = createAcceptedFixture(workspaceRoot, { knowledge });
    const packagePath = join(
      workspaceRoot,
      'threads/th_00000000-0000-7ba9-ab4a-4397e62aa2e5/turns/tu_00000000-0000-71df-9e29-90f5b5578e47/context-package/package.json'
    );
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    manifest.annotation = 'manifest';
    manifest.materialSelections[0].annotation = 'manifest selection';
    if (knowledge) manifest.knowledgeSelections[0].annotation = 'manifest Knowledge selection';
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
    const bytes = canonical(manifest);
    writeFileSync(packagePath, bytes);
    const raw = JSON.parse(JSON.stringify(fixture.trace));
    raw.annotation = 'trace';
    raw.retainedTrace = { ignored: 'untrusted metadata cannot replace trace bytes' };
    if (knowledge) {
      raw.knowledgeSelectionInput.annotation = 'retrieval input';
      raw.knowledgeSelectionInput.retrievalTraceRef.annotation = 'qualified reference';
      raw.knowledgeSelections[0].annotation = 'Knowledge selection';
      raw.knowledgeExclusions[0].annotation = 'Knowledge exclusion';
    }
    raw.materialSelections[0].annotation = 'selection';
    raw.materialExclusions[0].annotation = 'exclusion';
    raw.excludedItems[0].annotation = 'item';
    const entry = raw.fileInventory.find(
      (entry: { path: string }) => entry.path === 'package.json'
    );
    entry.byteLength = Buffer.byteLength(bytes);
    entry.contentDigest = sha256(bytes);
    const { contextPackageDigest: _prior, ...withoutDigest } = raw;
    raw.contextPackageDigest = `ctxpkg_sha256_${sha256(canonical(withoutDigest)).slice(7)}`;
    const originalRead = fixture.authorities.readWorkspaceInputSnapshot;
    const packageRootDigest = sha256(canonical(raw.fileInventory));
    fixture.authorities.readWorkspaceInputSnapshot = (...args) => ({
      ...originalRead(...args)!,
      base: { commit: null, contentDigest: packageRootDigest },
    });
    const originalAep = fixture.authorities.readAgentEnvironmentPackage;
    fixture.authorities.readAgentEnvironmentPackage = (...args) => {
      const aep = structuredClone(originalAep(...args)!);
      aep.workspace.inputs[0]!.materialization!.contentDigest = packageRootDigest;
      return aep;
    };
    const originalWmr = fixture.authorities.readWorkspaceMaterializationRecord;
    fixture.authorities.readWorkspaceMaterializationRecord = (...args) => ({
      ...originalWmr(...args)!,
      base: { commit: null, contentDigest: packageRootDigest },
    });
    const read = parseWorkerContextPackageTrace(raw);
    expect(read).not.toHaveProperty('annotation');
    expect(JSON.stringify(read)).not.toContain('annotation');
    expect(
      verifyWorkerContextPackageTrace({ ...fixture, trace: read, workspaceRoot })
        .contextPackageDigest
    ).toBe(raw.contextPackageDigest);
    writeWorkerContextPackageTrace({ ...fixture, trace: read, workspaceRoot });
    expect(
      readWorkerContextPackageTrace({
        authorities: fixture.authorities,
        workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
        threadId: 'th_00000000-0000-7ba9-ab4a-4397e62aa2e5',
        turnId: 'tu_00000000-0000-71df-9e29-90f5b5578e47',
        workspaceRoot,
      })
    ).toEqual(read);
    expect(readFileSync(packagePath, 'utf8')).toBe(bytes);
    expect(JSON.parse(serializeWorkerContextPackageTrace(read))).toEqual(raw);
    Object.assign(read, { requestId: 'req_changed' });
    expect(() => parseWorkerContextPackageTrace(read)).toThrow('retained core mismatch');
    expect(() => serializeWorkerContextPackageTrace(read)).toThrow('retained core mismatch');
  });

  it('builds deterministic files, inventory, digests, and the exact generated AEP input', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-'));
    const first = createPackage(workspaceRoot);
    const second = createWorkerContextPackageFiles({
      contextBudgetTokens: 4_096,
      includedItemIds: [
        'it_00000000-0000-7a3c-ae74-d9d096838a5d',
        'it_00000000-0000-767c-97eb-d0af46940f44',
        'it_00000000-0000-7d5c-b364-336c2c54fdf3',
        'it_00000000-0000-7a18-85bb-ebc66a6f69bc',
      ],
      materialSelections: first.materialSelections.map((selection) => ({
        ...selection,
        content:
          selection.materialId === 'mat_00000000-0000-7dff-bea7-c084ff4fb19f'
            ? '# First material\n'
            : 'Second material.\n',
      })),
      threadId: 'th_00000000-0000-7ba9-ab4a-4397e62aa2e5',
      turnId: 'tu_00000000-0000-71df-9e29-90f5b5578e47',
      workerRequestBytes: WORKER_REQUEST_BYTES,
      workerRequestItemId: 'it_00000000-0000-7a3c-ae74-d9d096838a5d',
      workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
    });

    expect(second).toEqual(first);
    expect(first.fileInventory.map((entry) => entry.path)).toEqual([
      'instructions.md',
      'package.json',
      'workspace/materials/mat_00000000-0000-71c3-b271-61d90d2cd29c/mrev_00000000-0000-7000-8000-000000000003.txt',
      'workspace/materials/mat_00000000-0000-7dff-bea7-c084ff4fb19f/mrev_00000000-0000-7000-8000-000000000002.md',
    ]);
    expect(
      first.fileInventory.every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.contentDigest))
    ).toBe(true);
    expect(first.packageRootDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.workerRequestDigest).toBe(sha256(WORKER_REQUEST_BYTES));

    const manifestBytes = first.files.find((file) => file.path === 'package.json')?.bytes;
    const manifest = JSON.parse(Buffer.from(manifestBytes ?? []).toString('utf8'));
    expect(manifest).toMatchObject({
      contextPackageId: 'ctxpkg_tu_00000000-0000-71df-9e29-90f5b5578e47',
      includedItemIds: [
        'it_00000000-0000-7a3c-ae74-d9d096838a5d',
        'it_00000000-0000-767c-97eb-d0af46940f44',
        'it_00000000-0000-7d5c-b364-336c2c54fdf3',
        'it_00000000-0000-7a18-85bb-ebc66a6f69bc',
      ],
      policyVersion: 'worker-context-v1',
      schemaVersion: 1,
      threadId: 'th_00000000-0000-7ba9-ab4a-4397e62aa2e5',
      turnId: 'tu_00000000-0000-71df-9e29-90f5b5578e47',
      workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
    });
    expect(manifest).not.toHaveProperty('contextPackageDigest');
    expect(manifest.fileInventory.map((entry: { path: string }) => entry.path)).not.toContain(
      'package.json'
    );
    expect(
      buildWorkerContextPackageWorkspaceInput({
        agentSessionId: 'as_00000000-0000-77fe-a8c9-41ee91fa0b94',
        packageRootDigest: first.packageRootDigest,
        threadId: 'th_00000000-0000-7ba9-ab4a-4397e62aa2e5',
        turnId: 'tu_00000000-0000-71df-9e29-90f5b5578e47',
      })
    ).toEqual({
      access: 'read-only',
      id: 'context_tu_00000000-0000-71df-9e29-90f5b5578e47',
      kind: 'generated',
      materialization: {
        contentDigest: first.packageRootDigest,
        slotId: 'context',
        strategy: 'filesystem',
      },
      source: {
        kind: 'generated',
        pathRef:
          'threads/th_00000000-0000-7ba9-ab4a-4397e62aa2e5/turns/tu_00000000-0000-71df-9e29-90f5b5578e47/context-package',
      },
      target: '/openkit/sessions/as_00000000-0000-77fe-a8c9-41ee91fa0b94/context',
    });
    expect(
      readFileSync(
        join(
          workspaceRoot,
          'threads/th_00000000-0000-7ba9-ab4a-4397e62aa2e5/turns/tu_00000000-0000-71df-9e29-90f5b5578e47/context-package/instructions.md'
        ),
        'utf8'
      )
    ).toBe(WORKER_REQUEST_BYTES);
  });

  it('materializes one governed Knowledge selection into the existing package and trace', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-knowledge-'));
    const retrievalTraceId = 'krt_0190f4c8-0000-7000-8000-000000000399';
    const retrievalTraceRef = {
      scopeId:
        'retrieval-trace/turn/ws_00000000-0000-7990-bde7-4411160ea0db/th_00000000-0000-7ba9-ab4a-4397e62aa2e5/tu_00000000-0000-71df-9e29-90f5b5578e47',
      objectId: retrievalTraceId,
    };
    const contentDigest = sha256(KNOWLEDGE_PAGE_BYTES);
    const packageFiles = createWorkerContextPackageFiles({
      contextBudgetTokens: 4_096,
      includedItemIds: ['it_00000000-0000-7a3c-ae74-d9d096838a5d'],
      knowledgeSelections: [
        {
          content: KNOWLEDGE_PAGE_BYTES,
          contentDigest,
          knowledgePageId: 'lessons/task-mode',
          sourceRefs: [
            'source:ks_00000000-0000-7930-9f0d-0ed5d41a7410',
            'source:ks_00000000-0000-7971-9553-9dd821fd7f55',
          ],
        },
      ],
      materialSelections: [],
      threadId: 'th_00000000-0000-7ba9-ab4a-4397e62aa2e5',
      turnId: 'tu_00000000-0000-71df-9e29-90f5b5578e47',
      workerRequestBytes: WORKER_REQUEST_BYTES,
      workerRequestItemId: 'it_00000000-0000-7a3c-ae74-d9d096838a5d',
      workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
    });
    writeWorkerContextPackageFiles(workspaceRoot, packageFiles);

    const expectedSelection = {
      contentDigest,
      knowledgePageId: 'lessons/task-mode',
      packagePath: 'knowledge/pages/lessons/task-mode.md',
      sourceRefs: [
        'source:ks_00000000-0000-7930-9f0d-0ed5d41a7410',
        'source:ks_00000000-0000-7971-9553-9dd821fd7f55',
      ],
    };
    expect(packageFiles).toMatchObject({
      knowledgeSelections: [expectedSelection],
    });
    expect(packageFiles.fileInventory.map((entry) => entry.path)).toEqual([
      'instructions.md',
      'knowledge/pages/lessons/task-mode.md',
      'package.json',
    ]);
    expect(
      readFileSync(
        join(
          workspaceRoot,
          'threads/th_00000000-0000-7ba9-ab4a-4397e62aa2e5/turns/tu_00000000-0000-71df-9e29-90f5b5578e47/context-package/knowledge/pages/lessons/task-mode.md'
        ),
        'utf8'
      )
    ).toBe(KNOWLEDGE_PAGE_BYTES);
    const manifestBytes = packageFiles.files.find((file) => file.path === 'package.json')?.bytes;
    expect(JSON.parse(Buffer.from(manifestBytes ?? []).toString('utf8'))).toMatchObject({
      knowledgeSelections: [expectedSelection],
    });
    expect(JSON.parse(Buffer.from(manifestBytes ?? []).toString('utf8'))).not.toHaveProperty(
      'knowledgeSelectionInput'
    );
    expect(JSON.parse(Buffer.from(manifestBytes ?? []).toString('utf8'))).not.toHaveProperty(
      'knowledgeExclusions'
    );

    const traceInput = {
      agentSessionId: 'as_00000000-0000-77fe-a8c9-41ee91fa0b94',
      excludedItems: [],
      goalId: null,
      knowledgeExclusions: [],
      knowledgeSelectionInput: { retrievalTraceRef },
      packageFiles,
      packageSnapshotId: 'aepsnap_context',
      requestId: 'req_context',
      taskId: null,
    };
    expect(createWorkerContextPackageTrace(traceInput)).toMatchObject({
      knowledgeExclusions: [],
      knowledgeSelectionInput: { retrievalTraceRef },
      knowledgeSelections: [expectedSelection],
    });
    expect(() =>
      parseWorkerContextPackageTrace(
        createWorkerContextPackageTrace({
          ...traceInput,
          knowledgeSelectionInput: {
            retrievalTraceRef: {
              ...retrievalTraceRef,
              scopeId: 'retrieval-trace/workspace/ws_00000000-0000-7990-bde7-4411160ea0db',
            },
          },
        })
      )
    ).toThrow('Worker Context Package trace is malformed.');
    expect(() =>
      createWorkerContextPackageTrace({
        ...traceInput,
        goalId: 'goal_context',
        taskId: 'task_context',
      })
    ).toThrow();
    expect(
      createWorkerContextPackageTrace({
        ...traceInput,
        knowledgeSelectionInput: null,
        packageFiles: createPackage(workspaceRoot, false),
      })
    ).toMatchObject({
      goalId: null,
      knowledgeExclusions: [],
      knowledgeSelectionInput: null,
      knowledgeSelections: [],
      taskId: null,
    });
  });

  it('retains an explicitly prepared Knowledge selection on a receiving Chat Task Thread', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-chat-selection-'));
    const origin = 'th_00000000-0000-7ba9-ab4a-4397e62aa2e5';
    const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
    const workspaceId = 'ws_00000000-0000-7990-bde7-4411160ea0db';
    const requestId = 'req_context';
    const threadId = conversationTaskThreadId(actor, workspaceId, origin, requestId);
    const turnId = conversationTaskTurnId(actor, workspaceId, origin, threadId, requestId);
    const fixture = createAcceptedFixture(workspaceRoot, { threadId, turnId, knowledge: true });
    expect(
      writeWorkerContextPackageTrace({
        workspaceRoot,
        trace: fixture.trace,
        authorities: { ...fixture.authorities, readThreadParent: () => origin },
      })
    ).toEqual(fixture.trace);
  });

  it('accepts null Knowledge only for the exact persisted user Chat-subordinate Turn', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-chat-task-'));
    const turnId = fixtureChatTaskTurnId(
      'usr_00000000-0000-7000-8000-000000000001',
      'ws_00000000-0000-7990-bde7-4411160ea0db',
      'th_00000000-0000-7ba9-ab4a-4397e62aa2e5',
      'req_context'
    );
    const fixture = createLiveNullKnowledgeFixture(workspaceRoot, { turnId });

    expect(
      writeWorkerContextPackageTrace({
        authorities: fixture.authorities,
        trace: fixture.trace,
        workspaceRoot,
      })
    ).toEqual(fixture.trace);
    expect(
      existsSync(
        join(
          workspaceRoot,
          `threads/${fixture.trace.threadId}/turns/${turnId}/context-package.json`
        )
      )
    ).toBe(true);
  });

  it.each([
    {
      name: 'ordinary direct Task',
      turnId: deriveEntityId('tu', {
        actorId: 'usr_00000000-0000-7000-8000-000000000001',
        command: 'task.start',
        requestId: 'req_context',
        threadId: 'th_00000000-0000-7ba9-ab4a-4397e62aa2e5',
        workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
      }),
    },
    {
      name: 'trigger kind mismatch',
      triggerActor: {
        id: 'agent_context',
        kind: 'agent' as const,
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
      },
      turnId: fixtureChatTaskTurnId(
        'agent_context',
        'ws_00000000-0000-7990-bde7-4411160ea0db',
        'th_00000000-0000-7ba9-ab4a-4397e62aa2e5',
        'req_context'
      ),
    },
    {
      name: 'actor mismatch',
      turnId: fixtureChatTaskTurnId(
        'usr_00000000-0000-73d4-904a-d4c4b905df7c',
        'ws_00000000-0000-7990-bde7-4411160ea0db',
        'th_00000000-0000-7ba9-ab4a-4397e62aa2e5',
        'req_context'
      ),
    },
    {
      name: 'Workspace mismatch',
      turnId: fixtureChatTaskTurnId(
        'usr_00000000-0000-7000-8000-000000000001',
        'ws_00000000-0000-71f5-922f-6fd42f52f580',
        'th_00000000-0000-7ba9-ab4a-4397e62aa2e5',
        'req_context'
      ),
    },
    {
      name: 'Thread mismatch',
      turnId: fixtureChatTaskTurnId(
        'usr_00000000-0000-7000-8000-000000000001',
        'ws_00000000-0000-7990-bde7-4411160ea0db',
        'th_00000000-0000-78ce-b458-8347d12d1da2',
        'req_context'
      ),
    },
    {
      name: 'request mismatch',
      turnId: fixtureChatTaskTurnId(
        'usr_00000000-0000-7000-8000-000000000001',
        'ws_00000000-0000-7990-bde7-4411160ea0db',
        'th_00000000-0000-7ba9-ab4a-4397e62aa2e5',
        'req_other'
      ),
    },
  ])('rejects null Knowledge for $name before immutable trace write', ({
    triggerActor,
    turnId,
  }) => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-chat-reject-'));
    const fixture = createLiveNullKnowledgeFixture(workspaceRoot, { triggerActor, turnId });

    expect(() =>
      writeWorkerContextPackageTrace({
        authorities: fixture.authorities,
        trace: fixture.trace,
        workspaceRoot,
      })
    ).toThrow();
    expect(
      existsSync(
        join(
          workspaceRoot,
          `threads/${fixture.trace.threadId}/turns/${turnId}/context-package.json`
        )
      )
    ).toBe(false);
  });

  it('persists one immutable trace and verifies every durable owner without a checkpoint', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-trace-'));
    const fixture = createAcceptedFixture(workspaceRoot);

    expect(parseWorkerContextPackageTrace(JSON.parse(JSON.stringify(fixture.trace)))).toEqual(
      fixture.trace
    );
    expect(
      parseWorkerContextPackageTrace(
        rewriteTrace(fixture.trace, { unexpected: true } as Partial<WorkerContextPackageTrace>)
      )
    ).not.toHaveProperty('unexpected');

    expect(
      writeWorkerContextPackageTrace({
        authorities: fixture.authorities,
        trace: fixture.trace,
        workspaceRoot,
      })
    ).toEqual(fixture.trace);
    expect(
      verifyPortableWorkerContextPackageTrace({
        authorities: fixture.authorities,
        trace: fixture.trace,
        workspaceRoot,
      })
    ).toEqual({ trace: fixture.trace, verification: 'strict' });
    expect(
      readWorkerContextPackageTrace({
        authorities: fixture.authorities,
        threadId: 'th_00000000-0000-7ba9-ab4a-4397e62aa2e5',
        turnId: 'tu_00000000-0000-71df-9e29-90f5b5578e47',
        workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
        workspaceRoot,
      })
    ).toEqual(fixture.trace);
    expect(
      writeWorkerContextPackageTrace({
        authorities: fixture.authorities,
        trace: fixture.trace,
        workspaceRoot,
      })
    ).toEqual(fixture.trace);
    expect(
      existsSync(
        join(
          workspaceRoot,
          'threads/th_00000000-0000-7ba9-ab4a-4397e62aa2e5/turns/tu_00000000-0000-71df-9e29-90f5b5578e47/context-package.json'
        )
      )
    ).toBe(true);
    expect(
      readFileSync(
        join(
          workspaceRoot,
          'threads/th_00000000-0000-7ba9-ab4a-4397e62aa2e5/turns/tu_00000000-0000-71df-9e29-90f5b5578e47/context-package.json'
        ),
        'utf8'
      )
    ).toBe(serializeWorkerContextPackageTrace(fixture.trace));

    const conflicting = createWorkerContextPackageTrace({
      agentSessionId: 'as_00000000-0000-77fe-a8c9-41ee91fa0b94',
      excludedItems: [],
      goalId: 'goal_context',
      packageFiles: fixture.packageFiles,
      packageSnapshotId: fixture.trace.packageSnapshotId,
      requestId: 'req_context',
      taskId: 'task_context',
    });
    expect(() =>
      writeWorkerContextPackageTrace({
        authorities: fixture.authorities,
        trace: conflicting,
        workspaceRoot,
      })
    ).toThrow(/conflict/);
  });

  it('rejects reserved import lineage before consulting live authorities', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-import-lineage-'));
    const fixture = createAcceptedFixture(workspaceRoot);
    const authorities = new Proxy(fixture.authorities, {
      get: () => () => {
        throw new Error('live authority was consulted');
      },
    });

    expect(() =>
      verifyWorkerContextPackageTrace({
        authorities,
        trace: {
          ...fixture.trace,
          requestId: `import-lineage:sha256:${'a'.repeat(64)}`,
        },
        workspaceRoot,
      })
    ).toThrow('strict delivery rejects reserved import lineage');
    expect(() =>
      verifyPortableWorkerContextPackageTrace({
        authorities,
        trace: {
          ...fixture.trace,
          requestId: `import-lineage:sha256:${'g'.repeat(64)}`,
        },
        workspaceRoot,
      })
    ).toThrow('strict delivery rejects reserved import lineage');
  });

  it('accepts exact imported history without promoting matching runtime lookalikes', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-history-'));
    const fixture = createImportedHistoryFixture(workspaceRoot, true);

    expect(
      verifyImportedWorkerContextPackageTrace({
        authorities: fixture.authorities,
        trace: fixture.trace,
        workspaceRoot,
      })
    ).toEqual(fixture.trace);
    expect(fixture.trace.knowledgeSelectionInput).toBeNull();
    expect(
      verifyPortableWorkerContextPackageTrace({
        authorities: fixture.authorities,
        trace: fixture.trace,
        workspaceRoot,
      })
    ).toEqual({ trace: fixture.trace, verification: 'imported-history' });
    writeFileSync(
      join(
        workspaceRoot,
        'threads/th_00000000-0000-7ba9-ab4a-4397e62aa2e5/turns/tu_00000000-0000-71df-9e29-90f5b5578e47/context-package.json'
      ),
      serializeWorkerContextPackageTrace(fixture.trace)
    );
    expect(
      readPortableWorkerContextPackageTrace({
        authorities: fixture.authorities,
        threadId: fixture.trace.threadId,
        turnId: fixture.trace.turnId,
        workspaceId: fixture.trace.workspaceId,
        workspaceRoot,
      })
    ).toEqual({ trace: fixture.trace, verification: 'imported-history' });
    expect(fixture.runtimeAuthorityReads()).toBe(0);
    expect(() =>
      verifyWorkerContextPackageTrace({
        authorities: fixture.authorities,
        trace: fixture.trace,
        workspaceRoot,
      })
    ).toThrow('strict delivery rejects reserved import lineage');
    expect(fixture.runtimeAuthorityReads()).toBe(0);
  });

  it.each([
    {
      name: 'runtime request lookalike',
      alter: (
        fixture: ReturnType<typeof createImportedHistoryFixture>,
        _workspaceRoot: string
      ) => ({
        authorities: fixture.authorities,
        trace: { ...fixture.trace, requestId: `import-lineage:sha256:${'g'.repeat(64)}` },
      }),
    },
    {
      name: 'historical worker-session tamper',
      alter: (
        fixture: ReturnType<typeof createImportedHistoryFixture>,
        _workspaceRoot: string
      ) => ({
        authorities: {
          ...fixture.authorities,
          readWorkspaceMaterializationRecord: (...args: [string, string]) => {
            const record = fixture.authorities.readWorkspaceMaterializationRecord(...args);
            return record ? { ...record, workerSessionId: 'sandbox_runtime_lookalike' } : null;
          },
        },
        trace: fixture.trace,
      }),
    },
    {
      name: 'backend kind disallowed by AEP',
      alter: (
        fixture: ReturnType<typeof createImportedHistoryFixture>,
        _workspaceRoot: string
      ) => ({
        authorities: {
          ...fixture.authorities,
          readAgentEnvironmentPackage: (...args: [string, string]) => {
            const environmentPackage = fixture.authorities.readAgentEnvironmentPackage(...args);
            return environmentPackage
              ? {
                  ...environmentPackage,
                  backend: { ...environmentPackage.backend, allowedKinds: ['docker'] },
                }
              : null;
          },
        },
        trace: fixture.trace,
      }),
    },
    {
      name: 'missing Workspace import lineage',
      alter: (
        fixture: ReturnType<typeof createImportedHistoryFixture>,
        _workspaceRoot: string
      ) => ({
        authorities: { ...fixture.authorities, readWorkspaceImportedFrom: () => null },
        trace: fixture.trace,
      }),
    },
    {
      name: 'non-stale AgentSession',
      alter: (
        fixture: ReturnType<typeof createImportedHistoryFixture>,
        _workspaceRoot: string
      ) => ({
        authorities: {
          ...fixture.authorities,
          readAgentSession: (...args: [string, string]) => {
            const session = fixture.authorities.readAgentSession(...args);
            return session ? { ...session, stale: false } : null;
          },
        },
        trace: fixture.trace,
      }),
    },
    {
      name: 'package byte tamper',
      alter: (fixture: ReturnType<typeof createImportedHistoryFixture>, workspaceRoot: string) => {
        writeFileSync(
          join(
            workspaceRoot,
            'threads/th_00000000-0000-7ba9-ab4a-4397e62aa2e5/turns/tu_00000000-0000-71df-9e29-90f5b5578e47/context-package/instructions.md'
          ),
          'Tampered request.\n'
        );
        return { authorities: fixture.authorities, trace: fixture.trace };
      },
    },
  ])('rejects imported-history $name', ({ alter }) => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-history-tamper-'));
    const changed = alter(createImportedHistoryFixture(workspaceRoot), workspaceRoot);

    expect(() => verifyImportedWorkerContextPackageTrace({ ...changed, workspaceRoot })).toThrow();
  });

  it('fails closed for malformed traces, unsafe paths, and mismatched durable owners', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-verify-'));
    const fixture = createAcceptedFixture(workspaceRoot);
    const verify = (
      authorities: WorkerContextPackageAuthorityReader = fixture.authorities,
      trace: WorkerContextPackageTrace = fixture.trace
    ) => verifyWorkerContextPackageTrace({ authorities, trace, workspaceRoot });
    const cases: Array<[string, () => unknown, RegExp?]> = [
      [
        'unsafe namespace id',
        () =>
          createWorkerContextPackageFiles({
            contextBudgetTokens: 1,
            includedItemIds: ['it_00000000-0000-7a3c-ae74-d9d096838a5d'],
            materialSelections: [],
            threadId: '..',
            turnId: 'tu_00000000-0000-71df-9e29-90f5b5578e47',
            workerRequestBytes: WORKER_REQUEST_BYTES,
            workerRequestItemId: 'it_00000000-0000-7a3c-ae74-d9d096838a5d',
            workspaceId: 'ws_00000000-0000-7990-bde7-4411160ea0db',
          }),
      ],
      [
        'digest-uncovered nested trace annotation',
        () =>
          verify(fixture.authorities, {
            ...fixture.trace,
            materialSelections: fixture.trace.materialSelections.map((selection, index) =>
              index === 0 ? { ...selection, unexpected: true } : selection
            ),
          } as WorkerContextPackageTrace),
        /digest mismatch/,
      ],
      [
        'pre-existing ancestor link',
        () => {
          const linkedRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-link-'));
          const redirected = mkdtempSync(join(tmpdir(), 'openkit-worker-context-redirect-'));
          mkdirSync(join(linkedRoot, 'threads'));
          symlinkSync(
            redirected,
            join(linkedRoot, 'threads/th_00000000-0000-7ba9-ab4a-4397e62aa2e5')
          );
          writeWorkerContextPackageFiles(linkedRoot, createPackage(linkedRoot, false));
        },
      ],
      [
        'request Item',
        () =>
          verify({
            ...fixture.authorities,
            readThreadItems: (...args) =>
              fixture.authorities
                .readThreadItems(...args)
                .map((item) =>
                  item.id === 'it_00000000-0000-7a3c-ae74-d9d096838a5d'
                    ? { ...item, text: '{"task":"changed"}' }
                    : item
                ),
          }),
      ],
      [
        'Turn AgentSession',
        () =>
          verify({
            ...fixture.authorities,
            readTurn: (...args) => {
              const turn = fixture.authorities.readTurn(...args);
              return turn
                ? { ...turn, agentSessionId: 'as_00000000-0000-7436-9246-ac6dd3ca3fe4' }
                : null;
            },
          }),
      ],
      [
        'AEP',
        () =>
          verify({
            ...fixture.authorities,
            readAgentEnvironmentPackage: (...args) => {
              const environmentPackage = fixture.authorities.readAgentEnvironmentPackage(...args);
              return environmentPackage
                ? {
                    ...environmentPackage,
                    workspace: {
                      ...environmentPackage.workspace,
                      inputs: environmentPackage.workspace.inputs.map((input) => ({
                        ...input,
                        target: '/workspace/inputs',
                      })),
                    },
                  }
                : null;
            },
          }),
      ],
      [
        'competing AEP context input',
        () =>
          verify({
            ...fixture.authorities,
            readAgentEnvironmentPackage: (...args) => {
              const environmentPackage = fixture.authorities.readAgentEnvironmentPackage(...args);
              const contextInput = environmentPackage?.workspace.inputs[0];
              return environmentPackage && contextInput
                ? {
                    ...environmentPackage,
                    workspace: {
                      ...environmentPackage.workspace,
                      inputs: [contextInput, { ...contextInput, id: 'context_shadow' }],
                    },
                  }
                : null;
            },
          }),
      ],
      [
        'WIS',
        () =>
          verify({
            ...fixture.authorities,
            readWorkspaceInputSnapshot: (...args) => {
              const snapshot = fixture.authorities.readWorkspaceInputSnapshot(...args);
              return snapshot
                ? { ...snapshot, base: { ...snapshot.base, contentDigest: sha256('changed') } }
                : null;
            },
          }),
      ],
      [
        'WMR',
        () =>
          verify({
            ...fixture.authorities,
            readWorkspaceMaterializationRecord: (...args) => {
              const record = fixture.authorities.readWorkspaceMaterializationRecord(...args);
              return record ? { ...record, materializedRootRef: '/workspace/inputs' } : null;
            },
          }),
      ],
      [
        'handoff',
        () =>
          verify({
            ...fixture.authorities,
            readBackendHandoff: (...args) => {
              const handoff = fixture.authorities.readBackendHandoff(...args);
              return handoff ? { ...handoff, workspaceHandoffState: 'pending' } : null;
            },
          }),
      ],
      [
        'selected Material sensitivity',
        () =>
          verify({
            ...fixture.authorities,
            readMaterialRevision: (...args) => {
              const material = fixture.authorities.readMaterialRevision(...args);
              return material
                ? {
                    ...material,
                    sensitivity: material.sensitivity === 'public' ? 'internal' : 'public',
                  }
                : null;
            },
          }),
      ],
      [
        'excluded Material revision',
        () =>
          verify({
            ...fixture.authorities,
            readMaterialRevision: (...args) =>
              args[1] === 'mat_00000000-0000-7d3d-a336-0dbae085eb7e'
                ? null
                : fixture.authorities.readMaterialRevision(...args),
          }),
      ],
      [
        'untraced file or link',
        () => {
          const packageRoot = join(
            workspaceRoot,
            'threads/th_00000000-0000-7ba9-ab4a-4397e62aa2e5/turns/tu_00000000-0000-71df-9e29-90f5b5578e47/context-package'
          );
          writeFileSync(join(packageRoot, 'unexpected.txt'), 'unexpected');
          symlinkSync(join(packageRoot, 'instructions.md'), join(packageRoot, 'unexpected-link'));
          verify();
        },
      ],
    ];

    for (const [label, run, expected] of cases) {
      expect(run, label).toThrow(expected);
    }
  });
});

it.each([
  ['ws', WorkerContextPackageManifestSchema.shape.workspaceId],
  ['th', WorkerContextPackageManifestSchema.shape.threadId],
  ['tu', WorkerContextPackageManifestSchema.shape.turnId],
  ['it', WorkerContextPackageManifestSchema.shape.workerRequestItemId],
  ['it', WorkerContextPackageManifestSchema.shape.includedItemIds.element],
  ['mat', WorkerContextPackageManifestSchema.shape.materialSelections.element.shape.materialId],
  ['mrev', WorkerContextPackageManifestSchema.shape.materialSelections.element.shape.revisionId],
  [
    'mrev',
    WorkerContextPackageManifestSchema.shape.materialSelections.element.shape.parentRevisionId,
  ],
] as const)('uses canonical %s admission in retained Context Package fields', (kind, schema) => {
  for (const version of ['5', '7'])
    expect(schema.safeParse(`${kind}_00000000-0000-${version}000-8000-000000000001`).success).toBe(
      true
    );
  for (const value of [
    'legacy',
    'wrong_00000000-0000-7000-8000-000000000001',
    `${kind}_00000000-0000-4000-8000-000000000001`,
  ])
    expect(schema.safeParse(value).success).toBe(false);
});
