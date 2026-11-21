import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalIdentifierName, isRecord } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../auth/identity.js';
import { OperationError } from '../operation-error.js';
import { requireChannelStorage } from '../storage/communication-inbound.js';
import type { ChannelInboundOrigin } from '../storage/communication-port.js';
import {
  communicationKernelFixture,
  openCommunicationFixture,
} from '../storage/communication-worker.test-support.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb, serverStoragePath } from '../storage/db.js';
import { ensureLayout } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import {
  type DiscordPendingView,
  type DiscordReply,
  verifyDiscordInteraction,
} from './discord-interaction.js';
import {
  type CommunicationDiscordChannelOptions,
  openCommunicationDiscordChannel,
} from './discord-owner.js';

const native = vi.hoisted(() => ({ inKernel: false }));
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    get isMainThread() {
      return !native.inKernel && actual.isMainThread;
    },
  };
});

const applicationId = '123456789012345678';
const discordUserId = '223456789012345678';
const actor: Actor = { userId: testEntityId('usr', 'discord'), kind: 'session' };
const workspaceId = testEntityId('ws', 'discord');
const threadId = testEntityId('th', 'discord');
const turnId = testEntityId('tu', 'discord');
const requestLink = `https://openkit.invalid/tasks/${workspaceId}/${threadId}?requestId=ap_discord`;
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('hex');
const coreConnections: CoreDb[] = [];
const communicationConnections = new Set<Database.Database>();
const directories: string[] = [];

type Inbound = {
  readonly external_account_id: string | null;
  readonly origin_json: string | null;
  readonly native_input_hash: string | null;
  readonly refusal_code: string | null;
  readonly receipt_digest: string | null;
};

/** Extracts only response text, keeping the protocol assertion explicit. */
function content(reply: DiscordReply) {
  expect(reply.type).toBe(4);
  return reply.type === 4 ? reply.data.content : '';
}

