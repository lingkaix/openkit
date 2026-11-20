import { sha256Hex } from '@openkit/protocol/digest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isFreshDiscordGroupMention, selectDiscordGroupMention } from './discord-group-mention.js';
import { startDiscordGuildGateway } from './discord-guild-gateway.js';

const binding = { guildId: '123', channelId: '234', botUserId: '345' };
const message = {
  id: '456',
  guild_id: binding.guildId,
  channel_id: binding.channelId,
  type: 0,
  author: { id: '567' },
  mentions: [{ id: binding.botUserId }],
  content: '<@345> What was the latest total? ',
  timestamp: '2026-11-20T03:50:00.000+00:00',
};
const reply = { message_id: '789', channel_id: binding.channelId, type: 0 };

const select = (event: unknown) => selectDiscordGroupMention(event, binding.botUserId, binding);

describe('Reports mention projection', () => {
  it.each([
    { guild_id: '888' },
    { channel_id: '888' },
    { content: 'Do not store me' },
    { mentions: [] },
    { type: 19, message_reference: reply, content: 'Reply ping without an explicit mention' },
    { webhook_id: '999' },
    { message_snapshots: [] },
    { type: 19, message_reference: { ...reply, type: 1 } },
    { type: 19, message_reference: { ...reply, channel_id: '888' } },
    { type: 6 },
    { author: { id: '567', bot: true } },
    { author: { id: '567', system: true } },
    { content: '<@345> <@345> one too many' },
    { content: '<@345> <@888> one too many' },
  ])('drops ineligible content before native admission: %#', (change) => {
    expect(select({ ...message, ...change })).toBeNull();
  });

  it('ignores attachments and display metadata; binds exact text, author and route to the independent key', () => {
    const admitted = select(message)!;
    expect(admitted.requestId).toBe('["guild-mention","123","234","456"]');
    expect(admitted.content).toBe(message.content);
    expect(
      select({
        ...message,
        attachments: [{ content: 'excluded' }],
        author: { ...message.author, display_name: 'ignored' },
      })
    ).toEqual(admitted);
    const changed = select({ ...message, content: message.content.trim() })!;
    expect(changed.requestId).toBe(admitted.requestId);
    expect(changed.inputHash).not.toBe(admitted.inputHash);
    expect(select({ ...message, author: { id: '888' } })?.inputHash).not.toBe(admitted.inputHash);
    expect(select({ ...message, type: 19, message_reference: reply })?.inputHash).not.toBe(
      admitted.inputHash
    );
    expect(selectDiscordGroupMention(message, '888', binding)).toBeNull();
    expect(isFreshDiscordGroupMention(admitted, admitted.postedAt + 300_000)).toBe(true);
    expect(isFreshDiscordGroupMention(admitted, admitted.postedAt + 300_001)).toBe(false);
  });
});

class FixtureSocket extends EventTarget {
  readonly send = vi.fn<(raw: string) => void>();
  readonly close = vi.fn<(code: number) => void>();

  packet(payload: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }

  get sent() {
    return this.send.mock.calls.map(([raw]) => JSON.parse(raw));
  }
}

