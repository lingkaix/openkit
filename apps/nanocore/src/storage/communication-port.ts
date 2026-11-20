import type { AnswerUserInputRequest, AuditEvent } from '@openkit/protocol';
import type { z } from 'zod';
import type { AttentionAttemptCompletion } from '../notifications/attention.js';
import type {
  AttentionAttemptClaimSchema,
  AttentionClaimedDeliverySchema,
} from '../notifications/attention-codecs.js';
import type {
  StorageDecision,
  StorageIntent,
  StorageOccurrence,
  StorageReceipt,
  StorageResult,
  StorageStatus,
  StorageUnavailable,
} from './storage-owner.js';

/** A3 relays the immutable local pairing or unbind Audit event using its original ID. */
export type PairingAuditIntent = StorageIntent<
  'communication',
  'relay-pairing-audit',
  { readonly eventId: AuditEvent['id'] }
>;

/** The kernel receipt acknowledges the original Audit event and full input digest. */
export type PairingAuditReceipt = StorageReceipt<
  PairingAuditIntent,
  { readonly eventId: AuditEvent['id'] }
>;

/** The permanent channel/event key binds authenticated event coordinates across principals. */
export type ChannelInboundKey = StorageOccurrence<'communication', 'channel.inbound'>;

/** A3 reserves the envelope and authenticated payload digest before resolving a binding or disclosure. */
export interface ChannelInboundEnvelope extends ChannelInboundKey {
  readonly requestId: string;
  readonly inputDigest: string;
}

/** A3 binds the verified target once, before a Pending Request effect can be posted. */
export interface ChannelInboundOrigin {
  readonly envelope: ChannelInboundEnvelope;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly pendingRequestId: string;
  readonly userId: string;
  readonly bindingRevision: string;
  readonly disclosureDigest: string;
  readonly operation: ChannelInboundEffect['operation'];
}

/** A3 posts only a non-secret answer or a denial to the exact Pending Request owner. */
export type ChannelInboundEffect =
  | { readonly operation: 'question.answer'; readonly answers: AnswerUserInputRequest['answers'] }
  | { readonly operation: 'approval.respond'; readonly decision: 'denied' };

/** A3 settles pair/inspect from local handling, and answer/deny from the original decision. */
export type ChannelInboundReceipt = StorageReceipt<
  ChannelInboundEnvelope,
  { readonly kind: 'handled' } | { readonly kind: 'pending-decision'; readonly decisionRef: string }
>;

/** Restart inspects the original stage, including the saved principal after unbind/rebind. */
export type ChannelInboundState =
  | { readonly state: 'reserved'; readonly envelope: ChannelInboundEnvelope }
  | { readonly state: 'origin-bound'; readonly origin: ChannelInboundOrigin }
  | {
      readonly state: 'settled';
      readonly origin: ChannelInboundOrigin | null;
      readonly receipt: ChannelInboundReceipt;
    }
  | { readonly state: 'absent' | 'unknown' };

/** A3 pairing mutation and revision fact committed with the local Audit relay intent. */
export interface PairingChange {
  readonly bindingRevision: string;
  readonly audit: AuditEvent;
  readonly relay: PairingAuditIntent;
}

/** A3's typed handle keeps binding authority and delivery claims in the communication file. */
export interface CommunicationStore {
  status(): StorageStatus<'communication'>;
  /** Resolve the User from the challenge, consume it and commit the binding and local Audit. */
  pair(input: {
    readonly envelope: ChannelInboundEnvelope;
    readonly challengeDigest: string;
    readonly externalAccountId: string;
  }): Promise<StorageResult<'communication', PairingChange>>;
  /** Revoke the binding and outstanding challenges with the local Audit fact. */
  unbind(input: {
    readonly userId: string;
    readonly bindingRevision: string;
  }): Promise<StorageResult<'communication', PairingChange>>;
  /** Locate the next unsettled local Audit fact in owner append order after restart. */
  readPendingPairingAudit(): Promise<StorageResult<'communication', PairingChange | null>>;
  settlePairingAudit(receipt: PairingAuditReceipt): Promise<StorageResult<'communication', void>>;
  /**
   * Repeat live user, binding, disclosure and request checks at posting.
   * Keep the posting gate against unbind through the deciding call, outside the SQL transaction.
   * An interrupted claim inspects the original key before any further post.
   */
  decideInbound(
    origin: ChannelInboundOrigin,
    effect: ChannelInboundEffect,
    decide: (
      origin: ChannelInboundOrigin,
      effect: ChannelInboundEffect
    ) => Promise<StorageResult<'control-kernel', StorageDecision<ChannelInboundReceipt>>>
  ): Promise<
    | StorageResult<
        'communication',
        StorageDecision<ChannelInboundReceipt> | { readonly state: 'refused' | 'inspect-original' }
      >
    | StorageUnavailable<'control-kernel'>
  >;
  /** Match the original permanent receipt before settling the local intent. */
  settleInbound(receipt: ChannelInboundReceipt): Promise<StorageResult<'communication', void>>;
  /**
   * Compare recipient, channel and predecessor in the claim transaction.
   * Retry requires explicit admission and failed-no-send. Recheck authority immediately before send.
   */
  claimAttentionSend(
    input: z.infer<typeof AttentionAttemptClaimSchema>
  ): Promise<StorageResult<'communication', z.infer<typeof AttentionClaimedDeliverySchema>>>;
  /** A missing transport ACK settles as delivery-unknown and authorizes no retries. */
  settleAttentionSend(
    input: AttentionAttemptCompletion
  ): Promise<StorageResult<'communication', void>>;
}
