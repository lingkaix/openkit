// openkit-test-platform: posix
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import { AutomationStore } from '../lib/automation-store.js';
import { requireSchedulerAdmissionEntry } from '../scheduler-records.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { coreDbPath, readDataRootLayoutMarker, workspaceDbPath } from '../storage/fs-layout.js';
import {
  RECURRING_PORTABLE_PATHS,
  readRecurringPortableFiles,
  readRecurringPortableHistory,
} from '../storage/recurring-portable-history.js';
import { withVerifiedWorkspaceBackupBundle } from '../storage/workspace-backup-bundle.js';
import {
  finishWorkspaceMove,
  moveOutWorkspace,
  type WorkspaceMoveOutInput,
  type WorkspaceRecoveryBoundary,
  type WorkspaceRecoveryDependencies,
} from '../storage/workspace-move.js';
import {
  runWorkspaceRecoveryCli,
  type WorkspaceRecoveryCliReport,
  WorkspaceRecoveryError,
} from '../storage/workspace-recovery-cli.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';

const disposals: (() => Promise<void> | void)[] = [];
const runCli: (
  argv: readonly string[],
  write?: (line: string) => void,
  deps?: { releaseIdentityPath?: string }
) => Promise<WorkspaceRecoveryCliReport> = runWorkspaceRecoveryCli;
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

/** Observes every retained byte; no mutation or repair is part of this census. */
function bytes(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [
          path.slice(root.length),
          createHash('sha256').update(readFileSync(path)).digest('hex'),
        ];
      })
      .sort(([left], [right]) => left!.localeCompare(right!))
  );
}

/** Copies the complete stopped SQLite directory before opening it, so observation cannot add source sidecars. */
function callStatus(dataRoot: string, workspaceId: string, callId: string) {
  const observer = mkdtempSync(join(tmpdir(), 'd0-boot-observer-'));
  try {
    const path = workspaceDbPath(dataRoot, workspaceId);
    cpSync(dirname(path), observer, { recursive: true });
    const db = new Database(join(observer, basename(path)), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return db.prepare('SELECT status FROM capability_calls WHERE call_id=?').pluck().get(callId);
    } finally {
      db.close();
    }
  } finally {
    rmSync(observer, { recursive: true, force: true });
  }
}

