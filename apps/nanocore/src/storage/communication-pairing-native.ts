import { randomUUID } from 'node:crypto';
import {
  AuditEventIdSchema,
  canonicalJsonText,
  isUserId,
  RequestIdSchema,
  readRetainedV1,
} from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { prepareAuditEvent } from '../audit-events.js';
import { DiscordSnowflakeSchema } from '../channels/discord-snowflake.js';
import { OperationError } from '../operation-error.js';
import type {
  CommunicationStore,
  PairingAuditReceipt,
  PairingChange,
} from './communication-port.js';
import { hasOriginalReceiptDigest } from './communication-receipt.js';
import { storageRequestId } from './storage-owner.js';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const UserId = z.string().refine(isUserId);
const Instant = z.number().int().nonnegative().safe();
const Binding = z.object({
  externalAccountId: DiscordSnowflakeSchema,
  userId: UserId,
  revision: RequestIdSchema,
  pairedAt: Instant,
});
/** Original version-1 pairing Audit relay identity. */
export const PairingAuditIntentSchema = z.strictObject({
  deploymentId: z.string().min(1),
  sourceOwner: z.literal('communication'),
  verb: z.literal('relay-pairing-audit'),
  occurrenceKey: z.string().min(1),
  requestId: RequestIdSchema,
  target: z.strictObject({ eventId: AuditEventIdSchema }),
  expectedGeneration: RequestIdSchema,
  inputDigest: Digest,
});

const PairingAuditActorV1 = z.strictObject({ kind: z.literal('user'), id: UserId });
const PairingAuditEventV1 = z.strictObject({
  id: AuditEventIdSchema,
  workspaceId: z.null(),
  threadId: z.null(),
  turnId: z.null(),
  itemId: z.null(),
  capabilityCallId: z.null(),
  permissionDecisionId: z.null(),
  vaultGrantId: z.null(),
  requestId: z.null(),
  actor: PairingAuditActorV1,
  subject: PairingAuditActorV1,
  agentId: z.null(),
  agentSessionId: z.null(),
  category: z.literal('system'),
  action: z.enum(['channel.pairing.bind', 'channel.pairing.unbind']),
  resource: z.string().min(1),
  resourceRevision: z.null(),
  outcome: z.literal('succeeded'),
  severity: z.literal('info'),
  summary: z.string().min(1),
  errorCode: z.null(),
  createdAt: z.iso.datetime(),
  occurredAt: z.iso.datetime(),
});

type PairInput = Parameters<CommunicationStore['pair']>[0];
type UnbindInput = Parameters<CommunicationStore['unbind']>[0];
export type CommunicationBinding = z.infer<typeof Binding>;

/** The caller holds the kernel authority observation through the local deciding commit. */
interface PairingContext {
  readonly deploymentId: string;
  readonly currentAuthority: (userId: string) => { readonly administratorAtEvent: boolean } | null;
  readonly now: () => number;
}

const activeBindingSelection = `
  SELECT external_account_id AS externalAccountId, user_id AS userId, revision, paired_at AS pairedAt
  FROM channel_account_bindings WHERE channel_kind = 'discord' AND revoked_at IS NULL
`;

/** Reads a validated active revision over the admitted communication reader. */
export function readCommunicationBinding(
  sqlite: Database.Database,
  userId: string
): CommunicationBinding | null {
  const row = sqlite.prepare(`${activeBindingSelection} AND user_id = ?`).get(UserId.parse(userId));
  return row === undefined ? null : Binding.parse(row);
}

/** Resolves the authenticated external account to its current retained revision. */
export function readCommunicationBindingForAccount(
  sqlite: Database.Database,
  externalAccountId: string
): CommunicationBinding | null {
  const row = sqlite
    .prepare(`${activeBindingSelection} AND external_account_id = ?`)
    .get(DiscordSnowflakeSchema.parse(externalAccountId));
  return row === undefined ? null : Binding.parse(row);
}

/** Looks up the eligible challenge user before observing kernel authority. */
export function readPairingChallengeUser(
  sqlite: Database.Database,
  digest: string,
  now: number
): string | null {
  const row = sqlite
    .prepare(`
    SELECT user_id AS userId FROM channel_pairing_challenges
    WHERE channel_kind = 'discord' AND digest = ? AND consumed_at IS NULL AND expires_at > ?
  `)
    .get(Digest.parse(digest), Instant.parse(now));
  return row === undefined ? null : z.object({ userId: UserId }).parse(row).userId;
}

function invalidateChallenges(sqlite: Database.Database, userId: string, now: number): void {
  sqlite
    .prepare(`
    UPDATE channel_pairing_challenges SET consumed_at = ?
    WHERE channel_kind = 'discord' AND user_id = ? AND consumed_at IS NULL
  `)
    .run(now, userId);
}

