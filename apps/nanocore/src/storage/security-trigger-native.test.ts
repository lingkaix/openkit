// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import { describe, it, onTestFinished, vi } from 'vitest';
import { listServerAuditEvents, listWorkspaceAuditEvents } from '../audit-events.js';
import { createAccessTokenOperationImplementations } from '../auth/access-token-operations.js';
import { verifyOpenKitAccessTokenRecord } from '../auth/access-token-verification.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { ensureServerBootstrapTokenForStartup } from '../auth/bootstrap-ensure.js';
import { writeServerBootstrapTokenEmission } from '../auth/bootstrap-token.js';
import { type Actor, actorFromSession, ensureLocalUser } from '../auth/identity.js';
import { createCatalogOperationImplementations } from '../catalog/catalog-operations.js';
import { loadWorkspaceResourceCatalog } from '../catalog/resource-catalog.js';
import { FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { securityRequestId } from '../security/identifiers.js';
import { SecurityTriggerStore } from '../security/trigger.js';
import { closeWorkspaceProductReadHandles } from '../storage/control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { createWorkspaceOperationImplementations } from '../workspace-operation-implementations.js';
import { createWorkspaceSharingOperationImplementations } from '../workspace-sharing-operations.js';

type Snapshot = Awaited<ReturnType<SecurityTriggerStore['current']>>;
type Alarm = Awaited<ReturnType<SecurityTriggerStore['readAlarms']>>[number];
const FIRST = '2026-11-14T00:00:00.000Z';
const LATER = '2026-11-14T00:01:00.000Z';
const EXPIRY = '2099-01-01T00:00:00.000Z';
const projection = (s: Snapshot) => ({
  state: s.state,
  enableGeneration: s.enableGeneration,
  enablingUserId: s.enablingUserId,
  delegationCurrent: s.delegationCurrent,
  stoppingReason: s.stoppingReason,
});
const alarmProjection = (rows: readonly Alarm[]) =>
  rows
    .map(({ requestId, recipientUserId, rule, key, occurrence, raised }) => ({
      requestId,
      recipientUserId,
      rule,
      key,
      occurrence,
      raised,
    }))
    .sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
const context = (
  actor: Actor,
  scope: AdmittedOperationContext['scope'] = { kind: 'server' }
): AdmittedOperationContext => ({
  kind: 'public',
  actor,
  actorRef: { kind: 'user', id: actor.userId },
  scope,
});
const protocolMessage = (
  value: unknown
): value is { operation: string; id: number; status?: string } =>
  typeof value === 'object' &&
  value !== null &&
  'operation' in value &&
  typeof value.operation === 'string' &&
  'id' in value &&
  typeof value.id === 'number';

/** Call-through observation only: real Worker, real request, real result and covering ACK. */
function observeNativeSecurity() {
  const sent = vi.spyOn(Worker.prototype, 'postMessage');
  const emitted = vi.spyOn(Worker.prototype, 'emit');
  return {
    checkpoint() {
      return sent.mock.calls.length;
    },
    assertRoundTrip(since = 0) {
      const ids = new Set(
        sent.mock.calls
          .slice(since)
          .map(([message]) => message)
          .filter(protocolMessage)
          .filter((message) => message.operation === 'security-trigger')
          .map((message) => message.id)
      );
      assert.ok(
        ids.size > 0,
        'the public security facade must cross the real closed Core worker entry'
      );
      assert.ok(
        emitted.mock.calls.some(
          ([event, message]) =>
            event === 'message' &&
            protocolMessage(message) &&
            message.operation === 'security-trigger' &&
            message.status === 'ok' &&
            ids.has(message.id)
        ),
        'a genuine matching native success reply must be observed; no callback supplies a commit'
      );
    },
    restore() {
      emitted.mockRestore();
      sent.mockRestore();
    },
  };
}

/** Only schema initialization and original public producers create fixture state. */
async function fixture() {
  await shutdownControlStoreWorkerClient();
  const trace = observeNativeSecurity();
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-security-n1-'));
  let coreDb = openCoreDb(dataRoot);
  async function close() {
    closeWorkspaceProductReadHandles(dataRoot);
    if (coreDb.sqlite.open && coreDb.sqlite.readonly) coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
  }
  onTestFinished(async () => {
    try {
      await close();
      rmSync(dataRoot, { recursive: true, force: true });
    } finally {
      trace.restore();
    }
  });
  applyMigrations(coreDb);
  return {
    dataRoot,
    trace,
    get db() {
      return coreDb;
    },
    get trigger() {
      return new SecurityTriggerStore(coreDb);
    },
    tokens() {
      return createAccessTokenOperationImplementations({ coreDb, mode: 'server' });
    },
    async reopen() {
      await close();
      coreDb = openCoreDb(dataRoot);
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Real secret verification supplies the exact non-secret Actor fields; no asserted privilege. */
async function tokenActor(f: Fixture, secret: string): Promise<Actor> {
  const record = await verifyOpenKitAccessTokenRecord(f.db, secret);
  assert.ok(record, 'original verifier must admit the owner-issued synthetic credential');
  return {
    kind: 'token',
    userId: record.ownerUserId,
    tokenId: record.tokenId,
    tokenScope: record.scope,
    tokenWorkspaceIds: record.workspaceIds,
  };
}

/** Real signup, signed cookie and getSession own this non-administrator, not a seeded User row. */
async function signup(f: Fixture, name: string): Promise<{ actor: Actor; email: string }> {
  const auth = createBetterAuth(f.db, {
    mode: 'local',
    env: { BETTER_AUTH_URL: 'https://auth.example.invalid' },
  });
  const created = await auth.api.signUpEmail({
    returnHeaders: true,
    body: { name, email: [randomUUID(), 'example.invalid'].join('@'), password: randomUUID() },
  });
  const cookies = created.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
  const session = await auth.api.getSession({ headers: new Headers({ cookie: cookies }) });
  assert.ok(session, 'the actual auth owner must admit its created session');
  return { actor: actorFromSession(session), email: session.user.email };
}

async function serverFixture() {
  const f = await fixture();
  const bootstrap = await ensureServerBootstrapTokenForStartup(f.db);
  assert.ok(bootstrap, 'fresh isolated deployment must have its original bootstrap ceremony');
  writeServerBootstrapTokenEmission(f.dataRoot, bootstrap);
  const owner = await f.tokens()['bootstrap.consume']({
    token: bootstrap.token,
    ownerUserId: allocateEntityId('usr'),
    displayName: 'N1 enabling administrator',
    email: [randomUUID(), 'example.invalid'].join('@'),
    password: randomUUID(),
    tokenExpiresAt: EXPIRY,
  });
  const admin = await tokenActor(f, owner.token);
  const backupUser = await signup(f, 'N1 independent administrator');
  const backupIssue = await f.tokens()['token.create'](
    {
      ownerUserId: backupUser.actor.userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: EXPIRY,
    },
    context(admin)
  );
  const backup = await tokenActor(f, backupIssue.token);
  return {
    base: f,
    admin,
    backup,
    backupEmail: backupUser.email,
    ownerTokenId: owner.record.tokenId,
  };
}

/** The original pending row inputs, not caller-allocated request ids, determine exact E4 identity. */
function assertAlarms(
  rows: readonly Alarm[],
  rule: 'R1' | 'R8',
  recipients: readonly string[],
  generation: number
) {
  assert.deepEqual(rows.map((row) => row.recipientUserId).sort(), [...recipients].sort());
  for (const row of rows) {
    assert.equal(row.rule, rule);
    assert.equal(row.raised, false, 'N1 does not fabricate an N3 raised outcome');
    assert.equal(row.key[0], 'gap');
    assert.equal(row.key[1], generation);
    assert.ok(typeof row.key[2] === 'string' && row.key[2].length > 0);
    assert.ok(typeof row.key[3] === 'string' && row.key[3].length > 0);
    assert.deepEqual(row.occurrence, { kind: 'initial', n: 1 });
    assert.equal(
      row.requestId,
      securityRequestId({
        key: row.key,
        recipientUserId: row.recipientUserId,
        occurrence: row.occurrence,
      })
    );
  }
}

describe('N1 real-native Server security trigger authority and alarms', () => {
  it('starts off without delegation, alarms or an authorized Audit read', async () => {
    const f = await fixture();
    assert.deepEqual(projection(await f.trigger.current(FIRST)), {
      state: 'off',
      enableGeneration: 0,
      enablingUserId: null,
      delegationCurrent: false,
      stoppingReason: null,
    });
    assert.deepEqual(await f.trigger.readAlarms(), []);
    await assert.rejects(() => f.trigger.readAudit({ now: FIRST }));
    f.trace.assertRoundTrip();
  });

  it('uses the genuine canonical local identity and preserves enabled state through database reopen', async () => {
    const f = await fixture();
    const userId = await ensureLocalUser(f.db);
    const actor: Actor = { kind: 'local', userId };
    const expected = {
      state: 'on',
      enableGeneration: 1,
      enablingUserId: userId,
      delegationCurrent: true,
      stoppingReason: null,
    };
    assert.deepEqual(projection(await f.trigger.enable(actor, FIRST)), expected);
    assert.deepEqual(projection(await f.trigger.enable(actor, LATER)), expected);
    await f.reopen();
    assert.deepEqual(projection(await f.trigger.current(LATER)), expected);
    assert.deepEqual(await f.trigger.readAlarms(), []);
    f.trace.assertRoundTrip();
  });

  it('admits a real verified administrator, not a session claim, wrong-owner Token or forged local kind', async () => {
    const s = await serverFixture(),
      f = s.base;
    const { actor: ordinary } = await signup(f, 'N1 non-administrator');
    const pretenders: Actor[] = [
      ordinary,
      Object.assign({}, ordinary, { tokenScope: 'server-admin' as const, isAdmin: true }),
      {
        kind: 'token',
        userId: ordinary.userId,
        tokenId: s.ownerTokenId,
        tokenScope: 'server-admin',
        tokenWorkspaceIds: [],
      },
      { kind: 'local', userId: ordinary.userId },
    ];
    for (const actor of pretenders) await assert.rejects(() => f.trigger.enable(actor, FIRST));
    assert.equal((await f.trigger.current(FIRST)).state, 'off');
    assert.deepEqual(await f.trigger.readAlarms(), []);
    assert.deepEqual(projection(await f.trigger.enable(s.admin, FIRST)), {
      state: 'on',
      enableGeneration: 1,
      enablingUserId: s.admin.userId,
      delegationCurrent: true,
      stoppingReason: null,
    });
    for (const actor of pretenders) await assert.rejects(() => f.trigger.stop(actor, LATER));
    assert.equal((await f.trigger.current(LATER)).state, 'on');
    assert.deepEqual(await f.trigger.readAlarms(), []);
    await f.reopen();
    assert.deepEqual(projection(await f.trigger.current(LATER)), {
      state: 'on',
      enableGeneration: 1,
      enablingUserId: s.admin.userId,
      delegationCurrent: true,
      stoppingReason: null,
    });
    f.trace.assertRoundTrip();
  });

  it('stops with original R1 alarms, keeps exact identities on duplicate stop/reopen and cannot overwrite stopping', async () => {
    const s = await serverFixture(),
      f = s.base;
    await f.trigger.enable(s.admin, FIRST);
    assert.deepEqual(await f.trigger.readAlarms(), []);
    const stopEntry = f.trace.checkpoint();
    const stopped = await f.trigger.stop(s.backup, LATER);
    f.trace.assertRoundTrip(stopEntry);
    assert.equal(stopped.state, 'stopping');
    assert.equal(stopped.stoppingReason, 'monitoring-off');
    const alarmEntry = f.trace.checkpoint();
    const rows = await f.trigger.readAlarms();
    f.trace.assertRoundTrip(alarmEntry);
    assertAlarms(rows, 'R1', [s.admin.userId, s.backup.userId], 1);
    assert.equal(
      (await f.trigger.readAudit({ limit: 1, now: LATER })).events.length,
      1,
      'authorized stopping retains the existing delegated Audit read until N3 completes the stop'
    );
    const original = alarmProjection(rows);
    await Promise.all([f.trigger.stop(s.admin, LATER), f.trigger.stop(s.backup, LATER)]);
    assert.deepEqual(alarmProjection(await f.trigger.readAlarms()), original);
    await f.reopen();
    assert.deepEqual(alarmProjection(await f.trigger.readAlarms()), original);
    assert.equal((await f.trigger.current(LATER)).state, 'stopping');
    // Both refusal and unchanged stopping projection are allowed; overwrite is not.
    await f.trigger.enable(s.admin, LATER).catch(() => undefined);
    assert.equal((await f.trigger.current(LATER)).state, 'stopping');
    assert.equal((await f.trigger.current(LATER)).enableGeneration, 1);
    assert.deepEqual(alarmProjection(await f.trigger.readAlarms()), original);
    f.trace.assertRoundTrip();
  });

  it.each(['credential revocation', 'canonical User disable'] as const)(
    'uses real %s to atomically enter stopping with stable R8 alarms',
    async (loss) => {
      const s = await serverFixture(),
        f = s.base;
      await f.trigger.enable(s.admin, FIRST);
      if (loss === 'credential revocation') {
        const revoked = await f
          .tokens()
          ['token.revoke']({ tokenId: s.ownerTokenId }, context(s.backup));
        assert.equal(revoked.record.status, 'revoked');
      } else {
        const operations = createWorkspaceSharingOperationImplementations({
          coreDb: f.db,
          store: new FsStore({ dataRoot: f.dataRoot }),
          inflightCommands: new Map(),
          workspaceMutationAdmission: new WorkspaceMutationAdmission(),
        });
        const result = await operations['user.disable'](
          { requestId: randomUUID(), targetUserId: s.admin.userId },
          context(s.backup)
        );
        assert.equal(result.user.status, 'disabled');
      }
      // Loss is first discovered by the real Audit entry. Its rejection must not roll back R8.
      const lossEntry = f.trace.checkpoint();
      await assert.rejects(() => f.trigger.readAudit({ now: LATER }));
      f.trace.assertRoundTrip(lossEntry);
      const rows = await f.trigger.readAlarms();
      assertAlarms(rows, 'R8', [s.backup.userId], 1);
      const original = alarmProjection(rows);
      assert.deepEqual(projection(await f.trigger.current(LATER)), {
        state: 'stopping',
        enableGeneration: 1,
        enablingUserId: s.admin.userId,
        delegationCurrent: false,
        stoppingReason: 'lost-authority',
      });
      await f.trigger.current(LATER);
      assert.deepEqual(alarmProjection(await f.trigger.readAlarms()), original);
      await f.reopen();
      assert.deepEqual(alarmProjection(await f.trigger.readAlarms()), original);
      assert.equal((await f.trigger.current(LATER)).state, 'stopping');
      f.trace.assertRoundTrip();
    }
  );

  it('reads at most 128 real Server Audits without joining an actually produced Workspace Audit', async () => {
    const s = await serverFixture(),
      f = s.base;
    const store = new FsStore({ dataRoot: f.dataRoot });
    const workspaceApi = createWorkspaceOperationImplementations({
      coreDb: f.db,
      store,
      inflightCommands: new Map(),
    });
    const workspace = await workspaceApi['workspace.create'](
      { requestId: randomUUID(), name: 'N1 isolated Workspace evidence' },
      context(s.admin, { kind: 'user' })
    );
    const linkedRequestId = randomUUID();
    const sharing = createWorkspaceSharingOperationImplementations({
      coreDb: f.db,
      store,
      inflightCommands: new Map(),
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    await sharing['workspace.invitation-create'](
      { workspaceId: workspace.id, requestId: linkedRequestId, inviteeEmail: s.backupEmail },
      context(s.admin, { kind: 'workspace', workspaceId: workspace.id })
    );
    const coreLinked = listServerAuditEvents(f.db).find(
      (event) =>
        event.requestId === linkedRequestId && event.action === 'workspace.invitation.create'
    );
    assert.ok(
      coreLinked,
      'the original native sharing producer must publish its actual Core Audit fact'
    );
    assert.equal(
      coreLinked.workspaceId,
      workspace.id,
      'opaque Workspace linkage does not change the Core Audit home'
    );
    const requestId = randomUUID();
    const catalog = createCatalogOperationImplementations({
      coreDb: f.db,
      dataRoot: f.dataRoot,
      store,
      inflightCommands: new Map(),
      repositoryWorkspaceDb: (id) => openWorkspaceDb(f.dataRoot, id),
    });
    await catalog['catalog.mcp-create'](
      {
        workspaceId: workspace.id,
        requestId,
        expectedRevision: loadWorkspaceResourceCatalog(f.dataRoot, workspace.id).revision,
        id: 'n1-workspace-only',
        displayName: 'N1 Workspace-only Audit witness',
        allowedTools: ['probe'],
        declaration: { kind: 'http', endpoint: 'https://fixture.example.invalid/mcp' },
      },
      context(s.admin, { kind: 'workspace', workspaceId: workspace.id })
    );
    const db = openWorkspaceDb(f.dataRoot, workspace.id);
    let workspaceAuditId: string;
    try {
      const witness = listWorkspaceAuditEvents(db, workspace.id).find(
        (event) => event.action === 'catalog.mcp-create' && event.requestId === requestId
      );
      assert.ok(
        witness,
        'the original catalog operation must produce actual Workspace-owned evidence'
      );
      workspaceAuditId = witness.id;
    } finally {
      db.sqlite.close();
    }
    // More than one page, each event emitted by original native Token/Audit producers.
    for (let index = 0; index < 129; index++) {
      await f
        .tokens()
        ['token.create'](
          { scope: 'server-admin', workspaceIds: [], expiresAt: EXPIRY },
          context(s.admin)
        );
    }
    await f.trigger.enable(s.admin, FIRST);
    const serverIds = new Set(listServerAuditEvents(f.db).map((event) => event.id));
    assert.ok(serverIds.size > 128);
    assert.equal(serverIds.has(workspaceAuditId), false);
    const auditEntry = f.trace.checkpoint();
    const page = await f.trigger.readAudit({ limit: 128, now: LATER });
    f.trace.assertRoundTrip(auditEntry);
    assert.equal(page.events.length, 128);
    assert.ok(page.next);
    const rest = await f.trigger.readAudit({ after: page.next, limit: 128, now: LATER });
    assert.ok(rest.events.length > 0 && rest.events.length <= 128);
    const all = [...page.events, ...rest.events];
    assert.equal(
      new Set(all.map((event) => event.id)).size,
      all.length,
      'continuation does not duplicate the original page'
    );
    assert.ok(
      all.every((event) => serverIds.has(event.id)),
      'read facts remain in the actual Core Server Audit home'
    );
    assert.ok(
      all.some((event) => event.id === coreLinked.id),
      'Core facts with an opaque Workspace link are not filtered away'
    );
    assert.ok(
      all.every((event) => event.id !== workspaceAuditId),
      'no Workspace Audit/content join'
    );
    f.trace.assertRoundTrip();
  });
});