/** Starts actual NanoCore composition and waits for its real health endpoint, with no persistence mocks. */
async function boot(dataRoot: string) {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('No local fixture port.');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve()))
  );
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: {
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      OPENKIT_DATA_ROOT: dataRoot,
      OPENKIT_CORE_MODE: 'server',
      OPENKIT_BIND_HOST: '127.0.0.1',
      PORT: String(port),
      OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR: '1',
      BETTER_AUTH_SECRET: 'd0-isolated-boot-fixture-only-not-a-real-credential',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let exited = false;
  const done = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
    child.once('error', (error) => {
      output += error.message;
      exited = true;
      resolve();
    });
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-8192);
    });
  const stop = async () => {
    if (exited) return;
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    deadline.unref();
    child.kill('SIGTERM');
    try {
      await done;
    } finally {
      clearTimeout(deadline);
    }
  };
  disposals.push(stop);
  const base = `http://127.0.0.1:${port}`;
  await vi.waitFor(
    async () => {
      if (exited) throw new Error(`Fixture boot exited before health: ${output}`);
      expect(
        (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).status
      ).toBe(200);
    },
    { timeout: 60_000, interval: 100 }
  );
  const call = (operation: string, input: Record<string, unknown>, token: string) =>
    fetch(`${base}/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(typeof input.requestId === 'string' ? { 'x-openkit-request-id': input.requestId } : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(20_000),
    });
  return { stop, call };
}

/** Produces real native authority; the absent registry is the same observable placement gap as WM 438. */
async function fixture(registered: boolean) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'd0-boot-'));
  disposals.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const store = await createDemoStore({ dataRoot });
  const badId = DEMO_WORKSPACE_ID;
  const good = await store.createWorkspace('Healthy sibling');
  const core = openCoreDb(dataRoot);
  const ownerId = ensureLocalUser(core);
  recordWorkspaceOwnerMembership({ coreDb: core, workspaceId: good.id, ownerUserId: ownerId });
  if (registered)
    recordWorkspaceOwnerMembership({ coreDb: core, workspaceId: badId, ownerUserId: ownerId });
  const token = createOpenKitAccessTokenRecord(core, {
    ownerUserId: ownerId,
    scope: 'workspace',
    workspaceIds: [badId, good.id],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  core.sqlite.close();
  const callId = allocateEntityId('cap');
  for (const workspaceId of [badId, good.id]) {
    const db = openWorkspaceDb(dataRoot, workspaceId);
    try {
      startCapabilityCall({
        workspaceDb: db,
        workspaceId,
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
  }
  await shutdownControlStoreWorkerClient();
  return { dataRoot, badId, goodId: good.id, callId, token: token.secret, ownerId, store };
}

/** Cold-opens private copies, including crash-retained journals, without repairing the source. */
function crashSourceState(f: Awaited<ReturnType<typeof fixture>>, backupId: string) {
  const observer = mkdtempSync(join(tmpdir(), 'd0-crash-observer-'));
  try {
    const read = (path: string, name: string, query: (db: Database.Database) => unknown) => {
      const copy = join(observer, name);
      cpSync(dirname(path), copy, { recursive: true });
      const db = new Database(join(copy, basename(path)), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
        return query(db);
      } finally {
        db.close();
      }
    };
    const workspace = read(workspaceDbPath(f.dataRoot, f.badId), 'workspace', (db) => ({
      authority: db.prepare('SELECT * FROM control_workspaces WHERE id=?').get(f.badId),
      audit: db.prepare('SELECT * FROM audit_events ORDER BY rowid').all(),
      capture: db
        .prepare('SELECT * FROM workspace_capture_records WHERE capture_id=?')
        .get(backupId),
      calls: db.prepare('SELECT * FROM capability_calls ORDER BY rowid').all(),
    })) as {
      authority: { revision: number; record_json: string };
      audit: Record<string, unknown>[];
      capture: { state: string };
      calls: Record<string, unknown>[];
    };
    const core = read(coreDbPath(f.dataRoot), 'core', (db) => ({
      admission: db
        .prepare('SELECT * FROM workspace_recovery_admissions WHERE admission_id=?')
        .get(backupId),
      registry: db.prepare('SELECT * FROM workspace_registry WHERE workspace_id=?').all(f.badId),
      members: db
        .prepare('SELECT * FROM workspace_members WHERE workspace_id=? ORDER BY rowid')
        .all(f.badId),
    }));
    return { workspace, core };
  } finally {
    rmSync(observer, { recursive: true, force: true });
  }
}

/** Exits inside the real synchronous boundary callback; neither SQL nor publication is mocked. */
async function crashMoveOut(
  input: WorkspaceMoveOutInput,
  point: Parameters<NonNullable<WorkspaceRecoveryDependencies['atBoundary']>>[0]
) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
      import { writeSync } from 'node:fs';
      import { moveOutWorkspace } from ${JSON.stringify(new URL('../storage/workspace-move.ts', import.meta.url).href)};
      const visited = [];
      try {
        await moveOutWorkspace(${JSON.stringify(input)}, {
          atBoundary(point) {
            visited.push(point);
            if (point === ${JSON.stringify(point)}) {
              writeSync(1, JSON.stringify({ point, visited }));
              process.exit(73);
            }
          },
        });
        writeSync(1, JSON.stringify({ returnedWithoutCrash: true, visited }));
        process.exit(74);
      } catch (error) {
        writeSync(1, JSON.stringify({ code: error.code, visited }));
        process.exit(75);
      }
      `,
    ],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { PATH: process.env.PATH, TMPDIR: tmpdir() },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-8192);
    });
  let exited = false;
  const done = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      exited = true;
      resolve(code);
    });
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000);
  deadline.unref();
  disposals.push(async () => {
    if (!exited) child.kill('SIGKILL');
    await done.catch(() => undefined);
    clearTimeout(deadline);
  });
  try {
    expect(await done, output).toBe(73);
    expect(JSON.parse(output)).toEqual({
      point,
      visited: sourceCrashPoints.slice(0, sourceCrashPoints.indexOf(point) + 1),
    });
  } finally {
    clearTimeout(deadline);
  }
}

const sourceCrashPoints: readonly WorkspaceRecoveryBoundary[] = [
  'before-moved-out-commit',
  'after-moved-out-commit',
  'before-seal-publication',
  'after-seal-publication',
];

