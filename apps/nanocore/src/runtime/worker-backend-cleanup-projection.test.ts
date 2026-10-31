import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { recordTestAgentEnvironmentPackage } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import {
  listWorkspaceRuntimeEvidence,
  recordWorkerBackendTeardownEvidence,
} from './runtime-evidence.js';
import {
  projectWorkerBackendCleanup,
  projectWorkerBackendCleanupInDb,
} from './worker-backend-cleanup-projection.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './workspace-materializer.js';
import {
  listBackendWorkspaceHandles,
  listWorkspaceMaterializationRecords,
  recordWorkspaceInputSnapshots,
  recordWorkspaceMaterializationRecords,
  updateBackendWorkspaceHandleCleanupStatus,
} from './workspace-sync-records.js';

/** Creates one workspace database with a retained package handle. */
async function createFixture(options: { omitBackendStatus?: boolean } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-cleanup-projection-'));
  await createDemoStore({ dataRoot });
  // The cases open their own exact native-client database identity after stopped setup.
  await shutdownControlStoreWorkerClient();
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
  const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
    suffix: 'cleanup_projection',
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7011-88df-c2b1e8466b6f' },
    workspaceInputIds: ['repo'],
  });
  const inputSnapshots = recordWorkspaceInputSnapshots(
    workspaceDb,
    buildWorkspaceInputSnapshots({
      backendCapabilities: ['trusted-worker-inference-relay'],
      backendKind: 'openshell',
      createdAt: '2026-07-15T00:00:00.000Z',
      environmentPackage,
    })
  );
  recordWorkspaceMaterializationRecords(
    workspaceDb,
    buildWorkspaceMaterializationRecords({
      createdAt: '2026-07-15T00:00:00.000Z',
      inputSnapshots,
      materialization: {
        backendKind: 'openshell',
        ...(options.omitBackendStatus
          ? {}
          : { backendStatus: { health: 'ready', version: '0.0.80' } }),
        packageSnapshotId: environmentPackage.snapshotId,
        requiredCapabilities: environmentPackage.backend.requiredCapabilities,
        sandbox: { name: 'openkit-as_cleanup_projection', state: 'created' },
        workspaceInputs: environmentPackage.workspace.inputs.map((input) => ({
          id: input.id,
          target: input.target,
        })),
      },
    })
  );
  return { environmentPackage, workspaceDb };
}

/** Keeps private refusal reasons at their SQL owner and verifies native rollback separately. */
async function expectCleanupRefusal(
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  input: Parameters<typeof projectWorkerBackendCleanup>[1],
  message: string | RegExp
): Promise<void> {
  // A direct transaction is an excluded stopped phase, never a competing live writer.
  await shutdownControlStoreWorkerClient();
  expect(() =>
    workspaceDb.sqlite.transaction(() => projectWorkerBackendCleanupInDb(workspaceDb, input))()
  ).toThrow(message);
  await expect(projectWorkerBackendCleanup(workspaceDb, input)).rejects.toMatchObject({
    code: 'sql-failed',
    commit: 'not-committed',
  });
}

/** Returns the canonical successful cleanup projection input. */
function cleanupInput(environmentPackage: ReturnType<typeof recordTestAgentEnvironmentPackage>) {
  return {
    agentSessionId: environmentPackage.scope.agentSessionId,
    backendType: 'openshell',
    backendVersion: '0.0.80',
    completedAt: '2026-07-15T00:01:00.000Z',
    outcome: 'succeeded' as const,
    backendSessionId: 'openkit-as_cleanup_projection',
    environmentPackage,
    packageSnapshotId: environmentPackage.snapshotId,
    placement: 'local' as const,
    threadId: environmentPackage.scope.threadId,
    turnId: environmentPackage.scope.turnId,
    workerImage: 'openkit/worker-codex:dev',
    workspaceHandoffState: 'complete' as const,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  };
}

