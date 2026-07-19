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
export const ArtifactContentSchema = z.object({
  format: z.enum(['markdown', 'text', 'json']),
  body: z.string().min(1),
});

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
