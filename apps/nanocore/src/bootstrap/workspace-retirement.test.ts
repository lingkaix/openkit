// openkit-test-platform: posix
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
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
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import { openAssistantTimeline } from '../internal-agents/assistant-timeline.js';
import type { KnowledgeManagerAgentRun } from '../internal-agents/knowledge-manager-agent.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { initializeScopedNotebook } from '../knowledge/scoped-notebook-owner.js';
import {
  prepareUserMemoryMaintenance,
  runUserMemoryMaintenanceCommand,
} from '../knowledge/user-memory-agent-maintenance.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import { createDefaultWorkerMcpGateway } from '../runtime/worker-mcp-gateway.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import {
  openCoreDb,
  openUserDb,
  openWorkspaceDb,
  verifyAndMigrateExistingScopedDatabases,
} from '../storage/db.js';
import { userMemoryRoot, workspaceDbPath } from '../storage/fs-layout.js';
import {
  applyMigrations,
  applyNativeScopeMigrations,
  applyScopedMigrations,
} from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import {
  ensureUserQuickChatWorkspace,
  recordWorkspaceOwnerMembership,
} from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { isScopeAdmitted } from './readiness.js';

const disposals: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  await (
    await import('../storage/control-store-worker-client.js')
  ).shutdownControlStoreWorkerClient();
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

/** Captures every file in a fixture with no links; comparison includes additions and removals. */
function bytes(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(root.length), readFileSync(path).toString('base64')];
      })
      .sort(([left], [right]) => left!.localeCompare(right!))
  );
}

/** Creates trusted registry identity before damaging only its Workspace authority. */
async function fixture(fault: 'corrupt' | 'missing' | 'records', personal = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'retirement-cold-open-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspaceId = personal
    ? (await store.ensureQuickChatWorkspace(FIXTURE_LOCAL_USER_ID)).id
    : (await store.createWorkspace('Retired history')).id;
  const siblingId = (await store.createWorkspace('Still admitted')).id;
  for (const id of [workspaceId, siblingId])
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: id, ownerUserId: FIXTURE_LOCAL_USER_ID });
  const admin = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const member = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    scope: 'workspace',
    workspaceIds: [workspaceId, siblingId],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const admission = new WorkspaceMutationAdmission();
  const gateway = createDefaultWorkerMcpGateway(coreDb);
  const app = createApp({
    coreDb,
    dataRoot,
    store,
    mode: 'server',
    workerMcpGateway: gateway,
    workspaceMutationAdmission: admission,
    turnExecutor: new SimulatedTurnExecutor(),
  });
  disposals.push(async () => {
    await gateway.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  // An uncompleted real call distinguishes byte retention from ordinary restart recovery writes.
  await shutdownControlStoreWorkerClient();
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
  await startCapabilityCall({
    authorityActor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
    callId: testEntityId('cap', 'retirement-running-call'),
    capabilityId: 'llm.responses',
    family: 'llm',
    operation: 'responses.create',
    redactionClass: 'metadata-only',
    requestId: randomUUID(),
    workspaceDb,
    workspaceId,
  });
  await shutdownControlStoreWorkerClient();
  const originalWorkspaceRecord = workspaceDb.sqlite
    .prepare('SELECT record_json FROM control_workspaces WHERE id = ?')
    .pluck()
    .get(workspaceId) as string;
  if (fault === 'records')
    expect(
      workspaceDb.sqlite
        .prepare('UPDATE control_workspaces SET record_json = ? WHERE id = ?')
        .run(JSON.stringify('{unreadable history'), workspaceId).changes
    ).toBe(1);
  workspaceDb.sqlite.close();
  if (fault === 'missing') rmSync(workspaceDbPath(dataRoot, workspaceId));
  if (fault === 'corrupt')
    writeFileSync(workspaceDbPath(dataRoot, workspaceId), 'Retained corrupt authority');
  verifyAndMigrateExistingScopedDatabases(dataRoot, () => FsStore.validateFileAuthority(dataRoot));
  expect(isScopeAdmitted(dataRoot, 'workspace', workspaceId)).toBe(false);
  expect(isScopeAdmitted(dataRoot, 'workspace', siblingId)).toBe(true);
  const request = {
    workspaceId,
    requestId: randomUUID(),
    expectedRegistryRevision: 1,
    confirmation: `retire-quarantined-workspace:${workspaceId}:1`,
  };
  const call = (operation: string, input: Record<string, unknown>, secret = admin.secret) =>
    app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        ...(typeof input.requestId === 'string' ? { 'x-openkit-request-id': input.requestId } : {}),
      },
      body: JSON.stringify(input),
    });
  return {
    coreDb,
    dataRoot,
    workspaceId,
    siblingId,
    store,
    app,
    gateway,
    admin,
    member,
    request,
    call,
    originalWorkspaceRecord,
  };
}

