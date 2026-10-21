// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDataRootLock } from '../bootstrap/lock.js';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import { readReleaseIdentity } from '../diagnostics/release-identity.js';
import { raiseRecordedPendingRequest } from '../runtime/pending-request-flow.js';
import { pendingRequestItemId } from '../runtime/pending-requests.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { coreDbPath, readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import {
  parseWorkspaceBackupManifest,
  parseWorkspaceBackupSeal,
} from './workspace-backup-bundle.js';
import { nativeProductScope, readNativeTurnHistory } from './workspace-file-records.js';
import {
  runWorkspaceRecoveryCli,
  type WorkspaceRecoveryCliReport,
  WorkspaceRecoveryError,
} from './workspace-recovery-cli.js';

const workspaceId = DEMO_WORKSPACE_ID;
const roots: string[] = [];
const runCli: (
  argv: readonly string[],
  write?: (line: string) => void,
  deps?: { releaseIdentityPath?: string }
) => Promise<WorkspaceRecoveryCliReport> = runWorkspaceRecoveryCli;
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Selects existing-only native facts; a missing database is never initialized by the observer. */
function rows(path: string, table: string): Record<string, unknown>[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** Detects new paths and changed bytes without opening databases or following links. */
function retainedBytes(root: string) {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true }).map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [
        path.slice(root.length),
        entry.isFile()
          ? createHash('sha256').update(readFileSync(path)).digest('hex')
          : entry.isDirectory()
            ? 'directory'
            : 'nonregular',
      ];
    })
  );
}

