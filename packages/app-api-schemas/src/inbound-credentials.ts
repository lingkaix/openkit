import {
  AccessTokenIdSchema,
  AgentSessionIdSchema,
  AuthenticationSessionIdSchema,
  NanoHostTransportTokenIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { OpenKitAccessTokenRecordSchema } from './auth.js';
import { NanoHostTransportTokenRecordSchema } from './nanohost.js';

/** One redacted projection over the original inbound credential owners. */
export const InboundCredentialRecordSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('access-token'),
      id: AccessTokenIdSchema,
      record: OpenKitAccessTokenRecordSchema,
      integrationId: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('auth-session'),
      id: AuthenticationSessionIdSchema,
      issuedAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
      status: z.enum(['active', 'expired']),
      current: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('discord-pairing'),
      id: RequestIdSchema,
      issuedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('worker-run'),
      id: TurnIdSchema,
      workspaceId: WorkspaceIdSchema,
      threadId: ThreadIdSchema,
      turnId: TurnIdSchema,
      agentSessionId: AgentSessionIdSchema,
      status: z.enum(['open', 'closing']),
      issuedAt: z.string().datetime(),
      expiresAt: z.string().datetime().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('nanohost-transport'),
      id: NanoHostTransportTokenIdSchema,
      record: NanoHostTransportTokenRecordSchema,
    })
    .strict(),
]);

/** A selector identifies one original owner; it never carries credential material. */
export const RevokeInboundCredentialRequestSchema = z
  .object({
    kind: z.enum([
      'access-token',
      'auth-session',
      'discord-pairing',
      'worker-run',
      'nanohost-transport',
    ]),
    id: z.string().min(1).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    const schema =
      value.kind === 'access-token'
        ? AccessTokenIdSchema
        : value.kind === 'auth-session'
          ? AuthenticationSessionIdSchema
          : value.kind === 'discord-pairing'
            ? RequestIdSchema
            : value.kind === 'worker-run'
              ? TurnIdSchema
              : NanoHostTransportTokenIdSchema;
    if (!schema.safeParse(value.id).success)
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'Credential selector does not match its kind.',
      });
  });

/** Complete redacted inventory; run rows contain no sandbox route credential or hash. */
export const ListInboundCredentialsResponseSchema = z
  .object({
    items: z.array(InboundCredentialRecordSchema),
    canManageServerCredentials: z.boolean(),
  })
  .strict();

/** A run can truthfully remain in its existing cancellation and cleanup lifecycle. */
export const RevokeInboundCredentialResponseSchema = z
  .object({
    status: z.enum(['revoked', 'ending']),
  })
  .strict();

export type InboundCredentialRecord = z.infer<typeof InboundCredentialRecordSchema>;
