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
import type { AdmittedOperationContext } from '../operation-contract.js';
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
import { archiveThread } from '../thread-routes.js';
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

describe('N3 genuine initial alarm publication and trusted original reader', () => {
  it('publishes real R1 files/version/ref/automation Request and Turn; reads, reopens and replays exact authority without raising or rollover', async () => {
    const { f, actor, alarm } = await localAlarm();
    const alarms = await f.trigger.readAlarms();
    const destination = await prepareSecurityThread({
      coreDb: f.db,
      store: f.store,
      requestId: alarm.requestId,
    });
    const address = {
      requestId: alarm.requestId,
      workspaceId: destination.workspaceId,
      threadId: destination.threadId,
    };
    assert.equal(
      await read(f, address),
      null,
      'known source/destination, entire publication absent'
    );
    const value = await published(f, alarm);
    assert.equal(value.generation, destination.generation);
    assert.equal(value.workspaceId, destination.workspaceId);
    assert.equal(value.threadId, destination.threadId);
    const before = actual(f, value, alarm);
    assert.deepEqual(await read(f, address), value);
    assert.deepEqual(await publish(f, alarm.requestId), {
      status: 'published',
      publication: value,
    });
    assert.deepEqual(actual(f, value, alarm), before);
    await f.reopen();
    assert.deepEqual(await read(f, address), value);
    assert.deepEqual(await publish(f, alarm.requestId), {
      status: 'published',
      publication: value,
    });
    assert.deepEqual(actual(f, value, alarm), before);
    assert.equal(f.store.listThreadTurns(value.workspaceId, value.threadId).length, 1);
    const other = await f.store.createWorkspace('Actual unrelated publication Workspace');
    await assert.rejects(() => read(f, { ...address, workspaceId: other.id }));
    await assert.rejects(() => read(f, { ...address, requestId: randomUUID() }));
    const threads = f.store.listThreads(value.workspaceId);
    await archiveThread(
      { requestId: randomUUID(), workspaceId: value.workspaceId, threadId: value.threadId },
      {
        store: f.store,
        inflightCommands: new WeakMap(),
        repositoryWorkspaceDb: (workspaceId) => openWorkspaceDb(f.dataRoot, workspaceId),
      },
      actor
    );
    assert.deepEqual(
      await read(f, address),
      value,
      'historical archived complete source remains trusted'
    );
    await assert.rejects(() => publish(f, alarm.requestId));
    assert.deepEqual(
      f.store.listThreads(value.workspaceId).map((thread) => thread.id),
      threads.map((thread) => thread.id)
    );
    assert.deepEqual(await f.trigger.readAlarms(), alarms);
    assert.equal((await f.trigger.current()).state, 'stopping');
  });

  it('publishes actual R8 for the remaining current administrator despite lost enabling delegation', async () => {
    const { f, admin, backup, adminTokenId } = await server();
    await f.trigger.enable(admin);
    assert.equal(
      (await f.tokens()['token.revoke']({ tokenId: adminTokenId }, context(backup))).record.status,
      'revoked'
    );
    await assert.rejects(() => f.trigger.readAudit());
    const alarms = await f.trigger.readAlarms();
    const alarm = owed(alarms, backup.userId, 'R8');
    assert.equal((await f.trigger.current()).delegationCurrent, false);
    const value = await published(f, alarm);
    actual(f, value, alarm);
    assert.deepEqual(await read(f, value), value);
    await f.reopen();
    assert.deepEqual(await read(f, value), value);
    assert.deepEqual(await publish(f, alarm.requestId), {
      status: 'published',
      publication: value,
    });
    assert.deepEqual(await f.trigger.readAlarms(), alarms);
    assert.equal((await f.trigger.current()).delegationCurrent, false);
  });

  it('returns busy for a real original nonterminal Core-local Turn, leaving no admitted report/Request/publication tuple', async () => {
    const { f, actor, alarm } = await localAlarm();
    const destination = await prepareSecurityThread({
      coreDb: f.db,
      store: f.store,
      requestId: alarm.requestId,
    });
    const busy = await f.store.createTurn(
      destination.workspaceId,
      destination.threadId,
      'Actual original Core-local work',
      pendingRequestSystemActor(actor.userId),
      null,
      { triggerSource: { kind: 'system-input', summary: 'Original busy fixture work' } }
    );
    assert.equal(busy.status, 'running');
    const artifacts = f.store.listArtifacts(destination.workspaceId);
    const turns = f.store.listThreadTurns(destination.workspaceId, destination.threadId);
    assert.deepEqual(await publish(f, alarm.requestId), { status: 'busy' });
    assert.equal(await read(f, { ...destination, requestId: alarm.requestId }), null);
    assert.deepEqual(f.store.listArtifacts(destination.workspaceId), artifacts);
    assert.deepEqual(f.store.listThreadTurns(destination.workspaceId, destination.threadId), turns);
    assert.deepEqual(pending(f, destination.workspaceId, destination.threadId), []);
    assert.equal(owed(await f.trigger.readAlarms(), actor.userId, 'R1').raised, false);
  });

  it('refuses a genuinely published colliding original terminal Turn as partial, never merging/filling it or returning ordinary null', async () => {
    const { f, actor, alarm } = await localAlarm();
    const destination = await prepareSecurityThread({
      coreDb: f.db,
      store: f.store,
      requestId: alarm.requestId,
    });
    const ids = securityPublicationIds(alarm.requestId);
    const collider = await f.store.createTurn(
      destination.workspaceId,
      destination.threadId,
      'Ordinary original terminal collision',
      pendingRequestSystemActor(actor.userId),
      null,
      {
        turnId: ids.raiseTurnId,
        status: 'completed',
        triggerSource: { kind: 'system-input', summary: 'Not a security publication' },
      }
    );
    const address = { ...destination, requestId: alarm.requestId };
    await assert.rejects(() => read(f, address));
    await assert.rejects(() => publish(f, alarm.requestId));
    assert.deepEqual(
      f.store.getTurn(destination.workspaceId, destination.threadId, collider.id),
      collider
    );
    assert.deepEqual(f.store.listArtifacts(destination.workspaceId), []);
    assert.deepEqual(pending(f, destination.workspaceId, destination.threadId), []);
    await f.reopen();
    await assert.rejects(() => read(f, address));
    await assert.rejects(() => publish(f, alarm.requestId));
    assert.deepEqual(
      f.store.getTurn(destination.workspaceId, destination.threadId, collider.id),
      collider
    );
  });

  it('rechecks actual current recipient administration before publishing an otherwise real owed R1', async () => {
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
    assert.equal(
      (await f.tokens()['token.revoke']({ tokenId: backupTokenId }, context(admin))).record.status,
      'revoked'
    );
    await assert.rejects(() => publish(f, alarm.requestId));
    assert.deepEqual(f.store.listArtifacts(destination.workspaceId), []);
    assert.deepEqual(f.store.listThreadTurns(destination.workspaceId, destination.threadId), []);
    assert.deepEqual(pending(f, destination.workspaceId, destination.threadId), []);
    assert.deepEqual(await f.trigger.readAlarms(), alarms);
  });
});