/** Builds signed Discord commands without any real account or transport. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'discord-channel-'));
  directories.push(root);
  ensureLayout(root);
  const core = openCoreDb(root);
  const kernelDb = openCoreDb(root);
  coreConnections.push(core, kernelDb);
  applyMigrations(core);
  ensureLocalUser(core);
  const addUser = core.sqlite.prepare(`INSERT INTO users
    (id, display_name, email, email_verified, created_at, updated_at, kind)
    SELECT ?, display_name, ? || email, email_verified, created_at, updated_at, 'human'
    FROM users WHERE id = ?`);
  for (const id of [
    actor.userId,
    testEntityId('usr', 'discord-other'),
    testEntityId('usr', 'later-discord-owner'),
  ]) {
    addUser.run(id, id, FIXTURE_LOCAL_USER_ID);
  }
  const path = serverStoragePath(root, 'communication');
  let currentActor: Actor | null = actor;
  let view: DiscordPendingView = {
    status: 'available',
    kind: 'approval',
    workspaceId,
    threadId,
    pendingRequestId: 'ap_discord',
    turnId,
    content: 'Exact effect: publish the approved page.',
    responseAllowed: true,
  };
  const inspectPending = vi.fn(() => view);
  const invoke = vi.fn<CommunicationDiscordChannelOptions['invoke']>(async () => undefined);
  const proofs = new Map<string, string>();
  const verifyDecision = (origin: ChannelInboundOrigin) =>
    proofs.get(origin.envelope.requestId) ?? null;
  const kernel = communicationKernelFixture(kernelDb, verifyDecision, (effect) => {
    native.inKernel = true;
    try {
      return effect();
    } finally {
      native.inKernel = false;
    }
  });
  let owner = await openCommunicationFixture(core, 'server', kernel);
  const connect = () => {
    const connection = new Database(path, { fileMustExist: true });
    communicationConnections.add(connection);
    return connection;
  };
  let sqlite = connect();
  function compose() {
    const channel = requireChannelStorage(
      openCommunicationDiscordChannel({
        storage: owner.owners.communication.storage,
        kernel,
        deploymentId: owner.owners.deploymentId,
        applicationId,
        publicKey,
        appBaseUrl: 'https://openkit.invalid',
        requestLink: () => requestLink,
        resolveActor: (userId) => (currentActor?.userId === userId ? currentActor : null),
        inspectPending,
        inspectPendingDecision: verifyDecision,
        invoke: async (operation, input, selected) => {
          if (!isRecord(input) || typeof input.requestId !== 'string')
            throw new Error('Missing request');
          await invoke(operation, input, selected);
          proofs.set(input.requestId, 'c'.repeat(64));
        },
      })
    );
    return {
      binding: channel.binding,
      beginPairing: (actor: Actor) =>
        owner.withProducer(() => channel.beginPairing(actor)).then(requireChannelStorage),
      revoke: (actor: Actor) =>
        owner.withProducer(() => channel.revoke(actor)).then(requireChannelStorage),
      handleVerified: (input: Parameters<typeof channel.handleVerified>[0]) =>
        owner.withProducer(() => channel.handleVerified(input)).then(requireChannelStorage),
      handleSignedInteraction: (input: Parameters<typeof channel.handleSignedInteraction>[0]) =>
        owner
          .withProducer(() => channel.handleSignedInteraction(input))
          .then(requireChannelStorage),
    };
  }
  let channel = compose();
  let event = 100000000000000000n;
  const envelope = (command: string, values: Record<string, string> = {}, extra = {}) => ({
    id: String(++event),
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
        {
          name: command,
          type: 1,
          options: Object.entries(values).map(([name, value]) => ({ name, value, type: 3 })),
        },
      ],
    },
    ...extra,
  });
  const signed = (value: unknown, timestamp = String(Math.floor(Date.now() / 1000))) => {
    const body = Buffer.from(JSON.stringify(value));
    return {
      body,
      timestamp,
      signature: sign(
        null,
        Buffer.concat([Buffer.from(timestamp), body]),
        keys.privateKey
      ).toString('hex'),
    };
  };
  const send = (command: string, values: Record<string, string> = {}, extra = {}) =>
    channel.handleSignedInteraction(signed(envelope(command, values, extra)));
  const pair = async () => {
    const challenge = await channel.beginPairing(actor);
    expect(content(await send('pair', { challenge: challenge.challenge }))).toContain('paired');
    return challenge;
  };
  const target = { workspace: workspaceId, thread: threadId, request: 'ap_discord' };
  const disclose = async () => {
    const text = content(await send('inspect', target));
    const token = text.match(/Disclosure: ([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();
    return token!;
  };
  return {
    get sqlite() {
      return sqlite;
    },
    retained(eventId: string) {
      return sqlite
        .prepare(`
        SELECT * FROM communication_intents WHERE json_extract(intent_json, '$.occurrenceKey') = ?
      `)
        .get(canonicalIdentifierName(['discord', 'interaction', eventId])) as Inbound | undefined;
    },
    signed,
    envelope,
    send,
    pair,
    disclose,
    target,
    inspectPending,
    invoke,
    get channel() {
      return channel;
    },
    async restart() {
      await shutdownControlStoreWorkerClient();
      sqlite.close();
      owner = await openCommunicationFixture(core, 'server', kernel);
      sqlite = connect();
      channel = compose();
    },
    restartHandler() {
      channel = compose();
    },
    actor(value: Actor | null) {
      currentActor = value;
    },
    view(value: Partial<Extract<DiscordPendingView, { status: 'available' }>>) {
      view = { ...view, ...value } as DiscordPendingView;
    },
    unavailable() {
      view = { status: 'unavailable', code: 'request_not_pending' };
    },
  };
}

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const sqlite of communicationConnections) if (sqlite.open) sqlite.close();
  communicationConnections.clear();
  for (const db of coreConnections.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Discord original durable stage boundaries', () => {
  it('rolls back whole challenge, revocation and pairing stages and resumes only exact unfinished receipts', async () => {
    const f = await fixture();
    const challenges = () =>
      f.sqlite.prepare('SELECT * FROM channel_pairing_challenges ORDER BY digest').all();
    const bindings = () =>
      f.sqlite.prepare('SELECT * FROM channel_account_bindings ORDER BY external_account_id').all();
    const first = await f.channel.beginPairing(actor);
    const initialChallenges = challenges();
    f.sqlite.exec(`CREATE TRIGGER fail_challenge_insert BEFORE INSERT ON channel_pairing_challenges
      BEGIN SELECT RAISE(ABORT, 'challenge insertion refused'); END`);
    await expect(Promise.resolve().then(() => f.channel.beginPairing(actor))).rejects.toThrow();
    expect(challenges()).toEqual(initialChallenges);
    f.sqlite.exec('DROP TRIGGER fail_challenge_insert');
    expect(content(await f.send('pair', { challenge: first.challenge }))).toContain('paired');

    await f.channel.beginPairing(actor);
    const beforeRevoke = { challenges: challenges(), bindings: bindings() };
    f.sqlite.exec(`CREATE TRIGGER fail_challenge_retirement BEFORE UPDATE OF consumed_at ON channel_pairing_challenges
      WHEN OLD.consumed_at IS NULL BEGIN SELECT RAISE(ABORT, 'challenge retirement refused'); END`);
    await expect(Promise.resolve().then(() => f.channel.revoke(actor))).rejects.toThrow();
    expect({ challenges: challenges(), bindings: bindings() }).toEqual(beforeRevoke);
    f.sqlite.exec('DROP TRIGGER fail_challenge_retirement');
    await f.channel.revoke(actor);

    const next = await f.channel.beginPairing(actor);
    const beforePair = { challenges: challenges(), bindings: bindings() };
    f.sqlite.exec(`CREATE TRIGGER fail_binding_insert BEFORE INSERT ON channel_account_bindings
      BEGIN SELECT RAISE(ABORT, 'binding insertion refused'); END`);
    expect(content(await f.send('pair', { challenge: next.challenge }))).toContain('unknown');
    expect({ challenges: challenges(), bindings: bindings() }).toEqual(beforePair);
    f.sqlite.exec('DROP TRIGGER fail_binding_insert');
    expect(content(await f.send('pair', { challenge: next.challenge }))).toContain('paired');

    const firstEvent = f.envelope('inspect', f.target);
    const secondEvent = f.envelope('inspect', f.target);
    const blockSettlement = `CREATE TRIGGER fail_settlement BEFORE UPDATE OF receipt_digest ON communication_intents
      WHEN OLD.kind = 'channel.inbound' BEGIN SELECT RAISE(ABORT, 'settlement refused'); END`;
    f.sqlite.exec(blockSettlement);
    for (const event of [firstEvent, secondEvent]) {
      expect(content(await f.channel.handleSignedInteraction(f.signed(event)))).toContain(
        'unknown'
      );
      expect(f.retained(event.id)).toMatchObject({ origin_json: null, receipt_digest: null });
    }
    const pending = [f.retained(firstEvent.id), f.retained(secondEvent.id)];
    const binding = f.channel.binding(actor);
    const durable = { challenges: challenges(), bindings: bindings() };
    const disclosures = () =>
      f.sqlite.prepare('SELECT * FROM channel_disclosures ORDER BY token_digest').all();
    const beforeReopen = disclosures();
    f.sqlite.exec('DROP TRIGGER fail_settlement');
    await f.restart();
    expect(f.channel.binding(actor)).toEqual(binding);
    expect({ challenges: challenges(), bindings: bindings() }).toEqual(durable);
    expect(disclosures()).toEqual(beforeReopen);
    expect([f.retained(firstEvent.id), f.retained(secondEvent.id)]).toEqual(pending);

    // Keep the injected fault outside physical admission so it exercises original replay.
    f.sqlite.exec(blockSettlement);
    const inspections = f.inspectPending.mock.calls.length;
    expect(content(await f.channel.handleSignedInteraction(f.signed(firstEvent)))).toContain(
      'unknown'
    );
    expect([f.retained(firstEvent.id), f.retained(secondEvent.id)]).toEqual(pending);
    f.sqlite.exec('DROP TRIGGER fail_settlement');
    expect(content(await f.channel.handleSignedInteraction(f.signed(firstEvent)))).toContain(
      'already handled'
    );
    expect(f.retained(firstEvent.id)?.receipt_digest).toMatch(/^sha256:/);
    expect(f.retained(secondEvent.id)).toEqual(pending[1]);
    expect(f.inspectPending).toHaveBeenCalledTimes(inspections);
    expect(disclosures()).toEqual(beforeReopen);
    expect(f.invoke).not.toHaveBeenCalled();
  });
});

describe('Discord signed transport and account binding', () => {
  it('verifies exact raw bytes and timestamp, rejects forged, stale and future requests', async () => {
    const f = await fixture();
    const input = f.signed(f.envelope('inspect', f.target));
    const now = Date.now();
    const verify = (value = input) =>
      verifyDiscordInteraction({
        ...value,
        publicKey,
        applicationId,
        now,
      });
    expect(verify()).toBeTruthy();
    expect(() => verify({ ...input, body: Buffer.from('{}') })).toThrow();
    expect(() => verify({ ...input, signature: '00'.repeat(64) })).toThrow();
    expect(() => verify(f.signed(f.envelope('inspect', f.target), '1'))).toThrow();
    expect(() =>
      verify(
        f.signed(f.envelope('inspect', f.target), String(Math.floor((now + 60 * 60_000) / 1000)))
      )
    ).toThrow();
    expect(() =>
      verify(f.signed({ ...f.envelope('inspect', f.target), application_id: '999999999999999999' }))
    ).toThrow();
  });

  it('acknowledges only authenticated application pings and rejects forged verified objects', async () => {
    const f = await fixture();
    expect(
      await f.channel.handleSignedInteraction(
        f.signed({ id: '100000000000000001', application_id: applicationId, type: 1, version: 1 })
      )
    ).toEqual({ type: 1 });
    await expect(
      f.channel.handleVerified({ body: '{}', payloadDigest: 'forged', applicationId, publicKey })
    ).rejects.toThrow();
    const otherKeys = generateKeyPairSync('ed25519');
    const otherPublicKey = otherKeys.publicKey
      .export({ type: 'spki', format: 'der' })
      .subarray(-32)
      .toString('hex');
    const input = f.signed(f.envelope('inspect', f.target));
    const verified = verifyDiscordInteraction({
      ...input,
      signature: sign(
        null,
        Buffer.concat([Buffer.from(input.timestamp), input.body]),
        otherKeys.privateKey
      ).toString('hex'),
      publicKey: otherPublicKey,
      applicationId,
      now: Date.now(),
    });
    await expect(f.channel.handleVerified(verified)).rejects.toThrow();
    expect(
      f.sqlite
        .prepare(
          `SELECT count(*) AS count FROM communication_intents WHERE kind = 'channel.inbound'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it('consumes digest-only challenges once, preserves bindings after restart, and revokes them', async () => {
    const f = await fixture();
    const challenge = await f.pair();
    expect(
      JSON.stringify(f.sqlite.prepare('SELECT * FROM channel_pairing_challenges').all())
    ).not.toContain(challenge.challenge);
    expect(content(await f.send('pair', { challenge: challenge.challenge }))).toContain(
      'unavailable'
    );
    await f.restart();
    expect(f.channel.binding(actor)?.externalAccountId).toBe(discordUserId);
    await f.channel.revoke(actor);
    expect(f.channel.binding(actor)).toBeNull();
    expect(content(await f.send('inspect', f.target))).toContain('binding');
    expect(f.inspectPending).not.toHaveBeenCalled();
  });

  it('rejects expired or superseded challenges and user-supplied Core identity', async () => {
    const f = await fixture();
    const first = await f.channel.beginPairing(actor);
    await f.channel.beginPairing(actor);
    expect(content(await f.send('pair', { challenge: first.challenge }))).toContain('unavailable');
    const expired = await f.channel.beginPairing(actor);
    f.sqlite.exec('UPDATE channel_pairing_challenges SET expires_at = 0 WHERE consumed_at IS NULL');
    expect(content(await f.send('pair', { challenge: expired.challenge }))).toContain(
      'unavailable'
    );
    expect(content(await f.send('pair', { actorId: actor.userId }))).toContain('unsupported');
    expect(f.channel.binding(actor)).toBeNull();
  });

  it('cannot replace another active user binding and revocation also ends open challenges', async () => {
    const f = await fixture();
    await f.pair();
    const other: Actor = { kind: 'session', userId: testEntityId('usr', 'discord-other') };
    f.actor(other);
    const challenge = await f.channel.beginPairing(other);
    expect(content(await f.send('pair', { challenge: challenge.challenge }))).toContain(
      'active binding'
    );
    expect(f.channel.binding(actor)?.userId).toBe(actor.userId);
    await f.channel.revoke(other);
    expect(content(await f.send('pair', { challenge: challenge.challenge }))).toContain(
      'unavailable'
    );
  });

  it('rejects shared, group and ambiguous channels before any protected read', async () => {
    const f = await fixture();
    await f.pair();
    for (const extra of [
      { guild_id: '523456789012345678' },
      { context: 2 },
      { channel: { type: 3 } },
      { member: { user: { id: discordUserId } } },
      { channel: undefined },
    ]) {
      expect(content(await f.send('inspect', f.target, extra))).toContain('private');
    }
    expect(f.inspectPending).not.toHaveBeenCalled();
  });
});

describe('Discord exact Pending Request projection', () => {
  it('returns grant requests to the App without reading protected content or dispatching an operation', async () => {
    const f = await fixture();
    await f.pair();
    expect(content(await f.send('approve', f.target))).toContain(requestLink);
    expect(f.inspectPending).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('requires current exact disclosure and invokes only existing approval operation with durable request identity', async () => {
    const f = await fixture();
    await f.pair();
    const disclosure = await f.disclose();
    const body = f.signed(f.envelope('deny', { ...f.target, disclosure }));
    const result = await f.channel.handleSignedInteraction(body);
    expect(content(result)).toContain('accepted');
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.invoke).toHaveBeenCalledWith(
      'approval.respond',
      expect.objectContaining({
        workspaceId,
        threadId,
        turnId,
        approvalRequestId: 'ap_discord',
        decision: 'denied',
        requestId: expect.any(String),
      }),
      actor
    );
    await f.restart();
    await f.channel.handleSignedInteraction(body);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const changed = JSON.parse(body.body.toString());
    changed.data.options[0].name = 'approve';
    expect(content(await f.channel.handleSignedInteraction(f.signed(changed)))).toContain(
      'conflict'
    );
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it('refuses changed effect, ended request, revoked authority, and revoked disclosure binding', async () => {
    const f = await fixture();
    await f.pair();
    const disclosure = await f.disclose();
    f.view({ content: 'Changed exact effect.' });
    expect(content(await f.send('deny', { ...f.target, disclosure }))).toContain('changed');
    f.unavailable();
    expect(content(await f.send('deny', { ...f.target, disclosure }))).toContain(
      'request_not_pending'
    );
    f.actor(null);
    expect(content(await f.send('deny', { ...f.target, disclosure }))).toContain('authority');
    f.actor(actor);
    await f.channel.revoke(actor);
    await f.pair();
    expect(content(await f.send('deny', { ...f.target, disclosure }))).toContain('disclosure');
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('answers only an admitted non-secret question and preserves native stale failures', async () => {
    const f = await fixture();
    await f.pair();
    f.view({ kind: 'user-input', content: 'Which color? red or blue.' });
    const disclosure = await f.disclose();
    await f.send('answer', {
      ...f.target,
      disclosure,
      answers: JSON.stringify({ color: ['blue'] }),
    });
    expect(f.invoke).toHaveBeenCalledWith(
      'question.answer',
      expect.objectContaining({ userInputRequestId: 'ap_discord', answers: { color: ['blue'] } }),
      actor
    );
    f.invoke.mockRejectedValueOnce(
      new OperationError('request_not_pending', 'Private error detail.', 409)
    );
    const unknown = content(
      await f.send('answer', {
        ...f.target,
        disclosure,
        answers: JSON.stringify({ color: ['red'] }),
      })
    );
    expect(unknown).toContain('unknown');
    expect(unknown).not.toContain('Private error detail.');
    f.view({ responseAllowed: false, content: 'Protected secret prompt.' });
    expect(content(await f.send('inspect', f.target))).not.toContain('Protected secret');
    expect(content(await f.send('answer', { ...f.target, disclosure, answers: '{}' }))).toContain(
      'OpenKit'
    );
    f.unavailable();
    expect(
      content(await f.send('answer', { ...f.target, disclosure, answers: '{"color":["red"]}' }))
    ).toContain('request_not_pending');
  });

  it('drops selected administrator credentials and refuses changed scope or expired disclosure', async () => {
    const f = await fixture();
    await f.pair();
    const disclosure = await f.disclose();
    expect(
      content(
        await f.send('deny', {
          ...f.target,
          thread: testEntityId('th', 'discord-other'),
          disclosure,
        })
      )
    ).toContain('disclosure');
    f.actor({
      userId: actor.userId,
      kind: 'token',
      tokenId: testEntityId('tok', 'discord-admin'),
      tokenScope: 'server-admin',
    });
    await f.send('deny', { ...f.target, disclosure });
    expect(f.invoke.mock.calls[0]?.[2]).toEqual({ userId: actor.userId, kind: 'session' });
    f.sqlite.exec('UPDATE channel_disclosures SET expires_at = 0');
    expect(content(await f.send('deny', { ...f.target, disclosure }))).toContain('disclosure');
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps interrupted dispatch unknown after restart and never dispatches a duplicate', async () => {
    const f = await fixture();
    await f.pair();
    const disclosure = await f.disclose();
    let resolve!: (value: { status: string }) => void;
    let dispatched!: () => void;
    const dispatchStarted = new Promise<void>((done) => {
      dispatched = done;
    });
    f.invoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
          dispatched();
        })
    );
    const input = f.signed(f.envelope('deny', { ...f.target, disclosure }));
    const first = f.channel.handleSignedInteraction(input);
    await Promise.race([
      dispatchStarted,
      first.then(() => {
        throw new Error('The exact native invocation was never reached.');
      }),
    ]);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.retained(JSON.parse(input.body.toString()).id)).toMatchObject({
      origin_json: expect.any(String),
      receipt_digest: null,
    });
    f.restartHandler();
    expect(content(await f.channel.handleSignedInteraction(input))).toContain('unknown');
    expect(f.invoke).toHaveBeenCalledTimes(1);
    resolve({ status: 'resolved' });
    await first;
  });

  it('keeps unknown native failure unknown, drops raw disclosure content from receipts and refuses oversized content', async () => {
    const f = await fixture();
    await f.pair();
    const disclosure = await f.disclose();
    f.invoke.mockRejectedValueOnce(new Error('Transport lost after native dispatch.'));
    expect(content(await f.send('deny', { ...f.target, disclosure }))).toContain('unknown');
    expect(
      JSON.stringify(f.sqlite.prepare('SELECT * FROM communication_intents').all())
    ).not.toContain('publish the approved page');
    f.view({ content: 'x'.repeat(2_001) });
    expect(content(await f.send('inspect', f.target))).toContain('OpenKit');
  });
});

describe('Discord trusted capture origin', () => {
  it('retains the signed external actor without claiming unbound or rejected native authority', async () => {
    const f = await fixture();
    const input = f.envelope(
      'deny',
      { ...f.target, disclosure: 'untrusted' },
      {
        core_user_id: actor.userId,
      }
    );
    await f.channel.handleSignedInteraction(f.signed(input));
    expect(f.retained(input.id)).toMatchObject({
      external_account_id: discordUserId,
      origin_json: null,
      native_input_hash: null,
      refusal_code: 'channel_binding_unavailable',
    });
    expect(f.invoke).not.toHaveBeenCalled();
    await expect(
      f.channel.handleSignedInteraction({ ...f.signed(input), signature: '00'.repeat(64) })
    ).rejects.toThrow('Discord authentication failed.');
    expect(
      f.sqlite
        .prepare(
          `SELECT count(*) AS count FROM communication_intents WHERE kind = 'channel.inbound'`
        )
        .get()
    ).toEqual({ count: 1 });
  });

  it.each(['approval', 'user-input'] as const)(
    'stamps exact admitted %s origin before native dispatch',
    async (kind) => {
      const f = await fixture();
      await f.pair();
      f.view({ kind });
      const disclosure = await f.disclose();
      const binding = f.channel.binding(actor)!;
      const input = f.envelope(
        kind === 'approval' ? 'deny' : 'answer',
        {
          ...f.target,
          disclosure,
          ...(kind === 'user-input' ? { answers: '{"color":["blue"]}' } : {}),
        },
        { user: { id: discordUserId, core_user_id: 'forged-core-user' } }
      );
      let retained: Inbound | undefined;
      f.invoke.mockImplementationOnce(async (_operation, command, responder) => {
        retained = f.retained(input.id);
        expect(retained).toMatchObject({
          request_id: (command as { requestId: string }).requestId,
          receipt_digest: null,
          external_account_id: discordUserId,
          native_input_hash: expect.stringMatching(/^sha256:/),
        });
        expect(JSON.parse(retained!.origin_json!)).toMatchObject({
          userId: responder.userId,
          bindingRevision: binding.revision,
          operation: kind === 'approval' ? 'approval.respond' : 'question.answer',
          workspaceId,
          threadId,
          pendingRequestId: 'ap_discord',
          turnId,
        });
      });
      expect(content(await f.channel.handleSignedInteraction(f.signed(input)))).toContain(
        'accepted'
      );
      expect(retained).toBeDefined();
      expect(JSON.stringify(retained)).not.toContain(disclosure);
      expect(JSON.stringify(retained)).not.toContain('blue');
      expect(f.invoke).toHaveBeenCalledTimes(1);
      const settled = f.retained(input.id);
      expect(settled?.receipt_digest).toMatch(/^sha256:/);
      await f.restart();
      expect(content(await f.channel.handleSignedInteraction(f.signed(input)))).toContain(
        'already handled'
      );
      expect(f.retained(input.id)).toEqual(settled);
      expect(f.invoke).toHaveBeenCalledTimes(1);
    }
  );

  it('preserves admitted origin after unknown dispatch, restart, revocation and re-pairing', async () => {
    const f = await fixture();
    await f.pair();
    const disclosure = await f.disclose();
    const input = f.signed(f.envelope('deny', { ...f.target, disclosure }));
    const eventId = JSON.parse(input.body.toString()).id;
    f.invoke.mockRejectedValueOnce(new Error('uncertain native response'));
    expect(content(await f.channel.handleSignedInteraction(input))).toContain('unknown');
    const retained = f.retained(eventId);
    expect(JSON.parse(retained!.origin_json!)).toMatchObject({
      userId: actor.userId,
      operation: 'approval.respond',
    });
    await f.channel.revoke(actor);
    const other: Actor = { kind: 'session', userId: testEntityId('usr', 'later-discord-owner') };
    f.actor(other);
    const challenge = await f.channel.beginPairing(other);
    await f.send('pair', { challenge: challenge.challenge });
    expect(f.channel.binding(other)?.userId).toBe(other.userId);
    await f.restart();
    expect(content(await f.channel.handleSignedInteraction(input))).toContain('unknown');
    expect(f.retained(eventId)).toEqual(retained);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it('does not rebuild a redacted original receipt from a current binding', async () => {
    const f = await fixture();
    await f.pair();
    const event = f.envelope('inspect', f.target);
    const input = f.signed(event);
    expect(content(await f.channel.handleSignedInteraction(input))).toContain('Disclosure:');
    const original = f.retained(event.id)!;
    f.sqlite
      .prepare(
        'UPDATE communication_intents SET external_account_id = NULL WHERE receipt_digest = ?'
      )
      .run(original.receipt_digest);
    await f.restart();
    f.inspectPending.mockClear();
    expect(content(await f.channel.handleSignedInteraction(input))).toContain('already handled');
    expect(f.retained(event.id)).toEqual({ ...original, external_account_id: null });
    expect(f.inspectPending).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('refuses native dispatch when the origin update retains no row', async () => {
    const f = await fixture();
    await f.pair();
    const disclosure = await f.disclose();
    f.sqlite.exec(`CREATE TRIGGER discard_origin BEFORE UPDATE OF origin_json ON communication_intents
      WHEN NEW.origin_json IS NOT NULL BEGIN SELECT RAISE(IGNORE); END`);
    expect(content(await f.send('deny', { ...f.target, disclosure }))).toContain('unknown');
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('refuses native dispatch when required origin persistence fails', async () => {
    const f = await fixture();
    await f.pair();
    const disclosure = await f.disclose();
    f.sqlite.exec(`CREATE TRIGGER refuse_origin BEFORE UPDATE OF origin_json ON communication_intents
      WHEN NEW.origin_json IS NOT NULL BEGIN SELECT RAISE(ABORT, 'origin write unavailable'); END`);
    const input = f.envelope('deny', { ...f.target, disclosure });
    expect(content(await f.channel.handleSignedInteraction(f.signed(input)))).toContain('unknown');
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.retained(input.id)).toMatchObject({
      external_account_id: discordUserId,
      origin_json: null,
      native_input_hash: null,
      receipt_digest: null,
    });
  });
});
