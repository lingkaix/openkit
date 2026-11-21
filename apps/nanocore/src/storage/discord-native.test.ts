import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { canonicalIdentifierName, isRecord } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { type Actor, actorFromSession } from '../auth/identity.js';
import type { DiscordPendingView, DiscordReply } from '../channels/discord-interaction.js';
import {
  type CommunicationDiscordChannelOptions,
  openCommunicationDiscordChannel,
} from '../channels/discord-owner.js';
import { SecurityTriggerStore } from '../security/trigger.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { requireChannelStorage } from './communication-inbound.js';
import type { ChannelInboundOrigin } from './communication-port.js';
import {
  communicationKernelFixture,
  openCommunicationFixture,
} from './communication-worker.test-support.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { type CoreDb, openCoreDb, serverStoragePath } from './db.js';
import { ensureLayout } from './fs-layout.js';
import { applyMigrations } from './migrate.js';

// Observe and, when armed, withhold one genuine post-COMMIT reply from the real Worker.
const native = vi.hoisted(() => ({
  frames: [] as unknown[],
  inKernel: false,
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
    get isMainThread() {
      return !native.inKernel && actual.isMainThread;
    },
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        const frame: unknown = args[0];
        if (
          isRecord(frame) &&
          frame.operation === 'communication-owner' &&
          typeof frame.id === 'number' &&
          typeof frame.stage === 'string'
        ) {
          const content =
            frame.content instanceof ArrayBuffer
              ? Buffer.from(frame.content).toString('utf8')
              : null;
          native.frames.push({ ...structuredClone(frame), content });
          native.requests.set(frame.id, frame.stage);
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
          reply.operation === 'communication-owner' &&
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
const communicationConnections = new Set<Database.Database>();

function text(reply: DiscordReply): string {
  expect(reply.type).toBe(4);
  if (reply.type !== 4) throw new Error('Expected a private Discord reply.');
  expect(reply.data.flags).toBe(64);
  expect(reply.data.allowed_mentions).toEqual({ parse: [] });
  return reply.data.content;
}

/** Real signed producer and SQLite owner; only current Pending projection and invocation are external dependencies. */
async function fixture(
  administrator = false,
  userKind: 'local' | 'human' = 'local',
  mode: 'local' | 'server' = 'server'
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'discord-native-'));
  roots.push(dataRoot);
  ensureLayout(dataRoot);
  let coreDb = openCoreDb(dataRoot);
  databases.push(coreDb);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  let pairingActor: Actor = {
    userId: FIXTURE_LOCAL_USER_ID,
    kind: mode === 'local' ? 'local' : 'session',
  };
  if (userKind === 'human') {
    const auth = createBetterAuth(coreDb, {
      env: { BETTER_AUTH_URL: 'https://auth.example.invalid' },
    });
    const created = await auth.api.signUpEmail({
      returnHeaders: true,
      body: {
        name: 'Pairing user',
        email: [randomUUID(), 'example.invalid'].join('@'),
        password: randomUUID(),
      },
    });
    const cookie = created.headers
      .getSetCookie()
      .map((value) => value.split(';', 1)[0])
      .join('; ');
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session).toBeTruthy();
    pairingActor = actorFromSession(session!);
    // Better Auth initialized the Core worker with its private fixture opening.
    await shutdownControlStoreWorkerClient();
  }
  const actor = pairingActor;
  if (administrator)
    createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: actor.userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
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
  const proofs = new Map<string, string>();
  const verifyDecision = (origin: ChannelInboundOrigin) =>
    proofs.get(origin.envelope.requestId) ?? null;
  const invoke = vi.fn<CommunicationDiscordChannelOptions['invoke']>(async (_id, input) => {
    if (!isRecord(input) || typeof input.requestId !== 'string') throw new Error('Missing request');
    proofs.set(input.requestId, 'c'.repeat(64));
  });
  let kernelDb = openCoreDb(dataRoot);
  databases.push(kernelDb);
  const path = serverStoragePath(dataRoot, 'communication');
  const openCommunication = async () => {
    coreDb.sqlite.pragma('query_only = ON');
    const kernel = communicationKernelFixture(kernelDb, verifyDecision, (effect) => {
      native.inKernel = true;
      try {
        return effect();
      } finally {
        native.inKernel = false;
      }
    });
    const owner = await openCommunicationFixture(coreDb, mode, kernel);
    const channel = requireChannelStorage(
      openCommunicationDiscordChannel({
        applicationId,
        publicKey,
        appBaseUrl: 'https://openkit.invalid',
        deploymentId: owner.owners.deploymentId,
        storage: owner.owners.communication.storage,
        kernel,
        requestLink,
        resolveActor: () => currentActor,
        inspectPending: inspect,
        inspectPendingDecision: verifyDecision,
        invoke,
      })
    );
    return {
      beginPairing: (actor: Actor) =>
        owner.withProducer(() => channel.beginPairing(actor)).then(requireChannelStorage),
      binding: channel.binding,
      revoke: (actor: Actor) =>
        owner.withProducer(() => channel.revoke(actor)).then(requireChannelStorage),
      handleSignedInteraction: (input: Parameters<typeof channel.handleSignedInteraction>[0]) =>
        owner
          .withProducer(() => channel.handleSignedInteraction(input))
          .then(requireChannelStorage),
    };
  };
  let channel = await openCommunication();
  function connectCommunication() {
    const db = new Database(path, { fileMustExist: true });
    communicationConnections.add(db);
    return db;
  }
  let sqlite = connectCommunication();
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
    pairingActor,
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
    get sqlite() {
      return sqlite;
    },
    retained(eventId: string) {
      return sqlite
        .prepare(`
        SELECT origin_json, native_input_hash, receipt_digest, refusal_code
        FROM communication_intents WHERE json_extract(intent_json, '$.occurrenceKey') = ?
      `)
        .get(canonicalIdentifierName(['discord', 'interaction', eventId])) as
        | {
            origin_json: string | null;
            native_input_hash: string | null;
            receipt_digest: string | null;
            refusal_code: string | null;
          }
        | undefined;
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
      kernelDb.sqlite.close();
      sqlite.close();
      coreDb = openCoreDb(dataRoot);
      kernelDb = openCoreDb(dataRoot);
      databases.push(coreDb, kernelDb);
      channel = await openCommunication();
      sqlite = connectCommunication();
    },
    fault(sql: string) {
      sqlite.exec(sql);
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
  for (const db of communicationConnections) if (db.open) db.close();
  communicationConnections.clear();
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Discord native family', () => {
  it('rolls back unbinding when its original Audit insert fails', async () => {
    const f = await fixture();
    await f.pair();
    const binding = f.channel.binding(actor);
    f.fault(
      "CREATE TRIGGER reject_pairing_audit BEFORE INSERT ON communication_intents WHEN json_extract(NEW.event_json, '$.action') = 'channel.pairing.unbind' BEGIN SELECT RAISE(ABORT, 'Audit fixture failure'); END"
    );
    await expect(f.channel.revoke(actor)).rejects.toThrow();
    expect(f.channel.binding(actor)).toEqual(binding);
    expect(
      f.db.sqlite
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'channel.pairing.unbind'")
        .get()
    ).toEqual({ n: 0 });
  });

  it.each([
    { userKind: 'human', mode: 'server', token: false, administrator: false },
    { userKind: 'human', mode: 'server', token: true, administrator: true },
    { userKind: 'local', mode: 'local', token: false, administrator: true },
  ] as const)(
    'publishes pairing bind and unbind Audit facts for $userKind in $mode (administrator=$administrator)',
    async ({ userKind, mode, token, administrator }) => {
      const f = await fixture(token, userKind, mode);
      const actor = f.pairingActor;
      if (userKind === 'local')
        expect(
          f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM openkit_access_tokens').get()
        ).toEqual({ n: 0 });
      await f.pair();
      const revision = f.channel.binding(actor)!.revision;
      await f.channel.revoke(actor);
      const readEvents = () =>
        f.db.sqlite
          .prepare(
            "SELECT action, actor_json AS actor, subject_json AS subject, resource_revision AS revision, summary FROM audit_events WHERE action IN ('channel.pairing.bind','channel.pairing.unbind') ORDER BY rowid"
          )
          .all() as {
          action: string;
          actor: string;
          subject: string;
          revision: number | null;
          summary: string;
        }[];
      await vi.waitFor(() => expect(readEvents()).toHaveLength(2));
      const events = readEvents();
      expect(events.map((e) => e.action)).toEqual([
        'channel.pairing.bind',
        'channel.pairing.unbind',
      ]);
      for (const event of events) {
        expect(JSON.parse(event.actor)).toEqual({ kind: 'user', id: actor.userId });
        expect(JSON.parse(event.subject)).toEqual({ kind: 'user', id: actor.userId });
        expect(JSON.parse(event.summary)).toEqual({
          channelKind: 'discord',
          userId: actor.userId,
          bindingRevision: revision,
          administratorAtEvent: administrator,
        });
      }
      await f.channel.revoke(actor);
      expect(
        f.db.sqlite
          .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'channel.pairing.unbind'")
          .get()
      ).toEqual({ n: 1 });
      // Grant current monitoring authority only after the non-admin facts were committed.
      if (!administrator) {
        f.db.sqlite.pragma('query_only = OFF');
        createOpenKitAccessTokenRecord(f.db, {
          ownerUserId: actor.userId,
          scope: 'server-admin',
          workspaceIds: [],
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
        f.db.sqlite.pragma('query_only = ON');
      }
      const trigger = new SecurityTriggerStore(f.db);
      await expect(trigger.enable(actor)).rejects.toMatchObject({ code: 'forbidden' });
      expect(
        (await trigger.readAudit()).events.filter((event) =>
          event.action.startsWith('channel.pairing.')
        )
      ).toEqual([]);
      expect(await trigger.detectAudit()).toEqual({
        cursor: null,
        scanned: 0,
        detected: 0,
        unsupported: 0,
      });
      expect(
        (await trigger.readDetections()).events.filter((event) =>
          event.action.startsWith('channel.pairing.')
        )
      ).toEqual([]);
    }
  );

  it('returns only the App home after binding revocation during an approve settlement ACK', async () => {
    const f = await fixture();
    await f.pair();
    const committed = new Promise<void>((resolve) => {
      native.arrived = resolve;
    });
    native.stage = 'settle-handled';
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
      `UPDATE channel_pairing_challenges SET expires_at = ${Date.now() - 1} WHERE consumed_at IS NULL`
    );
    const expired = f.sqlite.prepare('SELECT * FROM channel_pairing_challenges').all();
    expect(expired).toEqual([expect.objectContaining({ consumed_at: null })]);
    expect(text(await f.send('pair', { challenge: issued.challenge }))).toContain('unavailable');
    expect(f.channel.binding(actor)).toBeNull();
    expect(f.sqlite.prepare('SELECT * FROM channel_pairing_challenges').all()).toEqual(expired);
    expect([...native.requests.values()].filter((stage) => stage === 'pair')).toHaveLength(0);
    expect(
      [...native.requests.values()].filter((stage) => stage === 'settle-refusal')
    ).toHaveLength(1);
    expect(f.invoke).not.toHaveBeenCalled();
    await f.cold();
    expect(f.channel.binding(actor)).toBeNull();
    expect(f.sqlite.prepare('SELECT * FROM channel_pairing_challenges').all()).toEqual(expired);
  });

  it('publishes all original stages with Main query_only and retains only digests through cold reopen', async () => {
    const f = await fixture();
    expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
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
    expect(binding?.externalAccountId).toBe(discordUserId);
    await f.cold();
    expect(text(await f.channel.handleSignedInteraction(body))).toContain('already handled');
    expect(f.invoke).toHaveBeenCalledTimes(2);
    const frames = JSON.stringify({
      wire: native.frames,
      intents: f.sqlite.prepare('SELECT * FROM communication_intents').all(),
      challenges: f.sqlite.prepare('SELECT * FROM channel_pairing_challenges').all(),
      disclosures: f.sqlite.prepare('SELECT * FROM channel_disclosures').all(),
    });
    expect(frames).not.toContain(challenge.challenge);
    expect(frames).not.toContain(disclosure);
    expect(frames).not.toContain(questionDisclosure);
    expect(frames).not.toContain('Exact private effect');
    expect(frames).not.toContain('Exact private question');
    expect(frames).not.toContain('ULTRA_PRIVATE_BLUE');
    const stages = new Set(native.requests.values());
    expect([...stages]).toEqual(
      expect.arrayContaining([
        'reconcile-attention',
        'unbind',
        'issue-challenge',
        'pair',
        'stage-envelope',
        'claim-origin',
        'write-disclosure',
        'settle-origin',
        'settle-handled',
      ])
    );
  });

  it.each([
    'settle-handled',
    'unbind',
    'issue-challenge',
    'pair',
    'stage-envelope',
    'claim-origin',
    'write-disclosure',
    'settle-origin',
  ])('joins the genuine %s FULL acknowledgement before its caller continues', async (stage) => {
    const f = await fixture();
    let action: () => Promise<unknown>;
    let postedEvent: string | undefined;
    if (stage === 'issue-challenge') {
      action = () => f.channel.beginPairing(actor);
    } else if (stage === 'pair') {
      const issued = await f.channel.beginPairing(actor);
      action = () => f.send('pair', { challenge: issued.challenge });
    } else {
      await f.pair();
      if (stage === 'unbind') {
        await f.channel.beginPairing(actor);
        action = () => f.channel.revoke(actor);
      } else {
        const message =
          stage === 'write-disclosure' || stage === 'settle-handled'
            ? f.envelope('inspect', f.target)
            : f.envelope('deny', { ...f.target, disclosure: await f.disclose() });
        postedEvent = message.id;
        action = () => f.channel.handleSignedInteraction(f.signed(message));
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
      if (stage === 'unbind') {
        expect(f.channel.binding(actor)).toBeNull();
        expect(
          f.sqlite
            .prepare(
              'SELECT count(*) AS count FROM channel_pairing_challenges WHERE consumed_at IS NULL'
            )
            .get()
        ).toEqual({ count: 0 });
      } else if (stage === 'issue-challenge') {
        expect(
          f.sqlite.prepare('SELECT count(*) AS count FROM channel_pairing_challenges').get()
        ).toEqual({ count: 1 });
      } else if (stage === 'pair') {
        expect(f.channel.binding(actor)?.externalAccountId).toBe(discordUserId);
      } else if (stage === 'write-disclosure') {
        expect(f.sqlite.prepare('SELECT count(*) AS count FROM channel_disclosures').get()).toEqual(
          { count: 1 }
        );
      } else if (stage === 'settle-handled') {
        expect(f.retained(postedEvent!)).toMatchObject({
          origin_json: null,
          receipt_digest: expect.any(String),
        });
      } else if (stage === 'stage-envelope') {
        expect(f.inspect).toHaveBeenCalledTimes(priorInspections);
        expect(f.retained(postedEvent!)).toMatchObject({
          origin_json: null,
          native_input_hash: null,
          receipt_digest: null,
        });
      } else if (stage === 'claim-origin') {
        const row = f.retained(postedEvent!)!;
        expect(JSON.parse(row.origin_json!)).toMatchObject({ operation: 'approval.respond' });
        expect(row.native_input_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(row.receipt_digest).toBeNull();
      } else {
        expect(f.retained(postedEvent!)?.receipt_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      }
      expect(f.invoke).toHaveBeenCalledTimes(stage === 'settle-origin' ? 1 : 0);
      native.release!();
      native.release = undefined;
      const result = await pending;
      expect(continued).toBe(true);
      if (stage === 'write-disclosure' || stage === 'settle-handled')
        expect(text(result as DiscordReply)).toContain('Disclosure:');
      if (['stage-envelope', 'claim-origin', 'settle-origin'].includes(stage)) {
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

  it.each(['stage-envelope', 'claim-origin', 'write-disclosure', 'settle-origin'])(
    'keeps lost %s acknowledgement unknown without invoking, replaying content or reposting',
    async (stage) => {
      const f = await fixture();
      await f.pair();
      const disclosure = stage === 'write-disclosure' ? undefined : await f.disclose();
      const input = f.envelope(stage === 'write-disclosure' ? 'inspect' : 'deny', {
        ...f.target,
        ...(disclosure ? { disclosure } : {}),
      });
      const signed = f.signed(input);
      const committed = new Promise<void>((resolve) => {
        native.arrived = resolve;
      });
      native.stage = stage;
      let continued = false;
      const pending = f.channel.handleSignedInteraction(signed).then((reply) => {
        continued = true;
        return reply;
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
        const retained = f.retained(input.id)!;
        if (stage === 'settle-origin') expect(retained.receipt_digest).toMatch(/^sha256:/);
        else expect(retained.receipt_digest).toBeNull();
        expect(f.invoke).toHaveBeenCalledTimes(stage === 'settle-origin' ? 1 : 0);
        const posts = native.frames.length;
        native.release = undefined;
        await native.worker!.terminate();
        const result = text(await pending);
        expect(result).toContain('outcome is unknown');
        expect(result).not.toContain('accepted');
        expect(result).not.toContain('Disclosure:');
        expect(native.frames).toHaveLength(posts);
        await f.cold();
        expect(f.retained(input.id)).toEqual(retained);
        expect(text(await f.channel.handleSignedInteraction(signed))).toContain(
          stage === 'settle-origin' ? 'already handled' : 'unknown'
        );
        expect(f.invoke).toHaveBeenCalledTimes(stage === 'settle-origin' ? 1 : 0);
      } finally {
        if (timeout) clearTimeout(timeout);
        native.stage = undefined;
        native.release?.();
        native.release = undefined;
      }
    }
  );

  it.each([
    ['claim-origin', 'binding'],
    ['claim-origin', 'source'],
    ['claim-origin', 'actor'],
    ['claim-origin', 'disclosure-expiry'],
    ['write-disclosure', 'binding'],
    ['write-disclosure', 'source'],
    ['settle-handled', 'source'],
  ] as const)(
    'rechecks current %s authority after its ACK when %s changes',
    async (stage, loss) => {
      const f = await fixture();
      await f.pair();
      const disclosure = stage === 'claim-origin' ? await f.disclose() : undefined;
      const input = f.envelope(stage === 'claim-origin' ? 'deny' : 'inspect', {
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
        if (loss === 'binding') {
          f.sqlite
            .prepare('UPDATE channel_account_bindings SET revoked_at = ? WHERE user_id = ?')
            .run(Date.now(), actor.userId);
        } else if (loss === 'source') f.unavailable();
        else if (loss === 'disclosure-expiry') {
          // The exact owner-created disclosure was valid before the origin commit.
          // Expire its retained proof during the genuine ACK gap, without changing clocks.
          f.fault('UPDATE channel_disclosures SET expires_at = 0');
        } else f.actor(null);
        native.release!();
        native.release = undefined;
        const result = text(await pending);
        if (loss === 'disclosure-expiry') expect.soft(f.invoke).not.toHaveBeenCalled();
        expect(result).toContain('refused');
        expect(result).not.toContain('Disclosure:');
        expect(result).not.toContain('Exact private effect');
        expect(f.invoke).not.toHaveBeenCalled();
        const row = f.retained(input.id)!;
        expect(row.refusal_code).toEqual(expect.any(String));
        await f.cold();
        expect(text(await f.channel.handleSignedInteraction(f.signed(input)))).toEqual(result);
        expect(f.invoke).not.toHaveBeenCalled();
        if (stage === 'claim-origin') {
          expect(JSON.parse(row.origin_json!)).toMatchObject({ operation: 'approval.respond' });
          expect(row.receipt_digest).toBeNull();
        } else {
          expect(row.origin_json).toBeNull();
          expect(row.receipt_digest).toMatch(/^sha256:/);
        }
      } finally {
        if (timeout) clearTimeout(timeout);
        native.stage = undefined;
        native.release?.();
        native.release = undefined;
        await pending.catch(() => undefined);
      }
    }
  );

  it.each(['issue-challenge', 'unbind', 'pair'])(
    'rolls back every member of native %s and preserves the prior tuple after cold reopen',
    async (stage) => {
      const f = await fixture();
      let action: () => Promise<unknown>;
      let fault: string;
      if (stage === 'unbind') {
        await f.pair();
        await f.channel.beginPairing(actor);
        fault = `CREATE TRIGGER fail_stage BEFORE UPDATE OF consumed_at ON channel_pairing_challenges
          WHEN OLD.consumed_at IS NULL BEGIN SELECT RAISE(ABORT, 'late revoke refused'); END`;
        action = async () => f.channel.revoke(actor);
      } else {
        const challenge = await f.channel.beginPairing(actor);
        if (stage === 'issue-challenge') {
          fault = `CREATE TRIGGER fail_stage BEFORE INSERT ON channel_pairing_challenges
            BEGIN SELECT RAISE(ABORT, 'late issue refused'); END`;
          action = async () => f.channel.beginPairing(actor);
        } else {
          fault = `CREATE TRIGGER fail_stage BEFORE INSERT ON channel_account_bindings
            BEGIN SELECT RAISE(ABORT, 'late pair refused'); END`;
          action = () => f.send('pair', { challenge: challenge.challenge });
        }
      }
      const before = {
        challenges: f.sqlite
          .prepare('SELECT * FROM channel_pairing_challenges ORDER BY digest')
          .all(),
        bindings: f.sqlite
          .prepare('SELECT * FROM channel_account_bindings ORDER BY external_account_id')
          .all(),
      };
      f.fault(fault);
      if (stage === 'pair')
        expect(text((await action()) as DiscordReply)).toContain('outcome is unknown');
      else await expect(action()).rejects.toThrow();
      expect({
        challenges: f.sqlite
          .prepare('SELECT * FROM channel_pairing_challenges ORDER BY digest')
          .all(),
        bindings: f.sqlite
          .prepare('SELECT * FROM channel_account_bindings ORDER BY external_account_id')
          .all(),
      }).toEqual(before);
      expect(f.invoke).not.toHaveBeenCalled();
      f.fault('DROP TRIGGER fail_stage');
      await f.cold();
      expect({
        challenges: f.sqlite
          .prepare('SELECT * FROM channel_pairing_challenges ORDER BY digest')
          .all(),
        bindings: f.sqlite
          .prepare('SELECT * FROM channel_account_bindings ORDER BY external_account_id')
          .all(),
      }).toEqual(before);
    }
  );
});
