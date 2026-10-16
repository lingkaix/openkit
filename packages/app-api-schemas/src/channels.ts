import {
  ApprovalRequestIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
  UserInputRequestIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import type { OperationDefinition } from './operation-contract.js';

/** Deployment-local transport observation; no value represents a Core decision. */
export const NotificationDeliverySchema = z.object({
  id: RequestIdSchema,
  appPath: z.string().startsWith('/'),
  source: z.object({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    requestId: z.union([ApprovalRequestIdSchema, UserInputRequestIdSchema]),
    kind: z.enum(['approval-request', 'user-input-request']),
  }),
  recipientUserId: z.string().min(1),
  channel: z.enum(['discord', 'email']).nullable(),
  status: z.enum(['queued', 'sending', 'sent', 'failed-no-send', 'delivery-unknown']),
  createdAt: z.string().datetime(),
  attempt: z
    .object({
      id: z.number().int().positive(),
      status: z.enum(['sending', 'sent', 'failed-no-send', 'delivery-unknown']),
      failureCode: z
        .enum(['authority-unavailable', 'transport-refused', 'transport-unknown', 'restart'])
        .nullable(),
      startedAt: z.string().datetime(),
      finishedAt: z.string().datetime().nullable(),
    })
    .nullable(),
});

/** Current caller's external account association; no credential is returned. */
export const DiscordChannelStatusSchema = z.object({
  configured: z.boolean(),
  sendingAvailable: z.boolean(),
  binding: z.object({ discordUserId: z.string().min(1), pairedAt: z.number().int() }).nullable(),
});

const credentials = ['local-user', 'user-session', 'deployment-administrator'] as const;
const userBoundary = {
  credentials,
  scope: { kind: 'user' },
  target: { kind: 'user' },
  policyOperation: 'api.call',
  binding: 'json',
  successStatus: 200,
} as const;

/** First-channel settings and conditional delivery commands use existing native operation projections. */
export const CHANNEL_OPERATION_DEFINITIONS = {
  'channel.discord.status': {
    ...userBoundary,
    description: 'Read your Discord binding and deployment availability.',
    inputSchema: z.object({}).strict(),
    outputSchema: DiscordChannelStatusSchema,
    mutating: false,
    returnsOneTimeSecret: false,
  },
  'channel.discord.pair': {
    ...userBoundary,
    description: 'Start a short-lived one-use Discord account pairing challenge.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ challenge: z.string().min(1), expiresAt: z.number().int() }),
    mutating: true,
    returnsOneTimeSecret: true,
  },
  'channel.discord.revoke': {
    ...userBoundary,
    description: 'Revoke your Discord account binding and outstanding pairing challenges.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.null(),
    mutating: true,
    returnsOneTimeSecret: false,
  },
  'notification.list': {
    ...userBoundary,
    description: 'List your currently authorized Pending Request delivery observations.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(),
    outputSchema: z.object({ items: z.array(NotificationDeliverySchema).max(100) }),
    mutating: false,
    returnsOneTimeSecret: false,
  },
  'notification.send': {
    ...userBoundary,
    description:
      'Send one attention link, or explicitly retry a proved no-send attempt using its exact identity.',
    inputSchema: z
      .object({
        deliveryId: RequestIdSchema,
        expectedAttemptId: z.number().int().positive().nullable(),
      })
      .strict(),
    outputSchema: NotificationDeliverySchema,
    mutating: true,
    returnsOneTimeSecret: false,
  },
} as const satisfies Record<string, OperationDefinition>;