/** Commits one digest-only challenge and supersedes previous open challenges. */
export function issuePairingChallengeInDb(
  sqlite: Database.Database,
  input: { readonly userId: string; readonly digest: string; readonly expiresAt: number },
  context: PairingContext
): void {
  const userId = UserId.parse(input.userId);
  const digest = Digest.parse(input.digest);
  const expiresAt = Instant.parse(input.expiresAt);
  sqlite
    .transaction(() => {
      const now = Instant.parse(context.now());
      if (expiresAt <= now || !context.currentAuthority(userId)) {
        throw new OperationError(
          'channel_actor_unavailable',
          'Current pairing authority is unavailable.',
          403
        );
      }
      invalidateChallenges(sqlite, userId, now);
      sqlite
        .prepare(`
      INSERT INTO channel_pairing_challenges(digest, channel_kind, user_id, expires_at)
      VALUES (?, 'discord', ?, ?)
    `)
        .run(digest, userId, expiresAt);
    })
    .immediate();
}

function appendPairingAudit(
  sqlite: Database.Database,
  deploymentId: string,
  action: 'channel.pairing.bind' | 'channel.pairing.unbind',
  binding: CommunicationBinding,
  administratorAtEvent: boolean,
  now: number
): PairingChange {
  const eventJson = canonicalJsonText(
    prepareAuditEvent({
      workspaceId: null,
      actor: { kind: 'user', id: binding.userId },
      subject: { kind: 'user', id: binding.userId },
      action,
      resource: `channel:discord:${binding.userId}`,
      outcome: 'succeeded',
      now: new Date(now),
      summary: JSON.stringify({
        channelKind: 'discord',
        userId: binding.userId,
        bindingRevision: binding.revision,
        administratorAtEvent,
      }),
    })
  );
  const audit = PairingAuditEventV1.parse(JSON.parse(eventJson));
  const occurrence = {
    deploymentId,
    sourceOwner: 'communication',
    verb: 'relay-pairing-audit',
    occurrenceKey: audit.id,
  } as const;
  const relay = PairingAuditIntentSchema.parse({
    ...occurrence,
    requestId: storageRequestId(occurrence),
    target: { eventId: audit.id },
    expectedGeneration: binding.revision,
    inputDigest: sha256Hex(eventJson),
  });
  sqlite
    .prepare(`
    INSERT INTO communication_intents(request_id, schema_version, kind, intent_json, event_id, event_json)
    VALUES (?, 1, 'relay-pairing-audit', ?, ?, ?)
  `)
    .run(relay.requestId, canonicalJsonText(relay), audit.id, eventJson);
  return { bindingRevision: binding.revision, audit, relay };
}

/** Consumes the validated challenge and commits its binding and original Audit together. */
export function pairCommunicationInDb(
  sqlite: Database.Database,
  input: PairInput,
  context: PairingContext
): PairingChange {
  const externalAccountId = DiscordSnowflakeSchema.parse(input.externalAccountId);
  const digest = Digest.parse(input.challengeDigest);
  // Only the caller that obtained the kernel's fresh envelope reservation may post here.
  if (
    input.envelope.deploymentId !== context.deploymentId ||
    input.envelope.sourceOwner !== 'communication' ||
    input.envelope.verb !== 'channel.inbound' ||
    input.envelope.requestId !== storageRequestId(input.envelope)
  )
    throw new OperationError(
      'channel_authority_unavailable',
      'Current pairing authority is unavailable.',
      403
    );

  return sqlite
    .transaction(() => {
      const now = Instant.parse(context.now());
      const userId = readPairingChallengeUser(sqlite, digest, now);
      const authority = userId && context.currentAuthority(userId);
      if (!userId || !authority) {
        throw new OperationError(
          'channel_challenge_unavailable',
          'Pairing challenge unavailable.',
          409
        );
      }
      const externalAccountIsBound = sqlite
        .prepare(`
      SELECT 1 FROM channel_account_bindings
      WHERE channel_kind = 'discord' AND external_account_id = ? AND revoked_at IS NULL
    `)
        .get(externalAccountId);
      if (externalAccountIsBound || readCommunicationBinding(sqlite, userId)) {
        throw new OperationError('channel_binding_conflict', 'An active binding exists.', 409);
      }
      const consumed = sqlite
        .prepare(
          'UPDATE channel_pairing_challenges SET consumed_at = ? WHERE digest = ? AND consumed_at IS NULL'
        )
        .run(now, digest);
      if (consumed.changes !== 1) throw new Error('Pairing challenge did not commit.');
      const binding = { externalAccountId, userId, revision: randomUUID(), pairedAt: now };
      sqlite
        .prepare(`
      INSERT INTO channel_account_bindings(revision, channel_kind, external_account_id, user_id, paired_at)
      VALUES (?, 'discord', ?, ?, ?)
    `)
        .run(binding.revision, externalAccountId, userId, now);
      return appendPairingAudit(
        sqlite,
        context.deploymentId,
        'channel.pairing.bind',
        binding,
        authority.administratorAtEvent,
        now
      );
    })
    .immediate();
}

