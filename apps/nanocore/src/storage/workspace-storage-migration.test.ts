// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import { recordTestAgentEnvironmentPackage } from '../test-support/agent-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { verifyDataRootBackupManifest } from './data-root-backup.js';
import { type CoreDb, openWorkspaceDbAtRoot } from './db.js';
import { resolveDataRootPath } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import * as schema from './schema/index.js';
import {
  migrateWorkspaceStorage,
  preflightWorkspaceStorageMigration,
} from './workspace-storage-migration.js';

const timestamp = '2026-07-19T00:00:00.000Z';
const predecessorDeploymentId = 'dep_workspace_storage_v1';

/** Isolated predecessor-layout fixture used by storage migration tests. */
interface MigrationFixture {
  /** Open predecessor Core database. */
  readonly coreDb: CoreDb;
  /** Predecessor data root. */
  readonly dataRoot: string;
  /** Primary Workspace owner. */
  readonly ownerUserId: string;
  /** Primary Workspace id. */
  readonly workspaceId: string;
}

/** Captured identity for one migration-only legacy AEP fixture. */
interface LegacyAepSnapshotFixture {
  /** Predecessor V1 snapshot-record content digest. */
  readonly predecessorContentDigest: string;
  /** Snapshot file path relative to its Workspace root. */
  readonly relativePath: string;
  /** Expected V2 trigger actor. */
  readonly triggerActor:
    | { readonly id: string; readonly kind: 'user' }
    | {
        readonly id: string;
        readonly kind: 'automation';
        readonly responsibleUserId: string | null;
      };
}

/**
 * Creates one owner-nested Workspace root without invoking current layout openers.
 *
 * @param dataRoot Predecessor data root.
 * @param ownerUserId Physical owner directory.
 * @param workspaceId Workspace id.
 * @returns Absolute predecessor Workspace root.
 */
function createOwnerNestedWorkspaceRoot(
  dataRoot: string,
  ownerUserId: string,
  workspaceId: string
): string {
  const workspaceRoot = resolveDataRootPath(
    dataRoot,
    'users',
    ownerUserId,
    'workspaces',
    workspaceId
  );

  mkdirSync(join(workspaceRoot, 'db'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'files'), { recursive: true });
  const workspaceDb = new Database(join(workspaceRoot, 'db', 'workspace.sqlite'));
  workspaceDb.close();
  writeFileSync(
    join(workspaceRoot, 'workspace.json'),
    `${JSON.stringify(
      {
        id: workspaceId,
        name: workspaceId,
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      null,
      2
    )}\n`
  );

  return workspaceRoot;
}

/**
 * Adds one registered predecessor Workspace and its active owner membership.
 *
 * @param fixture Existing predecessor fixture.
 * @param ownerUserId Workspace owner.
 * @param workspaceId Workspace id.
 * @returns Absolute predecessor Workspace root.
 */
function addRegisteredWorkspace(
  fixture: Pick<MigrationFixture, 'coreDb' | 'dataRoot'>,
  ownerUserId: string,
  workspaceId: string
): string {
  const workspaceRoot = createOwnerNestedWorkspaceRoot(fixture.dataRoot, ownerUserId, workspaceId);

  recordWorkspaceOwnerMembership({
    coreDb: fixture.coreDb,
    now: new Date(timestamp),
    ownerUserId,
    workspaceId,
  });

  return workspaceRoot;
}

/**
 * Creates one valid owner-nested Workspace migration source.
 *
 * @returns Isolated migration fixture with open Core database.
 */
