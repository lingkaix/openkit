// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  mkdtempSync as createTemporaryDirectory,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStructuredWorkerDelegationRequest,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import { chatTaskModeTurnId, commandInputHash } from '../runtime/idempotent-command.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import {
  buildWorkerContextPackageWorkspaceInput,
  createWorkerContextPackageFiles,
  createWorkerContextPackagePolicyDigest,
  createWorkerContextPackageTrace,
  parseWorkerContextPackageTrace,
  projectWorkerContextRequest,
  readPortableWorkerContextPackageTrace,
  readWorkerContextPackageTrace,
  serializeWorkerContextPackageTrace,
  verifyImportedWorkerContextPackageTrace,
  verifyPortableWorkerContextPackageTrace,
  verifyWorkerContextPackageTrace,
  type WorkerContextPackageAuthorityReader,
  type WorkerContextPackageFiles,
  type WorkerContextPackageProjection,
  type WorkerContextPackageSourceFileInput,
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
  'openkit_status: "active"',
  'status: "stable"',
  'scope: "workspace"',
  'source_refs: ["source:ks_alpha", "source:ks_beta"]',
  'review_state: "accepted"',
  'sensitivity: "public"',
  'freshness: "current"',
  '---',
  'Use the existing direct Task worker path.',
  '',
].join('\n');

/** Computes the public SHA-256 format for exact text or binary bytes. */
function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
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

const temporaryRoots: string[] = [];
/** Tracks each fixture root for deterministic per-test cleanup. */
function mkdtempSync(prefix: string): string {
  const root = createTemporaryDirectory(prefix);
  temporaryRoots.push(root);
  return root;
}
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates deterministic package bytes for one worker Turn. */
async function createPackage(
  workspaceRoot: string,
  writeFiles = true,
  turnId = 'tu_context',
  sourceFiles?: readonly WorkerContextPackageSourceFileInput[]
): Promise<WorkerContextPackageFiles> {
  const packageFiles = createWorkerContextPackageFiles({
    sourceFiles,
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
    await writeWorkerContextPackageFiles(workspaceRoot, packageFiles, {
      admission: new FileStorageAdmission(workspaceRoot, () => 0n),
    });
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
      id: packageFiles.turnId,
      items: [],
      startedAt: TURN_STARTED_AT,
      status: 'running',
      threadId: packageFiles.threadId,
      triggerActor: { kind: 'user', id: 'user_local' },
      workspaceId: packageFiles.workspaceId,
    },
    turnInput: WORKER_REQUEST_BYTES,
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
          agentSessionId: 'as_context',
          packageRootDigest: packageFiles.packageRootDigest,
          threadId: packageFiles.threadId,
          turnId: packageFiles.turnId,
        }),
      ],
    },
  });
}

