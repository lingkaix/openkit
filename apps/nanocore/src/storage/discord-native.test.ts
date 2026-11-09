import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { isRecord } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../auth/identity.js';
import {
  createDiscordChannel,
  type DiscordChannelOptions,
  type DiscordPendingView,
  type DiscordReply,
} from '../channels/discord.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

// Observe and, when armed, withhold one genuine post-COMMIT reply from the real Worker.
const native = vi.hoisted(() => ({
  frames: [] as unknown[],
  requests: new Map<number, string>(),
  stage: undefined as string | undefined,
  arrived: undefined as (() => void) | undefined,
  release: undefined as (() => void) | undefined,
  worker: undefined as NativeWorker | undefined,
}));
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        const frame: unknown = args[0];
        if (
          isRecord(frame) &&
          frame.operation === 'discord-channel' &&
          typeof frame.id === 'number' &&
          isRecord(frame.input) &&
          typeof frame.input.stage === 'string'
        ) {
          native.frames.push(structuredClone(frame));
          native.requests.set(frame.id, frame.input.stage);
          native.worker = this;
        }
        return super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const reply = args[0];
        if (
          event === 'message' &&
          isRecord(reply) &&
          reply.status === 'ok' &&
          reply.operation === 'discord-channel' &&
          typeof reply.id === 'number' &&
          native.stage !== undefined &&
          native.requests.get(reply.id) === native.stage
        ) {
          native.stage = undefined;
          native.release = () => super.emit(event, ...args);
          native.arrived?.();
          return true;
        }
        return super.emit(event, ...args);
      }
    },
  };
});

const applicationId = '123456789012345678';
const discordUserId = '223456789012345678';
const actor: Actor = { userId: FIXTURE_LOCAL_USER_ID, kind: 'session' };
const workspaceId = testEntityId('ws', 'discord-native');
const threadId = testEntityId('th', 'discord-native');
const turnId = testEntityId('tu', 'discord-native');
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('hex');
const roots: string[] = [];
const databases: CoreDb[] = [];

function text(reply: DiscordReply): string {
  expect(reply.type).toBe(4);
  if (reply.type !== 4) throw new Error('Expected a private Discord reply.');
  expect(reply.data.flags).toBe(64);
  expect(reply.data.allowed_mentions).toEqual({ parse: [] });
  return reply.data.content;
}

