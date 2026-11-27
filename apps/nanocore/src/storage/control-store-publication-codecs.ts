import { AuditEventSchema, ItemSchema, RequestIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { CommandRequestName } from '../lib/store.js';
import { ControlPendingCommandInputSchema } from '../runtime/pending-request-codecs.js';
import { StoredRuntimeEvidenceV1Schema } from '../runtime/runtime-evidence-v1.js';
import { ControlAdmissionSchema } from './control-store-admission-codecs.js';
import {
  CONTROL_PRODUCT_LIMITS,
  type ControlProductEntry,
  ControlProductEntrySchema,
  ControlProductMutationSchema,
  fileContentSchema,
} from './control-store-product-records.js';
import { StoredWorkOwnerV1Schema } from './retained-work-metadata-v1.js';

/** Counts descriptor metadata separately from bounded inline entry bodies; actual queue bytes stay charged. */
export function controlProductMetadataJson(value: {
  entries?: readonly ControlProductEntry[];
  terminal?: { entries?: readonly ControlProductEntry[] };
  admission?: { entries?: readonly ControlProductEntry[] };
  pendingItem?: { entry: ControlProductEntry } | null;
  pendingAdmission?: { entries?: readonly ControlProductEntry[] };
  transition?: { entries?: readonly ControlProductEntry[] };
}): string {
  const entryMetadata = (entry: ControlProductEntry) => {
    const reference = entry.content.reference;
    return 'representation' in reference
      ? { ...entry, content: { ...entry.content, reference: { ...reference, body: '' } } }
      : entry;
  };
  const entriesMetadata = (input: { entries?: readonly ControlProductEntry[] }) => ({
    ...input,
    ...(input.entries && {
      entries: input.entries.map(entryMetadata),
    }),
  });
  return JSON.stringify({
    ...entriesMetadata(value),
    // Existing compound owners carry bounded bodies at these fixed packet paths.
    ...(value.terminal && { terminal: entriesMetadata(value.terminal) }),
    ...(value.admission && { admission: entriesMetadata(value.admission) }),
    ...(value.pendingItem && {
      pendingItem: { ...value.pendingItem, entry: entryMetadata(value.pendingItem.entry) },
    }),
    ...(value.pendingAdmission && { pendingAdmission: entriesMetadata(value.pendingAdmission) }),
    ...(value.transition && { transition: entriesMetadata(value.transition) }),
  });
}

/** Closed existing Item/event admissions; each category keeps its accepted equality rule. */
export const ControlPublicationInputSchema = z
  .object({
    category: z.enum(['already-decided-publication', 'display-projection-refresh']),
    turnId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    entries: z.array(ControlProductEntrySchema).min(1).max(CONTROL_PRODUCT_LIMITS.entries),
  })
  .strict();
/** Entry-only publication; no metadata or outcome mutation is admitted. */
export type ControlPublicationInput = z.infer<typeof ControlPublicationInputSchema>;

/** Complete addressed Item intent; heads and durable bytes are resolved by the native owner. */
export const ControlItemAppendSchema = z
  .object({
    item: ItemSchema,
    category: ControlPublicationInputSchema.shape.category.optional(),
  })
  .strict();
export type ControlItemAppend = z.infer<typeof ControlItemAppendSchema>;

/** Closed original command partitions whose terminal publication can own their receipt. */
const terminalReceiptSchema = z
  .object({
    key: z.string().min(1),
    command: z.enum([
      'conversation.submit',
      'task.start',
      'turn.start',
      'turn.input.submit',
      'turn.interrupt',
      'knowledge.tell',
      'knowledge.maintain',
      'knowledge.server.tell',
      'knowledge.server.maintain',
    ] satisfies readonly CommandRequestName[]),
    requestId: RequestIdSchema,
    scope: z.record(z.string(), z.string()),
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    response: z
      .object({
        kind: z.string().min(1),
        id: z.string().min(1),
        conversationMetadata: z.unknown().optional(),
      })
      .strict(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

const terminalCommandSchema = z
  .object({
    receipt: terminalReceiptSchema,
    audit: AuditEventSchema.extend({
      createdAt: z.string().datetime(),
      occurredAt: z.string().datetime(),
    }),
  })
  .strict();

/** Complete local terminal tuple. Null execution means no native execution, not proof of release. */
export const ControlTerminalTransitionSchema = z
  .object({
    owner: z.union([
      StoredWorkOwnerV1Schema.options[0].strict(),
      StoredWorkOwnerV1Schema.options[1].strict(),
    ]),
    turn: ControlProductMutationSchema.extend({ kind: z.literal('turn') }),
    products: z.array(ControlProductMutationSchema).max(CONTROL_PRODUCT_LIMITS.entries),
    entries: z.array(ControlProductEntrySchema).min(1).max(CONTROL_PRODUCT_LIMITS.entries),
    pending: z
      .array(z.lazy(() => ControlPendingCommandInputSchema))
      .max(CONTROL_PRODUCT_LIMITS.entries)
      .optional(),
    reap: z.object({ reason: z.string().min(1), inferredBy: z.string().min(1) }).strict(),
    evidence: z.array(StoredRuntimeEvidenceV1Schema).max(CONTROL_PRODUCT_LIMITS.entries),
    evidenceContent: z.array(fileContentSchema).max(CONTROL_PRODUCT_LIMITS.entries),
    command: terminalCommandSchema.nullable(),
    // Only the waiting internal Stop may converge with the original submission.
    interruptCommand: terminalCommandSchema
      .refine((command) => command.receipt.command === 'turn.interrupt')
      .optional(),
    execution: z
      .object({
        executionId: z.string().min(1),
        terminalStepId: z.string().min(1),
        expectedRevision: z.number().int().positive(),
        cleanupStepId: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
/** Parsed complete native terminal input; it carries facts and references, never executable callbacks. */
export type ControlTerminalTransition = z.infer<typeof ControlTerminalTransitionSchema>;

/** Original Pending command receipts; no separate execution or settlement ledger. */
export const ControlPendingReceiptSchema = z
  .object({
    key: z.string().min(1),
    command: z.enum(['approval.respond', 'user_input.answer', 'pending_request.withdraw']),
    requestId: RequestIdSchema,
    scope: z.record(z.string(), z.string()),
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    responseKind: z.enum(['approval', 'pending_request']),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
/** Complete native Pending publication packet; all immutable bytes are synchronized before SQL. */
export const ControlPendingTransitionSchema = z
  .object({
    input: z.lazy(() => ControlPendingCommandInputSchema),
    terminal: z.lazy(() => ControlTerminalTransitionSchema).optional(),
    admission: z.lazy(() => ControlAdmissionSchema).optional(),
    products: z.lazy(() =>
      z.array(ControlProductMutationSchema).max(CONTROL_PRODUCT_LIMITS.entries)
    ),
    entries: z.lazy(() => z.array(ControlProductEntrySchema).max(CONTROL_PRODUCT_LIMITS.entries)),
    receipt: z
      .object({
        original: ControlPendingReceiptSchema,
        input: z.unknown(),
        responseId: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
/** Closed Pending body and existing dependent local projections. */
export type ControlPendingTransition = z.infer<typeof ControlPendingTransitionSchema>;
