import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStructuredWorkerDelegationRequest,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { resolveDataRootPath } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { createWorkerContextPackageAuthorityReader } from './worker-context-authorities.js';
import {
  buildWorkerContextPackageWorkspaceInput,
  createWorkerContextPackageFiles,
  createWorkerContextPackagePolicyDigest,
  createWorkerContextPackageTrace,
  readPortableWorkerContextPackageTrace,
  readWorkerContextPackageTrace,
  type WorkerContextPackageAuthorityReader,
  type WorkerContextPackageTrace,
  writeWorkerContextPackageFiles,
  writeWorkerContextPackageTrace,
} from './worker-context-package.js';
import {
  projectThreadMaterialContext,
  projectThreadTaskInputs,
  projectVerifiedThreadMaterialTraces,
  type VerifiedWorkerContextTrace,
} from './worker-context-projection.js';

vi.mock('./worker-context-authorities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worker-context-authorities.js')>();
  return {
    ...actual,
    createWorkerContextPackageAuthorityReader: vi.fn(
      actual.createWorkerContextPackageAuthorityReader
    ),
  };
});

vi.mock('./worker-context-package.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worker-context-package.js')>();
  return {
    ...actual,
    readWorkerContextPackageTrace: vi.fn(actual.readWorkerContextPackageTrace),
  };
});

/** Builds the trace fields consumed by the pure read projector. */
function trace(
  turnId: string,
  selections: readonly [materialId: string, revisionId: string][]
): WorkerContextPackageTrace {
  return {
    turnId,
    materialSelections: selections.map(([materialId, revisionId]) => ({
      materialId,
      revisionId,
    })),
  } as WorkerContextPackageTrace;
}

/** Pairs one minimal trace with its verification branch and ordering timestamp. */
function verifiedTrace(
  turnId: string,
  selections: readonly [materialId: string, revisionId: string][],
  verification: VerifiedWorkerContextTrace['verification'] = 'strict',
  startedAt = '2026-07-18T00:00:00.000Z'
): VerifiedWorkerContextTrace {
  return { startedAt, trace: trace(turnId, selections), verification };
}

