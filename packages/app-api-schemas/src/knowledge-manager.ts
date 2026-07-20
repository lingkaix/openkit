import { ActorRefSchema, RequestIdSchema, TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';
import { addRawSecretIssues } from './raw-secrets.js';

const obviousKnowledgeProposalHostPathPattern =
  /(?:^|[\s"'`(])(?:\/(?:Users|home)\/\S+|~\/\S+|[A-Za-z]:[\\/]\S+|\\\\[^\\\s]+\\[^\\\s]+(?:\\\S*)?)/;

/** Returns whether proposal text exposes one bounded obvious local host path shape. */
function containsObviousKnowledgeProposalHostPath(value: string): boolean {
  return obviousKnowledgeProposalHostPathPattern.test(value);
}

/** Non-empty proposal text without supported raw credential or local-home path canaries. */
const KnowledgeProposalSafeTextSchema = z
  .string()
  .min(1)
  .refine((value) => !containsObviousKnowledgeProposalHostPath(value), {
    message: 'Knowledge Proposal text must not expose an absolute host path.',
  })
  .superRefine((value, context) => addRawSecretIssues(value, context, []));

/** Server-assigned semantic owner of one Knowledge Manager invocation path. */
export const KnowledgeManagerCallerSchema = z.enum(['assistant', 'task-mode', 'app-api']);

/** Workspace knowledge source material category. */
export const KnowledgeSourceKindSchema = z.enum([
  'upload',
  'url',
  'document',
  'transcript',
  'code',
]);

/** Registered workspace knowledge source identity. */
export const KnowledgeSourceSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  kind: KnowledgeSourceKindSchema,
  title: z.string().min(1),
  uri: z.string().min(1).nullable(),
  contentDigest: z.string().min(1),
  originatingThreadId: z.string().min(1).nullable(),
  originatingTurnId: z.string().min(1).nullable(),
  originatingFileId: z.string().min(1).nullable(),
  capturedAt: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

/** Derived representation metadata for one workspace knowledge source. */
export const KnowledgeSourceDerivedRepresentationSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  sourceId: z.string().min(1),
  kind: z.literal('text'),
  path: z.string().min(1),
  materialPath: z.string().min(1),
  contentDigest: z.string().min(1),
  sourceContentDigest: z.string().min(1),
  createdAt: z.string().min(1),
});

/** Request body for explicit Knowledge Source registration. */
export const RegisterKnowledgeSourceRequestSchema = z
  .object({
    requestId: z.string().min(1),
    kind: KnowledgeSourceKindSchema,
    title: z.string().min(1),
    content: z.string().min(1),
    uri: z.string().min(1).optional(),
    originatingThreadId: z.string().min(1).optional(),
    originatingTurnId: z.string().min(1).optional(),
    originatingFileId: z.string().min(1).optional(),
  })
  .strict();

/** Response returned after registering one Knowledge Source. */
export const RegisterKnowledgeSourceResponseSchema = z.object({
  source: KnowledgeSourceSchema,
  derivedRepresentations: z.array(KnowledgeSourceDerivedRepresentationSchema),
});

/** Response returned when listing Knowledge Sources. */
export const ListKnowledgeSourcesResponseSchema = z.object({
  items: z.array(KnowledgeSourceSchema),
});

/** Response returned when reading one Knowledge Source. */
export const ReadKnowledgeSourceResponseSchema = z.object({
  source: KnowledgeSourceSchema,
  derivedRepresentations: z.array(KnowledgeSourceDerivedRepresentationSchema),
});

/** Workspace maintenance observation category. */
export const KnowledgeObservationKindSchema = z.enum([
  'retrieval',
  'source',
  'maintenance',
  'agent',
  'user-feedback',
]);

/** Workspace maintenance observation lifecycle status. */
export const KnowledgeObservationStatusSchema = z.enum([
  'retained',
  'promoted',
  'expired',
  'archived',
]);

/** File-backed workspace Knowledge Store observation ledger row. */
export const KnowledgeObservationSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  kind: KnowledgeObservationKindSchema,
  summary: z.string().min(1),
  sourceReferences: z.array(z.string().min(1)),
  scope: z.string().min(1),
  producer: z.string().min(1),
  confidence: z.number().min(0).max(1),
  freshness: z.enum(['current', 'stale', 'unknown']),
  status: KnowledgeObservationStatusSchema,
  observedAt: z.string().min(1),
  createdAt: z.string().min(1),
});

