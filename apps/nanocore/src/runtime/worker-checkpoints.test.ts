import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
} from '../capability/usage-ledger.js';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  listWorkspaceRuntimeEvidence,
  recordWorkerBackendTeardownEvidence,
} from './runtime-evidence.js';
import {
  clearWorkerCheckpoint,
  createWorkerCheckpointEvidenceDiagnostics,
  getWorkerCheckpoint,
  parseWorkerCheckpointContextAssembly,
  updateWorkerCheckpoint,
  upsertWorkerCheckpoint,
} from './worker-checkpoints.js';

/**
 * Opens a migrated workspace database for worker checkpoint tests.
 *
 * @returns Migrated workspace database handle.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-checkpoints-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

describe('worker checkpoint storage', () => {
  it('creates compact evidence diagnostics for checkpoint summaries', () => {
    expect(createWorkerCheckpointEvidenceDiagnostics({ itemIds: [], artifactIds: [] })).toBeNull();
    expect(
      createWorkerCheckpointEvidenceDiagnostics({
        itemIds: ['it_00000000-0000-7a37-91be-d019992bbed5'],
        artifactIds: ['ar_00000000-0000-75c1-916e-15c1a3a00e41'],
      })
    ).toBe(
      '{"itemIds":["it_00000000-0000-7a37-91be-d019992bbed5"],"artifactIds":["ar_00000000-0000-75c1-916e-15c1a3a00e41"]}'
    );
    expect(
      createWorkerCheckpointEvidenceDiagnostics(
        { itemIds: ['it_00000000-0000-7c48-be23-62b666211f68'], artifactIds: [] },
        null,
        'Worker process exited with code 1.'
      )
    ).toBe(
      '{"itemIds":["it_00000000-0000-7c48-be23-62b666211f68"],"artifactIds":[],"failureSummary":"Worker process exited with code 1."}'
    );
  });

  it('stores only the closed checkpoint context fields', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-739f-8055-882b863ee48c',
        requestId: 'req_closed_context',
        requestInputHash: 'sha256:closed_context',
        stage: 'running_worker',
        iteration: 1,
        diagnosticsSummary: JSON.stringify({
          itemIds: ['it_00000000-0000-7c83-8648-2137d67bcf8e'],
          artifactIds: [],
          contextAssembly: {
            contextDigest: 'sha256:context',
            contextRefs: [
              {
                kind: 'workspace',
                id: 'ws_00000000-0000-7000-8000-000000000001',
                authorization: 'Bearer live_secret',
              },
            ],
            knowledgeSelectionInput: null,
            nativeThreadId: 'native_secret',
          },
        }),
        now: () => '2026-05-31T00:00:00.000Z',
      });

      expect(checkpoint.diagnosticsSummary).toBe(
        '{"itemIds":["it_00000000-0000-7c83-8648-2137d67bcf8e"],"artifactIds":[],"contextAssembly":{"contextDigest":"sha256:context","contextRefs":[{"kind":"workspace","id":"ws_00000000-0000-7000-8000-000000000001"}],"knowledgeSelectionInput":null}}'
      );
      expect(checkpoint.diagnosticsSummary).not.toContain('live_secret');
      expect(checkpoint.diagnosticsSummary).not.toContain('native_secret');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('reads, rewrites and reopens annotated checkpoint selection summaries', () => {
    const workspaceDb = createWorkspaceDb();
    try {
      const diagnostics = JSON.stringify({
        annotation: 'outer',
        contextAssembly: {
          contextDigest: 'sha256:context',
          annotation: 'assembly',
          contextRefs: [
            {
              kind: 'workspace',
              id: 'ws_00000000-0000-7000-8000-000000000001',
              annotation: 'reference',
            },
          ],
          knowledgeSelectionInput: {
            retrievalTraceRef: {
              scopeId:
                'retrieval-trace/turn/ws_00000000-0000-7000-8000-000000000001/th_00000000-0000-7000-8000-000000000001/tu_00000000-0000-76bf-b9f7-48f0f8d2d3ce',
              objectId: 'krt_00000000-0000-780e-b78f-51422afca1e9',
              annotation: 'qualified reference',
            },
            annotation: 'selection',
          },
        },
      });
      const expected = {
        contextDigest: 'sha256:context',
        contextRefs: [{ kind: 'workspace', id: 'ws_00000000-0000-7000-8000-000000000001' }],
        knowledgeSelectionInput: {
          retrievalTraceRef: {
            scopeId:
              'retrieval-trace/turn/ws_00000000-0000-7000-8000-000000000001/th_00000000-0000-7000-8000-000000000001/tu_00000000-0000-76bf-b9f7-48f0f8d2d3ce',
            objectId: 'krt_00000000-0000-780e-b78f-51422afca1e9',
          },
        },
      };
      expect(parseWorkerCheckpointContextAssembly(diagnostics)).toEqual(expected);
      expect(
        parseWorkerCheckpointContextAssembly(
          JSON.stringify({
            contextAssembly: {
              contextDigest: 'sha256:context',
              contextRefs: [],
              knowledgeSelectionInput: {
                retrievalTraceId: 'krt_00000000-0000-780e-b78f-51422afca1e9',
              },
            },
          })
        )
      ).toBeNull();
      const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-74a3-a7a1-0220eb37b036',
        requestId: 'req_extended',
        requestInputHash: 'sha256:extended',
        stage: 'running_worker',
        iteration: 1,
        diagnosticsSummary: diagnostics,
      });
      expect(parseWorkerCheckpointContextAssembly(checkpoint.diagnosticsSummary)).toEqual(expected);
      const reopened = openWorkspaceDb(workspaceDb.dataRoot, workspaceDb.workspaceId);
      try {
        expect(
          parseWorkerCheckpointContextAssembly(
            getWorkerCheckpoint(
              reopened,
              'ws_00000000-0000-7000-8000-000000000001',
              'th_00000000-0000-7000-8000-000000000001',
              'tu_00000000-0000-74a3-a7a1-0220eb37b036'
            )!.diagnosticsSummary
          )
        ).toEqual(expected);
      } finally {
        reopened.sqlite.close();
      }
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('creates and reads request-bound worker checkpoints without replay instructions', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        requestId: 'req_worker_demo',
        requestInputHash: 'sha256:worker_demo',
        stage: 'running_worker',
        iteration: 2,
        workerSessionId: 'session_demo',
        contextDigest: 'ctxpkg_sha256_abc',
        stopReason: null,
        diagnosticsSummary: 'worker is running',
        now: () => '2026-05-31T00:00:00.000Z',
      });

      expect(checkpoint).toMatchObject({
        checkpointId:
          'ws_00000000-0000-7000-8000-000000000001:th_00000000-0000-7000-8000-000000000001:tu_00000000-0000-77e3-bfde-66477d556f64',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        requestId: 'req_worker_demo',
        requestInputHash: 'sha256:worker_demo',
        stage: 'running_worker',
        iteration: 2,
        workerSessionId: 'session_demo',
        contextDigest: 'ctxpkg_sha256_abc',
        replayInstruction: false,
        createdAt: '2026-05-31T00:00:00.000Z',
        updatedAt: '2026-05-31T00:00:00.000Z',
      });
      expect(
        getWorkerCheckpoint(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'tu_00000000-0000-77e3-bfde-66477d556f64'
        )
      ).toEqual(checkpoint);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('updates and clears worker checkpoints', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        requestId: 'req_turn_demo',
        requestInputHash: 'sha256:tu_00000000-0000-77e3-bfde-66477d556f64',
        stage: 'running_worker',
        iteration: 1,
        now: () => '2026-05-31T00:00:00.000Z',
      });

      const updated = updateWorkerCheckpoint(workspaceDb, {
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b' },
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        stage: 'failed',
        stopReason: 'error',
        diagnosticsSummary: 'provider failed',
        now: () => '2026-05-31T00:10:00.000Z',
      });

      expect(updated).toMatchObject({
        stage: 'failed',
        stopReason: 'error',
        diagnosticsSummary: 'provider failed',
        updatedAt: '2026-05-31T00:10:00.000Z',
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toMatchObject([
        {
          phase: 'checkpoint',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
          outcome: 'failed',
          redactedStderrSummary: 'provider failed',
        },
      ]);
      expect(
        clearWorkerCheckpoint(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'tu_00000000-0000-77e3-bfde-66477d556f64'
        )
      ).toBe(true);
      expect(
        getWorkerCheckpoint(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'tu_00000000-0000-77e3-bfde-66477d556f64'
        )
      ).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records one audit event when a checkpoint first transitions to a terminal stage', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-7506-bfe1-961aaf316353',
        requestId: 'req_turn_direct_terminal',
        requestInputHash: 'sha256:tu_00000000-0000-7506-bfe1-961aaf316353',
        stage: 'completed',
        iteration: 1,
        stopReason: 'completed',
        now: () => '2026-05-31T00:00:00.000Z',
      });
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-70de-9845-2fece35e232a',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        requestId: 'req_turn_terminal',
        requestInputHash: 'sha256:tu_00000000-0000-70de-9845-2fece35e232a',
        stage: 'running_worker',
        iteration: 1,
        now: () => '2026-05-31T00:00:00.000Z',
      });
      expect(
        workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get()
      ).toEqual({ count: 0 });

      updateWorkerCheckpoint(workspaceDb, {
        authorityActor: {
          kind: 'agent',
          id: 'agent_runtime_demo',
          responsibleUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
        },
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-70de-9845-2fece35e232a',
        stage: 'completed',
        stopReason: 'completed',
        now: () => '2026-05-31T00:10:00.000Z',
      });
      updateWorkerCheckpoint(workspaceDb, {
        authorityActor: {
          kind: 'agent',
          id: 'agent_runtime_demo',
          responsibleUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
        },
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-70de-9845-2fece35e232a',
        stage: 'completed',
        stopReason: 'completed',
        now: () => '2026-05-31T00:11:00.000Z',
      });

      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, category, outcome, severity, resource, thread_id, turn_id, summary
            FROM audit_events
            WHERE action = 'worker.checkpoint.terminal'`
          )
          .all()
      ).toEqual([
        {
          action: 'worker.checkpoint.terminal',
          category: 'system',
          outcome: 'succeeded',
          resource:
            'worker-checkpoint:ws_00000000-0000-7000-8000-000000000001:th_00000000-0000-7000-8000-000000000001:tu_00000000-0000-70de-9845-2fece35e232a',
          severity: 'info',
          summary: 'Worker checkpoint terminal: completed',
          thread_id: 'th_00000000-0000-7000-8000-000000000001',
          turn_id: 'tu_00000000-0000-70de-9845-2fece35e232a',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records one runtime evidence row when a checkpoint first transitions to a terminal stage', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-784a-b5cd-eb5f8f622c05',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        requestId: 'req_turn_runtime_evidence',
        requestInputHash: 'sha256:tu_00000000-0000-784a-b5cd-eb5f8f622c05',
        stage: 'running_worker',
        iteration: 1,
        workerSessionId: 'session_demo',
        contextDigest: 'sha256:ctx_demo',
        diagnosticsSummary: createWorkerCheckpointEvidenceDiagnostics({
          itemIds: ['it_00000000-0000-7a37-91be-d019992bbed5'],
          artifactIds: ['artifact_worker_result'],
        }),
        now: () => '2026-05-31T00:00:00.000Z',
      });

      updateWorkerCheckpoint(workspaceDb, {
        authorityActor: {
          kind: 'agent',
          id: 'agent_runtime_demo',
          responsibleUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
        },
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-784a-b5cd-eb5f8f622c05',
        stage: 'completed',
        stopReason: 'completed',
        diagnosticsSummary: 'Authorization: Bearer live_secret',
        now: () => '2026-05-31T00:10:00.000Z',
      });
      updateWorkerCheckpoint(workspaceDb, {
        authorityActor: {
          kind: 'agent',
          id: 'agent_runtime_demo',
          responsibleUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
        },
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-784a-b5cd-eb5f8f622c05',
        stage: 'completed',
        stopReason: 'completed',
        now: () => '2026-05-31T00:11:00.000Z',
      });

      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toMatchObject([
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-784a-b5cd-eb5f8f622c05',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          agentSessionId: testEntityId('as', 'session_demo'),
          phase: 'checkpoint',
          summary: 'Worker checkpoint terminal: completed.',
          outcome: 'succeeded',
          stopReason: 'completed',
          redactedStderrSummary: null,
          evidenceBundleIds: [],
          requiredFeatures: ['runtime.evidence.v1'],
          createdAt: '2026-05-31T00:10:00.000Z',
          completedAt: '2026-05-31T00:10:00.000Z',
          collectedAt: '2026-05-31T00:10:00.000Z',
        },
      ]);
      expect(
        JSON.stringify(
          listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
        )
      ).not.toContain('live_secret');
      expect(
        listWorkspaceCapabilityCalls(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toMatchObject([
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-784a-b5cd-eb5f8f622c05',
          agentSessionId: testEntityId('as', 'session_demo'),
          capabilityId: 'runtime.worker_turn',
          family: 'runtime',
          operation: 'worker.checkpoint.terminal',
          providerRef: 'nanocore-runtime',
          serviceRef: 'worker-checkpoint',
          redactionClass: 'metadata-only',
          status: 'succeeded',
        },
      ]);
      expect(
        listWorkspaceUsageRecords(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toMatchObject([
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-784a-b5cd-eb5f8f622c05',
          agentSessionId: testEntityId('as', 'session_demo'),
          responsibleUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
          category: 'runtime',
          unit: 'sandbox_sessions',
          quantity: 1,
          providerRef: 'nanocore-runtime',
          source: 'worker-checkpoint-terminal',
          recordedAt: '2026-05-31T00:10:00.000Z',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records checkpoint evidence separately from authoritative backend teardown', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-7a0d-b527-6df9c8763406',
        goalId: 'goal_backend',
        taskId: 'task_backend',
        requestId: 'req_turn_backend_evidence',
        requestInputHash: 'sha256:tu_00000000-0000-7a0d-b527-6df9c8763406',
        stage: 'running_worker',
        iteration: 1,
        workerSessionId: 'session_backend',
        now: () => '2026-05-31T00:00:00.000Z',
      });
      recordWorkerBackendTeardownEvidence(workspaceDb, {
        agentSessionId: testEntityId('as', 'session_backend'),
        backendType: 'openshell',
        backendVersion: '0.0.80',
        completedAt: '2026-05-31T00:09:00.000Z',
        outcome: 'succeeded',
        packageSnapshotId: 'aepsnap_backend',
        placement: 'remote',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-7a0d-b527-6df9c8763406',
        workerImage: 'openkit/worker-codex:dev',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });

      updateWorkerCheckpoint(workspaceDb, {
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b' },
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-7a0d-b527-6df9c8763406',
        stage: 'completed',
        stopReason: 'completed',
        now: () => '2026-05-31T00:10:00.000Z',
      });

      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001').map(
          (record) => record.phase
        )
      ).toEqual(['teardown', 'checkpoint']);
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([
        expect.objectContaining({
          agentSessionId: testEntityId('as', 'session_backend'),
          backendType: 'openshell',
          backendVersion: '0.0.80',
          goalId: 'goal_backend',
          outcome: 'succeeded',
          stopReason: 'completed',
          summary: 'Worker backend teardown succeeded.',
          taskId: 'task_backend',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records failed checkpoint evidence without fabricating backend teardown', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-763f-87d2-81e8d9727aa6',
        goalId: 'goal_backend',
        taskId: 'task_backend',
        requestId: 'req_turn_backend_failure',
        requestInputHash: 'sha256:tu_00000000-0000-763f-87d2-81e8d9727aa6',
        stage: 'running_worker',
        iteration: 1,
        now: () => '2026-05-31T00:00:00.000Z',
      });
      updateWorkerCheckpoint(workspaceDb, {
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b' },
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-763f-87d2-81e8d9727aa6',
        stage: 'failed',
        stopReason: 'error',
        diagnosticsSummary: createWorkerCheckpointEvidenceDiagnostics(
          { itemIds: ['it_00000000-0000-7433-94eb-a9f9a1be99a0'], artifactIds: [] },
          null,
          'Authorization: Bearer live_secret'
        ),
        now: () => '2026-05-31T00:10:00.000Z',
      });

      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([]);
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001').filter(
          (record) => record.phase === 'checkpoint'
        )
      ).toEqual([
        expect.objectContaining({
          agentSessionId: null,
          goalId: 'goal_backend',
          outcome: 'failed',
          redactedStderrSummary: 'Authorization: Bearer [redacted]',
          stopReason: 'error',
          taskId: 'task_backend',
          transcriptSummary: '1 item, 0 artifacts',
        }),
      ]);
      expect(
        JSON.stringify(
          listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
        )
      ).not.toContain('live_secret');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('redacts checkpoint diagnostics and stores no secret columns', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-766a-959c-b6b802aab0e0',
        requestId: 'req_turn_secret',
        requestInputHash: 'sha256:tu_00000000-0000-766a-959c-b6b802aab0e0',
        stage: 'running_worker',
        iteration: 1,
        diagnosticsSummary:
          'Authorization: Bearer live_secret token=tok_00000000-0000-7608-9cb9-96beaf03534f',
        now: () => '2026-05-31T00:00:00.000Z',
      });
      const columns = workspaceDb.sqlite
        .prepare('PRAGMA table_info(worker_turn_checkpoints)')
        .all() as Array<{ name: string }>;

      expect(checkpoint.diagnosticsSummary).toBe(
        'Authorization: Bearer [redacted] token=[redacted]'
      );
      expect(JSON.stringify(checkpoint)).not.toContain('live_secret');
      expect(JSON.stringify(checkpoint)).not.toContain('tok_00000000-0000-7608-9cb9-96beaf03534f');
      expect(
        columns.some((column) => /secret|token|credential|password|env/i.test(column.name))
      ).toBe(false);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
