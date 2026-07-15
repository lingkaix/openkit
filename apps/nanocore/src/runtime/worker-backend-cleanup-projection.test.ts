import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { recordTestAgentEnvironmentPackage } from '../test-support/agent-environment.js';
import {
  listWorkspaceRuntimeEvidence,
  recordWorkerBackendTeardownEvidence,
} from './runtime-evidence.js';
import { projectWorkerBackendCleanup } from './worker-backend-cleanup-projection.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './workspace-materializer.js';
import {
  listBackendWorkspaceHandles,
  recordWorkspaceInputSnapshots,
  recordWorkspaceMaterializationRecords,
  updateBackendWorkspaceHandleCleanupStatus,
} from './workspace-sync-records.js';

/** Creates one workspace database with a retained package handle. */
function createFixture() {
  const workspaceDb = openWorkspaceDb(
    mkdtempSync(join(tmpdir(), 'openkit-cleanup-projection-')),
    'user_owner',
    'ws_demo'
  );
  applyScopedMigrations(workspaceDb);
  const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
    suffix: 'cleanup_projection',
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
        backendStatus: { health: 'ready', version: '0.0.80' },
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

/** Returns the canonical successful cleanup projection input. */
function cleanupInput(environmentPackage: ReturnType<typeof recordTestAgentEnvironmentPackage>) {
  return {
    agentSessionId: 'as_cleanup_projection',
    backendType: 'openshell',
    backendVersion: '0.0.80',
    completedAt: '2026-07-15T00:01:00.000Z',
    outcome: 'succeeded' as const,
    backendSessionId: 'openkit-as_cleanup_projection',
    environmentPackage,
    packageSnapshotId: 'aepsnap_turn_cleanup_projection_as_cleanup_projection',
    placement: 'local' as const,
    threadId: 'thread_cleanup_projection',
    turnId: 'turn_cleanup_projection',
    workerImage: 'openkit/worker-codex:dev',
    workspaceHandoffState: 'complete' as const,
    workspaceId: 'ws_demo',
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
        workspaceId: 'ws_tampered',
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
];

describe('worker backend cleanup projection', () => {
  it('projects successful physical cleanup over a retained transport status', () => {
    const { environmentPackage, workspaceDb } = createFixture();

    try {
      updateBackendWorkspaceHandleCleanupStatus(
        workspaceDb,
        'ws_demo',
        environmentPackage.snapshotId,
        'retained',
        '2026-07-15T00:00:30.000Z'
      );
      expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          cleanupStatus: 'retained',
          updatedAt: '2026-07-15T00:00:30.000Z',
        }),
      ]);

      expect(
        projectWorkerBackendCleanup(workspaceDb, cleanupInput(environmentPackage))
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
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toHaveLength(1);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rolls back handle updates when teardown evidence conflicts, then retries atomically', () => {
    const { environmentPackage, workspaceDb } = createFixture();

    try {
      recordWorkerBackendTeardownEvidence(workspaceDb, {
        ...cleanupInput(environmentPackage),
        completedAt: '2026-07-15T00:00:30.000Z',
      });

      expect(() =>
        projectWorkerBackendCleanup(workspaceDb, cleanupInput(environmentPackage))
      ).toThrow(/runtime evidence replay conflict/i);
      expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({ cleanupStatus: 'pending' }),
      ]);

      workspaceDb.sqlite.prepare('DELETE FROM runtime_evidence').run();
      expect(
        projectWorkerBackendCleanup(workspaceDb, cleanupInput(environmentPackage))
      ).toMatchObject({
        evidence: { outcome: 'succeeded', phase: 'teardown' },
        handles: [expect.objectContaining({ cleanupStatus: 'cleaned' })],
      });
      expect(
        projectWorkerBackendCleanup(workspaceDb, cleanupInput(environmentPackage))
      ).toMatchObject({
        evidence: { outcome: 'succeeded', phase: 'teardown' },
        handles: [expect.objectContaining({ cleanupStatus: 'cleaned' })],
      });
      expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({ cleanupStatus: 'cleaned' }),
      ]);
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toHaveLength(1);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('projects evidence without handles only while the durable handoff is pending', () => {
    const { environmentPackage, workspaceDb } = createFixture();

    try {
      workspaceDb.sqlite.prepare('DELETE FROM backend_workspace_handles').run();
      workspaceDb.sqlite.prepare('DELETE FROM workspace_materialization_records').run();

      expect(
        projectWorkerBackendCleanup(workspaceDb, {
          ...cleanupInput(environmentPackage),
          workspaceHandoffState: 'pending',
        })
      ).toMatchObject({ handles: [], workspaceHandoffComplete: false });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects a missing handoff after Core marked it complete', () => {
    const { environmentPackage, workspaceDb } = createFixture();

    try {
      workspaceDb.sqlite.prepare('DELETE FROM backend_workspace_handles').run();
      workspaceDb.sqlite.prepare('DELETE FROM workspace_materialization_records').run();

      expect(() =>
        projectWorkerBackendCleanup(workspaceDb, cleanupInput(environmentPackage))
      ).toThrow('handoff is incomplete');
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (evidence) => evidence.phase === 'teardown'
        )
      ).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects and rolls back a pending partial handoff', () => {
    const { environmentPackage, workspaceDb } = createFixture();

    try {
      workspaceDb.sqlite.prepare('DELETE FROM backend_workspace_handles').run();

      expect(() =>
        projectWorkerBackendCleanup(workspaceDb, {
          ...cleanupInput(environmentPackage),
          workspaceHandoffState: 'pending',
        })
      ).toThrow('handoff is incomplete');
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (evidence) => evidence.phase === 'teardown'
        )
      ).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects a tampered physical worker-session join inside the projection transaction', () => {
    const { environmentPackage, workspaceDb } = createFixture();

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

      expect(() =>
        projectWorkerBackendCleanup(workspaceDb, cleanupInput(environmentPackage))
      ).toThrow('handoff is incomplete');
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (evidence) => evidence.phase === 'teardown'
        )
      ).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it.each(exactHandoffTamperCases)('rejects tampered %s', (_description, tamper) => {
    const { environmentPackage, workspaceDb } = createFixture();

    try {
      tamper(workspaceDb);
      expect(() =>
        projectWorkerBackendCleanup(workspaceDb, cleanupInput(environmentPackage))
      ).toThrow('handoff is incomplete');
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (evidence) => evidence.phase === 'teardown'
        )
      ).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