/** Request body for appending one Knowledge Store observation. */
export const RecordKnowledgeObservationRequestSchema = z.object({
  requestId: z.string().min(1),
  kind: KnowledgeObservationKindSchema,
  summary: z.string().min(1),
  sourceReferences: z.array(z.string().min(1)).default([]),
  scope: z.string().min(1).default('workspace'),
  producer: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.5),
  freshness: z.enum(['current', 'stale', 'unknown']).default('current'),
  status: KnowledgeObservationStatusSchema.default('retained'),
  observedAt: z.string().min(1).optional(),
});

/** Response returned after appending one Knowledge Store observation. */
export const RecordKnowledgeObservationResponseSchema = z.object({
  observation: KnowledgeObservationSchema,
});

/** Response returned when listing Knowledge Store observations. */
export const ListKnowledgeObservationsResponseSchema = z.object({
  items: z.array(KnowledgeObservationSchema),
});

/** Workspace Knowledge Claim freshness state. */
export const KnowledgeClaimFreshnessSchema = z.enum(['current', 'stale', 'unknown']);

/** Workspace Knowledge Claim review state. */
export const KnowledgeClaimReviewStateSchema = z.enum([
  'needs-review',
  'accepted',
  'rejected',
  'deferred',
]);

/** Workspace Knowledge Claim conflict status. */
export const KnowledgeClaimConflictStatusSchema = z.enum([
  'none',
  'conflicting',
  'weak_evidence',
  'stale',
  'superseded',
  'partially_superseded',
]);

/** File-backed workspace Knowledge Store claim ledger row. */
export const KnowledgeClaimSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  statement: z.string().min(1),
  sourceReferences: z.array(z.string().min(1)),
  scope: z.string().min(1),
  producer: z.string().min(1),
  confidence: z.number().min(0).max(1),
  freshness: KnowledgeClaimFreshnessSchema,
  reviewState: KnowledgeClaimReviewStateSchema,
  conflictStatus: KnowledgeClaimConflictStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

/** Request body for appending one Knowledge Store claim. */
export const RecordKnowledgeClaimRequestSchema = z.object({
  requestId: z.string().min(1),
  statement: z.string().min(1),
  sourceReferences: z.array(z.string().min(1)).default([]),
  scope: z.string().min(1).default('workspace'),
  producer: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.5),
  freshness: KnowledgeClaimFreshnessSchema.default('current'),
  reviewState: KnowledgeClaimReviewStateSchema.default('needs-review'),
  conflictStatus: KnowledgeClaimConflictStatusSchema.default('none'),
});

/** Response returned after appending one Knowledge Store claim. */
export const RecordKnowledgeClaimResponseSchema = z.object({
  claim: KnowledgeClaimSchema,
});

/** Response returned when listing Knowledge Store claims. */
export const ListKnowledgeClaimsResponseSchema = z.object({
  items: z.array(KnowledgeClaimSchema),
});

/** Workspace Knowledge Conflict status. */
export const KnowledgeConflictStatusSchema = z.enum([
  'conflicting',
  'needs_review',
  'weak_evidence',
  'stale',
  'resolved',
  'superseded',
  'partially_superseded',
]);

/** Status allowed when initially recording one Knowledge Store conflict. */
export const RecordKnowledgeConflictStatusSchema = z.enum([
  'conflicting',
  'needs_review',
  'weak_evidence',
  'stale',
  'superseded',
  'partially_superseded',
]);

