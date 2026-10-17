import { z } from 'zod';

import {
  ArtifactIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '../common/ids.js';
import { TimestampSchema } from '../common/timestamps.js';
import { ActorRefSchema } from './actor.js';

/** Lowercase SHA-256 digest over exact canonical content bytes. */
const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/**
 * Inline artifact content payload.
 */
export const ArtifactInlineContentSchema = z.object({
  format: z.enum(['markdown', 'text', 'json']),
  body: z.string().min(1),
});

/** Decimal byte bound for one upload submission or one Worker-produced file. */
export const MAX_ARTIFACT_FILE_BYTES = 1_000_000_000;

/** Safe media type metadata; content bytes are never interpreted from this label. */
export const ArtifactMediaTypeSchema = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/);

/** Exact original stored outside the protocol record, including empty and binary files. */
export const ArtifactFileContentSchema = z.object({
  format: z.literal('file'),
  mediaType: ArtifactMediaTypeSchema,
  byteLength: z.number().int().min(0).max(MAX_ARTIFACT_FILE_BYTES),
});

/** Retained inline content or a version-owned immutable original file. */
export const ArtifactContentSchema = z.discriminatedUnion('format', [
  ArtifactInlineContentSchema,
  ArtifactFileContentSchema,
]);

/** Immutable provenance for either a work-produced or directly imported Artifact. */
export const ArtifactOriginSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('turn-output'),
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    requestId: z.string().min(1),
  }),
  z
    .object({
      kind: z.literal('imported'),
      sourceKind: z.literal('direct-import'),
      sourceId: z.string().min(1),
      sourceDigest: Sha256DigestSchema,
      actor: ActorRefSchema,
      requestId: z.string().min(1),
      recordedAt: TimestampSchema,
    })
    .strict(),
]);

/**
 * Durable user-visible output whose Thread and Turn lineage is governed by its origin.
 */
export const ArtifactSchema = z
  .object({
    id: ArtifactIdSchema,
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema.nullable(),
    turnId: TurnIdSchema.nullable(),
    kind: z.enum(['report', 'diff', 'file', 'summary']),
    title: z.string().min(1),
    status: z.enum(['draft', 'ready', 'archived']),
    summary: z.string().nullable(),
    version: z.number().int().positive(),
    content: ArtifactContentSchema,
    contentDigest: Sha256DigestSchema,
    lastMutationRequestId: z.string().min(1),
    origin: ArtifactOriginSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .superRefine((artifact, context) => {
    if (artifact.origin.kind === 'turn-output') {
      if (
        artifact.threadId !== artifact.origin.threadId ||
        artifact.turnId !== artifact.origin.turnId
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Turn-output Artifact lineage must match its immutable origin.',
          path: ['origin'],
        });
      }
    } else {
      if (artifact.threadId !== null || artifact.turnId !== null) {
        context.addIssue({
          code: 'custom',
          message: 'Imported Artifacts cannot own Thread or Turn lineage.',
          path: ['origin'],
        });
      }
      if (artifact.origin.sourceId !== artifact.origin.requestId) {
        context.addIssue({
          code: 'custom',
          message: 'Imported Artifact source identity must equal its import request identity.',
          path: ['origin', 'sourceId'],
        });
      }
      if (artifact.version === 1 && artifact.origin.sourceDigest !== artifact.contentDigest) {
        context.addIssue({
          code: 'custom',
          message: 'Imported Artifact version 1 must preserve its accepted source digest.',
          path: ['origin', 'sourceDigest'],
        });
      }
    }

    if (artifact.version === 1 && artifact.lastMutationRequestId !== artifact.origin.requestId) {
      context.addIssue({
        code: 'custom',
        message: 'Artifact version 1 mutation proof must equal its origin request identity.',
        path: ['lastMutationRequestId'],
      });
    }
  });

/** Immutable version identity and producing lineage, separate from the Artifact's original origin. */
export const ArtifactVersionSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    workspaceId: WorkspaceIdSchema,
    artifactVersion: z.number().int().positive(),
    parentVersion: z.number().int().positive().nullable(),
    title: z.string().min(1),
    summary: z.string().nullable(),
    contentDigest: Sha256DigestSchema,
    actor: ActorRefSchema,
    threadId: ThreadIdSchema.nullable(),
    turnId: TurnIdSchema.nullable(),
    requestId: z.string().min(1),
    recordedAt: TimestampSchema,
  })
  .superRefine((version, context) => {
    if (
      version.parentVersion !== (version.artifactVersion === 1 ? null : version.artifactVersion - 1)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['parentVersion'],
        message: 'An Artifact version must identify its exact preceding version.',
      });
    }
    if (
      (version.threadId === null) !== (version.turnId === null) ||
      (version.artifactVersion > 1 && version.turnId === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['turnId'],
        message: 'A work-produced Artifact version requires complete producing lineage.',
      });
    }
  });

/** One exact retained Artifact state and the immutable metadata that identifies its commit. */
export const ArtifactVersionRecordSchema = z
  .object({ artifact: ArtifactSchema, version: ArtifactVersionSchema })
  .superRefine(({ artifact, version }, context) => {
    if (
      artifact.id !== version.artifactId ||
      artifact.workspaceId !== version.workspaceId ||
      artifact.version !== version.artifactVersion ||
      artifact.contentDigest !== version.contentDigest ||
      artifact.title !== version.title ||
      artifact.summary !== version.summary ||
      artifact.lastMutationRequestId !== version.requestId ||
      artifact.updatedAt !== version.recordedAt ||
      (artifact.version === 1 &&
        artifact.origin.kind === 'turn-output' &&
        (artifact.origin.threadId !== version.threadId ||
          artifact.origin.turnId !== version.turnId)) ||
      (artifact.version === 1 &&
        artifact.origin.kind === 'imported' &&
        (version.threadId !== null ||
          version.turnId !== null ||
          version.recordedAt !== artifact.origin.recordedAt ||
          JSON.stringify(version.actor) !== JSON.stringify(artifact.origin.actor)))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['version'],
        message: 'Artifact version metadata must match its exact retained Artifact state.',
      });
    }
  });

/** Immutable Artifact version metadata shared by native and product readers. */
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;

/** Exact retained Artifact state and producing lineage. */
export type ArtifactVersionRecord = z.infer<typeof ArtifactVersionRecordSchema>;
