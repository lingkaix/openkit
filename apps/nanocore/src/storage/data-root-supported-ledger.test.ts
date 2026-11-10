import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { parseDataRootBackupManifest } from '@openkit/config-schema';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { BootConfigError } from '../config/mode.js';
import {
  createLightApp,
  createRecord,
  getRecord,
  type KernelCommandContext,
  listLightAppSnapshots,
  rollbackLightAppSnapshot,
  updateLightAppSchema,
} from '../generative-kernel/commands.js';
import { FsStore } from '../lib/store.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { lightAppDbPath, lightAppRoot } from './app-db.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import {
  copyColdDataRoot,
  DATA_ROOT_BACKUP_MANIFEST_FILE,
  inventoryRegularFiles,
  restoreDataRootBackup,
  writeColdDataRootBackupManifest,
} from './data-root-backup.js';
import { openExistingCoreDbWithIntegrityCheck, openUserDb } from './db.js';
import { coreDbPath, readDataRootLayoutMarker, userDbPath, workspaceDbPath } from './fs-layout.js';
import {
  applyNativeScopeMigrations,
  applyScopedMigrations,
  listAppliedNativeMigrationIds,
  type StorageMigrationScope,
} from './migrate.js';

// G2: only canonical scope paths and owned immutable App snapshots are ledger authorities.
const roots: string[] = [];
const timestamp = '2026-11-10T06:00:00.000Z';
const schema: LightAppSchemaInput = {
  format: 'openkit.light-app',
  schemaVersion: 1,
  title: 'Root backup ledger',
  purpose: 'Preserve the original record and recovery copy.',
  collections: [
    {
      name: 'notes',
      type: 'base',
      description: 'Original records.',
      fields: [{ name: 'text', type: 'text', required: true, description: 'Exact retained text.' }],
      indexes: [],
    },
  ],
};
function journal(scope: StorageMigrationScope): { tag: string; when: number }[] {
  return JSON.parse(
    readFileSync(new URL(`../../drizzle/${scope}/meta/_journal.json`, import.meta.url), 'utf8')
  ).entries;
}
/** Captures bytes through the existing inventory owner and identities separately from content equality. */
function tree(root: string) {
  const files = inventoryRegularFiles(root);
  const directory = statSync(root);
  return {
    files,
    rootIdentity: [directory.dev, directory.ino],
    identities: files.map((file) => {
      const metadata = statSync(join(root, file.path));
      return { path: file.path, dev: metadata.dev, ino: metadata.ino };
    }),
  };
}
async function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'openkit-root-ledger-'));
  roots.push(parent);
  const source = join(parent, 'source');
  const backup = join(parent, 'backup');
  const target = join(parent, 'target');
  const store = await createDemoStore({ dataRoot: source });
  const user = openUserDb(source, FIXTURE_LOCAL_USER_ID);
  try {
    applyScopedMigrations(user);
  } finally {
    user.sqlite.close();
  }
  const context: KernelCommandContext = {
    dataRoot: source,
    store,
    inflightCommands: new WeakMap(),
    workspaceId: DEMO_WORKSPACE_ID,
    actor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
    requestId: randomUUID(),
  };
  const app = await createLightApp(context, schema);
  const record = await createRecord(
    { ...context, requestId: randomUUID() },
    app.appId,
    'notes',
    app.schemaRevision,
    { text: 'Exact retained note é' }
  );
  const { appId: _appId, schemaRevision: _schemaRevision, ...proposal } = app.schema!;
  proposal.title = 'New definition; retain the original recovery copy';
  const changed = await updateLightAppSchema(
    { ...context, requestId: randomUUID() },
    app.appId,
    app.appRevision,
    app.schemaRevision,
    proposal
  );
  const snapshots = listLightAppSnapshots(source, DEMO_WORKSPACE_ID, app.appId).snapshots;
  expect(snapshots).toHaveLength(1);
  const snapshot = snapshots[0]!;
  await shutdownControlStoreWorkerClient();
  closeWorkspaceProductReadHandles(source);
  const appRoot = lightAppRoot(source, DEMO_WORKSPACE_ID, app.appId);
  const paths = {
    core: coreDbPath(source),
    user: userDbPath(source, FIXTURE_LOCAL_USER_ID),
    workspace: workspaceDbPath(source, DEMO_WORKSPACE_ID),
    app: lightAppDbPath(source, DEMO_WORKSPACE_ID, app.appId),
    'app-snapshot': join(appRoot, 'snapshots', `${snapshot.snapshotId}.sqlite`),
  };
  for (const path of Object.values(paths)) expect(existsSync(path)).toBe(true);
  return { parent, source, backup, target, paths, app, changed, snapshot, record };
}
function capture(f: Awaited<ReturnType<typeof fixture>>) {
  copyColdDataRoot({ dataRoot: f.source, backupRoot: f.backup });
  writeColdDataRootBackupManifest({
    backupRoot: f.backup,
    backupId: testEntityId('drb', 'supported-root-ledger'),
    sourceDeploymentId: readDataRootLayoutMarker(f.source).deploymentId,
    startedAt: timestamp,
    completedAt: timestamp,
  });
  copyColdDataRoot({ dataRoot: f.source, backupRoot: f.target });
  writeFileSync(
    join(f.target, 'prior-root-sentinel.txt'),
    'Do not replace this root on refusal.\n'
  );
}
/** Keeps an existing recovery copy's byte digest valid after a deliberate ledger-only fault. */
function refreshSnapshotDigest(path: string) {
  const metadataPath = path.replace(/\.sqlite$/, '.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Record<string, unknown>;
  metadata.digest = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
}
/** Models a future binary's digest-valid backup by faulting one owned ledger after valid capture. */
function futureBackup(f: Awaited<ReturnType<typeof fixture>>, kind: keyof typeof f.paths) {
  const path = join(f.backup, relative(f.source, f.paths[kind]));
  const scope = kind === 'app-snapshot' ? 'app' : kind;
  const sqlite = new Database(path, { fileMustExist: true });
  try {
    sqlite
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('independent-future-binary-fixture', journal(scope).at(-1)!.when + 1);
  } finally {
    sqlite.close();
  }
  if (kind === 'app-snapshot') {
    // Keep the existing snapshot's own exact-byte digest valid as well as the root inventory.
    refreshSnapshotDigest(path);
  }
  refreshBackupManifest(f.backup);
  return scope;
}
/** Refreshes only the existing inventory/digest after a deliberate future-backup fixture fault. */
function refreshBackupManifest(backupRoot: string) {
  const manifestPath = join(backupRoot, DATA_ROOT_BACKUP_MANIFEST_FILE);
  const original = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const contentInventory = inventoryRegularFiles(backupRoot).filter(
    (file) => file.path !== DATA_ROOT_BACKUP_MANIFEST_FILE
  );
  const candidate = {
    ...original,
    contentInventory,
    contentDigest: `sha256:${createHash('sha256').update(JSON.stringify(contentInventory)).digest('hex')}`,
  };
  const manifest = parseDataRootBackupManifest(candidate);
  writeFileSync(manifestPath, `${JSON.stringify(candidate)}\n`);
  expect(manifest.contentInventory).toEqual(contentInventory);
  expect(manifest.contentDigest).toBe(
    `sha256:${createHash('sha256').update(JSON.stringify(contentInventory)).digest('hex')}`
  );
}
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) {
    closeWorkspaceProductReadHandles(root);
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['core', 'user', 'workspace', 'app', 'app-snapshot'] as const)(
  'G2 refuses a digest-valid backup with unsupported %s history before replacing any destination authority',
  async (kind) => {
    const f = await fixture();
    capture(f);
    const scope = futureBackup(f, kind);
    const before = tree(f.target);
    const backup = tree(f.backup);
    let failure: unknown;
    try {
      await Promise.resolve().then(() =>
        restoreDataRootBackup({ backupRoot: f.backup, dataRoot: f.target })
      );
    } catch (error) {
      failure = error;
    }
    const identity = statSync(f.target);
    expect([identity.dev, identity.ino]).toEqual(before.rootIdentity);
    expect(tree(f.target)).toEqual(before);
    expect(readFileSync(join(f.target, 'prior-root-sentinel.txt'), 'utf8')).toBe(
      'Do not replace this root on refusal.\n'
    );
    expect(tree(f.backup)).toEqual(backup);
    expect(failure).toBeInstanceOf(BootConfigError);
    expect(failure).toMatchObject({ code: `migration_unsupported_${scope}` });
  }
);

