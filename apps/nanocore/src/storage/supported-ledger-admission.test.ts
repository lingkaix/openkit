import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { BootConfigError } from '../config/mode.js';
import {
  createLightApp,
  type KernelCommandContext,
  upgradeLightAppFormat,
} from '../generative-kernel/commands.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { lightAppDbPath, lightAppRoot, openAppDbReadOnly, openExistingAppDb } from './app-db.js';
import {
  closeWorkspaceProductReadHandles,
  openControlStoreProductReadHandle,
} from './control-store-product-records.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { inventoryRegularFiles } from './data-root-backup.js';
import {
  openBootVerifiedWorkspaceDb,
  openCoreDb,
  openCoreDbWithIntegrityCheck,
  openExistingCoreDbWithIntegrityCheck,
  openUserDb,
  openUserReadDb,
  openWorkspaceDb,
  openWorkspaceDbAtRoot,
  openWorkspaceReadDb,
} from './db.js';
import { coreDbPath, userDbPath, workspaceDbPath } from './fs-layout.js';
import {
  applyNativeScopeMigrations,
  hasPendingAppMigrations,
  hasPendingUserMigrations,
  type StorageMigrationScope,
} from './migrate.js';

// G1: inspect actual ledger rows; known sparse history remains supported. Hashes are informational.
const scopes = ['core', 'user', 'workspace', 'app'] as const;
const roots: string[] = [];
const workspaceId = testEntityId('ws', 'supported-ledger');
const userId = FIXTURE_LOCAL_USER_ID;
const schema: LightAppSchemaInput = {
  format: 'openkit.light-app',
  schemaVersion: 1,
  title: 'Ledger admission',
  purpose: 'Retain original application authority.',
  collections: [
    {
      name: 'notes',
      type: 'base',
      description: 'Retained notes.',
      fields: [{ name: 'text', type: 'text', required: true, description: 'Exact note.' }],
      indexes: [],
    },
  ],
};
interface Fixture {
  root: string;
  path: string;
  scope: StorageMigrationScope;
  workspaceId: string;
  appId?: string;
  context?: KernelCommandContext;
}
function journal(scope: StorageMigrationScope): { tag: string; when: number }[] {
  return JSON.parse(
    readFileSync(new URL(`../../drizzle/${scope}/meta/_journal.json`, import.meta.url), 'utf8')
  ).entries;
}
async function fixture(scope: StorageMigrationScope): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'openkit-ledger-admission-'));
  roots.push(root);
  if (scope === 'app') {
    const context: KernelCommandContext = {
      dataRoot: root,
      store: await createDemoStore({ dataRoot: root }),
      inflightCommands: new WeakMap(),
      workspaceId: DEMO_WORKSPACE_ID,
      actor: { kind: 'user', id: userId },
      requestId: randomUUID(),
    };
    const app = await createLightApp(context, schema);
    await shutdownControlStoreWorkerClient();
    closeWorkspaceProductReadHandles(root);
    return {
      root,
      path: lightAppDbPath(root, DEMO_WORKSPACE_ID, app.appId),
      scope,
      workspaceId: DEMO_WORKSPACE_ID,
      appId: app.appId,
      context,
    };
  }
  const db =
    scope === 'core'
      ? openCoreDb(root)
      : scope === 'user'
        ? openUserDb(root, userId)
        : openWorkspaceDb(root, workspaceId);
  try {
    expect(
      db.sqlite.prepare("SELECT name FROM sqlite_schema WHERE name='__drizzle_migrations'").get()
    ).toBeUndefined();
    applyNativeScopeMigrations(
      db.sqlite,
      scope,
      undefined,
      undefined,
      scope === 'workspace' ? 'pre-knowledge' : 'full'
    );
  } finally {
    db.sqlite.close();
  }
  const path =
    scope === 'core'
      ? coreDbPath(root)
      : scope === 'user'
        ? userDbPath(root, userId)
        : workspaceDbPath(root, workspaceId);
  return { root, path, scope, workspaceId };
}
/** Faults only the journal of an already initialized real database. */
function unsupported(f: Fixture, position: 'earlier' | 'interior' | 'future') {
  const entries = journal(f.scope);
  const when =
    position === 'earlier'
      ? entries[0]!.when - 1
      : position === 'interior'
        ? entries[0]!.when + 1
        : entries.at(-1)!.when + 1;
  expect(entries.some((entry) => entry.when === when)).toBe(false);
  const sqlite = new Database(f.path, { fileMustExist: true });
  try {
    sqlite
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('independent-unsupported-ledger-fixture', when);
  } finally {
    sqlite.close();
  }
}
/** Uses a raw readonly observer so refusal cannot be confused with the observer's own admission. */
function retained(f: Fixture) {
  const sqlite = new Database(f.path, { readonly: true, fileMustExist: true });
  let contents: Buffer;
  let ledger: unknown[];
  try {
    contents = sqlite.serialize();
    ledger = sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY created_at, id').all();
  } finally {
    sqlite.close();
  }
  const identity = statSync(f.path);
  return { contents, ledger, bytes: readFileSync(f.path), dev: identity.dev, ino: identity.ino };
}
/** Applies only the accepted unsupported-opening cache exception; every prior file stays exact. */
function expectRefusalInventoryUnchanged(
  before: ReturnType<typeof inventoryRegularFiles>,
  after: ReturnType<typeof inventoryRegularFiles>,
  databasePath: string
) {
  const permittedCreated = new Set<string>();
  for (const suffix of ['-wal', '-shm']) {
    const path = `${databasePath}${suffix}`;
    if (before.some((entry) => entry.path === path)) continue;
    const created = after.find((entry) => entry.path === path);
    if (!created) continue;
    // Explicit refusal exception: a newly created WAL must contain no committed frames.
    if (suffix === '-wal') expect(created.bytes).toBe(0);
    permittedCreated.add(path);
  }
  expect(after.filter((entry) => !permittedCreated.has(entry.path))).toEqual(before);
}
function expectUnsupported(action: () => unknown, scope: StorageMigrationScope) {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(BootConfigError);
  expect(failure).toMatchObject({ code: `migration_unsupported_${scope}` });
}
function openReader(f: Fixture): Database.Database {
  switch (f.scope) {
    case 'core':
      return openExistingCoreDbWithIntegrityCheck(f.root).sqlite;
    case 'user':
      return openUserReadDb(f.root, userId).sqlite;
    case 'workspace':
      return openWorkspaceReadDb(f.root, f.workspaceId).sqlite;
    case 'app':
      return openExistingAppDb(f.root, f.workspaceId, f.appId!).sqlite;
  }
}
function nativeOpening(
  f: Fixture,
  existingCore = false
): Parameters<ReturnType<typeof getControlStoreWorkerClient>['open']>[0] {
  const common = { database: `${f.scope}:${f.path}`, path: f.path, create: false };
  if (f.scope === 'app')
    return {
      ...common,
      dataRoot: f.root,
      physicalScope: { kind: 'app', workspaceId: f.workspaceId, appId: f.appId! },
    };
  if (f.scope === 'core')
    return {
      ...common,
      dataRoot: f.root,
      productOwner: { kind: 'server' },
      ...(existingCore ? {} : { initialize: 'core' as const }),
    };
  if (f.scope === 'workspace')
    return {
      ...common,
      dataRoot: f.root,
      productOwner: { kind: 'workspace', workspaceId: f.workspaceId },
      initialize: 'workspace',
    };
  return { ...common, initialize: 'user' };
}
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) {
    closeWorkspaceProductReadHandles(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe.each(scopes)('G1 %s supported ledger', (scope) => {
  it.each(['earlier', 'interior', 'future'] as const)(
    'refuses an unknown %s timestamp in raw apply before changing database authority',
    async (position) => {
      const f = await fixture(scope);
      unsupported(f, position);
      const before = retained(f);
      const sqlite = new Database(f.path, { fileMustExist: true });
      try {
        expectUnsupported(
          () =>
            applyNativeScopeMigrations(
              sqlite,
              scope,
              undefined,
              undefined,
              scope === 'workspace' ? 'pre-knowledge' : 'full'
            ),
          scope
        );
      } finally {
        sqlite.close();
      }
      expect(retained(f)).toEqual(before);
    }
  );

  it('refuses a future timestamp through the ordinary existing owner before returning a handle', async () => {
    const f = await fixture(scope);
    unsupported(f, 'future');
    const before = retained(f);
    expectUnsupported(() => {
      openReader(f).close();
    }, scope);
    expect(retained(f)).toEqual(before);
  });

  it('refuses a future timestamp in the genuine native Worker open without changing retained authority', async () => {
    const f = await fixture(scope);
    unsupported(f, 'future');
    const before = retained(f);
    const beforeFiles = inventoryRegularFiles(dirname(f.path));
    const opening = getControlStoreWorkerClient().open(nativeOpening(f));
    await expect(opening).rejects.toBeInstanceOf(ControlStoreWorkerError);
    await expect(opening).rejects.toMatchObject({
      code: `migration_unsupported_${scope}`,
      commit: 'not-committed',
    });
    await shutdownControlStoreWorkerClient();
    expectRefusalInventoryUnchanged(
      beforeFiles,
      inventoryRegularFiles(dirname(f.path)),
      basename(f.path)
    );
    expect(retained(f)).toEqual(before);
  });

  it('admits fresh owner initialization and a known sparse history without filling holes or rewriting rows', async () => {
    const f = await fixture(scope);
    const sqlite = new Database(f.path, { fileMustExist: true });
    try {
      const earlier = sqlite
        .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at LIMIT 1')
        .get() as { created_at: number };
      expect(
        sqlite
          .prepare('DELETE FROM __drizzle_migrations WHERE created_at=?')
          .run(earlier.created_at).changes
      ).toBe(1);
    } finally {
      sqlite.close();
    }
    const before = retained(f);
    const apply = new Database(f.path, { fileMustExist: true });
    try {
      applyNativeScopeMigrations(
        apply,
        scope,
        undefined,
        undefined,
        scope === 'workspace' ? 'pre-knowledge' : 'full'
      );
      if (scope === 'user') expect(hasPendingUserMigrations(apply)).toBe(false);
      if (scope === 'app') hasPendingAppMigrations(apply);
    } finally {
      apply.close();
    }
    openReader(f).close();
    await getControlStoreWorkerClient().open(nativeOpening(f));
    await shutdownControlStoreWorkerClient();
    expect(retained(f)).toEqual(before);
  });
});

it.each(['core', 'user', 'workspace'] as const)(
  'G1 raw %s owner cannot bypass supported-ledger admission by omitting apply',
  async (scope) => {
    const f = await fixture(scope);
    unsupported(f, 'future');
    const before = retained(f);
    expectUnsupported(() => {
      const db =
        scope === 'core'
          ? openCoreDb(f.root)
          : scope === 'user'
            ? openUserDb(f.root, userId)
            : openWorkspaceDb(f.root, f.workspaceId);
      db.sqlite.close();
    }, scope);
    expect(retained(f)).toEqual(before);
  }
);
it('G1 Core integrity boot opener refuses an unsupported journal before returning writable authority', async () => {
  const f = await fixture('core');
  unsupported(f, 'future');
  const before = retained(f);
  expectUnsupported(
    () => openCoreDbWithIntegrityCheck(f.root, { freshInitialization: false }).sqlite.close(),
    'core'
  );
  expect(retained(f)).toEqual(before);
});
it('G1 existing native Core product opening without initialize still refuses its unsupported journal', async () => {
  const f = await fixture('core');
  unsupported(f, 'future');
  const before = retained(f);
  const beforeFiles = inventoryRegularFiles(dirname(f.path));
  await expect(getControlStoreWorkerClient().open(nativeOpening(f, true))).rejects.toMatchObject({
    name: 'ControlStoreWorkerError',
    code: 'migration_unsupported_core',
    commit: 'not-committed',
  });
  await shutdownControlStoreWorkerClient();
  expectRefusalInventoryUnchanged(
    beforeFiles,
    inventoryRegularFiles(dirname(f.path)),
    basename(f.path)
  );
  expect(retained(f)).toEqual(before);
});
it.each(['user', 'app'] as const)(
  'G1 %s readiness refuses unknown retained rows rather than treating them as applied or pending',
  async (scope) => {
    const f = await fixture(scope);
    unsupported(f, 'future');
    const before = retained(f);
    const sqlite = new Database(f.path, { readonly: true, fileMustExist: true });
    try {
      expectUnsupported(
        () =>
          scope === 'app' ? hasPendingAppMigrations(sqlite) : hasPendingUserMigrations(sqlite),
        scope
      );
    } finally {
      sqlite.close();
    }
    expect(retained(f)).toEqual(before);
  }
);
it('G1 current User readonly admission refuses an unsupported journal without requiring a new writer', async () => {
  const f = await fixture('user');
  unsupported(f, 'future');
  const before = retained(f);
  let failure: unknown;
  try {
    (await getControlStoreWorkerClient().openInitializedUserReadDb(f.root, userId)).sqlite.close();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(BootConfigError);
  expect(failure).toMatchObject({ code: 'migration_unsupported_user' });
  expect(retained(f)).toEqual(before);
});
it('G1 App snapshot/candidate readonly verifier refuses an unsupported App journal', async () => {
  const f = await fixture('app');
  unsupported(f, 'future');
  const before = retained(f);
  expectUnsupported(() => openAppDbReadOnly(f.path).close(), 'app');
  expect(retained(f)).toEqual(before);
});
it('G1 public App format upgrade refuses unknown history before its existing recovery snapshot or native effect', async () => {
  const f = await fixture('app');
  const sqlite = new Database(f.path, { fileMustExist: true });
  try {
    // A supported sparse ledger reaches the original hasPendingAppMigrations snapshot branch.
    expect(
      sqlite
        .prepare('DELETE FROM __drizzle_migrations WHERE created_at=?')
        .run(journal('app')[1]!.when).changes
    ).toBe(1);
  } finally {
    sqlite.close();
  }
  unsupported(f, 'earlier');
  const root = lightAppRoot(f.root, f.workspaceId, f.appId!);
  const before = inventoryRegularFiles(root);
  const upgrade = upgradeLightAppFormat({ ...f.context!, requestId: randomUUID() }, f.appId!, 1);
  await expect(upgrade).rejects.toBeInstanceOf(BootConfigError);
  await expect(upgrade).rejects.toMatchObject({ code: 'migration_unsupported_app' });
  await shutdownControlStoreWorkerClient();
  expectRefusalInventoryUnchanged(before, inventoryRegularFiles(root), 'data.sqlite');
});
it('G1 keeps the existing Workspace Knowledge activation-history refusal independently of general sparse admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-ledger-knowledge-'));
  roots.push(root);
  await createDemoStore({ dataRoot: root });
  await shutdownControlStoreWorkerClient();
  closeWorkspaceProductReadHandles(root);
  const path = workspaceDbPath(root, DEMO_WORKSPACE_ID);
  const sqlite = new Database(path, { fileMustExist: true });
  try {
    const activation = journal('workspace').find(
      (entry) => entry.tag === '0019_knowledge_authority'
    )!;
    expect(
      sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at=?').run(activation.when)
        .changes
    ).toBe(1);
    expect(() =>
      applyNativeScopeMigrations(sqlite, 'workspace', undefined, undefined, 'pre-knowledge')
    ).toThrowError(expect.objectContaining({ code: 'migration_failed' }));
  } finally {
    sqlite.close();
  }
});

