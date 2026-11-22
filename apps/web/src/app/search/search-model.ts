import type { AppSearchHit } from '../../screens/operations/data';
import { type NavGroup, SURFACES } from '../surfaces';

/** One palette or search-page result type (ia.md §1a). */
export type SearchGroupId = 'thread' | 'workspace' | 'artifact' | 'knowledge' | 'setting';

/** One openable result. `snippet` is matched message text when the hit is an Item. */
export interface SearchResult {
  readonly key: string;
  readonly group: SearchGroupId;
  readonly title: string;
  readonly path: string;
  /** Workspace the result belongs to; opening selects it first. */
  readonly workspaceId?: string;
  readonly snippet?: string;
}

/** Result groups in display order. */
export const SEARCH_GROUPS: readonly { id: SearchGroupId; title: string }[] = [
  { id: 'thread', title: 'Threads' },
  { id: 'workspace', title: 'Workspaces' },
  { id: 'artifact', title: 'Artifacts' },
  { id: 'knowledge', title: 'Knowledge pages' },
  { id: 'setting', title: 'Settings' },
];

const SETTINGS_GROUPS: readonly NavGroup[] = [
  'settings-workspace',
  'settings-user',
  'settings-server',
  'settings-admin',
];

/** Settings pages the sidebar lists, as search results (fixed paths only). */
export function settingsResults(): SearchResult[] {
  return SURFACES.filter(
    (surface) =>
      surface.tier === 'A' && SETTINGS_GROUPS.includes(surface.nav) && !surface.path.includes(':')
  ).map((surface) => ({
    key: `setting:${surface.id}`,
    group: 'setting',
    title: surface.title,
    path: surface.path,
  }));
}

/** Case- and accent-insensitive words of a query. */
export function queryWords(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase();
}

/** True when every query word occurs in the text. An empty query matches everything. */
export function matchesQuery(text: string, query: string): boolean {
  const haystack = fold(text);
  return queryWords(query).every((word) => haystack.includes(word));
}

/**
 * Splits text into plain and matched runs for highlighting.
 * Matching folds case only, so each run maps back to the original characters.
 */
export function highlightRuns(text: string, query: string): { text: string; match: boolean }[] {
  const words = query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (words.length === 0) return [{ text, match: false }];
  const lower = text.toLocaleLowerCase();
  const runs: { text: string; match: boolean }[] = [];
  let plainStart = 0;
  let index = 0;
  while (index < text.length) {
    const word = words.find((candidate) => lower.startsWith(candidate, index));
    if (!word) {
      index += 1;
      continue;
    }
    if (index > plainStart) runs.push({ text: text.slice(plainStart, index), match: false });
    runs.push({ text: text.slice(index, index + word.length), match: true });
    index += word.length;
    plainStart = index;
  }
  if (plainStart < text.length) runs.push({ text: text.slice(plainStart), match: false });
  return runs;
}

/** A product-safe server hit as a result, or null when it cannot be opened. */
export function resultForHit(hit: AppSearchHit, path: string): SearchResult | null {
  switch (hit.kind) {
    case 'thread':
      return hit.workspaceId
        ? {
            key: `thread:${hit.workspaceId}:${hit.id}`,
            group: 'thread',
            title: hit.title,
            path,
            workspaceId: hit.workspaceId,
          }
        : null;
    case 'item':
      // An Item hit opens its Thread; the Item text is the snippet.
      return hit.workspaceId && hit.threadId
        ? {
            key: `item:${hit.workspaceId}:${hit.id}`,
            group: 'thread',
            title: hit.title,
            path,
            workspaceId: hit.workspaceId,
            snippet: hit.title,
          }
        : null;
    case 'workspace':
      return {
        key: `workspace:${hit.id}`,
        group: 'workspace',
        title: hit.title,
        path,
        workspaceId: hit.id,
      };
    case 'artifact':
      return hit.workspaceId
        ? {
            key: `artifact:${hit.workspaceId}:${hit.id}`,
            group: 'artifact',
            title: hit.title,
            path,
            workspaceId: hit.workspaceId,
          }
        : null;
    case 'knowledge':
      return {
        key: `knowledge:${hit.workspaceId ?? ''}:${hit.id}`,
        group: 'knowledge',
        title: hit.title,
        path,
        ...(hit.workspaceId ? { workspaceId: hit.workspaceId } : {}),
      };
  }
}

/** Results grouped in display order, keeping each group's order and dropping repeated keys. */
export function groupResults(
  results: readonly SearchResult[]
): { id: SearchGroupId; title: string; results: SearchResult[] }[] {
  const seen = new Set<string>();
  const unique = results.filter((result) => {
    if (seen.has(result.key)) return false;
    seen.add(result.key);
    return true;
  });
  return SEARCH_GROUPS.map((group) => ({
    ...group,
    results: unique.filter((result) => result.group === group.id),
  })).filter((group) => group.results.length > 0);
}

/** `/search` with the query and filters in the URL. */
export function searchPagePath(query: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams();
  if (query.trim()) search.set('q', query.trim());
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `/search?${text}` : '/search';
}