/** Real current authority, with optional uncompleted work raised through the native Pending owner. */
async function fixture(history = false) {
  const root = mkdtempSync(join(tmpdir(), 'd0-lifecycle-'));
  roots.push(root);
  const dataRoot = join(root, 'source');
  const store = await createDemoStore({ dataRoot });
  const core = openCoreDb(dataRoot);
  const ownerId = ensureLocalUser(core);
  recordWorkspaceOwnerMembership({ coreDb: core, workspaceId, ownerUserId: ownerId });
  core.sqlite.close();
  let turnId: string | undefined;
  let pendingId: string | undefined;
  let callId: string | undefined;
  if (history) {
    const turn = await store.createTurn(workspaceId, DEMO_THREAD_ID, 'Captured unfinished work', {
      kind: 'user',
      id: ownerId,
    });
    turnId = turn.id;
    pendingId = randomUUID();
    callId = allocateEntityId('cap');
    const db = openWorkspaceDb(dataRoot, workspaceId);
    try {
      await raiseRecordedPendingRequest(store, db.sqlite, {
        requestId: pendingId,
        workspaceId,
        threadId: DEMO_THREAD_ID,
        raisingTurnId: turn.id,
        requestItemId: pendingRequestItemId(pendingId, 'request'),
        kind: 'approval',
        requesterKind: 'person',
        responsibleUserId: ownerId,
        governedIntent: {
          operation: 'fixture.effect',
          input: 'Never replay this captured request',
        },
        approval: {
          kind: 'destructive-action',
          title: 'Captured approval',
          description: 'Historical request only',
        },
        now: new Date().toISOString(),
      });
      startCapabilityCall({
        workspaceDb: db,
        workspaceId,
        threadId: DEMO_THREAD_ID,
        turnId: turn.id,
        callId,
        authorityActor: { kind: 'user', id: ownerId },
        family: 'llm',
        operation: 'responses.create',
        capabilityId: 'llm.responses',
        requestId: randomUUID(),
        redactionClass: 'metadata-only',
      });
    } finally {
      db.sqlite.close();
    }
    const queueDb = openCoreDb(dataRoot);
    try {
      createSchedulerAdmissionEntry(queueDb, {
        queueEntryId: `d0-captured-queue-${randomUUID()}`,
        backendId: 'nanohost',
        workspaceId,
        threadId: DEMO_THREAD_ID,
        turnId: turn.id,
        turnInput: 'Captured queue must never dispatch on the target',
        requestedAgentId: 'agent_d0_history',
        triggerActor: { kind: 'user', id: ownerId },
      });
    } finally {
      queueDb.sqlite.close();
    }
  }
  await shutdownControlStoreWorkerClient();
  const releaseIdentityPath = join(root, 'release-identity.json');
  writeFileSync(
    releaseIdentityPath,
    JSON.stringify({ releaseTag: 'v0.1.0-rc.11', sourceCommit: '1'.repeat(40) }),
    { mode: 0o600 }
  );
  const backupId = allocateEntityId('wsbak');
  const bundleRoot = join(root, 'bundle');
  const deploymentId = readDataRootLayoutMarker(dataRoot).deploymentId;
  const captureArgs = [
    'capture',
    '--source-data-root',
    dataRoot,
    '--workspace-id',
    workspaceId,
    '--expected-source-deployment-id',
    deploymentId,
    '--backup-id',
    backupId,
    '--bundle-root',
    bundleRoot,
    '--purpose',
    'move',
  ];
  return {
    root,
    dataRoot,
    ownerId,
    backupId,
    bundleRoot,
    deploymentId,
    releaseIdentityPath,
    captureArgs,
    turnId,
    pendingId,
    callId,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A source lifecycle test uses the actual preparation owner; it never forges command ownership SQL. */
async function prepare(f: Fixture) {
  const promise = runCli(f.captureArgs, () => {}, f);
  await expect(promise).resolves.toMatchObject({
    command: 'capture',
    disposition: 'prepared',
    workspaceId,
    capture: { backupId: f.backupId, sourceDeploymentId: f.deploymentId },
  });
  return promise;
}

/** Exact source selector for one prepared capture and its observed lifecycle revision. */
function moveArgs(f: Fixture, revision: number) {
  return [
    'move-out',
    '--data-root',
    f.dataRoot,
    '--workspace-id',
    workspaceId,
    '--backup-id',
    f.backupId,
    '--bundle-root',
    f.bundleRoot,
    '--expected-revision',
    String(revision),
  ];
}

/** Requires the real successful source-local decision before testing a later lifecycle transition. */
async function movedOut(f: Fixture) {
  const prepared = await prepare(f);
  const argv = moveArgs(f, prepared.capture!.capturedRevision);
  const promise = runCli(argv, () => {}, f);
  await expect(promise).resolves.toMatchObject({
    command: 'move-out',
    disposition: 'moved-out',
    workspaceId,
    capture: { backupId: f.backupId, manifestDigest: prepared.capture!.manifestDigest },
    nextAction: 'reactivate',
  });
  return { report: await promise, argv, prepared };
}

/** An exact refusal code, never a generic thrown exception, decides each negative CLI case. */
async function refuses(f: Fixture, argv: readonly string[], code: string) {
  const output: string[] = [];
  const error: unknown = await runCli(argv, (line) => output.push(line), f).catch(
    (value: unknown) => value
  );
  expect(error).toBeInstanceOf(WorkspaceRecoveryError);
  expect((error as WorkspaceRecoveryError).code).toBe(code);
  expect(output).toEqual([]);
  expect(String(error)).not.toContain(f.root);
}

describe('D0-2 actual source lifecycle and inert transfer', () => {
  it('WM 410–413: move-out binds the seal, disposition and one Audit fact to the same capture and raw digest', async () => {
    const f = await fixture();
    // Restore has its own valid backup-purpose input; the moved-out source is the only refusal.
    const restoreBundle = join(f.root, 'backup-before-move');
    await expect(
      runCli(
        f.captureArgs.map((value) =>
          value === f.backupId
            ? allocateEntityId('wsbak')
            : value === f.bundleRoot
              ? restoreBundle
              : value === 'move'
                ? 'backup'
                : value
        ),
        () => {},
        f
      )
    ).resolves.toMatchObject({ command: 'capture', disposition: 'sealed', workspaceId });
    const { report } = await movedOut(f);
    const rawDigest = `sha256:${createHash('sha256')
      .update(readFileSync(join(f.bundleRoot, 'manifest.json')))
      .digest('hex')}`;
    expect(
      parseWorkspaceBackupSeal(JSON.parse(readFileSync(join(f.bundleRoot, 'seal.json'), 'utf8')))
    ).toEqual({
      format: 'openkit-workspace-backup-seal',
      version: 1,
      purpose: 'move',
      backupId: f.backupId,
      manifestDigest: rawDigest,
    });
    expect(report.capture!.manifestDigest).toBe(rawDigest);
    expect(
      rows(workspaceDbPath(f.dataRoot, workspaceId), 'audit_events').filter(
        (row) => JSON.stringify(row).includes(f.backupId) && JSON.stringify(row).includes(rawDigest)
      )
    ).toHaveLength(1);
    await expect(
      runCli(
        [
          'inspect',
          '--data-root',
          f.dataRoot,
          '--workspace-id',
          workspaceId,
          '--backup-id',
          f.backupId,
        ],
        () => {},
        f
      )
    ).resolves.toMatchObject({
      disposition: 'moved-out',
      currentRevision: report.currentRevision,
      capture: { backupId: f.backupId, manifestDigest: rawDigest },
    });
    await refuses(
      f,
      [
        'restore',
        '--data-root',
        f.dataRoot,
        '--workspace-id',
        workspaceId,
        '--bundle-root',
        restoreBundle,
        '--request-id',
        randomUUID(),
      ],
      'workspace-moved-out'
    );
  }, 120_000);

  it('WM 411–415 / current revision: stale move-out refuses request-conflict with unchanged revision, disposition and Audit', async () => {
    const f = await fixture();
    const prepared = await prepare(f);
    expect(prepared.capture!.capturedRevision).toBeGreaterThan(0);
    const state = rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_workspaces');
    const audit = rows(workspaceDbPath(f.dataRoot, workspaceId), 'audit_events');
    await refuses(f, moveArgs(f, prepared.capture!.capturedRevision - 1), 'request-conflict');
    expect(rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_workspaces')).toEqual(state);
    expect(rows(workspaceDbPath(f.dataRoot, workspaceId), 'audit_events')).toEqual(audit);
    expect(existsSync(join(f.bundleRoot, 'seal.json'))).toBe(false);
  }, 120_000);

  it('WM 415: stale reactivation conflicts; current revision revokes every old publication retry before reopening', async () => {
    const f = await fixture();
    const moved = await movedOut(f);
    expect(moved.report.currentRevision).toBeTypeOf('number');
    const args = [
      'reactivate',
      '--data-root',
      f.dataRoot,
      '--workspace-id',
      workspaceId,
      '--backup-id',
      f.backupId,
      '--expected-revision',
      String(moved.report.currentRevision),
      '--acknowledge-target-fenced',
      '--acknowledge-copies-retired',
    ];
    const state = rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_workspaces');
    const audit = rows(workspaceDbPath(f.dataRoot, workspaceId), 'audit_events');
    await refuses(
      f,
      args.map((value) =>
        value === String(moved.report.currentRevision)
          ? String(moved.report.currentRevision! - 1)
          : value
      ),
      'request-conflict'
    );
    expect(rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_workspaces')).toEqual(state);
    expect(rows(workspaceDbPath(f.dataRoot, workspaceId), 'audit_events')).toEqual(audit);
    await expect(runCli(args, () => {}, f)).resolves.toMatchObject({
      command: 'reactivate',
      disposition: 'reactivated',
      workspaceId,
      nextAction: 'none',
    });
    expect(existsSync(join(f.bundleRoot, 'seal.json'))).toBe(false);
    await refuses(f, moved.argv, 'recovery-required');
    await refuses(
      f,
      [
        'finish',
        '--data-root',
        f.dataRoot,
        '--workspace-id',
        workspaceId,
        '--backup-id',
        f.backupId,
      ],
      'recovery-required'
    );
    expect(existsSync(join(f.bundleRoot, 'seal.json'))).toBe(false);
  }, 120_000);

  it('WM 373, 415: explicit capture abandonment is inspectable and publishes no transferable seal', async () => {
    const f = await fixture();
    await prepare(f);
    const selection = [
      '--data-root',
      f.dataRoot,
      '--workspace-id',
      workspaceId,
      '--backup-id',
      f.backupId,
    ];
    await expect(runCli(['abandon', ...selection], () => {}, f)).resolves.toMatchObject({
      command: 'abandon',
      disposition: 'abandoned',
      workspaceId,
    });
    await expect(runCli(['inspect', ...selection], () => {}, f)).resolves.toMatchObject({
      command: 'inspect',
      disposition: 'abandoned',
      selection: { kind: 'capture', backupId: f.backupId },
    });
    expect(existsSync(join(f.bundleRoot, 'seal.json'))).toBe(false);
  }, 120_000);

  it('WM 382, 432 / D0 exception: transferred unfinished executions and Pending Requests are inert, unknown effects stay unknown', async () => {
    const f = await fixture(true);
    const { report } = await movedOut(f);
    expect(report.capture!.unknownEffectTurnIds).toContain(f.turnId);
    const targetRoot = join(f.root, 'target');
    const core = openCoreDb(targetRoot);
    applyMigrations(core);
    const ownerId = ensureLocalUser(core);
    core.sqlite.close();
    const promise = runCli(
      [
        'move-in',
        '--data-root',
        targetRoot,
        '--bundle-root',
        f.bundleRoot,
        '--request-id',
        randomUUID(),
        '--target-owner-id',
        ownerId,
      ],
      () => {},
      f
    );
    await expect(promise).resolves.toMatchObject({
      disposition: 'imported',
      workspaceId,
      capture: { unknownEffectTurnIds: expect.arrayContaining([f.turnId]) },
    });
    expect(rows(coreDbPath(targetRoot), 'scheduler_admission_entries')).toEqual([]);
    expect(rows(coreDbPath(targetRoot), 'scheduler_execution_attempts')).toEqual([]);
    expect(rows(workspaceDbPath(targetRoot, workspaceId), 'capability_calls')).toEqual(
      expect.arrayContaining([expect.objectContaining({ call_id: f.callId, status: 'unknown' })])
    );
    expect(rows(workspaceDbPath(targetRoot, workspaceId), 'pending_requests')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ request_id: f.pendingId, delivery_turn_id: null }),
      ])
    );
    // Pending Requests:217,242,247,274 require separate, inert closeout publication.
    const sourceTurns = rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_turns');
    const targetDb = workspaceDbPath(targetRoot, workspaceId);
    const targetTurns = rows(targetDb, 'control_turns');
    const sourceIds = new Set(sourceTurns.map((turn) => turn.id));
    const addedTurns = targetTurns.filter((turn) => !sourceIds.has(turn.id));
    const closed = rows(targetDb, 'pending_requests').filter(
      (request) => request.delivery === 'closed-out'
    );
    expect(closed).toHaveLength(1);
    expect(targetTurns).toHaveLength(sourceTurns.length + closed.length);
    expect(addedTurns).toHaveLength(closed.length);
    expect(
      targetTurns.filter((turn) => sourceIds.has(turn.id)).map(({ id, status }) => ({ id, status }))
    ).toEqual(sourceTurns.map(({ id, status }) => ({ id, status })));
    const scope = nativeProductScope(targetRoot, { kind: 'workspace', workspaceId });
    for (const request of closed) {
      expect(request).toMatchObject({
        request_id: f.pendingId,
        state: 'ended',
        resolution: null,
        claim: 'unclaimed',
        execution_call_id: null,
        delivery_turn_id: null,
      });
      const publication = addedTurns.find((turn) => turn.id === request.publication_turn_id);
      expect(publication).toBeDefined();
      expect(publication!.id).toMatch(
        /^tu_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(publication!.id).not.toBe(request.raising_turn_id);
      expect(publication!.agent_session_id).toBeNull();
      expect(['completed', 'interrupted', 'cancelled', 'failed']).toContain(publication!.status);
      const history = readNativeTurnHistory(scope, String(publication!.id))!;
      expect(history.turn).toMatchObject({
        owner: { kind: 'workspace', workspaceId },
        threadId: request.thread_id,
        triggerActor: { kind: 'system' },
        triggerSource: { kind: 'system-input' },
        agentId: null,
        agentSessionId: null,
        completedAt: expect.any(String),
      });
      const closeoutId = pendingRequestItemId(String(request.request_id), 'ending');
      expect(history.turn.items).toEqual([
        expect.objectContaining({
          id: closeoutId,
          type: 'status',
          owner: { kind: 'workspace', workspaceId },
          threadId: request.thread_id,
          turnId: request.publication_turn_id,
          causationId: request.request_item_id,
          summary: request.invalidating_event ?? request.ending,
        }),
      ]);
      expect(
        readNativeTurnHistory(scope, String(request.raising_turn_id))!.turn.items.filter(
          (item) => item.id === closeoutId || item.causationId === request.request_item_id
        )
      ).toEqual([]);
      expect(
        rows(targetDb, 'control_executions').filter(
          (execution) => execution.work_id === publication!.id
        )
      ).toEqual([]);
      expect(
        rows(targetDb, 'worker_turn_checkpoints').filter(
          (checkpoint) => checkpoint.turn_id === publication!.id
        )
      ).toEqual([]);
    }
  }, 120_000);
});

describe('D0-2 closed operator preconditions', () => {
  it.each([
    '--acknowledge-target-fenced',
    '--acknowledge-copies-retired',
  ])('WM 415: omitted %s refuses invalid-arguments without a source mutation', async (omitted) => {
    const f = await fixture();
    const before = rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_workspaces');
    await refuses(
      f,
      [
        'reactivate',
        '--data-root',
        f.dataRoot,
        '--workspace-id',
        workspaceId,
        '--backup-id',
        f.backupId,
        '--expected-revision',
        '1',
        '--acknowledge-target-fenced',
        '--acknowledge-copies-retired',
      ].filter((value) => value !== omitted),
      'invalid-arguments'
    );
    expect(rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_workspaces')).toEqual(before);
  }, 120_000);

  it.each([
    'restore',
    'move-out',
    'move-in',
    'finish',
    'abandon',
    'reactivate',
  ] as const)('D0 root exclusion: a second command holder makes %s refuse root-locked', async (command) => {
    const f = await fixture();
    const base = ['--data-root', f.dataRoot];
    const selection = ['--workspace-id', workspaceId, '--backup-id', f.backupId];
    const argv =
      command === 'restore'
        ? [
            command,
            ...base,
            '--workspace-id',
            workspaceId,
            '--bundle-root',
            f.bundleRoot,
            '--request-id',
            randomUUID(),
          ]
        : command === 'move-in'
          ? [
              command,
              ...base,
              '--bundle-root',
              f.bundleRoot,
              '--request-id',
              randomUUID(),
              '--target-owner-id',
              f.ownerId,
            ]
          : command === 'move-out'
            ? moveArgs(f, 1)
            : command === 'reactivate'
              ? [
                  command,
                  ...base,
                  ...selection,
                  '--expected-revision',
                  '1',
                  '--acknowledge-target-fenced',
                  '--acknowledge-copies-retired',
                ]
              : [command, ...base, ...selection];
    const lock = acquireDataRootLock(f.dataRoot, { bootId: 'second-offline-command' });
    try {
      await refuses(f, argv, 'root-locked');
    } finally {
      lock.release();
    }
  }, 120_000);

  it.each([
    'capture',
    'verify',
    'restore',
    'move-in',
  ] as const)('D0 release ruling: %s without an installed identity refuses release-mismatch, never a source-build fallback', async (command) => {
    const f = await fixture();
    rmSync(f.releaseIdentityPath);
    const before = retainedBytes(f.root);
    const argv =
      command === 'capture'
        ? f.captureArgs
        : command === 'verify'
          ? ['verify', '--bundle-root', f.bundleRoot]
          : command === 'restore'
            ? [
                'restore',
                '--data-root',
                f.dataRoot,
                '--workspace-id',
                workspaceId,
                '--bundle-root',
                f.bundleRoot,
                '--request-id',
                randomUUID(),
              ]
            : [
                'move-in',
                '--data-root',
                f.dataRoot,
                '--bundle-root',
                f.bundleRoot,
                '--request-id',
                randomUUID(),
                '--target-owner-id',
                f.ownerId,
              ];
    await refuses(f, argv, 'release-mismatch');
    expect(existsSync(f.bundleRoot)).toBe(false);
    expect(retainedBytes(f.root)).toEqual(before);
  }, 120_000);

  it('D0 12:49Z release ruling: a present untagged identity captures version source and its exact commit', async () => {
    const f = await fixture();
    writeFileSync(
      f.releaseIdentityPath,
      JSON.stringify({ releaseTag: null, sourceCommit: '1'.repeat(40) })
    );
    const output: string[] = [];
    await expect(runCli(f.captureArgs, (line) => output.push(line), f)).resolves.toMatchObject({
      command: 'capture',
      disposition: 'prepared',
      workspaceId,
    });
    expect(
      parseWorkspaceBackupManifest(
        JSON.parse(readFileSync(join(f.bundleRoot, 'manifest.json'), 'utf8'))
      ).release
    ).toEqual({ version: 'source', buildId: '1'.repeat(40) });
    expect(output).toHaveLength(1);
  }, 120_000);

  it('D0 release ruling: the existing identity parser refuses a malformed private file', () => {
    const root = mkdtempSync(join(tmpdir(), 'd0-malformed-release-'));
    roots.push(root);
    const path = join(root, 'release-identity.json');
    writeFileSync(path, JSON.stringify({ releaseTag: 'v0.1.0', sourceCommit: 'not-a-commit' }));
    expect(() => readReleaseIdentity(path)).toThrowError(
      expect.objectContaining({ code: 'invalid_release_identity' })
    );
    expect(readFileSync(path, 'utf8')).toBe(
      JSON.stringify({ releaseTag: 'v0.1.0', sourceCommit: 'not-a-commit' })
    );
  });
});
