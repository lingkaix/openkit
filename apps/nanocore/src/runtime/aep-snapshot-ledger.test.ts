// openkit-test-platform: posix
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import {
  importAgentEnvironmentPackageSnapshots,
  listExportableAgentEnvironmentPackageSnapshots,
  recordAgentEnvironmentPackageSnapshot,
  requireAgentEnvironmentPackageSnapshot,
} from './aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';

/**
 * Creates one migrated workspace database for AEP snapshot ledger tests.
 *
 * @returns Open workspace database.
 */
function createWorkspaceDb() {
  const workspaceDb = openWorkspaceDb(
    mkdtempSync(join(tmpdir(), 'openkit-aep-snapshot-ledger-')),
    'ws_1'
  );
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Creates the safe redacted AEP fixture shared by ledger tests.
 *
 * @returns Parsed AEP without secret or host-path material.
 */
function createEnvironmentPackage(): AgentEnvironmentPackage {
  return AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
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
      agentSetup: createTestAgentSetup(),
      agentSessionId: 'as_1',
      triggerActor: { kind: 'user', id: 'user_local' },
      backend: {
        kind: 'openshell',
      },
      requestId: 'req_1',
      turn: {
        id: 'turn_1',
        workspaceId: 'ws_1',
        threadId: 'th_1',
        items: [],
        status: 'running',
        humanGate: null,
        error: null,
        configVersion: null,
        startedAt: '2026-07-06T00:00:00.000Z',
        completedAt: null,
        durationMs: null,
        triggerActor: { kind: 'user', id: 'user_local' },
      },
      turnInput: 'Run tests',
      workspaceCwd: '/workspace',
      workspaceRoots: [],
    })
  );
}

/**
 * Resolves the canonical AEP snapshot path from workspace database ownership metadata.
 *
 * @param workspaceDb Workspace database that owns the snapshot.
 * @param environmentPackage AEP whose session and snapshot ids name the file.
 * @returns Absolute canonical snapshot path.
 */
function snapshotPath(
  workspaceDb: WorkspaceDb,
  environmentPackage: AgentEnvironmentPackage
): string {
  return join(
    workspaceDb.dataRoot,
    'workspaces',
    workspaceDb.workspaceId,
    'runtime',
    'agent-sessions',
    environmentPackage.scope.agentSessionId,
    'aep-snapshots',
    `${environmentPackage.snapshotId}.json`
  );
}