it('G2 restores supported older User and sparse Workspace/App-snapshot journals unchanged, then normal upgrade and rollback owners remain usable', async () => {
  const f = await fixture();
  const prefix = join(f.parent, 'original-user-journal');
  const original = new URL('../../drizzle/user/', import.meta.url);
  const metadata = JSON.parse(readFileSync(new URL('meta/_journal.json', original), 'utf8'));
  const first = metadata.entries[0]!;
  mkdirSync(join(prefix, 'meta'), { recursive: true });
  writeFileSync(
    join(prefix, 'meta', '_journal.json'),
    JSON.stringify({ ...metadata, entries: [first] })
  );
  copyFileSync(new URL(`${first.tag}.sql`, original), join(prefix, `${first.tag}.sql`));
  // Stopped, private predecessor fixture: the real original SQL owns its tables and ledger.
  rmSync(f.paths.user);
  const user = openUserDb(f.source, FIXTURE_LOCAL_USER_ID);
  try {
    applyNativeScopeMigrations(user.sqlite, 'user', prefix);
  } finally {
    user.sqlite.close();
  }
  const workspace = new Database(f.paths.workspace, { fileMustExist: true });
  try {
    expect(
      workspace
        .prepare('DELETE FROM __drizzle_migrations WHERE created_at=?')
        .run(journal('workspace')[1]!.when).changes
    ).toBe(1);
  } finally {
    workspace.close();
  }
  const snapshotDb = new Database(f.paths['app-snapshot'], { fileMustExist: true });
  try {
    expect(
      snapshotDb
        .prepare('DELETE FROM __drizzle_migrations WHERE created_at=?')
        .run(journal('app')[1]!.when).changes
    ).toBe(1);
  } finally {
    snapshotDb.close();
  }
  refreshSnapshotDigest(f.paths['app-snapshot']);
  capture(f);
  const backup = tree(f.backup);
  const userBefore = readFileSync(join(f.backup, relative(f.source, f.paths.user)));
  await Promise.resolve().then(() =>
    restoreDataRootBackup({ backupRoot: f.backup, dataRoot: f.target })
  );
  expect(tree(f.backup)).toEqual(backup);
  expect(readFileSync(userDbPath(f.target, FIXTURE_LOCAL_USER_ID))).toEqual(userBefore);
  const upgraded = openUserDb(f.target, FIXTURE_LOCAL_USER_ID);
  try {
    expect(listAppliedNativeMigrationIds(upgraded.sqlite, 'user')).toEqual([`user_${first.tag}`]);
    applyScopedMigrations(upgraded);
    expect(listAppliedNativeMigrationIds(upgraded.sqlite, 'user')).toEqual(
      journal('user')
        .map((entry) => `user_${entry.tag}`)
        .sort()
    );
  } finally {
    upgraded.sqlite.close();
  }
  const reopened = new FsStore({ dataRoot: f.target });
  expect(reopened.getWorkspace(DEMO_WORKSPACE_ID).name).toBe('Demo Workspace');
  expect(
    getRecord(
      f.target,
      DEMO_WORKSPACE_ID,
      f.app.appId,
      'notes',
      f.record.id,
      f.changed.schemaRevision
    ).data
  ).toEqual({ text: 'Exact retained note é' });
  const restored = await rollbackLightAppSnapshot(
    {
      dataRoot: f.target,
      store: reopened,
      inflightCommands: new WeakMap(),
      workspaceId: DEMO_WORKSPACE_ID,
      actor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
      requestId: randomUUID(),
    },
    f.app.appId,
    f.changed.appRevision,
    f.snapshot.snapshotId
  );
  expect(restored.schemaRevision).toBe(f.app.schemaRevision);
  expect(
    getRecord(
      f.target,
      DEMO_WORKSPACE_ID,
      f.app.appId,
      'notes',
      f.record.id,
      restored.schemaRevision
    ).data
  ).toEqual({ text: 'Exact retained note é' });
  await shutdownControlStoreWorkerClient();
  closeWorkspaceProductReadHandles(f.target);
  expect(tree(f.backup)).toEqual(backup);
});

