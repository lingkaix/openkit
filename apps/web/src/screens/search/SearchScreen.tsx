import { useEffect, useMemo, useRef, useState } from 'react';
import { Input, Label, SearchField } from 'react-aria-components';
import { Link, useSearchParams } from 'react-router-dom';
import {
  groupResults,
  highlightRuns,
  resultForHit,
  type SearchGroupId,
  type SearchResult,
} from '../../app/search/search-model';
import { useDebouncedValue } from '../../app/search/use-debounced-value';
import { EmptyState, InlineAlert, Page, PageHeader, Picker, Skeleton } from '../../primitives';
import { useConversationNavigation, useCurrentWorkspaceId, useWorkspaces } from '../chat/data';
import { pathForSearchHit, useAppSearch } from '../operations/data';
import { useWorkspaceStore } from '../workspace-store';

const ALL = 'all';

/** Result types the page filters by (ia.md §1a). */
const TYPE_OPTIONS: { id: string; label: string; groups: readonly SearchGroupId[] }[] = [
  { id: ALL, label: 'All types', groups: ['thread', 'artifact', 'knowledge'] },
  { id: 'thread', label: 'Threads', groups: ['thread'] },
  { id: 'artifact', label: 'Artifacts', groups: ['artifact'] },
  { id: 'knowledge', label: 'Knowledge pages', groups: ['knowledge'] },
];

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightRuns(text, query).map((run, index) =>
        run.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and never reorder
          <mark key={index} className="rounded-sm bg-notice-bg px-0.5 text-fg-strong">
            {run.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and never reorder
          <span key={index}>{run.text}</span>
        )
      )}
    </>
  );
}

/**
 * `/search?q=`: full results with snippets and the matched words highlighted (ia.md §1a).
 *
 * The query, Workspace and type filters live in the URL, so a search can be shared and
 * reloaded. Results come from `app.search` only; it carries no time, so there is no time
 * filter (B1 gap).
 */