/** File-backed workspace Knowledge Store conflict ledger row. */
export const KnowledgeConflictSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  subjectReferences: z.array(z.string().min(1)).min(1),
  sourceReferences: z.array(z.string().min(1)),
  status: KnowledgeConflictStatusSchema,
  summary: z.string().min(1),
  suggestedActions: z.array(z.string().min(1)),
  producer: z.string().min(1),
  resolution: z.string().min(1).optional(),
  resolvedAt: z.string().min(1).optional(),
  resolvedBy: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

/** Request body for appending one Knowledge Store conflict. */
export const RecordKnowledgeConflictRequestSchema = z.object({
  requestId: z.string().min(1),
  subjectReferences: z.array(z.string().min(1)).min(1),
  sourceReferences: z.array(z.string().min(1)).default([]),
  status: RecordKnowledgeConflictStatusSchema.default('conflicting'),
  summary: z.string().min(1),
  suggestedActions: z.array(z.string().min(1)).default([]),
  producer: z.string().min(1),
});

/** Response returned after appending one Knowledge Store conflict. */
export const RecordKnowledgeConflictResponseSchema = z.object({
  conflict: KnowledgeConflictSchema,
});

/** Request body for resolving one Knowledge Store conflict. */
export const ResolveKnowledgeConflictRequestSchema = z.object({
  requestId: z.string().min(1),
  status: z.enum(['resolved', 'superseded', 'partially_superseded']).default('resolved'),
  resolution: z.string().min(1),
  resolvedBy: z.string().min(1),
});

/** Response returned after resolving one Knowledge Store conflict. */
export const ResolveKnowledgeConflictResponseSchema = z.object({
  conflict: KnowledgeConflictSchema,
});

/** Response returned when listing Knowledge Store conflicts. */
export const ListKnowledgeConflictsResponseSchema = z.object({
  items: z.array(KnowledgeConflictSchema),
});

/** Conformance level reached by one file-backed Knowledge Store page. */
export const KnowledgeConformanceSchema = z.enum([
  'invalid',
  'OKF-compatible',
  'OpenKit-profile-valid',
  'Workspace-schema-valid',
]);

/** Validation error returned for one file-backed Knowledge Store page. */
export const KnowledgeValidationErrorSchema = z.object({
  code: z.string().min(1),
  field: z.string().min(1).optional(),
  message: z.string().min(1),
});

/** Directed Markdown link edge between Knowledge Store concepts. */
export const KnowledgeLinkEdgeSchema = z.object({
  fromId: z.string().min(1),
  target: z.string().min(1),
  toId: z.string().min(1),
  resolved: z.boolean(),
});

/** Derived Knowledge Store Markdown link graph. */
export const KnowledgeLinkGraphSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: z.string().min(1),
  rebuiltAt: z.string().min(1),
  edges: z.array(KnowledgeLinkEdgeSchema),
});

/** Validation report for one file-backed Knowledge Store page. */
export const KnowledgeValidationRecordSchema = z.object({
  conceptId: z.string().min(1),
  path: z.string().min(1),
  title: z.string().min(1).optional(),
  conformance: KnowledgeConformanceSchema,
  active: z.boolean(),
  indexed: z.boolean(),
  errors: z.array(KnowledgeValidationErrorSchema),
});

/** Derived Knowledge Store validation report. */
export const KnowledgeValidationIndexSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: z.string().min(1),
  rebuiltAt: z.string().min(1),
  records: z.array(KnowledgeValidationRecordSchema),
});

/** Source-reference classification in the derived Knowledge Store index. */
export const KnowledgeSourceReferenceKindSchema = z.enum([
  'registered-source',
  'workspace-knowledge',
  'external-reference',
]);

/** Source reference declared by one file-backed Knowledge Store page. */
export const KnowledgeSourceReferenceSchema = z.object({
  conceptId: z.string().min(1),
  path: z.string().min(1),
  reference: z.string().min(1),
  kind: KnowledgeSourceReferenceKindSchema,
  targetId: z.string().min(1).nullable(),
  resolved: z.boolean(),
});