describe('D0 RED-3 source crash boundaries / Ruling 13:07Z', () => {
  it.each(
    sourceCrashPoints
  )('WM 389, 411–415 / %s: cold state, real boot refusal and exact explicit recovery', async (point) => {
    const f = await fixture(true);
    const commandRoot = mkdtempSync(join(tmpdir(), 'd0-source-crash-'));
    disposals.push(() => rmSync(commandRoot, { recursive: true, force: true }));
    const bundleRoot = join(commandRoot, 'bundle');
    const releaseIdentityPath = join(commandRoot, 'release-identity.json');
    writeFileSync(
      releaseIdentityPath,
      JSON.stringify({ releaseTag: 'v0.1.0-rc.11', sourceCommit: '1'.repeat(40) })
    );
    const backupId = allocateEntityId('wsbak');
    const prepared = await runCli(
      [
        'capture',
        '--source-data-root',
        f.dataRoot,
        '--workspace-id',
        f.badId,
        '--expected-source-deployment-id',
        readDataRootLayoutMarker(f.dataRoot).deploymentId,
        '--bundle-root',
        bundleRoot,
        '--purpose',
        'move',
        '--backup-id',
        backupId,
      ],
      () => {},
      { releaseIdentityPath }
    );
    expect(prepared).toMatchObject({
      disposition: 'prepared',
      workspaceId: f.badId,
      capture: { backupId },
    });
    const digest = `sha256:${createHash('sha256')
      .update(readFileSync(join(bundleRoot, 'manifest.json')))
      .digest('hex')}`;
    expect(prepared.capture!.manifestDigest).toBe(digest);
    expect(existsSync(join(bundleRoot, 'seal.json'))).toBe(false);
    const capturedBytes = bytes(bundleRoot);
    const before = crashSourceState(f, backupId);
    expect(before.workspace.capture.state).toBe('active');
    expect(callStatus(f.dataRoot, f.badId, f.callId)).toBe('running');
    const input: WorkspaceMoveOutInput = {
      dataRoot: f.dataRoot,
      workspaceId: f.badId,
      backupId,
      bundleRoot,
      expectedRevision: prepared.capture!.capturedRevision,
    };
    await crashMoveOut(input, point);

    const committed = point !== 'before-moved-out-commit';
    const sealed = point === 'after-seal-publication';
    const cold = crashSourceState(f, backupId);
    if (!committed) {
      expect.soft(cold).toEqual(before);
    } else {
      expect.soft(cold.workspace.authority.revision).toBeGreaterThan(input.expectedRevision);
      expect.soft(JSON.parse(cold.workspace.authority.record_json)).toMatchObject({
        movedOut: { backupId, manifestDigest: digest },
      });
      expect
        .soft(
          cold.workspace.audit.filter(
            (row) => JSON.stringify(row).includes(backupId) && JSON.stringify(row).includes(digest)
          )
        )
        .toHaveLength(1);
    }
    // No durable seal means no independent verified copy and no end to capture protection.
    if (!sealed) expect.soft(cold.workspace.capture).toEqual(before.workspace.capture);
    expect
      .soft(cold.workspace.calls.map((call) => call.call_id))
      .toEqual(before.workspace.calls.map((call) => call.call_id));
    expect
      .soft(['running', 'unknown'])
      .toContain(cold.workspace.calls.find((call) => call.call_id === f.callId)?.status);
    expect.soft(existsSync(join(bundleRoot, 'seal.json'))).toBe(sealed);
    const bundleAfterCrash = bytes(bundleRoot);
    const { '/seal.json': _seal, ...unsealedBytes } = bundleAfterCrash;
    // A failed publication may leave owned temporary bytes, but may not change captured content.
    expect.soft(unsealedBytes).toMatchObject(capturedBytes);
    if (sealed) {
      expect.soft(JSON.parse(readFileSync(join(bundleRoot, 'seal.json'), 'utf8'))).toMatchObject({
        format: 'openkit-workspace-backup-seal',
        version: 1,
        purpose: 'move',
        backupId,
        manifestDigest: digest,
      });
      await expect
        .soft(
          runCli(['verify', '--bundle-root', bundleRoot], () => {}, {
            releaseIdentityPath,
          })
        )
        .resolves.toMatchObject({
          disposition: 'verified',
          capture: { backupId, manifestDigest: digest },
        });
    } else {
      const output: string[] = [];
      const refusal: unknown = await runCli(
        ['verify', '--bundle-root', bundleRoot],
        (line) => output.push(line),
        { releaseIdentityPath }
      ).catch((error: unknown) => error);
      expect.soft(refusal).toBeInstanceOf(WorkspaceRecoveryError);
      expect.soft((refusal as WorkspaceRecoveryError).code).toBe('invalid-bundle');
      expect.soft(output).toEqual([]);
    }

    // Boot must preserve both unfinished capture and committed tombstone, before native recovery.
    const server = await boot(f.dataRoot);
    const healthy = await server.call(
      'thread.create',
      {
        workspaceId: f.goodId,
        name: 'Healthy beside crashed MOVE',
        requestId: randomUUID(),
      },
      f.token
    );
    expect.soft(healthy.status, await healthy.clone().text()).toBe(200);
    const refused = await server.call(
      'thread.create',
      {
        workspaceId: f.badId,
        name: 'Must not reopen partial MOVE',
        requestId: randomUUID(),
      },
      f.token
    );
    expect.soft([403, 409], await refused.clone().text()).toContain(refused.status);
    await server.stop();
    expect.soft(callStatus(f.dataRoot, f.goodId, f.callId)).toBe('unknown');
    expect.soft(crashSourceState(f, backupId)).toEqual(cold);
    expect.soft(bytes(bundleRoot)).toEqual(bundleAfterCrash);

    const selection = [
      '--data-root',
      f.dataRoot,
      '--workspace-id',
      f.badId,
      '--backup-id',
      backupId,
    ];
    await expect
      .soft(runCli(['inspect', ...selection], () => {}, { releaseIdentityPath }))
      .resolves.toMatchObject({
        disposition: committed ? 'moved-out' : 'prepared',
        currentRevision: cold.workspace.authority.revision,
        capture: { backupId, manifestDigest: digest },
      });
    // A cold retry owns recovery; boot may neither seal the bundle nor replay the source work.
    const recovered = committed
      ? finishWorkspaceMove({
          dataRoot: f.dataRoot,
          workspaceId: f.badId,
          selection: { kind: 'capture', backupId },
        })
      : moveOutWorkspace(input);
    await expect.soft(recovered).resolves.toMatchObject({
      disposition: 'moved-out',
      workspaceId: f.badId,
      capture: { backupId, manifestDigest: digest },
    });
    await expect
      .soft(
        runCli(['verify', '--bundle-root', bundleRoot], () => {}, {
          releaseIdentityPath,
        })
      )
      .resolves.toMatchObject({
        disposition: 'verified',
        capture: { backupId, manifestDigest: digest },
      });
    const finished = crashSourceState(f, backupId);
    expect.soft(finished.workspace.capture.state).toBe('finished');
    expect
      .soft(
        finished.workspace.audit.filter(
          (row) => JSON.stringify(row).includes(backupId) && JSON.stringify(row).includes(digest)
        )
      )
      .toHaveLength(1);
    expect
      .soft(finished.workspace.calls.map((call) => call.call_id))
      .toEqual(before.workspace.calls.map((call) => call.call_id));
    expect
      .soft(['running', 'unknown'])
      .toContain(finished.workspace.calls.find((call) => call.call_id === f.callId)?.status);
    await expect.soft(moveOutWorkspace(input)).resolves.toMatchObject({
      disposition: 'moved-out',
      currentRevision: finished.workspace.authority.revision,
      capture: { backupId, manifestDigest: digest },
    });
    expect.soft(crashSourceState(f, backupId)).toEqual(finished);
  }, 120_000);
});