it('G2 leaves a SQLite source file opaque even when its bytes contain an unsupported migration ledger', async () => {
  const f = await fixture();
  const opaque = join(f.source, 'workspaces', DEMO_WORKSPACE_ID, 'files', 'opaque.sqlite');
  mkdirSync(dirname(opaque), { recursive: true });
  copyFileSync(f.paths.user, opaque);
  const sqlite = new Database(opaque, { fileMustExist: true });
  try {
    sqlite
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('opaque-user-file-not-openkit-authority', journal('user').at(-1)!.when + 1);
  } finally {
    sqlite.close();
  }
  const bytes = readFileSync(opaque);
  capture(f);
  const backup = tree(f.backup);
  await Promise.resolve().then(() =>
    restoreDataRootBackup({ backupRoot: f.backup, dataRoot: f.target })
  );
  expect(tree(f.backup)).toEqual(backup);
  expect(readFileSync(join(f.target, relative(f.source, opaque)))).toEqual(bytes);
  expect(
    getRecord(
      f.target,
      DEMO_WORKSPACE_ID,
      f.app.appId,
      'notes',
      f.record.id,
      f.changed.schemaRevision
    ).data
  ).toEqual({ text: 'Exact retained note é' });
});

it('G2 refuses unsupported Core history committed only in backup WAL while its base database remains supported', async () => {
  const f = await fixture();
  capture(f);
  const path = f.paths.core;
  const backupPath = join(f.backup, relative(f.source, path));
  // This private committed-WAL capture omits the copied disposable reader cache.
  rmSync(`${backupPath}-shm`, { force: true });
  const producer = new Database(path, { fileMustExist: true });
  let baseBytes: Buffer;
  let walBytes: Buffer;
  const when = journal('core').at(-1)!.when + 1;
  try {
    expect(producer.pragma('journal_mode = WAL', { simple: true })).toBe('wal');
    producer.pragma('synchronous = FULL');
    producer.pragma('wal_autocheckpoint = 0');
    expect(producer.pragma('wal_checkpoint(TRUNCATE)')).toEqual([
      expect.objectContaining({ busy: 0 }),
    ]);
    const supported = producer
      .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
      .all() as { created_at: number }[];
    expect(supported.map((row) => Number(row.created_at))).toEqual(
      journal('core').map((entry) => entry.when)
    );
    baseBytes = readFileSync(path);
    producer
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('genuine-committed-WAL-only-future-identity', when);
    expect(producer.inTransaction).toBe(false);
    expect(
      producer.prepare('SELECT created_at FROM __drizzle_migrations WHERE created_at=?').get(when)
    ).toEqual({ created_at: when });
    // Genuine autocommit is visible to the owner, but not present in the base database bytes.
    expect(readFileSync(path)).toEqual(baseBytes);
    walBytes = readFileSync(`${path}-wal`);
    expect(walBytes.byteLength).toBeGreaterThan(32);
    // The producer is idle and open until both authoritative files have been copied.
    copyFileSync(path, backupPath);
    copyFileSync(`${path}-wal`, `${backupPath}-wal`);
    expect(readFileSync(backupPath)).toEqual(baseBytes);
    expect(readFileSync(`${backupPath}-wal`)).toEqual(walBytes);
    expect(existsSync(`${backupPath}-shm`)).toBe(false);
  } finally {
    producer.close();
  }
  // This retained committed-WAL image is a crash-consistent hot capture, not a clean shutdown.
  const manifestPath = join(f.backup, DATA_ROOT_BACKUP_MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, backupMode: 'hot', consistency: 'crash-consistent' })}\n`
  );
  refreshBackupManifest(f.backup);
  const before = tree(f.target);
  const backup = tree(f.backup);
  let failure: unknown;
  try {
    await Promise.resolve().then(() =>
      restoreDataRootBackup({ backupRoot: f.backup, dataRoot: f.target })
    );
  } catch (error) {
    failure = error;
  }
  const identity = statSync(f.target);
  expect([identity.dev, identity.ino]).toEqual(before.rootIdentity);
  expect(tree(f.target)).toEqual(before);
  expect(readFileSync(join(f.target, 'prior-root-sentinel.txt'), 'utf8')).toBe(
    'Do not replace this root on refusal.\n'
  );
  expect(tree(f.backup)).toEqual(backup);
  expect(readFileSync(backupPath)).toEqual(baseBytes!);
  expect(readFileSync(`${backupPath}-wal`)).toEqual(walBytes!);
  expect(failure).toBeInstanceOf(BootConfigError);
  expect(failure).toMatchObject({ code: 'migration_unsupported_core' });
});

it('G2 admits the actual pre-reset Core 0005 SQL hash unchanged through public open, backup and restore', async () => {
  const f = await fixture();
  // SHA-256 of 1a2c0739e^:apps/nanocore/drizzle/core/0005_channel_notifications.sql.
  // Applied SQL hashes are informational; only the exact supported scope timestamps admit history.
  const old0005Hash = 'a3fa5c6983ec449f04ba59c9876822c8e6fa2f6eafe4e91afbdac07cbb76b132';
  const entry = journal('core').find((row) => row.tag === '0005_channel_notifications')!;
  const sqlite = new Database(f.paths.core, { fileMustExist: true });
  let retainedLedger: unknown[];
  try {
    const current = sqlite
      .prepare('SELECT hash FROM __drizzle_migrations WHERE created_at=?')
      .get(entry.when) as { hash: string };
    expect(current.hash).not.toBe(old0005Hash);
    expect(
      sqlite
        .prepare('UPDATE __drizzle_migrations SET hash=? WHERE created_at=?')
        .run(old0005Hash, entry.when).changes
    ).toBe(1);
    retainedLedger = sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all();
  } finally {
    sqlite.close();
  }
  const opened = openExistingCoreDbWithIntegrityCheck(f.source);
  try {
    expect(opened.sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()).toEqual(
      retainedLedger
    );
    expect(
      opened.sqlite
        .prepare('SELECT hash FROM __drizzle_migrations WHERE created_at=?')
        .get(entry.when)
    ).toEqual({ hash: old0005Hash });
  } finally {
    opened.sqlite.close();
  }
  const sourceBytes = readFileSync(f.paths.core);
  capture(f);
  const backupCore = join(f.backup, relative(f.source, f.paths.core));
  expect(readFileSync(backupCore)).toEqual(sourceBytes);
  const backup = tree(f.backup);
  await Promise.resolve().then(() =>
    restoreDataRootBackup({ backupRoot: f.backup, dataRoot: f.target })
  );
  expect(tree(f.backup)).toEqual(backup);
  expect(readFileSync(coreDbPath(f.target))).toEqual(sourceBytes);
  const restored = openExistingCoreDbWithIntegrityCheck(f.target);
  try {
    expect(restored.sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()).toEqual(
      retainedLedger
    );
    expect(
      restored.sqlite
        .prepare('SELECT hash FROM __drizzle_migrations WHERE created_at=?')
        .get(entry.when)
    ).toEqual({ hash: old0005Hash });
  } finally {
    restored.sqlite.close();
  }
  expect(tree(f.backup)).toEqual(backup);
});
