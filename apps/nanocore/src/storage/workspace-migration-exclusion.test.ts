// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { KnowledgeBaseIdSchema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  acquireDataRootLock,
  type DataRootLock,
  DataRootLockError,
  dataRootLockPath,
} from '../bootstrap/lock.js';
import { isScopeAdmitted } from '../bootstrap/readiness.js';
import { parseJsoncObject } from '../config/jsonc.js';
import {
  initializeDefaultKnowledgeBaseId,
  readDefaultKnowledgeBaseId,
} from '../config/knowledge-base.js';
import { DEFAULT_NOTEBOOK_INDEX, KnowledgeNotebook } from '../knowledge/notebook.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { notebookImportFixture } from '../test-support/notebook-import.js';
import { createTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { inventoryRegularFiles, verifyDataRootBackupManifest } from './data-root-backup.js';
import type { CoreDb, UserDb, WorkspaceDb } from './db.js';
import * as scopeDb from './db.js';
import {
  coreDbPath,
  readDataRootLayoutMarker,
  resolveDataRootPath,
  userDbPath,
  workspaceDbPath,
} from './fs-layout.js';
import * as migrationSql from './migrate.js';
import { applyMigrations } from './migrate.js';
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

/** Creates supported native authority before arranging its cold bytes as physical V1 input. */
async function createNativeLayoutSource(
  workspaceRoot: string,
  workspaceId: string,
  ownerUserId: string
): Promise<void> {
  const workspaceBytes = readFileSync(join(workspaceRoot, 'workspace.json'));
  const configBytes = readFileSync(join(workspaceRoot, 'config', 'workspace.jsonc'));
  const config = WorkspaceConfigSchema.parse(parseJsoncObject(configBytes.toString('utf8')));
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-native-layout-source-'));
  try {
    const store = createTestStore({ dataRoot });
    await store.importWorkspaceSnapshot({
      ...notebookImportFixture({ workspaceId, userId: ownerUserId, knowledge: [] }),
      workspace: JSON.parse(workspaceBytes.toString('utf8')),
      defaultKnowledgeBaseId: KnowledgeBaseIdSchema.parse(config.workspace.defaultKnowledgeBaseId),
      threads: [],
      turns: [],
      knowledge: [],
      itemRevisions: [],
      artifacts: [],
      agentSessions: [],
      turnEvents: [],
    });
    await shutdownControlStoreWorkerClient();
    rmSync(workspaceRoot, { recursive: true, force: true });
    cpSync(join(dataRoot, 'workspaces', workspaceId), workspaceRoot, { recursive: true });
    // Preserve V1 projection/configuration input; native authority already exists in the cold database.
    writeFileSync(join(workspaceRoot, 'workspace.json'), workspaceBytes);
    writeFileSync(join(workspaceRoot, 'config', 'workspace.jsonc'), configBytes);
  } finally {
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  }
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
    canInitializeLocalUser: false,
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

const migrationVerificationFailure =
  'Derived-index verification did not rebuild every migrated Workspace.';

/** Actual public-operation observations, not inferred acknowledgements. */
interface HandleObservation {
  readonly scope: CoreDb['scope'] | UserDb['scope'] | WorkspaceDb['scope'];
  readonly expectedPath: string;
  readonly actualPath: string;
  readonly device: string;
  readonly inode: string;
  readonly readonly: boolean;
  readonly queryOnly: number;
  readonly openOrder: number;
  readonly openedWhileContenderHeld: boolean;
  readonly kernelPeerRefusedWhileOpen?: boolean;
  readonly contenderBootIdWhileOpen?: string;
  openBeforeClose?: boolean;
  kernelPeerRefusedBeforeClose?: boolean;
  closeOrder?: number;
  openAfterClose?: boolean;
}

/** Independent ordinary-owner result at the successor/canonical-open crossing. */
interface LockObservation {
  readonly path: string;
  readonly refused: boolean;
  readonly ownerBootId: string;
  readonly directoryDevice: string;
  readonly directoryInode: string;
  readonly marker: ReturnType<typeof readDataRootLayoutMarker>;
  readonly markerSha256: string;
  readonly publicCallReturned: boolean;
  readonly activeOriginalStack: string;
  readonly operationSettled: boolean;
  readonly order: number;
  readonly acquisition?: DataRootLock['acquisition'];
  releasedOrder?: number;
}

/** Identifies the same actual file, never a logical-only database label. */
function physicalIdentity(path: string) {
  const metadata = statSync(path, { bigint: true });
  return { device: String(metadata.dev), inode: String(metadata.ino) };
}

/** Copies no product record: this only hashes existing fixture bytes. */
function digestFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Retains selected original business rows without treating migration ledgers as unchanged history. */
function retainedRows(path: string, tables: readonly string[]) {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    sqlite.pragma('query_only = ON');
    const selected = tables.length
      ? [...tables]
      : (
          sqlite
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
            .all() as Array<{ name: string }>
        ).map(({ name }) => name);
    return Object.fromEntries(
      selected.map((table) => [
        table,
        sqlite
          .prepare(`SELECT * FROM "${table}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      ])
    );
  } finally {
    sqlite.close();
  }
}

/** Calibrates the original kernel-backed API; diagnostic-file presence is not the oracle. */
function calibrateOrdinaryLock(dataRoot: string) {
  // The existing predecessor fixture omits this empty directory. Select it through
  // the real owner, never by guessing a lock filename or fabricating holder bytes.
  const path = dataRootLockPath(dataRoot);
  mkdirSync(dirname(path), { recursive: true });
  const directory = physicalIdentity(dirname(path));
  const firstBootId = `p6-calibration-${randomUUID()}`;
  const first = acquireDataRootLock(dataRoot, { bootId: firstBootId });
  let unexpected: DataRootLock | undefined;
  let refusal: unknown;
  try {
    try {
      unexpected = acquireDataRootLock(dataRoot, { bootId: `p6-calibration-peer-${randomUUID()}` });
    } catch (error) {
      refusal = error;
    }
    unexpected?.release();
    expect(refusal, 'ordinary independent open-description lock must conflict').toBeInstanceOf(
      DataRootLockError
    );
    expect(first.path).toBe(path);
    expect(JSON.parse(readFileSync(first.path, 'utf8')).bootId).toBe(firstBootId);
  } finally {
    first.release();
  }
  const afterRelease = acquireDataRootLock(dataRoot, {
    bootId: `p6-calibration-reacquire-${randomUUID()}`,
  });
  afterRelease.release();
  expect(existsSync(path)).toBe(false);
  return { path, directory, conflictingOwnerRefused: true, releaseAndReacquisitionObserved: true };
}

/** Observes original constructors/close calls while preserving their exact results and exceptions. */
function observeMigration(fixture: MigrationFixture, workspaceFailure?: Error) {
  let order = 0;
  const handles: Array<{ sqlite: Database.Database; observation: HandleObservation }> = [];
  let contender: DataRootLock | undefined;
  let probe: LockObservation | undefined;
  const state = {
    publicCallReturned: false,
    settled: false,
    faultInjected: false,
    faultScopeOpen: false,
  };
  const originalUser = scopeDb.openUserDb;
  const originalWorkspace = scopeDb.openBootVerifiedWorkspaceDb;
  const originalMigrate = migrationSql.applyMigrations;
  const originalScopedMigrate = migrationSql.applyScopedMigrations;
  const markerPath = resolveDataRootPath(fixture.dataRoot, 'server', 'layout.json');

  const probeBeforeCanonicalOpen = () => {
    if (probe) return;
    const marker = readDataRootLayoutMarker(fixture.dataRoot);
    const ownerBootId = `p6-migration-contender-${randomUUID()}`;
    let refused = false;
    try {
      contender = acquireDataRootLock(fixture.dataRoot, { bootId: ownerBootId });
    } catch (error) {
      if (!(error instanceof DataRootLockError)) throw error;
      refused = true;
    }
    const path = dataRootLockPath(fixture.dataRoot);
    probe = {
      path,
      refused,
      ownerBootId,
      ...(() => {
        const identity = physicalIdentity(dirname(path));
        return { directoryDevice: identity.device, directoryInode: identity.inode };
      })(),
      marker,
      markerSha256: digestFile(markerPath),
      publicCallReturned: state.publicCallReturned,
      activeOriginalStack: new Error('P6 active original migration crossing').stack ?? '',
      operationSettled: state.settled,
      order: ++order,
      ...(contender ? { acquisition: contender.acquisition } : {}),
    };
    // If OLD grants the contender, retain its real kernel lease through the actual
    // public operation. A later original RW open then proves overlap, not ability
    // guessed after the contender has already released its lock.
  };

  // Each call uses the unchanged ordinary API and a distinct kernel open description.
  // Refusal is observed even when the first canonical-open probe granted no contender.
  const ordinaryPeerRefused = (boundary: 'open' | 'before-close'): boolean => {
    let peer: DataRootLock | undefined;
    try {
      peer = acquireDataRootLock(fixture.dataRoot, {
        bootId: `p6-lifetime-${boundary}-${randomUUID()}`,
      });
      return false;
    } catch (error) {
      if (!(error instanceof DataRootLockError)) throw error;
      return true;
    } finally {
      peer?.release();
    }
  };

  // Observe the driver boundary inside any caller-owned close wrapper. Sampling only
  // before that wrapper could miss its releasing the lease before the physical close.
  const originalPhysicalClose = Database.prototype.close;
  vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
    const handle = handles.find((entry) => entry.sqlite === this);
    let result!: ReturnType<typeof originalPhysicalClose>;
    try {
      if (handle && this.open) {
        handle.observation.openBeforeClose = this.open;
        handle.observation.kernelPeerRefusedBeforeClose = ordinaryPeerRefused('before-close');
      }
    } finally {
      // An observer error must not skip real close; no return here may swallow it.
      result = originalPhysicalClose.call(this);
    }
    return result;
  });

  const watch = <T extends CoreDb | UserDb | WorkspaceDb>(db: T, expectedPath: string): T => {
    if (handles.some((entry) => entry.sqlite === db.sqlite)) return db;
    const actualPath = realpathSync(db.sqlite.name);
    const kernelPeerRefusedWhileOpen = ordinaryPeerRefused('open');
    let contenderBootIdWhileOpen: string | undefined;
    if (contender) {
      contenderBootIdWhileOpen = JSON.parse(readFileSync(contender.path, 'utf8')).bootId;
    }
    const observation: HandleObservation = {
      scope: db.scope,
      expectedPath: resolve(expectedPath),
      actualPath,
      ...physicalIdentity(actualPath),
      readonly: db.sqlite.readonly,
      queryOnly: Number(db.sqlite.pragma('query_only', { simple: true })),
      openOrder: ++order,
      openedWhileContenderHeld: contender !== undefined,
      ...(kernelPeerRefusedWhileOpen === undefined ? {} : { kernelPeerRefusedWhileOpen }),
      ...(contenderBootIdWhileOpen === undefined ? {} : { contenderBootIdWhileOpen }),
    };
    const originalClose = db.sqlite.close.bind(db.sqlite);
    db.sqlite.close = () => {
      try {
        return originalClose();
      } finally {
        observation.closeOrder = ++order;
        observation.openAfterClose = db.sqlite.open;
      }
    };
    handles.push({ sqlite: db.sqlite, observation });
    return db;
  };

  vi.spyOn(migrationSql, 'applyMigrations').mockImplementation((db, ...args) => {
    if (resolve(db.sqlite.name) === resolve(coreDbPath(fixture.dataRoot)))
      watch(db, coreDbPath(fixture.dataRoot));
    return originalMigrate(db, ...args);
  });
  vi.spyOn(migrationSql, 'applyScopedMigrations').mockImplementation((db, ...args) => {
    const result = originalScopedMigrate(db, ...args);
    if (
      workspaceFailure &&
      db.scope === 'workspace' &&
      resolve(db.dataRoot) === resolve(fixture.dataRoot) &&
      resolve(db.sqlite.name) === resolve(workspaceDbPath(fixture.dataRoot, fixture.workspaceId))
    ) {
      state.faultInjected = true;
      state.faultScopeOpen = db.sqlite.open;
      throw workspaceFailure;
    }
    return result;
  });
  vi.spyOn(scopeDb, 'openUserDb').mockImplementation((dataRoot, userId) => {
    if (resolve(dataRoot) === resolve(fixture.dataRoot)) {
      probeBeforeCanonicalOpen();
      return watch(originalUser(dataRoot, userId), userDbPath(dataRoot, userId));
    }
    return originalUser(dataRoot, userId);
  });
  vi.spyOn(scopeDb, 'openBootVerifiedWorkspaceDb').mockImplementation((dataRoot, workspaceId) => {
    if (resolve(dataRoot) === resolve(fixture.dataRoot)) {
      probeBeforeCanonicalOpen();
      return watch(
        originalWorkspace(dataRoot, workspaceId),
        workspaceDbPath(dataRoot, workspaceId)
      );
    }
    return originalWorkspace(dataRoot, workspaceId);
  });

  return {
    state,
    handles,
    probe: () => probe,
    allClosed: () => handles.length > 0 && handles.every(({ sqlite }) => !sqlite.open),
    workspaceObserved: () => handles.some(({ observation }) => observation.scope === 'workspace'),
    releaseContender() {
      if (contender) {
        const owner = contender;
        contender = undefined;
        owner.release();
        if (probe) probe.releasedOrder = ++order;
      }
    },
    cleanup() {
      // Only abnormal test/setup failure can use this safety cleanup. Its use is
      // recorded by the caller and never counted as the product's close proof.
      const forced: string[] = [];
      for (const { sqlite, observation } of handles) {
        if (sqlite.open) {
          forced.push(observation.actualPath);
          sqlite.close();
        }
      }
      this.releaseContender();
      vi.restoreAllMocks();
      return forced;
    },
  };
}

/** Reads the migration owner's own report instead of inventing completion evidence. */
function migrationReport(dataRoot: string) {
  const root = resolveDataRootPath(dataRoot, 'server', 'migrations');
  const files = readdirSync(root).filter((name) => name.endsWith('.json'));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(root, files[0]!), 'utf8')) as {
    outcome: string;
    sourceLayoutVersion: number;
    targetLayoutVersion: number;
    backup: { id: string };
    failure?: { message: string };
  };
}

/** Reuses the existing successful native-layout fixture without changing its production setup. */
async function preparedFixture() {
  const fixture = createMigrationFixture();
  const sourceRoot = sourceWorkspaceRoot(fixture);
  try {
    await createNativeLayoutSource(sourceRoot, fixture.workspaceId, fixture.ownerUserId);
    const preflight = preflightWorkspaceStorageMigration({
      coreDb: fixture.coreDb,
      dataRoot: fixture.dataRoot,
    });
    expect(preflight.diagnostics).toEqual([]);
    const config = readFileSync(join(sourceRoot, 'config', 'workspace.jsonc'));
    const knowledgeBaseId = KnowledgeBaseIdSchema.parse(
      WorkspaceConfigSchema.parse(parseJsoncObject(config.toString('utf8'))).workspace
        .defaultKnowledgeBaseId
    );
    const notebookInventory = inventoryRegularFiles(join(sourceRoot, 'knowledge', 'notebook.git'));
    fixture.coreDb.sqlite.close();
    const coreRows = retainedRows(coreDbPath(fixture.dataRoot), [
      'users',
      'workspace_registry',
      'workspace_members',
      'idempotency_requests',
      'audit_events',
    ]);
    const workspaceRows = retainedRows(join(sourceRoot, 'db', 'workspace.sqlite'), []);
    return {
      fixture,
      sourceRoot,
      config,
      knowledgeBaseId,
      notebookInventory,
      coreRows,
      workspaceRows,
    };
  } catch (error) {
    if (fixture.coreDb.sqlite.open) fixture.coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(fixture.dataRoot, { recursive: true, force: true });
    throw error;
  }
}

describe('independent stopped migration kernel exclusion', () => {
  for (const mode of ['normal', 'canonical Workspace failure'] as const) {
    it(`retains exclusion across real canonical RW lifetime: ${mode}`, async () => {
      const prepared = await preparedFixture();
      const { fixture } = prepared;
      const backupParent = mkdtempSync(join(tmpdir(), 'openkit-p6-backup-'));
      const backupRoot = join(backupParent, 'backup');
      const calibration = calibrateOrdinaryLock(fixture.dataRoot);
      const injected = new Error(
        'package6 injected failure after real canonical Workspace migrations'
      );
      const observed = observeMigration(
        fixture,
        mode === 'canonical Workspace failure' ? injected : undefined
      );
      let caught: unknown;
      let result: Awaited<ReturnType<typeof migrateWorkspaceStorage>> | undefined;
      let receipt: Record<string, unknown> | undefined;
      try {
        const operation = migrateWorkspaceStorage({
          backupRoot,
          dataRoot: fixture.dataRoot,
          now: () => timestamp,
        });
        observed.state.publicCallReturned = true;
        try {
          result = await operation.then(
            (value) => {
              observed.state.settled = true;
              return value;
            },
            (error: unknown) => {
              observed.state.settled = true;
              throw error;
            }
          );
        } catch (error) {
          caught = error;
        }
        const probe = observed.probe();
        const observations = observed.handles.map(({ observation }) => observation);
        receipt = {
          mode,
          calibration,
          probe,
          handles: observations,
          faultInjected: observed.state.faultInjected,
          faultScopeOpen: observed.state.faultScopeOpen,
          caught: caught instanceof Error ? caught.message : caught,
          originalResult: result,
          originalPromiseSettled: observed.state.settled,
          canonicalWorkspaceAdmitted: isScopeAdmitted(
            fixture.dataRoot,
            'workspace',
            fixture.workspaceId
          ),
          allCanonicalHandlesClosedByProduct: observed.allClosed(),
        };
        // Preserve raw observation even if an ancillary setup/retention assertion
        // fails. Only the final exclusion predicate can classify a deciding OLD.
        console.log(`P6-MIGRATION-EXCLUSION ${JSON.stringify(receipt)}`);
        expect(
          probe,
          'must reach successor publication before a real canonical open'
        ).toBeDefined();
        expect(probe!.marker).toMatchObject({
          schemaVersion: 1,
          layoutVersion: 2,
          deploymentId: predecessorDeploymentId,
        });
        expect(probe!.activeOriginalStack).toContain('migrateWorkspaceStorage');
        expect(probe!.activeOriginalStack).toContain('verifyAndMigrateExistingScopedDatabases');
        expect(probe!.operationSettled).toBe(false);
        expect(probe!.directoryDevice).toBe(calibration.directory.device);
        expect(probe!.directoryInode).toBe(calibration.directory.inode);
        expect(observed.state.settled).toBe(true);
        expect(observations.some((handle) => handle.scope === 'core')).toBe(true);
        expect(observations.some((handle) => handle.scope === 'user')).toBe(true);
        expect(observations.some((handle) => handle.scope === 'workspace')).toBe(true);
        for (const handle of observations) {
          expect(handle.actualPath).toBe(realpathSync(handle.expectedPath));
          expect(handle.readonly).toBe(false);
          expect(handle.queryOnly).toBe(0);
          expect(handle.closeOrder).toBeGreaterThan(handle.openOrder);
          expect(handle.openAfterClose).toBe(false);
          if (!probe!.refused && handle.scope !== 'core') {
            expect(handle.openedWhileContenderHeld).toBe(true);
            expect(handle.kernelPeerRefusedWhileOpen).toBe(true);
            expect(handle.contenderBootIdWhileOpen).toBe(probe!.ownerBootId);
          }
        }
        expect(observed.allClosed(), 'original finally/close paths, before test cleanup').toBe(
          true
        );
        if (mode === 'normal') {
          expect(caught).toBeUndefined();
          expect(result).toMatchObject({ outcome: 'succeeded', workspaceCount: 1 });
          expect(isScopeAdmitted(fixture.dataRoot, 'workspace', fixture.workspaceId)).toBe(true);
        } else {
          expect(observed.state.faultInjected).toBe(true);
          expect(observed.state.faultScopeOpen).toBe(true);
          expect(caught).toBeInstanceOf(Error);
          expect((caught as Error).message).toBe(migrationVerificationFailure);
          expect(isScopeAdmitted(fixture.dataRoot, 'workspace', fixture.workspaceId)).toBe(false);
          expect(result).toBeUndefined();
        }

        observed.releaseContender();
        if (probe!.acquisition) {
          expect(probe!.releasedOrder).toBeGreaterThan(
            Math.max(...observations.map((handle) => handle.closeOrder!))
          );
        }
        const released = acquireDataRootLock(fixture.dataRoot, {
          bootId: `p6-after-original-${randomUUID()}`,
        });
        const afterOriginal = { acquisition: released.acquisition, path: released.path };
        released.release();
        expect(existsSync(afterOriginal.path)).toBe(false);
        expect(physicalIdentity(dirname(afterOriginal.path))).toEqual(calibration.directory);

        const verified = verifyDataRootBackupManifest({ backupRoot });
        expect(verified.manifest.sourceDeploymentId).toBe(predecessorDeploymentId);
        expect(verified.manifest.backupStartedAt).toBe(timestamp);
        expect(verified.manifest.backupCompletedAt).toBe(timestamp);
        expect(verified.checkedFiles).toContain(
          relative(fixture.dataRoot, join(prepared.sourceRoot, 'db', 'workspace.sqlite'))
        );
        const report = migrationReport(fixture.dataRoot);
        expect(report).toMatchObject({
          outcome: mode === 'normal' ? 'succeeded' : 'failed',
          sourceLayoutVersion: 1,
          targetLayoutVersion: 2,
          backup: { id: verified.manifest.id },
        });
        if (result) expect(result.backupId).toBe(verified.manifest.id);
        if (mode === 'canonical Workspace failure')
          expect(report.failure?.message).toBe(migrationVerificationFailure);
        expect(existsSync(prepared.sourceRoot)).toBe(false);
        const targetRoot = resolveDataRootPath(fixture.dataRoot, 'workspaces', fixture.workspaceId);
        expect(readFileSync(join(targetRoot, 'config', 'workspace.jsonc'))).toEqual(
          prepared.config
        );
        if (mode === 'normal') {
          expect(
            readDefaultKnowledgeBaseId({
              dataRoot: fixture.dataRoot,
              scope: { kind: 'workspace', workspaceId: fixture.workspaceId },
            })
          ).toBe(prepared.knowledgeBaseId);
        }
        // The failure case must remain refused; inspect only its private fixture
        // files and readonly SQL below, never re-admit it to make this check pass.
        expect(inventoryRegularFiles(join(targetRoot, 'knowledge', 'notebook.git'))).toEqual(
          prepared.notebookInventory
        );
        expect(
          retainedRows(coreDbPath(fixture.dataRoot), [
            'users',
            'workspace_registry',
            'workspace_members',
            'idempotency_requests',
            'audit_events',
          ])
        ).toEqual(prepared.coreRows);
        expect(retainedRows(workspaceDbPath(fixture.dataRoot, fixture.workspaceId), [])).toEqual(
          prepared.workspaceRows
        );
        receipt = { ...receipt, probe, afterOriginal, retainedOriginalSemantics: true };
        console.log(`P6-MIGRATION-EXCLUSION-RETAINED ${JSON.stringify(receipt)}`);

        // Core Storage SQLite Layers requires one physical owner; the dispatch
        // requires ordinary root exclusion across the stopped migration's RW
        // lifetime, including the actual post-successor canonical-open interval.
        expect(
          probe!.refused,
          'P6 stopped migration must retain real root exclusion after successor publication through canonical RW close'
        ).toBe(true);
        // Keep the original OLD deciding predicate first. A refused first probe is
        // insufficient on NEW: each actual open handle and its pre-close boundary
        // must still exclude a genuine independent ordinary kernel owner.
        for (const handle of observations) {
          expect(
            handle.kernelPeerRefusedWhileOpen,
            `P6 ${handle.scope} canonical RW handle must retain root exclusion while open`
          ).toBe(true);
          expect(handle.openBeforeClose).toBe(true);
          expect(
            handle.kernelPeerRefusedBeforeClose,
            `P6 ${handle.scope} canonical RW handle must retain root exclusion before physical close`
          ).toBe(true);
        }
      } finally {
        const forcedCloses = observed.cleanup();
        console.log(`P6-MIGRATION-EXCLUSION-CLEANUP ${JSON.stringify({ mode, forcedCloses })}`);
        if (fixture.coreDb.sqlite.open) fixture.coreDb.sqlite.close();
        await shutdownControlStoreWorkerClient();
        rmSync(fixture.dataRoot, { recursive: true, force: true });
        rmSync(backupParent, { recursive: true, force: true });
      }
    });
  }

  it('refuses an already-held ordinary lock before protected writes', async () => {
    const prepared = await preparedFixture();
    const { fixture } = prepared;
    const backupParent = mkdtempSync(join(tmpdir(), 'openkit-p6-locked-backup-'));
    const backupRoot = join(backupParent, 'backup');
    const calibration = calibrateOrdinaryLock(fixture.dataRoot);
    const held = acquireDataRootLock(fixture.dataRoot, {
      bootId: `p6-existing-owner-${randomUUID()}`,
    });
    const lockRelativePath = relative(fixture.dataRoot, held.path);
    const protectedInventory = () =>
      inventoryRegularFiles(fixture.dataRoot).filter((entry) => entry.path !== lockRelativePath);
    const before = protectedInventory();
    let error: unknown;
    try {
      try {
        await migrateWorkspaceStorage({
          backupRoot,
          dataRoot: fixture.dataRoot,
          now: () => timestamp,
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/lock/i);
      expect(protectedInventory()).toEqual(before);
      expect(existsSync(backupRoot)).toBe(false);
      expect(existsSync(join(fixture.dataRoot, 'workspaces'))).toBe(false);
      expect(
        JSON.parse(
          readFileSync(resolveDataRootPath(fixture.dataRoot, 'server', 'layout.json'), 'utf8')
        )
      ).toMatchObject({ layoutVersion: 1, deploymentId: predecessorDeploymentId });
      expect(() =>
        acquireDataRootLock(fixture.dataRoot, { bootId: `p6-still-held-${randomUUID()}` })
      ).toThrow(DataRootLockError);
      console.log(
        `P6-MIGRATION-EXCLUSION-CONTROL ${JSON.stringify({
          calibration,
          actualHeldPath: held.path,
          originalRefusal: (error as Error).message,
          protectedInventoryUnchanged: true,
          successorNotPublished: true,
          originalOwnerStillHoldsKernelLock: true,
        })}`
      );
    } finally {
      held.release();
      vi.restoreAllMocks();
      await shutdownControlStoreWorkerClient();
      if (fixture.coreDb.sqlite.open) fixture.coreDb.sqlite.close();
      rmSync(fixture.dataRoot, { recursive: true, force: true });
      rmSync(backupParent, { recursive: true, force: true });
    }
  });
});
