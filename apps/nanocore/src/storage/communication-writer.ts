import {
  AuditEventSchema,
  RequestIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { DiscordSnowflakeSchema } from '../channels/discord-snowflake.js';
import { OperationError } from '../operation-error-core.js';
import {
  CommunicationDisclosureWriteSchema,
  writeCommunicationDisclosureInDb,
} from './communication-disclosure-native.js';
import {
  ChannelNativeInputHashSchema,
  ChannelRefusalCodeSchema,
  claimChannelOriginInDb,
  settleChannelOriginInDb,
  settleChannelRefusalInDb,
  stageChannelEnvelopeInDb,
} from './communication-inbound-native.js';
import {
  issuePairingChallengeInDb,
  PairingAuditIntentSchema,
  pairCommunicationInDb,
  revokePairingChallengesInDb,
  settlePairingAuditInDb,
  unbindCommunicationInDb,
} from './communication-pairing-native.js';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Instant = z.number().int().nonnegative().safe();
const Authority = z.strictObject({
  userId: UserIdSchema,
  administratorAtEvent: z.boolean(),
});
const Envelope = z.strictObject({
  deploymentId: z.string().min(1),
  sourceOwner: z.literal('communication'),
  verb: z.literal('channel.inbound'),
  occurrenceKey: z.string().min(1),
  requestId: RequestIdSchema,
  inputDigest: Digest,
});
const Origin = z.strictObject({
  envelope: Envelope,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  pendingRequestId: z.string().min(1),
  userId: UserIdSchema,
  bindingRevision: RequestIdSchema,
  disclosureDigest: Digest,
  operation: z.enum(['question.answer', 'approval.respond']),
});
const Applied = {
  receiptDigest: z.string().min(1),
  disposition: z.literal('applied'),
};
const InboundReceipt = z.strictObject({
  ...Applied,
  intent: Envelope,
  result: z.strictObject({ kind: z.literal('pending-decision'), decisionRef: z.string().min(1) }),
});
const PairingReceipt = z.strictObject({
  ...Applied,
  intent: PairingAuditIntentSchema,
  result: z.strictObject({ eventId: AuditEventSchema.shape.id }),
});

/** Closed DM mutations carried by the shared communication worker channel. */
export const CommunicationWriterCommandSchema = z.discriminatedUnion('stage', [
  z.strictObject({
    stage: z.literal('stage-envelope'),
    envelope: Envelope,
    externalAccountId: DiscordSnowflakeSchema,
  }),
  z.strictObject({
    stage: z.literal('issue-challenge'),
    authority: Authority,
    input: z.strictObject({ userId: UserIdSchema, digest: Digest, expiresAt: Instant }),
  }),
  z.strictObject({
    stage: z.literal('revoke-challenges'),
    authority: Authority,
    input: z.strictObject({ userId: UserIdSchema }),
  }),
  z.strictObject({
    stage: z.literal('pair'),
    authority: Authority,
    input: z.strictObject({
      envelope: Envelope,
      challengeDigest: Digest,
      externalAccountId: DiscordSnowflakeSchema,
    }),
  }),
  z.strictObject({
    stage: z.literal('unbind'),
    authority: Authority,
    input: z.strictObject({ userId: UserIdSchema, bindingRevision: RequestIdSchema }),
  }),
  z.strictObject({
    stage: z.literal('write-disclosure'),
    authority: Authority,
    input: CommunicationDisclosureWriteSchema,
  }),
  z.strictObject({
    stage: z.literal('claim-origin'),
    input: z.strictObject({ origin: Origin, inputHash: ChannelNativeInputHashSchema }),
  }),
  z.strictObject({
    stage: z.literal('settle-origin'),
    input: z.strictObject({
      origin: Origin,
      inputHash: ChannelNativeInputHashSchema,
      receipt: InboundReceipt,
    }),
  }),
  z.strictObject({
    stage: z.literal('settle-refusal'),
    input: z.strictObject({
      envelope: Envelope,
      origin: Origin.nullable(),
      code: ChannelRefusalCodeSchema,
    }),
  }),
  z.strictObject({ stage: z.literal('settle-pairing-audit'), input: PairingReceipt }),
]);

export type CommunicationWriterCommand = z.infer<typeof CommunicationWriterCommandSchema>;

const PairingChange = z.strictObject({
  bindingRevision: RequestIdSchema,
  audit: AuditEventSchema,
  relay: PairingAuditIntentSchema,
});

/** Durable results acknowledged after the owning worker commits. */
export const CommunicationWriterReplySchema = z.discriminatedUnion('stage', [
  z.strictObject({
    stage: z.literal('stage-envelope'),
    admission: z.enum(['staged-now', 'inspect-original', 'conflict']),
  }),
  z.strictObject({ stage: z.literal('issue-challenge') }),
  z.strictObject({ stage: z.literal('revoke-challenges') }),
  z.strictObject({
    stage: z.literal('pair'),
    change: PairingChange,
  }),
  z.strictObject({
    stage: z.literal('unbind'),
    change: PairingChange,
  }),
  z.strictObject({ stage: z.literal('write-disclosure') }),
  z.strictObject({ stage: z.literal('claim-origin'), claimed: z.boolean() }),
  z.strictObject({ stage: z.literal('settle-origin') }),
  z.strictObject({ stage: z.literal('settle-refusal') }),
  z.strictObject({ stage: z.literal('settle-pairing-audit') }),
]);

export type CommunicationWriterReply = z.infer<typeof CommunicationWriterReplySchema>;

/** Runs one closed mutation over the writer admitted to that communication file. */
export function applyCommunicationWriterCommand(
  sqlite: Database.Database,
  deploymentId: string,
  value: CommunicationWriterCommand,
  now: () => number = Date.now
): CommunicationWriterReply {
  const command = CommunicationWriterCommandSchema.parse(value);
  const stage = command.stage;
  if (
    'authority' in command &&
    'userId' in command.input &&
    command.input.userId !== command.authority.userId
  ) {
    throw new OperationError(
      'channel_authority_unavailable',
      'Current authority unavailable.',
      403
    );
  }
  const currentAuthority = (userId: string) =>
    'authority' in command && command.authority.userId === userId ? command.authority : null;
  const context = { deploymentId, now, currentAuthority };
  switch (stage) {
    case 'stage-envelope':
      if (command.envelope.deploymentId !== deploymentId) {
        throw new OperationError(
          'channel_authority_unavailable',
          'Current authority unavailable.',
          403
        );
      }
      return {
        stage,
        admission: stageChannelEnvelopeInDb(sqlite, command.envelope, command.externalAccountId),
      };
    case 'issue-challenge':
      issuePairingChallengeInDb(sqlite, command.input, context);
      return { stage };
    case 'revoke-challenges':
      revokePairingChallengesInDb(sqlite, command.input.userId, context);
      return { stage };
    case 'pair':
      return {
        stage,
        change: PairingChange.parse(pairCommunicationInDb(sqlite, command.input, context)),
      };
    case 'unbind':
      return {
        stage,
        change: PairingChange.parse(unbindCommunicationInDb(sqlite, command.input, context)),
      };
    case 'write-disclosure':
      writeCommunicationDisclosureInDb(sqlite, command.input, now());
      return { stage };
    case 'claim-origin':
      if (command.input.origin.envelope.deploymentId !== deploymentId) {
        throw new OperationError(
          'channel_authority_unavailable',
          'Current authority unavailable.',
          403
        );
      }
      return { stage, claimed: claimChannelOriginInDb(sqlite, command.input) };
    case 'settle-origin':
      settleChannelOriginInDb(sqlite, command.input);
      return { stage };
    case 'settle-refusal':
      if (command.input.envelope.deploymentId !== deploymentId) {
        throw new OperationError(
          'channel_authority_unavailable',
          'Current authority unavailable.',
          403
        );
      }
      settleChannelRefusalInDb(sqlite, command.input);
      return { stage };
    case 'settle-pairing-audit':
      settlePairingAuditInDb(sqlite, command.input);
      return { stage };
  }
}