function createMigrationFixture(): MigrationFixture {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-storage-migration-'));
  const ownerUserId = 'user_owner';
  const workspaceId = 'ws_migration';
  const now = Date.now();

  mkdirSync(join(dataRoot, 'server', 'db'), { recursive: true });
  mkdirSync(join(dataRoot, 'server', 'migrations'), { recursive: true });
  mkdirSync(join(dataRoot, 'users'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'server', 'layout.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        layoutVersion: 1,
        deploymentId: predecessorDeploymentId,
      },
      null,
      2
    )}\n`
  );

  const sqlite = new Database(join(dataRoot, 'server', 'db', 'core.sqlite'));
  const coreDb: CoreDb = {
    scope: 'core',
    sqlite,
    db: drizzle(sqlite, { schema }),
    dataRoot,
  };
  applyMigrations(coreDb);

  coreDb.sqlite
    .prepare(
      `INSERT INTO users (
        id,
        display_name,
        email,
        email_verified,
        created_at,
        updated_at,
        kind
      ) VALUES
        (?, 'Owner', 'owner@example.com', false, ?, ?, 'human'),
        ('user_other', 'Other', 'other@example.com', false, ?, ?, 'human')`
    )
    .run(ownerUserId, now, now, now, now);
  const fixture = { coreDb, dataRoot, ownerUserId, workspaceId };
  addRegisteredWorkspace(fixture, ownerUserId, workspaceId);

  return fixture;
}

/**
 * Returns one owner-nested Workspace root without creating it.
 *
 * @param fixture Migration fixture.
 * @returns Absolute source Workspace root.
 */
function sourceWorkspaceRoot(fixture: ReturnType<typeof createMigrationFixture>): string {
  return resolveDataRootPath(
    fixture.dataRoot,
    'users',
    fixture.ownerUserId,
    'workspaces',
    fixture.workspaceId
  );
}

/**
 * Records one valid V2 AEP fixture, then rewrites it into the migration-only V1 input shape.
 *
 * @param fixture Existing predecessor-layout fixture.
 * @param suffix Stable package lineage suffix.
 * @param automationId Optional legacy automation identity.
 * @param userId Optional legacy responsible or triggering user.
 * @returns Legacy record identity and expected V2 actor.
 */
function writeLegacyAepSnapshot(
  fixture: MigrationFixture,
  suffix: string,
  automationId: string | null,
  userId: string | null
): LegacyAepSnapshotFixture {
  const workspaceRoot = sourceWorkspaceRoot(fixture);
  const workspaceDb = openWorkspaceDbAtRoot({
    dataRoot: fixture.dataRoot,
    workspaceId: fixture.workspaceId,
    workspaceRoot,
  });

  try {
    applyScopedMigrations(workspaceDb);
    const triggerActor = automationId
      ? ({ kind: 'automation', id: automationId, responsibleUserId: userId } as const)
      : ({ kind: 'user', id: userId! } as const);
    const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
      suffix,
      triggerActor,
      workspaceInputIds: [],
    });
    const threadRoot = join(workspaceRoot, 'threads', environmentPackage.scope.threadId);
    mkdirSync(join(threadRoot, 'turns'), { recursive: true });
    writeFileSync(
      join(threadRoot, 'thread.json'),
      `${JSON.stringify(
        {
          id: environmentPackage.scope.threadId,
          workspaceId: fixture.workspaceId,
          name: suffix,
          preview: suffix,
          status: 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        null,
        2
      )}\n`
    );
    writeFileSync(
      join(
        workspaceRoot,
        'runtime',
        'agent-sessions',
        environmentPackage.scope.agentSessionId,
        'session.json'
      ),
      `${JSON.stringify(
        {
          id: environmentPackage.scope.agentSessionId,
          agentId: environmentPackage.agent.agentId,
          workspaceId: fixture.workspaceId,
          threadId: environmentPackage.scope.threadId,
          status: 'closed',
          message: null,
          sandboxSummary: null,
          configVersion: null,
          environmentPackageSnapshotId: environmentPackage.snapshotId,
          policySnapshotId: null,
          sessionCompatibilityKey: null,
          stale: false,
          workspaceRoots: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        null,
        2
      )}\n`
    );
    const relativePath = join(
      'runtime',
      'agent-sessions',
      environmentPackage.scope.agentSessionId,
      'aep-snapshots',
      `${environmentPackage.snapshotId}.json`
    );
    const path = join(workspaceRoot, relativePath);
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & {
      snapshot: Record<string, unknown> & { scope: Record<string, unknown> };
    };
    const legacyScope = {
      ...record.snapshot.scope,
      automationId,
      organizationId: null,
      userId,
    };
    delete legacyScope.triggerActor;
    const legacySnapshot = { ...record.snapshot, schemaVersion: 1, scope: legacyScope };
    const predecessorContentDigest = createHash('sha256')
      .update(JSON.stringify(legacySnapshot))
      .digest('hex');

    writeFileSync(
      path,
      `${JSON.stringify(
        { ...record, contentDigest: predecessorContentDigest, snapshot: legacySnapshot },
        null,
        2
      )}\n`
    );

    return { predecessorContentDigest, relativePath, triggerActor };
  } finally {
    workspaceDb.sqlite.close();
  }
}

const INVALID_PREFLIGHT_CASES = [
  {
    code: 'duplicate_workspace_root',
    mutate(fixture: ReturnType<typeof createMigrationFixture>) {
      createOwnerNestedWorkspaceRoot(fixture.dataRoot, 'user_other', fixture.workspaceId);
    },
    name: 'duplicate workspace id',
  },
  {
    code: 'workspace_owner_mismatch',
    mutate(fixture: ReturnType<typeof createMigrationFixture>) {
      fixture.coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_members (
             workspace_id, user_id, status, access_level, invitation_id, joined_at,
             removed_at, revision, created_at, updated_at
           ) VALUES (?, 'user_other', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
        )
        .run(
          fixture.workspaceId,
          new Date().toISOString(),
          new Date().toISOString(),
          new Date().toISOString()
        );
      fixture.coreDb.sqlite
        .prepare('UPDATE workspace_registry SET owner_user_id = ? WHERE workspace_id = ?')
        .run('user_other', fixture.workspaceId);
    },
    name: 'registry and physical owner mismatch',
  },
  {
    code: 'workspace_owner_missing',
    mutate(fixture: ReturnType<typeof createMigrationFixture>) {
      fixture.coreDb.sqlite.pragma('foreign_keys = OFF');
      fixture.coreDb.sqlite.prepare('DELETE FROM users WHERE id = ?').run(fixture.ownerUserId);
    },
    name: 'registry owner missing from Core users',
  },
  {
    code: 'workspace_registry_missing',
    mutate(fixture: ReturnType<typeof createMigrationFixture>) {
      fixture.coreDb.sqlite
        .prepare('DELETE FROM workspace_registry WHERE workspace_id = ?')
        .run(fixture.workspaceId);
    },
    name: 'physical workspace without registry owner',
  },
  {
    code: 'owner_membership_missing',
    mutate(fixture: ReturnType<typeof createMigrationFixture>) {
      fixture.coreDb.sqlite.exec('DROP TRIGGER workspace_owner_member_delete_guard');
      fixture.coreDb.sqlite
        .prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .run(fixture.workspaceId, fixture.ownerUserId);
    },
    name: 'missing owner membership',
  },
  {
    code: 'unsafe_workspace_root',
    mutate(fixture: ReturnType<typeof createMigrationFixture>) {
      const sourceRoot = sourceWorkspaceRoot(fixture);
      const outsideRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-storage-outside-'));
      rmSync(sourceRoot, { force: true, recursive: true });
      symlinkSync(outsideRoot, sourceRoot, 'dir');
    },
    name: 'symlinked workspace root',
  },
  {
    code: 'unsafe_workspace_root',
    mutate(fixture: ReturnType<typeof createMigrationFixture>) {
      const outsideFile = join(
        mkdtempSync(join(tmpdir(), 'openkit-workspace-storage-outside-')),
        'outside.txt'
      );
      writeFileSync(outsideFile, 'outside\n');
      symlinkSync(outsideFile, join(sourceWorkspaceRoot(fixture), 'files', 'linked.txt'));
    },
    name: 'symlinked workspace descendant',
  },
  {
    code: 'unsafe_workspace_id',
    mutate(fixture: ReturnType<typeof createMigrationFixture>) {
      const now = new Date().toISOString();
      fixture.coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_registry (
            workspace_id,
            owner_user_id,
            status,
            created_at,
            updated_at
          ) VALUES ('../unsafe', ?, 'active', ?, ?)`
        )
        .run(fixture.ownerUserId, now, now);
      fixture.coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_members (
             workspace_id, user_id, status, access_level, invitation_id, joined_at,
             removed_at, revision, created_at, updated_at
           ) VALUES ('../unsafe', ?, 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
        )
        .run(fixture.ownerUserId, now, now, now);
    },
    name: 'unsafe registry workspace id',
  },
  {
    code: 'workspace_database_corrupt',
    mutate(fixture: ReturnType<typeof createMigrationFixture>) {
      writeFileSync(
        join(sourceWorkspaceRoot(fixture), 'db', 'workspace.sqlite'),
        'not a sqlite database'
      );
    },
    name: 'corrupt authoritative workspace database',
  },
  {
    code: 'mixed_workspace_layout',
    mutate(fixture: ReturnType<typeof createMigrationFixture>) {
      mkdirSync(resolveDataRootPath(fixture.dataRoot, 'workspaces', fixture.workspaceId), {
        recursive: true,
      });
    },
    name: 'owner-nested and top-level roots together',
  },
] as const;

