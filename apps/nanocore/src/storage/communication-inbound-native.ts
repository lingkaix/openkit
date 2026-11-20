import { canonicalJsonText, RequestIdSchema } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { DiscordSnowflakeSchema } from '../channels/discord-snowflake.js';
import { OperationError } from '../operation-error-core.js';
import { readCommunicationBinding } from './communication-pairing-native.js';
import type {
  ChannelInboundEnvelope,
  ChannelInboundOrigin,
  ChannelInboundReceipt,
} from './communication-port.js';
import { hasOriginalReceiptDigest } from './communication-receipt.js';

import { storageRequestId } from './storage-owner.js';

export const ChannelNativeInputHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const ChannelRefusalCodeSchema = z.string().regex(/^[a-z0-9_-]{1,80}$/);

export interface ChannelOriginClaim {
  readonly origin: ChannelInboundOrigin;
  readonly inputHash: string;
}

export interface ChannelOriginSettlement extends ChannelOriginClaim {
  readonly receipt: ChannelInboundReceipt;
}

export interface ChannelInboundRefusal {
  readonly envelope: ChannelInboundEnvelope;
  readonly origin: ChannelInboundOrigin | null;
  readonly code: string;
}

export interface ChannelInboundProof {
  readonly inputHash: string | null;
  readonly receiptDigest: string | null;
  readonly refusalCode: string | null;
}

const originRecord = z.object({
  schemaVersion: z.literal(1),
  envelopeJson: z.string(),
  externalAccountId: DiscordSnowflakeSchema.nullable(),
  originJson: z.string().nullable(),
  inputHash: ChannelNativeInputHashSchema.nullable(),
  refusalCode: ChannelRefusalCodeSchema.nullable(),
  receiptDigest: z.string().min(1).nullable(),
});

/** Stores the signed actor once, before the kernel can grant a fresh event reservation. */
export function stageChannelEnvelopeInDb(
  sqlite: Database.Database,
  envelope: ChannelInboundEnvelope,
  externalAccountId: string
): 'staged-now' | 'inspect-original' | 'conflict' {
  const requestId = RequestIdSchema.parse(envelope.requestId);
  if (requestId !== storageRequestId(envelope)) {
    throw new OperationError(
      'channel_origin_conflict',
      'The original response identity differs.',
      409
    );
  }
  const actor = DiscordSnowflakeSchema.parse(externalAccountId);
  const envelopeJson = canonicalJsonText(envelope);
  return sqlite
    .transaction(() => {
      const inserted = sqlite
        .prepare(`
      INSERT INTO communication_intents(
        request_id, schema_version, kind, intent_json, external_account_id
      ) VALUES (?, 1, 'channel.inbound', ?, ?) ON CONFLICT(request_id) DO NOTHING
    `)
        .run(requestId, envelopeJson, actor);
      if (inserted.changes === 1) return 'staged-now';

      const original = readChannelOriginInDb(sqlite, requestId);
      return original.envelopeJson === envelopeJson &&
        (original.externalAccountId === null || original.externalAccountId === actor)
        ? 'inspect-original'
        : 'conflict';
    })
    .immediate();
}

/** Commits the local original intent before asking the kernel to bind an effect. */
export function claimChannelOriginInDb(
  sqlite: Database.Database,
  { origin, inputHash }: ChannelOriginClaim
): boolean {
  const requestId = RequestIdSchema.parse(origin.envelope.requestId);
  const originJson = canonicalJsonText(origin);
  const nativeInputHash = ChannelNativeInputHashSchema.parse(inputHash);
  return sqlite
    .transaction(() => {
      const original = readChannelOriginInDb(sqlite, requestId);
      if (
        original.envelopeJson !== canonicalJsonText(origin.envelope) ||
        (original.originJson !== null &&
          (original.originJson !== originJson || original.inputHash !== nativeInputHash))
      ) {
        throw new OperationError(
          'channel_origin_conflict',
          'The original response origin differs.',
          409
        );
      }
      if (original.originJson !== null || original.refusalCode !== null) return false;
      const binding = readCommunicationBinding(sqlite, origin.userId);
      if (
        !binding ||
        binding.revision !== origin.bindingRevision ||
        binding.externalAccountId !== original.externalAccountId
      ) {
        throw new OperationError(
          'channel_binding_unavailable',
          'Current binding unavailable.',
          409
        );
      }
      const changed = sqlite
        .prepare(`
        UPDATE communication_intents SET origin_json = ?, native_input_hash = ?
        WHERE request_id = ? AND kind = 'channel.inbound' AND origin_json IS NULL
      `)
        .run(originJson, nativeInputHash, requestId);
      if (changed.changes !== 1) throw new Error('Original response origin did not commit.');
      return true;
    })
    .immediate();
}