/** Invalidates outstanding challenges while the observed absence of a binding still holds. */
export function revokePairingChallengesInDb(
  sqlite: Database.Database,
  userId: string,
  context: PairingContext
): void {
  const selected = UserId.parse(userId);
  sqlite
    .transaction(() => {
      if (!context.currentAuthority(selected)) {
        throw new OperationError(
          'channel_authority_unavailable',
          'Current unbind authority is unavailable.',
          403
        );
      }
      if (readCommunicationBinding(sqlite, selected)) {
        throw new OperationError(
          'channel_binding_unavailable',
          'Current binding changed. Inspect its revision before unbinding.',
          409
        );
      }
      invalidateChallenges(sqlite, selected, Instant.parse(context.now()));
    })
    .immediate();
}

/** Revokes only the selected active revision and appends its Audit in the same commit. */
export function unbindCommunicationInDb(
  sqlite: Database.Database,
  input: UnbindInput,
  context: PairingContext
): PairingChange {
  const userId = UserId.parse(input.userId);
  const bindingRevision = RequestIdSchema.parse(input.bindingRevision);
  return sqlite
    .transaction(() => {
      const now = Instant.parse(context.now());
      const authority = context.currentAuthority(userId);
      if (!authority) {
        throw new OperationError(
          'channel_authority_unavailable',
          'Current unbind authority is unavailable.',
          403
        );
      }
      const binding = readCommunicationBinding(sqlite, userId);
      if (!binding || binding.revision !== bindingRevision) {
        throw new OperationError(
          'channel_binding_unavailable',
          'Current binding unavailable.',
          409
        );
      }
      const revoked = sqlite
        .prepare(
          'UPDATE channel_account_bindings SET revoked_at = ? WHERE revision = ? AND revoked_at IS NULL'
        )
        .run(now, bindingRevision);
      if (revoked.changes !== 1) throw new Error('Binding revocation did not commit.');
      invalidateChallenges(sqlite, userId, now);
      return appendPairingAudit(
        sqlite,
        context.deploymentId,
        'channel.pairing.unbind',
        binding,
        authority.administratorAtEvent,
        now
      );
    })
    .immediate();
}

function decodePairingAudit(row: {
  request_id: string;
  event_id: string;
  event_json: string;
  intent_json: string;
  schema_version: number;
}): PairingChange {
  return readRetainedV1({ schemaVersion: row.schema_version }, () => {
    const relay = PairingAuditIntentSchema.parse(JSON.parse(row.intent_json));
    if (relay.inputDigest !== sha256Hex(row.event_json)) {
      throw new Error('Retained communication Audit digest differs from the original.');
    }
    const audit = PairingAuditEventV1.parse(JSON.parse(row.event_json));
    if (
      row.request_id !== relay.requestId ||
      row.event_id !== audit.id ||
      relay.occurrenceKey !== audit.id ||
      relay.target.eventId !== audit.id ||
      relay.requestId !== storageRequestId(relay)
    ) {
      throw new Error('Invalid retained communication Audit identity.');
    }
    return { bindingRevision: relay.expectedGeneration, audit, relay };
  });
}

const auditColumns = 'request_id, event_id, event_json, intent_json, schema_version';

/** Reads the oldest unsettled fact in local append order for restart or repair relay. */
export function readPendingPairingAuditInDb(sqlite: Database.Database): PairingChange | null {
  const row = sqlite
    .prepare<[], Parameters<typeof decodePairingAudit>[0]>(`
    SELECT ${auditColumns} FROM communication_intents
    WHERE kind = 'relay-pairing-audit' AND receipt_digest IS NULL ORDER BY sequence LIMIT 1
  `)
    .get();
  return row ? decodePairingAudit(row) : null;
}

/** Acknowledges the exact applied kernel receipt and preserves the original event bytes. */
export function settlePairingAuditInDb(
  sqlite: Database.Database,
  receipt: PairingAuditReceipt
): void {
  if (
    receipt.disposition !== 'applied' ||
    receipt.result.eventId !== receipt.intent.target.eventId
  ) {
    throw new Error('Kernel receipt did not apply the communication Audit fact.');
  }
  const { receiptDigest } = receipt;
  if (!hasOriginalReceiptDigest(receipt)) {
    throw new Error(
      'Kernel receipt digest does not match the original communication Audit decision.'
    );
  }
  sqlite
    .transaction(() => {
      const row = sqlite
        .prepare<
          [string],
          Parameters<typeof decodePairingAudit>[0] & {
            receipt_digest: string | null;
          }
        >(`
      SELECT ${auditColumns}, receipt_digest FROM communication_intents WHERE request_id = ? AND kind = 'relay-pairing-audit'
    `)
        .get(receipt.intent.requestId);
      if (
        !row ||
        canonicalJsonText(decodePairingAudit(row).relay) !== canonicalJsonText(receipt.intent)
      ) {
        throw new Error('Kernel receipt does not match the original communication Audit fact.');
      }
      if (row.receipt_digest === receiptDigest) return;
      if (row.receipt_digest !== null) throw new Error('Conflicting communication Audit receipt.');
      sqlite
        .prepare(`
      UPDATE communication_intents SET receipt_digest = ?
      WHERE request_id = ? AND kind = 'relay-pairing-audit'
    `)
        .run(receiptDigest, receipt.intent.requestId);
    })
    .immediate();
}
