import { isUserId, RequestIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Existing external account/event identity, never a Core authority assertion. */
const SnowflakeSchema = z.string().regex(/^[0-9]{1,20}$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const UserIdSchema = z.string().refine(isUserId);
const InstantSchema = z.number().int().nonnegative().safe();
const ModeSchema = z.enum(['local', 'server']);
const TargetSchema = z.object({
  workspaceId: z.string(),
  threadId: z.string(),
  pendingRequestId: z.string(),
});

/** Eight original Discord SQL stages; no secret, body, answer, callback or SQL crosses. */
export const ControlDiscordChannelInputSchema = z.discriminatedUnion('stage', [
  z.object({ stage: z.literal('reconcile-incomplete') }).strict(),
  z.object({ stage: z.literal('revoke-binding'), userId: UserIdSchema }).strict(),
  z
    .object({
      stage: z.literal('issue-challenge'),
      mode: ModeSchema,
      userId: UserIdSchema,
      digest: DigestSchema,
      expiresAt: InstantSchema,
    })
    .strict(),
  z
    .object({
      stage: z.literal('consume-challenge'),
      mode: ModeSchema,
      discordUserId: SnowflakeSchema,
      digest: DigestSchema,
      admittedUserId: UserIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      stage: z.literal('reserve-inbound'),
      eventId: SnowflakeSchema,
      payloadDigest: DigestSchema,
      discordUserId: SnowflakeSchema,
    })
    .strict(),
  TargetSchema.extend({
    stage: z.literal('publish-origin'),
    mode: ModeSchema,
    eventId: SnowflakeSchema,
    requestId: RequestIdSchema,
    userId: UserIdSchema,
    discordUserId: SnowflakeSchema,
    bindingRevision: RequestIdSchema,
    operationId: z.enum(['question.answer', 'approval.respond']),
    turnId: z.string(),
  }).strict(),
  TargetSchema.extend({
    stage: z.literal('publish-disclosure'),
    mode: ModeSchema,
    userId: UserIdSchema,
    tokenDigest: DigestSchema,
    discordUserId: SnowflakeSchema,
    bindingRevision: RequestIdSchema,
    kind: z.enum(['approval', 'user-input']),
    contentDigest: DigestSchema,
    expiresAt: InstantSchema,
  }).strict(),
  z
    .object({
      stage: z.literal('settle-inbound'),
      eventId: SnowflakeSchema,
      state: z.enum(['settled', 'response-unknown']),
    })
    .strict(),
]);

/** Original bounded pairing responses, shared without content or external credentials. */
export const DiscordPairResultSchema = z.enum([
  'Pairing challenge unavailable. Start pairing in OpenKit.',
  'An active binding exists. Revoke it in OpenKit before pairing again.',
  'Discord account paired. Current Core authority is checked for each response.',
]);

/** Exact existing reservation outcome; unknown historical state remains a bounded unknown reply. */
export const DiscordInboundReservationSchema = z.union([
  z
    .object({ existing: z.object({ payloadDigest: z.string(), state: z.string() }).strict() })
    .strict(),
  z.object({ requestId: RequestIdSchema }).strict(),
]);

/** Stage acknowledgements and only the existing safe public authority/binding refusals. */
export const ControlDiscordChannelResultSchema = z.discriminatedUnion('stage', [
  z
    .object({ stage: z.literal('reconcile-incomplete'), changes: z.number().int().nonnegative() })
    .strict(),
  z.object({ stage: z.literal('revoke-binding') }).strict(),
  z.object({ stage: z.literal('issue-challenge') }).strict(),
  z.object({ stage: z.literal('consume-challenge'), text: DiscordPairResultSchema }).strict(),
  z
    .object({ stage: z.literal('reserve-inbound'), receipt: DiscordInboundReservationSchema })
    .strict(),
  z
    .object({ stage: z.literal('publish-origin'), changes: z.number().int().nonnegative() })
    .strict(),
  z.object({ stage: z.literal('publish-disclosure') }).strict(),
  z.object({ stage: z.literal('settle-inbound') }).strict(),
  z
    .object({
      stage: z.literal('refused'),
      code: z.enum([
        'channel_actor_unavailable',
        'channel_authority_unavailable',
        'channel_binding_unavailable',
      ]),
      message: z.enum([
        'Current actor authority is unavailable.',
        'Current authority unavailable.',
        'Current binding unavailable.',
        'The retained account binding is unavailable.',
      ]),
      status: z.union([z.literal(403), z.literal(409)]),
    })
    .strict(),
]);

export type ControlDiscordChannelInput = z.infer<typeof ControlDiscordChannelInputSchema>;
export type ControlDiscordChannelResult = z.infer<typeof ControlDiscordChannelResultSchema>;