function readChannelOriginInDb(sqlite: Database.Database, requestId: string) {
  return originRecord.parse(
    sqlite
      .prepare(`
        SELECT schema_version AS schemaVersion, intent_json AS envelopeJson,
          external_account_id AS externalAccountId, origin_json AS originJson,
          native_input_hash AS inputHash, refusal_code AS refusalCode, receipt_digest AS receiptDigest
        FROM communication_intents WHERE request_id = ? AND kind = 'channel.inbound'
      `)
      .get(requestId)
  );
}

function matchesOrigin(
  row: z.infer<typeof originRecord>,
  envelope: ChannelInboundEnvelope,
  origin: ChannelInboundOrigin | null
): boolean {
  const envelopeJson = canonicalJsonText(envelope);
  return (
    row.envelopeJson === envelopeJson &&
    row.originJson === (origin && canonicalJsonText(origin)) &&
    (origin === null || canonicalJsonText(origin.envelope) === envelopeJson)
  );
}

/** Reads only proof for the original envelope and the full expected origin. */
export function readChannelInboundProof(
  sqlite: Database.Database,
  envelope: ChannelInboundEnvelope,
  origin: ChannelInboundOrigin | null
): ChannelInboundProof | null {
  const row = readChannelOriginInDb(sqlite, envelope.requestId);
  if (!matchesOrigin(row, envelope, origin)) return null;
  return {
    inputHash: row.inputHash,
    receiptDigest: row.receiptDigest,
    refusalCode: row.refusalCode,
  };
}

/** Records a definite no-effect outcome without storing any reply or answer text. */
export function settleChannelRefusalInDb(
  sqlite: Database.Database,
  { envelope, origin, code }: ChannelInboundRefusal
): void {
  const requestId = RequestIdSchema.parse(envelope.requestId);
  const refusalCode = ChannelRefusalCodeSchema.parse(code);
  sqlite
    .transaction(() => {
      const original = readChannelOriginInDb(sqlite, requestId);
      if (
        !matchesOrigin(original, envelope, origin) ||
        original.receiptDigest !== null ||
        (original.refusalCode !== null && original.refusalCode !== refusalCode)
      ) {
        throw new Error('The refusal does not match the original unsettled response.');
      }
      sqlite
        .prepare(
          "UPDATE communication_intents SET refusal_code = ? WHERE request_id = ? AND kind = 'channel.inbound'"
        )
        .run(refusalCode, requestId);
    })
    .immediate();
}

/** Settles only the local intent for this exact applied original decision. */
export function settleChannelOriginInDb(
  sqlite: Database.Database,
  { origin, inputHash, receipt }: ChannelOriginSettlement
): void {
  if (receipt.disposition !== 'applied' || receipt.result.kind !== 'pending-decision') {
    throw new Error('The kernel receipt does not prove a Pending Request decision.');
  }
  if (!hasOriginalReceiptDigest(receipt)) {
    throw new Error('The kernel receipt digest does not match the original response.');
  }
  if (!origin) throw new Error('The kernel receipt has no bound origin.');
  const requestId = RequestIdSchema.parse(receipt.intent.requestId);
  const { receiptDigest } = receipt;
  sqlite
    .transaction(() => {
      const original = readChannelOriginInDb(sqlite, requestId);
      if (
        !matchesOrigin(original, receipt.intent, origin) ||
        original.inputHash !== ChannelNativeInputHashSchema.parse(inputHash) ||
        original.refusalCode !== null
      ) {
        throw new Error(
          'The kernel receipt does not match the original response origin and input.'
        );
      }
      if (original.receiptDigest === receiptDigest) return;
      if (original.receiptDigest !== null)
        throw new Error('Conflicting inbound settlement receipt.');
      sqlite
        .prepare(
          "UPDATE communication_intents SET receipt_digest = ? WHERE request_id = ? AND kind = 'channel.inbound'"
        )
        .run(receiptDigest, requestId);
    })
    .immediate();
}
