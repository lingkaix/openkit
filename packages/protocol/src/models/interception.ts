import { z } from 'zod';
import { ScopeQualifiedReferenceSchema } from '../common/object-reference.js';
import { TimestampSchema } from '../common/timestamps.js';
import { ActorRefSchema } from './actor.js';
import { KnowledgeOwnerScopeSchema } from './knowledge-notebook.js';

/** Exact existing-owner identity and version; references never confer access. */
export const InterceptionRecordReferenceSchema = z
  .object({
    kind: z.literal('record'),
    owner: KnowledgeOwnerScopeSchema,
    family: z.string().min(1),
    id: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();

/** Safe content versions use the shared qualified reference grammar, not a transport URL. */
export const InterceptionReferenceSchema = z.union([
  InterceptionRecordReferenceSchema,
  z
    .object({
      kind: z.literal('content'),
      reference: ScopeQualifiedReferenceSchema,
      version: z.string().min(1),
    })
    .strict(),
]);

/** A participant or contract version is opaque to the product reference resolver. */
export const InterceptionContractSchema = z
  .object({ id: z.string().min(1), version: z.string().min(1) })
  .strict();

/** Accepted NanoCore points; a binding does not create an operation at a point. */
export const InterceptionPointSchema = z.enum(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);

/** Permission and mutation authority remain separate from observation and advice. */
export const InterceptionModeSchema = z.enum(['observe', 'transform', 'advise', 'gate']);

const statementFields = {
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  point: InterceptionPointSchema,
  mode: InterceptionModeSchema,
  participant: InterceptionContractSchema,
  owner: KnowledgeOwnerScopeSchema,
  subject: ActorRefSchema,
  action: z.string().min(1),
  resource: InterceptionRecordReferenceSchema,
  inputContract: InterceptionContractSchema,
  outputContract: InterceptionContractSchema,
  order: z.number().int().nonnegative(),
  timeoutMs: z.number().int().min(1).max(60_000),
  circuit: z
    .object({
      failureThreshold: z.number().int().min(1).max(100),
      resetAfterMs: z.number().int().min(1).max(3_600_000),
    })
    .strict(),
  onUnavailable: z.enum(['error', 'continue', 'pending']),
  author: ActorRefSchema,
  delegation: InterceptionRecordReferenceSchema.nullable(),
};

/** Authored Policy statement; the trusted owner supplies its source and resolved version. */
export const InterceptionStatementSchema = z
  .object(statementFields)
  .strict()
  .superRefine((value, ctx) => {
    if ((value.mode === 'gate' || value.mode === 'transform') && value.onUnavailable === 'continue')
      ctx.addIssue({
        code: 'custom',
        path: ['onUnavailable'],
        message: 'A required decision or transform cannot continue without a valid result.',
      });
  });

/** Immutable admitted statement pinned to actual source bytes by NanoCore. */
export const InterceptionBindingSchema = InterceptionStatementSchema.safeExtend({
  version: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  source: InterceptionRecordReferenceSchema,
});

/** One admitted invocation observation in an existing scoped Audit event. */
export const InterceptionInvocationSchema = z
  .object({
    schemaVersion: z.literal(1),
    binding: InterceptionBindingSchema,
    input: InterceptionReferenceSchema,
    output: InterceptionReferenceSchema.nullable(),
    actor: ActorRefSchema,
    outcome: z.enum([
      'observed',
      'transformed',
      'advised',
      'allowed',
      'refused',
      'pending',
      'unavailable',
      'error',
    ]),
    reasonCode: z.string().min(1).nullable(),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema,
  })
  .strict();

/** A configured statement has no independent storage or identity lifecycle. */
export type InterceptionStatement = z.infer<typeof InterceptionStatementSchema>;
/** A resolved Policy/config snapshot, never a grant inferred from provider output. */
export type InterceptionBinding = z.infer<typeof InterceptionBindingSchema>;
/** A safe version reference resolved only by its existing owner. */
export type InterceptionReference = z.infer<typeof InterceptionReferenceSchema>;
/** A scoped record reference with an opaque owner-defined version. */
export type InterceptionRecordReference = z.infer<typeof InterceptionRecordReferenceSchema>;
/** Typed additive data in the existing Audit event family. */
export type InterceptionInvocation = z.infer<typeof InterceptionInvocationSchema>;