/** Mutates the only JSON payload in one fixture table without changing indexed columns. */
function mutateOnlyHandoffPayload(
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  table:
    | 'workspace_input_snapshots'
    | 'workspace_materialization_records'
    | 'backend_workspace_handles',
  mutate: (payload: Record<string, unknown>) => Record<string, unknown>
): void {
  const row = workspaceDb.sqlite.prepare(`SELECT payload_json FROM ${table}`).get() as {
    payload_json: string;
  };
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  workspaceDb.sqlite
    .prepare(`UPDATE ${table} SET payload_json = ?`)
    .run(JSON.stringify(mutate(payload)));
}

const exactHandoffTamperCases: ReadonlyArray<
  readonly [string, (workspaceDb: ReturnType<typeof openWorkspaceDb>) => void]
> = [
  [
    'snapshot and record strategy/base together',
    (workspaceDb) => {
      mutateOnlyHandoffPayload(workspaceDb, 'workspace_input_snapshots', (payload) => ({
        ...payload,
        base: { commit: 'tampered', contentDigest: null },
        strategy: 'filesystem',
      }));
      mutateOnlyHandoffPayload(workspaceDb, 'workspace_materialization_records', (payload) => ({
        ...payload,
        base: { commit: 'tampered', contentDigest: null },
        strategy: 'filesystem',
      }));
    },
  ],
  [
    'snapshot path scope and joined source together',
    (workspaceDb) => {
      mutateOnlyHandoffPayload(workspaceDb, 'workspace_input_snapshots', (payload) => ({
        ...payload,
        pathScope: ['outside-package-scope'],
        sourceId: 'tampered-source',
      }));
      mutateOnlyHandoffPayload(workspaceDb, 'workspace_materialization_records', (payload) => ({
        ...payload,
        sourceId: 'tampered-source',
      }));
    },
  ],
  [
    'materialization policy digest',
    (workspaceDb) => {
      mutateOnlyHandoffPayload(workspaceDb, 'workspace_materialization_records', (payload) => ({
        ...payload,
        policyDigest: 'sha256:tampered',
      }));
    },
  ],
  [
    'materialized root and handle transport together',
    (workspaceDb) => {
      mutateOnlyHandoffPayload(workspaceDb, 'workspace_materialization_records', (payload) => ({
        ...payload,
        materializedRootRef: '/workspace/tampered',
      }));
      mutateOnlyHandoffPayload(workspaceDb, 'backend_workspace_handles', (payload) => ({
        ...payload,
        transportRefs: [{ kind: 'materialized-root', ref: '/workspace/tampered' }],
      }));
    },
  ],
  [
    'handle workspace payload-column divergence',
    (workspaceDb) => {
      mutateOnlyHandoffPayload(workspaceDb, 'backend_workspace_handles', (payload) => ({
        ...payload,
        workspaceId: 'ws_00000000-0000-7ed5-af04-09748208a411',
      }));
    },
  ],
  [
    'handle retention ownership',
    (workspaceDb) => {
      mutateOnlyHandoffPayload(workspaceDb, 'backend_workspace_handles', (payload) => ({
        ...payload,
        retention: 'retain-for-debug',
      }));
    },
  ],
  [
    'materialization readinessEvidence sandbox ref',
    (workspaceDb) => {
      mutateOnlyHandoffPayload(workspaceDb, 'workspace_materialization_records', (payload) => ({
        ...payload,
        readinessEvidence: [{ kind: 'sandbox.created', ref: 'foreign-sandbox' }],
      }));
    },
  ],
];

