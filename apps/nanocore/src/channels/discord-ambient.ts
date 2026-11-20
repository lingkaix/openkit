import { z } from 'zod';

const snowflake = z.string().regex(/^[1-9][0-9]{0,19}$/);
const guild = z.object({ id: snowflake, approximate_member_count: z.number().int().positive() });
const message = z.object({
  id: snowflake,
  channel_id: snowflake,
  type: z.union([z.literal(0), z.literal(19)]),
  author: z.object({
    id: snowflake,
    bot: z.literal(false).optional(),
    system: z.literal(false).optional(),
  }),
  webhook_id: z.undefined().optional(),
  message_snapshots: z.undefined().optional(),
  message_reference: z.object({ type: z.literal(0).optional() }).optional(),
  content: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
  edited_timestamp: z.iso.datetime({ offset: true }).nullish(),
});
const windowMs = 5 * 60_000;
const api = 'https://discord.com/api/v10';

/** A selected in-memory source. The capture owner maps the account to a binding-scoped author. */
export interface DiscordAmbientMessage {
  readonly messageId: string;
  readonly discordAuthorId: string;
  readonly postedAt: number;
  readonly editedAt: string | null;
  readonly text: string;
}

/** The Turn owner freezes the first selected or unavailable outcome. This reader retains neither. */
export type DiscordAmbientResult =
  | { readonly state: 'unavailable' }
  | {
      readonly state: 'selected';
      readonly approximateMemberCount: number;
      readonly countObservedAt: number;
      readonly windowStart: number;
      readonly messages: readonly DiscordAmbientMessage[];
    };

/** Reads the disclosed main-channel window once. Only the admitted Turn owner can call this reader. */
export function createDiscordAmbientReader(options: {
  readonly resolveVerifiedBotToken: (botUserId: string) => Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}) {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  return async (input: {
    readonly guildId: string;
    readonly channelId: string;
    readonly botUserId: string;
    readonly mentionId: string;
    readonly postedAt: number;
    readonly limits: { readonly small: number; readonly medium: number };
    readonly excludedMessageIds: ReadonlySet<string>;
    /** Rechecks binding, bot, effective Message Content access and publication of the actual notice. */
    readonly current: () => boolean;
  }): Promise<DiscordAmbientResult> => {
    const unavailable = { state: 'unavailable' } as const;
    const { guildId, channelId, botUserId, mentionId, postedAt, current } = input;
    const { small, medium } = input.limits;
    if (
      ![guildId, channelId, botUserId, mentionId].every((id) => snowflake.safeParse(id).success) ||
      !Number.isSafeInteger(postedAt) ||
      !Number.isInteger(small) ||
      small < 0 ||
      small > 100 ||
      !Number.isInteger(medium) ||
      medium < 0 ||
      medium > 30 ||
      (small === 0 && medium === 0)
    )
      return unavailable;

    try {
      if (current() !== true) return unavailable;
      const token = await options.resolveVerifiedBotToken(botUserId);
      if (!token || current() !== true) return unavailable;
      const get = (url: string, cap: number) =>
        fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bot ${token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        }).then((response) => readJson(response, cap));
      const count = guild.parse(await get(`${api}/guilds/${guildId}?with_counts=true`, 64 * 1024));
      const countObservedAt = now();
      if (count.id !== guildId) return unavailable;
      const size = count.approximate_member_count;
      const limit = size <= 20 ? small : size <= 100 ? medium : 0;
      if (!limit || current() !== true) return unavailable;
      const history = await get(
        `${api}/channels/${channelId}/messages?before=${mentionId}&limit=${limit}`,
        2 * 1024 * 1024
      );
      if (!Array.isArray(history) || history.length > limit || current() !== true)
        return unavailable;

      const windowStart = postedAt - windowMs;
      const messages = new Map<string, DiscordAmbientMessage>();
      for (const candidate of history) {
        const parsed = message.safeParse(candidate);
        if (!parsed.success) continue;
        const row = parsed.data;
        const time = Date.parse(row.timestamp);
        if (
          row.channel_id !== channelId ||
          row.author.id === botUserId ||
          BigInt(row.id) >= BigInt(mentionId) ||
          time < windowStart ||
          time > postedAt ||
          input.excludedMessageIds.has(row.id) ||
          Buffer.byteLength(row.content, 'utf8') > 8192
        )
          continue;
        const selected = {
          messageId: row.id,
          discordAuthorId: row.author.id,
          postedAt: time,
          editedAt: row.edited_timestamp ? normalizeDiscordEditInstant(row.edited_timestamp) : null,
          text: row.content,
        };
        const duplicate = messages.get(row.id);
        if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(selected)) return unavailable;
        messages.set(row.id, selected);
      }
      return {
        state: 'selected',
        approximateMemberCount: size,
        countObservedAt,
        windowStart,
        messages: [...messages.values()].sort(
          (a, b) => a.postedAt - b.postedAt || (BigInt(a.messageId) < BigInt(b.messageId) ? -1 : 1)
        ),
      };
    } catch {
      return unavailable;
    }
  };
}

/** Normalizes timezone and trailing zeroes without truncating the source fraction. */
function normalizeDiscordEditInstant(input: string): string {
  const parts = /^(.*:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(input);
  if (!parts) throw new Error('Discord edit timestamp unavailable');
  const second = new Date(`${parts[1]}${parts[3]}`).toISOString().slice(0, -5);
  const fraction = parts[2]?.replace(/0+$/, '');
  return `${second}${fraction ? `.${fraction}` : ''}Z`;
}

/** Bounds response bytes before JSON parsing; rejected bodies never reach capture. */
async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Discord ambient response unavailable');
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error('Discord ambient response too large');
    }
    parts.push(part.value);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, bytes)));
}