/** Real signed producer and SQLite owner; only current Pending projection and invocation are external dependencies. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'discord-native-'));
  roots.push(dataRoot);
  let coreDb = openCoreDb(dataRoot);
  databases.push(coreDb);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  let currentActor: Actor | null = actor;
  let view: DiscordPendingView = {
    status: 'available',
    kind: 'approval',
    workspaceId,
    threadId,
    pendingRequestId: 'ap_discord_native',
    turnId,
    content: 'Exact private effect: publish native-only page.',
    responseAllowed: true,
  };
  const inspect = vi.fn(() => view);
  const requestLink = vi.fn(() => `https://openkit.invalid/tasks/${workspaceId}/${threadId}`);
  const invoke = vi.fn<DiscordChannelOptions['invoke']>(async () => ({ status: 'resolved' }));
  const compose = () => {
    coreDb.sqlite.pragma('query_only = ON');
    return createDiscordChannel({
      sqlite: coreDb.sqlite,
      nativeCoreDb: coreDb,
      mode: 'server',
      applicationId,
      publicKey,
      appBaseUrl: 'https://openkit.invalid',
      requestLink,
      newRequestId: randomUUID,
      resolveActor: () => currentActor,
      inspectPending: inspect,
      invoke,
    });
  };
  // OLD reaches the genuine original Main startup UPDATE under query_only before a future API is used.
  let channel = compose();
  await channel.reconcileIncompleteInteractions();
  let event = 100000000000000000n;
  const target = { workspace: workspaceId, thread: threadId, request: 'ap_discord_native' };
  const envelope = (command: string, values: Record<string, string>) => ({
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
  });
  const signed = (value: unknown) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
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
  const send = (command: string, values: Record<string, string>) =>
    channel.handleSignedInteraction(signed(envelope(command, values)));
  const pair = async () => {
    const challenge = await channel.beginPairing(actor);
    expect(text(await send('pair', { challenge: challenge.challenge }))).toContain('paired');
    return challenge;
  };
  const disclose = async () => {
    const result = text(await send('inspect', target));
    const token = result.match(/Disclosure: ([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();
    return token!;
  };
  return {
    dataRoot,
    target,
    pair,
    disclose,
    send,
    signed,
    envelope,
    invoke,
    inspect,
    requestLink,
    get db() {
      return coreDb;
    },
    get channel() {
      return channel;
    },
    actor(value: Actor | null) {
      currentActor = value;
    },
    questions() {
      view = {
        status: 'available',
        kind: 'user-input',
        workspaceId,
        threadId,
        pendingRequestId: 'ap_discord_native',
        turnId,
        content: 'Exact private question: choose a color.',
        responseAllowed: true,
      };
    },
    unavailable() {
      view = { status: 'unavailable', code: 'request_not_pending' };
    },
    async cold() {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      databases.push(coreDb);
      channel = compose();
      return channel.reconcileIncompleteInteractions();
    },
    fault(sql: string) {
      const external = new Database(coreDb.sqlite.name);
      try {
        external.exec(sql);
      } finally {
        external.close();
      }
    },
  };
}

afterEach(async () => {
  native.stage = undefined;
  native.release?.();
  native.release = undefined;
  native.arrived = undefined;
  await shutdownControlStoreWorkerClient();
  native.frames = [];
  native.requests.clear();
  native.worker = undefined;
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Discord native family', () => {
  it('returns only the App home after binding revocation during an approve settlement ACK', async () => {
    const f = await fixture();
    await f.pair();
    const committed = new Promise<void>((resolve) => {
      native.arrived = resolve;
    });
    native.stage = 'settle-inbound';
    const pending = f.send('approve', f.target);
    void pending.catch(() => undefined);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        committed,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Missing genuine approve settlement ACK.')),
            10_000
          );
        }),
      ]);
      expect(f.requestLink).not.toHaveBeenCalled();
      await f.channel.revoke(actor);
      expect(f.channel.binding(actor)).toBeNull();
      native.release!();
      native.release = undefined;
      const result = text(await pending);
      expect(f.requestLink).not.toHaveBeenCalled();
      expect(result).not.toContain(`/tasks/${workspaceId}/${threadId}`);
      expect(result).toContain('Open OpenKit: https://openkit.invalid');
      expect(f.inspect).not.toHaveBeenCalled();
      expect(f.invoke).not.toHaveBeenCalled();
    } finally {
      if (timeout) clearTimeout(timeout);
      native.stage = undefined;
      native.release?.();
      native.release = undefined;
      await pending.catch(() => undefined);
    }
  });

  it('refuses an owner-issued expired challenge without consuming or binding it across cold reopen', async () => {
    const f = await fixture();
    const issued = await f.channel.beginPairing(actor);
    f.fault(
      `UPDATE discord_pairing_challenges SET expires_at = ${Date.now() - 1} WHERE consumed_at IS NULL`
    );
    const expired = f.db.sqlite.prepare('SELECT * FROM discord_pairing_challenges').all();
    expect(expired).toEqual([expect.objectContaining({ consumed_at: null })]);
    expect(text(await f.send('pair', { challenge: issued.challenge }))).toContain('unavailable');
    expect(f.channel.binding(actor)).toBeNull();
    expect(f.db.sqlite.prepare('SELECT * FROM discord_pairing_challenges').all()).toEqual(expired);
    expect(
      [...native.requests.values()].filter((stage) => stage === 'consume-challenge')
    ).toHaveLength(1);
    expect(f.invoke).not.toHaveBeenCalled();
    expect(await f.cold()).toBe(0);
    expect(f.channel.binding(actor)).toBeNull();
    expect(f.db.sqlite.prepare('SELECT * FROM discord_pairing_challenges').all()).toEqual(expired);
  });

  it('publishes all original stages with Main query_only and retains only digests through cold reopen', async () => {
    const f = await fixture();
    const challenge = await f.pair();
    const disclosure = await f.disclose();
    const binding = f.channel.binding(actor);
    const body = f.signed(f.envelope('deny', { ...f.target, disclosure }));
    const simultaneous = await Promise.all([
      f.channel.handleSignedInteraction(body),
      f.channel.handleSignedInteraction(body),
    ]);
    expect(simultaneous.map(text).filter((value) => value.includes('accepted'))).toHaveLength(1);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const changed = JSON.parse(body.body.toString()) as {
      data: { options: Array<{ name: string }> };
    };
    changed.data.options[0]!.name = 'approve';
    expect(text(await f.channel.handleSignedInteraction(f.signed(changed)))).toContain('conflict');
    expect(f.invoke).toHaveBeenCalledTimes(1);
    f.questions();
    const questionDisclosure = await f.disclose();
    expect(
      text(
        await f.send('answer', {
          ...f.target,
          disclosure: questionDisclosure,
          answers: '{"color":["ULTRA_PRIVATE_BLUE"]}',
        })
      )
    ).toContain('accepted');
    expect(f.invoke).toHaveBeenCalledTimes(2);
    await f.channel.beginPairing(actor);
    await f.channel.revoke(actor);
    expect(f.channel.binding(actor)).toBeNull();
    expect(binding?.discordUserId).toBe(discordUserId);
    expect(await f.cold()).toBe(0);
    expect(text(await f.channel.handleSignedInteraction(body))).toContain('already handled');
    expect(f.invoke).toHaveBeenCalledTimes(2);
    const frames = JSON.stringify(native.frames);
    expect(frames).not.toContain(challenge.challenge);
    expect(frames).not.toContain(disclosure);
    expect(frames).not.toContain(questionDisclosure);
    expect(frames).not.toContain('Exact private effect');
    expect(frames).not.toContain('Exact private question');
    expect(frames).not.toContain('ULTRA_PRIVATE_BLUE');
    const stages = new Set(native.requests.values());
    expect(stages).toEqual(
      new Set([
        'reconcile-incomplete',
        'revoke-binding',
        'issue-challenge',
        'consume-challenge',
        'reserve-inbound',
        'publish-origin',
        'publish-disclosure',
        'settle-inbound',
      ])
    );
  });

  it.each([
    'reconcile-incomplete',
    'revoke-binding',
    'issue-challenge',
    'consume-challenge',
    'reserve-inbound',
    'publish-origin',
    'publish-disclosure',
    'settle-inbound',
  ])('joins the genuine %s FULL acknowledgement before its caller continues', async (stage) => {
    const f = await fixture();
    let action: () => Promise<unknown>;
    if (stage === 'issue-challenge') {
      action = async () => f.channel.beginPairing(actor);
    } else if (stage === 'consume-challenge') {
      const issued = await f.channel.beginPairing(actor);
      action = () => f.send('pair', { challenge: issued.challenge });
    } else {
      await f.pair();
      if (stage === 'revoke-binding') {
        await f.channel.beginPairing(actor);
        action = async () => f.channel.revoke(actor);
      } else if (stage === 'publish-disclosure') {
        action = () => f.send('inspect', f.target);
      } else if (stage === 'reconcile-incomplete') {
        f.fault(`CREATE TRIGGER fail_settlement BEFORE UPDATE OF state ON discord_inbound_receipts
          BEGIN SELECT RAISE(ABORT, 'settlement refused'); END`);
        await expect(f.send('inspect', f.target)).rejects.toThrow();
        f.fault('DROP TRIGGER fail_settlement');
        action = () => f.channel.reconcileIncompleteInteractions();
      } else {
        const disclosure = await f.disclose();
        action = () => f.send('deny', { ...f.target, disclosure });
      }
    }
    const priorInspections = f.inspect.mock.calls.length;
    const committed = new Promise<void>((resolve) => {
      native.arrived = resolve;
    });
    native.stage = stage;
    let continued = false;
    const pending = action().then((result) => {
      continued = true;
      return result;
    });
    void pending.catch(() => undefined);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        committed,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Missing genuine ${stage} ACK.`)), 10_000);
        }),
      ]);
      expect(continued).toBe(false);
      // SQLite is committed while only the real post-COMMIT reply is withheld.
      if (stage === 'revoke-binding') {
        expect(f.channel.binding(actor)).toBeNull();
        expect(
          f.db.sqlite
            .prepare(
              'SELECT count(*) AS count FROM discord_pairing_challenges WHERE consumed_at IS NULL'
            )
            .get()
        ).toEqual({ count: 0 });
      } else if (stage === 'issue-challenge') {
        expect(
          f.db.sqlite.prepare('SELECT count(*) AS count FROM discord_pairing_challenges').get()
        ).toEqual({ count: 1 });
      } else if (stage === 'consume-challenge') {
        expect(f.channel.binding(actor)?.discordUserId).toBe(discordUserId);
      } else if (stage === 'publish-disclosure') {
        expect(
          f.db.sqlite.prepare('SELECT count(*) AS count FROM discord_disclosures').get()
        ).toEqual({ count: 1 });
      } else if (stage === 'reconcile-incomplete') {
        expect(
          f.db.sqlite
            .prepare(
              "SELECT count(*) AS count FROM discord_inbound_receipts WHERE state='dispatching'"
            )
            .get()
        ).toEqual({ count: 0 });
      } else if (stage === 'reserve-inbound') {
        expect(f.inspect).toHaveBeenCalledTimes(priorInspections);
        expect(
          f.db.sqlite
            .prepare("SELECT operation_id FROM discord_inbound_receipts WHERE state='dispatching'")
            .get()
        ).toEqual({ operation_id: null });
      } else if (stage === 'publish-origin') {
        expect(
          f.db.sqlite
            .prepare("SELECT operation_id FROM discord_inbound_receipts WHERE state='dispatching'")
            .get()
        ).toEqual({ operation_id: 'approval.respond' });
      }
      expect(f.invoke).toHaveBeenCalledTimes(stage === 'settle-inbound' ? 1 : 0);
      native.release!();
      native.release = undefined;
      const result = await pending;
      expect(continued).toBe(true);
      if (stage === 'reconcile-incomplete') expect(result).toBe(1);
      if (stage === 'publish-disclosure')
        expect(text(result as DiscordReply)).toContain('Disclosure:');
      if (['reserve-inbound', 'publish-origin', 'settle-inbound'].includes(stage)) {
        expect(text(result as DiscordReply)).toContain('accepted');
        expect(f.invoke).toHaveBeenCalledTimes(1);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      native.stage = undefined;
      native.release?.();
      native.release = undefined;
      await pending.catch(() => undefined);
    }
  });

  it.each(['reserve-inbound', 'publish-origin', 'publish-disclosure', 'settle-inbound'])(
    'keeps lost %s acknowledgement unknown without invoking, replaying content or reposting',
    async (stage) => {
      const f = await fixture();
      await f.pair();
      const disclosure = stage === 'publish-disclosure' ? undefined : await f.disclose();
      const input = f.envelope(stage === 'publish-disclosure' ? 'inspect' : 'deny', {
        ...f.target,
        ...(disclosure ? { disclosure } : {}),
      });
      const signed = f.signed(input);
      const committed = new Promise<void>((resolve) => {
        native.arrived = resolve;
      });
      native.stage = stage;
      let continued = false;
      const pending = f.channel
        .handleSignedInteraction(signed)
        .then(
          (reply) => ({ reply }),
          (error: unknown) => ({ error })
        )
        .then((result) => {
          continued = true;
          return result;
        });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          committed,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`Missing genuine ${stage} ACK.`)), 10_000);
          }),
        ]);
        expect(continued).toBe(false);
        const retained = f.db.sqlite
          .prepare('SELECT * FROM discord_inbound_receipts WHERE event_id=?')
          .get(input.id) as Record<string, unknown>;
        expect(retained.state).toBe(stage === 'settle-inbound' ? 'settled' : 'dispatching');
        expect(f.invoke).toHaveBeenCalledTimes(stage === 'settle-inbound' ? 1 : 0);
        const posts = native.frames.length;
        native.release = undefined;
        await native.worker!.terminate();
        const result = await pending;
        if ('reply' in result) {
          expect(text(result.reply)).not.toContain('accepted');
          expect(text(result.reply)).not.toContain('Disclosure:');
        }
        expect(native.frames).toHaveLength(posts);
        expect(await f.cold()).toBe(stage === 'settle-inbound' ? 0 : 1);
        expect(
          f.db.sqlite
            .prepare('SELECT * FROM discord_inbound_receipts WHERE event_id=?')
            .get(input.id)
        ).toEqual({
          ...retained,
          state: stage === 'settle-inbound' ? 'settled' : 'response-unknown',
        });
        expect(text(await f.channel.handleSignedInteraction(signed))).toContain(
          stage === 'settle-inbound' ? 'already handled' : 'unknown'
        );
        expect(f.invoke).toHaveBeenCalledTimes(stage === 'settle-inbound' ? 1 : 0);
      } finally {
        if (timeout) clearTimeout(timeout);
        native.stage = undefined;
        native.release?.();
        native.release = undefined;
      }
    }
  );

  it.each([
    ['publish-origin', 'binding'],
    ['publish-origin', 'source'],
    ['publish-origin', 'actor'],
    ['publish-origin', 'disclosure-expiry'],
    ['publish-disclosure', 'binding'],
    ['publish-disclosure', 'source'],
  ] as const)(
    'rechecks current %s authority after its ACK when %s changes',
    async (stage, loss) => {
      const f = await fixture();
      await f.pair();
      const disclosure = stage === 'publish-origin' ? await f.disclose() : undefined;
      const input = f.envelope(stage === 'publish-origin' ? 'deny' : 'inspect', {
        ...f.target,
        ...(disclosure ? { disclosure } : {}),
      });
      const committed = new Promise<void>((resolve) => {
        native.arrived = resolve;
      });
      native.stage = stage;
      const pending = f.channel.handleSignedInteraction(f.signed(input));
      void pending.catch(() => undefined);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          committed,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`Missing genuine ${stage} ACK.`)), 10_000);
          }),
        ]);
        if (loss === 'binding') await f.channel.revoke(actor);
        else if (loss === 'source') f.unavailable();
        else if (loss === 'disclosure-expiry') {
          // The exact owner-created disclosure was valid before the origin commit.
          // Expire its retained proof during the genuine ACK gap, without changing clocks.
          f.fault('UPDATE discord_disclosures SET expires_at = 0');
        } else f.actor(null);
        native.release!();
        native.release = undefined;
        const result = text(await pending);
        if (loss === 'disclosure-expiry') expect.soft(f.invoke).not.toHaveBeenCalled();
        expect(result).toContain('refused');
        expect(result).not.toContain('Disclosure:');
        expect(result).not.toContain('Exact private effect');
        expect(f.invoke).not.toHaveBeenCalled();
        expect(
          f.db.sqlite
            .prepare('SELECT state,operation_id FROM discord_inbound_receipts WHERE event_id=?')
            .get(input.id)
        ).toEqual({
          state: 'settled',
          operation_id: stage === 'publish-origin' ? 'approval.respond' : null,
        });
      } finally {
        if (timeout) clearTimeout(timeout);
        native.stage = undefined;
        native.release?.();
        native.release = undefined;
        await pending.catch(() => undefined);
      }
    }
  );

  it.each(['issue-challenge', 'revoke-binding', 'consume-challenge'])(
    'rolls back every member of native %s and preserves the prior tuple after cold reopen',
    async (stage) => {
      const f = await fixture();
      let action: () => Promise<unknown>;
      let fault: string;
      if (stage === 'revoke-binding') {
        await f.pair();
        await f.channel.beginPairing(actor);
        fault = `CREATE TRIGGER fail_stage BEFORE UPDATE OF consumed_at ON discord_pairing_challenges
          WHEN OLD.consumed_at IS NULL BEGIN SELECT RAISE(ABORT, 'late revoke refused'); END`;
        action = async () => f.channel.revoke(actor);
      } else {
        const challenge = await f.channel.beginPairing(actor);
        if (stage === 'issue-challenge') {
          fault = `CREATE TRIGGER fail_stage BEFORE INSERT ON discord_pairing_challenges
            BEGIN SELECT RAISE(ABORT, 'late issue refused'); END`;
          action = async () => f.channel.beginPairing(actor);
        } else {
          fault = `CREATE TRIGGER fail_stage BEFORE INSERT ON discord_account_bindings
            BEGIN SELECT RAISE(ABORT, 'late pair refused'); END`;
          action = () => f.send('pair', { challenge: challenge.challenge });
        }
      }
      const before = {
        challenges: f.db.sqlite
          .prepare('SELECT * FROM discord_pairing_challenges ORDER BY digest')
          .all(),
        bindings: f.db.sqlite
          .prepare('SELECT * FROM discord_account_bindings ORDER BY discord_user_id')
          .all(),
      };
      f.fault(fault);
      if (stage === 'consume-challenge')
        expect(text((await action()) as DiscordReply)).toContain('refused');
      else await expect(action()).rejects.toThrow();
      expect({
        challenges: f.db.sqlite
          .prepare('SELECT * FROM discord_pairing_challenges ORDER BY digest')
          .all(),
        bindings: f.db.sqlite
          .prepare('SELECT * FROM discord_account_bindings ORDER BY discord_user_id')
          .all(),
      }).toEqual(before);
      expect(f.invoke).not.toHaveBeenCalled();
      f.fault('DROP TRIGGER fail_stage');
      expect(await f.cold()).toBe(0);
      expect({
        challenges: f.db.sqlite
          .prepare('SELECT * FROM discord_pairing_challenges ORDER BY digest')
          .all(),
        bindings: f.db.sqlite
          .prepare('SELECT * FROM discord_account_bindings ORDER BY discord_user_id')
          .all(),
      }).toEqual(before);
    }
  );
});
