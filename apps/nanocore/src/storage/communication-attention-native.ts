import { RequestIdSchema } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  claimAttentionAttemptInDb,
  completeAttentionAttemptInDb,
} from '../notifications/attention.js';
import {
  AttentionAttemptClaimSchema,
  AttentionClaimedDeliverySchema,
} from '../notifications/attention-codecs.js';
import { AttentionError } from '../notifications/attention-error.js';
import {
  type ControlAttentionAttemptCompletion,
  ControlAttentionAttemptCompletionSchema,
} from './attention-attempt-completion-codecs.js';
import { readCommunicationBinding } from './communication-pairing-native.js';

export const CommunicationAttentionClaimSchema = AttentionAttemptClaimSchema.extend({
  channel: z.literal('discord'),
  bindingRevision: RequestIdSchema,
});

/** Claims the original attempt while the selected communication binding is still current. */
export function claimCommunicationAttentionInDb(
  sqlite: Database.Database,
  value: z.infer<typeof CommunicationAttentionClaimSchema>,
  now: () => string
): z.infer<typeof AttentionClaimedDeliverySchema> {
  const { bindingRevision, ...claim } = CommunicationAttentionClaimSchema.parse(value);
  return sqlite
    .transaction(() => {
      const binding = readCommunicationBinding(sqlite, claim.recipientUserId);
      if (binding?.revision !== bindingRevision) throw new AttentionError('attention_not_eligible');

      const delivery = AttentionClaimedDeliverySchema.parse(
        claimAttentionAttemptInDb(sqlite, claim, now)
      );
      if (delivery.source.kind === 'security-notice')
        throw new AttentionError('attention_not_eligible');
      return delivery;
    })
    .immediate();
}

/** Acknowledges only the exact outcome of the selected delivery and attempt. */
export function settleCommunicationAttentionInDb(
  sqlite: Database.Database,
  value: ControlAttentionAttemptCompletion
): void {
  const input = ControlAttentionAttemptCompletionSchema.parse(value);
  sqlite
    .transaction(() => {
      completeAttentionAttemptInDb(sqlite, input);
      const row = sqlite
        .prepare<
          [number, string],
          {
            status: string;
            failureCode: string | null;
            finishedAt: string | null;
          }
        >(`
        SELECT status, failure_code AS failureCode, finished_at AS finishedAt
        FROM notification_delivery_attempts WHERE id = ? AND attention_id = ? AND channel = 'discord'
      `)
        .get(input.attemptId, input.deliveryId);
      if (
        row?.status !== input.status ||
        row.failureCode !== input.failureCode ||
        row.finishedAt !== input.finishedAt
      )
        throw new AttentionError('attention_attempt_conflict');
    })
    .immediate();
}