/** Creates native recurring rows through their owner, including one real published queued Turn when selected. */
async function recurringFixture(queued: boolean) {
  const f = await fixture(true);
  const core = openCoreDb(f.dataRoot);
  let instant = '2026-10-16T00:00:00.000Z';
  const schedules = new AutomationStore(core, new WorkspaceMutationAdmission(), () => instant);
  const schedule = schedules.createAutomation(f.ownerId, {
    name: 'Retained weekly work',
    workspaceId: f.badId,
    threadId: DEMO_THREAD_ID,
    intervalSeconds: 60,
    prompt: 'Historical recurring work must not restart.',
  });
  schedules.updateAutomation(f.ownerId, schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: instant,
  });
  const occurrence = schedules.collectScanCandidates(instant)[0]!;
  let turnId: string | undefined;
  let queueEntryId: string | undefined;
  try {
    if (queued) {
      schedules.commitAttempt(occurrence.id, 2, {
        kind: 'ready',
        payload: {
          backendId: 'source-only-backend',
          requestedAgentId: 'worker',
          profileRef: 'source-profile',
          modelId: 'source-model',
          workspaceCwd: null,
          workspaceRoots: [],
        },
      });
      const accepted = schedules.getOccurrence(occurrence.id);
      const entry = requireSchedulerAdmissionEntry(core, accepted.queueEntryId!);
      expect(entry.status).toBe('queued');
      queueEntryId = entry.queueEntryId;
      turnId = entry.turnId;
      await f.store.createTurn(
        entry.workspaceId,
        entry.threadId,
        entry.turnInput,
        entry.triggerActor,
        null,
        {
          turnId: entry.turnId,
          status: 'pending',
          agentId: entry.requestedAgentId,
          executorKind: 'worker',
        }
      );
    }
    instant = '2026-10-16T01:00:00.000Z';
    schedules.collectScanCandidates(instant);
    for (const table of [
      'recurring_schedules',
      'recurring_occurrences',
      'recurring_expired_ranges',
    ]) {
      expect(
        core.sqlite
          .prepare(`SELECT count(*) FROM ${table} WHERE workspace_id=?`)
          .pluck()
          .get(f.badId)
      ).toBeGreaterThan(0);
    }
  } finally {
    core.sqlite.close();
  }
  await shutdownControlStoreWorkerClient();
  const commandRoot = mkdtempSync(join(tmpdir(), 'd0-recurring-'));
  disposals.push(() => rmSync(commandRoot, { recursive: true, force: true }));
  const releaseIdentityPath = join(commandRoot, 'release-identity.json');
  writeFileSync(
    releaseIdentityPath,
    JSON.stringify({
      releaseTag: 'v0.1.0-rc.11',
      sourceCommit: '1'.repeat(40),
    })
  );
  const bundleRoot = join(commandRoot, 'bundle');
  const backupId = allocateEntityId('wsbak');
  return {
    ...f,
    commandRoot,
    releaseIdentityPath,
    bundleRoot,
    backupId,
    scheduleId: schedule.id,
    turnId,
    queueEntryId,
  };
}