/** Derived Knowledge Store source-reference index. */
export const KnowledgeSourceReferenceIndexSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: z.string().min(1),
  rebuiltAt: z.string().min(1),
  references: z.array(KnowledgeSourceReferenceSchema),
});

/** Full-text posting for one Knowledge Store concept. */
export const KnowledgeFullTextPostingSchema = z.object({
  conceptId: z.string().min(1),
  fields: z.array(z.enum(['title', 'body'])),
  occurrences: z.number().int().positive(),
});

/** Full-text term and postings for Knowledge Store retrieval. */
export const KnowledgeFullTextTermSchema = z.object({
  term: z.string().min(1),
  postings: z.array(KnowledgeFullTextPostingSchema),
});

/** Derived Knowledge Store full-text index. */
export const KnowledgeFullTextIndexSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: z.string().min(1),
  rebuiltAt: z.string().min(1),
  tokenizer: z.literal('unicode-simple-v1'),
  terms: z.array(KnowledgeFullTextTermSchema),
});

/** Response returned when reading Knowledge Store derived indexes. */
export const KnowledgeDerivedIndexesResponseSchema = z.object({
  linkGraph: KnowledgeLinkGraphSchema,
  validation: KnowledgeValidationIndexSchema,
  sourceReferences: KnowledgeSourceReferenceIndexSchema,
  fullText: KnowledgeFullTextIndexSchema,
});

/** Request body for deterministic Knowledge Store retrieval with trace persistence. */
export const RetrieveKnowledgeRequestSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(20).default(5),
  pinnedConceptIds: z.array(z.string().min(1)).default([]),
});

/** Canonical server-generated identity of one governed Knowledge retrieval trace. */
const KnowledgeRetrievalTraceIdSchema = z
  .string()
  .regex(/^krt_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

/** Selected Knowledge Store retrieval candidate. */
export const KnowledgeRetrievalCandidateSchema = z
  .object({
    knowledgePageId: z.string().min(1),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    score: z.number().int().nonnegative(),
    sourceReferences: z.array(z.string().min(1)),
  })
  .strict();

/** Retrieval candidate excluded by one governed disposition. */
export const KnowledgeRetrievalExclusionSchema = z
  .object({
    knowledgePageId: z.string().min(1),
    contentDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    reason: z.enum([
      'sensitive_content',
      'lower_conformance',
      'policy_excluded',
      'freshness_expired',
      'budget_exceeded',
      'source_unavailable',
    ]),
  })
  .strict();

/** Response and persisted trace returned by deterministic Knowledge Store retrieval. */
export const KnowledgeRetrievalResponseSchema = z
  .object({
    traceId: KnowledgeRetrievalTraceIdSchema,
    workspaceId: z.string().min(1),
    caller: KnowledgeManagerCallerSchema,
    requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    retrievalParameters: z
      .object({
        limit: z.number().int().positive().max(20),
        pinnedConceptIds: z.array(z.string().min(1)),
      })
      .strict(),
    selected: z.array(KnowledgeRetrievalCandidateSchema),
    excluded: z.array(KnowledgeRetrievalExclusionSchema),
    createdAt: z.string().min(1),
  })
  .strict();

/** Request body for one bounded Knowledge Manager answer operation. */
export const KnowledgeManagerAnswerRequestSchema = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(10).optional(),
  })
  .strict();

/** Source citation returned by one Knowledge Manager answer. */
export const KnowledgeManagerAnswerCitationSchema = z.object({
  knowledgeEntryId: z.string().min(1),
  kind: z.enum(['preference', 'project-context', 'task-summary']),
  title: z.string().min(1),
  excerpt: z.string().min(1),
});

