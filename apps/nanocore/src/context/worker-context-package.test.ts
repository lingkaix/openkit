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
import { describe, expect, it } from 'vitest';
import {
  createStructuredWorkerDelegationRequest,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import { resolveAgentEnvironmentPackage } from '../runtime/agent-environment.js';
import { chatTaskModeTurnId, commandInputHash } from '../runtime/idempotent-command.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
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
      { kind: 'workspace', id: 'ws_context' },
      { kind: 'thread', id: 'th_context' },
      { kind: 'item', id: 'it_prior' },
      { kind: 'item', id: 'it_gate_request' },
      { kind: 'item', id: 'it_gate_response' },
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
  'status: "active"',
  'scope: "workspace"',
  'source_refs: ["source:ks_alpha", "source:ks_beta"]',
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

/** Creates deterministic package bytes for one worker Turn. */
function createPackage(
  workspaceRoot: string,
  writeFiles = true,
  turnId = 'tu_context'
): WorkerContextPackageFiles {
  const packageFiles = createWorkerContextPackageFiles({
    contextBudgetTokens: 4_096,
    includedItemIds: ['it_request', 'it_prior', 'it_gate_request', 'it_gate_response'],
    materialSelections: [
      {
        bindingMutationRequestId: 'req_bind_2',
        content: 'Second material.\n',
        contentDigest: sha256('Second material.\n'),
        inclusionReason: 'thread_binding',
        materialId: 'mat_b',
        mediaType: 'text/plain',
        parentRevisionId: null,
        revisionId: 'rev_b1',
        sensitivity: 'internal',
      },
      {
        bindingMutationRequestId: 'req_bind_1',
        content: '# First material\n',
        contentDigest: sha256('# First material\n'),
        inclusionReason: 'thread_binding',
        materialId: 'mat_a',
        mediaType: 'text/markdown',
        parentRevisionId: 'rev_a0',
        revisionId: 'rev_a1',
        sensitivity: 'public',
      },
    ],
    threadId: 'th_context',
    turnId,
    workerRequestBytes: WORKER_REQUEST_BYTES,
    workerRequestItemId: 'it_request',
    workspaceId: 'ws_context',
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
    agentSessionId: 'as_context',
    agentSetup: createTestAgentSetup(),
    triggerActor: { kind: 'user', id: 'user_local' },
    backend: {
      kind: 'openshell',
    },
    requestId,
    turn: {
      completedAt: null,
      configVersion: null,
      durationMs: null,
      error: null,
      humanGate: null,
      id: packageFiles.turnId,
      items: [],
      startedAt: TURN_STARTED_AT,
      status: 'running',
      threadId: packageFiles.threadId,
      triggerActor: { kind: 'user', id: 'user_local' },
      workspaceId: packageFiles.workspaceId,
    },
    turnInput: WORKER_REQUEST_BYTES,
    userId: 'user_context',
    workspaceCwd: '/workspace',
    workspaceRoots: [],
  });

  return AgentEnvironmentPackageSchema.parse({
    ...unresolved,
    scope: { ...unresolved.scope, itemId: 'it_request' },
    workspace: {
      ...unresolved.workspace,
      inputs: [
        buildWorkerContextPackageWorkspaceInput({
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
  options: { readonly requestId?: string; readonly turnId?: string } = {}
): {
  authorities: WorkerContextPackageAuthorityReader;
  packageFiles: WorkerContextPackageFiles;
  trace: WorkerContextPackageTrace;
} {
  const requestId = options.requestId ?? 'req_context';
  const turnId = options.turnId ?? 'tu_context';
  const packageFiles = createPackage(workspaceRoot, true, turnId);
  const environmentPackage = createEnvironmentPackage(packageFiles, requestId);
  const trace = createWorkerContextPackageTrace({
    agentSessionId: 'as_context',
    excludedItems: [{ itemId: 'it_excluded', reason: 'policy_excluded' }],
    goalId: 'goal_context',
    materialExclusions: [
      {
        materialId: 'mat_excluded',
        reason: 'sensitive_content',
        revisionId: 'rev_excluded_1',
        sensitivity: 'restricted',
      },
    ],
    packageFiles,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId,
    taskId: 'task_context',
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
    workspaceId: 'ws_context',
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
    materializedRootRef: '/openkit/context',
    packageSnapshotId: environmentPackage.snapshotId,
    policyDigest: createWorkerContextPackagePolicyDigest({
      backendKind: 'openshell',
      packageSnapshotId: environmentPackage.snapshotId,
      requiredCapabilities,
    }),
    readinessEvidence,
    strategy: 'filesystem' as const,
    workerSessionId: 'sandbox_context',
    workspaceId: 'ws_context',
  };
  const materials = new Map([
    ...packageFiles.materialSelections.map(
      (selection) =>
        [
          `${selection.materialId}:${selection.revisionId}`,
          {
            ...selection,
            content: selection.materialId === 'mat_a' ? '# First material\n' : 'Second material.\n',
            workspaceId: 'ws_context',
          },
        ] as const
    ),
    [
      'mat_excluded:rev_excluded_1',
      {
        content: 'Restricted material.\n',
        contentDigest: sha256('Restricted material.\n'),
        materialId: 'mat_excluded',
        mediaType: 'text/plain',
        parentRevisionId: null,
        revisionId: 'rev_excluded_1',
        sensitivity: 'restricted' as const,
        workspaceId: 'ws_context',
      },
    ] as const,
  ]);
  const authorities: WorkerContextPackageAuthorityReader = {
    readAdmission: () => ({
      requestId,
      status: 'admitted',
      threadId: 'th_context',
      turnId,
      workspaceId: 'ws_context',
    }),
    readAgentEnvironmentPackage: () => environmentPackage,
    readAgentSession: () => ({
      environmentPackageSnapshotId: environmentPackage.snapshotId,
      id: 'as_context',
      stale: false,
      threadId: 'th_context',
      workspaceId: 'ws_context',
    }),
    readBackendHandoff: () => ({
      agentSessionId: 'as_context',
      backendKind: 'openshell',
      backendSessionId: 'sandbox_context',
      packageSnapshotId: environmentPackage.snapshotId,
      readinessEvidence,
      threadId: 'th_context',
      turnId,
      workspaceHandoffState: 'complete',
      workspaceId: 'ws_context',
    }),
    readGoalTask: () => ({
      gateContextItemIds: ['it_gate_request', 'it_gate_response'],
      goal: {
        goalId: 'goal_context',
        threadId: 'th_context',
        workspaceId: 'ws_context',
      },
      task: {
        goalId: 'goal_context',
        taskId: 'task_context',
        threadId: 'th_context',
        workspaceId: 'ws_context',
      },
    }),
    readMaterialRevision: (_workspaceId, materialId, revisionId) =>
      materials.get(`${materialId}:${revisionId}`) ?? null,
    readThreadItems: () => [
      {
        id: 'it_prior',
        status: 'completed',
        text: 'Prior context',
        threadId: 'th_context',
        turnId: 'tu_prior',
        type: 'user-message',
        actor: { kind: 'user', id: 'user_local' },
        workspaceId: 'ws_context',
      },
      {
        id: 'it_excluded',
        status: 'completed',
        text: 'Private diagnostic',
        threadId: 'th_context',
        turnId: 'tu_prior',
        type: 'status',
        workspaceId: 'ws_context',
      },
      {
        id: 'it_gate_request',
        status: 'completed',
        text: 'Approve the next attempt?',
        threadId: 'th_context',
        turnId: 'tu_gate',
        type: 'approval-request',
        workspaceId: 'ws_context',
      },
      {
        id: 'it_gate_response',
        status: 'completed',
        text: 'Approved',
        threadId: 'th_context',
        turnId: 'tu_gate',
        type: 'approval-decision',
        actor: { kind: 'user', id: 'user_local' },
        causationId: 'it_gate_request',
        workspaceId: 'ws_context',
      },
      {
        id: 'it_request',
        status: 'completed',
        text: WORKER_REQUEST_BYTES,
        threadId: 'th_context',
        turnId,
        type: 'user-message',
        actor: { kind: 'user', id: 'user_local' },
        workspaceId: 'ws_context',
      },
    ],
    readTurn: () => ({
      agentSessionId: 'as_context',
      id: turnId,
      startedAt: TURN_STARTED_AT,
      threadId: 'th_context',
      triggerActor: { kind: 'user', id: 'user_local' },
      workspaceId: 'ws_context',
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
  const agentSessionId = 'as_imported_ws_context_1';
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
        sourceWorkspaceId: 'ws_source',
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
  const fixture = createAcceptedFixture(workspaceRoot, { turnId: options.turnId });
  const triggerActor = options.triggerActor ?? { kind: 'user' as const, id: 'user_local' };
  return {
    authorities: {
      ...fixture.authorities,
      readTurn: (...args) => {
        const turn = fixture.authorities.readTurn(...args);
        return turn ? { ...turn, triggerActor } : null;
      },
    },
    trace: rewriteTrace(fixture.trace, { goalId: null, taskId: null }),
  };
}

describe('worker Context Package owner', () => {
  it('builds deterministic files, inventory, digests, and the exact generated AEP input', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-'));
    const first = createPackage(workspaceRoot);
    const second = createWorkerContextPackageFiles({
      contextBudgetTokens: 4_096,
      includedItemIds: ['it_request', 'it_prior', 'it_gate_request', 'it_gate_response'],
      materialSelections: first.materialSelections.map((selection) => ({
        ...selection,
        content: selection.materialId === 'mat_a' ? '# First material\n' : 'Second material.\n',
      })),
      threadId: 'th_context',
      turnId: 'tu_context',
      workerRequestBytes: WORKER_REQUEST_BYTES,
      workerRequestItemId: 'it_request',
      workspaceId: 'ws_context',
    });

    expect(second).toEqual(first);
    expect(first.fileInventory.map((entry) => entry.path)).toEqual([
      'instructions.md',
      'package.json',
      'workspace/materials/mat_a/rev_a1.md',
      'workspace/materials/mat_b/rev_b1.txt',
    ]);
    expect(
      first.fileInventory.every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.contentDigest))
    ).toBe(true);
    expect(first.packageRootDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.workerRequestDigest).toBe(sha256(WORKER_REQUEST_BYTES));

    const manifestBytes = first.files.find((file) => file.path === 'package.json')?.bytes;
    const manifest = JSON.parse(Buffer.from(manifestBytes ?? []).toString('utf8'));
    expect(manifest).toMatchObject({
      contextPackageId: 'ctxpkg_tu_context',
      includedItemIds: ['it_request', 'it_prior', 'it_gate_request', 'it_gate_response'],
      policyVersion: 'worker-context-v1',
      schemaVersion: 1,
      threadId: 'th_context',
      turnId: 'tu_context',
      workspaceId: 'ws_context',
    });
    expect(manifest).not.toHaveProperty('contextPackageDigest');
    expect(manifest.fileInventory.map((entry: { path: string }) => entry.path)).not.toContain(
      'package.json'
    );
    expect(
      buildWorkerContextPackageWorkspaceInput({
        packageRootDigest: first.packageRootDigest,
        threadId: 'th_context',
        turnId: 'tu_context',
      })
    ).toEqual({
      access: 'read-only',
      id: 'context_tu_context',
      kind: 'generated',
      materialization: {
        contentDigest: first.packageRootDigest,
        slotId: 'context',
        strategy: 'filesystem',
      },
      source: {
        kind: 'generated',
        pathRef: 'threads/th_context/turns/tu_context/context-package',
      },
      target: '/openkit/context',
    });
    expect(
      readFileSync(
        join(workspaceRoot, 'threads/th_context/turns/tu_context/context-package/instructions.md'),
        'utf8'
      )
    ).toBe(WORKER_REQUEST_BYTES);
  });

  it('materializes one governed Knowledge selection into the existing package and trace', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-knowledge-'));
    const retrievalTraceId = 'krt_0190f4c8-0000-7000-8000-000000000399';
    const contentDigest = sha256(KNOWLEDGE_PAGE_BYTES);
    const packageFiles = createWorkerContextPackageFiles({
      contextBudgetTokens: 4_096,
      includedItemIds: ['it_request'],
      knowledgeSelections: [
        {
          content: KNOWLEDGE_PAGE_BYTES,
          contentDigest,
          knowledgePageId: 'lessons/task-mode',
          sourceRefs: ['source:ks_beta', 'source:ks_alpha'],
        },
      ],
      materialSelections: [],
      threadId: 'th_context',
      turnId: 'tu_context',
      workerRequestBytes: WORKER_REQUEST_BYTES,
      workerRequestItemId: 'it_request',
      workspaceId: 'ws_context',
    });
    writeWorkerContextPackageFiles(workspaceRoot, packageFiles);

    const expectedSelection = {
      contentDigest,
      knowledgePageId: 'lessons/task-mode',
      packagePath: 'knowledge/pages/lessons/task-mode.md',
      sourceRefs: ['source:ks_alpha', 'source:ks_beta'],
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
          'threads/th_context/turns/tu_context/context-package/knowledge/pages/lessons/task-mode.md'
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
      agentSessionId: 'as_context',
      excludedItems: [],
      goalId: null,
      knowledgeExclusions: [],
      knowledgeSelectionInput: { retrievalTraceId },
      packageFiles,
      packageSnapshotId: 'aepsnap_context',
      requestId: 'req_context',
      taskId: null,
    };
    expect(createWorkerContextPackageTrace(traceInput)).toMatchObject({
      knowledgeExclusions: [],
      knowledgeSelectionInput: { retrievalTraceId },
      knowledgeSelections: [expectedSelection],
    });
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

  it('accepts null Knowledge only for the exact persisted user Chat-subordinate Turn', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-chat-task-'));
    const turnId = chatTaskModeTurnId('user_local', 'ws_context', 'th_context', 'req_context');
    const fixture = createLiveNullKnowledgeFixture(workspaceRoot, { turnId });

    expect(
      writeWorkerContextPackageTrace({
        authorities: fixture.authorities,
        trace: fixture.trace,
        workspaceRoot,
      })
    ).toEqual(fixture.trace);
    expect(
      existsSync(join(workspaceRoot, `threads/th_context/turns/${turnId}/context-package.json`))
    ).toBe(true);
  });

  it.each([
    {
      name: 'ordinary direct Task',
      turnId: `turn_req_context_${commandInputHash({
        actorId: 'user_local',
        command: 'task.start',
        requestId: 'req_context',
        threadId: 'th_context',
        workspaceId: 'ws_context',
      }).slice(-16)}`,
    },
    {
      name: 'non-user trigger',
      triggerActor: {
        id: 'agent_context',
        kind: 'agent' as const,
        responsibleUserId: 'user_local',
      },
      turnId: chatTaskModeTurnId('agent_context', 'ws_context', 'th_context', 'req_context'),
    },
    {
      name: 'actor mismatch',
      turnId: chatTaskModeTurnId('user_other', 'ws_context', 'th_context', 'req_context'),
    },
    {
      name: 'Workspace mismatch',
      turnId: chatTaskModeTurnId('user_local', 'ws_other', 'th_context', 'req_context'),
    },
    {
      name: 'Thread mismatch',
      turnId: chatTaskModeTurnId('user_local', 'ws_context', 'th_other', 'req_context'),
    },
    {
      name: 'request mismatch',
      turnId: chatTaskModeTurnId('user_local', 'ws_context', 'th_context', 'req_other'),
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
      existsSync(join(workspaceRoot, `threads/th_context/turns/${turnId}/context-package.json`))
    ).toBe(false);
  });

  it('persists one immutable trace and verifies every durable owner without a checkpoint', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-trace-'));
    const fixture = createAcceptedFixture(workspaceRoot);

    expect(parseWorkerContextPackageTrace(JSON.parse(JSON.stringify(fixture.trace)))).toEqual(
      fixture.trace
    );
    expect(() => parseWorkerContextPackageTrace({ ...fixture.trace, unexpected: true })).toThrow(
      'trace is malformed'
    );

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
        threadId: 'th_context',
        turnId: 'tu_context',
        workspaceId: 'ws_context',
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
      existsSync(join(workspaceRoot, 'threads/th_context/turns/tu_context/context-package.json'))
    ).toBe(true);
    expect(
      readFileSync(
        join(workspaceRoot, 'threads/th_context/turns/tu_context/context-package.json'),
        'utf8'
      )
    ).toBe(serializeWorkerContextPackageTrace(fixture.trace));

    const conflicting = createWorkerContextPackageTrace({
      agentSessionId: 'as_context',
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
      join(workspaceRoot, 'threads/th_context/turns/tu_context/context-package.json'),
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
            'threads/th_context/turns/tu_context/context-package/instructions.md'
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
            includedItemIds: ['it_request'],
            materialSelections: [],
            threadId: '..',
            turnId: 'tu_context',
            workerRequestBytes: WORKER_REQUEST_BYTES,
            workerRequestItemId: 'it_request',
            workspaceId: 'ws_context',
          }),
      ],
      [
        'extra nested trace field',
        () =>
          verify(fixture.authorities, {
            ...fixture.trace,
            materialSelections: fixture.trace.materialSelections.map((selection, index) =>
              index === 0 ? { ...selection, unexpected: true } : selection
            ),
          } as WorkerContextPackageTrace),
        /malformed/,
      ],
      [
        'pre-existing ancestor link',
        () => {
          const linkedRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-link-'));
          const redirected = mkdtempSync(join(tmpdir(), 'openkit-worker-context-redirect-'));
          mkdirSync(join(linkedRoot, 'threads'));
          symlinkSync(redirected, join(linkedRoot, 'threads/th_context'));
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
                  item.id === 'it_request' ? { ...item, text: '{"task":"changed"}' } : item
                ),
          }),
      ],
      [
        'Goal task',
        () =>
          verify({
            ...fixture.authorities,
            readGoalTask: () => null,
          }),
      ],
      [
        'Goal gate context',
        () =>
          verify({
            ...fixture.authorities,
            readGoalTask: (...args) => {
              const pair = fixture.authorities.readGoalTask(...args);
              return pair
                ? { ...pair, gateContextItemIds: ['it_gate_request', 'it_excluded'] }
                : null;
            },
          }),
      ],
      [
        'Turn AgentSession',
        () =>
          verify({
            ...fixture.authorities,
            readTurn: (...args) => {
              const turn = fixture.authorities.readTurn(...args);
              return turn ? { ...turn, agentSessionId: 'as_other' } : null;
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
              args[1] === 'mat_excluded' ? null : fixture.authorities.readMaterialRevision(...args),
          }),
      ],
      [
        'untraced file or link',
        () => {
          const packageRoot = join(
            workspaceRoot,
            'threads/th_context/turns/tu_context/context-package'
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
