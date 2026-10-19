// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
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

import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { KnowledgeBaseIdSchema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { parseJsoncObject } from '../config/jsonc.js';
import {
  initializeDefaultKnowledgeBaseId,
  readDefaultKnowledgeBaseId,
} from '../config/knowledge-base.js';
import { DEFAULT_NOTEBOOK_INDEX, KnowledgeNotebook } from '../knowledge/notebook.js';
import { AgentEnvironmentSnapshotReadError } from '../runtime/aep-snapshot-ledger.js';
import { recordTestAgentEnvironmentPackage } from '../test-support/agent-environment.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { inventoryRegularFiles, verifyDataRootBackupManifest } from './data-root-backup.js';
import { type CoreDb, openWorkspaceDbAtRoot } from './db.js';
import { resolveDataRootPath } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import * as schema from './schema/index.js';
import {
  migrateWorkspaceStorage,
  preflightWorkspaceStorageMigration,
} from './workspace-storage-migration.js';

const timestamp = '2026-07-19T00:00:00.000Z';
const predecessorDeploymentId = 'dep_00000000-0000-73b2-b75c-097b4af22221';

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
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      null,
      2
    )}\n`
  );

  mkdirSync(join(workspaceRoot, 'config'), { recursive: true });
  writeFileSync(
    join(workspaceRoot, 'config', 'workspace.jsonc'),
    `${JSON.stringify({ schemaVersion: 1, workspace: { name: workspaceId, defaultAgentId: null } })}\n`
  );
  initializeDefaultKnowledgeBaseId({
    dataRoot,
    workspaceRoot,
    scope: { kind: 'workspace', workspaceId },
    knowledgeBaseId: testEntityId('kb', `storage-layout:${workspaceId}`),
  });

  // This fixture varies the outer storage layout, not the current Notebook content format.
  new KnowledgeNotebook({
    repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
  }).initialize({
    files: { 'index.md': DEFAULT_NOTEBOOK_INDEX },
    metadata: {
      summary: 'Storage-layout fixture',
      producer: { kind: 'user', id: ownerUserId },
      authority: { kind: 'direct', instructionReference: 'test-fixture:storage-layout' },
      changeRequest: { requestId: randomUUID(), inputDigest: `sha256:${'0'.repeat(64)}` },
      sourceReferences: [],
    },
  });
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
  const ownerUserId = 'usr_00000000-0000-7011-88df-c2b1e8466b6f';
  const workspaceId = 'ws_00000000-0000-7f1c-9858-74a73d4be08c';
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
        ('usr_00000000-0000-73d4-904a-d4c4b905df7c', 'Other', 'other@example.com', false, ?, ?, 'human')`
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