/** Response returned by one bounded Knowledge Manager answer operation. */
export const KnowledgeManagerAnswerResponseSchema = z.object({
  operationId: z.string().min(1),
  operation: z.literal('answer'),
  workspaceId: z.string().min(1),
  caller: KnowledgeManagerCallerSchema,
  retrievalTraceId: KnowledgeRetrievalTraceIdSchema,
  query: z.string().min(1),
  outcome: z.enum(['answered', 'insufficient-evidence']),
  answer: z.string().min(1),
  citations: z.array(KnowledgeManagerAnswerCitationSchema),
  confidence: z.number().min(0).max(1),
  uncertainty: z.string().min(1).nullable(),
});

/** Request body for one bounded Knowledge Manager context-material operation. */
export const KnowledgeManagerPrepareContextRequestSchema = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(10).optional(),
  })
  .strict();

/** Response returned by one bounded Knowledge Manager context-material operation. */
export const KnowledgeManagerPrepareContextResponseSchema = z
  .object({
    operationId: z.string().min(1),
    operation: z.literal('prepare-context-material'),
    workspaceId: z.string().min(1),
    caller: KnowledgeManagerCallerSchema,
    retrievalTraceId: KnowledgeRetrievalTraceIdSchema,
    outcome: z.enum(['prepared', 'insufficient-evidence']),
    selected: z.array(KnowledgeRetrievalCandidateSchema),
    excluded: z.array(KnowledgeRetrievalExclusionSchema),
  })
  .strict();

/** Safe create-only Knowledge Page identity carried by proposal commands. */
export const KnowledgeProposalPageIdSchema = z
  .string()
  .max(240)
  .regex(/^(?!index$|log$)[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63})*$/);

/** Lowercase SHA-256 digest over exact canonical Knowledge content bytes. */
export const KnowledgeProposalContentDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const knowledgeProposalSourceReferenceSchema = z
  .string()
  .refine(
    (reference) =>
      /^source:ks_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}@sha256:[a-f0-9]{64}$/.test(
        reference
      ) ||
      /^knowledge:(?!index@|log@)[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63})*@sha256:[a-f0-9]{64}$/.test(
        reference
      ) ||
      /^(?:turn|item):[^@\s]+$/.test(reference) ||
      /^context-package:[^@\s]+@ctxpkg_sha256_[a-f0-9]{64}$/.test(reference),
    'Unsupported Knowledge Proposal source reference.'
  );

/** Request body for one governed Knowledge Manager proposal draft operation. */
export const KnowledgeManagerDraftProposalRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    knowledgePageId: KnowledgeProposalPageIdSchema,
    canonicalPageBytes: KnowledgeProposalSafeTextSchema,
    contentDigest: KnowledgeProposalContentDigestSchema,
    sourceReferences: z
      .array(knowledgeProposalSourceReferenceSchema)
      .min(1)
      .superRefine((references, context) => {
        if (
          references.some((reference, index) => index > 0 && references[index - 1]! >= reference)
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Knowledge Proposal source references must be bytewise sorted and unique.',
          });
        }
      }),
    rationale: KnowledgeProposalSafeTextSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();

/** Pending immutable create-only Knowledge Proposal projected after drafting. */
export const KnowledgeManagerDraftedProposalSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    operation: z.literal('create'),
    knowledgePageId: KnowledgeProposalPageIdSchema,
    canonicalPageBytes: KnowledgeProposalSafeTextSchema,
    contentDigest: KnowledgeProposalContentDigestSchema,
    sourceReferences: KnowledgeManagerDraftProposalRequestSchema.shape.sourceReferences,
    rationale: KnowledgeProposalSafeTextSchema,
    confidence: z.number().min(0).max(1),
    producer: ActorRefSchema,
    status: z.literal('pending'),
    createdAt: TimestampSchema,
  })
  .strict();

/** Deterministic validation result for one Knowledge Manager proposal draft. */
export const KnowledgeManagerProposalValidationSchema = z
  .object({
    conformance: z.literal('Workspace-schema-valid'),
    generatedFromCompletedWorkHistory: z.boolean(),
  })
  .strict();

