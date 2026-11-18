// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { describe, it, onTestFinished, vi } from 'vitest';
import { verifyOpenKitAccessTokenRecord } from '../auth/access-token-verification.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { ensureServerBootstrapTokenForStartup } from '../auth/bootstrap-ensure.js';
import { writeServerBootstrapTokenEmission } from '../auth/bootstrap-token.js';
import { createCredentialOperationImplementations } from '../auth/credential-operations.js';
import { type Actor, actorFromSession } from '../auth/identity.js';
import { createChannelServices, type DiscordAttentionTransport } from '../channel-services.js';
import { FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { createPendingRequestOperationImplementations } from '../pending-request-operations.js';
import { listThreadPendingRequests } from '../runtime/pending-requests.js';
import { publishSecurityAlarm } from '../security/publication.js';
import { SecurityTriggerStore } from '../security/trigger.js';
import { archiveThread } from '../thread-routes.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';

const EXPIRY = '2099-01-01T00:00:00.000Z';
const context = (actor: Actor): AdmittedOperationContext => ({
  kind: 'public',
  actor,
  actorRef: { kind: 'user', id: actor.userId },
  scope: { kind: 'server' },
});
/** Actual original producers own all fixture state; physical fixtures remain under Storage. */
async function fixture() {
  await shutdownControlStoreWorkerClient();

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
    await close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  store = new FsStore({ dataRoot });
  return {
    dataRoot,
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
      return createCredentialOperationImplementations({ coreDb, mode: 'server' });
    },
    async reopen() {
      await close();
      coreDb = openCoreDb(dataRoot);
      store = new FsStore({ dataRoot });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
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

const keys = generateKeyPairSync('ed25519');
const applicationId = '123456789012345678';
const discordUserId = '223456789012345678';

/** Publishes a real native notice, with two independently authenticated administrators. */
async function noticeFixture() {
  const admins = await server();
  const { f, admin, backup } = admins;
  await f.trigger.enable(admin);
  await f.trigger.stop(admin);
  for (const row of await f.trigger.readAlarms()) {
    if (row.recipientUserId !== backup.userId) {
      const other = await publishSecurityAlarm({
        coreDb: f.db,
        store: f.store,
        requestId: row.requestId,
      });
      assert.equal(other.status, 'published');
    }
  }
  const alarm = (await f.trigger.readAlarms()).find((row) => row.recipientUserId === backup.userId);
  assert.ok(alarm);
  const result = await publishSecurityAlarm({
    coreDb: f.db,
    store: f.store,
    requestId: alarm.requestId,
  });
  assert.equal(result.status, 'published');
  if (result.status !== 'published') throw new Error('Expected a published notice.');
  const publication = result.publication;
  const recipient: Actor = { kind: 'session', userId: backup.userId };
  const sendAttention = vi
    .fn<DiscordAttentionTransport['sendAttention']>()
    .mockResolvedValue({ status: 'sent', externalMessageId: '523456789012345678' });
  const compose = () =>
    createChannelServices({
      coreDb: f.db,
      store: f.store,
      mode: 'server',
      publicBaseUrl: 'https://openkit.invalid',
      discordConfig: {
        applicationId,
        publicKey: keys.publicKey
          .export({ type: 'spki', format: 'der' })
          .subarray(-32)
          .toString('hex'),
      },
      transport: { sendAttention },
      openWorkspace: (workspaceId) => openWorkspaceDb(f.dataRoot, workspaceId),
      invokePending: async () => {
        throw new Error('Security notices must stay App-only.');
      },
    });
  let services = compose();
  await services.notifications.reconcileIncompleteAttempts();
  await services.discord!.reconcileIncompleteInteractions();
  const { challenge } = await services.discord!.beginPairing(recipient);
  const body = Buffer.from(
    JSON.stringify({
      id: '623456789012345678',
      application_id: applicationId,
      type: 2,
      version: 1,
      context: 1,
      channel: { id: '323456789012345678', type: 1 },
      user: { id: discordUserId },
      data: {
        id: '423456789012345678',
        type: 1,
        name: 'openkit',
        options: [
          { name: 'pair', type: 1, options: [{ name: 'challenge', value: challenge, type: 3 }] },
        ],
      },
    })
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const reply = await services.discord!.handleSignedInteraction({
    body,
    timestamp,
    signature: sign(null, Buffer.concat([Buffer.from(timestamp), body]), keys.privateKey).toString(
      'hex'
    ),
  });
  assert.equal(reply.type, 4);
  if (reply.type === 4) assert.match(reply.data.content, /paired/);
  const notice = await f.trigger.readAlarmNotice(alarm.requestId);
  assert.ok(notice);
  const readPending = () => {
    const db = openWorkspaceDb(f.dataRoot, publication.workspaceId);
    try {
      const record = listThreadPendingRequests(
        db.sqlite,
        publication.workspaceId,
        publication.threadId
      ).find((row) => row.requestId === alarm.requestId);
      assert.ok(record);
      return record;
    } finally {
      db.sqlite.close();
    }
  };
  return {
    ...admins,
    recipient,
    publication,
    notice,
    sendAttention,
    readPending,
    get services() {
      return services;
    },
    async closeRequest(kind: 'answer' | 'withdraw' | 'archive', decidingActor: Actor) {
      if (kind === 'archive') {
        await archiveThread(
          {
            requestId: randomUUID(),
            workspaceId: publication.workspaceId,
            threadId: publication.threadId,
          },
          {
            store: f.store,
            inflightCommands: new WeakMap(),
            repositoryWorkspaceDb: (workspaceId) => openWorkspaceDb(f.dataRoot, workspaceId),
          },
          decidingActor
        );
        assert.notEqual(readPending().state, 'pending');
        return;
      }
      const api = createPendingRequestOperationImplementations({
        coreDb: f.db,
        store: f.store,
        inflightCommands: new WeakMap(),
        repositoryWorkspaceDb: (workspaceId) => openWorkspaceDb(f.dataRoot, workspaceId),
      });
      const input = {
        requestId: randomUUID(),
        workspaceId: publication.workspaceId,
        threadId: publication.threadId,
      };
      const admitted = {
        ...context(decidingActor),
        scope: { kind: 'workspace' as const, workspaceId: publication.workspaceId },
      };
      if (kind === 'withdraw')
        await api['pending-request.withdraw'](
          { ...input, pendingRequestId: alarm.requestId },
          admitted
        );
      else {
        const questions = readPending().questions!;
        const answers = Object.fromEntries(
          questions.map((question) => [String(question.id), ['Expected'] as [string]])
        );
        await api['question.answer'](
          { ...input, userInputRequestId: alarm.requestId, answers },
          admitted
        );
      }
      assert.notEqual(readPending().state, 'pending');
    },
    async restart() {
      await f.reopen();
      services = compose();
      await services.notifications.reconcileIncompleteAttempts();
      await services.discord!.reconcileIncompleteInteractions();
    },
  };
}

describe('outstanding native security notice delivery', () => {
  it.each(['answer', 'withdraw', 'archive'] as const)(
    'keeps a notice deliverable after another administrator %s, including explicit retry',
    async (closure) => {
      const n = await noticeFixture();
      await n.closeRequest(closure, n.admin);
      const record = n.readPending();
      assert.deepEqual(closure === 'answer' ? record.decidingActor : record.endingActor, {
        kind: 'user',
        id: n.admin.userId,
      });
      assert.equal(n.services.eligible(n.notice.attention), true);
      assert.equal(n.services.readableDelivery(n.notice.attention), true);
      n.sendAttention.mockResolvedValueOnce({
        status: 'failed-no-send',
        code: 'transport_unavailable',
      });
      const first = await n.services.send(n.recipient, n.notice.attention.id, null);
      assert.equal(first.status, 'failed-no-send');
      assert.ok(first.attempt);
      assert.equal((await n.services.send(n.recipient, first.id, first.attempt.id)).status, 'sent');
      assert.equal(n.sendAttention.mock.calls.length, 2);
      assert.equal(n.sendAttention.mock.calls[0]![0].automation, true);
      assert.deepEqual(n.readPending(), record);
    }
  );

  it.each(['answer', 'withdraw', 'archive'] as const)(
    'recovers the original cold queued notice after another administrator %s while monitoring is off',
    async (closure) => {
      const n = await noticeFixture();
      await n.closeRequest(closure, n.admin);
      const record = n.readPending();
      await n.restart();
      assert.equal((await n.f.trigger.current()).state, 'off');
      assert.equal(n.services.eligible(n.notice.attention), true);
      await n.services.recoverAttention();
      await vi.waitFor(
        () => assert.equal(n.services.notifications.get(n.notice.attention.id)?.status, 'sent'),
        { timeout: 15_000 }
      );
      assert.equal(n.sendAttention.mock.calls.length, 1);
      await n.services.recoverAttention();
      assert.equal(n.sendAttention.mock.calls.length, 1);
      assert.deepEqual(n.readPending(), record);
      assert.equal(
        n.services.notifications.listForActor(n.recipient.userId, {}, () => true).length,
        1
      );
      assert.deepEqual(
        n.f.db.sqlite
          .prepare('SELECT COUNT(*) AS n FROM security_trigger_outbox WHERE recipient_user_id=?')
          .get(n.recipient.userId),
        { n: 1 }
      );
    }
  );

  it('keeps a recipient withdrawal outstanding because it is not an answer', async () => {
    const n = await noticeFixture();
    await n.closeRequest('withdraw', n.backup);
    await n.restart();
    assert.equal(n.services.eligible(n.notice.attention), true);
    assert.equal((await n.services.send(n.recipient, n.notice.attention.id, null)).status, 'sent');
  });

  it('ends send eligibility only for the recipient answer, retaining readable transport history across restart', async () => {
    const n = await noticeFixture();
    await n.closeRequest('answer', n.backup);
    await n.restart();
    assert.equal(n.services.eligible(n.notice.attention), false);
    assert.equal(n.services.readableDelivery(n.notice.attention), true);
    await n.services.recoverAttention();
    await assert.rejects(() => n.services.send(n.recipient, n.notice.attention.id, null));
    assert.equal(n.sendAttention.mock.calls.length, 0);
  });

  it('rechecks recipient acknowledgement after asynchronous transport preparation', async () => {
    const n = await noticeFixture();
    n.sendAttention.mockImplementationOnce(async (input) => {
      await n.closeRequest('answer', n.backup);
      assert.equal(input.beforeSend(), false);
      return { status: 'failed-no-send', code: 'recipient_acknowledged' };
    });
    assert.equal(
      (await n.services.send(n.recipient, n.notice.attention.id, null)).status,
      'failed-no-send'
    );
  });

  it('never replays unknown transport after third-party closure and restart', async () => {
    const n = await noticeFixture();
    n.sendAttention.mockRejectedValueOnce(new Error('Lost acknowledgement'));
    assert.equal(
      (await n.services.send(n.recipient, n.notice.attention.id, null)).status,
      'delivery-unknown'
    );
    await n.closeRequest('withdraw', n.admin);
    await n.restart();
    assert.equal(n.services.eligible(n.notice.attention), true);
    await n.services.recoverAttention();
    await assert.rejects(() => n.services.send(n.recipient, n.notice.attention.id, null));
    assert.equal(n.sendAttention.mock.calls.length, 1);
  });

  it('refuses an outstanding notice after its recipient loses administrator authority', async () => {
    const n = await noticeFixture();
    await n.closeRequest('withdraw', n.admin);
    await n.f
      .tokens()
      ['credential.revoke']({ kind: 'access-token', id: n.backupTokenId }, context(n.admin));
    await n.restart();
    assert.equal(n.services.eligible(n.notice.attention), false);
    await n.services.recoverAttention();
    await assert.rejects(() => n.services.send(n.recipient, n.notice.attention.id, null));
    assert.equal(n.sendAttention.mock.calls.length, 0);
  });
});
