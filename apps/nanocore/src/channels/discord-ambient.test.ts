import { describe, expect, it, vi } from 'vitest';
import { createDiscordAmbientReader } from './discord-ambient.js';

const postedAt = Date.parse('2026-11-20T04:00:00Z');
const route = { guildId: '123', channelId: '234', botUserId: '345', mentionId: '900', postedAt };
const sample = {
  id: '600',
  channel_id: route.channelId,
  author: { id: '777', username: 'ignored' },
  type: 0,
  content: 'Untrusted quoted text',
  timestamp: new Date(postedAt - 300_000).toISOString(),
};

function fixture(count: number | undefined, history: unknown = []) {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ id: route.guildId, approximate_member_count: count }))
    .mockResolvedValueOnce(history instanceof Response ? history : Response.json(history));
  const read = createDiscordAmbientReader({
    resolveVerifiedBotToken: async () => 'fixture',
    fetch,
    now: () => postedAt + 120,
  });
  const current = vi.fn(() => true);
  const run = () =>
    read({
      ...route,
      limits: { small: 100, medium: 30 },
      excludedMessageIds: new Set(['890']),
      current,
    });
  return { fetch, current, run };
}

describe('Reports bounded ambient history', () => {
  it.each([
    [20, 100],
    [21, 30],
    [100, 30],
    [101, 0],
    [undefined, 0],
  ] as const)('uses count %s for one bounded request with limit %s', async (count, limit) => {
    const { fetch, run } = fixture(count);
    const result = await run();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://discord.com/api/v10/guilds/123?with_counts=true',
      ...(limit
        ? [`https://discord.com/api/v10/channels/234/messages?before=900&limit=${limit}`]
        : []),
    ]);
    expect(result.state).toBe(limit ? 'selected' : 'unavailable');
  });

  it('returns chronological human text only, with inclusive lower time and numeric same-time ID order', async () => {
    const keptLaterId = {
      ...sample,
      id: '601',
      content: 'Another quote',
      edited_timestamp: new Date(postedAt).toISOString(),
    };
    const { fetch, run } = fixture(20, [
      { ...sample, id: '890', content: 'Excluded: already in quote' },
      { ...sample, id: '900', content: 'Excluded: mention itself' },
      { ...sample, id: '899', timestamp: new Date(postedAt + 1).toISOString() },
      { ...sample, id: '602', timestamp: new Date(postedAt - 300_001).toISOString() },
      { ...sample, id: '603', channel_id: '999' },
      { ...sample, id: '604', author: { id: route.botUserId, bot: true } },
      { ...sample, id: '605', webhook_id: '678' },
      { ...sample, id: '606', message_reference: { type: 1 } },
      { ...sample, id: '607', content: '界'.repeat(3000) },
      { ...sample, id: '608', content: '' },
      { ...sample, id: '609', type: 7 },
      keptLaterId,
      { ...sample, attachments: [{ filename: 'discarded' }], embeds: [{ title: 'discarded' }] },
      sample,
    ]);
    expect(await run()).toEqual({
      state: 'selected',
      approximateMemberCount: 20,
      countObservedAt: postedAt + 120,
      windowStart: postedAt - 300_000,
      messages: [
        {
          messageId: '600',
          discordAuthorId: '777',
          postedAt: postedAt - 300_000,
          editedAt: null,
          text: sample.content,
        },
        {
          messageId: '601',
          discordAuthorId: '777',
          postedAt: postedAt - 300_000,
          editedAt: new Date(postedAt).toISOString().replace('.000Z', 'Z'),
          text: keptLaterId.content,
        },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([403, 429])('records history refusal %s as unavailable without retry', async (status) => {
    const { fetch, run } = fixture(20, new Response('fixture body', { status }));
    expect(await run()).toEqual({ state: 'unavailable' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('checks current disclosure and access before contact, after count and after history', async () => {
    for (const allowed of [0, 2, 3]) {
      const { fetch, current, run } = fixture(20, [sample]);
      for (let i = 0; i < allowed; i++) current.mockReturnValueOnce(true);
      current.mockReturnValue(false);
      expect(await run()).toEqual({ state: 'unavailable' });
      expect(fetch).toHaveBeenCalledTimes(allowed ? allowed - 1 : 0);
    }
  });

  it('rejects a disputed duplicate and an oversized transport response', async () => {
    const disputed = fixture(20, [sample, { ...sample, content: 'different source bytes' }]);
    expect(await disputed.run()).toEqual({ state: 'unavailable' });
    const oversized = fixture(20, new Response(' '.repeat(2 * 1024 * 1024 + 1)));
    expect(await oversized.run()).toEqual({ state: 'unavailable' });
  });
});