/** Captures through the frozen CLI; no recurring collector is replaced by a test producer. */
async function captureRecurring(
  f: Awaited<ReturnType<typeof recurringFixture>>,
  purpose: 'backup' | 'move'
) {
  const promise = runCli(
    [
      'capture',
      '--source-data-root',
      f.dataRoot,
      '--workspace-id',
      f.badId,
      '--expected-source-deployment-id',
      readDataRootLayoutMarker(f.dataRoot).deploymentId,
      '--bundle-root',
      f.bundleRoot,
      '--backup-id',
      f.backupId,
      '--purpose',
      purpose,
    ],
    () => {},
    f
  );
  await expect(promise).resolves.toMatchObject({
    command: 'capture',
    disposition: purpose === 'backup' ? 'sealed' : 'prepared',
    capture: { backupId: f.backupId },
  });
  return promise;
}

/** Consumes the exact verified JSONL files with the existing history reader and real retained Turn references. */
async function recurringBundle(f: Awaited<ReturnType<typeof recurringFixture>>) {
  const stagingParent = join(f.commandRoot, 'verify');
  mkdirSync(stagingParent);
  return withVerifiedWorkspaceBackupBundle(
    {
      bundleRoot: f.bundleRoot,
      stagingParent,
      admission: new FileStorageAdmission(f.commandRoot, () => 0n),
      expectedRelease: { version: 'v0.1.0-rc.11', buildId: '1'.repeat(40) },
      supportedDatabaseFormats: { 'drizzle.workspace': 14 },
      supportedRequiredFeatures: ['workspace.recurring-triggers.v1'],
    },
    async (verified) => {
      expect(verified.manifest.requiredFeatures).toContain('workspace.recurring-triggers.v1');
      expect(verified.manifest.databaseFormats.map((entry) => entry.path)).toEqual([
        'db/workspace.sqlite',
      ]);
      const files = new Map<string, string>();
      for (const path of Object.values(RECURRING_PORTABLE_PATHS)) {
        expect(verified.manifest.inventory.map((entry) => entry.path)).toContain(path);
        const chunks: Uint8Array[] = [];
        for await (const chunk of verified.readFile(path)) chunks.push(chunk);
        files.set(path, Buffer.concat(chunks).toString('utf8'));
      }
      expect(
        verified.manifest.inventory.some((entry) => /scheduler|core\.sqlite/.test(entry.path))
      ).toBe(false);
      const graph = readRecurringPortableFiles(files, {
        workspaceId: f.badId,
        threadIds: new Set(f.store.listThreads(f.badId).map((thread) => thread.id)),
        turns: new Map(
          f.store.listThreadTurns(f.badId, DEMO_THREAD_ID).map((turn) => [turn.id, DEMO_THREAD_ID])
        ),
      });
      expect(graph.schedules).toEqual([
        expect.objectContaining({ originScheduleId: f.scheduleId }),
      ]);
      expect(graph.occurrences.length).toBeGreaterThan(0);
      expect(graph.expiredRanges.length).toBeGreaterThan(0);
      return graph;
    }
  );
}

