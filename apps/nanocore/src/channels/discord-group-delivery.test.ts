import { describe, expect, it, vi } from 'vitest';
import { createDiscordGroupDelivery } from './discord-group-delivery.js';

const guildId = '123456789012345678';
const channelId = '223456789012345678';
const botUserId = '323456789012345678';
const messageId = '423456789012345678';
const content = 'Units: 8 (Published facts, as of 2026-11-01).\n@everyone https://example.com';
const channelUrl = `https://discord.com/api/v10/channels/${channelId}`;
const ack = { id: messageId, channel_id: channelId, author: { id: botUserId, bot: true }, content };

function fixture() {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(async () => Response.json({ id: botUserId, bot: true }))
    .mockImplementationOnce(async () =>
      Response.json({ id: channelId, guild_id: guildId, type: 0 })
    );
  const beforeSend = vi.fn(() => true);
  const stillCurrent = vi.fn(() => true);
  const transport = createDiscordGroupDelivery({ resolveBotToken: async () => 'fixture', fetch });
  const send = (changes = {}) =>
    transport.send({
      guildId,
      channelId,
      botUserId,
      content,
      beforeSend,
      stillCurrent,
      ...changes,
    });
  return { fetch, beforeSend, stillCurrent, send };
}

describe('Discord exact group publication transport', () => {
  it('verifies bot and bound guild text channel, then posts the exact plain text once', async () => {
    const { fetch, beforeSend, send } = fixture();
    fetch.mockResolvedValueOnce(Response.json(ack));
    expect(await send()).toEqual({ status: 'sent', externalMessageId: messageId });
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://discord.com/api/v10/users/@me', 'GET'],
      [channelUrl, 'GET'],
      [`${channelUrl}/messages`, 'POST'],
    ]);
    const init = fetch.mock.calls[2]?.[1];
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bot fixture');
    expect(JSON.parse(init?.body as string)).toEqual({
      content,
      allowed_mentions: { parse: [] },
      flags: 4,
    });
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(fetch.mock.invocationCallOrder[2]).toBeGreaterThan(
      beforeSend.mock.invocationCallOrder[0]!
    );
  });

  it.each([
    { botUserId: '999' },
    { guildId: '999' },
    { content: 'a'.repeat(2001) },
    { content: '界'.repeat(1366) },
    { content: '\uD800' },
  ])('does not post or claim on mismatched preparation or invalid content: %#', async (change) => {
    const { fetch, beforeSend, send } = fixture();
    expect((await send(change)).status).toBe('failed-no-send');
    expect(beforeSend).not.toHaveBeenCalled();
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('checks authority before each preparation request', async () => {
    for (const expectedGets of [0, 1]) {
      const { fetch, stillCurrent, send } = fixture();
      if (expectedGets) stillCurrent.mockReturnValueOnce(true);
      stillCurrent.mockReturnValue(false);
      expect((await send()).status).toBe('failed-no-send');
      expect(fetch).toHaveBeenCalledTimes(expectedGets);
    }
  });

  it('does not post after losing current authority or the shared claim', async () => {
    const { fetch, beforeSend, send } = fixture();
    beforeSend.mockReturnValue(false);
    expect((await send()).status).toBe('failed-no-send');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { channel_id: '999' },
    { id: 'invalid' },
    { id: '0' },
    { id: '001' },
    { id: '18446744073709551616' },
    { author: { id: '999', bot: true } },
    { content: `${content} ` },
  ])('does not treat an acknowledgement mismatch as sent: %#', async (change) => {
    const { fetch, send } = fixture();
    fetch.mockResolvedValueOnce(Response.json({ ...ack, ...change }));
    expect((await send()).status).toBe('delivery-unknown');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('classifies a lost reply as unknown without resending, and an explicit refusal as no-send', async () => {
    const lost = fixture();
    lost.fetch.mockRejectedValueOnce(new Error('fixture detail'));
    expect(await lost.send()).toEqual({
      status: 'delivery-unknown',
      code: 'discord_message_outcome_unknown',
    });
    expect(lost.fetch).toHaveBeenCalledTimes(3);
    const refused = fixture();
    refused.fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await refused.send()).status).toBe('failed-no-send');
    expect(refused.fetch).toHaveBeenCalledTimes(3);
  });
});
