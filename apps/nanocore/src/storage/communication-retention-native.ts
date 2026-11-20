import {
  AuditEventSchema,
  canonicalJsonText,
  RequestIdSchema,
  UserIdSchema,
} from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { prepareAuditEvent } from '../audit-events.js';
import { DiscordSnowflakeSchema } from '../channels/discord-snowflake.js';
import { OperationError } from '../operation-error-core.js';

const Instant = z.number().int().nonnegative().safe();
const DiscordRetentionAgeSchema = z.number().int().positive().safe();
const DeleteAccount = z.strictObject({
  kind: z.literal('delete-account'),
  externalAccountId: DiscordSnowflakeSchema,
});
export const DiscordRetentionSelectionSchema = z.discriminatedUnion('kind', [
  DeleteAccount,
  z.strictObject({ kind: z.literal('expire') }),
]);
export const DiscordRetentionCommandSchema = z.strictObject({
  requestId: RequestIdSchema,
  userId: UserIdSchema,
  action: DiscordRetentionSelectionSchema,
});
export type DiscordRetentionCommand = z.infer<typeof DiscordRetentionCommandSchema>;
export type DiscordRetentionSelection = z.infer<typeof DiscordRetentionSelectionSchema>;

const RetentionCounts = z.strictObject({
  bindings: Instant,
  challenges: Instant,
  disclosures: Instant,
  redactedInbound: Instant,
  heldInbound: Instant,
});
export const DiscordRetentionAckSchema = RetentionCounts.extend({
  auditEventId: AuditEventSchema.shape.id,
});
export type DiscordRetentionAck = z.infer<typeof DiscordRetentionAckSchema>;

const retainedAudit = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('discord.retention'),
  intentJson: z.string(),
  eventId: AuditEventSchema.shape.id,
  eventJson: z.string(),
  receiptDigest: z.string(),
});

/** Removes scoped Discord data with the original admin request and Audit in the same commit. */
export function applyDiscordRetentionInDb(
  sqlite: Database.Database,
  value: DiscordRetentionCommand,
  context: {
    readonly now: () => number;
    readonly readExpiryAgeMs?: (() => number | undefined) | undefined;
    readonly currentAuthority: (userId: string) => { administratorAtEvent: boolean } | null;
  }
): DiscordRetentionAck | null {
  const input = DiscordRetentionCommandSchema.parse(value);
  const { requestId, userId, action } = input;
  const intentJson = canonicalJsonText({ inputDigest: sha256Hex(canonicalJsonText(input)) });
  return sqlite
    .transaction(() => {
      if (!context.currentAuthority(userId)?.administratorAtEvent)
        throw new OperationError('forbidden', 'Current deployment administrator required.', 403);
      const previous = sqlite
        .prepare(`
          SELECT schema_version AS schemaVersion, kind, intent_json AS intentJson, event_id AS eventId,
            event_json AS eventJson, receipt_digest AS receiptDigest
          FROM communication_intents WHERE request_id = ?
        `)
        .get(requestId);
      if (previous) {
        const row = retainedAudit.parse(previous);
        if (row.intentJson !== intentJson)
          throw new OperationError('idempotency_key_conflict', 'Retention request changed.', 409);
        if (sha256Hex(row.eventJson) !== row.receiptDigest)
          throw new Error('The retained Discord retention Audit digest differs.');
        const audit = AuditEventSchema.parse(JSON.parse(row.eventJson));
        if (audit.id !== row.eventId || audit.requestId !== requestId)
          throw new Error('The retained Discord retention Audit identity differs.');
        return {
          ...RetentionCounts.parse(JSON.parse(audit.summary)),
          auditEventId: audit.id,
        };
      }

      const now = Instant.parse(context.now());
      const byAccount = action.kind === 'delete-account';
      const retainForMs = byAccount ? undefined : context.readExpiryAgeMs?.();
      if (!byAccount && retainForMs === undefined) return null;
      const selection = byAccount
        ? action.externalAccountId
        : now - DiscordRetentionAgeSchema.parse(retainForMs);
      if (
        byAccount &&
        sqlite
          .prepare(`
            SELECT 1 FROM channel_account_bindings
            WHERE channel_kind = 'discord' AND external_account_id = ? AND revoked_at IS NULL
          `)
          .get(selection)
      ) {
        throw new OperationError('channel_binding_active', 'Revoke the active binding first.', 409);
      }
      const inboundScope = byAccount ? 'external_account_id = ?' : 'recorded_at <= ?';
      const heldInbound = Instant.parse(
        sqlite
          .prepare(`
            SELECT count(*) FROM communication_intents
            WHERE kind = 'channel.inbound' AND external_account_id IS NOT NULL AND ${inboundScope}
              AND receipt_digest IS NULL AND refusal_code IS NULL
          `)
          .pluck()
          .get(selection)
      );
      if (byAccount && heldInbound > 0)
        throw new OperationError(
          'channel_retention_recovery_required',
          'Recover the original inbound outcomes before deleting this account data.',
          409
        );

      const redactedInbound = sqlite
        .prepare(`
          UPDATE communication_intents
          SET external_account_id = NULL, origin_json = NULL, native_input_hash = NULL, recorded_at = NULL
          WHERE kind = 'channel.inbound' AND external_account_id IS NOT NULL AND ${inboundScope}
            AND (receipt_digest IS NOT NULL OR refusal_code IS NOT NULL)
        `)
        .run(selection).changes;
      const bindings = sqlite
        .prepare(`
          DELETE FROM channel_account_bindings
          WHERE channel_kind = 'discord' AND revoked_at IS NOT NULL
            AND ${byAccount ? 'external_account_id = ?' : 'revoked_at <= ?'}
        `)
        .run(selection).changes;
      const disclosures = sqlite
        .prepare(`
          DELETE FROM channel_disclosures
          WHERE channel_kind = 'discord' AND ${byAccount ? 'external_account_id = ?' : 'expires_at <= ?'}
        `)
        .run(selection).changes;
      const challenges = byAccount
        ? 0
        : sqlite
            .prepare(
              "DELETE FROM channel_pairing_challenges WHERE channel_kind = 'discord' AND expires_at <= ?"
            )
            .run(selection).changes;
      const counts = { bindings, challenges, disclosures, redactedInbound, heldInbound };
      const audit = prepareAuditEvent({
        workspaceId: null,
        requestId,
        actor: { kind: 'user', id: userId },
        action: `channel.retention.${action.kind}`,
        resource: 'channel:discord',
        outcome: 'succeeded',
        summary: canonicalJsonText(counts),
        now: new Date(now),
      });
      const eventJson = canonicalJsonText(audit);
      const written = sqlite
        .prepare(`
          INSERT INTO communication_intents(
            request_id, schema_version, kind, intent_json, event_id, event_json, receipt_digest
          ) VALUES (?, 1, 'discord.retention', ?, ?, ?, ?)
        `)
        .run(requestId, intentJson, audit.id, eventJson, sha256Hex(eventJson));
      if (written.changes !== 1) throw new Error('The Discord retention Audit did not commit.');
      return { ...counts, auditEventId: audit.id };
    })
    .immediate();
}
