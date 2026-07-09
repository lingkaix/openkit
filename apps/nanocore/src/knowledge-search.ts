import type { KnowledgeEntrySchema } from '@openkit/protocol';
import type { z } from 'zod';

/** Workspace knowledge entry type used by NanoCore knowledge helpers. */
export type WorkspaceKnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

/**
 * Searches workspace knowledge entries using a bounded case-insensitive substring match.
 *
 * @param entries Candidate knowledge entries.
 * @param query Search query.
 * @param limit Maximum number of entries to return.
 * @returns Matching knowledge entries.
 */
export function searchKnowledgeEntries(
  entries: readonly WorkspaceKnowledgeEntry[],
  query: string,
  limit: number
): WorkspaceKnowledgeEntry[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return [];
  }

  return entries
    .filter((entry) => {
      const normalizedTitle = entry.title.toLowerCase();

      return (
        normalizedTitle.includes(normalizedQuery) ||
        normalizedQuery.includes(normalizedTitle) ||
        entry.content.toLowerCase().includes(normalizedQuery)
      );
    })
    .slice(0, limit);
}