/** Uses real User storage and native notebook tools; only the external model role is substituted. */
function memoryDependencies(f: Awaited<ReturnType<typeof fixture>>) {
  const userDb = openUserDb(f.dataRoot, FIXTURE_LOCAL_USER_ID);
  applyScopedMigrations(userDb);
  disposals.push(() => {
    if (userDb.sqlite.open) userDb.sqlite.close();
  });
  const run = vi.fn(async (input: KnowledgeManagerAgentRun) => {
    const submit = input.tools.find(({ name }) => name === 'knowledge.notebook.update')!;
    const result = await submit.execute(
      { summary: 'Inspect existing User Memory without edits.' },
      { callId: randomUUID(), toolOccurrence: 1, signal: input.signal }
    );
    expect(
      JSON.parse(
        result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      )
    ).toEqual({ outcome: 'no_change' });
    await f.store.updateTurn(input.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    return { turnId: input.turn.id, text: '{"summary":"No changes."}' };
  });
  const dependencies = {
    coreDb: f.coreDb,
    userDb,
    store: f.store,
    runtimeConfigManager: {
      current: () => ({
        userConfigs: [
          {
            userId: FIXTURE_LOCAL_USER_ID,
            config: {
              knowledgeMaintenance: { enabled: true, reviewRequiredPageIds: [] },
            },
          },
        ],
      }),
    } as unknown as RuntimeConfigManager,
    openWorkspace: (id: string) => openWorkspaceDb(f.dataRoot, id),
    inflightCommands: new WeakMap(),
    run,
    pin: async (input: Pick<KnowledgeManagerAgentRun, 'turn' | 'inputs'>) => {
      await f.store.updateTurn(input.turn.id, {
        internalExecution: {
          roleId: 'knowledge-manager',
          logicalModelId: 'fixture-model',
          limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 300_000 },
          contextStrategy: 'compaction',
          threshold: 1000,
          knowledge: input.inputs!,
        },
      });
    },
  };
  return {
    userDb,
    run,
    dependencies,
    input: {
      requestId: randomUUID(),
      requestActor: { kind: 'local' as const, userId: FIXTURE_LOCAL_USER_ID },
      trigger: 'request' as const,
      instructions: 'Inspect existing User Memory.',
      sources: [],
      signal: new AbortController().signal,
    },
  };
}

