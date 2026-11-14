// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { allocateEntityId, deriveEntityId } from '@openkit/protocol';
import { describe, it, onTestFinished, vi } from 'vitest';
import { createAccessTokenOperationImplementations } from '../auth/access-token-operations.js';
import { verifyOpenKitAccessTokenRecord } from '../auth/access-token-verification.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { ensureServerBootstrapTokenForStartup } from '../auth/bootstrap-ensure.js';
import { writeServerBootstrapTokenEmission } from '../auth/bootstrap-token.js';
import { type Actor, actorFromSession, ensureLocalUser } from '../auth/identity.js';
import { artifactReferenceItemId } from '../lib/artifact-reference-id.js';
import { FsStore } from '../lib/store.js';
import { type AttentionDelivery, AttentionNotifications } from '../notifications/attention.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { createPendingRequestOperationImplementations } from '../pending-request-operations.js';
import {
  listThreadPendingRequests,
  pendingRequestSystemActor,
} from '../runtime/pending-requests.js';
import {
  securityPublicationIds,
  securityReportArtifactId,
  securityRequestId,
} from '../security/identifiers.js';
import { publishSecurityAlarm, readSecurityAlarmPublication } from '../security/publication.js';
import { prepareSecurityThread } from '../security/threads.js';
import { SecurityTriggerStore } from '../security/trigger.js';
import { ensureUserQuickChatWorkspace } from '../workspace-membership.js';
import {
  closeWorkspaceProductReadHandles,
  openControlStoreProductReadHandle,
} from './control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { nativeProductMetadataScope } from './workspace-file-records.js';

type Publication = Awaited<ReturnType<typeof readSecurityAlarmPublication>> & {};
type Alarm = Awaited<ReturnType<SecurityTriggerStore['readAlarms']>>[number];
const EXPIRY = '2099-01-01T00:00:00.000Z';
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

/** Call-through Worker observations never replace an owner, result or commit. */
function observeNative() {
  const sent = vi.spyOn(Worker.prototype, 'postMessage');
  const emitted = vi.spyOn(Worker.prototype, 'emit');
  return {
    checkpoint() {
      return sent.mock.calls.length;
    },
    ack(since: number, operation: 'security-trigger' | 'publication') {
      const calls = sent.mock.calls
        .slice(since)
        .map(([message]) => message)
        .filter(wire)
        .filter((message) =>
          operation === 'security-trigger'
            ? message.operation === 'security-trigger'
            : ['pending', 'terminal'].includes(message.operation) &&
              typeof message.database === 'string' &&
              message.database.startsWith('workspace:') &&
              Object.values(message)
                .filter(object)
                .map((value) => (object(value.terminal) ? value.terminal : value))
                .some(
                  (value) =>
                    object(value.turn) && Array.isArray(value.pending) && value.pending.length > 0
                )
        );
      assert.ok(calls.length > 0, `actual ${operation} owner entry must be invoked`);
      assert.ok(
        emitted.mock.calls.some(
          ([event, reply]) =>
            event === 'message' &&
            wire(reply) &&
            reply.status === 'ok' &&
            calls.some((call) => call.id === reply.id && call.operation === reply.operation)
        ),
        'actual matching native FULL acknowledgement, not callback success'
      );
    },
    restore() {
      emitted.mockRestore();
      sent.mockRestore();
    },
  };
}