/** Response returned by one governed Knowledge Manager proposal draft operation. */
export const KnowledgeManagerDraftProposalResponseSchema = z
  .object({
    operationId: z.string().min(1),
    operation: z.literal('draft-proposal'),
    workspaceId: z.string().min(1),
    caller: KnowledgeManagerCallerSchema,
    proposal: KnowledgeManagerDraftedProposalSchema,
    validation: KnowledgeManagerProposalValidationSchema,
  })
  .strict();

/** Request body for one bounded Knowledge Manager repair suggestion operation. */
export const KnowledgeManagerSuggestRepairRequestSchema = z
  .object({
    limit: z.number().int().positive().max(20).default(10),
  })
  .strict();

/** Repair suggestion returned by Knowledge Manager without applying changes. */
export const KnowledgeManagerRepairSuggestionSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('duplicate-title'),
  title: z.string().min(1),
  detail: z.string().min(1),
  affectedKnowledgeEntryIds: z.array(z.string().min(1)).min(2),
  autoApplicable: z.literal(false),
  reviewRequired: z.literal(true),
});

/** Response returned by one bounded Knowledge Manager repair suggestion operation. */
export const KnowledgeManagerSuggestRepairResponseSchema = z.object({
  operationId: z.string().min(1),
  operation: z.literal('suggest-repair'),
  workspaceId: z.string().min(1),
  caller: KnowledgeManagerCallerSchema,
  outcome: z.enum(['suggested', 'healthy']),
  suggestions: z.array(KnowledgeManagerRepairSuggestionSchema),
});

/** Request body for one bounded Knowledge Manager health-check operation. */
export const KnowledgeManagerHealthCheckRequestSchema = z
  .object({
    limit: z.number().int().positive().max(20).default(10),
  })
  .strict();

/** Individual check returned by one Knowledge Manager health report. */
export const KnowledgeManagerHealthCheckItemSchema = z.object({
  code: z.enum(['knowledge-present', 'repair-suggestions']),
  status: z.enum(['pass', 'warn']),
  detail: z.string().min(1),
});

/** Response returned by one bounded Knowledge Manager health-check operation. */
export const KnowledgeManagerHealthCheckResponseSchema = z.object({
  operationId: z.string().min(1),
  operation: z.literal('health-check'),
  workspaceId: z.string().min(1),
  caller: KnowledgeManagerCallerSchema,
  outcome: z.enum(['healthy', 'needs-attention']),
  summary: z.string().min(1),
  checks: z.array(KnowledgeManagerHealthCheckItemSchema),
  repairSuggestions: z.array(KnowledgeManagerRepairSuggestionSchema),
});

/** Request body for one bounded Knowledge Manager answer operation. */
export type KnowledgeManagerAnswerRequest = z.infer<typeof KnowledgeManagerAnswerRequestSchema>;
/** Response returned by one bounded Knowledge Manager answer operation. */
export type KnowledgeManagerAnswerResponse = z.infer<typeof KnowledgeManagerAnswerResponseSchema>;
/** Request body for one bounded Knowledge Manager context-material operation. */
export type KnowledgeManagerPrepareContextRequest = z.infer<
  typeof KnowledgeManagerPrepareContextRequestSchema
>;
/** Response returned by one bounded Knowledge Manager context-material operation. */
export type KnowledgeManagerPrepareContextResponse = z.infer<
  typeof KnowledgeManagerPrepareContextResponseSchema
>;
/** Request body for one governed Knowledge Manager proposal draft operation. */
export type KnowledgeManagerDraftProposalRequest = z.infer<
  typeof KnowledgeManagerDraftProposalRequestSchema
>;
/** Response returned by one governed Knowledge Manager proposal draft operation. */
export type KnowledgeManagerDraftProposalResponse = z.infer<
  typeof KnowledgeManagerDraftProposalResponseSchema
>;
/** Request body for one bounded Knowledge Manager repair suggestion operation. */
export type KnowledgeManagerSuggestRepairRequest = z.infer<
  typeof KnowledgeManagerSuggestRepairRequestSchema