describe('workspace storage migration preflight', () => {
  it('accepts one complete owner-nested source layout', () => {
    const fixture = createMigrationFixture();

    try {
      expect(
        preflightWorkspaceStorageMigration({
          coreDb: fixture.coreDb,
          dataRoot: fixture.dataRoot,
        })
      ).toEqual({ diagnostics: [], workspaceCount: 1 });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it.each(INVALID_PREFLIGHT_CASES)('rejects $name', ({ code, mutate }) => {
    const fixture = createMigrationFixture();

    try {
      mutate(fixture);
      const result = preflightWorkspaceStorageMigration({
        coreDb: fixture.coreDb,
        dataRoot: fixture.dataRoot,
      });

      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });
});

describe('workspace storage migration', () => {
  it('refuses to overwrite an existing external backup destination', () => {
    const fixture = createMigrationFixture();
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-workspace-storage-retention-')),
      'backup'
    );
    const sentinelPath = join(backupRoot, 'retain.txt');

    mkdirSync(backupRoot);
    writeFileSync(sentinelPath, 'retain\n');
    fixture.coreDb.sqlite.close();

    expect(() =>
      migrateWorkspaceStorage({
        backupRoot,
        dataRoot: fixture.dataRoot,
        now: () => timestamp,
      })
    ).toThrow(/backup.*must not already exist/i);
    expect(readFileSync(sentinelPath, 'utf8')).toBe('retain\n');
    expect(
      JSON.parse(readFileSync(join(fixture.dataRoot, 'server', 'layout.json'), 'utf8'))
    ).toMatchObject({ layoutVersion: 1 });
  });

  it('rejects a copied backup that differs from the captured complete predecessor inventory', () => {
    const fixture = createMigrationFixture();
    const serverFile = join(fixture.dataRoot, 'server', 'migration-source.txt');
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-workspace-storage-retention-')),
      'backup'
    );
    let clockReads = 0;

    writeFileSync(serverFile, 'captured\n');
    fixture.coreDb.sqlite.close();

    expect(() =>
      migrateWorkspaceStorage({
        backupRoot,
        dataRoot: fixture.dataRoot,
        now: () => {
          clockReads += 1;
          if (clockReads === 2) {
            writeFileSync(serverFile, 'changed-before-copy\n');
          }
          return timestamp;
        },
      })
    ).toThrow(/backup.*predecessor.*inventory/i);
    expect(verifyDataRootBackupManifest({ backupRoot }).checkedFiles).toContain(
      'server/migration-source.txt'
    );
    expect(existsSync(join(fixture.dataRoot, 'workspaces'))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(fixture.dataRoot, 'server', 'layout.json'), 'utf8'))
    ).toMatchObject({ layoutVersion: 1 });
  });

  it('transforms every staged V1 AEP snapshot into the strict V3 runtime and actor shape', () => {
    const fixture = createMigrationFixture();
    const userSnapshot = writeLegacyAepSnapshot(
      fixture,
      'migration_user',
      null,
      fixture.ownerUserId
    );
    const automationSnapshot = writeLegacyAepSnapshot(
      fixture,
      'migration_automation',
      'automation_migration',
      fixture.ownerUserId
    );
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-workspace-storage-retention-')),
      'backup'
    );
    fixture.coreDb.sqlite.close();

    migrateWorkspaceStorage({
      backupRoot,
      dataRoot: fixture.dataRoot,
      now: () => timestamp,
    });

    const successorDigests: string[] = [];
    for (const legacy of [userSnapshot, automationSnapshot]) {
      const record = JSON.parse(
        readFileSync(
          join(fixture.dataRoot, 'workspaces', fixture.workspaceId, legacy.relativePath),
          'utf8'
        )
      ) as Record<string, unknown> & {
        contentDigest: string;
        snapshot: Record<string, unknown> & { scope: Record<string, unknown> };
      };
      const snapshot = AgentEnvironmentPackageSchema.parse(record.snapshot);
      const successorDigest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      successorDigests.push(successorDigest);

      expect(snapshot.schemaVersion).toBe(3);
      expect(snapshot.runtime.image).toEqual({
        kind: 'reference',
        pullPolicy: 'if-not-present',
        ref: 'openkit/worker-codex:dev',
      });
      expect(snapshot.control).toMatchObject({
        mode: 'sandbox-integration',
        bindings: {
          capabilities: {
            pathPrefix: '/capabilities/',
            tokenRef: 'runtime://openkit/capability-token',
          },
          inference: {
            pathPrefix: '/inference/',
            tokenRef: 'runtime://openkit/inference-token',
          },
          workerControl: {
            pathPrefix: '/worker-control/',
            tokenRef: 'runtime://openkit/worker-control-token',
          },
        },
      });
      expect(snapshot.control).not.toHaveProperty('endpoint');
      expect(snapshot.control).not.toHaveProperty('auth');
      expect(
        AgentEnvironmentPackageSchema.safeParse({ ...snapshot, schemaVersion: 2 }).success
      ).toBe(false);
      expect(snapshot.scope.triggerActor).toEqual(legacy.triggerActor);
      expect(snapshot.scope).not.toHaveProperty('userId');
      expect(snapshot.scope).not.toHaveProperty('automationId');
      expect(snapshot.scope).not.toHaveProperty('organizationId');
      expect(record.contentDigest).toBe(successorDigest);
    }

    const reportFile = readdirSync(join(fixture.dataRoot, 'server', 'migrations')).find((name) =>
      name.endsWith('.json')
    );
    const reportText = readFileSync(
      join(fixture.dataRoot, 'server', 'migrations', reportFile!),
      'utf8'
    );
    for (const digest of [
      userSnapshot.predecessorContentDigest,
      automationSnapshot.predecessorContentDigest,
      ...successorDigests,
    ]) {
      expect(reportText).toContain(digest);
    }
  });

  it('publishes two Workspaces as one root and retains one verified external predecessor backup', () => {
    const fixture = createMigrationFixture();
    const secondWorkspaceId = 'ws_second';
    const firstSourceRoot = sourceWorkspaceRoot(fixture);
    const secondSourceRoot = addRegisteredWorkspace(fixture, 'user_other', secondWorkspaceId);
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-workspace-storage-retention-')),
      'backup'
    );

    writeFileSync(join(firstSourceRoot, 'files', 'first.txt'), 'first\n');
    writeFileSync(join(secondSourceRoot, 'files', 'second.txt'), 'second\n');
    fixture.coreDb.sqlite.close();

    migrateWorkspaceStorage({
      backupRoot,
      dataRoot: fixture.dataRoot,
      now: () => timestamp,
    });

    const verifiedBackup = verifyDataRootBackupManifest({ backupRoot });
    expect(verifiedBackup.checkedFiles).toEqual(
      expect.arrayContaining([
        'users/user_owner/workspaces/ws_migration/db/workspace.sqlite',
        'users/user_owner/workspaces/ws_migration/files/first.txt',
        'users/user_other/workspaces/ws_second/db/workspace.sqlite',
        'users/user_other/workspaces/ws_second/files/second.txt',
      ])
    );
    expect(existsSync(firstSourceRoot)).toBe(false);
    expect(existsSync(secondSourceRoot)).toBe(false);
    expect(
      readFileSync(
        join(fixture.dataRoot, 'workspaces', fixture.workspaceId, 'files', 'first.txt'),
        'utf8'
      )
    ).toBe('first\n');
    expect(
      readFileSync(
        join(fixture.dataRoot, 'workspaces', secondWorkspaceId, 'files', 'second.txt'),
        'utf8'
      )
    ).toBe('second\n');
    expect(
      JSON.parse(readFileSync(join(fixture.dataRoot, 'server', 'layout.json'), 'utf8'))
    ).toMatchObject({
      schemaVersion: 1,
      layoutVersion: 2,
      deploymentId: predecessorDeploymentId,
    });

    const migrationReportFiles = readdirSync(join(fixture.dataRoot, 'server', 'migrations')).filter(
      (name) => name.endsWith('.json')
    );
    expect(migrationReportFiles).toHaveLength(1);
    const report = JSON.parse(
      readFileSync(join(fixture.dataRoot, 'server', 'migrations', migrationReportFiles[0]!), 'utf8')
    ) as Record<string, unknown>;
    const reportText = JSON.stringify(report);

    expect(report).toMatchObject({
      outcome: 'succeeded',
      sourceLayoutVersion: 1,
      targetLayoutVersion: 2,
    });
    expect(reportText).toContain(verifiedBackup.manifest.id);
    expect(reportText).toContain('users/user_owner/workspaces/ws_migration');
    expect(reportText).toContain('workspaces/ws_migration');
    expect(reportText).toContain('users/user_other/workspaces/ws_second');
    expect(reportText).toContain('workspaces/ws_second');
    expect(reportText).toMatch(/sha256:[a-f0-9]{64}/);
  });

  it('fails closed when a published top-level root still has the v1 marker', () => {
    const fixture = createMigrationFixture();
    const sourceRoot = sourceWorkspaceRoot(fixture);
    const targetRoot = resolveDataRootPath(fixture.dataRoot, 'workspaces', fixture.workspaceId);
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-workspace-storage-retention-')),
      'backup'
    );

    mkdirSync(join(fixture.dataRoot, 'workspaces'), { recursive: true });
    cpSync(sourceRoot, targetRoot, { recursive: true });
    fixture.coreDb.sqlite.close();

    expect(() =>
      migrateWorkspaceStorage({
        backupRoot,
        dataRoot: fixture.dataRoot,
        now: () => timestamp,
      })
    ).toThrow(/mixed|published|layout/i);
    expect(existsSync(sourceRoot)).toBe(true);
    expect(existsSync(targetRoot)).toBe(true);
    expect(existsSync(backupRoot)).toBe(false);
    expect(
      JSON.parse(readFileSync(join(fixture.dataRoot, 'server', 'layout.json'), 'utf8'))
    ).toMatchObject({
      layoutVersion: 1,
    });
  });
});
