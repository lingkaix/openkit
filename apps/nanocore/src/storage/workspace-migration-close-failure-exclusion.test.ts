// openkit-test-platform: posix
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { KnowledgeBaseIdSchema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { expect, it, onTestFinished } from 'vitest';
import { acquireDataRootLock, DataRootLockError, dataRootLockPath } from '../bootstrap/lock.js';
import { parseJsoncObject } from '../config/jsonc.js';
import { initializeDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { DEFAULT_NOTEBOOK_INDEX, KnowledgeNotebook } from '../knowledge/notebook.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { notebookImportFixture } from '../test-support/notebook-import.js';
import { createTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import type { CoreDb } from './db.js';
import { coreDbPath, resolveDataRootPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import * as schema from './schema/index.js';
import { preflightWorkspaceStorageMigration } from './workspace-storage-migration.js';

// The original954 builder is copied unchanged because that test exports no fixture
// and this dispatch owns only this additive file. Its three original cases stay unchanged.
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

/** The child retains the real refused-close receiver until actual process exit. */
const migrationChild = String.raw`
import { createRequire } from 'node:module';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
const config = JSON.parse(process.argv[1]);
const require = createRequire(config.driverPath);
const Database = require(config.driverPath);
const originalClose = Database.prototype.close;
const { register } = await import(config.loaderUrl);
register();
const { acquireDataRootLock, DataRootLockError } = await import(config.lockUrl);
const { migrateWorkspaceStorage } = await import(config.migrationUrl);
const identity = path => {
  const s = statSync(path, { bigint: true });
  return { device: String(s.dev), inode: String(s.ino) };
};
const errorRow = error => ({ name: error.name, message: error.message, code: error.code, stack: error.stack });
const attempts = [];
let receiver;
let statement;
let iterator;
let firstNext;
let queryOnly;
let lastCloseError;
let queued = false;
let migration = { state: 'pending' };
const device = {
  pid: process.pid, uid: process.getuid(), node: process.version, platform: process.platform,
  driverPath: config.driverPath,
  driverVersion: JSON.parse(readFileSync(config.driverPackagePath, 'utf8')).version,
};
const sample = kind => ({
  kind, device, migration, attempts,
  core: receiver ? {
    path: receiver.name, readonly: receiver.readonly, open: receiver.open,
    ...identity(receiver.name),
    statementBusy: statement?.busy ?? false, firstNext, queryOnly,
  } : null,
});
const boundary = () => {
  if (queued) return;
  queued = true;
  // The actual close/catch/finally stack and promise reactions run before this sample.
  // A corrected owner may keep the migration pending; that is not a failed precondition.
  setImmediate(() => process.send(sample('boundary')));
};
Database.prototype.close = function (...args) {
  if (this.name !== config.corePath || this.readonly) {
    return Reflect.apply(originalClose, this, args);
  }
  if (config.busyIterator && receiver && receiver !== this) {
    return Reflect.apply(originalClose, this, args);
  }
  receiver = this;
  if (config.busyIterator && !iterator) {
    queryOnly = this.pragma('query_only', { simple: true });
    statement = this.prepare('SELECT 1 AS value UNION ALL SELECT 2 AS value');
    iterator = statement.iterate();
    firstNext = iterator.next();
  }
  let peer;
  try {
    peer = acquireDataRootLock(config.dataRoot, { bootId: 'q07-before-original-close' });
  } catch (error) {
    if (!(error instanceof DataRootLockError)) throw error;
  }
  const attempt = {
    path: this.name, readonly: this.readonly, openBefore: this.open,
    ...identity(this.name), iteratorBusyBefore: statement?.busy ?? false,
    kernelPeerRefusedBeforeClose: peer === undefined,
    originalCloseInvoked: false,
  };
  peer?.release();
  attempts.push(attempt);
  try {
    attempt.originalCloseInvoked = true;
    const result = Reflect.apply(originalClose, this, args);
    attempt.threw = false;
    attempt.openAfter = this.open;
    return result;
  } catch (error) {
    lastCloseError = error;
    attempt.threw = true;
    attempt.error = errorRow(error);
    attempt.openAfter = this.open;
    attempt.iteratorBusyAfter = statement?.busy ?? false;
    // Keep the real throw-and-live frontier even if lawful containment exits immediately.
    // This file is outside both the source data root and its backup inventory.
    try { appendFileSync(config.closeLog, JSON.stringify(sample('frontier')) + '\n'); }
    catch (observationError) { process.stderr.write(String(observationError) + '\n'); }
    boundary();
    throw error; // Preserve the actual SDK exception; do not invent a refusal.
  }
};
process.on('message', command => {
  if (command === 'sample') process.send(sample('sample'));
  else if (command === 'exit') {
    // Do not close the receiver, return its iterator, checkpoint or unlink anything.
    // Actual owning-process exit is the only abnormal disposal performed by this test.
    process.exit(0);
  }
});
Promise.resolve(migrateWorkspaceStorage({ dataRoot: config.dataRoot, backupRoot: config.backupRoot }))
  .then(result => {
    migration = { state: 'fulfilled', result };
    boundary();
  }, error => {
    migration = {
      state: 'rejected', error: errorRow(error),
      originalCloseErrorPreserved: error === lastCloseError,
    };
    boundary();
  });
`;

interface PhysicalIdentity {
  device: string;
  inode: string;
}

interface CloseAttempt extends PhysicalIdentity {
  path: string;
  readonly: boolean;
  openBefore: boolean;
  openAfter: boolean;
  originalCloseInvoked: boolean;
  kernelPeerRefusedBeforeClose: boolean;
  iteratorBusyBefore: boolean;
  iteratorBusyAfter?: boolean;
  threw: boolean;
  error?: { name: string; message: string; code?: string };
}

interface ChildSample {
  kind: 'boundary' | 'sample' | 'frontier';
  device: { pid: number; uid: number; node: string; platform: string; driverVersion: string };
  migration: {
    state: 'pending' | 'fulfilled' | 'rejected';
    result?: { outcome: string; workspaceCount: number };
    error?: { name: string; message: string; code?: string };
  };
  attempts: CloseAttempt[];
  core:
    | (PhysicalIdentity & {
        path: string;
        readonly: boolean;
        open: boolean;
        statementBusy: boolean;
        firstNext?: { done: boolean; value: { value: number } };
        queryOnly?: number;
      })
    | null;
}

/** Each acquisition uses the unchanged ordinary owner and an independent file description. */
function ordinaryPeer(dataRoot: string) {
  try {
    return {
      refused: false,
      lock: acquireDataRootLock(dataRoot, { bootId: `q07-peer-${randomUUID()}` }),
    };
  } catch (error) {
    if (!(error instanceof DataRootLockError)) throw error;
    return { refused: true, lock: undefined };
  }
}

function identity(path: string): PhysicalIdentity {
  const s = statSync(path, { bigint: true });
  return { device: String(s.dev), inode: String(s.ino) };
}

/** A real owner conflict/release calibration, not a lockfile-presence check. */
function calibrateKernel(dataRoot: string) {
  mkdirSync(dirname(dataRootLockPath(dataRoot)), { recursive: true });
  const first = ordinaryPeer(dataRoot);
  expect(first.refused, 'Q07 kernel calibration: initial owner acquires').toBe(false);
  try {
    const second = ordinaryPeer(dataRoot);
    second.lock?.release();
    expect(second.refused, 'Q07 kernel calibration: independent owner conflicts').toBe(true);
  } finally {
    first.lock?.release();
  }
  const released = ordinaryPeer(dataRoot);
  released.lock?.release();
  expect(released.refused, 'Q07 kernel calibration: released owner reacquires').toBe(false);
}

/** Test-only argv shape; no production message or record is added. */
interface MigrationChildInput {
  dataRoot: string;
  backupRoot: string;
  busyIterator: boolean;
  corePath: string;
  closeLog: string;
  driverPath: string;
  driverPackagePath: string;
  loaderUrl: string;
  migrationUrl: string;
  lockUrl: string;
}

/** Starts only the actual public migration; no Vitest code is imported by the child. */
function childMigration(dataRoot: string, backupRoot: string, busyIterator: boolean) {
  const require = createRequire(import.meta.url);
  const config: MigrationChildInput = {
    dataRoot,
    backupRoot,
    busyIterator,
    corePath: coreDbPath(dataRoot),
    closeLog: `${dataRoot}.close-observations.jsonl`,
    driverPath: require.resolve('better-sqlite3'),
    driverPackagePath: require.resolve('better-sqlite3/package.json'),
    loaderUrl: pathToFileURL(require.resolve('tsx/esm/api')).href,
    migrationUrl: new URL('./workspace-storage-migration.ts', import.meta.url).href,
    lockUrl: new URL('../bootstrap/lock.ts', import.meta.url).href,
  };
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', migrationChild, JSON.stringify(config)],
    {
      // Do not inherit credentials or the parent's test-observer NODE_OPTIONS.
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const joined = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const next = () =>
    new Promise<ChildSample | undefined>((resolve, reject) => {
      const cleanup = () => {
        child.off('message', message);
        child.off('error', error);
        child.off('close', exited);
      };
      const message = (value: unknown) => {
        cleanup();
        resolve(value as ChildSample);
      };
      const error = (value: Error) => {
        cleanup();
        reject(value);
      };
      const exited = () => {
        cleanup();
        resolve(undefined);
      };
      child.once('message', message);
      child.once('error', error);
      child.once('close', exited);
    });
  const initial = next();
  return {
    child,
    initial,
    joined,
    config,
    sample: () => {
      if (!child.connected) return joined.then(() => undefined);
      const result = next();
      child.send('sample', () => undefined);
      return result;
    },
    raw: () => ({ stdout, stderr }),
    exit: () => child.send('exit', () => undefined),
  };
}

/** Allows genuine owning-process containment, without requiring a redundant live child. */
async function exitedFault(
  owned: ReturnType<typeof childMigration>,
  dataRoot: string,
  expectedIdentity: PhysicalIdentity
) {
  const exit = await owned.joined; // Actual OS child close, not a terminate Promise.
  if (existsSync(owned.config.closeLog)) {
    console.info('Q07 preserved early-exit frontier', readFileSync(owned.config.closeLog, 'utf8'));
  }
  console.info('Q07 actual early-exit status', JSON.stringify(exit));
  expect(
    existsSync(owned.config.closeLog),
    'Q07 real close frontier must precede physical exit'
  ).toBe(true);
  const frontiers = readFileSync(owned.config.closeLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ChildSample);
  const frontier = frontiers.find((frame) =>
    frame.attempts.some(
      (attempt) =>
        attempt.originalCloseInvoked &&
        attempt.threw &&
        attempt.openAfter &&
        attempt.iteratorBusyAfter
    )
  );
  expect(frontier?.device).toMatchObject({
    pid: owned.child.pid,
    node: process.version,
    platform: process.platform,
    driverVersion: '13.0.3',
    uid: process.getuid?.(),
  });
  expect(
    frontier?.core,
    'Q07 actual SDK throw-and-live frontier, not a synthetic exit'
  ).toMatchObject({
    path: coreDbPath(dataRoot),
    readonly: false,
    open: true,
    statementBusy: true,
    firstNext: { done: false, value: { value: 1 } },
    ...expectedIdentity,
  });
  expect(
    frontier?.attempts.some(
      (attempt) =>
        attempt.originalCloseInvoked &&
        attempt.threw &&
        attempt.openAfter &&
        attempt.iteratorBusyBefore &&
        attempt.iteratorBusyAfter &&
        attempt.kernelPeerRefusedBeforeClose
    )
  ).toBe(true);
  const peer = ordinaryPeer(dataRoot); // Only after the actual owning process has exited.
  peer.lock?.release();
  console.info(
    'Q07 actual early owner exit',
    JSON.stringify({ exit, frontiers, peerRefused: peer.refused })
  );
  expect(peer.refused, 'Q07 ordinary root owner acquires after proved physical owner exit').toBe(
    false
  );
}

/** Real migration/driver/kernel seam (L2); no server boot or container API is needed. */
it.each([false, true])(
  'keeps exclusion until canonical Core physically closes or its owner exits (busyIterator=%s)',
  async (busyIterator) => {
    const fixture = createMigrationFixture();
    const backupRoot = `${fixture.dataRoot}.backup`;
    let owned: ReturnType<typeof childMigration> | undefined;
    onTestFinished(async () => {
      // Vitest timeout does not cancel an awaited child Promise. Join any owned child
      // even on that NONDECIDING path; this finalizer never supplies product success.
      if (owned && owned.child.exitCode === null && owned.child.signalCode === null) {
        owned.child.kill('SIGTERM');
        await owned.joined;
      }
    });
    try {
      await createNativeLayoutSource(
        sourceWorkspaceRoot(fixture),
        fixture.workspaceId,
        fixture.ownerUserId
      );
      expect(
        preflightWorkspaceStorageMigration({
          coreDb: fixture.coreDb,
          dataRoot: fixture.dataRoot,
        }).diagnostics,
        'Q07 supported original predecessor fixture'
      ).toEqual([]);
      fixture.coreDb.sqlite.close();
      await shutdownControlStoreWorkerClient();
      calibrateKernel(fixture.dataRoot);
      const expectedIdentity = identity(coreDbPath(fixture.dataRoot));
      owned = childMigration(fixture.dataRoot, backupRoot, busyIterator);
      console.info('Q07 actual child argv', JSON.stringify(owned.config));
      const boundary = await owned.initial;
      console.info('Q07 original child boundary', JSON.stringify(boundary));
      if (!boundary) {
        expect(busyIterator, 'Q07 normal migration must reach its live-child success control').toBe(
          true
        );
        await exitedFault(owned, fixture.dataRoot, expectedIdentity);
        return;
      }
      expect(boundary.kind, 'Q07 actual child evidence boundary').toBe('boundary');
      expect(boundary.device).toMatchObject({
        node: process.version,
        platform: process.platform,
        driverVersion: '13.0.3',
        uid: process.getuid?.(),
      });
      expect(boundary.device.pid).toBe(owned.child.pid);
      expect(boundary.core, 'Q07 actual canonical Core close seam reached').not.toBeNull();
      expect(boundary.attempts.length).toBeGreaterThan(0);
      for (const attempt of boundary.attempts) {
        expect(attempt).toMatchObject({
          path: coreDbPath(fixture.dataRoot),
          readonly: false,
          openBefore: true,
          originalCloseInvoked: true,
          kernelPeerRefusedBeforeClose: true,
          ...expectedIdentity,
        });
      }
      if (busyIterator) {
        // SDK13 source-derived fault preconditions, not the product deciding predicate.
        expect(boundary.core).toMatchObject({
          readonly: false,
          open: true,
          statementBusy: true,
          queryOnly: 0,
          firstNext: { done: false, value: { value: 1 } },
          ...expectedIdentity,
        });
        expect(
          boundary.attempts.some(
            (attempt) =>
              attempt.threw &&
              attempt.openAfter &&
              attempt.iteratorBusyBefore &&
              attempt.iteratorBusyAfter
          ),
          'Q07 original SDK close must actually throw and leave its real iterator/handle alive'
        ).toBe(true);
        // Observe pending/rejected/error classes; none substitutes for physical custody.
      } else {
        expect(boundary.migration).toMatchObject({
          state: 'fulfilled',
          result: { outcome: 'succeeded', workspaceCount: 1 },
        });
        expect(boundary.core?.open).toBe(false);
        expect(boundary.attempts.every((attempt) => !attempt.threw && !attempt.openAfter)).toBe(
          true
        );
      }
      const beforePeer = await owned.sample();
      if (!beforePeer) {
        expect(busyIterator, 'Q07 normal root-release control needs its live child').toBe(true);
        await exitedFault(owned, fixture.dataRoot, expectedIdentity);
        return;
      }
      const peer = ordinaryPeer(fixture.dataRoot);
      let afterPeer: ChildSample | undefined;
      try {
        afterPeer = await owned.sample();
      } finally {
        peer.lock?.release();
      }
      if (!afterPeer) {
        console.info(
          'Q07 exit crossed peer sample',
          JSON.stringify({ beforePeer, peerRefused: peer.refused })
        );
        expect(busyIterator, 'Q07 normal root-release control needs its live child').toBe(true);
        if (!peer.refused) {
          throw new Error(
            'Q07 UNKNOWN: successful peer acquisition crossed actual exit; no live overlap was proved'
          );
        }
        await exitedFault(owned, fixture.dataRoot, expectedIdentity);
        return;
      }
      if (busyIterator) {
        for (const sample of [beforePeer, afterPeer]) {
          expect(sample.core).toMatchObject({
            path: coreDbPath(fixture.dataRoot),
            readonly: false,
            open: true,
            statementBusy: true,
            ...expectedIdentity,
          });
          // Operation settlement is retained as evidence, not a permissible-outcome switch.
        }
      } else {
        for (const sample of [beforePeer, afterPeer]) {
          expect(sample.core).toMatchObject({
            path: coreDbPath(fixture.dataRoot),
            readonly: false,
            open: false,
            ...expectedIdentity,
          });
          expect(sample.migration).toMatchObject({
            state: 'fulfilled',
            result: { outcome: 'succeeded', workspaceCount: 1 },
          });
        }
      }
      // Preserve the deciding interval before actual exit. No iterator return/close supplies it.
      const deciding = {
        busyIterator,
        boundary,
        beforePeer,
        afterPeer,
        peerRefused: peer.refused,
        peerPid: process.pid,
        peerAcquisition: peer.lock?.acquisition,
      };
      console.info('Q07 actual throw-and-live kernel interval', JSON.stringify(deciding));
      owned.exit();
      const exit = await owned.joined;
      if (!busyIterator) {
        expect(exit, 'Q07 normal child follows its explicit successful exit request').toEqual({
          code: 0,
          signal: null,
        });
      }
      // For the fault, keep the actual exit status/signal; physical exit is not an error-class policy.
      const afterExit = ordinaryPeer(fixture.dataRoot);
      afterExit.lock?.release();
      console.info(
        'Q07 actual process-exit release',
        JSON.stringify({ exit, peerRefused: afterExit.refused })
      );
      expect(afterExit.refused, 'Q07 ordinary kernel owner acquires after actual owner exit').toBe(
        false
      );
      // Core Storage physical lifetime: error is not permission to release a live RW owner.
      expect(
        peer.refused,
        busyIterator
          ? 'Q07 root exclusion must survive actual SDK close throw while canonical Core remains open'
          : 'Q07 normal physical close must release ordinary root exclusion'
      ).toBe(busyIterator);
    } finally {
      if (owned) {
        if (owned.child.exitCode === null && owned.child.signalCode === null)
          owned.child.kill('SIGTERM');
        await owned.joined;
        console.info('Q07 owned child raw output', JSON.stringify(owned.raw()));
        if (existsSync(owned.config.closeLog)) {
          console.info(
            'Q07 preserved actual close frontiers',
            readFileSync(owned.config.closeLog, 'utf8')
          );
        }
      }
      await shutdownControlStoreWorkerClient();
      if (fixture.coreDb.sqlite.open) fixture.coreDb.sqlite.close();
      rmSync(fixture.dataRoot, { recursive: true, force: true });
      rmSync(backupRoot, { recursive: true, force: true });
      if (owned) rmSync(owned.config.closeLog, { force: true });
    }
  }
);
