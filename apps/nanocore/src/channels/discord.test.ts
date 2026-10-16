import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../auth/identity.js';
import { OperationError } from '../operation-error.js';
import {
  createDiscordChannel,
  type DiscordPendingView,
  type DiscordReply,
  verifyDiscordInteraction,
} from './discord.js';

const applicationId = '123456789012345678';
const discordUserId = '223456789012345678';
const actor: Actor = { userId: 'user_discord', kind: 'session' };
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('hex');
const databases: Database.Database[] = [];

/** Installs only the migration-owned tables in an isolated real SQLite fixture. */
function database() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE discord_pairing_challenges (digest TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed_at INTEGER);
    CREATE TABLE discord_account_bindings (discord_user_id TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL,revision TEXT NOT NULL,paired_at INTEGER NOT NULL,revoked_at INTEGER);
    CREATE UNIQUE INDEX discord_account_bindings_active_user ON discord_account_bindings(user_id) WHERE revoked_at IS NULL;
    CREATE TABLE discord_inbound_receipts (event_id TEXT PRIMARY KEY NOT NULL,payload_digest TEXT NOT NULL,request_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('dispatching','settled','response-unknown')),created_at INTEGER NOT NULL);
    CREATE TABLE discord_disclosures (token_digest TEXT PRIMARY KEY NOT NULL,discord_user_id TEXT NOT NULL,binding_revision TEXT NOT NULL,workspace_id TEXT NOT NULL,thread_id TEXT NOT NULL,pending_request_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('approval','user-input')),content_digest TEXT NOT NULL,expires_at INTEGER NOT NULL);
  `);
  databases.push(sqlite);
  return sqlite;
}

/** Extracts only response text, keeping the protocol assertion explicit. */
function content(reply: DiscordReply) {
  expect(reply.type).toBe(4);
  return reply.type === 4 ? reply.data.content : '';
}

/** Builds signed Discord commands without any real account or transport. */
function fixture() {
  const sqlite = database();
  let now = Date.parse('2026-10-16T10:00:00Z');
  let currentActor: Actor | null = actor;
  let view: DiscordPendingView = {
    status: 'available',
    kind: 'approval',
    workspaceId: 'ws_discord',
    threadId: 'th_discord',
    pendingRequestId: 'ap_discord',
    turnId: 'tu_discord',
    content: 'Exact effect: publish the approved page.',
    responseAllowed: true,
  };
  const inspectPending = vi.fn(() => view);
  const invoke = vi.fn(async () => ({ status: 'resolved' }));
  const options = {
    sqlite,
    applicationId,
    publicKey,
    now: () => now,
    newRequestId: randomUUID,
    resolveActor: () => currentActor,
    inspectPending,
    invoke,
  };
  let channel = createDiscordChannel(options);
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
  const signed = (value: unknown, timestamp = String(Math.floor(now / 1000))) => {
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
    const challenge = channel.beginPairing(actor);
    expect(content(await send('pair', { challenge: challenge.challenge }))).toContain('paired');
    return challenge;
  };
  const target = { workspace: 'ws_discord', thread: 'th_discord', request: 'ap_discord' };
  const disclose = async () => {
    const text = content(await send('inspect', target));
    const token = text.match(/Disclosure: ([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();
    return token!;
  };
  return {
    sqlite,
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
    restart() {
      channel = createDiscordChannel(options);
    },
    advance(ms: number) {
      now += ms;
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

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

describe('Discord signed transport and account binding', () => {
  it('verifies exact raw bytes and timestamp, rejects forged, stale and future requests', () => {
    const f = fixture();
    const input = f.signed(f.envelope('inspect', f.target));
    const verify = (value = input) =>
      verifyDiscordInteraction({
        ...value,
        publicKey,
        applicationId,
        now: Date.parse('2026-10-16T10:00:00Z'),
      });
    expect(verify()).toBeTruthy();
    expect(() => verify({ ...input, body: Buffer.from('{}') })).toThrow();
    expect(() => verify({ ...input, signature: '00'.repeat(64) })).toThrow();
    expect(() => verify(f.signed(f.envelope('inspect', f.target), '1'))).toThrow();
    expect(() =>
      verify(
        f.signed(f.envelope('inspect', f.target), String(Date.parse('2026-10-16T11:00:00Z') / 1000))
      )
    ).toThrow();
    expect(() =>
      verify(f.signed({ ...f.envelope('inspect', f.target), application_id: '999999999999999999' }))
    ).toThrow();
  });

  it('acknowledges only authenticated application pings and rejects forged verified objects', async () => {
    const f = fixture();
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
      now: Date.parse('2026-10-16T10:00:00Z'),
    });
    await expect(f.channel.handleVerified(verified)).rejects.toThrow();
    expect(
      f.sqlite.prepare('SELECT count(*) AS count FROM discord_inbound_receipts').get()
    ).toEqual({ count: 0 });
  });

  it('consumes digest-only challenges once, preserves bindings after restart, and revokes them', async () => {
    const f = fixture();
    const challenge = await f.pair();
    expect(
      JSON.stringify(f.sqlite.prepare('SELECT * FROM discord_pairing_challenges').all())
    ).not.toContain(challenge.challenge);
    expect(content(await f.send('pair', { challenge: challenge.challenge }))).toContain(
      'unavailable'
    );
    f.restart();
    expect(f.channel.binding(actor)?.discordUserId).toBe(discordUserId);
    f.channel.revoke(actor);
    expect(f.channel.binding(actor)).toBeNull();
    expect(content(await f.send('inspect', f.target))).toContain('binding');
    expect(f.inspectPending).not.toHaveBeenCalled();
  });

  it('rejects expired or superseded challenges and user-supplied Core identity', async () => {
    const f = fixture();
    const first = f.channel.beginPairing(actor);
    f.channel.beginPairing(actor);
    expect(content(await f.send('pair', { challenge: first.challenge }))).toContain('unavailable');
    const expired = f.channel.beginPairing(actor);
    f.advance(301_000);
    expect(content(await f.send('pair', { challenge: expired.challenge }))).toContain(
      'unavailable'
    );
    expect(content(await f.send('pair', { actorId: actor.userId }))).toContain('unsupported');
    expect(f.channel.binding(actor)).toBeNull();
  });

  it('cannot replace another active user binding and revocation also ends open challenges', async () => {
    const f = fixture();
    await f.pair();
    const other: Actor = { kind: 'session', userId: 'user_other' };
    f.actor(other);
    const challenge = f.channel.beginPairing(other);
    expect(content(await f.send('pair', { challenge: challenge.challenge }))).toContain(
      'active binding'
    );
    expect(f.channel.binding(actor)?.userId).toBe(actor.userId);
    f.channel.revoke(other);
    expect(content(await f.send('pair', { challenge: challenge.challenge }))).toContain(
      'unavailable'
    );
  });

  it('rejects shared, group and ambiguous channels before any protected read', async () => {
    const f = fixture();
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
    const f = fixture();
    await f.pair();
    expect(content(await f.send('approve', f.target))).toContain('channel_grant_requires_app');
    expect(f.inspectPending).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('requires current exact disclosure and invokes only existing approval operation with durable request identity', async () => {
    const f = fixture();
    await f.pair();
    const disclosure = await f.disclose();
    const body = f.signed(f.envelope('deny', { ...f.target, disclosure }));
    const result = await f.channel.handleSignedInteraction(body);
    expect(content(result)).toContain('accepted');
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.invoke).toHaveBeenCalledWith(
      'approval.respond',
      expect.objectContaining({
        workspaceId: 'ws_discord',
        threadId: 'th_discord',
        turnId: 'tu_discord',
        approvalRequestId: 'ap_discord',
        decision: 'denied',
        requestId: expect.any(String),
      }),
      actor
    );
    f.restart();
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
    const f = fixture();
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
    f.channel.revoke(actor);
    await f.pair();
    expect(content(await f.send('deny', { ...f.target, disclosure }))).toContain('disclosure');
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('answers only an admitted non-secret question and preserves native stale failures', async () => {
    const f = fixture();
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
    expect(
      content(
        await f.send('answer', {
          ...f.target,
          disclosure,
          answers: JSON.stringify({ color: ['red'] }),
        })
      )
    ).toContain('request_not_pending');
    f.view({ responseAllowed: false, content: 'Protected secret prompt.' });
    expect(content(await f.send('inspect', f.target))).not.toContain('Protected secret');
    expect(content(await f.send('answer', { ...f.target, disclosure, answers: '{}' }))).toContain(
      'OpenKit'
    );
  });

  it('drops selected administrator credentials and refuses changed scope or expired disclosure', async () => {
    const f = fixture();
    await f.pair();
    const disclosure = await f.disclose();
    expect(
      content(await f.send('deny', { ...f.target, thread: 'th_other', disclosure }))
    ).toContain('disclosure');
    f.actor({
      userId: actor.userId,
      kind: 'token',
      tokenId: 'token_admin',
      tokenScope: 'server-admin',
    });
    await f.send('deny', { ...f.target, disclosure });
    expect(f.invoke.mock.calls[0]?.[2]).toEqual({ userId: actor.userId, kind: 'session' });
    f.advance(301_000);
    expect(content(await f.send('deny', { ...f.target, disclosure }))).toContain('disclosure');
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps interrupted dispatch unknown after restart and never dispatches a duplicate', async () => {
    const f = fixture();
    await f.pair();
    const disclosure = await f.disclose();
    let resolve!: (value: { status: string }) => void;
    f.invoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const input = f.signed(f.envelope('deny', { ...f.target, disclosure }));
    const first = f.channel.handleSignedInteraction(input);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(
      f.sqlite
        .prepare('SELECT state FROM discord_inbound_receipts WHERE event_id = ?')
        .get(JSON.parse(input.body.toString()).id)
    ).toEqual({ state: 'dispatching' });
    f.restart();
    expect(content(await f.channel.handleSignedInteraction(input))).toContain('unknown');
    expect(f.invoke).toHaveBeenCalledTimes(1);
    resolve({ status: 'resolved' });
    await first;
  });

  it('keeps unknown native failure unknown, drops raw disclosure content from receipts and refuses oversized content', async () => {
    const f = fixture();
    await f.pair();
    const disclosure = await f.disclose();
    f.invoke.mockRejectedValueOnce(new Error('Transport lost after native dispatch.'));
    expect(content(await f.send('deny', { ...f.target, disclosure }))).toContain('unknown');
    expect(
      JSON.stringify(f.sqlite.prepare('SELECT * FROM discord_inbound_receipts').all())
    ).not.toContain('publish the approved page');
    f.view({ content: 'x'.repeat(2_001) });
    expect(content(await f.send('inspect', f.target))).toContain('OpenKit');
  });
});
