import { isDeepStrictEqual } from 'node:util';
import { KnowledgeSourceSchema } from '@openkit/app-api-schemas';
import { KnowledgeContentReferenceSchema } from '@openkit/protocol';
import { z } from 'zod';
import { NotebookError } from './notebook-error.js';
import { parseOkfDocument } from './okf.js';

/** Existing Source metadata, projected from the sole Notebook pointer rather than a registry. */
export const SourceMetadataSchema = KnowledgeSourceSchema.omit({ workspaceId: true }).extend({
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

/** Captured Source fields have one serialized meaning across User, Workspace and Server. */
export const SourcePointerFieldsSchema = z.object({
  contentRef: KnowledgeContentReferenceSchema.refine((reference) => reference.range === null),
  byteLength: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  sourceKind: SourceMetadataSchema.shape.kind,
  uri: SourceMetadataSchema.shape.uri,
  capturedAt: z.iso.datetime({ offset: true }),
  captureChannel: z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/),
  originatingThreadId: SourceMetadataSchema.shape.originatingThreadId,
  originatingTurnId: SourceMetadataSchema.shape.originatingTurnId,
  originatingFileId: SourceMetadataSchema.shape.originatingFileId,
});

/** Allows descriptive edits while preserving captured facts, governance and unknown extensions. */
export function assertSourcePointerEdit(before: string, after: string): void {
  const original = parseOkfDocument({ path: 'sources/source.md', content: before });
  const candidate = parseOkfDocument({ path: 'sources/source.md', content: after });
  if (!original.ok || !candidate.ok) throw new NotebookError('invalid_request');
  const protectedFields = (fields: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(fields).filter(
        ([key]) => !['title', 'description', 'tags', 'updated_at', 'review_state'].includes(key)
      )
    );
  if (
    original.document.frontmatter.type !== 'SourceSummary' ||
    !SourcePointerFieldsSchema.safeParse(candidate.document.frontmatter).success ||
    !isDeepStrictEqual(
      protectedFields(original.document.frontmatter),
      protectedFields(candidate.document.frontmatter)
    )
  )
    throw new NotebookError('invalid_request');
}