>;
/** Response returned by one bounded Knowledge Manager repair suggestion operation. */
export type KnowledgeManagerSuggestRepairResponse = z.infer<
  typeof KnowledgeManagerSuggestRepairResponseSchema
>;
/** Request body for one bounded Knowledge Manager health-check operation. */
export type KnowledgeManagerHealthCheckRequest = z.infer<
  typeof KnowledgeManagerHealthCheckRequestSchema
>;
/** Response returned by one bounded Knowledge Manager health-check operation. */
export type KnowledgeManagerHealthCheckResponse = z.infer<
  typeof KnowledgeManagerHealthCheckResponseSchema
>;
/** Workspace knowledge source material category. */
export type KnowledgeSourceKind = z.infer<typeof KnowledgeSourceKindSchema>;
/** Registered workspace knowledge source identity. */
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;
/** Derived representation metadata for one workspace knowledge source. */
export type KnowledgeSourceDerivedRepresentation = z.infer<
  typeof KnowledgeSourceDerivedRepresentationSchema
>;
/** Request body for explicit Knowledge Source registration. */
export type RegisterKnowledgeSourceRequest = z.infer<typeof RegisterKnowledgeSourceRequestSchema>;
/** Response returned after registering one Knowledge Source. */
export type RegisterKnowledgeSourceResponse = z.infer<typeof RegisterKnowledgeSourceResponseSchema>;
/** Response returned when listing Knowledge Sources. */
export type ListKnowledgeSourcesResponse = z.infer<typeof ListKnowledgeSourcesResponseSchema>;
/** Response returned when reading one Knowledge Source. */
export type ReadKnowledgeSourceResponse = z.infer<typeof ReadKnowledgeSourceResponseSchema>;
/** Workspace maintenance observation category. */
export type KnowledgeObservationKind = z.infer<typeof KnowledgeObservationKindSchema>;
/** Workspace maintenance observation lifecycle status. */
export type KnowledgeObservationStatus = z.infer<typeof KnowledgeObservationStatusSchema>;
/** File-backed workspace Knowledge Store observation ledger row. */
export type KnowledgeObservation = z.infer<typeof KnowledgeObservationSchema>;
/** Request body for appending one Knowledge Store observation. */
export type RecordKnowledgeObservationRequest = z.infer<
  typeof RecordKnowledgeObservationRequestSchema
>;
/** Response returned after appending one Knowledge Store observation. */
export type RecordKnowledgeObservationResponse = z.infer<
  typeof RecordKnowledgeObservationResponseSchema
>;
/** Response returned when listing Knowledge Store observations. */
export type ListKnowledgeObservationsResponse = z.infer<
  typeof ListKnowledgeObservationsResponseSchema
>;
/** Workspace Knowledge Claim freshness state. */
export type KnowledgeClaimFreshness = z.infer<typeof KnowledgeClaimFreshnessSchema>;
/** Workspace Knowledge Claim review state. */
export type KnowledgeClaimReviewState = z.infer<typeof KnowledgeClaimReviewStateSchema>;
/** Workspace Knowledge Claim conflict status. */
export type KnowledgeClaimConflictStatus = z.infer<typeof KnowledgeClaimConflictStatusSchema>;
/** File-backed workspace Knowledge Store claim ledger row. */
export type KnowledgeClaim = z.infer<typeof KnowledgeClaimSchema>;
/** Request body for appending one Knowledge Store claim. */
export type RecordKnowledgeClaimRequest = z.input<typeof RecordKnowledgeClaimRequestSchema>;
/** Response returned after appending one Knowledge Store claim. */
export type RecordKnowledgeClaimResponse = z.infer<typeof RecordKnowledgeClaimResponseSchema>;
/** Response returned when listing Knowledge Store claims. */
export type ListKnowledgeClaimsResponse = z.infer<typeof ListKnowledgeClaimsResponseSchema>;
/** Workspace Knowledge Conflict status. */
export type KnowledgeConflictStatus = z.infer<typeof KnowledgeConflictStatusSchema>;
/** File-backed workspace Knowledge Store conflict ledger row. */
export type KnowledgeConflict = z.infer<typeof KnowledgeConflictSchema>;
/** Request body for appending one Knowledge Store conflict. */
export type RecordKnowledgeConflictRequest = z.input<typeof RecordKnowledgeConflictRequestSchema>;
/** Response returned after appending one Knowledge Store conflict. */
export type RecordKnowledgeConflictResponse = z.infer<typeof RecordKnowledgeConflictResponseSchema>;
/** Request body for resolving one Knowledge Store conflict. */
export type ResolveKnowledgeConflictRequest = z.input<typeof ResolveKnowledgeConflictRequestSchema>;
/** Response returned after resolving one Knowledge Store conflict. */
export type ResolveKnowledgeConflictResponse = z.infer<
  typeof ResolveKnowledgeConflictResponseSchema