describe('AEP snapshot ledger', () => {
  it('persists and reloads the redacted record from its canonical session path', () => {
    const workspaceDb = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();
    const path = snapshotPath(workspaceDb, environmentPackage);
    const record = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
      createdAt: '2026-07-06T00:00:01.000Z',
      environmentPackage,
    });

    expect.soft(existsSync(path)).toBe(true);
    expect.soft(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null).toEqual(record);
    expect(record).toMatchObject({
      snapshotId: environmentPackage.snapshotId,
      workspaceId: 'ws_1',
      turnId: 'turn_1',
      agentSessionId: 'as_1',
      agentId: 'agent_codex_host',
      packageId: environmentPackage.packageId,
    });
    expect(record.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record.snapshot)).not.toContain('sk-');

    const { dataRoot, workspaceId } = workspaceDb;
    workspaceDb.sqlite.close();
    const reopened = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(reopened);

    try {
      expect(
        requireAgentEnvironmentPackageSnapshot(reopened, 'ws_1', environmentPackage.snapshotId)
      ).toEqual(record);
      expect(listExportableAgentEnvironmentPackageSnapshots(reopened, 'ws_1')).toEqual([record]);
    } finally {
      reopened.sqlite.close();
    }
  });

  it('rejects V1 snapshots through every normal ledger path', () => {
    const workspaceDb = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();

    try {
      const record = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      const legacyScope = { ...record.snapshot.scope } as Record<string, unknown>;
      delete legacyScope.triggerActor;
      legacyScope.userId = 'user_local';
      const legacyRecord = {
        ...record,
        snapshot: { ...record.snapshot, schemaVersion: 1, scope: legacyScope },
      };
      writeFileSync(
        snapshotPath(workspaceDb, environmentPackage),
        `${JSON.stringify(legacyRecord)}\n`
      );

      expect(() =>
        requireAgentEnvironmentPackageSnapshot(workspaceDb, 'ws_1', environmentPackage.snapshotId)
      ).toThrow();
      expect(() => listExportableAgentEnvironmentPackageSnapshots(workspaceDb, 'ws_1')).toThrow();
      expect(() =>
        recordAgentEnvironmentPackageSnapshot(workspaceDb, {
          createdAt: '2026-07-06T00:00:02.000Z',
          environmentPackage: legacyRecord.snapshot as never,
        })
      ).toThrow();
      expect(() =>
        importAgentEnvironmentPackageSnapshots(workspaceDb, [legacyRecord as never])
      ).toThrow();
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('fails closed when canonical snapshot content, lineage, or digest is tampered', () => {
    const workspaceDb = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();

    try {
      const record = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      const path = snapshotPath(workspaceDb, environmentPackage);
      const tamperedRecords = [
        {
          ...record,
          snapshot: { ...record.snapshot, packageId: 'aep_tampered' },
        },
        { ...record, agentSessionId: 'as_tampered' },
        { ...record, contentDigest: '0'.repeat(64) },
      ];

      mkdirSync(dirname(path), { recursive: true });
      for (const tamperedRecord of tamperedRecords) {
        writeFileSync(path, `${JSON.stringify(tamperedRecord, null, 2)}\n`);

        expect
          .soft(() =>
            requireAgentEnvironmentPackageSnapshot(
              workspaceDb,
              'ws_1',
              environmentPackage.snapshotId
            )
          )
          .toThrow();
        expect
          .soft(() => listExportableAgentEnvironmentPackageSnapshots(workspaceDb, 'ws_1'))
          .toThrow();
      }
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects symbolic links for canonical snapshot and session entries', () => {
    const workspaceDb = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();

    try {
      const record = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      const path = snapshotPath(workspaceDb, environmentPackage);
      const linkedSnapshotTarget = `${path}.target`;

      writeFileSync(linkedSnapshotTarget, `${JSON.stringify(record, null, 2)}\n`);
      rmSync(path);
      symlinkSync(linkedSnapshotTarget, path);
      expect(() =>
        requireAgentEnvironmentPackageSnapshot(workspaceDb, 'ws_1', environmentPackage.snapshotId)
      ).toThrow();
      expect(() => listExportableAgentEnvironmentPackageSnapshots(workspaceDb, 'ws_1')).toThrow();

      const sessionRoot = dirname(dirname(path));
      const linkedSessionTarget = join(dirname(dirname(sessionRoot)), 'aep-session-symlink-target');

      rmSync(sessionRoot, { recursive: true, force: true });
      mkdirSync(join(linkedSessionTarget, 'aep-snapshots'), { recursive: true });
      writeFileSync(
        join(linkedSessionTarget, 'aep-snapshots', `${environmentPackage.snapshotId}.json`),
        `${JSON.stringify(record, null, 2)}\n`
      );
      symlinkSync(linkedSessionTarget, sessionRoot, 'dir');
      expect(() => listExportableAgentEnvironmentPackageSnapshots(workspaceDb, 'ws_1')).toThrow();
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('is idempotent for the same snapshot and rejects conflicting content for the same id', () => {
    const workspaceDb = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();

    try {
      const first = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      const replay = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-06T00:00:02.000Z',
        environmentPackage,
      });
      const conflictingPackage = AgentEnvironmentPackageSchema.parse({
        ...environmentPackage,
        scope: { ...environmentPackage.scope, requestId: 'req_conflict' },
      });

      expect(replay).toEqual(first);
      expect(() =>
        recordAgentEnvironmentPackageSnapshot(workspaceDb, {
          createdAt: '2026-07-06T00:00:03.000Z',
          environmentPackage: conflictingPackage,
        })
      ).toThrow();
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