describe('worker Context Package read projection', () => {
  it('projects the exact Material revision from a retained compact trace and canonical manifest', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-material-compact-trace-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = await createDemoStore({ dataRoot });
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(workspaceDb);
    const thread = await store.createThread(workspaceId, 'Compact trace Material projection');
    const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
    const turn = await store.createTurn(
      workspaceId,
      thread.id,
      'Read the selected revision.',
      actor
    );
    const agentSessionId = 'as_00000000-0000-7000-8000-000000000004';
    const itemId = 'it_00000000-0000-7000-8000-000000000003';
    const requestId = 'material_compact_trace';
    const request = structuredRequestText('Read the selected revision.');
    const workspaceRoot = resolveDataRootPath(dataRoot, 'workspaces', workspaceId);
    const material = {
      materialId: 'mat_00000000-0000-780b-aa01-5f7fb6dd4093',
      revisionId: 'mrev_00000000-0000-73b7-bfe3-9b5c8390209e',
      parentRevisionId: null,
      mediaType: 'text/markdown' as const,
      content: '# Exact selected revision\n',
      contentDigest: `sha256:${createHash('sha256').update('# Exact selected revision\n').digest('hex')}`,
      sensitivity: 'internal' as const,
    };
    try {
      await store.updateTurn(turn.id, { agentSessionId });
      const files = createWorkerContextPackageFiles({
        workspaceId,
        threadId: thread.id,
        turnId: turn.id,
        workerRequestBytes: request,
        workerRequestItemId: itemId,
        includedItemIds: [itemId],
        contextBudgetTokens: 4096,
        materialSelections: [
          { ...material, inclusionReason: 'thread_binding', bindingMutationRequestId: 'bind_1' },
        ],
      });
      await writeWorkerContextPackageFiles(workspaceRoot, files, {
        admission: new FileStorageAdmission(dataRoot, () => 0n),
      });
      const contextInput = buildWorkerContextPackageWorkspaceInput({
        agentSessionId,
        threadId: thread.id,
        turnId: turn.id,
        packageRootDigest: files.packageRootDigest,
      });
      const unresolved = resolveAgentEnvironmentPackage({
        agentSessionId,
        agentSetup: createTestAgentSetup(),
        backend: { kind: 'openshell' },
        captureCoverage: { scope: 'server', value: 'off' },
        requestId,
        triggerActor: actor,
        turn,
        turnInput: request,
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      });
      const environmentPackage = AgentEnvironmentPackageSchema.parse({
        ...unresolved,
        scope: { ...unresolved.scope, itemId },
        workspace: { ...unresolved.workspace, inputs: [contextInput] },
      });
      const packageSnapshotId = environmentPackage.snapshotId;
      const fullTrace = createWorkerContextPackageTrace({
        agentSessionId,
        excludedItems: [],
        goalId: 'goal_history',
        taskId: 'task_history',
        packageFiles: files,
        packageSnapshotId,
        requestId,
      });
      const readinessEvidence = [{ kind: 'backend.ready', ref: 'fixture' }];
      const base = { commit: null, contentDigest: files.packageRootDigest };
      const authorities: WorkerContextPackageAuthorityReader = {
        readAdmission: () => ({
          workspaceId,
          threadId: thread.id,
          turnId: turn.id,
          requestId,
          status: 'admitted',
        }),
        readAgentEnvironmentPackage: () => environmentPackage,
        readAgentSession: () => ({
          id: agentSessionId,
          workspaceId,
          threadId: thread.id,
          environmentPackageSnapshotId: packageSnapshotId,
          stale: false,
        }),
        readBackendHandoff: () => ({
          workspaceId,
          threadId: thread.id,
          turnId: turn.id,
          agentSessionId,
          packageSnapshotId,
          backendKind: 'openshell',
          backendSessionId: 'sandbox_projection',
          workspaceHandoffState: 'complete',
          readinessEvidence,
        }),
        readMaterialRevision: () => ({ ...material, workspaceId }),
        readThreadItems: () => [
          {
            id: itemId,
            owner: { kind: 'workspace', workspaceId: workspaceId },
            threadId: thread.id,
            turnId: turn.id,
            type: 'user-message',
            status: 'completed',
            text: request,
          },
        ],
        readThreadParent: () => null,
        readTurn: () => ({ ...turn, agentSessionId }),
        readWorkspaceImportedFrom: () => null,
        readWorkspaceInputSnapshot: () => ({
          backend: {
            capabilitySummary: [...environmentPackage.backend.requiredCapabilities],
            kind: 'openshell',
            label: 'openshell worker backend',
          },
          base,
          createdAt: turn.startedAt,
          generatedFiles: [],
          id: fullTrace.workspaceInputSnapshotId,
          ignoredPaths: [],
          pathScope: [`context_${turn.id}`],
          resourceId: `context_${turn.id}`,
          resourceKind: 'filesystem',
          strategy: 'filesystem',
          workspaceId,
          writableRoots: [],
        }),
        readWorkspaceMaterializationRecord: () => ({
          backendKind: 'openshell',
          base,
          createdAt: turn.startedAt,
          id: fullTrace.workspaceMaterializationRecordId,
          inputSnapshotId: fullTrace.workspaceInputSnapshotId,
          materializedRootRef: contextInput.target,
          packageSnapshotId,
          policyDigest: createWorkerContextPackagePolicyDigest({
            backendKind: 'openshell',
            packageSnapshotId,
            requiredCapabilities: environmentPackage.backend.requiredCapabilities,
          }),
          readinessEvidence,
          strategy: 'filesystem',
          workerSessionId: 'sandbox_projection',
          workspaceId,
        }),
      };
      writeWorkerContextPackageTrace({ authorities, trace: fullTrace, workspaceRoot });
      const turnRoot = join(workspaceRoot, 'threads', thread.id, 'turns', turn.id);
      expect(
        JSON.parse(readFileSync(join(turnRoot, 'context-package.json'), 'utf8'))
      ).not.toHaveProperty('materialSelections');
      expect(
        readPortableWorkerContextPackageTrace({
          authorities,
          workspaceId,
          threadId: thread.id,
          turnId: turn.id,
          workspaceRoot,
        }).trace.materialSelections
      ).toMatchObject([{ materialId: material.materialId, revisionId: material.revisionId }]);
      vi.mocked(createWorkerContextPackageAuthorityReader).mockReturnValue(authorities);
      const input = {
        coreDb,
        workspaceDb,
        store,
        threadId: thread.id,
        materialId: material.materialId,
      };
      const expected = {
        lastWorkerSeenRevisionId: material.revisionId,
        currentTurnRevisionId: material.revisionId,
        activeDelivery: null,
      };
      expect
        .soft(() => expect(projectThreadMaterialContext(input)).toEqual(expected))
        .not.toThrow();
      const manifestPath = join(turnRoot, 'context-package/package.json');
      const originalBytes = readFileSync(manifestPath);
      chmodSync(manifestPath, 0o600);
      writeFileSync(manifestPath, Buffer.concat([originalBytes, Buffer.from('\n')]));
      expect(() => projectThreadMaterialContext(input)).toThrow(
        'Worker Context Package verification failed: owner=worker-context-projection; check=readPortableWorkerContextPackageTrace; stage=thread-material-read.'
      );
      // A failure at an earlier owner must name that observed check, not the later reader.
      vi.mocked(createWorkerContextPackageAuthorityReader).mockImplementation(() => {
        throw new Error('Private authority failure at /private/source with source-content.');
      });
      let refusal: unknown;
      try {
        projectThreadMaterialContext(input);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({
        code: 'recovery_required',
        status: 409,
        message:
          'Worker Context Package verification failed: owner=worker-context-projection; check=createWorkerContextPackageAuthorityReader; stage=thread-material-read.',
      });
      expect(String(refusal)).not.toMatch(/private|source-content/);
    } finally {
      vi.mocked(createWorkerContextPackageAuthorityReader).mockRestore();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'orders last-seen traces by startedAt and then Turn id descending',
      traces: [
        verifiedTrace('tu_00000000-0000-7000-8000-000000000001', [
          ['mat_00000000-0000-780b-aa01-5f7fb6dd4093', 'mrev_00000000-0000-73b7-bfe3-9b5c8390209e'],
        ]),
        verifiedTrace('tu_00000000-0000-7000-8000-000000000002', [
          ['mat_00000000-0000-780b-aa01-5f7fb6dd4093', 'mrev_00000000-0000-7ae0-81e6-eaf3820b674e'],
        ]),
      ],
      currentTurnId: 'tu_00000000-0000-7000-8000-000000000001',
      expected: {
        lastWorkerSeenRevisionId: 'mrev_00000000-0000-7ae0-81e6-eaf3820b674e',
        currentTurnRevisionId: 'mrev_00000000-0000-73b7-bfe3-9b5c8390209e',
      },
    },
    {
      name: 'returns null when no verified trace selected the Material',
      traces: [
        verifiedTrace('tu_00000000-0000-7000-8000-000000000001', [
          ['mat_00000000-0000-7ab0-b20c-4dc5a61a957a', 'mrev_00000000-0000-7ae0-81e6-eaf3820b674e'],
        ]),
      ],
      currentTurnId: 'tu_00000000-0000-7000-8000-000000000001',
      expected: { lastWorkerSeenRevisionId: null, currentTurnRevisionId: null },
    },
    {
      name: 'does not substitute a historical trace for the current Turn',
      traces: [
        verifiedTrace('tu_00000000-0000-7000-8000-000000000001', [
          ['mat_00000000-0000-780b-aa01-5f7fb6dd4093', 'mrev_00000000-0000-73b7-bfe3-9b5c8390209e'],
        ]),
      ],
      currentTurnId: 'tu_00000000-0000-7000-8000-000000000002',
      expected: {
        lastWorkerSeenRevisionId: 'mrev_00000000-0000-73b7-bfe3-9b5c8390209e',
        currentTurnRevisionId: null,
      },
    },
    {
      name: 'uses imported history only for last-seen revision',
      traces: [
        verifiedTrace(
          'tu_00000000-0000-75d9-956c-5ec2769cb134',
          [
            [
              'mat_00000000-0000-780b-aa01-5f7fb6dd4093',
              'mrev_00000000-0000-7282-92b9-561b941e9a5a',
            ],
          ],
          'imported-history',
          '2026-07-18T01:00:00.000Z'
        ),
      ],
      currentTurnId: 'tu_00000000-0000-75d9-956c-5ec2769cb134',
      expected: {
        lastWorkerSeenRevisionId: 'mrev_00000000-0000-7282-92b9-561b941e9a5a',
        currentTurnRevisionId: null,
      },
    },
  ])('$name', ({ traces, currentTurnId, expected }) => {
    expect(
      projectVerifiedThreadMaterialTraces({
        currentTurnId,
        materialId: 'mat_00000000-0000-780b-aa01-5f7fb6dd4093',
        traces,
      })
    ).toEqual(expected);
  });

  it.each([
    'accepted-turn',
    'admission',
  ] as const)('fails closed when %s authority lacks its canonical trace', async (authority) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-context-missing-trace-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = await createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(workspaceDb);
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Missing accepted context trace'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Run accepted worker turn.',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );

    try {
      if (authority === 'accepted-turn') {
        await store.updateTurn(turn.id, {
          agentSessionId: 'as_00000000-0000-7b9a-ba85-578bca58899d',
        });
      } else {
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          queueEntryId: 'queue_missing_context_trace',
          requestId: 'request_missing_context_trace',
          triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: thread.id,
          turnId: turn.id,
          turnInput: 'Run accepted worker turn.',
          requestedAgentId: 'agent_codex_host',
          profileRef: 'agent_codex_host',
        });
        coreDb.sqlite
          .prepare(
            "UPDATE scheduler_admission_entries SET status = 'admitted' WHERE queue_entry_id = ?"
          )
          .run('queue_missing_context_trace');
      }

      expect(() =>
        projectThreadMaterialContext({
          coreDb,
          store,
          workspaceDb,
          threadId: thread.id,
          materialId: 'mat_00000000-0000-780b-aa01-5f7fb6dd4093',
        })
      ).toThrow(
        'An accepted worker Turn or admitted scheduler entry lacks its Context Package trace.'
      );
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});

