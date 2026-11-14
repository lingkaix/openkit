// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import { describe, it, onTestFinished, vi } from 'vitest';
import { createAccessTokenOperationImplementations } from '../auth/access-token-operations.js';
import { verifyOpenKitAccessTokenRecord } from '../auth/access-token-verification.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { ensureServerBootstrapTokenForStartup } from '../auth/bootstrap-ensure.js';
import { writeServerBootstrapTokenEmission } from '../auth/bootstrap-token.js';
import { type Actor, actorFromSession, ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { securityRequestId, securityThreadId } from '../security/identifiers.js';
import { prepareSecurityThread, selectSecurityThread } from '../security/threads.js';
import { SecurityTriggerStore } from '../security/trigger.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { createWorkspaceSharingOperationImplementations } from '../workspace-sharing-operations.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { resolvePersonalWorkspaceIdInDb } from './workspace-owner-records.js';

type Selection = Awaited<ReturnType<typeof prepareSecurityThread>>;
type Alarm = Awaited<ReturnType<SecurityTriggerStore['readAlarms']>>[number];
const EXPIRY = '2099-01-01T00:00:00.000Z';
const selection = (value: Selection) => ({
  recipientUserId: value.recipientUserId,
  generation: value.generation,
  workspaceId: value.workspaceId,
  threadId: value.threadId,
  threadStatus: value.threadStatus,
});
const context = (actor: Actor): AdmittedOperationContext => ({
  kind: 'public',
  actor,
  actorRef: { kind: 'user', id: actor.userId },
  scope: { kind: 'server' },
});
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const wire = (
  value: unknown
): value is Record<string, unknown> & { operation: string; id: number } =>
  object(value) && typeof value.operation === 'string' && typeof value.id === 'number';

/** Passive call-through observations, never a replacement publisher, result or acknowledgement. */
function observeNative() {
  const sent = vi.spyOn(Worker.prototype, 'postMessage');
  const emitted = vi.spyOn(Worker.prototype, 'emit');
  const homes = vi.spyOn(FsStore.prototype, 'ensureQuickChatWorkspace');
  const threads = vi.spyOn(FsStore.prototype, 'createThread');
  function calls(since: number) {
    return sent.mock.calls
      .slice(since)
      .map(([message], index) => ({ message, order: sent.mock.invocationCallOrder[since + index] }))
      .filter((call) => wire(call.message));
  }
  function acknowledgement(message: unknown) {
    if (!wire(message)) return undefined;
    const index = emitted.mock.calls.findIndex(
      ([event, reply]) =>
        event === 'message' &&
        wire(reply) &&
        reply.operation === message.operation &&
        reply.id === message.id &&
        reply.status === 'ok'
    );
    return index < 0 ? undefined : emitted.mock.invocationCallOrder[index];
  }
  function threadWrites(since: number, threadId: string) {
    return calls(since).filter(
      ({ message }) =>
        wire(message) &&
        (message.operation === 'products' || message.operation === 'transition') &&
        typeof message.database === 'string' &&
        message.database.startsWith('workspace:') &&
        object(message.transition) &&
        Array.isArray(message.transition.products) &&
        message.transition.products.some(
          (product: unknown) =>
            object(product) &&
            product.kind === 'thread' &&
            object(product.record) &&
            product.record.id === threadId
        )
    );
  }
  return {
    checkpoint() {
      return sent.mock.calls.length;
    },
    coreRoundTrip(since: number) {
      assert.ok(
        calls(since).some(
          ({ message }) =>
            wire(message) &&
            message.operation === 'security-trigger' &&
            acknowledgement(message) !== undefined
        ),
        'a real matching Core security-family success ACK is required'
      );
    },
    prepared(since: number, value: Selection) {
      assert.ok(
        homes.mock.calls.some(([userId]) => userId === value.recipientUserId),
        'the original Personal Workspace producer must run'
      );
      assert.ok(
        threads.mock.calls.some(
          ([workspaceId, , threadId, entryPath, audience]) =>
            workspaceId === value.workspaceId &&
            threadId === value.threadId &&
            entryPath === 'administration' &&
            audience?.visibility === 'private' &&
            audience.privateOwnerUserId === value.recipientUserId
        ),
        'the original Thread producer must receive the native tuple and exact private audience'
      );
      const writes = threadWrites(since, value.threadId);
      assert.ok(
        writes.length > 0,
        'real Workspace native Thread publication, not a callback commit'
      );
      const acks = writes
        .map(({ message }) => acknowledgement(message))
        .filter((order) => order !== undefined);
      assert.ok(
        acks.length > 0,
        'the actual Workspace Thread write must have its native success ACK'
      );
      const workspaceAck = Math.min(...acks);
      assert.ok(
        calls(since).some(
          ({ message, order }) =>
            wire(message) &&
            message.operation === 'security-trigger' &&
            order > workspaceAck &&
            acknowledgement(message) !== undefined
        ),
        'Core completion must follow the original Workspace Thread ACK before prepare returns'
      );
    },
    noThreadWrite(since: number, threadId: string) {
      assert.equal(
        threadWrites(since, threadId).length,
        0,
        'a ready/incomplete tuple must not be rewritten or repaired'
      );
    },
    restore() {
      threads.mockRestore();
      homes.mockRestore();
      emitted.mockRestore();
      sent.mockRestore();
    },
  };
}

/** Only original schema, identity, alarm and Workspace/Thread producers create retained state. */
async function fixture() {
  await shutdownControlStoreWorkerClient();
  const trace = observeNative();
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-security-n3-selector-'));
  const extraRoots: string[] = [];
  let coreDb = openCoreDb(dataRoot);
  let store: FsStore;
  async function close() {
    for (const root of [dataRoot, ...extraRoots]) closeWorkspaceProductReadHandles(root);
    if (coreDb.sqlite.open && coreDb.sqlite.readonly) coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
  }
  onTestFinished(async () => {
    try {
      await close();
      for (const root of [dataRoot, ...extraRoots]) rmSync(root, { recursive: true, force: true });
    } finally {
      trace.restore();
    }
  });
  applyMigrations(coreDb);
  store = new FsStore({ dataRoot });
  return {
    dataRoot,
    trace,
    get db() {
      return coreDb;
    },
    get store() {
      return store;
    },
    get trigger() {
      return new SecurityTriggerStore(coreDb);
    },
    tokens() {
      return createAccessTokenOperationImplementations({ coreDb, mode: 'server' });
    },
    foreignStore() {
      const root = mkdtempSync(join(tmpdir(), 'openkit-security-n3-other-'));
      extraRoots.push(root);
      const actualOtherCore = openCoreDb(root);
      applyMigrations(actualOtherCore);
      actualOtherCore.sqlite.close();
      return new FsStore({ dataRoot: root });
    },
    async reopen() {
      await close();
      coreDb = openCoreDb(dataRoot);
      store = new FsStore({ dataRoot });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const prepare = (f: Fixture, requestId: string) =>
  prepareSecurityThread({ coreDb: f.db, store: f.store, requestId });
const select = (f: Fixture, workspaceId: string, threadId: string) =>
  selectSecurityThread({ coreDb: f.db, store: f.store, workspaceId, threadId });

/** Checks an original owed N1 identity, never fabricates an alarm or recipient. */
function owed(rows: readonly Alarm[], userId: string, rule: 'R1' | 'R8'): Alarm {
  const alarm = rows.find((row) => row.recipientUserId === userId && row.rule === rule);
  assert.ok(alarm, 'the actual N1 producer must owe this recipient the original rule notice');
  assert.equal(alarm.raised, false);
  assert.equal(
    alarm.requestId,
    securityRequestId({
      key: alarm.key,
      recipientUserId: alarm.recipientUserId,
      occurrence: alarm.occurrence,
    })
  );
  return alarm;
}

/** Obtains a genuinely owed R1 using native local identity, enable and stop owners. */
async function localAlarm() {
  const f = await fixture();
  const userId = await ensureLocalUser(f.db);
  const actor: Actor = { kind: 'local', userId };
  await f.trigger.enable(actor);
  await f.trigger.stop(actor);
  return { f, actor, alarm: owed(await f.trigger.readAlarms(), userId, 'R1') };
}

/** The accepted closed Core reservation stage, not a row setter or ready-mark fixture. */
async function reserve(f: Fixture, requestId: string) {
  const result = await getControlStoreWorkerClient().securityTrigger(f.db, {
    action: 'destination-reserve',
    requestId,
  });
  if (result.kind !== 'destination')
    throw new Error('Expected the original native destination result.');
  return result;
}

/** Owner reads independently witness canonical home, actual physical Thread and no Raise. */
function assertPrivate(f: Fixture, value: Selection) {
  assert.equal(value.workspaceId, resolvePersonalWorkspaceIdInDb(f.db, value.recipientUserId));
  assert.equal(f.store.getWorkspace(value.workspaceId).kind, 'personal');
  const thread = f.store.getThread(value.workspaceId, value.threadId);
  assert.deepEqual(thread.owner, { kind: 'workspace', workspaceId: value.workspaceId });
  assert.equal(thread.entryPath, 'administration');
  assert.equal(thread.visibility, 'private');
  assert.equal(thread.privateOwnerUserId, value.recipientUserId);
  assert.equal(thread.status, value.threadStatus);
  assert.equal(
    f.store.listThreadTurns(value.workspaceId, value.threadId).length,
    0,
    'destination preparation is not Raise'
  );
  return thread;
}

/** Original bearer verification, not a supplied tokenScope claim, supplies this Actor. */
async function tokenActor(f: Fixture, secret: string): Promise<Actor> {
  const record = await verifyOpenKitAccessTokenRecord(f.db, secret);
  assert.ok(record, 'the actual verifier must admit its original synthetic credential');
  return {
    kind: 'token',
    userId: record.ownerUserId,
    tokenId: record.tokenId,
    tokenScope: record.scope,
    tokenWorkspaceIds: record.workspaceIds,
  };
}

/** Real bootstrap, signed Better Auth session, issuance and verification supply two current humans. */
async function server() {
  const f = await fixture();
  const bootstrap = await ensureServerBootstrapTokenForStartup(f.db);
  assert.ok(bootstrap);
  writeServerBootstrapTokenEmission(f.dataRoot, bootstrap);
  const owner = await f.tokens()['bootstrap.consume']({
    token: bootstrap.token,
    ownerUserId: allocateEntityId('usr'),
    displayName: 'N3 original enabling administrator',
    email: [randomUUID(), 'example.invalid'].join('@'),
    password: randomUUID(),
    tokenExpiresAt: EXPIRY,
  });
  const admin = await tokenActor(f, owner.token);
  const auth = createBetterAuth(f.db, {
    mode: 'local',
    env: { BETTER_AUTH_URL: 'https://auth.example.invalid' },
  });
  const created = await auth.api.signUpEmail({
    returnHeaders: true,
    body: {
      name: 'N3 original recipient',
      email: [randomUUID(), 'example.invalid'].join('@'),
      password: randomUUID(),
    },
  });
  const cookies = created.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
  const session = await auth.api.getSession({ headers: new Headers({ cookie: cookies }) });
  assert.ok(session);
  const human = actorFromSession(session);
  const issued = await f
    .tokens()
    ['token.create'](
      { ownerUserId: human.userId, scope: 'server-admin', workspaceIds: [], expiresAt: EXPIRY },
      context(admin)
    );
  const backup = await tokenActor(f, issued.token);
  return {
    f,
    admin,
    backup,
    adminTokenId: owner.record.tokenId,
    backupTokenId: issued.record.tokenId,
  };
}

describe('N3 original owed-alarm Thread destination producer and trusted native selector', () => {
  it('prepares a real owed R1, waits for actual owners, reuses ready state and survives reopen; title alone is not binding', async () => {
    const { f, actor, alarm } = await localAlarm();
    const alarms = await f.trigger.readAlarms();
    const entry = f.trace.checkpoint();
    const value = await prepare(f, alarm.requestId);
    f.trace.prepared(entry, value);
    assert.equal(value.recipientUserId, actor.userId);
    assert.equal(value.threadStatus, 'active');
    const thread = assertPrivate(f, value);
    const binding = await reserve(f, alarm.requestId);
    assert.equal(binding.fresh, false);
    assert.equal(binding.destination.status, 'ready');
    assert.equal(
      binding.destination.generation,
      1,
      'the real initial native assignment, never a caller counter'
    );
    assert.equal(binding.destination.sourceRequestId, alarm.requestId);
    assert.deepEqual(
      {
        recipientUserId: binding.destination.recipientUserId,
        generation: binding.destination.generation,
        workspaceId: binding.destination.workspaceId,
        threadId: binding.destination.threadId,
      },
      {
        recipientUserId: value.recipientUserId,
        generation: value.generation,
        workspaceId: value.workspaceId,
        threadId: value.threadId,
      }
    );
    assert.equal(
      value.threadId,
      securityThreadId(value.recipientUserId, binding.destination.generation)
    );
    const selectedAt = f.trace.checkpoint();
    assert.deepEqual(
      selection((await select(f, value.workspaceId, value.threadId))!),
      selection(value)
    );
    f.trace.coreRoundTrip(selectedAt);
    const lookalike = await f.store.createThread(
      value.workspaceId,
      thread.name,
      undefined,
      'administration',
      { visibility: 'private', privateOwnerUserId: actor.userId }
    );
    const ordinaryAt = f.trace.checkpoint();
    assert.equal(
      await select(f, value.workspaceId, lookalike.id),
      null,
      'same actual title, entry and private audience do not supply Core binding'
    );
    f.trace.coreRoundTrip(ordinaryAt);
    const threads = f.store.listThreads(value.workspaceId);
    const repeatedAt = f.trace.checkpoint();
    assert.deepEqual(selection(await prepare(f, alarm.requestId)), selection(value));
    f.trace.noThreadWrite(repeatedAt, value.threadId);
    await assert.rejects(
      () => prepare(f, randomUUID()),
      'a valid-looking but unowed request cannot reuse or allocate a destination'
    );
    assert.deepEqual(f.store.listThreads(value.workspaceId), threads);
    await f.reopen();
    assert.deepEqual(
      selection((await select(f, value.workspaceId, value.threadId))!),
      selection(value)
    );
    assert.deepEqual(selection(await prepare(f, alarm.requestId)), selection(value));
    assert.deepEqual(f.store.listThreads(value.workspaceId), threads);
    assertPrivate(f, value);
    assert.deepEqual(await f.trigger.readAlarms(), alarms, 'no raised flag or notice state change');
    assert.equal((await f.trigger.current()).state, 'stopping', 'no drain completion');
  });

  it('does not adopt an actually published colliding derived ID or turn a reserved collision into ordinary work', async () => {
    const { f, actor, alarm } = await localAlarm();
    const home = await f.store.ensureQuickChatWorkspace(actor.userId);
    // Adversarial ordinary creation input, not a native generation assignment or retained fixture row.
    const collider = await f.store.createThread(
      home.id,
      'Ordinary pre-existing collision',
      securityThreadId(actor.userId, 1),
      'conversation',
      { visibility: 'workspace' }
    );
    assert.equal(
      await select(f, home.id, collider.id),
      null,
      'an unbound ID lookalike is not a trusted security label'
    );
    const before = f.store.listThreads(home.id);
    const entry = f.trace.checkpoint();
    await assert.rejects(() => prepare(f, alarm.requestId));
    f.trace.noThreadWrite(entry, collider.id);
    await assert.rejects(
      () => select(f, home.id, collider.id),
      'the original reserved collision cannot become ordinary fallback'
    );
    await assert.rejects(() => prepare(f, alarm.requestId));
    assert.deepEqual(f.store.getThread(home.id, collider.id), collider);
    assert.deepEqual(f.store.listThreads(home.id), before);
    await f.reopen();
    await assert.rejects(() => select(f, home.id, collider.id));
    await assert.rejects(() => prepare(f, alarm.requestId));
    assert.deepEqual(f.store.listThreads(home.id), before);
    assert.equal(owed(await f.trigger.readAlarms(), actor.userId, 'R1').raised, false);
  });

  it('retains a genuine Core reserved/incomplete tuple without creating its missing Workspace or Thread on read or retry', async () => {
    const { f, alarm } = await localAlarm();
    const entry = f.trace.checkpoint();
    const original = await reserve(f, alarm.requestId);
    f.trace.coreRoundTrip(entry);
    assert.equal(original.fresh, true);
    assert.equal(original.destination.status, 'reserved');
    assert.equal(original.destination.sourceRequestId, alarm.requestId);
    assert.equal(original.destination.recipientUserId, alarm.recipientUserId);
    const homes = f.store.listWorkspaces();
    const { workspaceId, threadId } = original.destination;
    const refusalAt = f.trace.checkpoint();
    await assert.rejects(() => select(f, workspaceId, threadId));
    await assert.rejects(() => prepare(f, alarm.requestId));
    f.trace.noThreadWrite(refusalAt, threadId);
    assert.deepEqual(
      f.store.listWorkspaces(),
      homes,
      'neither selector nor retry may silently publish the missing home'
    );
    await f.reopen();
    await assert.rejects(() => select(f, workspaceId, threadId));
    await assert.rejects(() => prepare(f, alarm.requestId));
    assert.deepEqual(f.store.listWorkspaces(), homes);
    assert.equal(owed(await f.trigger.readAlarms(), alarm.recipientUserId, 'R1').raised, false);
  });

  it('looks up the registered Thread first and refuses wrong Workspace, mismatched Data Root and actual home-kind contradiction without repair', async () => {
    const { f, alarm } = await localAlarm();
    const value = await prepare(f, alarm.requestId);
    const thread = assertPrivate(f, value);
    const other = await f.store.createWorkspace('N3 actual unrelated Workspace');
    await assert.rejects(
      () => select(f, other.id, value.threadId),
      'wrong requested Workspace must not conceal a registered binding'
    );
    const foreign = f.foreignStore();
    const foreignHomes = foreign.listWorkspaces();
    await assert.rejects(() =>
      selectSecurityThread({
        coreDb: f.db,
        store: foreign,
        workspaceId: value.workspaceId,
        threadId: value.threadId,
      })
    );
    await assert.rejects(() =>
      prepareSecurityThread({ coreDb: f.db, store: foreign, requestId: alarm.requestId })
    );
    assert.deepEqual(foreign.listWorkspaces(), foreignHomes);
    assert.deepEqual(f.store.getThread(value.workspaceId, value.threadId), thread);
    // Original public native Workspace metadata producer, not a retained-record replacement.
    const contradicted = await f.store.updateWorkspace(value.workspaceId, { kind: 'general' });
    assert.equal(contradicted.kind, 'general');
    const entry = f.trace.checkpoint();
    await assert.rejects(() => select(f, value.workspaceId, value.threadId));
    await assert.rejects(() => prepare(f, alarm.requestId));
    f.trace.noThreadWrite(entry, value.threadId);
    assert.equal(
      f.store.getWorkspace(value.workspaceId).kind,
      'general',
      'do not repair or reprovision the original owner'
    );
    assert.deepEqual(f.store.getThread(value.workspaceId, value.threadId), thread);
  });

  it.each(['Token revocation', 'canonical User disable'] as const)(
    'rechecks the owed recipient after real %s, before first preparation',
    async (loss) => {
      const { f, admin, backup, backupTokenId } = await server();
      await f.trigger.enable(admin);
      await f.trigger.stop(admin);
      const alarms = await f.trigger.readAlarms();
      const alarm = owed(alarms, backup.userId, 'R1');
      if (loss === 'Token revocation') {
        const revoked = await f
          .tokens()
          ['token.revoke']({ tokenId: backupTokenId }, context(admin));
        assert.equal(revoked.record.status, 'revoked');
      } else {
        const operations = createWorkspaceSharingOperationImplementations({
          coreDb: f.db,
          store: f.store,
          inflightCommands: new Map(),
          workspaceMutationAdmission: new WorkspaceMutationAdmission(),
        });
        const disabled = await operations['user.disable'](
          { requestId: randomUUID(), targetUserId: backup.userId },
          context(admin)
        );
        assert.equal(disabled.user.status, 'disabled');
      }
      const homes = f.store.listWorkspaces();
      await assert.rejects(
        () => prepare(f, alarm.requestId),
        'an original owed request is not current recipient administration'
      );
      assert.deepEqual(f.store.listWorkspaces(), homes);
      assert.deepEqual(await f.trigger.readAlarms(), alarms);
      const eligible = owed(alarms, admin.userId, 'R1');
      assertPrivate(f, await prepare(f, eligible.requestId));
      assert.equal((await f.trigger.current()).state, 'stopping');
    }
  );

  it('uses an actual R8 despite lost delegation; retains renamed/archived classification and refuses rollover or raising', async () => {
    const { f, admin, backup, adminTokenId } = await server();
    await f.trigger.enable(admin);
    const revoked = await f.tokens()['token.revoke']({ tokenId: adminTokenId }, context(backup));
    assert.equal(revoked.record.status, 'revoked');
    await assert.rejects(() => f.trigger.readAudit());
    assert.equal((await f.trigger.current()).delegationCurrent, false);
    const alarms = await f.trigger.readAlarms();
    const alarm = owed(alarms, backup.userId, 'R8');
    const entry = f.trace.checkpoint();
    const value = await prepare(f, alarm.requestId);
    f.trace.prepared(entry, value);
    assertPrivate(f, value);
    await f.store.updateThread(value.workspaceId, value.threadId, {
      name: 'Renamed presentation only',
    });
    assert.deepEqual(
      selection((await select(f, value.workspaceId, value.threadId))!),
      selection(value)
    );
    await f.store.archiveThread(value.workspaceId, value.threadId);
    const archived = { ...selection(value), threadStatus: 'archived' as const };
    assert.deepEqual(selection((await select(f, value.workspaceId, value.threadId))!), archived);
    const before = f.store.listThreads(value.workspaceId);
    await assert.rejects(() => prepare(f, alarm.requestId), 'this cut has no G rollover');
    assert.deepEqual(f.store.listThreads(value.workspaceId), before);
    await f.reopen();
    assert.deepEqual(selection((await select(f, value.workspaceId, value.threadId))!), archived);
    await assert.rejects(() => prepare(f, alarm.requestId));
    assert.deepEqual(f.store.listThreads(value.workspaceId), before);
    assertPrivate(f, { ...value, threadStatus: 'archived' });
    assert.deepEqual(await f.trigger.readAlarms(), alarms);
    const state = await f.trigger.current();
    assert.equal(state.state, 'stopping');
    assert.equal(state.delegationCurrent, false);
  });
});