/** Actual original producers own all fixture state; physical fixtures remain under Storage. */
async function fixture() {
  await shutdownControlStoreWorkerClient();
  const trace = observeNative();
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-security-alarm-publication-'));
  let coreDb = openCoreDb(dataRoot);
  let store: FsStore;
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
    async reopen() {
      await close();
      coreDb = openCoreDb(dataRoot);
      store = new FsStore({ dataRoot });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const publish = (f: Fixture, requestId: string) =>
  publishSecurityAlarm({ coreDb: f.db, store: f.store, requestId });
const read = (f: Fixture, value: { requestId: string; workspaceId: string; threadId: string }) =>
  readSecurityAlarmPublication({
    coreDb: f.db,
    store: f.store,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    threadId: value.threadId,
  });

/** The actual N1 outbox, not caller-supplied recipient/G/source, determines the original alarm. */
function owed(rows: readonly Alarm[], recipient: string, rule: 'R1' | 'R8') {
  const alarm = rows.find((row) => row.recipientUserId === recipient && row.rule === rule);
  assert.ok(alarm);
  assert.equal(alarm.raised, false);
  assert.equal(
    alarm.requestId,
    securityRequestId({ key: alarm.key, recipientUserId: recipient, occurrence: alarm.occurrence })
  );
  return alarm;
}

async function localAlarm() {
  const f = await fixture();
  const userId = await ensureLocalUser(f.db);
  const actor: Actor = { kind: 'local', userId };
  await f.trigger.enable(actor);
  await f.trigger.stop(actor);
  return { f, actor, alarm: owed(await f.trigger.readAlarms(), userId, 'R1') };
}

/** Read the actual canonical Pending rows through the original query-only product owner. */
function pending(f: Fixture, workspaceId: string, threadId: string) {
  const scope = nativeProductMetadataScope(f.dataRoot, { kind: 'workspace', workspaceId });
  const reader = openControlStoreProductReadHandle(scope.path, scope.owner);
  try {
    return listThreadPendingRequests(reader.sqlite, workspaceId, threadId);
  } finally {
    reader.close();
  }
}

/** Observe original file/version authority plus actual native Turn/Items/Request, not only facade JSON. */
function actual(f: Fixture, value: Publication, alarm: Alarm) {
  const ids = securityPublicationIds(alarm.requestId);
  assert.equal(value.requestId, alarm.requestId);
  assert.equal(value.recipientUserId, alarm.recipientUserId);
  assert.equal(value.rule, alarm.rule);
  assert.deepEqual(value.key, alarm.key);
  assert.deepEqual(value.occurrence, alarm.occurrence);
  assert.equal(value.artifactId, deriveEntityId('ar', ['security-report', alarm.requestId]));
  assert.equal(securityReportArtifactId(alarm.requestId), value.artifactId);
  assert.equal(value.artifactVersion, 1);
  assert.equal(value.raiseTurnId, ids.raiseTurnId);
  assert.equal(value.reportItemId, ids.reportItemId);
  assert.equal(value.reportItemId, artifactReferenceItemId(value.artifactId, value.raiseTurnId));
  assert.equal(value.requestItemId, ids.requestItemId);
  const thread = f.store.getThread(value.workspaceId, value.threadId);
  assert.equal(f.store.getWorkspace(value.workspaceId).kind, 'personal');
  assert.equal(thread.entryPath, 'administration');
  assert.equal(thread.visibility, 'private');
  assert.equal(thread.privateOwnerUserId, alarm.recipientUserId);
  assert.deepEqual(thread.owner, { kind: 'workspace', workspaceId: value.workspaceId });
  const turn = f.store.getTurn(value.workspaceId, value.threadId, value.raiseTurnId);
  assert.equal(turn.status, 'completed');
  assert.equal(turn.triggerSource?.kind, 'automation');
  assert.equal(turn.agentId ?? null, null);
  assert.equal(turn.agentSessionId ?? null, null);
  assert.equal(
    turn.triggerActor.kind,
    'system',
    'truthful Core history, not person/Agent impersonation'
  );
  const report = f.store.getArtifact(value.workspaceId, value.artifactId);
  assert.equal(report.kind, 'report');
  assert.equal(report.status, 'ready');
  assert.equal(report.version, 1);
  assert.equal(report.content.format, 'markdown');
  assert.ok('body' in report.content && report.content.body.length > 0);
  assert.equal(
    report.contentDigest,
    `sha256:${createHash('sha256').update(report.content.body, 'utf8').digest('hex')}`
  );
  assert.equal(report.lastMutationRequestId, alarm.requestId);
  assert.deepEqual(report.origin, {
    kind: 'turn-output',
    threadId: value.threadId,
    turnId: value.raiseTurnId,
    requestId: alarm.requestId,
  });
  const version = f.store.getArtifactVersion(value.workspaceId, value.artifactId, 1);
  assert.deepEqual(version.artifact, report);
  const reference = turn.items.find((item) => item.id === value.reportItemId);
  assert.ok(reference?.type === 'artifact-reference');
  assert.equal(reference.artifactId, value.artifactId);
  assert.equal(reference.artifactVersion, 1);
  assert.equal(reference.lastMutationRequestId, alarm.requestId);
  const question = turn.items.find((item) => item.id === value.requestItemId);
  assert.ok(question?.type === 'user-input-request');
  assert.equal(question.responsibleUserId, alarm.recipientUserId);
  assert.deepEqual(
    question.questions.flatMap((q) => (q.options ?? []).map((option) => option.label)),
    alarm.rule === 'R1' ? ['Expected', 'Not expected'] : ['Reviewed', 'Start a response']
  );
  const requests = pending(f, value.workspaceId, value.threadId).filter(
    (row) => row.requestItemId === value.requestItemId
  );
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(
    request.requestId,
    question.userInputRequestId,
    'the canonical Pending owner keeps its own capability identity'
  );
  assert.equal(request.raisingTurnId, value.raiseTurnId);
  assert.equal(request.kind, 'user-input');
  assert.equal(request.requesterKind, 'automation');
  assert.equal(request.responsibleUserId, alarm.recipientUserId);
  assert.equal(request.agentId ?? null, null);
  assert.equal(request.agentSessionId ?? null, null);
  assert.equal(request.state, 'pending');
  return structuredClone({ report, version, turn, request });
}

async function published(f: Fixture, alarm: Alarm) {
  const checkpoint = f.trace.checkpoint();
  const result = await publish(f, alarm.requestId);
  assert.equal(result.status, 'published');
  if (result.status !== 'published') throw new Error('Expected actual publication.');
  f.trace.ack(checkpoint, 'security-trigger');
  f.trace.ack(checkpoint, 'publication');
  return result.publication;
}

async function tokenActor(f: Fixture, secret: string): Promise<Actor> {
  const record = await verifyOpenKitAccessTokenRecord(f.db, secret);
  assert.ok(record);
  return {
    kind: 'token',
    userId: record.ownerUserId,
    tokenId: record.tokenId,
    tokenScope: record.scope,
    tokenWorkspaceIds: record.workspaceIds,
  };
}

/** Genuine bootstrap, Better Auth session, Token issuance and verifier create two actual administrators. */
async function server() {
  const f = await fixture();
  const bootstrap = await ensureServerBootstrapTokenForStartup(f.db);
  assert.ok(bootstrap);
  writeServerBootstrapTokenEmission(f.dataRoot, bootstrap);
  const owner = await f.tokens()['bootstrap.consume']({
    token: bootstrap.token,
    ownerUserId: allocateEntityId('usr'),
    displayName: 'Publication enabler',
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
      name: 'Publication recipient',
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

type AlarmNotice = Alarm & { raised: true; generation: number; attention: AttentionDelivery };
const readNotice = (f: Fixture, requestId: string) =>
  (
    f.trigger as SecurityTriggerStore & { readAlarmNotice(id: string): Promise<AlarmNotice | null> }
  ).readAlarmNotice(requestId);

/** Read only: IDs come from the ORIGINAL Attention table; its public owner decodes every row. No enqueue/eligibility stub. */
function attentionRows(f: Fixture): AttentionDelivery[] {
  const ids = f.db.sqlite
    .prepare(
      "SELECT id FROM notification_attention WHERE source_kind='security-notice' ORDER BY id"
    )
    .all() as Array<{ id: string }>;
  const owner = new AttentionNotifications(f.db.sqlite);
  return ids.map(({ id }) => {
    const row = owner.get(id);
    assert.ok(row);
    return row;
  });
}

/** Deciding OLD assertion precedes the absent read API: OLD still lists its unraised entry in the PENDING-only page. */
async function marked(f: Fixture, alarm: Alarm, value: Publication): Promise<AlarmNotice> {
  const pendingAlarm = (await f.trigger.readAlarms()).find(
    (row) => row.requestId === alarm.requestId
  );
  assert.equal(
    pendingAlarm,
    undefined,
    'E4 transaction 3 must remove the marked original request from the pending-only alarm page'
  );
  const notice = await readNotice(f, alarm.requestId);
  assert.ok(notice);
  const { generation, attention, ...row } = notice;
  assert.deepEqual(
    row,
    { ...alarm, raised: true },
    'the notice ID is the original outbox request, not a replacement identity'
  );
  assert.equal(generation, value.generation);
  assert.deepEqual(attention.source, {
    kind: 'security-notice',
    workspaceId: value.workspaceId,
    threadId: value.threadId,
    requestId: alarm.requestId,
  });
  assert.equal(attention.recipientUserId, alarm.recipientUserId);
  assert.equal(attention.status, 'queued');
  assert.equal(attention.channel, null);
  assert.equal(attention.attempt, null, 'enqueue is not a channel/drain/send attempt');
  assert.deepEqual(new AttentionNotifications(f.db.sqlite).get(attention.id), attention);
  assert.equal(attentionRows(f).filter((candidate) => candidate.id === attention.id).length, 1);
  return notice;
}
const workspaceTuple = (f: Fixture, value: Pick<Publication, 'workspaceId' | 'threadId'>) =>
  structuredClone({
    artifacts: f.store.listArtifacts(value.workspaceId),
    turns: f.store.listThreadTurns(value.workspaceId, value.threadId),
    requests: pending(f, value.workspaceId, value.threadId),
  });

describe('N3 E4 transaction 3 original alarm mark and native Attention enqueue', () => {
  it('marks every original R1 recipient with exact own Attention identity after real publication; replay/reopen never reallocates or drains', async () => {
    const { f, admin, backup } = await server();
    await f.trigger.enable(admin);
    await f.trigger.stop(admin);
    const alarms = await f.trigger.readAlarms();
    assert.deepEqual(
      alarms.map((row) => row.recipientUserId).sort(),
      [admin.userId, backup.userId].sort()
    );
    assert.ok(alarms.every((row) => row.rule === 'R1' && row.raised === false));
    assert.deepEqual(attentionRows(f), []);
    for (const alarm of alarms)
      await prepareSecurityThread({ coreDb: f.db, store: f.store, requestId: alarm.requestId });
    const committed = new Set<string>();
    const saved: Array<{
      alarm: Alarm;
      publication: Publication;
      notice: AlarmNotice;
      tuple: ReturnType<typeof actual>;
    }> = [];
    for (const alarm of alarms) {
      const value = await published(f, alarm); // actual Step-2 publication and Core covering ACKs
      const tuple = actual(f, value, alarm);
      const notice = await marked(f, alarm, value); // OLD fails pending-entry absence here, NOT missing read API
      committed.add(alarm.requestId);
      assert.deepEqual(
        await f.trigger.readAlarms(),
        alarms.filter((row) => !committed.has(row.requestId))
      );
      for (const other of alarms.filter((row) => !committed.has(row.requestId))) {
        assert.equal(
          await readNotice(f, other.requestId),
          null,
          'a valid original unraised alarm has no stored notice yet'
        );
      }
      saved.push({ alarm, publication: value, notice: structuredClone(notice), tuple });
      assert.equal(attentionRows(f).length, committed.size);
    }
    assert.equal(
      new Set(saved.map((item) => item.notice.attention.id)).size,
      alarms.length,
      'each actual recipient has its own original-owner row'
    );
    const originalAttention = structuredClone(attentionRows(f));
    await f.reopen();
    for (const item of saved) {
      assert.deepEqual(await publish(f, item.alarm.requestId), {
        status: 'published',
        publication: item.publication,
      });
      assert.deepEqual(await read(f, item.publication), item.publication);
      assert.deepEqual(actual(f, item.publication, item.alarm), item.tuple);
      assert.deepEqual(await readNotice(f, item.alarm.requestId), item.notice);
    }
    assert.deepEqual(attentionRows(f), originalAttention);
    assert.deepEqual(
      await f.trigger.readAlarms(),
      alarms.filter((row) => !committed.has(row.requestId))
    );
    assert.equal(
      (await f.trigger.current()).state,
      'off',
      'completed stop preserves the original queued notices without draining them'
    );
  });

  it('marks a genuine R8 for the remaining current recipient under the original alarm grant despite lost enabling delegation', async () => {
    const { f, admin, backup, adminTokenId } = await server();
    await f.trigger.enable(admin);
    await f.tokens()['token.revoke']({ tokenId: adminTokenId }, context(backup));
    await assert.rejects(() => f.trigger.readAudit());
    const alarms = await f.trigger.readAlarms();
    const alarm = owed(alarms, backup.userId, 'R8');
    assert.equal((await f.trigger.current()).delegationCurrent, false);
    const value = await published(f, alarm);
    const tuple = actual(f, value, alarm);
    const notice = await marked(f, alarm, value);
    assert.equal(attentionRows(f).length, 1);
    await f.reopen();
    assert.deepEqual(await publish(f, alarm.requestId), {
      status: 'published',
      publication: value,
    });
    assert.deepEqual(actual(f, value, alarm), tuple);
    assert.deepEqual(await readNotice(f, alarm.requestId), notice);
    assert.deepEqual(attentionRows(f), [notice.attention]);
    assert.equal((await f.trigger.current()).delegationCurrent, false);
  });

  it('does not mark or enqueue while a genuine Core-local Turn is busy, then succeeds only after original terminal-owner completion', async () => {
    const { f, actor, alarm } = await localAlarm();
    const destination = await prepareSecurityThread({
      coreDb: f.db,
      store: f.store,
      requestId: alarm.requestId,
    });
    const busy = await f.store.createTurn(
      destination.workspaceId,
      destination.threadId,
      'Actual busy original work',
      pendingRequestSystemActor(actor.userId),
      null,
      { triggerSource: { kind: 'system-input', summary: 'Existing terminal-owner retry witness' } }
    );
    assert.equal(busy.status, 'running');
    const alarms = await f.trigger.readAlarms();
    const original = workspaceTuple(f, destination);
    assert.deepEqual(await publish(f, alarm.requestId), { status: 'busy' });
    assert.deepEqual(await f.trigger.readAlarms(), alarms);
    assert.deepEqual(attentionRows(f), []);
    assert.deepEqual(workspaceTuple(f, destination), original);
    assert.equal(await read(f, { ...destination, requestId: alarm.requestId }), null);
    const terminal = await f.store.completeTurn(busy.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    assert.equal(terminal.status, 'completed');
    const value = await published(f, alarm);
    actual(f, value, alarm);
    const notice = await marked(f, alarm, value);
    assert.equal(attentionRows(f).length, 1);
    assert.deepEqual(await publish(f, alarm.requestId), {
      status: 'published',
      publication: value,
    });
    assert.deepEqual(await readNotice(f, alarm.requestId), notice);
    assert.deepEqual(attentionRows(f), [notice.attention]);
  });

  it('refuses actual recipient administration loss without marking the original alarm, admitting a report, or manufacturing Attention', async () => {
    const { f, admin, backup, backupTokenId } = await server();
    await f.trigger.enable(admin);
    await f.trigger.stop(admin);
    const alarms = await f.trigger.readAlarms();
    const alarm = owed(alarms, backup.userId, 'R1');
    const destination = await prepareSecurityThread({
      coreDb: f.db,
      store: f.store,
      requestId: alarm.requestId,
    });
    const original = workspaceTuple(f, destination);
    await f.tokens()['token.revoke']({ tokenId: backupTokenId }, context(admin));
    await assert.rejects(() => publish(f, alarm.requestId));
    assert.deepEqual(await f.trigger.readAlarms(), alarms);
    assert.deepEqual(attentionRows(f), []);
    assert.deepEqual(workspaceTuple(f, destination), original);
  });

  it('enqueues the original recipient notice for a genuinely withdrawn Pending whose complete original Step-2 tuple already exists', async () => {
    const { f, actor, alarm } = await localAlarm();
    await ensureUserQuickChatWorkspace({ coreDb: f.db, store: f.store, userId: actor.userId });
    const destination = await prepareSecurityThread({
      coreDb: f.db,
      store: f.store,
      requestId: alarm.requestId,
    });
    const step2 = f.trace.checkpoint();
    assert.equal(
      await f.store.publishSecurityAlarmTurn({
        requestId: alarm.requestId,
        workspaceId: destination.workspaceId,
        threadId: destination.threadId,
        recipientUserId: alarm.recipientUserId,
        rule: alarm.rule,
      }),
      'published'
    );
    f.trace.ack(step2, 'publication');
    const address = {
      workspaceId: destination.workspaceId,
      threadId: destination.threadId,
      requestId: alarm.requestId,
    };
    const value = await read(f, address);
    assert.ok(value);
    const before = actual(f, value, alarm);
    assert.equal(
      (await f.trigger.readAlarms()).find((row) => row.requestId === alarm.requestId)?.raised,
      false
    );
    assert.deepEqual(attentionRows(f), []);
    const pendingApi = createPendingRequestOperationImplementations({
      coreDb: f.db,
      store: f.store,
      inflightCommands: new WeakMap(),
      repositoryWorkspaceDb: (workspaceId) => openWorkspaceDb(f.dataRoot, workspaceId),
    });
    await pendingApi['pending-request.withdraw'](
      {
        requestId: randomUUID(),
        workspaceId: value.workspaceId,
        threadId: value.threadId,
        pendingRequestId: before.request.requestId,
      },
      { ...context(actor), scope: { kind: 'workspace', workspaceId: value.workspaceId } }
    );
    const ended = pending(f, value.workspaceId, value.threadId).find(
      (row) => row.requestId === before.request.requestId
    );
    assert.ok(ended);
    assert.notEqual(
      ended.state,
      'pending',
      'the admitted original lifecycle actually ended THIS source request'
    );
    assert.equal(ended.requesterKind, 'automation');
    assert.deepEqual(
      await read(f, address),
      value,
      'complete original source remains a source after its own request ends'
    );
    const tupleAfterEnd = workspaceTuple(f, value);
    const markEntry = f.trace.checkpoint();
    assert.deepEqual(await publish(f, alarm.requestId), {
      status: 'published',
      publication: value,
    });
    f.trace.ack(markEntry, 'security-trigger');
    const notice = await marked(f, alarm, value);
    assert.deepEqual(
      workspaceTuple(f, value),
      tupleAfterEnd,
      'Core mark/enqueue must not repair/rewrite/reopen the ended Workspace tuple'
    );
    await f.reopen();
    assert.deepEqual(await publish(f, alarm.requestId), {
      status: 'published',
      publication: value,
    });
    assert.deepEqual(await read(f, address), value);
    assert.deepEqual(await readNotice(f, alarm.requestId), notice);
    assert.deepEqual(attentionRows(f), [notice.attention]);
    assert.deepEqual(workspaceTuple(f, value), tupleAfterEnd);
  });
});
