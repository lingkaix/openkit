import { sha256Hex } from '@openkit/protocol/digest';
import { z } from 'zod';
import { normalizeDiscordInstant } from './discord-instant.js';

const snowflake = z.string().regex(/^[0-9]{1,20}$/);
const guildMessage = z.object({
  id: snowflake,
  guild_id: snowflake,
  channel_id: snowflake,
  type: z.union([z.literal(0), z.literal(19)]),
  author: z.object({
    id: snowflake,
    bot: z.literal(false).optional(),
    system: z.literal(false).optional(),
  }),
  webhook_id: z.undefined().optional(),
  message_snapshots: z.undefined().optional(),
  message_reference: z
    .object({
      type: z.literal(0).optional(),
      message_id: snowflake,
      channel_id: snowflake,
      guild_id: snowflake.optional(),
    })
    .optional(),
  mentions: z.array(z.object({ id: snowflake })),
  content: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
});

/** Exact active routing projection. Resolving it grants no Policy authority. */
export interface DiscordGroupMentionBinding {
  readonly guildId: string;
  readonly channelId: string;
  readonly botUserId: string;
}

/** In-memory ingress only. Only the owning binding may map this sender to a principal. */
export interface DiscordGroupMention {
  readonly requestId: string;
  readonly inputHash: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly botUserId: string;
  readonly senderId: string;
  readonly content: string;
  readonly postedAt: number;
  readonly postedAtExact: string;
  readonly questionDigest: string;
  readonly replyToMessageId: string | null;
}

/** Returns only an addressed human message on the current connection's exact route. */
export function selectDiscordGroupMention(
  event: unknown,
  connectedBotUserId: string,
  binding: DiscordGroupMentionBinding
): DiscordGroupMention | null {
  if (connectedBotUserId !== binding.botUserId) return null;
  const observed = guildMessage.safeParse(event);
  if (!observed.success) return null;
  const message = observed.data;
  if (
    message.guild_id !== binding.guildId ||
    message.channel_id !== binding.channelId ||
    message.author.id === connectedBotUserId ||
    !message.mentions.some((mention) => mention.id === connectedBotUserId)
  )
    return null;

  // Structured mentions alone can be reply notifications. Require one explicit user mention in the body.
  const explicit = [...message.content.matchAll(/<@!?([0-9]{1,20})>/g)];
  if (explicit.length !== 1 || explicit[0]?.[1] !== connectedBotUserId) return null;
  if (Buffer.from(message.content, 'utf8').toString('utf8') !== message.content) return null;
  const reference = message.message_reference;
  if (
    (message.type === 19) !== (reference !== undefined) ||
    (reference &&
      (reference.channel_id !== message.channel_id ||
        (reference.guild_id && reference.guild_id !== message.guild_id)))
  )
    return null;

  const postedAtExact = normalizeDiscordInstant(message.timestamp);
  if (!postedAtExact) return null;
  const postedAt = Date.parse(postedAtExact);
  const replyToMessageId = reference?.message_id ?? null;
  return {
    requestId: JSON.stringify(['guild-mention', message.guild_id, message.channel_id, message.id]),
    inputHash: sha256Hex(
      JSON.stringify([
        'guild-mention-v1',
        message.author.id,
        message.content,
        [connectedBotUserId],
        replyToMessageId,
      ])
    ),
    guildId: message.guild_id,
    channelId: message.channel_id,
    messageId: message.id,
    botUserId: connectedBotUserId,
    senderId: message.author.id,
    content: message.content,
    postedAt,
    postedAtExact,
    questionDigest: sha256Hex(message.content),
    replyToMessageId,
  };
}

/** The receipt owner must check existing rows before rejecting a stale unseen mention. */
export function isFreshDiscordGroupMention(mention: DiscordGroupMention, now: number): boolean {
  const age = now - mention.postedAt;
  return age >= 0 && age <= 5 * 60_000;
}
