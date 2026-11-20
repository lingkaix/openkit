import type { z } from 'zod';
import type { createDiscordRestTransport } from '../channels/discord-rest.js';
import {
  type AttentionAttemptCompletion,
  type AttentionDelivery,
  type AttentionEligibility,
  type AttentionSource,
  deliverClaimedAttention,
} from '../notifications/attention.js';
import type {
  AttentionClaimedDeliverySchema,
  AttentionEnqueueSchema,
} from '../notifications/attention-codecs.js';
import { AttentionError } from '../notifications/attention-error.js';
import type { PendingRequestRecord } from '../runtime/pending-requests.js';
import type { CommunicationAttentionClaimSchema } from './communication-attention-native.js';
import type { WithCommunicationBinding } from './communication-discord.js';
import { requireChannelStorage } from './communication-inbound.js';
import type { CommunicationBinding } from './communication-pairing-native.js';
import type { CommunicationStore } from './communication-port.js';
import type { StorageResult } from './storage-owner.js';

type Claim = z.infer<typeof CommunicationAttentionClaimSchema>;
type ClaimSnapshot = z.infer<typeof AttentionClaimedDeliverySchema>;

interface CommunicationAttentionWriters {
  claim(input: Claim): Promise<StorageResult<'communication', ClaimSnapshot>>;
  settle: CommunicationStore['settleAttentionSend'];
}

type PublishedPending = Pick<
  PendingRequestRecord,
  | 'workspaceId'
  | 'threadId'
  | 'requestId'
  | 'responsibleUserId'
  | 'kind'
  | 'state'
  | 'requesterKind'
>;

/** Projects a source observed through the existing post-publication or verified reopen reader. */
export async function observePublishedCommunicationAttention(
  record: PublishedPending,
  dependencies: {
    readonly isCurrent: (record: PublishedPending) => boolean;
    readonly enqueue: (
      input: z.infer<typeof AttentionEnqueueSchema>
    ) => Promise<StorageResult<'communication', AttentionDelivery>>;
  }
): Promise<StorageResult<'communication', AttentionDelivery | null>> {
  if (
    record.state !== 'pending' ||
    record.requesterKind === 'automation' ||
    !dependencies.isCurrent(record)
  ) {
    return { state: 'ready', value: null };
  }
  return dependencies.enqueue({
    source: {
      workspaceId: record.workspaceId,
      threadId: record.threadId,
      requestId: record.requestId,
      kind: record.kind === 'approval' ? 'approval-request' : 'user-input-request',
    },
    recipientUserId: record.responsibleUserId,
  });
}

/** Sends one ACKed attempt while the shared recipient binding gate protects the effect. */
export function sendCommunicationAttention(input: {
  readonly selection: Omit<Claim, 'bindingRevision' | 'channel'>;
  readonly withBinding: WithCommunicationBinding;
  readonly readBinding: (
    userId: string
  ) => StorageResult<'communication', CommunicationBinding | null>;
  readonly writer: CommunicationAttentionWriters;
  readonly isEligible: AttentionEligibility;
  readonly buildAppPath: (source: AttentionSource) => string;
  readonly send: ReturnType<typeof createDiscordRestTransport>['sendAttention'];
  readonly now?: () => string;
}): Promise<AttentionDelivery> {
  const { recipientUserId } = input.selection;
  return input.withBinding(recipientUserId, async () => {
    const selected = requireChannelStorage(input.readBinding(recipientUserId));
    if (!selected) throw new AttentionError('attention_not_eligible');
    const delivery = requireChannelStorage(
      await input.writer.claim({
        ...input.selection,
        channel: 'discord',
        bindingRevision: selected.revision,
      })
    );
    if (
      delivery.id !== input.selection.deliveryId ||
      delivery.recipientUserId !== recipientUserId ||
      delivery.channel !== 'discord' ||
      delivery.attempt.id === input.selection.expectedAttemptId
    ) {
      throw new AttentionError('attention_attempt_conflict');
    }
    const eligible = () =>
      input.isEligible(delivery) &&
      requireChannelStorage(input.readBinding(recipientUserId))?.revision === selected.revision;
    return deliverClaimedAttention(delivery, {
      buildAppPath: input.buildAppPath,
      isEligible: eligible,
      transport: (payload) =>
        input.send({
          discordUserId: selected.externalAccountId,
          appPath: payload.appPath,
          beforeSend: eligible,
        }),
      finish: async (status, failureCode) => {
        const finishedAt = input.now?.() ?? new Date().toISOString();
        const completion: AttentionAttemptCompletion = {
          deliveryId: delivery.id,
          attemptId: delivery.attempt.id,
          status,
          failureCode,
          finishedAt,
        };
        requireChannelStorage(await input.writer.settle(completion));
        return {
          ...delivery,
          status,
          attempt: { ...delivery.attempt, status, failureCode, finishedAt },
        };
      },
    });
  });
}
