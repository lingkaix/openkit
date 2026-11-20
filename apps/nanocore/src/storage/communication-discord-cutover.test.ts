import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocateEntityId, canonicalIdentifierName } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../auth/identity.js';
import type { DiscordPendingView, DiscordReply } from '../channels/discord-interaction.js';
import {
  type CommunicationDiscordChannelOptions,
  openCommunicationDiscordChannel,
} from '../channels/discord-owner.js';
import { OperationError } from '../operation-error-core.js';
import {
  type CommunicationDiscordWrites,
  createCommunicationDiscord,
  type WithPairingAuthority,
} from './communication-discord.js';
import type { ChannelInboundState } from './communication-port.js';
import {
  applyCommunicationWriterCommand,
  CommunicationWriterCommandSchema,
  type CommunicationWriterReply,
  CommunicationWriterReplySchema,
} from './communication-writer.js';
import type { ControlKernelStore } from './control-kernel-port.js';
import { configureOwnedSqlite } from './control-store.js';
import { commandInputHash } from './control-store-input.js';

const now = Date.parse('2026-11-20T10:00:00Z');
const deploymentId = 'dm-cutover-fixture';
const applicationId = '101';
const externalAccountId = '102';
const alice = allocateEntityId('usr');
const bob = allocateEntityId('usr');
const workspaceId = allocateEntityId('ws');
const threadId = allocateEntityId('th');
const turnId = allocateEntityId('tu');
const pendingRequestId = 'ap_exact_cutover';
const target = { workspace: workspaceId, thread: threadId, request: pendingRequestId };
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('hex');
const connections = new Set<Database.Database>();
const temporaryFolders: string[] = [];

function ready<T>(value: T) {
  return { state: 'ready' as const, value };
}

function text(reply: DiscordReply) {
  expect(reply.type).toBe(4);
  return reply.type === 4 ? reply.data.content : '';
}

function signedDm(id: string, command: string, args: Record<string, string> = {}, extra = {}) {
  const timestamp = String(Math.floor(now / 1000));
  const body = Buffer.from(
    JSON.stringify({
      id,
      application_id: applicationId,
      type: 2,
      version: 1,
      context: 1,
      channel: { id: '103', type: 1 },
      user: { id: externalAccountId },
      data: {
        id: '104',
        type: 1,
        name: 'openkit',
        options: [
          {
            name: command,
            type: 1,
            options: Object.entries(args).map(([name, value]) => ({ name, value, type: 3 })),
          },
        ],
      },
      ...extra,
    })
  );
  return {
    body,
    timestamp,
    signature: sign(null, Buffer.concat([Buffer.from(timestamp), body]), keys.privateKey).toString(
      'hex'
    ),
  };
}

