import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AuthVariables } from './auth/middleware.js';
import type { ChannelServices } from './channel-services.js';
import { discordPrivateReply, verifyDiscordInteraction } from './channels/discord.js';
import type { OpenKitConfig } from './config/openkit-config.js';
import { OperationError } from './operation-error.js';

/** Registers Discord's separately signed entry before ordinary App authentication middleware. */
export function registerDiscordInteractionRoutes(input: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly config: NonNullable<OpenKitConfig['channels']>['discord'];
  readonly services: () => ChannelServices | undefined;
}): void {
  input.app.post(
    '/api/channels/discord/interactions',
    bodyLimit({ maxSize: 65_536 }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const discord = input.services()?.discord;
      if (!input.config || !discord)
        return c.json(
          { error: { code: 'channel_unavailable', message: 'Discord is unavailable.' } },
          503
        );
      try {
        const verified = verifyDiscordInteraction({
          body: new Uint8Array(await c.req.arrayBuffer()),
          signature: c.req.header('x-signature-ed25519') ?? '',
          timestamp: c.req.header('x-signature-timestamp') ?? '',
          applicationId: input.config.applicationId,
          publicKey: input.config.publicKey,
        });
        const work = discord.handleVerified(verified).then((reply) => {
          queueMicrotask(() => {
            try {
              input.services()?.recoverAttention();
            } catch {
              /* A transport projection never decides a Core request. */
            }
          });
          return reply;
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Discord's inline acknowledgement deadline is three seconds. An unfinished owner keeps its durable receipt.
          const deadline = new Promise<ReturnType<typeof discordPrivateReply>>((resolve) => {
            timer = setTimeout(
              () =>
                resolve(
                  discordPrivateReply(
                    'The response is still being checked. Inspect the request in OpenKit before retrying.'
                  )
                ),
              2_000
            );
          });
          return c.json(await Promise.race([work, deadline]));
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch (error) {
        if (error instanceof OperationError)
          return c.json(
            { error: { code: error.code, message: 'Discord input was refused.' } },
            error.status as 400 | 401 | 403 | 409 | 503
          );
        return c.json(
          {
            error: {
              code: 'discord_input_failed',
              message: 'Discord input could not be processed.',
            },
          },
          503
        );
      }
    }
  );
}