function fixture() {
  vi.useFakeTimers();
  const sockets: FixtureSocket[] = [];
  const connect = vi.fn((_url: string) => {
    const socket = new FixtureSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const readBinding = vi.fn(() => binding);
  const onMention = vi.fn(async () => {});
  const onFault = vi.fn();
  const stop = startDiscordGuildGateway({
    botUserId: binding.botUserId,
    resolveBotToken: async () => 'fixture',
    connect,
    readBinding,
    onMention,
    onFault,
  });
  return { sockets, connect, readBinding, onMention, onFault, stop };
}

const hello = { op: 10, d: { heartbeat_interval: 60_000 } };
const ready = {
  op: 0,
  t: 'READY',
  s: 4,
  d: {
    user: { id: binding.botUserId, bot: true },
    session_id: 'session',
    resume_gateway_url: 'wss://gateway-fixture.discord.gg',
  },
};
const dispatch = (s: number, d: unknown = message) => ({ op: 0, t: 'MESSAGE_CREATE', s, d });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Reports Discord Gateway', () => {
  it('preserves exact question bytes and the sub-millisecond Discord instant', () => {
    const instant = selectDiscordGroupMention(
      { ...message, timestamp: '2026-11-20T01:00:00.0001230+01:00' },
      binding.botUserId,
      binding
    );
    const next = selectDiscordGroupMention(
      { ...message, timestamp: '2026-11-20T00:00:00.000124Z' },
      binding.botUserId,
      binding
    );
    expect(instant?.postedAtExact).toBe('2026-11-20T00:00:00.000123Z');
    expect(next?.postedAtExact).toBe('2026-11-20T00:00:00.000124Z');
    expect(instant?.postedAt).toBe(next?.postedAt);
    expect(instant?.questionDigest).toBe(sha256Hex(message.content));
  });
  it('reconnects after IDENTIFY if READY never arrives', async () => {
    const { sockets, stop } = fixture();
    await Promise.resolve();
    sockets[0]!.packet(hello);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(sockets).toHaveLength(2);
    stop();
  });

  it('does not resume past a pending durable handoff even if a later message finishes', async () => {
    const { sockets, stop, onMention } = fixture();
    let finish!: () => void;
    onMention.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    await Promise.resolve();
    const first = sockets[0]!;
    first.packet(hello);
    first.packet(ready);
    first.packet(dispatch(5));
    first.packet(dispatch(6, { ...message, id: '789' }));
    await Promise.resolve();
    first.packet({ op: 7 });
    await vi.advanceTimersByTimeAsync(1000);
    sockets[1]!.packet(hello);
    expect(sockets[1]!.sent[0]).toMatchObject({ op: 6, d: { seq: 4 } });
    finish();
    stop();
  });
  it('identifies without privileged intents, ignores unsolicited traffic, and resumes with the same receipt identity', async () => {
    const { sockets, connect, onMention, onFault, stop } = fixture();
    await Promise.resolve();
    const first = sockets[0]!;
    first.packet(hello);
    expect(first.sent[0]).toMatchObject({ op: 2, d: { token: 'fixture', intents: 513 } });
    first.packet(dispatch(3));
    expect(onMention).not.toHaveBeenCalled();
    first.packet(ready);
    first.packet(dispatch(5, { ...message, content: 'drop before ingress' }));
    expect(onMention).not.toHaveBeenCalled();
    first.packet(dispatch(6));
    await Promise.resolve();
    first.packet({ op: 7 });
    first.packet(dispatch(7));
    expect(first.close).toHaveBeenCalledWith(4000);
    expect(onMention).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenLastCalledWith(
      'wss://gateway-fixture.discord.gg/?v=10&encoding=json'
    );
    const second = sockets[1]!;
    second.packet(hello);
    expect(second.sent[0]).toEqual({
      op: 6,
      d: { token: 'fixture', session_id: 'session', seq: 6 },
    });
    second.packet(dispatch(7));
    expect(onMention).toHaveBeenLastCalledWith(select(message));
    expect(onMention).toHaveBeenCalledTimes(2);
    expect(onFault).not.toHaveBeenCalled();
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('never admits a message on a connection authenticated as another bot', async () => {
    const { sockets, onMention, onFault } = fixture();
    await Promise.resolve();
    const socket = sockets[0]!;
    socket.packet(hello);
    socket.packet({ ...ready, d: { ...ready.d, user: { id: '888', bot: true } } });
    socket.packet(dispatch(5));
    expect(onMention).not.toHaveBeenCalled();
    expect(onFault).toHaveBeenCalledExactlyOnceWith('gateway-rejected');
    expect(socket.close).toHaveBeenCalledWith(1000);
  });

  it('abandons a missed heartbeat and identifies again if Discord invalidates the session', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { sockets, stop } = fixture();
    await Promise.resolve();
    sockets[0]!.packet(hello);
    sockets[0]!.packet(ready);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.sent.at(-1)).toEqual({ op: 1, d: 4 });
    await vi.advanceTimersByTimeAsync(61_000);
    sockets[1]!.packet(hello);
    expect(sockets[1]!.sent[0]).toMatchObject({ op: 6 });
    sockets[1]!.packet({ op: 9, d: false });
    await vi.advanceTimersByTimeAsync(2000);
    sockets[2]!.packet(hello);
    expect(sockets[2]!.sent[0]).toMatchObject({ op: 2 });
    stop();
  });
});