/** Compact structured worker request used to prove objective extraction. */
function structuredRequestText(objective: string): string {
  return serializeStructuredWorkerDelegationRequest(
    createStructuredWorkerDelegationRequest({
      acceptanceCriteria: ['The projection returns only a proven objective.'],
      constraints: { maxContextTokens: 4_096, maxWorkerIterations: 1 },
      contextRefs: [
        { kind: 'workspace', id: 'ws_00000000-0000-7000-8000-000000000001' },
        { kind: 'thread', id: 'th_00000000-0000-7000-8000-000000000001' },
      ],
      escalationConditions: [],
      expectedArtifacts: [],
      objective,
      resources: [],
      reviewContext: null,
      reviewPolicy: {
        instructions: 'Review the worker result.',
        required: false,
        reviewers: ['human'],
      },
      verification: [{ description: 'Report the bounded result.', kind: 'manual' }],
    })
  );
}

describe('thread taskInputs projection', () => {
  afterEach(async () => {
    await shutdownControlStoreWorkerClient();
    vi.mocked(createWorkerContextPackageAuthorityReader).mockRestore();
    vi.mocked(readWorkerContextPackageTrace).mockRestore();
  });

  it('maps the objective from a verified trace through the exact request Item', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-task-inputs-valid-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = await createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(workspaceDb);
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Proven initiating request'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Run proven worker request.',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const requestText = structuredRequestText('Implement the bounded dashboard projection.');
    const otherText = structuredRequestText('Ignore this unproven matching JSON.');
    const item = await store.createItem({
      id: 'it_00000000-0000-7b9d-9e1a-2632c3b76ed5',
      owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-message',
      status: 'completed',
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      text: requestText,
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt,
    });
    await store.createItem({
      id: 'it_00000000-0000-7275-b9e3-6a2e51407254',
      owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-message',
      status: 'completed',
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      text: otherText,
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt,
    });
    const input = {
      coreDb,
      store,
      threadId: thread.id,
      workspaceDb,
    };
    const authorities = createWorkerContextPackageAuthorityReader(input);

    try {
      vi.mocked(createWorkerContextPackageAuthorityReader).mockReturnValue(authorities);
      vi.mocked(readWorkerContextPackageTrace).mockReturnValue({
        workerRequestItemId: item.id,
        workerRequestDigest: `sha256:${createHash('sha256').update(requestText).digest('hex')}`,
      } as WorkerContextPackageTrace);

      expect(projectThreadTaskInputs(input)).toEqual([
        { itemId: item.id, objective: 'Implement the bounded dashboard projection.' },
      ]);
      expect(createWorkerContextPackageAuthorityReader).toHaveBeenCalledWith(input);
      expect(readWorkerContextPackageTrace).toHaveBeenCalledWith({
        authorities,
        threadId: thread.id,
        turnId: turn.id,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        workspaceRoot: resolveDataRootPath(
          dataRoot,
          'workspaces',
          'ws_00000000-0000-7000-8000-000000000001'
        ),
      });
      vi.mocked(readWorkerContextPackageTrace).mockReturnValue({
        workerRequestItemId: item.id,
        workerRequestDigest: `sha256:${createHash('sha256').update(otherText).digest('hex')}`,
      } as WorkerContextPackageTrace);
      expect(projectThreadTaskInputs(input)).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('omits a summary when the shared verifier throws missing or corrupt proof', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-task-inputs-corrupt-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = await createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(workspaceDb);
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Corrupt initiating request'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Run unproven worker request.',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    await store.createItem({
      id: 'it_00000000-0000-75e6-8332-7e496922d8d5',
      owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-message',
      status: 'completed',
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      text: structuredRequestText('Do not treat matching JSON as proof.'),
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt,
    });
    const input = {
      coreDb,
      store,
      threadId: thread.id,
      workspaceDb,
    };
    const authorities = createWorkerContextPackageAuthorityReader(input);

    try {
      vi.mocked(createWorkerContextPackageAuthorityReader).mockReturnValue(authorities);
      vi.mocked(readWorkerContextPackageTrace).mockImplementation(() => {
        throw new Error('Worker Context Package trace is unavailable.');
      });

      expect(projectThreadTaskInputs(input)).toEqual([]);
      expect(createWorkerContextPackageAuthorityReader).toHaveBeenCalledWith(input);
      expect(readWorkerContextPackageTrace).toHaveBeenCalledWith({
        authorities,
        threadId: thread.id,
        turnId: turn.id,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        workspaceRoot: resolveDataRootPath(
          dataRoot,
          'workspaces',
          'ws_00000000-0000-7000-8000-000000000001'
        ),
      });
      expect(store.listThreadItems('ws_00000000-0000-7000-8000-000000000001', thread.id)).toEqual([
        expect.objectContaining({
          id: 'it_00000000-0000-75e6-8332-7e496922d8d5',
          text: expect.stringContaining('Do not treat matching JSON as proof.'),
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