export function SearchScreen() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const workspaceFilter = params.get('workspace') ?? ALL;
  const typeFilter = TYPE_OPTIONS.some((option) => option.id === params.get('type'))
    ? (params.get('type') as string)
    : ALL;
  const [draft, setDraft] = useState(query);
  const debounced = useDebouncedValue(draft.trim(), 250);
  const workspaces = useWorkspaces();
  const currentWorkspaceId = useCurrentWorkspaceId();
  const navigation = useConversationNavigation(currentWorkspaceId);
  const search = useAppSearch(query);

  // A query from outside (palette, Back, a shared link) replaces the draft; our own write does not.
  const written = useRef(query);
  useEffect(() => {
    if (query === written.current) return;
    written.current = query;
    setDraft(query);
  }, [query]);

  // Typing replaces the query in place; it does not add a history entry per keystroke.
  useEffect(() => {
    if (debounced === query.trim()) return;
    written.current = debounced;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (debounced) next.set('q', debounced);
        else next.delete('q');
        return next;
      },
      { replace: true }
    );
  }, [debounced, query, setParams]);

  function setFilter(key: 'workspace' | 'type', value: string) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value === ALL) next.delete(key);
      else next.set(key, value);
      return next;
    });
  }

  const workspaceNames = useMemo(
    () => new Map((workspaces.data ?? []).map((workspace) => [workspace.id, workspace.name])),
    [workspaces.data]
  );
  const threadNames = useMemo(
    () =>
      new Map(
        (navigation.data ?? []).map((row) => [
          `${currentWorkspaceId}:${row.thread.id}`,
          row.thread.name ?? row.thread.preview,
        ])
      ),
    [currentWorkspaceId, navigation.data]
  );

  // Only a read finished after this mount shows hits; a paused or failed read hides them.
  const settled = search.isFetchedAfterMount && search.isSuccess && search.fetchStatus === 'idle';
  const groups = useMemo(() => {
    const allowed = TYPE_OPTIONS.find((option) => option.id === typeFilter)?.groups ?? [];
    const results = (settled ? search.data : [])
      .map((hit) => resultForHit(hit, pathForSearchHit(hit)))
      .filter((result): result is SearchResult => result !== null)
      .filter((result) => allowed.includes(result.group))
      .filter(
        (result) =>
          workspaceFilter === ALL ||
          (result.workspaceId === workspaceFilter && workspaceNames.has(workspaceFilter))
      );
    return groupResults(results);
  }, [search.data, settled, typeFilter, workspaceFilter, workspaceNames]);

  function select(result: SearchResult) {
    if (result.workspaceId && workspaceNames.has(result.workspaceId)) {
      useWorkspaceStore.getState().setCurrentWorkspaceId(result.workspaceId);
    }
  }

  function titleOf(result: SearchResult): string {
    if (!result.snippet) return result.title;
    const threadId = result.path.split('/').pop() ?? '';
    return threadNames.get(`${result.workspaceId}:${decodeURIComponent(threadId)}`) ?? 'Message';
  }

  return (
    <Page className="max-w-[880px]">
      <PageHeader title="Search" />
      <SearchField
        aria-label="Search"
        value={draft}
        onChange={setDraft}
        autoFocus
        className="flex flex-col gap-1"
      >
        <Label className="sr-only">Search</Label>
        <Input
          placeholder="Search Threads, Artifacts and Knowledge pages"
          className="ok-field-control h-control-md rounded-ok border border-border bg-card px-3 text-sm text-fg outline-none transition-colors placeholder:text-fg-muted hover:border-border-hover focus:border-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus"
        />
      </SearchField>
      <div className="flex flex-wrap gap-4">
        <Picker
          label="Workspace"
          items={[
            { id: ALL, label: 'All my Workspaces' },
            ...(workspaces.data ?? []).map((workspace) => ({
              id: workspace.id,
              label: workspace.name,
            })),
          ]}
          selectedKey={workspaceNames.has(workspaceFilter) ? workspaceFilter : ALL}
          onSelectionChange={(key) => setFilter('workspace', String(key))}
        />
        <Picker
          label="Type"
          items={TYPE_OPTIONS.map(({ id, label }) => ({ id, label }))}
          selectedKey={typeFilter}
          onSelectionChange={(key) => setFilter('type', String(key))}
        />
      </div>

      {!query ? (
        <EmptyState
          icon="search"
          title="Search"
          hint="Type to search Thread names, messages, Artifacts and Knowledge pages."
        />
      ) : search.isError ? (
        <InlineAlert message="Couldn't search." onRetry={() => void search.refetch()} />
      ) : !settled ? (
        <Skeleton lines={3} />
      ) : groups.length === 0 ? (
        <EmptyState icon="search" title="No results" hint={`Nothing matches “${query}”.`} />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.id} aria-labelledby={`search-group-${group.id}`}>
              <h2
                id={`search-group-${group.id}`}
                className="mb-2 text-eyebrow font-bold text-fg-muted"
              >
                {group.title}
              </h2>
              <ul className="flex flex-col divide-y divide-separator rounded-ok border border-border bg-card">
                {group.results.map((result) => (
                  <li key={result.key}>
                    {result.workspaceId && !workspaceNames.has(result.workspaceId) ? (
                      <span
                        aria-disabled="true"
                        className="flex flex-col gap-0.5 px-4 py-3 text-sm text-disabled-fg"
                      >
                        {result.snippet ? titleOf(result) : result.title}
                      </span>
                    ) : (
                      <Link
                        to={result.path}
                        onClick={() => select(result)}
                        className="flex flex-col gap-0.5 px-4 py-3 text-sm outline-none hover:bg-overlay focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-focus"
                      >
                        <span className="truncate font-medium text-fg-strong">
                          {result.snippet ? (
                            titleOf(result)
                          ) : (
                            <Highlighted text={result.title} query={query} />
                          )}
                        </span>
                        {result.snippet ? (
                          <span className="line-clamp-2 text-fg">
                            <Highlighted text={result.snippet} query={query} />
                          </span>
                        ) : null}
                        {result.workspaceId && workspaceNames.has(result.workspaceId) ? (
                          <span className="text-xs text-fg-muted">
                            {workspaceNames.get(result.workspaceId)}
                          </span>
                        ) : null}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Page>
  );
}