const INVALID_PREFLIGHT_CASES = [
  {
    code: 'duplicate_workspace_root',
    mutate(fixture: ReturnType<typeof createMigrationFixture>) {
      createOwnerNestedWorkspaceRoot(
        fixture.dataRoot,
        'usr_00000000-0000-73d4-904a-d4c4b905df7c',
        fixture.workspaceId
      );
    },
    name: 'duplicate workspace id',
  },
  {
    code: 'workspace_owner_mismatch',
    mutate(fixture: ReturnType<typeof createMigrationFixture>) {
      fixture.coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_members (
             workspace_id, user_id, status, invitation_id, joined_at,
             removed_at, revision, created_at, updated_at
           ) VALUES (?, 'usr_00000000-0000-73d4-904a-d4c4b905df7c', 'active', NULL, ?, NULL, 1, ?, ?)`
        )
        .run(
          fixture.workspaceId,
          new Date().toISOString(),
          new Date().toISOString(),
          new Date().toISOString()
        );
      fixture.coreDb.sqlite
        .prepare('UPDATE workspace_registry SET owner_user_id = ? WHERE workspace_id = ?')
        .run('usr_00000000-0000-73d4-904a-d4c4b905df7c', fixture.workspaceId);
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
             workspace_id, user_id, status, invitation_id, joined_at,
             removed_at, revision, created_at, updated_at
           ) VALUES ('../unsafe', ?, 'active', NULL, ?, NULL, 1, ?, ?)`
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
  it('refuses entropy failure before backup or staging publication and preserves the predecessor', () => {
    const fixture = createMigrationFixture();
    fixture.coreDb.sqlite.close();
    const backupParent = mkdtempSync(join(tmpdir(), 'openkit-workspace-storage-entropy-'));
    const backupRoot = join(backupParent, 'backup');
    const predecessor = inventoryRegularFiles(fixture.dataRoot);
    const entropy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('Backup identity entropy unavailable.');
    });
    try {
      expect(() =>
        migrateWorkspaceStorage({ backupRoot, dataRoot: fixture.dataRoot, now: () => timestamp })
      ).toThrow('Backup identity entropy unavailable.');
      expect(existsSync(backupRoot)).toBe(false);
      expect(inventoryRegularFiles(fixture.dataRoot)).toEqual(predecessor);
    } finally {
      entropy.mockRestore();
      rmSync(fixture.dataRoot, { recursive: true, force: true });
      rmSync(backupParent, { recursive: true, force: true });
    }
  });

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

  it('refuses a V1 AEP snapshot without changing the predecessor or publishing the target root', () => {
    const fixture = createMigrationFixture();
    const workspaceRoot = sourceWorkspaceRoot(fixture);
    const workspaceDb = openWorkspaceDbAtRoot({
      dataRoot: fixture.dataRoot,
      workspaceId: fixture.workspaceId,
      workspaceRoot,
    });
    let snapshotPath: string;
    try {
      applyScopedMigrations(workspaceDb);
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'unsupported-layout-aep',
        triggerActor: { kind: 'user', id: fixture.ownerUserId },
        workspaceInputIds: [],
      });
      snapshotPath = join(
        'runtime',
        'agent-sessions',
        environmentPackage.scope.agentSessionId,
        'aep-snapshots',
        `${environmentPackage.snapshotId}.json`
      );
    } finally {
      workspaceDb.sqlite.close();
    }
    const sourcePath = join(workspaceRoot, snapshotPath);
    const record = JSON.parse(readFileSync(sourcePath, 'utf8'));
    const snapshot = { ...record.snapshot, schemaVersion: 1 };
    const contentDigest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const predecessorBytes = `${JSON.stringify({ ...record, snapshot, contentDigest }, null, 2)}\n`;
    writeFileSync(sourcePath, predecessorBytes);
    const predecessorInventory = inventoryRegularFiles(workspaceRoot);
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-workspace-storage-retention-')),
      'backup'
    );
    fixture.coreDb.sqlite.close();

    let failure: unknown;
    try {
      migrateWorkspaceStorage({
        backupRoot,
        dataRoot: fixture.dataRoot,
        now: () => timestamp,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AgentEnvironmentSnapshotReadError);
    expect(failure).toMatchObject({
      cause: {
        issues: expect.arrayContaining([expect.objectContaining({ path: ['schemaVersion'] })]),
      },
    });
    expect(readFileSync(sourcePath, 'utf8')).toBe(predecessorBytes);
    expect(inventoryRegularFiles(workspaceRoot)).toEqual(predecessorInventory);
    verifyDataRootBackupManifest({ backupRoot });
    expect(
      readFileSync(
        join(
          backupRoot,
          'users',
          fixture.ownerUserId,
          'workspaces',
          fixture.workspaceId,
          snapshotPath
        ),
        'utf8'
      )
    ).toBe(predecessorBytes);
    expect(existsSync(join(fixture.dataRoot, 'workspaces'))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(fixture.dataRoot, 'server', 'layout.json'), 'utf8'))
    ).toMatchObject({ layoutVersion: 1 });
  });

  it('refuses invalid existing Workspace configuration before publication or source removal', () => {
    const fixture = createMigrationFixture();
    const sourceRoot = sourceWorkspaceRoot(fixture);
    const configPath = join(sourceRoot, 'config', 'workspace.jsonc');
    const config = WorkspaceConfigSchema.parse(parseJsoncObject(readFileSync(configPath, 'utf8')));
    writeFileSync(
      configPath,
      `${JSON.stringify({ ...config, workspace: { ...config.workspace, name: 17 } })}\n`
    );
    const invalidConfigBytes = readFileSync(configPath);
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-workspace-storage-invalid-config-')),
      'backup'
    );
    fixture.coreDb.sqlite.close();

    expect(() =>
      migrateWorkspaceStorage({ backupRoot, dataRoot: fixture.dataRoot, now: () => timestamp })
    ).toThrow();
    expect(existsSync(join(fixture.dataRoot, 'workspaces'))).toBe(false);
    expect(existsSync(sourceRoot)).toBe(true);
    expect(readFileSync(configPath)).toEqual(invalidConfigBytes);
  });

  it('publishes two Workspaces as one root and retains one verified external predecessor backup', () => {
    const fixture = createMigrationFixture();
    const secondWorkspaceId = 'ws_00000000-0000-768f-80f6-8bbf108cc9a9';
    const firstSourceRoot = sourceWorkspaceRoot(fixture);
    const secondSourceRoot = addRegisteredWorkspace(
      fixture,
      'usr_00000000-0000-73d4-904a-d4c4b905df7c',
      secondWorkspaceId
    );
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-workspace-storage-retention-')),
      'backup'
    );

    const sourceConfigurations = [
      { workspaceId: fixture.workspaceId, sourceRoot: firstSourceRoot },
      { workspaceId: secondWorkspaceId, sourceRoot: secondSourceRoot },
    ].map(({ workspaceId, sourceRoot }) => {
      const bytes = readFileSync(join(sourceRoot, 'config', 'workspace.jsonc'));
      const config = WorkspaceConfigSchema.parse(parseJsoncObject(bytes.toString('utf8')));
      return {
        workspaceId,
        bytes,
        knowledgeBaseId: KnowledgeBaseIdSchema.parse(config.workspace.defaultKnowledgeBaseId),
      };
    });
    expect(sourceConfigurations[0]!.knowledgeBaseId).not.toBe(
      sourceConfigurations[1]!.knowledgeBaseId
    );
    writeFileSync(join(firstSourceRoot, 'files', 'first.txt'), 'first\n');
    writeFileSync(join(secondSourceRoot, 'files', 'second.txt'), 'second\n');
    fixture.coreDb.sqlite.close();

    const result = migrateWorkspaceStorage({
      backupRoot,
      dataRoot: fixture.dataRoot,
      now: () => timestamp,
    });

    for (const source of sourceConfigurations) {
      expect(
        readFileSync(
          join(fixture.dataRoot, 'workspaces', source.workspaceId, 'config', 'workspace.jsonc')
        )
      ).toEqual(source.bytes);
      expect(
        readDefaultKnowledgeBaseId({
          dataRoot: fixture.dataRoot,
          scope: { kind: 'workspace', workspaceId: source.workspaceId },
        })
      ).toBe(source.knowledgeBaseId);
    }
    const verifiedBackup = verifyDataRootBackupManifest({ backupRoot });
    expect(result.backupId).toMatch(
      /^drb_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(verifiedBackup.manifest.id).toBe(result.backupId);
    expect(verifiedBackup.manifest.sourceDeploymentId).toBe(predecessorDeploymentId);
    expect(verifiedBackup.manifest.backupStartedAt).toBe(timestamp);
    expect(verifiedBackup.manifest.backupCompletedAt).toBe(timestamp);
    expect(verifiedBackup.checkedFiles).toEqual(
      expect.arrayContaining([
        'users/usr_00000000-0000-7011-88df-c2b1e8466b6f/workspaces/ws_00000000-0000-7f1c-9858-74a73d4be08c/db/workspace.sqlite',
        'users/usr_00000000-0000-7011-88df-c2b1e8466b6f/workspaces/ws_00000000-0000-7f1c-9858-74a73d4be08c/files/first.txt',
        'users/usr_00000000-0000-73d4-904a-d4c4b905df7c/workspaces/ws_00000000-0000-768f-80f6-8bbf108cc9a9/db/workspace.sqlite',
        'users/usr_00000000-0000-73d4-904a-d4c4b905df7c/workspaces/ws_00000000-0000-768f-80f6-8bbf108cc9a9/files/second.txt',
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
      backup: { id: result.backupId },
    });
    expect(reportText).toContain(verifiedBackup.manifest.id);
    expect(reportText).toContain(
      'users/usr_00000000-0000-7011-88df-c2b1e8466b6f/workspaces/ws_00000000-0000-7f1c-9858-74a73d4be08c'
    );
    expect(reportText).toContain('workspaces/ws_00000000-0000-7f1c-9858-74a73d4be08c');
    expect(reportText).toContain(
      'users/usr_00000000-0000-73d4-904a-d4c4b905df7c/workspaces/ws_00000000-0000-768f-80f6-8bbf108cc9a9'
    );
    expect(reportText).toContain('workspaces/ws_00000000-0000-768f-80f6-8bbf108cc9a9');
    expect(reportText).toMatch(/sha256:[a-f0-9]{64}/);
  });

  it('rebuilds a current derived index set while migrating a Workspace', () => {
    const fixture = createMigrationFixture();
    const seededAt = '1999-01-01T00:00:00.000Z';
    const indexesRoot = join(sourceWorkspaceRoot(fixture), 'indexes');
    mkdirSync(indexesRoot);
    const header = {
      schemaVersion: 1,
      workspaceId: fixture.workspaceId,
      rebuiltAt: seededAt,
    };
    const seeded = {
      'search.json': { ...header, items: [] },
      'knowledge-links.json': { ...header, edges: [] },
      'knowledge-validation.json': { ...header, records: [] },
      'knowledge-source-refs.json': { ...header, references: [] },
      'knowledge-fts.json': { ...header, tokenizer: 'unicode-simple-v1', terms: [] },
    };
    for (const [name, value] of Object.entries(seeded)) {
      writeFileSync(join(indexesRoot, name), `${JSON.stringify(value, null, 2)}\n`);
    }
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

    const publishedRoot = join(fixture.dataRoot, 'workspaces', fixture.workspaceId, 'indexes');
    const expectedFiles = [
      'knowledge-links.json',
      'knowledge-source-refs.json',
      'knowledge-validation.json',
    ];
    expect(readdirSync(publishedRoot).sort()).toEqual(expectedFiles);
    for (const name of expectedFiles) {
      const published = JSON.parse(readFileSync(join(publishedRoot, name), 'utf8')) as {
        rebuiltAt: string;
        schemaVersion: number;
        workspaceId: string;
      };
      expect(published).toMatchObject({
        rebuiltAt: timestamp,
        schemaVersion: 1,
        workspaceId: fixture.workspaceId,
      });
      expect(published.rebuiltAt).not.toBe(seededAt);
    }
    expect(existsSync(join(publishedRoot, 'search.json'))).toBe(false);
    expect(existsSync(join(publishedRoot, 'knowledge-fts.json'))).toBe(false);
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