/** Reads current scheduler authority after commands or server shutdown without creating absent storage. */
function schedulingState(dataRoot: string, workspaceId: string) {
  const db = new Database(coreDbPath(dataRoot), { readonly: true, fileMustExist: true });
  try {
    return Object.fromEntries(
      [
        'recurring_schedules',
        'recurring_occurrences',
        'recurring_expired_ranges',
        'scheduler_admission_entries',
        'scheduler_execution_attempts',
      ].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} WHERE workspace_id=? ORDER BY rowid`).all(workspaceId),
      ])
    );
  } finally {
    db.close();
  }
}

describe('D0-3 actual next-boot admission', () => {
  it('WM 389, 438–441: an unregistered final Workspace is excluded before recovery while a healthy sibling serves writes', async () => {
    const f = await fixture(false);
    const badRoot = join(f.dataRoot, 'workspaces', f.badId);
    const before = bytes(badRoot);
    expect(callStatus(f.dataRoot, f.badId, f.callId)).toBe('running');
    const server = await boot(f.dataRoot);
    const healthy = await server.call(
      'thread.create',
      {
        workspaceId: f.goodId,
        name: 'Healthy real boot',
        requestId: randomUUID(),
      },
      f.token
    );
    expect(healthy.status, await healthy.clone().text()).toBe(200);
    await server.stop();
    // The active sibling proves ordinary startup recovery actually ran in this process.
    expect(callStatus(f.dataRoot, f.goodId, f.callId)).toBe('unknown');
    expect(callStatus(f.dataRoot, f.badId, f.callId)).toBe('running');
    expect(bytes(badRoot)).toEqual(before);
  }, 120_000);

  it('WM 389, 441: registered missing authority stays absent and quarantined while a healthy sibling boots', async () => {
    const f = await fixture(true);
    const path = workspaceDbPath(f.dataRoot, f.badId);
    rmSync(path);
    const server = await boot(f.dataRoot);
    const healthy = await server.call(
      'thread.create',
      {
        workspaceId: f.goodId,
        name: 'Healthy beside missing authority',
        requestId: randomUUID(),
      },
      f.token
    );
    expect(healthy.status, await healthy.clone().text()).toBe(200);
    await server.stop();
    expect(existsSync(path)).toBe(false);
    expect(callStatus(f.dataRoot, f.goodId, f.callId)).toBe('unknown');
  }, 120_000);

  it('D0 cold exclusion / WM 377, 389: the running server root lock refuses an offline restore', async () => {
    const f = await fixture(true);
    const server = await boot(f.dataRoot);
    const output: string[] = [];
    const releaseIdentityPath = join(f.dataRoot, 'fixture-release.json');
    writeFileSync(
      releaseIdentityPath,
      JSON.stringify({ releaseTag: 'v0.1.0-rc.11', sourceCommit: '1'.repeat(40) })
    );
    const error: unknown = await runCli(
      [
        'restore',
        '--data-root',
        f.dataRoot,
        '--bundle-root',
        join(f.dataRoot, 'absent-bundle'),
        '--workspace-id',
        f.badId,
        '--request-id',
        randomUUID(),
      ],
      (line) => output.push(line),
      { releaseIdentityPath }
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(WorkspaceRecoveryError);
    expect((error as WorkspaceRecoveryError).code).toBe('root-locked');
    expect(output).toEqual([]);
    await server.stop();
  }, 120_000);

  it('WM 411–415: process exit after the move-out report leaves a read-only, inspectable tombstone on the next real boot', async () => {
    const f = await fixture(true);
    const commandRoot = mkdtempSync(join(tmpdir(), 'd0-command-exit-'));
    disposals.push(() => rmSync(commandRoot, { recursive: true, force: true }));
    const bundleRoot = join(commandRoot, 'bundle');
    const releaseIdentityPath = join(commandRoot, 'release-identity.json');
    writeFileSync(
      releaseIdentityPath,
      JSON.stringify({ releaseTag: 'v0.1.0-rc.11', sourceCommit: '1'.repeat(40) })
    );
    const backupId = allocateEntityId('wsbak');
    const prepared = runCli(
      [
        'capture',
        '--source-data-root',
        f.dataRoot,
        '--workspace-id',
        f.badId,
        '--expected-source-deployment-id',
        readDataRootLayoutMarker(f.dataRoot).deploymentId,
        '--bundle-root',
        bundleRoot,
        '--purpose',
        'move',
        '--backup-id',
        backupId,
      ],
      () => {},
      { releaseIdentityPath }
    );
    await expect(prepared).resolves.toMatchObject({
      disposition: 'prepared',
      capture: { backupId },
    });
    const revision = (await prepared).capture!.capturedRevision;
    const argv = [
      'move-out',
      '--data-root',
      f.dataRoot,
      '--workspace-id',
      f.badId,
      '--backup-id',
      backupId,
      '--bundle-root',
      bundleRoot,
      '--expected-revision',
      String(revision),
    ];
    // The output callback follows the command's durable result. This tests only that known boundary,
    // not an invented stop between SQL COMMIT and seal publication.
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { writeSync } from 'node:fs';
      import { runWorkspaceRecoveryCli } from ${JSON.stringify(new URL('../storage/workspace-recovery-cli.ts', import.meta.url).href)};
      try {
        await runWorkspaceRecoveryCli(${JSON.stringify(argv)}, line => {
          writeSync(1, line); process.exit(73);
        }, ${JSON.stringify({ releaseIdentityPath })});
        process.exit(74);
      } catch (error) {
        writeSync(1, JSON.stringify({code: error.code})); process.exit(75);
      }
    `,
      ],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { PATH: process.env.PATH, TMPDIR: tmpdir() },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let response = '';
    child.stdout.on('data', (chunk) => {
      response += String(chunk);
    });
    let exited = false;
    const done = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        exited = true;
        resolve(code);
      });
    });
    disposals.push(async () => {
      if (!exited) child.kill('SIGKILL');
      await done.catch(() => undefined);
    });
    const code = await done;
    expect(code, response).toBe(73);
    const committed = JSON.parse(response) as WorkspaceRecoveryCliReport;
    expect(committed).toMatchObject({ disposition: 'moved-out', capture: { backupId } });
    const before = bytes(join(f.dataRoot, 'workspaces', f.badId));
    const server = await boot(f.dataRoot);
    const healthy = await server.call(
      'thread.create',
      {
        workspaceId: f.goodId,
        name: 'Healthy beside tombstone',
        requestId: randomUUID(),
      },
      f.token
    );
    expect(healthy.status, await healthy.clone().text()).toBe(200);
    const refused = await server.call(
      'thread.create',
      {
        workspaceId: f.badId,
        name: 'Cannot reopen moved source',
        requestId: randomUUID(),
      },
      f.token
    );
    expect([403, 409]).toContain(refused.status);
    await server.stop();
    expect(bytes(join(f.dataRoot, 'workspaces', f.badId))).toEqual(before);
    await expect(
      runCli(
        ['inspect', '--data-root', f.dataRoot, '--workspace-id', f.badId, '--backup-id', backupId],
        () => {},
        { releaseIdentityPath }
      )
    ).resolves.toMatchObject({
      disposition: 'moved-out',
      currentRevision: committed.currentRevision,
      capture: { backupId, manifestDigest: committed.capture!.manifestDigest },
    });
  }, 120_000);
});