/** Runs the real source entry in a separate process, with no watcher, built-App dependency or Host fixture. */
async function startRetirementProcess(dataRoot: string) {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture listener address is unavailable.');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve()))
  );
  const appRoot = fileURLToPath(new URL('../../', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: appRoot,
    env: {
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      HOME: dataRoot,
      OPENKIT_DATA_ROOT: dataRoot,
      OPENKIT_CORE_MODE: 'server',
      OPENKIT_BIND_HOST: '127.0.0.1',
      PORT: String(port),
      OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR: '1',
      BETTER_AUTH_SECRET: 'retirement-process-fixture-only-secret-at-least-32-characters',
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
      output = (output + chunk.toString()).slice(-65536);
    });
  const stop = async () => {
    if (exited) return;
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    deadline.unref();
    try {
      child.kill('SIGTERM');
      await done;
    } finally {
      clearTimeout(deadline);
    }
  };
  disposals.push(stop);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await vi.waitFor(
      async () => {
        if (exited) throw new Error(`Fixture process exited before health: ${output}`);
        const response = await fetch(`${baseUrl}/api/health`, {
          signal: AbortSignal.timeout(1000),
        });
        expect(response.status).toBe(200);
      },
      { timeout: 20000, interval: 100 }
    );
  } catch (error) {
    await stop();
    throw new Error(`Real index.ts boot failed. ${output}`, { cause: error });
  }
  const call = (operation: string, input: Record<string, unknown>, secret: string) =>
    fetch(`${baseUrl}/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        ...(typeof input.requestId === 'string' ? { 'x-openkit-request-id': input.requestId } : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10000),
    });
  return { call, stop };
}

describe('retired registry consumers and retained Core migration', () => {
  it.each([
    { status: 'active', fault: 'records' },
    { status: 'retired', fault: 'records' },
    { status: 'retired', fault: 'corrupt' },
    { status: 'retired', fault: 'missing' },
  ] as const)('real index.ts process: $status registry with $fault fault decides exclusion before scoped work', async ({
    status,
    fault,
  }) => {
    const f = await fixture(fault);
    if (status === 'retired') {
      const response = await f.call('workspace.retire-quarantined', f.request);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({
        retirement: {
          workspaceId: f.workspaceId,
          ownerUserId: FIXTURE_LOCAL_USER_ID,
          registryRevision: 2,
          status: 'retired',
          dataRetained: true,
          storageReclaimed: false,
        },
      });
    }
    await f.gateway.close();
    f.coreDb.sqlite.close();
    // Reverse only the injected fixture fault while stopped. This is not a product repair path.
    // Readable retained bytes must not revive a retired identity. They make a late boot fence observable.
    const targetRoot = join(f.dataRoot, 'workspaces', f.workspaceId);
    if (fault === 'records') {
      const stopped = new Database(workspaceDbPath(f.dataRoot, f.workspaceId), {
        fileMustExist: true,
      });
      try {
        expect(
          stopped
            .prepare('UPDATE control_workspaces SET record_json = ? WHERE id = ?')
            .run(f.originalWorkspaceRecord, f.workspaceId).changes
        ).toBe(1);
      } finally {
        stopped.close();
      }
    }
    const before = bytes(targetRoot);
    /** Reads only a detached copy while the fixture or child is stopped; WAL readers can create sidecars. */
    const readCallStatus = () => {
      const beforeObservation = bytes(targetRoot);
      const observerRoot = mkdtempSync(join(tmpdir(), 'retirement-status-observer-'));
      try {
        const databasePath = workspaceDbPath(f.dataRoot, f.workspaceId);
        // Copy the entire database directory, including retained WAL, SHM and rollback journals.
        cpSync(dirname(databasePath), observerRoot, { recursive: true });
        const db = new Database(join(observerRoot, basename(databasePath)), {
          readonly: true,
          fileMustExist: true,
        });
        try {
          return db
            .prepare('SELECT status FROM capability_calls WHERE call_id = ?')
            .pluck()
            .get(testEntityId('cap', 'retirement-running-call'));
        } finally {
          db.close();
        }
      } finally {
        rmSync(observerRoot, { recursive: true, force: true });
        expect(
          bytes(targetRoot),
          'status observation must preserve every source path and byte'
        ).toEqual(beforeObservation);
      }
    };
    if (fault === 'records') expect(readCallStatus()).toBe('running');
    const process = await startRetirementProcess(f.dataRoot);
    const sibling = await process.call(
      'thread.create',
      { workspaceId: f.siblingId, name: 'Progress after real boot', requestId: randomUUID() },
      f.member.secret
    );
    expect(sibling.status, await sibling.clone().text()).toBe(200);
    const thread = (await sibling.json()) as { id: string };
    const readBack = await process.call(
      'thread.dashboard',
      { workspaceId: f.siblingId, threadId: thread.id },
      f.member.secret
    );
    expect(readBack.status).toBe(200);
    expect(await readBack.json()).toMatchObject({ thread: { id: thread.id } });
    const ordinary = await process.call(
      'workspace.member-list',
      { workspaceId: f.workspaceId },
      f.member.secret
    );
    if (status === 'retired') {
      expect([403, 409]).toContain(ordinary.status);
      const replay = await process.call('workspace.retire-quarantined', f.request, f.admin.secret);
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(await replay.json()).toMatchObject({
        retirement: {
          registryRevision: 2,
          status: 'retired',
          dataRetained: true,
          storageReclaimed: false,
        },
      });
      const recovery = await process.call(
        'workspace.deleted-recover',
        {
          workspaceId: f.workspaceId,
          requestId: randomUUID(),
          deletionRequestId: f.request.requestId,
        },
        f.admin.secret
      );
      expect([403, 409]).toContain(recovery.status);
    } else {
      expect(ordinary.status).toBe(200);
    }
    await process.stop();
    // The active control proves the same real startup changes the canary; a no-op child cannot pass both cases.
    if (fault === 'records')
      expect(readCallStatus()).toBe(status === 'retired' ? 'running' : 'unknown');
    if (fault === 'missing')
      expect(existsSync(workspaceDbPath(f.dataRoot, f.workspaceId))).toBe(false);
    if (status === 'retired') expect(bytes(targetRoot)).toEqual(before);
    else expect(bytes(targetRoot)).not.toEqual(before);
  }, 40000);

  it('CONTROL: upgrades populated Core 0011 through the ordinary migrator without losing lineage, foreign keys or owner guards', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'retirement-core0011-'));
    const coreDb = openCoreDb(dataRoot);
    disposals.push(() => {
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    const source = new URL('../../drizzle/core/', import.meta.url);
    const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', source), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const previous = { ...journal, entries: journal.entries.filter((entry) => entry.idx <= 11) };
    expect(previous.entries).toHaveLength(12);
    expect(previous.entries.at(-1)?.idx).toBe(11);
    const folder = join(dataRoot, 'fixture-core0011');
    mkdirSync(join(folder, 'meta'), { recursive: true });
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(previous));
    // Pin the retained 0011 fixture to a7a269b7c, so rewriting old migrations cannot mask data loss.
    const retainedSourceDigest = createHash('sha256').update(JSON.stringify(previous.entries));
    for (const entry of previous.entries) {
      retainedSourceDigest.update(readFileSync(new URL(`${entry.tag}.sql`, source)));
      copyFileSync(new URL(`${entry.tag}.sql`, source), join(folder, `${entry.tag}.sql`));
    }
    expect(retainedSourceDigest.digest('hex')).toBe(
      '572253024d75f508d143e0731980ebf15ba5dc7a05c28a5b4ba03c957156b70d'
    );
    applyNativeScopeMigrations(coreDb.sqlite, 'core', folder);
    ensureLocalUser(coreDb);
    coreDb.sqlite.pragma('foreign_keys = ON');
    const workspaceId = testEntityId('ws', 'retirement-migration-workspace');
    const invitee = testEntityId('usr', 'retirement-migration-invitee');
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status) VALUES (?, 'Invitee', 'retained-invitee@example.invalid', 0, 1, 1, 'human', 'active')"
      )
      .run(invitee);
    recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: FIXTURE_LOCAL_USER_ID });
    const invitationId = testEntityId('inv', 'retirement-migration-invitation');
    coreDb.sqlite
      .prepare(`INSERT INTO workspace_invitations (invitation_id, workspace_id, invitee_user_id, inviter_user_id, status, expires_at, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', '2999-01-01T00:00:00.000Z', 1, '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z')`)
      .run(invitationId, workspaceId, invitee, FIXTURE_LOCAL_USER_ID);
    const memberId = testEntityId('usr', 'retirement-migration-member');
    const acceptedId = testEntityId('inv', 'retirement-migration-accepted');
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status) VALUES (?, 'Member', 'retained-member@example.invalid', 0, 1, 1, 'human', 'active')"
      )
      .run(memberId);
    coreDb.sqlite
      .prepare(`INSERT INTO workspace_invitations (invitation_id, workspace_id, invitee_user_id, inviter_user_id, status, expires_at, accepted_at, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'accepted', '2999-01-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z', 2, '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z')`)
      .run(acceptedId, workspaceId, memberId, FIXTURE_LOCAL_USER_ID);
    coreDb.sqlite
      .prepare(`INSERT INTO workspace_members (workspace_id, user_id, status, invitation_id, joined_at, revision, created_at, updated_at)
      VALUES (?, ?, 'active', ?, '2026-10-20T00:00:00.000Z', 1, '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z')`)
      .run(workspaceId, memberId, acceptedId);
    const tables = ['workspace_registry', 'workspace_members', 'workspace_invitations'];
    const retained = () =>
      Object.fromEntries(
        tables.map((table) => [
          table,
          coreDb.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ])
      );
    const before = retained();
    const foreignKeys = () =>
      Object.fromEntries(
        tables.map((table) => [table, coreDb.sqlite.pragma(`foreign_key_list(${table})`)])
      );
    const beforeKeys = foreignKeys();
    const guards = () =>
      coreDb.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'workspace_owner_%' ORDER BY name"
        )
        .all();
    const beforeGuards = guards();
    expect(beforeGuards).toHaveLength(3);
    applyMigrations(coreDb);
    expect(retained()).toEqual(before);
    expect(foreignKeys()).toEqual(beforeKeys);
    expect(coreDb.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(coreDb.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(guards()).toEqual(beforeGuards);
    expect(() =>
      coreDb.sqlite
        .prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .run(workspaceId, FIXTURE_LOCAL_USER_ID)
    ).toThrow();
    expect(() =>
      coreDb.sqlite
        .prepare(
          "UPDATE workspace_members SET status = 'removed', removed_at = '2026-10-20T01:00:00.000Z' WHERE workspace_id = ? AND user_id = ?"
        )
        .run(workspaceId, FIXTURE_LOCAL_USER_ID)
    ).toThrow();
    expect(() =>
      coreDb.sqlite
        .prepare('UPDATE workspace_registry SET owner_user_id = ? WHERE workspace_id = ?')
        .run(invitee, workspaceId)
    ).toThrow();
    expect(retained()).toEqual(before);
    applyMigrations(coreDb);
    expect(retained()).toEqual(before);
  });

  it.each([
    'corrupt',
    'missing',
    'records',
  ] as const)('reconstructs retirement exclusion before scoped work after a lost reply with %s authority', async (fault) => {
    const f = await fixture(fault);
    // Working baseline authority is reached before the new feature is required.
    expect(
      (await f.call('workspace.member-list', { workspaceId: f.siblingId }, f.member.secret)).status
    ).toBe(200);
    const response = await f.call('workspace.retire-quarantined', f.request);
    expect(response.status, await response.clone().text()).toBe(200);
    // Discard the successful reply body: retry must use durable Core facts, not that reply or Store cache.
    const audit = f.coreDb.sqlite.prepare('SELECT * FROM audit_events ORDER BY rowid').all();
    const receipts = f.coreDb.sqlite
      .prepare('SELECT * FROM idempotency_requests ORDER BY rowid')
      .all();
    const tree = bytes(join(f.dataRoot, 'workspaces', f.workspaceId));
    await f.gateway.close();
    f.coreDb.sqlite.close();
    // Reset modules rather than clearing an admission map or manufacturing a retired registry row.
    // This is an in-process cold-open seam test, not proof of the index.ts process phase ordering.
    await shutdownControlStoreWorkerClient();
    await (
      await import('../storage/control-store-worker-client.js')
    ).shutdownControlStoreWorkerClient();
    vi.resetModules();
    const dbOwner = await import('../storage/db.js');
    const readiness = await import('./readiness.js');
    const appOwner = await import('../app.js');
    const storeOwner = await import('../lib/store.js');
    const gateOwner = await import('../workspace-mutation-admission.js');
    expect(readiness.scopeAdmissionFailures(f.dataRoot)).toEqual([]);
    const coreDb = dbOwner.openCoreDbWithIntegrityCheck(f.dataRoot);
    disposals.push(() => {
      if (coreDb.sqlite.open) coreDb.sqlite.close();
    });
    const admission = new gateOwner.WorkspaceMutationAdmission();
    appOwner.restoreWorkspaceDeletionMutationAdmission({
      coreDb,
      dataRoot: f.dataRoot,
      workspaceMutationAdmission: admission,
    });
    expect(admission.isClosed(f.workspaceId)).toBe(true);
    expect(readiness.isScopeAdmitted(f.dataRoot, 'workspace', f.workspaceId)).toBe(false);
    dbOwner.verifyAndMigrateExistingScopedDatabases(f.dataRoot, () =>
      storeOwner.FsStore.validateFileAuthority(f.dataRoot)
    );
    expect(
      dbOwner.listExistingWorkspaceDatabaseScopes(f.dataRoot).map((scope) => scope.workspaceId)
    ).not.toContain(f.workspaceId);
    const store = new storeOwner.FsStore({ dataRoot: f.dataRoot });
    expect(store.listWorkspaces().map((workspace) => workspace.id)).not.toContain(f.workspaceId);
    expect(store.getWorkspace(f.siblingId).id).toBe(f.siblingId);
    expect(() => dbOwner.openWorkspaceDb(f.dataRoot, f.workspaceId)).toThrow();
    expect(bytes(join(f.dataRoot, 'workspaces', f.workspaceId))).toEqual(tree);
    if (fault === 'missing')
      expect(existsSync(workspaceDbPath(f.dataRoot, f.workspaceId))).toBe(false);
    const restarted = appOwner.createApp({
      coreDb,
      dataRoot: f.dataRoot,
      store,
      mode: 'server',
      workspaceMutationAdmission: admission,
      turnExecutor: new SimulatedTurnExecutor(),
    });
    const retry = (operation: string, input: Record<string, unknown>) =>
      restarted.request(`/api/app/operations/${operation}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${f.admin.secret}`,
          'content-type': 'application/json',
          ...(typeof input.requestId === 'string'
            ? { 'x-openkit-request-id': input.requestId }
            : {}),
        },
        body: JSON.stringify(input),
      });
    const replay = await retry('workspace.retire-quarantined', f.request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      retirement: {
        workspaceId: f.workspaceId,
        ownerUserId: FIXTURE_LOCAL_USER_ID,
        registryRevision: 2,
        status: 'retired',
        dataRetained: true,
        storageReclaimed: false,
      },
    });
    expect(coreDb.sqlite.prepare('SELECT * FROM audit_events ORDER BY rowid').all()).toEqual(audit);
    expect(
      coreDb.sqlite.prepare('SELECT * FROM idempotency_requests ORDER BY rowid').all()
    ).toEqual(receipts);
    const ordinary = await retry('workspace.member-list', { workspaceId: f.workspaceId });
    expect([403, 409]).toContain(ordinary.status);
    const recovery = await retry('workspace.deleted-recover', {
      workspaceId: f.workspaceId,
      requestId: randomUUID(),
      deletionRequestId: f.request.requestId,
    });
    expect([403, 409]).toContain(recovery.status);
    expect(bytes(join(f.dataRoot, 'workspaces', f.workspaceId))).toEqual(tree);
    expect((await retry('workspace.member-list', { workspaceId: f.siblingId })).status).toBe(200);
  }, 20000);

  it('keeps a quarantined home without initializing User Memory or running a model', async () => {
    const f = await fixture('missing', true);
    const memory = memoryDependencies(f);
    const home = bytes(join(f.dataRoot, 'workspaces', f.workspaceId));
    const scopes = f.store.listWorkspaces().map(({ id }) => id);
    expect(existsSync(userMemoryRoot(f.dataRoot, FIXTURE_LOCAL_USER_ID))).toBe(false);
    await ensureUserQuickChatWorkspace({
      coreDb: f.coreDb,
      store: f.store,
      userId: FIXTURE_LOCAL_USER_ID,
    });
    // MEM-2: an unavailable dependency is a recovery outcome before User-notebook effects.
    await expect
      .soft(prepareUserMemoryMaintenance(memory.dependencies, memory.input))
      .rejects.toMatchObject({
        code: 'recovery_required',
      });
    expect(existsSync(userMemoryRoot(f.dataRoot, FIXTURE_LOCAL_USER_ID))).toBe(false);
    expect(
      memory.userDb.sqlite
        .prepare("SELECT 1 FROM audit_events WHERE action = 'knowledge.notebook.initialize'")
        .all()
    ).toEqual([]);
    expect(memory.run).not.toHaveBeenCalled();
    expect(f.store.listWorkspaces().map(({ id }) => id)).toEqual(scopes);
    expect(bytes(join(f.dataRoot, 'workspaces', f.workspaceId))).toEqual(home);
    expect(
      f.coreDb.sqlite
        .prepare('SELECT status, revision FROM workspace_registry WHERE workspace_id = ?')
        .get(f.workspaceId)
    ).toEqual({ status: 'active', revision: 1 });
  });

  it('retains an unpublished successor binding across Core reopen and a new authorized request', async () => {
    const f = await fixture('missing', true);
    const response = await f.call('workspace.retire-quarantined', f.request);
    expect(response.status, await response.clone().text()).toBe(200);
    const retired = bytes(join(f.dataRoot, 'workspaces', f.workspaceId));
    // Fault the Store's public publication boundary before it can create any successor bytes.
    const publication = vi
      .spyOn(f.store, 'ensureQuickChatWorkspace')
      .mockRejectedValueOnce(new Error('Injected pre-publication interruption.'));
    await expect(
      ensureUserQuickChatWorkspace({
        coreDb: f.coreDb,
        store: f.store,
        userId: FIXTURE_LOCAL_USER_ID,
      })
    ).rejects.toThrow();
    expect(publication).toHaveBeenCalledTimes(1);
    publication.mockRestore();
    const selectedId = f.coreDb.sqlite
      .prepare('SELECT personal_workspace_id FROM users WHERE id = ?')
      .pluck()
      .get(FIXTURE_LOCAL_USER_ID) as string;
    expect(selectedId).toMatch(/^ws_/);
    expect(selectedId).not.toBe(f.workspaceId);
    expect(existsSync(join(f.dataRoot, 'workspaces', selectedId))).toBe(false);
    expect(
      f.coreDb.sqlite
        .prepare('SELECT 1 FROM workspace_registry WHERE workspace_id = ?')
        .get(selectedId)
    ).toBeUndefined();
    expect(bytes(join(f.dataRoot, 'workspaces', f.workspaceId))).toEqual(retired);

    await shutdownControlStoreWorkerClient();
    await f.gateway.close();
    f.coreDb.sqlite.close();
    const coreDb = openCoreDb(f.dataRoot);
    disposals.push(() => {
      if (coreDb.sqlite.open) coreDb.sqlite.close();
    });
    applyMigrations(coreDb);
    expect(
      coreDb.sqlite
        .prepare('SELECT personal_workspace_id FROM users WHERE id = ?')
        .pluck()
        .get(FIXTURE_LOCAL_USER_ID)
    ).toBe(selectedId);
    const store = new FsStore({ dataRoot: f.dataRoot });
    // This is a new authorized request after the known pre-effect failure, not an inferred effect replay.
    await ensureUserQuickChatWorkspace({
      coreDb,
      store,
      userId: FIXTURE_LOCAL_USER_ID,
    });
    expect(
      store
        .listWorkspaces()
        .filter(({ kind }) => kind === 'personal')
        .map(({ id }) => id)
    ).toEqual([selectedId]);
    expect(
      coreDb.sqlite
        .prepare('SELECT personal_workspace_id FROM users WHERE id = ?')
        .pluck()
        .get(FIXTURE_LOCAL_USER_ID)
    ).toBe(selectedId);
    expect(
      coreDb.sqlite
        .prepare('SELECT status, revision FROM workspace_registry WHERE workspace_id = ?')
        .get(f.workspaceId)
    ).toEqual({ status: 'retired', revision: 2 });
    expect(existsSync(workspaceDbPath(f.dataRoot, f.workspaceId))).toBe(false);
    expect(bytes(join(f.dataRoot, 'workspaces', f.workspaceId))).toEqual(retired);
  });

  it('replaces only terminally retired personal homes and routes private native maintenance through the durable successor', async () => {
    const f = await fixture('missing', true);
    // This retained User has no explicit binding and keeps its pre-existing deterministic home.
    expect(f.workspaceId).toBe('ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28');
    const memory = memoryDependencies(f);
    const notebookRoot = userMemoryRoot(f.dataRoot, FIXTURE_LOCAL_USER_ID);
    const originalRevision = initializeScopedNotebook({
      coreDb: f.coreDb,
      userDb: memory.userDb,
      actor: memory.input.requestActor,
      target: { kind: 'user' },
      initialization: {
        requestId: randomUUID(),
        instructionReference: 'test:retained-user-memory',
      },
    });
    const notebook = new KnowledgeNotebook({ repositoryPath: join(notebookRoot, 'notebook.git') });
    const originalMemory = notebook.readRevision(originalRevision);
    const response = await f.call('workspace.retire-quarantined', f.request);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(
      (await f.call('workspace.member-list', { workspaceId: f.siblingId }, f.member.secret)).status
    ).toBe(200);
    expect([403, 409]).toContain(
      (await f.call('workspace.member-list', { workspaceId: f.workspaceId }, f.member.secret))
        .status
    );
    const retired = bytes(join(f.dataRoot, 'workspaces', f.workspaceId));
    // One caller may meet an unpublished Workspace and truthfully refuse; neither may mint another successor.
    const attempts = await Promise.allSettled(
      [0, 1].map(() =>
        ensureUserQuickChatWorkspace({
          coreDb: f.coreDb,
          store: f.store,
          userId: FIXTURE_LOCAL_USER_ID,
        })
      )
    );
    expect(attempts.some(({ status }) => status === 'fulfilled')).toBe(true);
    // A new authorized invocation must reuse the acknowledged identity after those attempts settle.
    await ensureUserQuickChatWorkspace({
      coreDb: f.coreDb,
      store: f.store,
      userId: FIXTURE_LOCAL_USER_ID,
    });
    const homes = f.store.listWorkspaces().filter(({ kind }) => kind === 'personal');
    expect(homes).toHaveLength(1);
    const successorId = homes[0]!.id;
    expect(successorId).not.toBe(f.workspaceId);
    const timeline = await openAssistantTimeline(
      f.store,
      successorId,
      FIXTURE_LOCAL_USER_ID,
      'Private successor Timeline'
    );
    expect(timeline).toMatchObject({
      visibility: 'private',
      privateOwnerUserId: FIXTURE_LOCAL_USER_ID,
    });
    // Real User preparation, native maintenance admission and native notebook submission surround only a fake model.
    const result = await runUserMemoryMaintenanceCommand(memory.dependencies, memory.input);
    expect(result).toMatchObject({ outcome: 'no-change', notebookRevision: originalRevision });
    expect(f.store.getThread(successorId, result.threadId)).toMatchObject({
      visibility: 'private',
      privateOwnerUserId: FIXTURE_LOCAL_USER_ID,
      entryPath: 'knowledge-manager',
    });
    expect(await runUserMemoryMaintenanceCommand(memory.dependencies, memory.input)).toEqual(
      result
    );
    expect(memory.run).toHaveBeenCalledTimes(1);
    expect(notebook.readRevision(notebook.publishedRevision())).toEqual(originalMemory);
    expect(bytes(join(f.dataRoot, 'workspaces', f.workspaceId))).toEqual(retired);
    expect(existsSync(workspaceDbPath(f.dataRoot, f.workspaceId))).toBe(false);

    // A successor can itself retire; this must not fall back to either reserved identity.
    await shutdownControlStoreWorkerClient();
    rmSync(workspaceDbPath(f.dataRoot, successorId));
    verifyAndMigrateExistingScopedDatabases(f.dataRoot, () =>
      FsStore.validateFileAuthority(f.dataRoot)
    );
    expect(isScopeAdmitted(f.dataRoot, 'workspace', successorId)).toBe(false);
    const second = await f.call('workspace.retire-quarantined', {
      workspaceId: successorId,
      requestId: randomUUID(),
      expectedRegistryRevision: 1,
      confirmation: `retire-quarantined-workspace:${successorId}:1`,
    });
    expect(second.status, await second.clone().text()).toBe(200);
    const successorBytes = bytes(join(f.dataRoot, 'workspaces', successorId));
    await ensureUserQuickChatWorkspace({
      coreDb: f.coreDb,
      store: f.store,
      userId: FIXTURE_LOCAL_USER_ID,
    });
    const currentHomes = f.store.listWorkspaces().filter(({ kind }) => kind === 'personal');
    expect(currentHomes).toHaveLength(1);
    const currentId = currentHomes[0]!.id;
    expect([f.workspaceId, successorId]).not.toContain(currentId);

    await shutdownControlStoreWorkerClient();
    await f.gateway.close();
    f.coreDb.sqlite.close();
    const coreDb = openCoreDb(f.dataRoot);
    disposals.push(() => {
      if (coreDb.sqlite.open) coreDb.sqlite.close();
    });
    applyMigrations(coreDb);
    const store = new FsStore({ dataRoot: f.dataRoot });
    for (const _ of [0, 1])
      await ensureUserQuickChatWorkspace({ coreDb, store, userId: FIXTURE_LOCAL_USER_ID });
    expect(
      store
        .listWorkspaces()
        .filter(({ kind }) => kind === 'personal')
        .map(({ id }) => id)
    ).toEqual([currentId]);
    expect(notebook.readRevision(notebook.publishedRevision())).toEqual(originalMemory);
    for (const id of [f.workspaceId, successorId]) {
      expect(
        coreDb.sqlite
          .prepare('SELECT status, revision FROM workspace_registry WHERE workspace_id = ?')
          .get(id)
      ).toEqual({ status: 'retired', revision: 2 });
      expect(existsSync(workspaceDbPath(f.dataRoot, id))).toBe(false);
    }
    expect(bytes(join(f.dataRoot, 'workspaces', f.workspaceId))).toEqual(retired);
    expect(bytes(join(f.dataRoot, 'workspaces', successorId))).toEqual(successorBytes);
    expect(store.getWorkspace(f.siblingId).id).toBe(f.siblingId);
  }, 20000);
});
