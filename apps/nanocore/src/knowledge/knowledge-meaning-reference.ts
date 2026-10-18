import type { KnowledgeRetrievalAccess } from '../retrieval-knowledge-adapter.js';

/** One request-local exact meaning read; it grants neither publication nor execution authority. */
export type KnowledgeMeaningResolution =
  | {
      readonly status: 'available';
      readonly reference: string;
      readonly notebookRevision: string;
      readonly contentDigest: string;
      readonly content: string;
    }
  | { readonly status: 'unavailable'; readonly reference: string };

/** Resolves one pinned Knowledge URI under native current caller admission, without retaining a projection. */
export function resolveKnowledgeMeaningReference(input: {
  readonly workspaceId: string;
  readonly reference: string;
  readonly access: KnowledgeRetrievalAccess;
}): KnowledgeMeaningResolution {
  return { status: 'unavailable', reference: input.reference };
}