describe('D0 12:49Z recurring-history ruling / WM 182–188, 382, 431–432', () => {
  it('captures real schedules, occurrences and compact expired ranges in all three required JSONL families', async () => {
    const f = await recurringFixture(false);
    await captureRecurring(f, 'backup');
    await recurringBundle(f);
  }, 120_000);

  it('captures beside a pending scheduler admission without carrying its execution authority', async () => {
    const f = await recurringFixture(true);
    const report = await captureRecurring(f, 'backup');
    expect([
      ...report.capture!.interruptedTurnIds,
      ...report.capture!.unknownEffectTurnIds,
    ]).toContain(f.turnId);
    const graph = await recurringBundle(f);
    expect(graph.occurrences).toContainEqual(
      expect.objectContaining({
        originQueueEntryId: f.queueEntryId,
        originTurnId: f.turnId,
      })
    );
    expect(
      graph.occurrences.every((row) => !('queueEntryId' in row) && !('resolvedPayload' in row))
    ).toBe(true);
  }, 120_000);

  it.each([
    'restore',
    'move-in',
  ] as const)('%s retains recurring history inert across the next real boot without starting an occurrence', async (command) => {
    const f = await recurringFixture(true);
    const prepared = await captureRecurring(f, command === 'restore' ? 'backup' : 'move');
    let targetRoot = f.dataRoot;
    let ownerId = f.ownerId;
    if (command === 'move-in') {
      await expect(
        runCli(
          [
            'move-out',
            '--data-root',
            f.dataRoot,
            '--workspace-id',
            f.badId,
            '--backup-id',
            f.backupId,
            '--bundle-root',
            f.bundleRoot,
            '--expected-revision',
            String(prepared.capture!.capturedRevision),
          ],
          () => {},
          f
        )
      ).resolves.toMatchObject({ disposition: 'moved-out' });
      targetRoot = join(f.commandRoot, 'target');
      await createDemoStore({ dataRoot: targetRoot });
      // The target is otherwise native and configured; its demo Workspace is an unrelated identity collision.
      // Remove only that fixture authority before admission and keep the real server/configuration owners.
      await shutdownControlStoreWorkerClient();
      rmSync(join(targetRoot, 'workspaces', DEMO_WORKSPACE_ID), { recursive: true, force: true });
      const targetCore = openCoreDb(targetRoot);
      ownerId = ensureLocalUser(targetCore);
      targetCore.sqlite.close();
    }
    const argv =
      command === 'restore'
        ? [
            command,
            '--data-root',
            targetRoot,
            '--bundle-root',
            f.bundleRoot,
            '--workspace-id',
            f.badId,
            '--request-id',
            randomUUID(),
          ]
        : [
            command,
            '--data-root',
            targetRoot,
            '--bundle-root',
            f.bundleRoot,
            '--target-owner-id',
            ownerId,
            '--request-id',
            randomUUID(),
          ];
    await expect(runCli(argv, () => {}, f)).resolves.toMatchObject({
      disposition: command === 'restore' ? 'restored' : 'imported',
      workspaceId: f.badId,
    });
    const historyPath = join(targetRoot, 'workspaces', f.badId, 'imports/recurrence-history.json');
    const history = readFileSync(historyPath, 'utf8');
    const graph = readRecurringPortableHistory(JSON.parse(history));
    expect(graph.schedules).toContainEqual(
      expect.objectContaining({ originScheduleId: f.scheduleId })
    );
    expect(graph.occurrences.length).toBeGreaterThan(0);
    expect(graph.expiredRanges.length).toBeGreaterThan(0);
    const before = schedulingState(targetRoot, f.badId);
    if (command === 'move-in') expect(before.scheduler_admission_entries).toEqual([]);
    else {
      // Existing source queue history may remain, but it cannot retain dispatch authority.
      const entries = before.scheduler_admission_entries as { status: string }[];
      expect(
        entries.every((entry) => ['cancelled', 'expired', 'denied'].includes(entry.status))
      ).toBe(true);
    }
    expect(before.scheduler_execution_attempts).toEqual([]);
    const core = openCoreDb(targetRoot);
    try {
      const schedules = new AutomationStore(core, new WorkspaceMutationAdmission());
      expect(schedules.collectScanCandidates(new Date().toISOString())).toEqual([]);
    } finally {
      core.sqlite.close();
    }
    const server = await boot(targetRoot);
    await server.stop();
    expect(schedulingState(targetRoot, f.badId)).toEqual(before);
    expect(readFileSync(historyPath, 'utf8')).toBe(history);
  }, 120_000);
});
