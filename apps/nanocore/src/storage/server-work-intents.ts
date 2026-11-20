import { ActorRefSchema, canonicalJsonText } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ControlKnowledgeAdmissionInputSchema } from './control-store-admission-codecs.js';
import { frameControlScalarText } from './control-store-input.js';
import {
  CONTROL_PRODUCT_LIMITS,
  ControlProductMutationSchema,
  ControlProductPreconditionError,
} from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { ServerWorkIntent, ServerWorkReceipt } from './server-work-port.js';
import { storageRequestId } from './storage-owner.js';

const intentEnvelope = z.strictObject({
  sourceOwner: z.literal('server-work'),
  deploymentId: z.string().min(1),
  occurrenceKey: z.string().min(1),
  requestId: z.string().min(1),
  expectedGeneration: z.string().min(1).nullable(),
  inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
const workTarget = z.strictObject({
  actor: ActorRefSchema,
  credentialRef: z.string().min(1).nullable(),
  recordRef: z.string().min(1),
});
const threadTarget = workTarget.extend({ threadId: z.string().min(1) });
const callTarget = workTarget.extend({ callId: z.string().min(1) });
const intentSchema = z.union([
  intentEnvelope.extend({ verb: z.literal('admit-thread'), target: threadTarget }),
  intentEnvelope.extend({
    verb: z.enum(['admit-turn', 'settle-turn']),
    target: threadTarget.extend({ turnId: z.string().min(1) }),
  }),
  intentEnvelope.extend({
    verb: z.literal('admit-call'),
    target: callTarget.extend({
      threadId: z.string().min(1).nullable(),
      turnId: z.string().min(1).nullable(),
      routeRef: z.string().min(1),
      budgetRef: z.string().min(1).nullable(),
    }),
  }),
  intentEnvelope.extend({ verb: z.enum(['settle-call', 'settle-usage']), target: callTarget }),
]) satisfies z.ZodType<ServerWorkIntent>;

const receiptEnvelope = z.strictObject({
  intent: intentSchema,
  receiptDigest: z.string().min(1),
});
const receiptSchema = z.discriminatedUnion('disposition', [
  receiptEnvelope.extend({
    disposition: z.literal('applied'),
    result: z.strictObject({ decisionRef: z.string().min(1) }),
  }),
  receiptEnvelope.extend({ disposition: z.literal('refused'), reason: z.string().min(1) }),
]) satisfies z.ZodType<ServerWorkReceipt>;

const productAdmissionDraft = z.strictObject({
  products: z.array(ControlProductMutationSchema).min(1).max(CONTROL_PRODUCT_LIMITS.entries),
  input: z.string().nullable(),
  knowledge: z
    .strictObject({
      busy: z.boolean(),
      receipt: ControlKnowledgeAdmissionInputSchema.shape.receipt,
    })
    .optional(),
});

/** Checks the decoded input as an exact scalar, including when resolving retained work. */
export function parseServerProductAdmissionDraft(payload: string) {
  const draft = productAdmissionDraft.parse(JSON.parse(payload));
  if (draft.input !== null) frameControlScalarText(draft.input);
  return draft;
}

/** Exact pending or settled draft on the Server work connection. */
export interface StagedServerWork {
  readonly intent: ServerWorkIntent;
  readonly payload: string;
  readonly receipt: ServerWorkReceipt | null;
}

function validateIntent(intent: ServerWorkIntent, payload: string): void {
  const framed = frameControlScalarText(payload);
  if (
    framed.byteLength > CONTROL_PRODUCT_LIMITS.payloadBytes ||
    intent.requestId !== storageRequestId(intent) ||
    intent.inputDigest !== framed.digest
  )
    throw new ControlProductPreconditionError();
  if (intent.verb === 'admit-thread' || intent.verb === 'admit-turn')
    parseServerProductAdmissionDraft(payload);
}

/** Reads and verifies the durable Server draft, including its local receipt when settled. */
export function readStagedServerWork(
  sqlite: Database.Database,
  requestId: string
): StagedServerWork | null {
  const row = sqlite
    .prepare(
      `SELECT schema_version, intent_json, payload_json, receipt_json
       FROM server_work_intents WHERE request_id = ?`
    )
    .get(requestId) as
    | {
        schema_version: number;
        intent_json: string;
        payload_json: string;
        receipt_json: string | null;
      }
    | undefined;
  if (!row) return null;
  if (row.schema_version !== 1) throw new ControlProductPreconditionError();

  const intent = intentSchema.parse(JSON.parse(row.intent_json));
  validateIntent(intent, row.payload_json);
  if (intent.requestId !== requestId) throw new ControlProductPreconditionError();
  const receipt =
    row.receipt_json === null ? null : receiptSchema.parse(JSON.parse(row.receipt_json));
  if (receipt && canonicalJsonText(receipt.intent) !== canonicalJsonText(intent))
    throw new ControlProductPreconditionError();
  return { intent, payload: row.payload_json, receipt };
}

/** Commits the original intent and its exact product bytes before the kernel request can post. */
export function stageServerWorkIntent<Intent extends ServerWorkIntent>(
  sqlite: Database.Database,
  intent: Intent,
  payload: string
): Intent {
  assertControlProductWriter(sqlite);
  const parsed = intentSchema.parse(intent);
  validateIntent(parsed, payload);
  const intentJson = canonicalJsonText(parsed);
  const staged = readStagedServerWork(sqlite, intent.requestId);
  if (staged) {
    if (canonicalJsonText(staged.intent) !== intentJson || staged.payload !== payload)
      throw new ControlProductPreconditionError();
  } else {
    sqlite
      .prepare(
        `INSERT INTO server_work_intents (request_id, schema_version, intent_json, payload_json)
         VALUES (?, 1, ?, ?)`
      )
      .run(parsed.requestId, intentJson, payload);
  }
  return intent;
}

/** Reads back the same staged intent without permitting additional kernel effects. */
export function readServerWorkIntent(
  sqlite: Database.Database,
  requestId: string
): ServerWorkIntent | null {
  return readStagedServerWork(sqlite, requestId)?.intent ?? null;
}

/** Reads local settlement for owner-ahead reconciliation before any deciding call. */
export function readServerWorkLocalReceipt(
  sqlite: Database.Database,
  requestId: string
): ServerWorkReceipt | null {
  return readStagedServerWork(sqlite, requestId)?.receipt ?? null;
}

/** Publishes the exact applied decision and records its receipt in the same owner savepoint. */
export function settleServerWorkIntent(
  sqlite: Database.Database,
  receipt: ServerWorkReceipt,
  publish: (intent: ServerWorkIntent, payload: string) => void
): void {
  assertControlProductWriter(sqlite);
  const parsed = receiptSchema.parse(receipt);
  const receiptJson = canonicalJsonText(parsed);
  const staged = readStagedServerWork(sqlite, parsed.intent.requestId);
  if (!staged || canonicalJsonText(staged.intent) !== canonicalJsonText(parsed.intent))
    throw new ControlProductPreconditionError();
  if (staged.receipt) {
    if (canonicalJsonText(staged.receipt) !== receiptJson)
      throw new ControlProductPreconditionError();
    return;
  }

  sqlite.transaction(() => {
    const changed = sqlite
      .prepare(
        'UPDATE server_work_intents SET receipt_json=? WHERE request_id=? AND receipt_json IS NULL'
      )
      .run(receiptJson, parsed.intent.requestId);
    if (changed.changes !== 1) throw new ControlProductPreconditionError();
    if (parsed.disposition === 'applied') publish(staged.intent, staged.payload);
  })();
}

/** Reads the exact staged bytes only after their matching applied receipt commits. */
export function readPublishedServerWorkPayload(
  sqlite: Database.Database,
  receipt: ServerWorkReceipt
): string | null {
  const staged = readStagedServerWork(sqlite, receipt.intent.requestId);
  return staged?.receipt?.disposition === 'applied' &&
    canonicalJsonText(staged.receipt) === canonicalJsonText(receipt)
    ? staged.payload
    : null;
}

/** Requires the exact applied receipt before the original Server admission can dispatch. */
export function isServerWorkPublished(
  sqlite: Database.Database,
  receipt: ServerWorkReceipt
): boolean {
  return readPublishedServerWorkPayload(sqlite, receipt) !== null;
}
