// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { FsStore } from '../lib/store.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { inventoryRegularFiles, writeHotDataRootBackup } from './data-root-backup.js';
import { type CoreDb, openCoreDb } from './db.js';
import { coreDbPath, readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import {
  parseWorkspaceBackupManifest,
  withVerifiedWorkspaceBackupBundle,
} from './workspace-backup-bundle.js';
import { nativeProductScope } from './workspace-file-records.js';
import {
  runWorkspaceRecoveryCli,
  type WorkspaceRecoveryCliReport,
  WorkspaceRecoveryError,
} from './workspace-recovery-cli.js';
import { admitWorkspaceBackup } from './workspace-restore.js';

const workspaceId = DEMO_WORKSPACE_ID;
const release = { releaseTag: 'v0.1.0-rc.11', sourceCommit: '1'.repeat(40) };
const roots: string[] = [];
// Same production function, with the coordinator's optional release-path dependency contract.
const runCli: (
  argv: readonly string[],
  write?: (line: string) => void,
  deps?: { releaseIdentityPath?: string }
) => Promise<WorkspaceRecoveryCliReport> = runWorkspaceRecoveryCli;
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Hashes fixture-owned bytes independently of the bundle parser. */
function sha(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Reads retained rows without creating or migrating an absent authority. */
function rows(path: string, table: string): unknown[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  } finally {
    db.close();
  }
}

/** Copies a stopped owner's actual files, preserving required modes and omitting empty directories. */
function copyInventory(source: string, target: string, relative = '') {
  const result: { path: string; bytes: number; sha256: string; mode: number }[] = [];
  for (const name of readdirSync(join(source, relative)).sort()) {
    const path = relative ? `${relative}/${name}` : name;
    if (/^(indexes|logs|projections)(\/|$)/.test(path)) continue;
    const from = join(source, path);
    const stat = statSync(from);
    if (stat.isDirectory()) result.push(...copyInventory(source, target, path));
    else {
      expect(stat.isFile()).toBe(true);
      const to = join(target, path);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      copyFileSync(from, to);
      chmodSync(to, stat.mode & 0o777);
      const bytes = readFileSync(to);
      result.push({ path, bytes: bytes.length, sha256: sha(bytes), mode: stat.mode & 0o777 });
    }
  }
  return result;
}

/** Seeds an ordinary active account in the same canonical table used by identity fixtures. */
function account(db: CoreDb) {
  const id = allocateEntityId('usr');
  db.sqlite
    .prepare(`INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, status)
    VALUES (?, 'human', 'MOVE fixture', ?, 0, ?, ?, 'active')`)
    .run(id, `${id}@example.invalid`, Date.now(), Date.now());
  return id;
}

/** Seals actual source snapshots independently of the D0 capture or move-out implementation. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'd0-move-'));
  roots.push(root);
  const sourceRoot = join(root, 'source');
  const store = await createDemoStore({ dataRoot: sourceRoot });
  const sourceCore = openCoreDb(sourceRoot);
  const sourceOwner = ensureLocalUser(sourceCore);
  const sourceMember = account(sourceCore);
  recordWorkspaceOwnerMembership({ coreDb: sourceCore, workspaceId, ownerUserId: sourceOwner });
  const now = new Date().toISOString();
  sourceCore.sqlite
    .prepare(`INSERT INTO workspace_members
    (workspace_id,user_id,status,invitation_id,joined_at,removed_at,revision,created_at,updated_at)
    VALUES (?,?,'active',NULL,?,NULL,1,?,?)`)
    .run(workspaceId, sourceMember, now, now, now);
  sourceCore.sqlite.close();
  const mappedThread = await store.createThread(
    workspaceId,
    'Explicitly mapped private history',
    undefined,
    'conversation',
    { visibility: 'private', privateOwnerUserId: sourceMember }
  );
  const unmappedThread = await store.createThread(
    workspaceId,
    'Unmapped private history',
    undefined,
    'conversation',
    { visibility: 'private', privateOwnerUserId: sourceOwner }
  );
  await shutdownControlStoreWorkerClient();
  const sourceDeploymentId = readDataRootLayoutMarker(sourceRoot).deploymentId;
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot: sourceRoot,
    scope: { kind: 'workspace', workspaceId },
  });
  const parent = join(root, 'parent');
  await writeHotDataRootBackup({
    dataRoot: sourceRoot,
    backupRoot: parent,
    backupId: allocateEntityId('drb'),
    sourceDeploymentId,
    startedAt: now,
    completedAt: now,
  });
  const bundleRoot = join(root, 'bundle');
  mkdirSync(bundleRoot, { mode: 0o700 });
  const inventory = copyInventory(join(parent, 'workspaces', workspaceId), bundleRoot);
  const sourceDb = new Database(workspaceDbPath(sourceRoot, workspaceId), {
    readonly: true,
    fileMustExist: true,
  });
  let capturedRevision: number;
  try {
    capturedRevision = sourceDb
      .prepare('SELECT revision FROM control_workspaces WHERE id=?')
      .pluck()
      .get(workspaceId) as number;
  } finally {
    sourceDb.close();
  }
  const manifest = parseWorkspaceBackupManifest({
    format: 'openkit-workspace-backup',
    version: 1,
    purpose: 'move',
    backupId: allocateEntityId('wsbak'),
    workspaceId,
    sourceDeploymentId,
    knowledgeBaseIds: [knowledgeBaseId],
    capturedRevision,
    priorMoves: [],
    release: { version: release.releaseTag, buildId: release.sourceCommit },
    requiredFeatures: [],
    databaseFormats: [{ path: 'db/workspace.sqlite', markers: { 'drizzle.workspace': 20 } }],
    capture: { startedAt: now, completedAt: now, consistency: 'quiescent' },
    inventory,
    inventoryDigest: sha(JSON.stringify(inventory)),
    coverage: {
      includedAuthorities: ['workspace-control', 'workspace-content', 'knowledge'],
      snapshotRoots: ['db', 'knowledge', 'evidence', 'config'],
      omittedProjections: ['indexes', 'logs', 'projections'],
      omittedVolumes: [],
      externalDependencies: [],
    },
    accounts: {
      ownerId: sourceOwner,
      memberIds: [sourceOwner, sourceMember],
      privateAudienceRefs: [sourceOwner, sourceMember],
    },
  });
  const raw = JSON.stringify(manifest);
  writeFileSync(join(bundleRoot, 'manifest.json'), raw, { mode: 0o600 });
  writeFileSync(
    join(bundleRoot, 'seal.json'),
    JSON.stringify({
      format: 'openkit-workspace-backup-seal',
      version: 1,
      backupId: manifest.backupId,
      purpose: 'move',
      manifestDigest: sha(raw),
    }),
    { mode: 0o600 }
  );
  const releaseIdentityPath = join(root, 'release-identity.json');
  writeFileSync(releaseIdentityPath, JSON.stringify(release), { mode: 0o600 });
  mkdirSync(join(root, 'staging'));
  await withVerifiedWorkspaceBackupBundle(
    {
      bundleRoot,
      stagingParent: join(root, 'staging'),
      admission: new FileStorageAdmission(root, () => 0n),
      expectedRelease: manifest.release,
      supportedDatabaseFormats: { 'drizzle.workspace': 20 },
    },
    async (verified) => {
      expect(verified.manifest).toEqual(manifest);
    }
  );
  const dataRoot = join(root, 'target');
  const target = openCoreDb(dataRoot);
  applyMigrations(target);
  ensureLocalUser(target);
  const targetOwner = account(target);
  const targetMember = account(target);
  target.sqlite.close();
  const requestId = randomUUID();
  const argv = [
    'move-in',
    '--data-root',
    dataRoot,
    '--bundle-root',
    bundleRoot,
    '--request-id',
    requestId,
    '--target-owner-id',
    targetOwner,
    '--member-map',
    `${sourceMember}=${targetMember}`,
  ];
  return {
    root,
    sourceRoot,
    dataRoot,
    sourceOwner,
    sourceMember,
    targetOwner,
    targetMember,
    mappedThread,
    unmappedThread,
    knowledgeBaseId,
    bundleRoot,
    manifest,
    manifestDigest: sha(raw),
    requestId,
    releaseIdentityPath,
    argv,
  };
}

/** Retains a real prepared MOVE after placement, before its registration transaction. */
async function placedMoveFixture() {
  const f = await fixture();
  let placed = false;
  await expect(
    admitWorkspaceBackup(
      {
        command: 'move-in',
        dataRoot: f.dataRoot,
        bundleRoot: f.bundleRoot,
        requestId: f.requestId,
        targetOwnerId: f.targetOwner,
        memberMappings: [{ sourceAccountId: f.sourceMember, targetAccountId: f.targetMember }],
        expectedRelease: f.manifest.release,
      },
      {
        atBoundary(boundary) {
          if (boundary !== 'after-target-rename') return;
          placed = true;
          throw new Error('Retain the real placed MOVE for selected registration.');
        },
      }
    )
  ).rejects.toMatchObject({ code: 'recovery-required' });
  expect(placed).toBe(true);
  return f;
}

/** Exact public refusal, with no untrusted text or success line. */
async function refuses(f: Awaited<ReturnType<typeof fixture>>, code: string, argv = f.argv) {
  const output: string[] = [];
  const error: unknown = await runCli(argv, (line) => output.push(line), f).catch(
    (value: unknown) => value
  );
  expect(error).toBeInstanceOf(WorkspaceRecoveryError);
  expect((error as WorkspaceRecoveryError).code).toBe(code);
  expect(output).toEqual([]);
  expect(String(error)).not.toContain(f.root);
}

/** A real SQLite trigger makes member registration fail inside the actual Core transaction. */
function refuseMemberCommit(dataRoot: string) {
  const db = new Database(coreDbPath(dataRoot), { fileMustExist: true });
  try {
    db.exec(`CREATE TRIGGER d0_refuse_members BEFORE INSERT ON workspace_members
    WHEN NEW.workspace_id='${workspaceId}' BEGIN SELECT RAISE(ABORT,'D0_MEMBER_COMMIT_FAULT'); END`);
  } finally {
    db.close();
  }
}

describe('D0-2 identity-preserving MOVE target admission', () => {
  it('WM 405, 419–439: explicit owner/member mapping preserves identities, provenance and private audiences', async () => {
    const f = await fixture();
    const output: string[] = [];
    const promise = runCli(f.argv, (line) => output.push(line), f);
    await expect(promise).resolves.toMatchObject({
      command: 'move-in',
      disposition: 'imported',
      workspaceId,
      nextAction: 'none',
      droppedSourceMemberIds: [f.sourceOwner],
      restrictedRecovery: false,
      capture: {
        backupId: f.manifest.backupId,
        manifestDigest: f.manifestDigest,
        sourceDeploymentId: f.manifest.sourceDeploymentId,
        knowledgeBaseIds: [f.knowledgeBaseId],
      },
    });
    const report = await promise;
    expect(rows(coreDbPath(f.dataRoot), 'workspace_registry')).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        owner_user_id: f.targetOwner,
        status: 'active',
      }),
    ]);
    expect(rows(coreDbPath(f.dataRoot), 'workspace_members')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace_id: workspaceId,
          user_id: f.targetOwner,
          status: 'active',
        }),
        expect.objectContaining({
          workspace_id: workspaceId,
          user_id: f.targetMember,
          status: 'active',
        }),
      ])
    );
    expect(rows(coreDbPath(f.dataRoot), 'workspace_members')).toHaveLength(2);
    expect(
      readDefaultKnowledgeBaseId({
        dataRoot: f.dataRoot,
        scope: { kind: 'workspace', workspaceId },
      })
    ).toBe(f.knowledgeBaseId);
    const store = new FsStore({ dataRoot: f.dataRoot });
    expect(store.getWorkspace(workspaceId)).toMatchObject({
      id: workspaceId,
      importedFrom: {
        sourceWorkspaceId: workspaceId,
        sourceDeploymentId: f.manifest.sourceDeploymentId,
        manifestDigest: f.manifestDigest,
      },
    });
    expect(isThreadIdVisible(store, workspaceId, f.mappedThread.id, f.targetMember)).toBe(true);
    expect(isThreadIdVisible(store, workspaceId, f.mappedThread.id, f.targetOwner)).toBe(false);
    expect(isThreadIdVisible(store, workspaceId, f.unmappedThread.id, f.targetMember)).toBe(false);
    expect(isThreadIdVisible(store, workspaceId, f.unmappedThread.id, f.targetOwner)).toBe(false);
    expect(store.getThread(workspaceId, f.unmappedThread.id).visibility).toBe('private');
    expect(output.map((line) => JSON.parse(line))).toEqual([report]);
    expect(output.join('')).not.toContain(f.root);
  }, 120_000);

  it.each([
    'absent owner',
    'inactive owner',
    'inactive member',
    'unknown source member',
    'duplicate source map',
  ] as const)('WM 419–421: %s refuses mapping-refused without target registration', async (fault) => {
    const f = await fixture();
    let argv = f.argv;
    const core = openCoreDb(f.dataRoot);
    try {
      if (fault === 'absent owner')
        argv = argv.map((value) => (value === f.targetOwner ? allocateEntityId('usr') : value));
      if (fault === 'inactive owner' || fault === 'inactive member') {
        core.sqlite.transaction(() =>
          disableCanonicalUser(core, fault === 'inactive owner' ? f.targetOwner : f.targetMember)
        )();
      }
      if (fault === 'unknown source member')
        argv = [
          ...argv.slice(0, -2),
          '--member-map',
          `${allocateEntityId('usr')}=${f.targetMember}`,
        ];
      if (fault === 'duplicate source map')
        argv = [...argv, '--member-map', `${f.sourceMember}=${f.targetOwner}`];
    } finally {
      core.sqlite.close();
    }
    const members = rows(coreDbPath(f.dataRoot), 'workspace_members');
    await refuses(f, 'mapping-refused', argv);
    expect(rows(coreDbPath(f.dataRoot), 'workspace_registry')).toEqual([]);
    expect(rows(coreDbPath(f.dataRoot), 'workspace_members')).toEqual(members);
    expect(existsSync(join(f.dataRoot, 'workspaces', workspaceId))).toBe(false);
  }, 120_000);

  it.each([
    'registry',
    'unregistered final directory',
  ] as const)('WM 405, 435, 441: unrelated %s collision refuses identity-collision without reminting', async (collision) => {
    const f = await fixture();
    if (collision === 'registry') {
      const core = openCoreDb(f.dataRoot);
      recordWorkspaceOwnerMembership({ coreDb: core, workspaceId, ownerUserId: f.targetOwner });
      core.sqlite.close();
    } else {
      cpSync(
        join(f.sourceRoot, 'workspaces', workspaceId),
        join(f.dataRoot, 'workspaces', workspaceId),
        { recursive: true }
      );
    }
    const before = rows(coreDbPath(f.dataRoot), 'workspace_registry');
    await refuses(f, 'identity-collision');
    expect(rows(coreDbPath(f.dataRoot), 'workspace_registry')).toEqual(before);
    expect(
      readdirSync(join(f.dataRoot, 'workspaces')).filter((name) => name.startsWith('ws_'))
    ).toEqual(collision === 'registry' ? [] : [workspaceId]);
  }, 120_000);

  it('WM 434–435: exact committed retry wins before inactive mapping or damaged bundle is revalidated', async () => {
    const f = await fixture();
    const promise = runCli(f.argv, () => {}, f);
    await expect(promise).resolves.toMatchObject({ disposition: 'imported' });
    const committed = await promise;
    const core = openCoreDb(f.dataRoot);
    core.sqlite.transaction(() => disableCanonicalUser(core, f.targetMember))();
    core.sqlite.close();
    writeFileSync(join(f.bundleRoot, 'seal.json'), 'AFTER-COMMIT-DAMAGE');
    const registry = rows(coreDbPath(f.dataRoot), 'workspace_registry');
    const members = rows(coreDbPath(f.dataRoot), 'workspace_members');
    await expect(runCli(f.argv, () => {}, f)).resolves.toEqual(committed);
    expect(rows(coreDbPath(f.dataRoot), 'workspace_registry')).toEqual(registry);
    expect(rows(coreDbPath(f.dataRoot), 'workspace_members')).toEqual(members);
  }, 120_000);

  it('WM 434–435: changed owner under a committed request refuses request-conflict', async () => {
    const f = await fixture();
    await expect(runCli(f.argv, () => {}, f)).resolves.toMatchObject({ disposition: 'imported' });
    await refuses(
      f,
      'request-conflict',
      f.argv.map((value) => (value === f.targetOwner ? f.targetMember : value))
    );
  }, 120_000);

  it('WM 438–441: failed member INSERT rolls back registration/result, then exact owned finish commits once', async () => {
    const f = await fixture();
    refuseMemberCommit(f.dataRoot);
    await refuses(f, 'recovery-required');
    expect(rows(coreDbPath(f.dataRoot), 'workspace_registry')).toEqual([]);
    expect(rows(coreDbPath(f.dataRoot), 'workspace_members')).toEqual([]);
    const select = [
      '--data-root',
      f.dataRoot,
      '--workspace-id',
      workspaceId,
      '--request-id',
      f.requestId,
    ];
    await expect(runCli(['inspect', ...select], () => {}, f)).resolves.toMatchObject({
      command: 'inspect',
      disposition: 'quarantined',
      workspaceId,
      selection: { kind: 'admission', requestId: f.requestId },
    });
    const core = new Database(coreDbPath(f.dataRoot), { fileMustExist: true });
    core.exec('DROP TRIGGER d0_refuse_members');
    core.close();
    await expect(runCli(['finish', ...select], () => {}, f)).resolves.toMatchObject({
      command: 'finish',
      disposition: 'imported',
      workspaceId,
      capture: { backupId: f.manifest.backupId, manifestDigest: f.manifestDigest },
    });
    expect(rows(coreDbPath(f.dataRoot), 'workspace_registry')).toHaveLength(1);
    expect(rows(coreDbPath(f.dataRoot), 'workspace_members')).toHaveLength(2);
    await expect(runCli(f.argv, () => {}, f)).resolves.toMatchObject({ disposition: 'imported' });
    expect(rows(coreDbPath(f.dataRoot), 'workspace_members')).toHaveLength(2);
  }, 120_000);

  it('rolls the complete placed MOVE registration and result back after a late admission failure, then explicitly finishes once', async () => {
    const f = await placedMoveFixture();
    const corePath = coreDbPath(f.dataRoot);
    const tuple = () =>
      Object.fromEntries(
        [
          'workspace_recovery_admissions',
          'workspace_registry',
          'workspace_members',
          'audit_events',
        ].map((table) => [table, rows(corePath, table)])
      );
    const before = tuple();
    const placedBytes = inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId));
    const sealedBytes = inventoryRegularFiles(f.bundleRoot);
    expect(before.workspace_registry).toEqual([]);
    expect(before.workspace_members).toEqual([]);
    const fault = new Database(corePath, { fileMustExist: true });
    try {
      // Fail after the new registry, both memberships and the terminal result
      // have run, at the final admission state change in their same transaction.
      fault.exec(`CREATE TRIGGER d0_refuse_target_terminal
        BEFORE UPDATE OF state ON workspace_recovery_admissions
        WHEN NEW.state='finished'
        BEGIN SELECT RAISE(ABORT, 'TARGET_TERMINAL_FAULT'); END`);
    } finally {
      fault.close();
    }
    const select = [
      '--data-root',
      f.dataRoot,
      '--workspace-id',
      workspaceId,
      '--request-id',
      f.requestId,
    ];
    await refuses(f, 'recovery-required', ['finish', ...select]);
    expect(tuple()).toEqual(before);
    expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId))).toEqual(placedBytes);
    expect(inventoryRegularFiles(f.bundleRoot)).toEqual(sealedBytes);
    await expect(runCli(['inspect', ...select], () => {}, f)).resolves.toMatchObject({
      disposition: 'quarantined',
      selection: { kind: 'admission', requestId: f.requestId },
    });
    const repair = new Database(corePath, { fileMustExist: true });
    try {
      repair.exec('DROP TRIGGER d0_refuse_target_terminal');
    } finally {
      repair.close();
    }
    await expect(runCli(['finish', ...select], () => {}, f)).resolves.toMatchObject({
      command: 'finish',
      disposition: 'imported',
      workspaceId,
    });
    const committed = tuple();
    expect(committed.workspace_registry).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        owner_user_id: f.targetOwner,
        status: 'active',
      }),
    ]);
    expect(committed.workspace_members).toEqual(
      expect.arrayContaining(
        [f.targetOwner, f.targetMember].map((user_id) =>
          expect.objectContaining({ workspace_id: workspaceId, user_id, status: 'active' })
        )
      )
    );
    expect(committed.workspace_members).toHaveLength(2);
    const admission = committed.workspace_recovery_admissions![0] as {
      state: string;
      proof_json: string;
    };
    expect(admission.state).toBe('finished');
    expect(JSON.parse(admission.proof_json).result).toMatchObject({
      disposition: 'imported',
      workspaceId,
    });
    await expect(runCli(f.argv, () => {}, f)).resolves.toEqual(
      JSON.parse(admission.proof_json).result
    );
    expect(tuple()).toEqual(committed);
    expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId))).toEqual(placedBytes);
    expect(inventoryRegularFiles(f.bundleRoot)).toEqual(sealedBytes);
  }, 120_000);

  it.each([
    'owner',
    'member',
  ] as const)('refuses the selected MOVE when its mapped %s becomes disabled during the actual Core posting hold', async (accountKind) => {
    const f = await placedMoveFixture();
    const scope = nativeProductScope(f.dataRoot, { kind: 'server' });
    const database = `core:${scope.path}`;
    const client = getControlStoreWorkerClient();
    await client.open({
      database,
      path: scope.path,
      dataRoot: f.dataRoot,
      create: false,
      initialize: 'core',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    let release = await client.pauseForDataRootBackup(database);
    const tuple = () =>
      Object.fromEntries(
        [
          'workspace_recovery_admissions',
          'workspace_registry',
          'workspace_members',
          'audit_events',
        ].map((table) => [table, rows(scope.path, table)])
      );
    const before = tuple();
    const placed = inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId));
    const publication = vi.spyOn(client, 'recoveryTargetRegistration');
    const actualOpen = client.open.bind(client);
    let upstreamOpenRejected = false;
    let upstreamOpenFailure: unknown;
    const opening = vi.spyOn(client, 'open').mockImplementation((...args) => {
      const operation = actualOpen(...args);
      void operation.catch((error: unknown) => {
        if (args[0].database === database) {
          upstreamOpenRejected = true;
          upstreamOpenFailure = error;
        }
      });
      return operation;
    });
    const posts = vi.spyOn(Worker.prototype, 'postMessage');
    const registrationPosts = () =>
      posts.mock.calls.filter(
        ([message]) =>
          message.operation === 'recovery-target-registration' &&
          message.database === database &&
          message.input?.admissionId === f.requestId &&
          message.input?.workspaceId === workspaceId
      );
    let settled = false;
    const command = runCli(
      [
        'finish',
        '--data-root',
        f.dataRoot,
        '--workspace-id',
        workspaceId,
        '--request-id',
        f.requestId,
      ],
      () => {},
      f
    ).then(
      (result) => {
        settled = true;
        return { result };
      },
      (error) => {
        settled = true;
        return { error };
      }
    );
    try {
      // A failed Core open can start cleanup before the producer settles. Its
      // close needs this hold released, so observe the real rejection separately.
      while (!publication.mock.calls.length && !settled && !upstreamOpenRejected) await nextTurn();
      expect(
        upstreamOpenFailure,
        'Actual selected Core open rejected before registration.'
      ).toBeUndefined();
      expect(publication).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(registrationPosts()).toEqual([]);
      const writer = openCoreDb(f.dataRoot);
      try {
        writer.sqlite
          .transaction(() =>
            disableCanonicalUser(writer, accountKind === 'owner' ? f.targetOwner : f.targetMember)
          )
          .immediate();
      } finally {
        writer.sqlite.close();
      }
      release();
      release = () => {};
      expect(await command).toMatchObject({ error: { code: 'mapping-refused' } });
      expect(registrationPosts()).toHaveLength(1);
      expect(tuple()).toEqual(before);
      expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId))).toEqual(placed);
    } finally {
      release();
      await command;
      opening.mockRestore();
      publication.mockRestore();
      posts.mockRestore();
    }
  }, 120_000);

  it('WM 441: abandon closes an owned unregistered candidate before a later finish can publish', async () => {
    const f = await fixture();
    refuseMemberCommit(f.dataRoot);
    await refuses(f, 'recovery-required');
    const select = [
      '--data-root',
      f.dataRoot,
      '--workspace-id',
      workspaceId,
      '--request-id',
      f.requestId,
    ];
    await expect(runCli(['abandon', ...select], () => {}, f)).resolves.toMatchObject({
      command: 'abandon',
      disposition: 'abandoned',
      workspaceId,
      nextAction: 'none',
    });
    await refuses(f, 'request-conflict', ['finish', ...select]);
    await expect(runCli(['inspect', ...select], () => {}, f)).resolves.toMatchObject({
      disposition: 'abandoned',
      selection: { kind: 'admission', requestId: f.requestId },
    });
    expect(existsSync(join(f.dataRoot, 'workspaces', workspaceId))).toBe(false);
    expect(rows(coreDbPath(f.dataRoot), 'workspace_registry')).toEqual([]);
    expect(rows(coreDbPath(f.dataRoot), 'workspace_members')).toEqual([]);
  }, 120_000);
});