function fixture(fixtureOptions: { readonly fileBacked?: boolean } = {}) {
  const folder = fixtureOptions.fileBacked
    ? mkdtempSync(join(tmpdir(), 'openkit-discord-dm-'))
    : null;
  if (folder) temporaryFolders.push(folder);
  const path = folder ? join(folder, 'state.sqlite') : ':memory:';
  const open = () => {
    const connection = new Database(path);
    connections.add(connection);
    configureOwnedSqlite(connection);
    return connection;
  };
  let sqlite = open();
  migrate(drizzle(sqlite), {
    migrationsFolder: fileURLToPath(
      new URL('../../drizzle/services/communication/', import.meta.url)
    ),
  });
  const active = new Set([alice, bob]);
  let clock = now;
  function apply<Stage extends CommunicationWriterReply['stage']>(
    stage: Stage,
    fields: object
  ): Extract<CommunicationWriterReply, { stage: Stage }> {
    const command = CommunicationWriterCommandSchema.parse({ stage, ...fields });
    const ack = CommunicationWriterReplySchema.parse(
      applyCommunicationWriterCommand(sqlite, deploymentId, command, () => clock)
    );
    if (ack.stage !== stage) throw new Error('Unexpected communication worker acknowledgement.');
    return ack as Extract<CommunicationWriterReply, { stage: Stage }>;
  }
  let localSettlementLost = false;
  let nextDecisionReceiptDigest: string | undefined;
  let beforeLocalSettlement: (() => void) | undefined;
  let refusalAckLost = false;
  const writer: CommunicationDiscordWrites = {
    stageEnvelope: async (envelope, externalAccountId) =>
      ready(apply('stage-envelope', { envelope, externalAccountId }).admission),
    revokeChallenges: async (userId, authority) => {
      apply('revoke-challenges', { input: { userId }, authority });
      return ready(undefined);
    },
    issueChallenge: async (input, authority) => {
      apply('issue-challenge', { input, authority });
      return ready(undefined);
    },
    pair: async (input, authority) => ready(apply('pair', { input, authority }).change),
    unbind: async (input, authority) => ready(apply('unbind', { input, authority }).change),
    writeDisclosure: async (input, authority) => {
      apply('write-disclosure', { input, authority });
      return ready(undefined);
    },
    claimOrigin: async (input) => ready(apply('claim-origin', { input }).claimed),
    settleInbound: async (input) => {
      if (localSettlementLost) {
        localSettlementLost = false;
        throw new Error('Local settlement acknowledgement lost.');
      }
      beforeLocalSettlement?.();
      apply('settle-origin', { input });
      return ready(undefined);
    },
    settleRefusal: async (input) => {
      apply('settle-refusal', { input });
      if (refusalAckLost) {
        refusalAckLost = false;
        throw new Error('Refusal acknowledgement lost after commit.');
      }
      return ready(undefined);
    },
  };
  const authoritySelections: Parameters<WithPairingAuthority>[0][] = [];
  const withAuthority: WithPairingAuthority = async (selection, post) => {
    authoritySelections.push(selection);
    expect(active.has(selection.userId)).toBe(true);
    return post({ userId: selection.userId, administratorAtEvent: false });
  };
  const createOwner = () =>
    createCommunicationDiscord({
      status: () => ({ state: 'ready', owner: 'communication' }),
      read: (run) => ready(run(sqlite)),
      writer,
      withAuthority,
      pairingAuditReady: () => {},
      now: () => clock,
    });
  let communication = createOwner();
  const events = new Map<string, ChannelInboundState>();
  let settleAckLost = false;
  let afterBind: (() => void | Promise<void>) | undefined;
  const kernel: CommunicationDiscordChannelOptions['kernel'] = {
    status: () => ({ state: 'ready', owner: 'control-kernel' }),
    reserveChannelInbound: vi.fn<ControlKernelStore['reserveChannelInbound']>(async (envelope) => {
      expect(
        sqlite
          .prepare(
            'SELECT external_account_id AS actor, origin_json AS origin FROM communication_intents WHERE request_id = ?'
          )
          .get(envelope.requestId)
      ).toEqual({ actor: externalAccountId, origin: null });
      if (events.has(envelope.occurrenceKey)) return ready({ state: 'inspect-original' });
      events.set(envelope.occurrenceKey, { state: 'reserved', envelope });
      return ready({ state: 'reserved-now' });
    }),
    inspectChannelInbound: async (key) =>
      ready(events.get(key.occurrenceKey) ?? { state: 'absent' }),
    bindChannelInboundOrigin: async (origin) => {
      if (events.get(origin.envelope.occurrenceKey)?.state !== 'reserved')
        return ready({ state: 'inspect-original' });
      events.set(origin.envelope.occurrenceKey, { state: 'origin-bound', origin });
      await afterBind?.();
      return ready({ state: 'bound-now' });
    },
    settleChannelInbound: async (intent, result) => {
      const previous = events.get(intent.occurrenceKey);
      if (previous?.state === 'settled')
        return ready({ state: 'settled', receipt: previous.receipt });
      if (!previous || (previous.state !== 'reserved' && previous.state !== 'origin-bound'))
        return ready({ state: 'unknown' });
      if (settleAckLost) {
        settleAckLost = false;
        throw new Error('ACK lost before kernel settlement was observed.');
      }
      const facts = { intent, disposition: 'applied', result } as const;
      const receipt = {
        ...facts,
        receiptDigest: `sha256:${sha256Hex(
          canonicalIdentifierName(['openkit:storage-receipt:v1', facts])
        )}`,
      };
      events.set(intent.occurrenceKey, {
        state: 'settled',
        origin: previous.state === 'origin-bound' ? previous.origin : null,
        receipt,
      });
      if (result.kind === 'pending-decision' && nextDecisionReceiptDigest) {
        const receiptDigest = nextDecisionReceiptDigest;
        nextDecisionReceiptDigest = undefined;
        return ready({ state: 'settled', receipt: { ...receipt, receiptDigest } });
      }
      return ready({ state: 'settled', receipt });
    },
  };
  const decisions = new Map<string, { inputHash: string; decisionRef: string }>();
  function storeDecision(value: unknown) {
    const { requestId } = value as { requestId: string };
    const inputHash = commandInputHash(value);
    decisions.set(requestId, {
      inputHash,
      decisionRef: sha256Hex(`decision:${requestId}:${inputHash}`),
    });
  }
  const invoke = vi.fn<CommunicationDiscordChannelOptions['invoke']>(async (_id, value) => {
    storeDecision(value);
    return { status: 'resolved' };
  });
  let pending: DiscordPendingView = {
    status: 'available',
    kind: 'approval',
    workspaceId,
    threadId,
    turnId,
    pendingRequestId,
    content: 'Exact effect',
    responseAllowed: true,
  };
  const inspectPending = vi.fn(() => pending);
  const inspectPendingDecision = vi.fn<
    CommunicationDiscordChannelOptions['inspectPendingDecision']
  >((origin, inputHash) => {
    const decision = decisions.get(origin.envelope.requestId);
    return decision?.inputHash === inputHash ? decision.decisionRef : null;
  });
  const options: CommunicationDiscordChannelOptions = {
    storage: communication.storage,
    deploymentId,
    kernel,
    applicationId,
    publicKey,
    appBaseUrl: 'https://openkit.invalid',
    requestLink: () => 'https://openkit.invalid/request',
    now: () => clock,
    resolveActor: (userId) => (active.has(userId) ? { kind: 'session', userId } : null),
    inspectPending,
    inspectPendingDecision,
    invoke,
  };
  function openChannel(storage = communication.storage) {
    const result = openCommunicationDiscordChannel({ ...options, storage });
    if (result.state !== 'ready') throw new Error('Expected admitted communication owners.');
    return result.value;
  }
  let channel = openChannel();
  const user = (userId: string): Actor => ({ userId, kind: 'session' });

  async function pair(userId: string, eventId: string) {
    const { challenge } = await channel.beginPairing(user(userId));
    return await channel.handleSignedInteraction(signedDm(eventId, 'pair', { challenge }));
  }

  async function disclose(eventId: string) {
    return (
      text(await channel.handleSignedInteraction(signedDm(eventId, 'inspect', target))).match(
        /Disclosure: ([A-Za-z0-9_-]+)/
      )?.[1] ?? ''
    );
  }

  return {
    get sqlite() {
      return sqlite;
    },
    kernel,
    options,
    invoke,
    active,
    authoritySelections,
    events,
    pair,
    disclose,
    beginPairing: (userId: string) => channel.beginPairing(user(userId)),
    revoke: (userId: string) => channel.revoke(user(userId)),
    inspectPending,
    inspectPendingDecision,
    storeDecision,
    beforeLocalSettlement: (hook: (() => void) | undefined) => {
      beforeLocalSettlement = hook;
    },
    loseRefusalAck: () => {
      refusalAckLost = true;
    },
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    pending: (overrides: Partial<Extract<DiscordPendingView, { status: 'available' }>>) => {
      if (pending.status === 'available') pending = { ...pending, ...overrides };
    },
    loseLocalSettlement: () => {
      localSettlementLost = true;
    },
    loseSettlementAck: () => {
      settleAckLost = true;
    },
    replaceNextDecisionReceiptDigest: (digest: string) => {
      nextDecisionReceiptDigest = digest;
    },
    afterBind: (callback: () => void | Promise<void>) => {
      afterBind = callback;
    },
    unbind: async (userId: string) => {
      const actor = user(userId);
      const binding = channel.binding(actor)!;
      return communication.unbindCredential({ actor, bindingRevision: binding.revision });
    },
    restart: () => {
      if (folder) {
        sqlite.close();
        connections.delete(sqlite);
        sqlite = open();
      }
      communication = createOwner();
      channel = openChannel();
    },
    send: (message: ReturnType<typeof signedDm>) => channel.handleSignedInteraction(message),
  };
}