>;
/** Response returned when listing Knowledge Store conflicts. */
export type ListKnowledgeConflictsResponse = z.infer<typeof ListKnowledgeConflictsResponseSchema>;
/** Conformance level reached by one file-backed Knowledge Store page. */
export type KnowledgeConformance = z.infer<typeof KnowledgeConformanceSchema>;
/** Validation error returned for one file-backed Knowledge Store page. */
export type KnowledgeValidationError = z.infer<typeof KnowledgeValidationErrorSchema>;
/** Directed Markdown link edge between Knowledge Store concepts. */
export type KnowledgeLinkEdge = z.infer<typeof KnowledgeLinkEdgeSchema>;
/** Derived Knowledge Store Markdown link graph. */
export type KnowledgeLinkGraph = z.infer<typeof KnowledgeLinkGraphSchema>;
/** Validation report for one file-backed Knowledge Store page. */
export type KnowledgeValidationRecord = z.infer<typeof KnowledgeValidationRecordSchema>;
/** Derived Knowledge Store validation report. */
export type KnowledgeValidationIndex = z.infer<typeof KnowledgeValidationIndexSchema>;
/** Source-reference classification in the derived Knowledge Store index. */
export type KnowledgeSourceReferenceKind = z.infer<typeof KnowledgeSourceReferenceKindSchema>;
/** Source reference declared by one file-backed Knowledge Store page. */
export type KnowledgeSourceReference = z.infer<typeof KnowledgeSourceReferenceSchema>;
/** Derived Knowledge Store source-reference index. */
export type KnowledgeSourceReferenceIndex = z.infer<typeof KnowledgeSourceReferenceIndexSchema>;
/** Full-text posting for one Knowledge Store concept. */
export type KnowledgeFullTextPosting = z.infer<typeof KnowledgeFullTextPostingSchema>;
/** Full-text term and postings for Knowledge Store retrieval. */
export type KnowledgeFullTextTerm = z.infer<typeof KnowledgeFullTextTermSchema>;
/** Derived Knowledge Store full-text index. */
export type KnowledgeFullTextIndex = z.infer<typeof KnowledgeFullTextIndexSchema>;
/** Response returned when reading Knowledge Store derived indexes. */
export type KnowledgeDerivedIndexesResponse = z.infer<typeof KnowledgeDerivedIndexesResponseSchema>;
/** Request body accepted for deterministic Knowledge Store retrieval with trace persistence. */
export type RetrieveKnowledgeRequest = z.input<typeof RetrieveKnowledgeRequestSchema>;
/** Selected Knowledge Store retrieval candidate. */
export type KnowledgeRetrievalCandidate = z.infer<typeof KnowledgeRetrievalCandidateSchema>;
/** Retrieval candidate excluded from the selected context budget. */
export type KnowledgeRetrievalExclusion = z.infer<typeof KnowledgeRetrievalExclusionSchema>;
/** Response and persisted trace returned by deterministic Knowledge Store retrieval. */
export type KnowledgeRetrievalResponse = z.infer<typeof KnowledgeRetrievalResponseSchema>;
