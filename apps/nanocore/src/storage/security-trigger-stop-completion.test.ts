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
import { listThreadPendingRequests } from '../runtime/pending-requests.js';
import {
  securityPublicationIds,
  securityReportArtifactId,
  securityRequestId,
} from '../security/identifiers.js';
import { publishSecurityAlarm, readSecurityAlarmPublication } from '../security/publication.js';
import { prepareSecurityThread } from '../security/threads.js';
import { SecurityTriggerStore } from '../security/trigger.js';
import {
  closeWorkspaceProductReadHandles,
  openControlStoreProductReadHandle,
} from './control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
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

/** Validate the already landed original mark, full alarm row and original queued Attention. */
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

describe('N3 E4 native completion of an already committed stop without consuming original notices', () => {
  it('finishes completed local R1 at native current and preserves its exact original queued notice/source through refusal and reopen', async () => {
    const { f, alarm } = await localAlarm();
    const stopping = await f.trigger.current();
    assert.equal(stopping.state, 'stopping', 'the original unraised alarm still blocks completion');
    const value = await published(f, alarm);
    const tuple = actual(f, value, alarm);
    const notice = structuredClone(await marked(f, alarm, value));
    const attention = structuredClone(attentionRows(f));
    const entry = f.trace.checkpoint();
    const completed = await f.trigger.current();
    f.trace.ack(entry, 'security-trigger');
    assert.equal(
      completed.state,
      'off',
      'OLD remains stopping after the original R1 is genuinely raised'
    );
    assert.equal(completed.enableGeneration, stopping.enableGeneration);
    assert.deepEqual(await f.trigger.readAlarms(), []);
    assert.deepEqual(await readNotice(f, alarm.requestId), notice);
    assert.deepEqual(attention, [notice.attention]);
    assert.deepEqual(attentionRows(f), attention);
    assert.deepEqual(await read(f, value), value);
    assert.deepEqual(actual(f, value, alarm), tuple);
    await assert.rejects(
      () => f.trigger.readAudit(),
      'off ends detection, not outstanding queued notices'
    );
    assert.deepEqual(await readNotice(f, alarm.requestId), notice);
    assert.deepEqual(attentionRows(f), attention);
    await f.reopen();
    const reopened = await f.trigger.current();
    assert.equal(reopened.state, 'off');
    assert.equal(reopened.enableGeneration, stopping.enableGeneration);
    assert.deepEqual(await readNotice(f, alarm.requestId), notice);
    assert.deepEqual(
      await readNotice(f, alarm.requestId),
      notice,
      'notice replay never allocates a successor'
    );
    assert.deepEqual(attentionRows(f), attention);
    assert.deepEqual(await read(f, value), value);
    assert.deepEqual(actual(f, value, alarm), tuple);
  });

  it('keeps two actual R1 recipients stopping after first raise/reopen; original Audit admission completes only after the second', async () => {
    const { f, admin, backup } = await server();
    await f.trigger.enable(admin);
    const stopping = await f.trigger.stop(admin);
    assert.equal(stopping.state, 'stopping', 'new stop intent must first commit stopping');
    const alarms = await f.trigger.readAlarms();
    assert.equal(alarms.length, 2);
    assert.deepEqual(
      alarms.map((row) => row.recipientUserId).sort(),
      [admin.userId, backup.userId].sort()
    );
    const first = owed(alarms, admin.userId, 'R1');
    const second = owed(alarms, backup.userId, 'R1');
    for (const alarm of alarms)
      await prepareSecurityThread({ coreDb: f.db, store: f.store, requestId: alarm.requestId });
    const firstValue = await published(f, first);
    const firstTuple = actual(f, firstValue, first);
    const firstNotice = structuredClone(await marked(f, first, firstValue));
    assert.equal(
      (await f.trigger.current()).state,
      'stopping',
      'one unraised recipient blocks completion'
    );
    assert.deepEqual(await f.trigger.readAlarms(), [second]);
    assert.equal(await readNotice(f, second.requestId), null);
    assert.deepEqual(attentionRows(f), [firstNotice.attention]);
    await f.reopen();
    assert.equal((await f.trigger.current()).state, 'stopping');
    assert.deepEqual(await f.trigger.readAlarms(), [second]);
    assert.deepEqual(await readNotice(f, first.requestId), firstNotice);
    assert.equal(await readNotice(f, second.requestId), null);
    const secondValue = await published(f, second);
    const secondTuple = actual(f, secondValue, second);
    const secondNotice = structuredClone(await marked(f, second, secondValue));
    assert.notEqual(firstNotice.attention.id, secondNotice.attention.id);
    const attention = structuredClone(attentionRows(f));
    assert.equal(attention.length, 2);
    const entry = f.trace.checkpoint();
    let auditRefused = false;
    try {
      await f.trigger.readAudit({ limit: 1 });
    } catch {
      auditRefused = true;
    }
    f.trace.ack(entry, 'security-trigger');
    // Observational original-family SELECT ONLY: a later current() must not mask absent Audit-side completion.
    const afterAudit = f.db.sqlite
      .prepare('SELECT state FROM security_trigger_state WHERE singleton=1')
      .get() as { state: string };
    const completed = await f.trigger.current();
    assert.equal(
      completed.state,
      'off',
      'OLD remains stopping even when BOTH original recipients are raised'
    );
    assert.equal(
      afterAudit.state,
      'off',
      'Audit admission itself commits completion before off refusal'
    );
    assert.equal(auditRefused, true);
    assert.equal(completed.enableGeneration, stopping.enableGeneration);
    assert.deepEqual(await f.trigger.readAlarms(), []);
    assert.deepEqual(await readNotice(f, first.requestId), firstNotice);
    assert.deepEqual(await readNotice(f, second.requestId), secondNotice);
    assert.deepEqual(attentionRows(f), attention);
    await f.reopen();
    assert.equal((await f.trigger.current()).state, 'off');
    assert.deepEqual(await readNotice(f, first.requestId), firstNotice);
    assert.deepEqual(await readNotice(f, second.requestId), secondNotice);
    assert.deepEqual(attentionRows(f), attention);
    assert.deepEqual(actual(f, firstValue, first), firstTuple);
    assert.deepEqual(actual(f, secondValue, second), secondTuple);
  });

  it('persists genuine lost-delegation R8 before refusal and finishes only after its actual remaining recipient is raised', async () => {
    const { f, admin, backup, adminTokenId } = await server();
    await f.trigger.enable(admin);
    await f.tokens()['token.revoke']({ tokenId: adminTokenId }, context(backup));
    const lossEntry = f.trace.checkpoint();
    await assert.rejects(() => f.trigger.readAudit());
    f.trace.ack(lossEntry, 'security-trigger');
    const alarms = await f.trigger.readAlarms();
    assert.equal(alarms.length, 1);
    const alarm = owed(alarms, backup.userId, 'R8');
    const stopping = await f.trigger.current();
    assert.equal(stopping.state, 'stopping', 'unraised R8 cannot complete under lost delegation');
    assert.equal(stopping.delegationCurrent, false);
    assert.equal(stopping.stoppingReason, 'lost-authority');
    assert.equal(await readNotice(f, alarm.requestId), null);
    assert.deepEqual(attentionRows(f), []);
    const value = await published(f, alarm);
    const tuple = actual(f, value, alarm);
    const notice = structuredClone(await marked(f, alarm, value));
    const completed = await f.trigger.current();
    assert.equal(
      completed.state,
      'off',
      'OLD remains stopping after the genuine R8 recipient is raised'
    );
    assert.equal(completed.enableGeneration, stopping.enableGeneration);
    assert.equal(completed.delegationCurrent, false);
    assert.deepEqual(await f.trigger.readAlarms(), []);
    assert.deepEqual(await readNotice(f, alarm.requestId), notice);
    assert.deepEqual(attentionRows(f), [notice.attention]);
    await assert.rejects(() => f.trigger.readAudit());
    assert.deepEqual(await readNotice(f, alarm.requestId), notice);
    await f.reopen();
    const reopened = await f.trigger.current();
    assert.equal(reopened.state, 'off');
    assert.equal(reopened.enableGeneration, stopping.enableGeneration);
    assert.equal(reopened.delegationCurrent, false);
    assert.deepEqual(await readNotice(f, alarm.requestId), notice);
    assert.deepEqual(attentionRows(f), [notice.attention]);
    assert.deepEqual(await read(f, value), value);
    assert.deepEqual(actual(f, value, alarm), tuple);
  });
});
