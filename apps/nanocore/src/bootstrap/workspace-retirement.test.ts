import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import { createDefaultWorkerMcpGateway } from '../runtime/worker-mcp-gateway.js';
import {
  openCoreDb,
  openWorkspaceDb,
  verifyAndMigrateExistingScopedDatabases,
} from '../storage/db.js';
import { workspaceDbPath } from '../storage/fs-layout.js';
import { applyMigrations, applyNativeScopeMigrations } from '../storage/migrate.js';
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
function fixture(fault: 'corrupt' | 'missing' | 'records', personal = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'retirement-cold-open-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspaceId = personal
    ? store.ensureQuickChatWorkspace(FIXTURE_LOCAL_USER_ID).id
    : store.createWorkspace('Retired history').id;
  const siblingId = store.createWorkspace('Still admitted').id;
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
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
  startCapabilityCall({
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
  workspaceDb.sqlite.close();
  if (fault === 'missing') rmSync(workspaceDbPath(dataRoot, workspaceId));
  if (fault === 'corrupt')
    writeFileSync(workspaceDbPath(dataRoot, workspaceId), 'Retained corrupt authority');
  if (fault === 'records')
    writeFileSync(
      join(dataRoot, 'workspaces', workspaceId, 'workspace-record.json'),
      '{unreadable history'
    );
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
  };
}

describe('retired registry consumers and retained Core migration', () => {
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
    const f = fixture(fault);
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

  it('does not reprovision a retired personal identity while its user can still access a healthy sibling', async () => {
    const f = fixture('missing', true);
    const response = await f.call('workspace.retire-quarantined', f.request);
    expect(response.status, await response.clone().text()).toBe(200);
    const tree = bytes(join(f.dataRoot, 'workspaces', f.workspaceId));
    const ensure = vi.spyOn(f.store, 'ensureQuickChatWorkspace');
    // This is the existing successful-session provisioning callback, not a new recovery API.
    expect(() =>
      ensureUserQuickChatWorkspace({
        coreDb: f.coreDb,
        store: f.store,
        userId: FIXTURE_LOCAL_USER_ID,
      })
    ).not.toThrow();
    const sibling = await f.call(
      'workspace.member-list',
      { workspaceId: f.siblingId },
      f.member.secret
    );
    expect(sibling.status).toBe(200);
    const personal = await f.call(
      'workspace.member-list',
      { workspaceId: f.workspaceId },
      f.member.secret
    );
    expect([403, 409]).toContain(personal.status);
    expect(ensure).not.toHaveBeenCalled();
    expect(
      f.coreDb.sqlite
        .prepare('SELECT status, revision FROM workspace_registry WHERE workspace_id = ?')
        .get(f.workspaceId)
    ).toEqual({ status: 'retired', revision: 2 });
    expect(bytes(join(f.dataRoot, 'workspaces', f.workspaceId))).toEqual(tree);
    expect(existsSync(workspaceDbPath(f.dataRoot, f.workspaceId))).toBe(false);
  });
});
