import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { OperationError } from '../operation-error.js';

/** Discord inline response. Protected replies are private and disable mentions. */
export type DiscordReply =
  | { readonly type: 1 }
  | {
      readonly type: 4;
      readonly data: {
        readonly content: string;
        readonly flags: 64;
        readonly allowed_mentions: { readonly parse: readonly [] };
      };
    };

/** A current Pending owner projection admitted for this actor and private external audience. */
export type DiscordPendingView =
  | {
      readonly status: 'available';
      readonly kind: 'approval' | 'user-input';
      readonly workspaceId: string;
      readonly threadId: string;
      readonly pendingRequestId: string;
      readonly turnId: string;
      /** Complete exact effect or non-secret questions; never a summary in place of the effect. */
      readonly content: string;
      /** False for secret questions, unsupported decision strength, or incomplete disclosure. */
      readonly responseAllowed: boolean;
    }
  | { readonly status: 'app-only' }
  | { readonly status: 'unavailable'; readonly code: string };

const verifiedInputs = new WeakSet<object>();
export const discordFreshnessMs = 300_000;
export const discordTransportSnowflake = z.string().regex(/^[0-9]{1,20}$/);
const envelopeSchema = z
  .object({
    id: discordTransportSnowflake,
    application_id: discordTransportSnowflake,
    type: z.number().int(),
    version: z.literal(1),
  })
  .passthrough();
const commandSchema = z.object({
  user: z.object({ id: discordTransportSnowflake }),
  context: z.literal(1),
  channel: z.object({ id: discordTransportSnowflake, type: z.literal(1) }),
  data: z.object({
    name: z.literal('openkit'),
    type: z.literal(1),
    options: z
      .array(
        z
          .object({
            name: z.enum(['pair', 'inspect', 'answer', 'approve', 'deny']),
            type: z.literal(1),
            options: z
              .array(
                z
                  .object({ name: z.string(), type: z.literal(3), value: z.string().max(6_000) })
                  .strict()
              )
              .max(5),
          })
          .strict()
      )
      .length(1),
  }),
});

/** Immutable raw request admitted by this module's signature verifier. */
export interface VerifiedDiscordInteraction {
  readonly body: string;
  readonly payloadDigest: string;
  readonly applicationId: string;
  readonly publicKey: string;
}

/** Verifies Ed25519 over timestamp plus exact raw body, then checks application and freshness. */
export function verifyDiscordInteraction(input: {
  readonly body: Uint8Array;
  readonly signature: string;
  readonly timestamp: string;
  readonly publicKey: string;
  readonly applicationId: string;
  readonly now?: number;
}): VerifiedDiscordInteraction {
  const reject = () =>
    new OperationError('invalid_discord_signature', 'Discord authentication failed.', 401);
  if (
    input.body.byteLength > 65_536 ||
    !/^[0-9a-f]{128}$/i.test(input.signature) ||
    !/^[0-9a-f]{64}$/i.test(input.publicKey) ||
    !/^[0-9]{1,12}$/.test(input.timestamp) ||
    Math.abs((input.now ?? Date.now()) - Number(input.timestamp) * 1000) > discordFreshnessMs
  )
    throw reject();
  try {
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(input.publicKey, 'hex'),
      ]),
      type: 'spki',
      format: 'der',
    });
    if (
      !verify(
        null,
        Buffer.concat([Buffer.from(input.timestamp), input.body]),
        key,
        Buffer.from(input.signature, 'hex')
      )
    )
      throw reject();
    const body = new TextDecoder('utf-8', { fatal: true }).decode(input.body);
    const envelope = envelopeSchema.parse(JSON.parse(body));
    if (envelope.application_id !== input.applicationId) throw reject();
    const value = Object.freeze({
      body,
      payloadDigest: discordDigest(input.body),
      applicationId: input.applicationId,
      publicKey: input.publicKey.toLowerCase(),
    });
    verifiedInputs.add(value);
    return value;
  } catch {
    throw reject();
  }
}

/** Private response helper also used by the HTTP entry's bounded interaction deadline. */
export function discordPrivateReply(content: string): DiscordReply {
  return { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } };
}

/** Admits the same authenticated private command for either storage owner. */
export function readVerifiedDiscordCommand(
  input: VerifiedDiscordInteraction,
  options: { readonly applicationId: string; readonly publicKey: string }
) {
  if (
    !verifiedInputs.has(input) ||
    input.applicationId !== options.applicationId ||
    input.publicKey !== options.publicKey.toLowerCase()
  ) {
    throw new OperationError('invalid_discord_signature', 'Discord authentication failed.', 401);
  }
  const envelope = envelopeSchema.parse(JSON.parse(input.body));
  if (envelope.type === 1) return { state: 'ping' } as const;
  const command = commandSchema.safeParse(envelope);
  if (
    envelope.guild_id !== undefined ||
    envelope.guild !== undefined ||
    envelope.member !== undefined ||
    envelope.context !== 1 ||
    !command.success
  ) {
    return { state: 'outside-dm' } as const;
  }
  if (envelope.type !== 2) return { state: 'unsupported' } as const;
  return { state: 'command', eventId: envelope.id, command: command.data } as const;
}

/** Hashes boundary bytes without retaining their sensitive content. */
export function discordDigest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Binds disclosure bytes to exact current Pending lineage as well as content. */
export function discordViewDigest(
  view: Extract<DiscordPendingView, { status: 'available' }>
): string {
  return discordDigest(
    JSON.stringify([
      view.kind,
      view.workspaceId,
      view.threadId,
      view.pendingRequestId,
      view.turnId,
      view.content,
    ])
  );
}
