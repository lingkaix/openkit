import { describe, expect, it, vi } from 'vitest';
import { createDiscordRestTransport } from './discord-rest.js';

const discordUserId = '223456789012345678';
const channelId = '323456789012345678';

/** Produces a private DM acknowledgement with an exact recipient. */
function dm() {
  return Response.json({ id: channelId, type: 1, recipients: [{ id: discordUserId }] });
}

describe('Discord REST private attention transport', () => {
  it('prepares a verified private DM and rechecks authority immediately before its link-only send', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(dm())
      .mockResolvedValueOnce(Response.json({ id: '423456789012345678', channel_id: channelId }));
    const beforeSend = vi.fn(() => true);
    const transport = createDiscordRestTransport({ publicBaseUrl: 'https://openkit.example', resolveBotToken: async () => 'fake-discord-bot-token', fetch });
    expect(await transport.sendAttention({ discordUserId, appPath: '/workspaces/ws/threads/th', beforeSend })).toEqual({ status: 'sent', externalMessageId: '423456789012345678' });
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://discord.com/api/v10/users/@me/channels');
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe(`https://discord.com/api/v10/channels/${channelId}/messages`);
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(init?.body as string)).toEqual({ content: 'OpenKit needs your attention: https://openkit.example/workspaces/ws/threads/th', allowed_mentions: { parse: [] }, flags: 4 });
    expect(fetch.mock.invocationCallOrder[1]).toBeGreaterThan(beforeSend.mock.invocationCallOrder[0]!);
  });

  it('refuses credential failure, wrong DM recipient, lost authority and a cross-origin link before message contact', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(dm());
    const transport = createDiscordRestTransport({ publicBaseUrl: 'https://openkit.example', resolveBotToken: async () => null, fetch });
    expect((await transport.sendAttention({ discordUserId, appPath: '/app', beforeSend: () => true })).status).toBe('failed-no-send');
    expect(fetch).not.toHaveBeenCalled();
    const ready = createDiscordRestTransport({ publicBaseUrl: 'https://openkit.example', resolveBotToken: async () => 'fake-token', fetch });
    expect((await ready.sendAttention({ discordUserId, appPath: '//attacker.example/', beforeSend: () => true })).status).toBe('failed-no-send');
    expect(fetch).not.toHaveBeenCalled();
    expect((await ready.sendAttention({ discordUserId, appPath: '/app', beforeSend: () => false })).status).toBe('failed-no-send');
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(Response.json({ id: channelId, type: 3, recipients: [{ id: discordUserId }] }));
    expect((await ready.sendAttention({ discordUserId, appPath: '/app', beforeSend: () => true })).status).toBe('failed-no-send');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['exception', 'server-error', 'malformed-ack'] as const)('preserves %s after message contact as unknown, with no retry or raw error', async (failure) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(dm());
    if (failure === 'exception') fetch.mockRejectedValueOnce(new Error('secret raw transport error'));
    if (failure === 'server-error') fetch.mockResolvedValueOnce(new Response('private upstream error', { status: 503 }));
    if (failure === 'malformed-ack') fetch.mockResolvedValueOnce(Response.json({ id: '423456789012345678', channel_id: 'wrong-channel' }));
    const transport = createDiscordRestTransport({ publicBaseUrl: 'https://openkit.example', resolveBotToken: async () => 'fake-token', fetch });
    const result = await transport.sendAttention({ discordUserId, appPath: '/app', beforeSend: () => true });
    expect(result.status).toBe('delivery-unknown');
    expect(JSON.stringify(result)).not.toMatch(/secret|private upstream|fake-token/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('distinguishes an explicit rejected message from an uncertain send', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(dm()).mockResolvedValueOnce(new Response('', { status: 403 }));
    const transport = createDiscordRestTransport({ publicBaseUrl: 'https://openkit.example', resolveBotToken: async () => 'fake-token', fetch });
    expect(await transport.sendAttention({ discordUserId, appPath: '/app', beforeSend: () => true })).toEqual({ status: 'failed-no-send', code: 'discord_message_rejected' });
  });
});