it.each(scopes)(
  'G1 preserves the existing %s missing-storage refusal without creating a replacement',
  async (scope) => {
    const f = await fixture(scope);
    rmSync(f.path);
    expect(() => openReader(f).close()).toThrow();
    expect(existsSync(f.path)).toBe(false);
  }
);

it('G1 direct readonly Core product owner refuses an unsupported journal', async () => {
  const f = await fixture('core');
  unsupported(f, 'future');
  const before = retained(f);
  expectUnsupported(
    () => openControlStoreProductReadHandle(f.path, { kind: 'server' }).close(),
    'core'
  );
  expect(retained(f)).toEqual(before);
});
it.each(['selected-root', 'boot-verified'] as const)(
  'G1 Workspace %s opener cannot bypass journal admission',
  async (opening) => {
    const f = await fixture('workspace');
    unsupported(f, 'future');
    const before = retained(f);
    expectUnsupported(() => {
      const db =
        opening === 'selected-root'
          ? openWorkspaceDbAtRoot({
              dataRoot: f.root,
              workspaceId: f.workspaceId,
              workspaceRoot: join(f.root, 'workspaces', f.workspaceId),
            })
          : openBootVerifiedWorkspaceDb(f.root, f.workspaceId);
      db.sqlite.close();
    }, 'workspace');
    expect(retained(f)).toEqual(before);
  }
);