afterEach(() => {
  for (const sqlite of connections) sqlite.close();
  connections.clear();
  for (const folder of temporaryFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('communication owner Discord DM cutover', () => {
  it('requires both admitted owner adapters before exposing the Discord handler', () => {
    const f = fixture();
    const { storage, kernel, ...transport } = f.options;
    const communicationStatus = vi.spyOn(storage, 'status');
    const kernelStatus = vi.spyOn(kernel, 'status');
    expect(openCommunicationDiscordChannel({ ...transport, kernel })).toEqual({
      state: 'unavailable',
      owner: 'communication',
      reason: 'missing',
    });
    expect(openCommunicationDiscordChannel({ ...transport, storage })).toEqual({
      state: 'unavailable',
      owner: 'control-kernel',
      reason: 'missing',
    });
    expect(communicationStatus).not.toHaveBeenCalled();
    expect(kernelStatus).not.toHaveBeenCalled();

    communicationStatus.mockReturnValueOnce({
      state: 'unavailable',
      owner: 'communication',
      reason: 'corrupt',
    });
    expect(openCommunicationDiscordChannel(f.options)).toMatchObject({
      state: 'unavailable',
      owner: 'communication',
      reason: 'corrupt',
    });
    kernelStatus.mockReturnValueOnce({
      state: 'unavailable',
      owner: 'control-kernel',
      reason: 'recovery-required',
    });
    expect(openCommunicationDiscordChannel(f.options)).toMatchObject({
      state: 'unavailable',
      owner: 'control-kernel',
      reason: 'recovery-required',
    });
    expect(openCommunicationDiscordChannel(f.options)).toMatchObject({ state: 'ready' });
    expect(f.kernel.reserveChannelInbound).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.sqlite.prepare('SELECT count(*) FROM communication_intents').pluck().get()).toBe(0);
  });
  it('reserves a first pair with no binding or disclosure and conflicts across signed principals', async () => {
    const f = fixture();
    expect(text(await f.pair(alice, '201'))).toContain('account paired');
    expect(
      f.sqlite
        .prepare(
          'SELECT kind, external_account_id AS actor FROM communication_intents ORDER BY sequence'
        )
        .all()
    ).toEqual([
      { kind: 'channel.inbound', actor: externalAccountId },
      { kind: 'relay-pairing-audit', actor: null },
    ]);
    const [original] = f.events.values();
    expect(original).toMatchObject({ state: 'settled', origin: null });
    expect(
      text(
        await f.send(
          signedDm(
            '201',
            'pair',
            { challenge: 'different' },
            {
              user: { id: '105' },
            }
          )
        )
      )
    ).toContain('identity conflict');
    expect(f.sqlite.prepare('SELECT count(*) FROM channel_account_bindings').pluck().get()).toBe(1);
  });

  it('revokes an outstanding challenge through the adapter without a binding', async () => {
    const f = fixture();
    const { challenge } = await f.beginPairing(alice);
    await f.revoke(alice);
    const selection = { userId: alice, actor: { kind: 'session', userId: alice } };
    expect(f.authoritySelections).toEqual([selection, selection]);
    expect(text(await f.send(signedDm('201', 'pair', { challenge })))).toContain(
      'Pairing challenge unavailable'
    );
    expect(f.sqlite.prepare('SELECT count(*) FROM channel_account_bindings').pluck().get()).toBe(0);
    expect(f.sqlite.prepare('SELECT count(*) FROM channel_pairing_challenges').pluck().get()).toBe(
      1
    );
  });

  it('settles an unbound DM refusal and replays the identical private response after cold reopen', async () => {
    const f = fixture({ fileBacked: true });
    const refused = signedDm('201', 'deny', { ...target, disclosure: 'fixture' });
    const original = text(await f.send(refused));
    expect(original).toContain('channel_binding_unavailable');
    expect([...f.events.values()]).toMatchObject([
      { state: 'settled', origin: null, receipt: { result: { kind: 'handled' } } },
    ]);
    f.restart();
    await f.pair(alice, '202');
    expect(text(await f.send(refused))).toBe(original);
    expect(
      f.sqlite
        .prepare(
          'SELECT external_account_id AS actor, origin_json AS origin FROM communication_intents ORDER BY sequence LIMIT 1'
        )
        .get()
    ).toEqual({ actor: externalAccountId, origin: null });
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it.each(['local refusal', 'kernel settlement'])(
    'finishes a cold refusal after lost %s ACK',
    async (ack) => {
      const f = fixture({ fileBacked: true });
      const refused = signedDm('201', 'deny', { ...target, disclosure: 'fixture' });
      if (ack === 'local refusal') f.loseRefusalAck();
      else f.loseSettlementAck();
      expect(text(await f.send(refused))).toContain('outcome is unknown');
      expect([...f.events.values()]).toMatchObject([{ state: 'reserved' }]);
      f.restart();
      expect(text(await f.send(refused))).toContain('channel_binding_unavailable');
      expect([...f.events.values()]).toMatchObject([{ state: 'settled' }]);
      expect(f.invoke).not.toHaveBeenCalled();
    }
  );

  it('recovers after an ACK loss and cold reopen without invoking again after unbind and re-pair', async () => {
    const f = fixture({ fileBacked: true });
    await f.pair(alice, '201');
    const disclosure = await f.disclose('202');
    expect(disclosure).toBeTruthy();
    const original = signedDm('203', 'deny', { ...target, disclosure });
    f.loseSettlementAck();
    expect(text(await f.send(original))).toContain('outcome is unknown');
    expect(f.invoke).toHaveBeenCalledTimes(1);
    f.restart();
    expect(text(await f.send(original))).toContain('already handled');
    await f.unbind(alice);
    expect(text(await f.pair(bob, '204'))).toContain('account paired');
    expect(text(await f.send(original))).toContain('already handled');
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(
      [...f.events.values()].find((event) => event.state === 'settled' && event.origin)
    ).toMatchObject({ origin: { userId: alice } });
  });

  it('completes local settlement from the already-applied kernel receipt on replay', async () => {
    const f = fixture();
    await f.pair(alice, '201');
    const disclosure = await f.disclose('202');
    const original = signedDm('203', 'deny', { ...target, disclosure });
    const receiptDigest = () =>
      f.sqlite
        .prepare('SELECT receipt_digest FROM communication_intents WHERE origin_json IS NOT NULL')
        .pluck()
        .get();

    f.loseLocalSettlement();
    expect(text(await f.send(original))).toContain('outcome is unknown');
    expect(receiptDigest()).toBeNull();
    f.restart();
    expect(text(await f.send(original))).toContain('already handled');
    expect(receiptDigest()).toEqual(expect.any(String));
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'changed'] as const)(
    'keeps a settled kernel receipt pending when the local origin is %s',
    async (change) => {
      const f = fixture({ fileBacked: true });
      await f.pair(alice, '201');
      const disclosure = await f.disclose('202');
      const original = signedDm('203', 'deny', { ...target, disclosure });
      f.loseLocalSettlement();
      expect(text(await f.send(original))).toContain('outcome is unknown');
      const event = [...f.events.values()].find(
        (value) => value.state === 'settled' && value.origin
      );
      if (event?.state !== 'settled' || !event.origin) throw new Error('Expected a kernel origin.');
      const { requestId } = event.origin.envelope;
      const update = (origin: object | null) =>
        f.sqlite
          .prepare('UPDATE communication_intents SET origin_json = ? WHERE request_id = ?')
          .run(origin === null ? null : JSON.stringify(origin), requestId);
      const storedOrigin = f.sqlite
        .prepare('SELECT origin_json FROM communication_intents WHERE request_id = ?')
        .pluck()
        .get(requestId) as string;
      update(change === 'missing' ? null : { ...event.origin, turnId: allocateEntityId('tu') });
      f.restart();
      expect(text(await f.send(original))).toContain('outcome is unknown');
      expect(
        f.sqlite
          .prepare('SELECT receipt_digest FROM communication_intents WHERE request_id = ?')
          .pluck()
          .get(requestId)
      ).toBeNull();
      f.sqlite
        .prepare('UPDATE communication_intents SET origin_json = ? WHERE request_id = ?')
        .run(storedOrigin, requestId);
      expect(text(await f.send(original))).toContain('already handled');
      expect(f.invoke).toHaveBeenCalledTimes(1);
    }
  );

  it('compares the full origin again inside the local settlement transaction', async () => {
    const f = fixture();
    await f.pair(alice, '201');
    const disclosure = await f.disclose('202');
    const original = signedDm('203', 'deny', { ...target, disclosure });
    const restore = vi.fn();
    f.beforeLocalSettlement(() => {
      const stored = f.sqlite
        .prepare(
          'SELECT request_id, origin_json FROM communication_intents WHERE origin_json IS NOT NULL'
        )
        .get() as { request_id: string; origin_json: string };
      const update = f.sqlite.prepare(
        'UPDATE communication_intents SET origin_json = ? WHERE request_id = ?'
      );
      update.run(
        JSON.stringify({ ...JSON.parse(stored.origin_json), turnId: allocateEntityId('tu') }),
        stored.request_id
      );
      restore.mockImplementation(() => update.run(stored.origin_json, stored.request_id));
    });
    expect(text(await f.send(original))).toContain('outcome is unknown');
    expect(
      f.sqlite
        .prepare('SELECT receipt_digest FROM communication_intents WHERE origin_json IS NOT NULL')
        .pluck()
        .get()
    ).toBeNull();
    f.beforeLocalSettlement(undefined);
    restore();
    expect(text(await f.send(original))).toContain('already handled');
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it('refuses a definite native idempotency conflict without inspecting a competing receipt', async () => {
    const f = fixture({ fileBacked: true });
    await f.pair(alice, '201');
    f.pending({ kind: 'user-input', content: 'Choose a color' });
    const disclosure = await f.disclose('202');
    const original = signedDm('203', 'answer', {
      ...target,
      disclosure,
      answers: JSON.stringify({ color: ['blue'] }),
    });
    f.inspectPendingDecision.mockReturnValue(sha256Hex('competing receipt'));
    f.invoke.mockRejectedValueOnce(
      new OperationError('idempotency_key_conflict', 'Different input', 409)
    );
    const refusal = text(await f.send(original));
    expect(refusal).toContain('idempotency_key_conflict');
    f.restart();
    expect(text(await f.send(original))).toBe(refusal);
    expect(f.inspectPendingDecision).not.toHaveBeenCalled();
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it('does not accept a different native answer under the original request ID on first settlement', async () => {
    const f = fixture();
    await f.pair(alice, '201');
    f.pending({ kind: 'user-input', content: 'Choose a color' });
    const disclosure = await f.disclose('202');
    f.invoke.mockImplementationOnce(async (_operation, input) => {
      f.storeDecision({ ...(input as object), answers: { color: ['green'] } });
    });
    const original = signedDm('203', 'answer', {
      ...target,
      disclosure,
      answers: JSON.stringify({ color: ['blue'] }),
    });
    expect(text(await f.send(original))).toContain('outcome is unknown');
    expect([...f.events.values()]).toContainEqual(
      expect.objectContaining({ state: 'origin-bound' })
    );
    expect(
      f.sqlite
        .prepare('SELECT receipt_digest FROM communication_intents WHERE origin_json IS NOT NULL')
        .pluck()
        .get()
    ).toBeNull();
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['origin-bound', 'settled'] as const)(
    'requires the original Workspace input hash after recovery of a %s event',
    async (stage) => {
      const f = fixture({ fileBacked: true });
      await f.pair(alice, '201');
      f.pending({ kind: 'user-input', content: 'Choose a color' });
      const disclosure = await f.disclose('202');
      const original = signedDm('203', 'answer', {
        ...target,
        disclosure,
        answers: JSON.stringify({ color: ['blue'] }),
      });
      if (stage === 'origin-bound') f.loseSettlementAck();
      else f.loseLocalSettlement();
      expect(text(await f.send(original))).toContain('outcome is unknown');
      const command = f.invoke.mock.calls[0]?.[1] as { requestId: string };
      const origin = () =>
        f.sqlite
          .prepare(
            'SELECT native_input_hash, receipt_digest FROM communication_intents WHERE request_id = ?'
          )
          .get(command.requestId);
      expect(origin()).toEqual({
        native_input_hash: commandInputHash(command),
        receipt_digest: null,
      });
      f.storeDecision({ ...command, answers: { color: ['green'] } });
      f.restart();
      expect(text(await f.send(original))).toContain('outcome is unknown');
      expect(origin()).toEqual({
        native_input_hash: commandInputHash(command),
        receipt_digest: null,
      });
      f.storeDecision(command);
      expect(text(await f.send(original))).toContain('already handled');
      expect(f.invoke).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps a decision pending locally when another event supplies its digest', async () => {
    const f = fixture();
    await f.pair(alice, '201');
    const disclosure = await f.disclose('202');
    const prior = [...f.events.values()].find((event) => event.state === 'settled');
    if (prior?.state !== 'settled') throw new Error('Expected a prior receipt.');
    f.replaceNextDecisionReceiptDigest(prior.receipt.receiptDigest);
    const input = signedDm('203', 'deny', { ...target, disclosure });
    const receiptDigest = () =>
      f.sqlite
        .prepare('SELECT receipt_digest FROM communication_intents WHERE origin_json IS NOT NULL')
        .pluck()
        .get();

    expect(text(await f.send(input))).toContain('outcome is unknown');
    expect(receiptDigest()).toBeNull();
    expect(text(await f.send(input))).toContain('already handled');
    expect(receiptDigest()).toMatch(/^sha256:/);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it('does not turn absent kernel evidence into a second reservation after a lost ACK', async () => {
    const f = fixture();
    await f.pair(alice, '201');
    const disclosure = await f.disclose('202');
    const original = signedDm('203', 'deny', { ...target, disclosure });
    vi.mocked(f.kernel.reserveChannelInbound).mockRejectedValueOnce(
      new Error('Reservation ACK lost')
    );
    expect(text(await f.send(original))).toContain('outcome is unknown');
    expect(f.kernel.reserveChannelInbound).toHaveBeenCalledTimes(3);
    f.restart();
    expect(text(await f.send(original))).toContain('outcome is unknown');
    expect(f.kernel.reserveChannelInbound).toHaveBeenCalledTimes(3);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('keeps an uncommitted local origin from invoking or replaying the effect', async () => {
    const f = fixture();
    await f.pair(alice, '201');
    const disclosure = await f.disclose('202');
    f.sqlite.exec(
      "CREATE TRIGGER reject_origin BEFORE UPDATE OF origin_json ON communication_intents BEGIN SELECT RAISE(ABORT, 'origin unavailable'); END"
    );
    const original = signedDm('203', 'deny', { ...target, disclosure });
    expect(text(await f.send(original))).toContain('outcome is unknown');
    f.sqlite.exec('DROP TRIGGER reject_origin');
    expect(text(await f.send(original))).toContain('outcome is unknown');
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('holds the binding admission through the final ACK and lets a later unbind revoke it', async () => {
    const f = fixture();
    await f.pair(alice, '201');
    const disclosure = await f.disclose('202');
    const bound = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.afterBind(() => {
      bound.resolve();
      return release.promise;
    });
    const input = signedDm('203', 'deny', { ...target, disclosure });
    const original = f.send(input);
    await bound.promise;
    try {
      await expect(f.unbind(alice)).rejects.toMatchObject({ code: 'channel_storage_busy' });
      expect(f.invoke).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    expect(text(await original)).toContain('accepted the response');
    await expect(f.unbind(alice)).resolves.toMatchObject({ state: 'ready' });
    expect(text(await f.send(signedDm('204', 'deny', { ...target, disclosure })))).toContain(
      'binding'
    );
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it('rechecks disclosure expiry after the origin acknowledgement and invokes nothing', async () => {
    const f = fixture();
    await f.pair(alice, '201');
    const disclosure = await f.disclose('202');
    f.afterBind(() => f.advance(300_000));
    expect(text(await f.send(signedDm('203', 'deny', { ...target, disclosure })))).toContain(
      'channel_disclosure_unavailable'
    );
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('keeps approval grants App-only and refuses a changed disclosed effect', async () => {
    const f = fixture();
    await f.pair(alice, '201');
    expect(text(await f.send(signedDm('202', 'approve', target)))).toContain(
      'complete App confirmation'
    );
    expect(f.inspectPending).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();

    const disclosure = await f.disclose('203');
    f.pending({ content: 'Changed exact effect' });
    expect(text(await f.send(signedDm('204', 'deny', { ...target, disclosure })))).toContain(
      'channel_disclosure_changed'
    );
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('commits exact native answer origin and retains neither the disclosure token nor answer bytes', async () => {
    const f = fixture();
    await f.pair(alice, '201');
    f.pending({ kind: 'user-input', content: 'Choose a color' });
    const disclosure = await f.disclose('202');
    const event = signedDm('203', 'answer', {
      ...target,
      disclosure,
      answers: JSON.stringify({ color: ['unique-fixture-color'] }),
    });
    expect(text(await f.send(event))).toContain('accepted the response');
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith(
      'question.answer',
      expect.objectContaining({
        workspaceId,
        threadId,
        userInputRequestId: pendingRequestId,
        answers: { color: ['unique-fixture-color'] },
      }),
      { userId: alice, kind: 'session' }
    );
    const { origin_json: originJson, native_input_hash: inputHash } = f.sqlite
      .prepare(
        'SELECT origin_json, native_input_hash FROM communication_intents WHERE origin_json IS NOT NULL'
      )
      .get() as { origin_json: string; native_input_hash: string };
    expect(inputHash).toBe(commandInputHash(f.invoke.mock.calls[0]?.[1]));
    expect(JSON.parse(originJson)).toMatchObject({
      operation: 'question.answer',
      userId: alice,
      workspaceId,
      threadId,
      turnId,
      pendingRequestId,
    });
    expect(originJson).not.toContain(disclosure);
    expect(originJson).not.toContain('unique-fixture-color');

    f.pending({ responseAllowed: false, content: 'Protected secret question' });
    expect(text(await f.send(signedDm('204', 'inspect', target)))).not.toContain(
      'Protected secret'
    );
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it('rechecks authority after origin ACK and refuses guild or general Turn admission before reservation', async () => {
    const f = fixture();
    const guild = await f.send(signedDm('200', 'inspect', target, { context: 0, guild_id: '301' }));
    expect(text(guild)).toContain('private DM');
    const generalTurn = await f.send(
      signedDm('205', 'turn', { workspace: workspaceId, text: 'Fixture message' })
    );
    expect(text(generalTurn)).toContain('Unsupported input');
    expect(f.kernel.reserveChannelInbound).not.toHaveBeenCalled();
    expect(f.sqlite.prepare('SELECT count(*) FROM communication_intents').pluck().get()).toBe(0);

    await f.pair(alice, '201');
    const disclosure = await f.disclose('202');
    f.afterBind(() => f.active.delete(alice));
    expect(text(await f.send(signedDm('203', 'deny', { ...target, disclosure })))).toContain(
      'channel_authority_unavailable'
    );
    expect(f.invoke).not.toHaveBeenCalled();
  });
});
