import { z } from 'zod';
import type { DiscordSendResult } from './discord-rest.js';
import { DiscordSnowflakeSchema as snowflake } from './discord-snowflake.js';

const bot = z.object({ id: snowflake, bot: z.literal(true) });
const textChannel = z.object({ id: snowflake, guild_id: snowflake, type: z.literal(0) });
const message = z.object({
  id: snowflake,
  channel_id: snowflake,
  author: bot,
  content: z.string(),
});
const api = 'https://discord.com/api/v10';

/** Exact destination and text from the governed publication action, not from Discord ingress. */
export interface DiscordGroupSend {
  readonly guildId: string;
  readonly channelId: string;
  readonly botUserId: string;
  readonly content: string;
  /** Recheck current authority and take the shared native claim after all preparation. */
  readonly beforeSend: () => boolean;
  /** Check current authority before each external preparation request. */
  readonly stillCurrent: () => boolean;
}

/** Prepares a bound Discord send. The Core publication owner owns the claim and records the result. */
export function createDiscordGroupDelivery(options: {
  readonly resolveBotToken: (botUserId: string) => Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
}) {
  const request = options.fetch ?? globalThis.fetch;

  return {
    /** Sends at most one POST. A failed acknowledgement never triggers a retry here. */
    async send(input: DiscordGroupSend): Promise<DiscordSendResult> {
      const { guildId, channelId, botUserId, content, beforeSend, stillCurrent } = input;
      if (
        ![guildId, channelId, botUserId].every((id) => snowflake.safeParse(id).success) ||
        !content ||
        Buffer.byteLength(content, 'utf8') > 4096 ||
        [...content].length > 2000 ||
        Buffer.from(content, 'utf8').toString('utf8') !== content
      )
        return { status: 'failed-no-send', code: 'discord_publication_invalid' };

      const channelUrl = `${api}/channels/${channelId}`;
      const body = JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: 4 });
      let headers: Headers;
      try {
        const token = await options.resolveBotToken(botUserId);
        if (!token || /[\r\n]/.test(token))
          return { status: 'failed-no-send', code: 'discord_credential_unavailable' };
        headers = new Headers({
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
        });

        // Verify the actual credential and destination before this credential can publish.
        const get = (url: string) =>
          request(url, {
            method: 'GET',
            headers,
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
          });
        if (stillCurrent() !== true)
          return { status: 'failed-no-send', code: 'discord_publication_not_current' };
        const identity = await get(`${api}/users/@me`);
        if (!identity.ok || bot.parse(await identity.json()).id !== botUserId)
          return { status: 'failed-no-send', code: 'discord_bot_unavailable' };
        if (stillCurrent() !== true)
          return { status: 'failed-no-send', code: 'discord_publication_not_current' };
        const destination = await get(channelUrl);
        if (!destination.ok)
          return { status: 'failed-no-send', code: 'discord_destination_unavailable' };
        const channel = textChannel.parse(await destination.json());
        if (channel.id !== channelId || channel.guild_id !== guildId)
          return { status: 'failed-no-send', code: 'discord_destination_unavailable' };
        if (beforeSend() !== true)
          return { status: 'failed-no-send', code: 'discord_publication_not_claimed' };
      } catch {
        return { status: 'failed-no-send', code: 'discord_preparation_failed' };
      }

      const unknown = {
        status: 'delivery-unknown',
        code: 'discord_message_outcome_unknown',
      } as const;
      try {
        const response = await request(`${channelUrl}/messages`, {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        if ([400, 401, 403, 404, 405, 413, 429].includes(response.status))
          return { status: 'failed-no-send', code: 'discord_message_rejected' };
        if (!response.ok) return unknown;
        const ack = message.parse(await response.json());
        if (ack.channel_id !== channelId || ack.author.id !== botUserId || ack.content !== content)
          return unknown;
        return { status: 'sent', externalMessageId: ack.id };
      } catch {
        return unknown;
      }
    },
  };
}