it('G1 native Core refusal preserves unsupported history committed only in WAL without checkpointing its base database', async () => {
  const source = await fixture('core');
  const target = await fixture('core');
  const producer = new Database(source.path, { fileMustExist: true });
  let baseBytes: Buffer;
  let walBytes: Buffer;
  try {
    expect(producer.pragma('journal_mode = WAL', { simple: true })).toBe('wal');
    producer.pragma('synchronous = FULL');
    producer.pragma('wal_autocheckpoint = 0');
    expect(producer.pragma('wal_checkpoint(TRUNCATE)')).toEqual([
      expect.objectContaining({ busy: 0 }),
    ]);
    expect(
      producer.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at').all()
    ).toEqual(journal('core').map((entry) => ({ created_at: entry.when })));
    baseBytes = readFileSync(source.path);
    const future = journal('core').at(-1)!.when + 1;
    producer
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('actual-committed-WAL-future-native-opening', future);
    expect(producer.inTransaction).toBe(false);
    expect(
      producer.prepare('SELECT created_at FROM __drizzle_migrations WHERE created_at=?').get(future)
    ).toEqual({ created_at: future });
    expect(readFileSync(source.path)).toEqual(baseBytes);
    walBytes = readFileSync(`${source.path}-wal`);
    expect(walBytes.byteLength).toBeGreaterThan(32);
    // Target is a closed private canonical Core cut; omit its disposable cache before placement.
    rmSync(`${target.path}-shm`, { force: true });
    rmSync(`${target.path}-wal`, { force: true });
    copyFileSync(source.path, target.path);
    copyFileSync(`${source.path}-wal`, `${target.path}-wal`);
  } finally {
    producer.close();
  }
  // Observe bytes without opening target SQLite; a writable observer could itself checkpoint WAL.
  expect(readFileSync(target.path)).toEqual(baseBytes);
  expect(readFileSync(`${target.path}-wal`)).toEqual(walBytes);
  expect(existsSync(`${target.path}-shm`)).toBe(false);
  const baseIdentity = statSync(target.path);
  const walIdentity = statSync(`${target.path}-wal`);
  const beforeFiles = inventoryRegularFiles(dirname(target.path));
  const opening = getControlStoreWorkerClient().open(nativeOpening(target));
  await expect(opening).rejects.toBeInstanceOf(ControlStoreWorkerError);
  await expect(opening).rejects.toMatchObject({
    code: 'migration_unsupported_core',
    commit: 'not-committed',
  });
  await shutdownControlStoreWorkerClient();
  expect(readFileSync(target.path)).toEqual(baseBytes);
  expect(readFileSync(`${target.path}-wal`)).toEqual(walBytes);
  expect([statSync(target.path).dev, statSync(target.path).ino]).toEqual([
    baseIdentity.dev,
    baseIdentity.ino,
  ]);
  expect([statSync(`${target.path}-wal`).dev, statSync(`${target.path}-wal`).ino]).toEqual([
    walIdentity.dev,
    walIdentity.ino,
  ]);
  expectRefusalInventoryUnchanged(
    beforeFiles,
    inventoryRegularFiles(dirname(target.path)),
    basename(target.path)
  );
});