/** Creates an accepted trace and every dependency used by the shared verifier. */
async function createAcceptedFixture(
  workspaceRoot: string,
  options: {
    readonly requestId?: string;
    readonly turnId?: string;
    readonly knowledge?: boolean;
    readonly sourceFiles?: readonly WorkerContextPackageSourceFileInput[];
  } = {}
): Promise<{
  authorities: WorkerContextPackageAuthorityReader;
  packageFiles: WorkerContextPackageFiles;
  trace: WorkerContextPackageTrace;
}> {
  const requestId = options.requestId ?? 'req_context';
  const turnId = options.turnId ?? 'tu_context';
  let packageFiles = await createPackage(
    workspaceRoot,
    !options.knowledge,
    turnId,
    options.sourceFiles
  );
  if (options.knowledge) {
    packageFiles = createWorkerContextPackageFiles({
      contextBudgetTokens: 4_096,
      includedItemIds: packageFiles.includedItemIds,
      knowledgeSelections: [
        {
          content: KNOWLEDGE_PAGE_BYTES,
          contentDigest: sha256(KNOWLEDGE_PAGE_BYTES),
          knowledgePageId: 'lessons/task-mode',
          sourceRefs: ['source:ks_alpha', 'source:ks_beta'],
        },
      ],
      materialSelections: packageFiles.materialSelections.map((selection) => ({
        ...selection,
        content: selection.materialId === 'mat_a' ? '# First material\n' : 'Second material.\n',
      })),
      threadId: 'th_context',
      turnId,
      workerRequestBytes: WORKER_REQUEST_BYTES,
      workerRequestItemId: 'it_request',
      workspaceId: 'ws_context',
    });
    await writeWorkerContextPackageFiles(workspaceRoot, packageFiles, {
      admission: new FileStorageAdmission(workspaceRoot, () => 0n),
    });
  }
  const environmentPackage = createEnvironmentPackage(packageFiles, requestId);
  const trace = createWorkerContextPackageTrace({
    agentSessionId: 'as_context',
    excludedItems: [{ itemId: 'it_excluded', reason: 'policy_excluded' }],
    goalId: options.knowledge ? null : 'goal_context',
    knowledgeSelectionInput: options.knowledge
      ? {
          retrievalTraceRef: {
            scopeId: `retrieval-trace/turn/ws_context/th_context/${turnId}`,
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
        materialId: 'mat_excluded',
        reason: 'sensitive_content',
        revisionId: 'rev_excluded_1',
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
    materializedRootRef: '/openkit/sessions/as_context/context',
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
  const materials = new Map<
    string,
    NonNullable<ReturnType<WorkerContextPackageAuthorityReader['readMaterialRevision']>>
  >([
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
async function createImportedHistoryFixture(
  workspaceRoot: string,
  directLike = false
): Promise<{
  authorities: WorkerContextPackageAuthorityReader;
  runtimeAuthorityReads: () => number;
  trace: WorkerContextPackageTrace;
}> {
  const accepted = await createAcceptedFixture(workspaceRoot);
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
async function createLiveNullKnowledgeFixture(
  workspaceRoot: string,
  options: {
    readonly turnId: string;
    readonly triggerActor?:
      | NonNullable<ReturnType<WorkerContextPackageAuthorityReader['readTurn']>>['triggerActor']
      | undefined;
  }
): Promise<{
  authorities: WorkerContextPackageAuthorityReader;
  trace: WorkerContextPackageTrace;
}> {
  const fixture = await createAcceptedFixture(workspaceRoot, { turnId: options.turnId });
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

describe('worker request source selector projection', () => {
  it('projects ordered exact Artifact selectors without interpreting resource display strings', () => {
    const request = JSON.parse(WORKER_REQUEST_BYTES);
    request.contextRefs.push(
      { kind: 'artifact', id: 'ar_selected', artifactVersion: 7 },
      { kind: 'artifact', id: 'ar_current' }
    );
    request.resources = [
      { kind: 'artifact', reference: 'ar_display:v99', reason: 'Display only.' },
    ];
    expect(projectWorkerContextRequest(JSON.stringify(request))).toEqual({
      contextBudgetTokens: 4096,
      requestKind: 'structured-delegation',
      requestedItemIds: ['it_prior', 'it_gate_request', 'it_gate_response'],
      requestedArtifactRefs: [
        { artifactId: 'ar_selected', artifactVersion: 7 },
        { artifactId: 'ar_current' },
      ],
    });
  });

  it('projects the exact Artifact Review follow-up version', () => {
    const artifactContent = 'Exact original content.';
    expect(
      projectWorkerContextRequest(
        JSON.stringify({
          kind: 'artifact-review-follow-up',
          workspaceId: 'ws_context',
          reviewId: 'review_selected',
          artifactId: 'ar_selected',
          artifactVersion: 7,
          contentDigest: sha256(artifactContent),
          artifactContent,
          artifactMediaType: 'text/plain',
          sourceThreadId: 'th_context',
          sourceTurnId: 'tu_prior',
          sourceAgentId: 'agent_selected',
          materialProposal: null,
          decision: 'redo',
          feedback: 'Revise the selected version.',
          decisionRequestId: 'req_decision',
          workerRequestId: 'req_follow_up',
        })
      )
    ).toEqual({
      contextBudgetTokens: 240000,
      requestKind: 'artifact-review',
      requestedItemIds: [],
      requestedArtifactRefs: [{ artifactId: 'ar_selected', artifactVersion: 7 }],
    });
  });

  it('projects no Artifact selector from a frozen pending outcome', () => {
    expect(
      projectWorkerContextRequest(
        JSON.stringify({
          triggerInput: 'Continue with the answered request.',
          pendingOutcomes: [
            {
              requestId: 'req_pending',
              requestItemId: 'it_pending',
              publicationTurnId: 'tu_prior',
              kind: 'user-input',
              resolution: 'answered',
              ending: null,
            },
          ],
        })
      )
    ).toEqual({
      contextBudgetTokens: 240000,
      requestKind: 'pending-outcomes',
      requestedItemIds: [],
      requestedArtifactRefs: [],
    });
  });
});

describe('worker Context Package owner', () => {
  it.each([
    false,
    true,
  ])('verifies additive annotation bytes and reopens (Knowledge: %s)', async (knowledge) => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-context-extended-'));
    const fixture = await createAcceptedFixture(workspaceRoot, { knowledge });
    const packagePath = join(
      workspaceRoot,
      'threads/th_context/turns/tu_context/context-package/package.json'
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
    const originalAuthorities = fixture.authorities;
    const packageRootDigest = sha256(canonical(raw.fileInventory));
    fixture.authorities = {
      ...originalAuthorities,
      readWorkspaceInputSnapshot: (...args) => ({
        ...originalAuthorities.readWorkspaceInputSnapshot(...args)!,
        base: { commit: null, contentDigest: packageRootDigest },
      }),
      readAgentEnvironmentPackage: (...args) => {
        const aep = structuredClone(originalAuthorities.readAgentEnvironmentPackage(...args)!);
        aep.workspace.inputs[0]!.materialization!.contentDigest = packageRootDigest;
        return aep;
      },
      readWorkspaceMaterializationRecord: (...args) => ({
        ...originalAuthorities.readWorkspaceMaterializationRecord(...args)!,
        base: { commit: null, contentDigest: packageRootDigest },
      }),
    };
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
        workspaceId: 'ws_context',
        threadId: 'th_context',
        turnId: 'tu_context',
        workspaceRoot,
      })
    ).toEqual(read);
    expect(readFileSync(packagePath, 'utf8')).toBe(bytes);
    expect(JSON.parse(serializeWorkerContextPackageTrace(read))).toEqual(raw);
    Object.assign(read, { requestId: 'req_changed' });
    expect(() => parseWorkerContextPackageTrace(read)).toThrow('retained core mismatch');
    expect(() => serializeWorkerContextPackageTrace(read)).toThrow('retained core mismatch');
  });

  it('builds deterministic files, inventory, digests, and the exact generated AEP input', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-'));
    const first = await createPackage(workspaceRoot);
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
        agentSessionId: 'as_context',
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
      target: '/openkit/sessions/as_context/context',
    });
    expect(
      readFileSync(
        join(workspaceRoot, 'threads/th_context/turns/tu_context/context-package/instructions.md'),
        'utf8'
      )
    ).toBe(WORKER_REQUEST_BYTES);
  });

  it('materializes one governed Knowledge selection into the existing package and trace', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-knowledge-'));
    const retrievalTraceId = 'krt_0190f4c8-0000-7000-8000-000000000399';
    const retrievalTraceRef = {
      scopeId: 'retrieval-trace/turn/ws_context/th_context/tu_context',
      objectId: retrievalTraceId,
    };
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
    await writeWorkerContextPackageFiles(workspaceRoot, packageFiles, {
      admission: new FileStorageAdmission(workspaceRoot, () => 0n),
    });

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
              scopeId: 'retrieval-trace/workspace/ws_context',
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
        packageFiles: await createPackage(workspaceRoot, false),
      })
    ).toMatchObject({
      goalId: null,
      knowledgeExclusions: [],
      knowledgeSelectionInput: null,
      knowledgeSelections: [],
      taskId: null,
    });
  });

  it('accepts null Knowledge only for the exact persisted user Chat-subordinate Turn', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-chat-task-'));
    const turnId = chatTaskModeTurnId('user_local', 'ws_context', 'th_context', 'req_context');
    const fixture = await createLiveNullKnowledgeFixture(workspaceRoot, { turnId });

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
  ])('rejects null Knowledge for $name before immutable trace write', async ({
    triggerActor,
    turnId,
  }) => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-chat-reject-'));
    const fixture = await createLiveNullKnowledgeFixture(workspaceRoot, { triggerActor, turnId });

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

  it('persists one immutable trace and verifies every durable owner without a checkpoint', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-trace-'));
    const fixture = await createAcceptedFixture(workspaceRoot);

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

  it('rejects reserved import lineage before consulting live authorities', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-import-lineage-'));
    const fixture = await createAcceptedFixture(workspaceRoot);
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

  it('accepts exact imported history without promoting matching runtime lookalikes', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-history-'));
    const fixture = await createImportedHistoryFixture(workspaceRoot, true);

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
        fixture: Awaited<ReturnType<typeof createImportedHistoryFixture>>,
        _workspaceRoot: string
      ) => ({
        authorities: fixture.authorities,
        trace: { ...fixture.trace, requestId: `import-lineage:sha256:${'g'.repeat(64)}` },
      }),
    },
    {
      name: 'historical worker-session tamper',
      alter: (
        fixture: Awaited<ReturnType<typeof createImportedHistoryFixture>>,
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
        fixture: Awaited<ReturnType<typeof createImportedHistoryFixture>>,
        _workspaceRoot: string
      ) => ({
        authorities: {
          ...fixture.authorities,
          readAgentEnvironmentPackage: (...args: [string, string]) => {
            const environmentPackage = fixture.authorities.readAgentEnvironmentPackage(...args);
            return environmentPackage
              ? {
                  ...environmentPackage,
                  backend: { ...environmentPackage.backend, allowedKinds: ['docker' as const] },
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
        fixture: Awaited<ReturnType<typeof createImportedHistoryFixture>>,
        _workspaceRoot: string
      ) => ({
        authorities: { ...fixture.authorities, readWorkspaceImportedFrom: () => null },
        trace: fixture.trace,
      }),
    },
    {
      name: 'non-stale AgentSession',
      alter: (
        fixture: Awaited<ReturnType<typeof createImportedHistoryFixture>>,
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
      alter: (
        fixture: Awaited<ReturnType<typeof createImportedHistoryFixture>>,
        workspaceRoot: string
      ) => {
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
  ])('rejects imported-history $name', async ({ alter }) => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-history-tamper-'));
    const changed = alter(await createImportedHistoryFixture(workspaceRoot), workspaceRoot);

    expect(() => verifyImportedWorkerContextPackageTrace({ ...changed, workspaceRoot })).toThrow();
  });

  it('fails closed for malformed traces, unsafe paths, and mismatched durable owners', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-verify-'));
    const fixture = await createAcceptedFixture(workspaceRoot);
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
        async () => {
          const linkedRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-context-link-'));
          const redirected = mkdtempSync(join(tmpdir(), 'openkit-worker-context-redirect-'));
          mkdirSync(join(linkedRoot, 'threads'));
          symlinkSync(redirected, join(linkedRoot, 'threads/th_context'));
          return writeWorkerContextPackageFiles(
            linkedRoot,
            await createPackage(linkedRoot, false),
            { admission: new FileStorageAdmission(linkedRoot, () => 0n) }
          );
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
                ? { ...snapshot, base: { commit: null, contentDigest: sha256('changed') } }
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
      await expect(async () => run(), label).rejects.toThrow(expected);
    }
  });
});

// Independent Python hashlib oracle frozen before the source-original streaming implementation.
const STREAMED_ORIGINAL_BYTES = 16_777_217;
const STREAMED_ORIGINAL_DIGEST =
  'sha256:1003b1b5dc078189799a1216ce0f9fbcebb94e8b6b83c58c4b03345f07f94ced';

describe('bounded S39 source representations', () => {
  it('keeps the original Material digest separate from its delivered excerpt digest', async () => {
    const content = '# Original material\nThe rest remains outside the excerpt.\n';
    const deliveredContent = '# Original';
    const projection: WorkerContextPackageProjection = {
      kind: 'excerpt',
      sourceRevision: 'rev_projected',
      representationId: 'original-utf8',
      representationDigest: sha256(content),
      representationByteLength: Buffer.byteLength(content),
      deliveredDigest: sha256(deliveredContent),
      ranges: [{ start: 0, end: Buffer.byteLength(deliveredContent) }],
      byteLength: Buffer.byteLength(deliveredContent),
      truncated: true,
      availability: 'incomplete',
      tokenAccounting: {
        identity: 'explicit-parent-accounting',
        budgetTokens: 256,
        countedTokens: 7,
      },
    };
    const files = createWorkerContextPackageFiles({
      workspaceId: 'ws_context',
      threadId: 'th_context',
      turnId: 'tu_context',
      workerRequestItemId: 'it_request',
      workerRequestBytes: WORKER_REQUEST_BYTES,
      includedItemIds: ['it_request'],
      contextBudgetTokens: 4096,
      materialSelections: [
        {
          materialId: 'mat_projected',
          revisionId: 'rev_projected',
          parentRevisionId: null,
          mediaType: 'text/markdown',
          content,
          contentDigest: sha256(content),
          inclusionReason: 'thread_binding',
          bindingMutationRequestId: 'req_binding',
          sensitivity: 'public',
          deliveredContent,
          projection,
        },
      ],
    });
    const selected = files.materialSelections[0]!;
    const inventory = files.fileInventory.find((entry) => entry.path === selected.packagePath)!;
    expect(inventory.contentDigest).toBe(sha256(deliveredContent));
    expect(inventory.contentDigest).not.toBe(selected.contentDigest);
    expect(
      Buffer.from(files.files.find((file) => file.path === selected.packagePath)!.bytes).toString()
    ).toBe(deliveredContent);
    expect(selected).toMatchObject({ contentDigest: sha256(content), projection });
  });

  it('streams an original larger than 16 MiB into the existing inventory and replays without reopening it', async () => {
    const root = mkdtempSync(join(tmpdir(), 's39-streamed-original-'));
    const sourcePath = join(root, 'original.bin');
    let descriptor: number | undefined;
    try {
      const writer = openSync(sourcePath, 'wx', 0o600);
      try {
        const chunk = Buffer.alloc(65_536);
        let total = 0;
        while (total < STREAMED_ORIGINAL_BYTES)
          total += writeSync(
            writer,
            chunk,
            0,
            Math.min(chunk.length, STREAMED_ORIGINAL_BYTES - total)
          );
      } finally {
        closeSync(writer);
      }
      descriptor = openSync(
        sourcePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      const held = descriptor;
      const before = fstatSync(held, { bigint: true });
      const delivered = 'Original binary source; text representation unavailable.\n';
      const open = vi.fn(async function* (_signal: AbortSignal) {
        const chunk = Buffer.alloc(65_536);
        let offset = 0;
        while (offset < STREAMED_ORIGINAL_BYTES) {
          const count = readSync(
            held,
            chunk,
            0,
            Math.min(chunk.length, STREAMED_ORIGINAL_BYTES - offset),
            offset
          );
          if (!count) throw new Error('Unexpected original EOF.');
          offset += count;
          yield chunk.subarray(0, count);
        }
      });
      const originalSnapshotPath = 'originals/artifacts/ar_stream/1/payload';
      const sourceFile: WorkerContextPackageSourceFileInput = {
        source: {
          kind: 'artifact',
          reference: { scopeId: 'artifact/workspace/ws_context', objectId: 'ar_stream' },
          artifactVersion: 1,
        },
        originalDigest: STREAMED_ORIGINAL_DIGEST,
        byteLength: STREAMED_ORIGINAL_BYTES,
        mediaType: 'application/octet-stream',
        originalSnapshotPath,
        packagePath: 'sources/ar_stream.txt',
        deliveredBytes: Buffer.from(delivered),
        projection: {
          kind: 'descriptor',
          sourceRevision: '1',
          representationId: 'binary-descriptor-v1',
          representationDigest: sha256(delivered),
          representationByteLength: Buffer.byteLength(delivered),
          deliveredDigest: sha256(delivered),
          ranges: [],
          byteLength: Buffer.byteLength(delivered),
          truncated: true,
          availability: 'unavailable',
          originalSnapshotPath,
        },
        open,
        assertUnchanged() {
          const after = fstatSync(held, { bigint: true });
          for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'] as const)
            expect(after[field]).toBe(before[field]);
        },
      };
      const files = createWorkerContextPackageFiles({
        workspaceId: 'ws_context',
        threadId: 'th_context',
        turnId: 'tu_streamed',
        workerRequestItemId: 'it_request',
        workerRequestBytes: WORKER_REQUEST_BYTES,
        includedItemIds: ['it_request'],
        contextBudgetTokens: 4096,
        materialSelections: [],
        sourceFiles: [sourceFile],
      });
      expect(files.fileInventory).toContainEqual({
        path: originalSnapshotPath,
        byteLength: STREAMED_ORIGINAL_BYTES,
        contentDigest: STREAMED_ORIGINAL_DIGEST,
      });
      expect(open).not.toHaveBeenCalled();
      const admission = new FileStorageAdmission(root, () => 0n);
      await writeWorkerContextPackageFiles(root, files, { admission });
      expect(open).toHaveBeenCalledTimes(1);
      const published = join(
        root,
        'threads/th_context/turns/tu_streamed/context-package',
        originalSnapshotPath
      );
      const output = openSync(published, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const hash = createHash('sha256');
        const chunk = Buffer.alloc(65_536);
        let total = 0;
        for (;;) {
          const count = readSync(output, chunk, 0, chunk.length, total);
          if (!count) break;
          total += count;
          hash.update(chunk.subarray(0, count));
        }
        expect(total).toBe(STREAMED_ORIGINAL_BYTES);
        expect(`sha256:${hash.digest('hex')}`).toBe(STREAMED_ORIGINAL_DIGEST);
      } finally {
        closeSync(output);
      }
      closeSync(held);
      descriptor = undefined;
      rmSync(sourcePath);
      await writeWorkerContextPackageFiles(root, files, { admission });
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Creates a small, pinned fixture source with an independently supplied digest. */
function sourceFixture(
  bytes: Uint8Array = Buffer.from([0, 255, 1])
): WorkerContextPackageSourceFileInput {
  const text = Buffer.from('Binary original is available only in the read-only file view.\n');
  return {
    source: {
      kind: 'artifact',
      reference: { scopeId: 'artifact/workspace/ws_context', objectId: 'ar_fixture' },
      artifactVersion: 1,
    },
    originalDigest: sha256(Buffer.from(bytes)),
    byteLength: bytes.byteLength,
    mediaType: 'application/octet-stream',
    originalSnapshotPath: 'originals/artifacts/ar_fixture/1/payload',
    packagePath: 'sources/ar_fixture.txt',
    projection: {
      kind: 'descriptor',
      sourceRevision: '1',
      representationId: 'unavailable-v1',
      representationDigest: sha256(text),
      representationByteLength: text.byteLength,
      deliveredDigest: sha256(text),
      ranges: [],
      byteLength: text.byteLength,
      truncated: true,
      availability: 'unavailable',
      originalSnapshotPath: 'originals/artifacts/ar_fixture/1/payload',
    },
    deliveredBytes: text,
    async *open() {
      yield bytes;
    },
    assertUnchanged() {},
  };
}

/** Creates package inputs without adding unrelated selection authority. */
function boundedInputs() {
  return {
    workspaceId: 'ws_context',
    threadId: 'th_context',
    turnId: 'tu_bounded',
    workerRequestItemId: 'it_request',
    workerRequestBytes: WORKER_REQUEST_BYTES,
    includedItemIds: ['it_request'],
    contextBudgetTokens: 4096,
    materialSelections: [],
  };
}

describe('S39 bounded delivery and publication refusal', () => {
  it.each([
    ['byte ceiling', 'a'.repeat(51_200), true],
    ['byte ceiling plus one', 'a'.repeat(51_201), false],
    ['line ceiling', 'a\n'.repeat(2000), true],
    ['line ceiling plus one', 'a\n'.repeat(2001), false],
  ] as const)('enforces the independent %s', (_name, content, accepted) => {
    const build = () =>
      createWorkerContextPackageFiles({
        ...boundedInputs(),
        knowledgeSelections: [
          {
            knowledgePageId: 'limits/example',
            content,
            contentDigest: sha256(content),
            sourceRefs: [],
          },
        ],
      });
    if (accepted) expect(build().knowledgeSelections).toHaveLength(1);
    else expect(build).toThrow(/byte or line bound/);
  });

  it('counts exact escaped aggregate metadata and refuses an impossible envelope budget', () => {
    const input = {
      ...boundedInputs(),
      workerRequestItemId: 'it_"request',
      includedItemIds: ['it_"request'],
    };
    const full = createWorkerContextPackageFiles(input);
    const manifest = full.files.find((file) => file.path === 'package.json')!.bytes;
    expect(() =>
      createWorkerContextPackageFiles({ ...input, maxMetadataBytes: manifest.byteLength })
    ).not.toThrow();
    expect(() =>
      createWorkerContextPackageFiles({ ...input, maxMetadataBytes: manifest.byteLength - 1 })
    ).toThrow(/metadata exceeds/);
    expect(() => createWorkerContextPackageFiles({ ...input, maxMetadataBytes: 1 })).toThrow(
      /metadata exceeds/
    );
  });

  it.each([
    'corrupt',
    'overrun',
    'drift',
    'abort',
    'oversized-chunk',
  ] as const)('cleans private original stages after %s and leaves no readiness manifest', async (failure) => {
    const root = mkdtempSync(join(tmpdir(), 's39-original-refusal-'));
    try {
      const source = sourceFixture(
        failure === 'oversized-chunk' ? Buffer.alloc(65_537) : undefined
      );
      const controller = new AbortController();
      let checks = 0;
      const modified = {
        ...source,
        originalDigest: failure === 'corrupt' ? `sha256:${'0'.repeat(64)}` : source.originalDigest,
        byteLength: failure === 'overrun' ? source.byteLength - 1 : source.byteLength,
        assertUnchanged() {
          if (++checks === 2 && failure === 'drift') throw new Error('Original drift.');
        },
        async *open() {
          if (failure === 'abort') controller.abort();
          yield failure === 'oversized-chunk' ? Buffer.alloc(65_537) : Buffer.from([0, 255, 1]);
        },
      };
      const files = createWorkerContextPackageFiles({
        ...boundedInputs(),
        sourceFiles: [modified],
      });
      const admission = new FileStorageAdmission(root, () => 0n);
      const release = vi.fn();
      const realReserve = admission.reserve.bind(admission);
      vi.spyOn(admission, 'reserve').mockImplementation((writes) => {
        const reservation = realReserve(writes);
        return {
          ...reservation,
          release() {
            release();
            reservation.release();
          },
        };
      });
      await expect(
        writeWorkerContextPackageFiles(root, files, { admission, signal: controller.signal })
      ).rejects.toThrow();
      const packageRoot = join(root, 'threads/th_context/turns/tu_bounded/context-package');
      expect(existsSync(join(packageRoot, 'package.json'))).toBe(false);
      expect(existsSync(join(packageRoot, source.originalSnapshotPath))).toBe(false);
      expect(release).toHaveBeenCalledTimes(2);
      const walk = (path: string): string[] =>
        readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory() ? walk(join(path, entry.name)) : [entry.name]
        );
      expect(walk(packageRoot)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses source capture before opening when the shared configured reserve cannot admit it', async () => {
    const root = mkdtempSync(join(tmpdir(), 's39-shared-reserve-'));
    try {
      const source = sourceFixture();
      const open = vi.fn(source.open);
      const files = createWorkerContextPackageFiles({
        ...boundedInputs(),
        sourceFiles: [{ ...source, open }],
      });
      const admission = new FileStorageAdmission(
        root,
        () => 900n,
        () => 1000n
      );
      await expect(
        writeWorkerContextPackageFiles(root, files, { admission })
      ).rejects.toMatchObject({ code: 'storage_capacity_unavailable' });
      expect(open).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('S39 original source authority and retained proof', () => {
  it('requires the original owner for first acceptance and then verifies historical binary snapshots independently', async () => {
    const root = mkdtempSync(join(tmpdir(), 's39-retained-original-'));
    const source = sourceFixture();
    const fixture = await createAcceptedFixture(root, { sourceFiles: [source] });
    expect(() => writeWorkerContextPackageTrace({ ...fixture, workspaceRoot: root })).toThrow(
      /original source authority/
    );
    const readSourceFile = vi.fn(() => ({
      originalDigest: source.originalDigest,
      byteLength: source.byteLength,
      mediaType: source.mediaType,
    }));
    const authorities = { ...fixture.authorities, readSourceFile };
    const trace = writeWorkerContextPackageTrace({
      authorities,
      trace: fixture.trace,
      workspaceRoot: root,
    });
    expect(readSourceFile).toHaveBeenCalledTimes(1);
    expect(trace.sourceFiles).toMatchObject([
      { source: source.source, originalDigest: source.originalDigest },
    ]);
    const missingOriginalOwner = { ...authorities, readSourceFile: vi.fn(() => null) };
    expect(
      readWorkerContextPackageTrace({
        authorities: missingOriginalOwner,
        workspaceId: 'ws_context',
        threadId: 'th_context',
        turnId: 'tu_context',
        workspaceRoot: root,
      })
    ).toEqual(trace);
    expect(missingOriginalOwner.readSourceFile).not.toHaveBeenCalled();
    const originalPath = join(
      root,
      'threads/th_context/turns/tu_context/context-package',
      source.originalSnapshotPath
    );
    chmodSync(originalPath, 0o600);
    writeFileSync(originalPath, Buffer.from([0, 254, 1]));
    expect(() =>
      verifyWorkerContextPackageTrace({ authorities, trace, workspaceRoot: root })
    ).toThrow(/digest mismatch/);
  });

  it.each([
    [
      'foreign Workspace',
      {
        source: {
          kind: 'artifact',
          reference: { scopeId: 'artifact/workspace/ws_other', objectId: 'ar_fixture' },
          artifactVersion: 1,
        },
      },
    ],
    [
      'changed revision',
      {
        source: {
          kind: 'artifact',
          reference: { scopeId: 'artifact/workspace/ws_context', objectId: 'ar_fixture' },
          artifactVersion: 2,
        },
      },
    ],
    ['escaping original path', { originalSnapshotPath: '../payload' }],
    ['invalid UTF-8 delivery', { deliveredBytes: Buffer.from([0xff]) }],
  ])('refuses %s before original reads', (_label, change) => {
    const source = sourceFixture();
    const open = vi.fn(source.open);
    expect(() =>
      createWorkerContextPackageFiles({
        ...boundedInputs(),
        sourceFiles: [{ ...source, ...change, open } as WorkerContextPackageSourceFileInput],
      })
    ).toThrow();
    expect(open).not.toHaveBeenCalled();
  });
});

describe('S39 exact original UTF-8 ranges', () => {
  it('preserves BOM and codepoints in a bounded excerpt of a huge single line', () => {
    const content = `\uFEFF${'界'.repeat(100_000)}`;
    const deliveredContent = `\uFEFF${'界'.repeat(17_000)}`;
    const projection: WorkerContextPackageProjection = {
      kind: 'excerpt',
      sourceRevision: 'rev_huge',
      representationId: 'original-utf8',
      representationDigest: sha256(content),
      representationByteLength: Buffer.byteLength(content),
      deliveredDigest: sha256(deliveredContent),
      ranges: [{ start: 0, end: Buffer.byteLength(deliveredContent) }],
      byteLength: Buffer.byteLength(deliveredContent),
      truncated: true,
      availability: 'incomplete',
    };
    const input = {
      ...boundedInputs(),
      materialSelections: [
        {
          materialId: 'mat_huge',
          revisionId: 'rev_huge',
          parentRevisionId: null,
          mediaType: 'text/plain' as const,
          content,
          contentDigest: sha256(content),
          deliveredContent,
          projection,
          inclusionReason: 'thread_binding' as const,
          bindingMutationRequestId: 'req_huge',
          sensitivity: 'internal' as const,
        },
      ],
    };
    const files = createWorkerContextPackageFiles(input);
    const delivered = files.files.find((file) => file.path.endsWith('rev_huge.txt'))!.bytes;
    expect(Buffer.from(delivered).equals(Buffer.from(deliveredContent))).toBe(true);
    expect(delivered.byteLength).toBe(51_003);
    expect(() =>
      createWorkerContextPackageFiles({
        ...input,
        materialSelections: [
          {
            ...input.materialSelections[0]!,
            projection: { ...projection, ranges: [{ start: 1, end: projection.byteLength + 1 }] },
          },
        ],
      })
    ).toThrow(/excerpt does not match/);
    expect(files.materialSelections[0]!.projection?.tokenAccounting).toBeUndefined();
  });
});

describe('S39 historical publication fence', () => {
  it('refuses a missing accepted original without reopening or rebuilding the source', async () => {
    const root = mkdtempSync(join(tmpdir(), 's39-no-historical-rebuild-'));
    const source = sourceFixture();
    const open = vi.fn(source.open);
    const fixture = await createAcceptedFixture(root, { sourceFiles: [{ ...source, open }] });
    const authorities = {
      ...fixture.authorities,
      readSourceFile: () => ({
        originalDigest: source.originalDigest,
        byteLength: source.byteLength,
        mediaType: source.mediaType,
      }),
    };
    writeWorkerContextPackageTrace({ authorities, trace: fixture.trace, workspaceRoot: root });
    const path = join(
      root,
      'threads/th_context/turns/tu_context/context-package',
      source.originalSnapshotPath
    );
    rmSync(path);
    await expect(
      writeWorkerContextPackageFiles(root, fixture.packageFiles, {
        admission: new FileStorageAdmission(root, () => 0n),
      })
    ).rejects.toThrow(/inventory mismatch/);
    expect(open).toHaveBeenCalledTimes(1);
    expect(existsSync(path)).toBe(false);
  });
});

/** Uses the one existing bound Material body path for both its selection and original inventory proof. */
function sharedMaterialInputs(): Parameters<typeof createWorkerContextPackageFiles>[0] {
  const content = '# Shared material\nOriginal remainder.\n';
  const deliveredContent = '# Shared material';
  const originalSnapshotPath = 'originals/materials/mat_shared/rev_shared/payload';
  const projection: WorkerContextPackageProjection = {
    kind: 'excerpt',
    sourceRevision: 'rev_shared',
    representationId: 'original-utf8',
    representationDigest: sha256(content),
    representationByteLength: Buffer.byteLength(content),
    deliveredDigest: sha256(deliveredContent),
    ranges: [{ start: 0, end: Buffer.byteLength(deliveredContent) }],
    byteLength: Buffer.byteLength(deliveredContent),
    truncated: true,
    availability: 'incomplete',
    originalSnapshotPath,
  };
  return {
    ...boundedInputs(),
    materialSelections: [
      {
        materialId: 'mat_shared',
        revisionId: 'rev_shared',
        parentRevisionId: null,
        mediaType: 'text/markdown',
        content,
        contentDigest: sha256(content),
        deliveredContent,
        projection,
        inclusionReason: 'thread_binding',
        bindingMutationRequestId: 'req_shared',
        sensitivity: 'internal',
      },
    ],
    sourceFiles: [
      {
        source: {
          kind: 'material',
          reference: { scopeId: 'material/workspace/ws_context', objectId: 'mat_shared' },
          revisionId: 'rev_shared',
        },
        originalDigest: sha256(content),
        byteLength: Buffer.byteLength(content),
        mediaType: 'text/markdown',
        originalSnapshotPath,
        packagePath: 'workspace/materials/mat_shared/rev_shared.md',
        projection,
        deliveredBytes: Buffer.from(deliveredContent),
        async *open() {
          yield Buffer.from(content);
        },
        assertUnchanged() {},
      },
    ],
  };
}

describe('S39 one bound Material delivery path', () => {
  it('retains one original inventory entry and reuses the exact selected body without duplicate bytes', async () => {
    const input = sharedMaterialInputs();
    const files = createWorkerContextPackageFiles(input);
    const source = files.sourceFiles![0]!;
    const selected = files.materialSelections[0]!;
    expect(source.packagePath).toBe(selected.packagePath);
    expect(files.files.filter((file) => file.path === selected.packagePath)).toHaveLength(1);
    expect(files.fileInventory.filter((entry) => entry.path === selected.packagePath)).toHaveLength(
      1
    );
    expect(
      files.fileInventory.filter((entry) => entry.path === source.originalSnapshotPath)
    ).toHaveLength(1);
    expect(files.files.some((file) => file.path.startsWith('sources/'))).toBe(false);
    const root = mkdtempSync(join(tmpdir(), 's39-shared-material-'));
    await writeWorkerContextPackageFiles(root, files, {
      admission: new FileStorageAdmission(root, () => 0n),
    });
    const packageRoot = join(root, 'threads/th_context/turns/tu_bounded/context-package');
    expect(readFileSync(join(packageRoot, selected.packagePath), 'utf8')).toBe(
      input.materialSelections[0]!.deliveredContent
    );
    expect(readFileSync(join(packageRoot, source.originalSnapshotPath), 'utf8')).toBe(
      input.materialSelections[0]!.content
    );
    expect(
      JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).sourceFiles[0].packagePath
    ).toBe(selected.packagePath);
  });

  it.each([
    'identity',
    'path',
    'projection',
    'digest',
    'size',
    'bytes',
    'kind',
  ] as const)('refuses mismatched shared Material %s before publication', (change) => {
    const input = sharedMaterialInputs();
    const source = input.sourceFiles![0]!;
    const modified: WorkerContextPackageSourceFileInput = {
      ...source,
      ...(change === 'identity'
        ? {
            source: {
              kind: 'material' as const,
              reference: { scopeId: 'material/workspace/ws_context', objectId: 'mat_other' },
              revisionId: 'rev_shared',
            },
          }
        : {}),
      ...(change === 'path' ? { packagePath: 'workspace/materials/mat_shared/rev_other.md' } : {}),
      ...(change === 'projection'
        ? { projection: { ...source.projection, representationId: 'other-representation' } }
        : {}),
      ...(change === 'digest' ? { originalDigest: `sha256:${'0'.repeat(64)}` } : {}),
      ...(change === 'size' ? { byteLength: source.byteLength + 1 } : {}),
      ...(change === 'bytes' ? { deliveredBytes: Buffer.from('Changed body') } : {}),
      ...(change === 'kind'
        ? {
            source: {
              kind: 'artifact' as const,
              reference: { scopeId: 'artifact/workspace/ws_context', objectId: 'mat_shared' },
              artifactVersion: 1,
            },
          }
        : {}),
    };
    expect(() => createWorkerContextPackageFiles({ ...input, sourceFiles: [modified] })).toThrow();
  });
});

describe('S39 empty original stream', () => {
  it('keeps an empty original valid when its supplier emits an empty chunk', async () => {
    const source = sourceFixture(Buffer.alloc(0));
    const files = createWorkerContextPackageFiles({ ...boundedInputs(), sourceFiles: [source] });
    const root = mkdtempSync(join(tmpdir(), 's39-empty-original-'));
    await writeWorkerContextPackageFiles(root, files, {
      admission: new FileStorageAdmission(root, () => 0n),
    });
    expect(
      readFileSync(
        join(
          root,
          'threads/th_context/turns/tu_bounded/context-package',
          source.originalSnapshotPath
        )
      )
    ).toEqual(Buffer.alloc(0));
    expect(files.fileInventory).toContainEqual({
      path: source.originalSnapshotPath,
      byteLength: 0,
      contentDigest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
  });
});