describe('worker backend cleanup projection', () => {
  it('refuses changed native package lineage before any cleanup SQL effect', async () => {
    const { environmentPackage, workspaceDb } = await createFixture();
    const beforeHandles = listBackendWorkspaceHandles(workspaceDb, workspaceDb.workspaceId);
    const beforeEvidence = listWorkspaceRuntimeEvidence(workspaceDb, workspaceDb.workspaceId);
    const client = getControlStoreWorkerClient();
    try {
      await client.open({
        database: 'native-cleanup',
        path: workspaceDb.sqlite.name,
        dataRoot: workspaceDb.dataRoot,
        create: false,
        initialize: 'workspace',
        productOwner: { kind: 'workspace', workspaceId: workspaceDb.workspaceId },
      });
      await expect(
        client.projectCleanup('native-cleanup', {
          ...cleanupInput(environmentPackage),
          packageSnapshotId: 'foreign-package',
        })
      ).rejects.toMatchObject({ code: 'invalid-request', commit: 'not-committed' });
      expect(listBackendWorkspaceHandles(workspaceDb, workspaceDb.workspaceId)).toEqual(
        beforeHandles
      );
      expect(listWorkspaceRuntimeEvidence(workspaceDb, workspaceDb.workspaceId)).toEqual(
        beforeEvidence
      );
    } finally {
      try {
        await client.shutdown();
      } finally {
        await shutdownControlStoreWorkerClient();
        workspaceDb.sqlite.close();
        rmSync(workspaceDb.dataRoot, { recursive: true, force: true });
      }
    }
  });

  it('acknowledges the complete native cleanup body on its exact scoped SQLite and ORM handle', async () => {
    const { environmentPackage, workspaceDb } = await createFixture();
    const beforeEvidence = listWorkspaceRuntimeEvidence(workspaceDb, workspaceDb.workspaceId);
    const client = getControlStoreWorkerClient();
    try {
      await client.open({
        database: 'native-cleanup',
        path: workspaceDb.sqlite.name,
        dataRoot: workspaceDb.dataRoot,
        create: false,
        initialize: 'workspace',
        productOwner: { kind: 'workspace', workspaceId: workspaceDb.workspaceId },
      });
      const result = await client.projectCleanup(
        'native-cleanup',
        cleanupInput(environmentPackage)
      );
      expect(result.workspaceHandoffComplete).toBe(true);
      expect(result.handles.length).toBeGreaterThan(0);
      expect(result.handles.every((handle) => handle.cleanupStatus === 'cleaned')).toBe(true);
      expect(listBackendWorkspaceHandles(workspaceDb, workspaceDb.workspaceId)).toEqual(
        result.handles
      );
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, workspaceDb.workspaceId).toSorted((a, b) =>
          a.id.localeCompare(b.id)
        )
      ).toEqual([...beforeEvidence, result.evidence].toSorted((a, b) => a.id.localeCompare(b.id)));
    } finally {
      try {
        await client.shutdown();
      } finally {
        await shutdownControlStoreWorkerClient();
        workspaceDb.sqlite.close();
        rmSync(workspaceDb.dataRoot, { recursive: true, force: true });
      }
    }
  });

  it('rolls back native handle updates together with rejected cleanup evidence', async () => {
    const { environmentPackage, workspaceDb } = await createFixture();
    const before = listBackendWorkspaceHandles(workspaceDb, workspaceDb.workspaceId);
    const beforeEvidence = listWorkspaceRuntimeEvidence(workspaceDb, workspaceDb.workspaceId);
    workspaceDb.sqlite.exec(
      `CREATE TRIGGER native_cleanup_evidence_abort BEFORE INSERT ON runtime_evidence BEGIN SELECT RAISE(ABORT, 'native_cleanup_evidence_abort'); END`
    );
    const client = getControlStoreWorkerClient();
    try {
      await client.open({
        database: 'native-cleanup',
        path: workspaceDb.sqlite.name,
        dataRoot: workspaceDb.dataRoot,
        create: false,
        initialize: 'workspace',
        productOwner: { kind: 'workspace', workspaceId: workspaceDb.workspaceId },
      });
      await expect(
        client.projectCleanup('native-cleanup', cleanupInput(environmentPackage))
      ).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
      expect(listBackendWorkspaceHandles(workspaceDb, workspaceDb.workspaceId)).toEqual(before);
      expect(listWorkspaceRuntimeEvidence(workspaceDb, workspaceDb.workspaceId)).toEqual(
        beforeEvidence
      );
    } finally {
      try {
        await client.shutdown();
      } finally {
        await shutdownControlStoreWorkerClient();
        workspaceDb.sqlite.close();
        rmSync(workspaceDb.dataRoot, { recursive: true, force: true });
      }
    }
  });
  it.each([
    'pending',
    'complete',
  ] as const)('replays exact no-materialization proof with a %s handoff', async (workspaceHandoffState) => {
    const { environmentPackage, workspaceDb } = await createFixture();
    try {
      workspaceDb.sqlite.prepare('DELETE FROM backend_workspace_handles').run();
      workspaceDb.sqlite.prepare('DELETE FROM workspace_materialization_records').run();
      const input = {
        ...cleanupInput(environmentPackage),
        workspaceHandoffState,
        materializationNotPublished: true,
      };
      expect(await projectWorkerBackendCleanup(workspaceDb, input)).toMatchObject({
        handles: [],
        workspaceHandoffComplete: true,
      });
      const evidence = listWorkspaceRuntimeEvidence(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001'
      );
      expect(await projectWorkerBackendCleanup(workspaceDb, input)).toMatchObject({
        handles: [],
        workspaceHandoffComplete: true,
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual(evidence);
      expect(
        listWorkspaceMaterializationRecords(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([]);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });

  it.each([
    'pending',
    'complete',
  ] as const)('rejects partial rows despite no-materialization proof with a %s handoff', async (workspaceHandoffState) => {
    const { environmentPackage, workspaceDb } = await createFixture();
    try {
      expect(
        workspaceDb.sqlite.prepare('DELETE FROM backend_workspace_handles').run().changes
      ).toBe(1);
      await expectCleanupRefusal(
        workspaceDb,
        {
          ...cleanupInput(environmentPackage),
          workspaceHandoffState,
          materializationNotPublished: true,
        },
        'handoff is incomplete'
      );
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([]);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });

  it('accepts a complete Workspace handoff whose accepted materialization omitted optional backendStatus', async () => {
    const { environmentPackage, workspaceDb } = await createFixture({ omitBackendStatus: true });
    const sandboxOnlyReadiness = [
      { kind: 'sandbox.created', ref: 'openkit-as_cleanup_projection' },
    ];

    try {
      expect(
        listWorkspaceMaterializationRecords(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([expect.objectContaining({ readinessEvidence: sandboxOnlyReadiness })]);

      expect(
        await projectWorkerBackendCleanup(workspaceDb, cleanupInput(environmentPackage))
      ).toMatchObject({
        evidence: { outcome: 'succeeded', phase: 'teardown' },
        handles: [
          expect.objectContaining({
            cleanupStatus: 'cleaned',
            updatedAt: '2026-07-15T00:01:00.000Z',
          }),
        ],
        workspaceHandoffComplete: true,
      });
      expect(
        listWorkspaceMaterializationRecords(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([expect.objectContaining({ readinessEvidence: sandboxOnlyReadiness })]);
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001').filter(
          (record) => record.phase === 'teardown'
        )
      ).toHaveLength(1);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });

  it('projects successful physical cleanup over a retained transport status', async () => {
    const { environmentPackage, workspaceDb } = await createFixture();

    try {
      updateBackendWorkspaceHandleCleanupStatus(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        environmentPackage.snapshotId,
        'retained',
        '2026-07-15T00:00:30.000Z'
      );
      expect(
        listBackendWorkspaceHandles(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([
        expect.objectContaining({
          cleanupStatus: 'retained',
          updatedAt: '2026-07-15T00:00:30.000Z',
        }),
      ]);

      expect(
        await projectWorkerBackendCleanup(workspaceDb, cleanupInput(environmentPackage))
      ).toMatchObject({
        evidence: { outcome: 'succeeded', phase: 'teardown' },
        handles: [
          expect.objectContaining({
            cleanupStatus: 'cleaned',
            updatedAt: '2026-07-15T00:01:00.000Z',
          }),
        ],
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001').filter(
          (record) => record.phase === 'teardown'
        )
      ).toHaveLength(1);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });

  it('rolls back handle updates when teardown evidence conflicts, then retries atomically', async () => {
    const { environmentPackage, workspaceDb } = await createFixture();

    try {
      recordWorkerBackendTeardownEvidence(workspaceDb, {
        ...cleanupInput(environmentPackage),
        completedAt: '2026-07-15T00:00:30.000Z',
      });

      await expectCleanupRefusal(
        workspaceDb,
        cleanupInput(environmentPackage),
        /runtime evidence replay conflict/i
      );
      expect(
        listBackendWorkspaceHandles(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([expect.objectContaining({ cleanupStatus: 'pending' })]);

      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.prepare('DELETE FROM runtime_evidence').run();
      expect(
        await projectWorkerBackendCleanup(workspaceDb, cleanupInput(environmentPackage))
      ).toMatchObject({
        evidence: { outcome: 'succeeded', phase: 'teardown' },
        handles: [expect.objectContaining({ cleanupStatus: 'cleaned' })],
      });
      expect(
        await projectWorkerBackendCleanup(workspaceDb, cleanupInput(environmentPackage))
      ).toMatchObject({
        evidence: { outcome: 'succeeded', phase: 'teardown' },
        handles: [expect.objectContaining({ cleanupStatus: 'cleaned' })],
      });
      expect(
        listBackendWorkspaceHandles(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([expect.objectContaining({ cleanupStatus: 'cleaned' })]);
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001').filter(
          (record) => record.phase === 'teardown'
        )
      ).toHaveLength(1);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });

  it('projects evidence without handles only while the durable handoff is pending', async () => {
    const { environmentPackage, workspaceDb } = await createFixture();

    try {
      workspaceDb.sqlite.prepare('DELETE FROM backend_workspace_handles').run();
      workspaceDb.sqlite.prepare('DELETE FROM workspace_materialization_records').run();

      expect(
        await projectWorkerBackendCleanup(workspaceDb, {
          ...cleanupInput(environmentPackage),
          workspaceHandoffState: 'pending',
        })
      ).toMatchObject({ handles: [], workspaceHandoffComplete: false });
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });

  it('rejects a missing handoff after Core marked it complete', async () => {
    const { environmentPackage, workspaceDb } = await createFixture();

    try {
      workspaceDb.sqlite.prepare('DELETE FROM backend_workspace_handles').run();
      workspaceDb.sqlite.prepare('DELETE FROM workspace_materialization_records').run();

      await expectCleanupRefusal(
        workspaceDb,
        cleanupInput(environmentPackage),
        'handoff is incomplete'
      );
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001').filter(
          (evidence) => evidence.phase === 'teardown'
        )
      ).toEqual([]);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });

  it('rejects and rolls back a pending partial handoff', async () => {
    const { environmentPackage, workspaceDb } = await createFixture();

    try {
      workspaceDb.sqlite.prepare('DELETE FROM backend_workspace_handles').run();

      await expectCleanupRefusal(
        workspaceDb,
        {
          ...cleanupInput(environmentPackage),
          workspaceHandoffState: 'pending',
        },
        'handoff is incomplete'
      );
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001').filter(
          (evidence) => evidence.phase === 'teardown'
        )
      ).toEqual([]);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });

  it('rejects a tampered physical worker-session join inside the projection transaction', async () => {
    const { environmentPackage, workspaceDb } = await createFixture();

    try {
      const row = workspaceDb.sqlite
        .prepare('SELECT backend_workspace_handle_id, payload_json FROM backend_workspace_handles')
        .get() as { backend_workspace_handle_id: string; payload_json: string };
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      workspaceDb.sqlite
        .prepare(
          'UPDATE backend_workspace_handles SET worker_session_id = ?, payload_json = ? WHERE backend_workspace_handle_id = ?'
        )
        .run(
          'openkit-other-session',
          JSON.stringify({ ...payload, workerSessionId: 'openkit-other-session' }),
          row.backend_workspace_handle_id
        );

      await expectCleanupRefusal(
        workspaceDb,
        cleanupInput(environmentPackage),
        'handoff is incomplete'
      );
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001').filter(
          (evidence) => evidence.phase === 'teardown'
        )
      ).toEqual([]);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });

  it.each(exactHandoffTamperCases)('rejects tampered %s', async (_description, tamper) => {
    const { environmentPackage, workspaceDb } = await createFixture();

    try {
      tamper(workspaceDb);
      await expectCleanupRefusal(
        workspaceDb,
        cleanupInput(environmentPackage),
        'handoff is incomplete'
      );
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001').filter(
          (evidence) => evidence.phase === 'teardown'
        )
      ).toEqual([]);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });
});
