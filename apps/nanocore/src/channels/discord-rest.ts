import { z } from 'zod';

/** A transport observation only; it never changes or proves a Pending Request outcome. */
export type DiscordSendResult =
  | { readonly status: 'sent'; readonly externalMessageId: string }
  | { readonly status: 'failed-no-send'; readonly code: string }
  | { readonly status: 'delivery-unknown'; readonly code: string };

/** Exact private account and App destination selected by the attention owner. */
export interface DiscordAttentionSend {
  readonly discordUserId: string;
  readonly appPath: string;
  /** Rechecks source, recipient, current actor and binding after all asynchronous preparation. */
  readonly beforeSend: () => boolean;
}

const snowflake = z.string().regex(/^[0-9]{1,20}$/);
const privateDmSchema = z.object({
  id: snowflake,
  type: z.literal(1),
  recipients: z.array(z.object({ id: snowflake })).length(1),
});
const messageSchema = z.object({ id: snowflake, channel_id: snowflake });

/** Builds the production Discord REST boundary. Tests inject fetch; construction makes no contact. */
export function createDiscordRestTransport(options: {
  readonly publicBaseUrl: string;
  readonly resolveBotToken: () => Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
}) {
  const request = options.fetch ?? globalThis.fetch;

  return {
    /** Sends only an authenticated App link, with no request text, arguments or decision controls. */
    async sendAttention(input: DiscordAttentionSend): Promise<DiscordSendResult> {
      let appUrl: URL;
      try {
        const base = new URL(options.publicBaseUrl);
        appUrl = new URL(input.appPath, base);
        if (
          base.protocol !== 'https:' ||
          base.username ||
          base.password ||
          appUrl.origin !== base.origin ||
          appUrl.username ||
          appUrl.password ||
          !input.appPath.startsWith('/') ||
          input.appPath.startsWith('//') ||
          !snowflake.safeParse(input.discordUserId).success ||
          appUrl.href.length > 1_850
        )
          return noSend('discord_destination_unavailable');
      } catch {
        return noSend('discord_destination_unavailable');
      }
      let token: string | null;
      let channelId: string;
      try {
        token = await options.resolveBotToken();
        if (!token || /[\r\n]/.test(token)) return noSend('discord_credential_unavailable');
        const response = await request('https://discord.com/api/v10/users/@me/channels', {
          method: 'POST',
          headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipient_id: input.discordUserId }),
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return noSend('discord_dm_unavailable');
        const dm = privateDmSchema.parse(await response.json());
        if (dm.recipients[0]!.id !== input.discordUserId) return noSend('discord_dm_unavailable');
        channelId = dm.id;
        if (!input.beforeSend()) return noSend('discord_recipient_unavailable');
      } catch {
        return noSend('discord_preparation_failed');
      }
      try {
        // No asynchronous step separates current audience admission from the attention-message POST.
        const response = await request(
          `https://discord.com/api/v10/channels/${channelId}/messages`,
          {
            method: 'POST',
            headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `OpenKit needs your attention: ${appUrl.href}`,
              allowed_mentions: { parse: [] },
              flags: 4,
            }),
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
          }
        );
        // A gateway timeout or unrecognized status is not proof that the message was refused.
        if ([400, 401, 403, 404, 405, 413, 429].includes(response.status))
          return noSend('discord_message_rejected');
        if (!response.ok) return unknownSend();
        const message = messageSchema.parse(await response.json());
        if (message.channel_id !== channelId) return unknownSend();
        return { status: 'sent', externalMessageId: message.id };
      } catch {
        return unknownSend();
      }
    },
  };
}

/** Classifies a failure that did not send an attention message. */
function noSend(code: string): DiscordSendResult {
  return { status: 'failed-no-send', code };
}

/** Keeps contact without a definite message result uncertain, without raw error data. */
function unknownSend(): DiscordSendResult {
  return { status: 'delivery-unknown', code: 'discord_message_outcome_unknown' };
}
