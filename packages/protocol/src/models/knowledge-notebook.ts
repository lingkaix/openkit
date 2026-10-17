import { z } from 'zod';
import { RequestIdSchema, WorkspaceIdSchema, ThreadIdSchema, TurnIdSchema } from '../common/ids.js';
import { ActorRefSchema, UserActorRefSchema } from './actor.js';

/** Exact durable notebook owner; query context and source restrictions remain independent. */
export const KnowledgeOwnerScopeSchema = z.union([
  z.object({ kind: z.literal('user'), userId: UserActorRefSchema.shape.id }).strict(),
  z.object({ kind: z.literal('workspace'), workspaceId: WorkspaceIdSchema }).strict(),
  z.object({ kind: z.literal('server') }).strict(),
]);

/** Existing notebook owner resolved by current operation admission, never a model-supplied root. */
export type KnowledgeOwnerScope = z.infer<typeof KnowledgeOwnerScopeSchema>;

/** The native maintenance outcome retained on its existing terminal Status Item and returned on command replay. */
export const KnowledgeMaintenanceOutcomeSchema = z.object({
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  outcome: z.enum(['published', 'review-required', 'no-change', 'skipped', 'failed']),
  notebookRevision: z.string().min(1),
  candidateRevision: z.string().min(1).optional(),
  proposalId: z.string().min(1).optional(),
  summary: z.string().min(1),
}).strict();

/** Exact SHA-256 content identity, distinct from an opaque Git notebook revision. */
export const KnowledgeContentDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Historical direct instruction or exact required-review candidate; neither is a reusable permission. */
export const KnowledgeNotebookAuthoritySchema = z.union([
  z.object({ kind: z.literal('direct'), instructionReference: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('proposal'), proposalId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('delegated'),
      settingReference: z.string().min(1),
      settingDigest: KnowledgeContentDigestSchema,
    })
    .strict(),
]);

/** Complete service-serialized commit message for the initial explicit human editing path. */
export const KnowledgeNotebookCommitMetadataSchema = z
  .object({
    summary: z.string().refine((value) => new TextEncoder().encode(value).length <= 4096),
    changeRequest: z
      .object({ requestId: z.string().min(1), inputDigest: KnowledgeContentDigestSchema })
      .strict(),
    producer: ActorRefSchema,
    authority: KnowledgeNotebookAuthoritySchema,
    sourceReferences: z.array(z.string().min(1)),
  })
  .strict();

/** Specific existing-Audit facts that must persist before the notebook ref can advance. */
export const KnowledgeNotebookAdmissionSchema = z
  .object({
    ownerScope: KnowledgeOwnerScopeSchema,
    requestId: RequestIdSchema,
    inputDigest: KnowledgeContentDigestSchema,
    baseRevision: z.string().min(1).nullable(),
    candidateRevision: z.string().min(1),
    producer: ActorRefSchema,
    authority: KnowledgeNotebookAuthoritySchema,
    sourceReferences: z.array(z.string().min(1)),
  })
  .strict();

/** Exact typed pre-publication evidence in the existing Audit family. */
export type KnowledgeNotebookAdmission = z.infer<typeof KnowledgeNotebookAdmissionSchema>;