it('G1 Core boot integrity opening refuses unsupported committed WAL without changing base or WAL authority', async () => {
  const source = await fixture('core');
  const target = await fixture('core');
  const producer = new Database(source.path, { fileMustExist: true });
  let baseBytes: Buffer;
  let walBytes: Buffer;
  try {
    expect(producer.pragma('journal_mode = WAL', { simple: true })).toBe('wal');
    producer.pragma('synchronous = FULL');
    producer.pragma('wal_autocheckpoint = 0');
    expect(producer.pragma('wal_checkpoint(TRUNCATE)')).toEqual([
      expect.objectContaining({ busy: 0 }),
    ]);
    expect(
      producer.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at').all()
    ).toEqual(journal('core').map((entry) => ({ created_at: entry.when })));
    baseBytes = readFileSync(source.path);
    const future = journal('core').at(-1)!.when + 1;
    producer
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('actual-committed-WAL-future-boot-opening', future);
    expect(producer.inTransaction).toBe(false);
    expect(
      producer.prepare('SELECT created_at FROM __drizzle_migrations WHERE created_at=?').get(future)
    ).toEqual({ created_at: future });
    expect(readFileSync(source.path)).toEqual(baseBytes);
    walBytes = readFileSync(`${source.path}-wal`);
    expect(walBytes.byteLength).toBeGreaterThan(32);
    // Target is a closed private canonical Core cut; omit its disposable cache before placement.
    rmSync(`${target.path}-shm`, { force: true });
    rmSync(`${target.path}-wal`, { force: true });
    copyFileSync(source.path, target.path);
    copyFileSync(`${source.path}-wal`, `${target.path}-wal`);
  } finally {
    producer.close();
  }
  // Observe bytes without opening target SQLite; a writable observer could itself checkpoint WAL.
  expect(readFileSync(target.path)).toEqual(baseBytes);
  expect(readFileSync(`${target.path}-wal`)).toEqual(walBytes);
  expect(existsSync(`${target.path}-shm`)).toBe(false);
  const baseIdentity = statSync(target.path);
  const walIdentity = statSync(`${target.path}-wal`);
  const beforeFiles = inventoryRegularFiles(dirname(target.path));
  expectUnsupported(() => openExistingCoreDbWithIntegrityCheck(target.root).sqlite.close(), 'core');
  expect(readFileSync(target.path)).toEqual(baseBytes);
  expect(readFileSync(`${target.path}-wal`)).toEqual(walBytes);
  expect([statSync(target.path).dev, statSync(target.path).ino]).toEqual([
    baseIdentity.dev,
    baseIdentity.ino,
  ]);
  expect([statSync(`${target.path}-wal`).dev, statSync(`${target.path}-wal`).ino]).toEqual([
    walIdentity.dev,
    walIdentity.ino,
  ]);
  expectRefusalInventoryUnchanged(
    beforeFiles,
    inventoryRegularFiles(dirname(target.path)),
    basename(target.path)
  );
});
