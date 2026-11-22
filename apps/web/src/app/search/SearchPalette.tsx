import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Autocomplete,
  Dialog,
  Header,
  Input,
  Menu,
  MenuItem,
  MenuSection,
  Modal,
  ModalOverlay,
  SearchField,
} from 'react-aria-components';
import { useNavigate } from 'react-router-dom';
import { Icon, InlineAlert } from '../../primitives';
import {
  threadPath,
  threadRouteState,
  useConversationNavigation,
  useCurrentWorkspaceId,
  useWorkspaces,
} from '../../screens/chat/data';
import { pathForSearchHit, useAppSearch } from '../../screens/operations/data';
import { useWorkspaceStore } from '../../screens/workspace-store';
import { usePersistentNavigation } from '../persistent-nav';
import {
  groupResults,
  matchesQuery,
  resultForHit,
  type SearchResult,
  searchPagePath,
  settingsResults,
} from './search-model';
import { useDebouncedValue } from './use-debounced-value';

const RECENT_LIMIT = 8;
const GROUP_LIMIT = 6;
const VIEW_ALL = 'search:view-all';

interface SearchPaletteControl {
  /** Opens the palette on desktop, or the `/search` page on a phone. */
  open: () => void;
}

const SearchPaletteContext = createContext<SearchPaletteControl | null>(null);

/** The Search palette opener. Outside the shell (a lone screen test) it opens `/search`. */
export function useSearchPalette(): SearchPaletteControl {
  const control = useContext(SearchPaletteContext);
  const navigate = useNavigate();
  return control ?? { open: () => navigate('/search') };
}

/** True on Apple platforms, where the shortcut is ⌘K rather than ⌃K. */
export function usesCommandKey(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
}

/** The shortcut label beside the sidebar Search row. */
export function searchShortcutLabel(): string {
  return usesCommandKey() ? '⌘K' : '⌃K';
}

/**
 * Owns the Search palette and its ⌃K / ⌘K shortcut for the whole shell (ia.md §1a).
 *
 * Desktop opens a centered 640px dialog; a phone opens the full-screen `/search` page.
 */
export function SearchPaletteProvider({ children }: { children: ReactNode }) {
  const persistentNav = usePersistentNavigation();
  const navigate = useNavigate();
  const [isOpen, setOpen] = useState(false);

  const open = useCallback(() => {
    if (persistentNav) setOpen(true);
    else navigate('/search');
  }, [navigate, persistentNav]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      open();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!persistentNav) setOpen(false);
  }, [persistentNav]);

  const control = useMemo(() => ({ open }), [open]);
  return (
    <SearchPaletteContext.Provider value={control}>
      {children}
      <ModalOverlay
        isDismissable
        isOpen={isOpen}
        onOpenChange={setOpen}
        className="fixed inset-0 z-50 flex items-start justify-center bg-fg/40 px-6 pt-[12vh]"
      >
        <Modal className="ok-dialog ok-dialog-l ok-search-palette p-0 outline-none">
          <SearchPalette onClose={() => setOpen(false)} />
        </Modal>
      </ModalOverlay>
    </SearchPaletteContext.Provider>
  );
}

/** Palette body: one autofocused input over grouped results (React Aria Autocomplete). */
export function SearchPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const debounced = useDebouncedValue(trimmed, 150);
  const workspaceId = useCurrentWorkspaceId();
  const workspaces = useWorkspaces();
  const navigation = useConversationNavigation(workspaceId);
  const search = useAppSearch(debounced);
  // Discovery alone cannot authorize retained private hits: only a read finished after this
  // mount, for the current query, shows server hits (the AppSearch rule it replaces).
  const currentRead =
    search.isFetchedAfterMount &&
    search.isSuccess &&
    search.fetchStatus === 'idle' &&
    debounced === trimmed;

  const groups = useMemo(() => {
    const rows = navigation.data ?? [];
    const localThreads: SearchResult[] = rows
      .filter((row) => matchesQuery(row.thread.name ?? row.thread.preview ?? '', trimmed))
      .slice(0, trimmed ? GROUP_LIMIT : RECENT_LIMIT)
      .map((row) => ({
        key: `thread:${workspaceId}:${row.thread.id}`,
        group: 'thread',
        title: row.thread.name ?? row.thread.preview ?? 'Untitled Thread',
        path: threadPath(workspaceId ?? '', row.thread.id),
        workspaceId: workspaceId ?? undefined,
      }));
    if (!trimmed) return groupResults(localThreads);
    const named = (currentRead ? (search.data ?? []) : [])
      .filter((hit) => hit.kind === 'thread' || hit.kind === 'artifact' || hit.kind === 'workspace')
      .map((hit) => resultForHit(hit, pathForSearchHit(hit)))
      .filter((result): result is SearchResult => result !== null);
    const localWorkspaces: SearchResult[] = (workspaces.data ?? [])
      .filter((workspace) => matchesQuery(workspace.name, trimmed))
      .map((workspace) => ({
        key: `workspace:${workspace.id}`,
        group: 'workspace',
        title: workspace.name,
        path: '/',
        workspaceId: workspace.id,
      }));
    const settings = settingsResults().filter((result) => matchesQuery(result.title, trimmed));
    return groupResults([...localThreads, ...named, ...localWorkspaces, ...settings]).map(
      (group) => ({ ...group, results: group.results.slice(0, GROUP_LIMIT) })
    );
  }, [currentRead, navigation.data, search.data, trimmed, workspaceId, workspaces.data]);

  const byKey = useMemo(
    () => new Map(groups.flatMap((group) => group.results.map((result) => [result.key, result]))),
    [groups]
  );
  const admittedIds = useMemo(
    () => new Set(workspaces.isSuccess ? workspaces.data.map((workspace) => workspace.id) : []),
    [workspaces.data, workspaces.isSuccess]
  );
  const disabledKeys = useMemo(
    () =>
      [...byKey.values()]
        .filter((result) => result.workspaceId && !admittedIds.has(result.workspaceId))
        .map((result) => result.key),
    [admittedIds, byKey]
  );
  const activityByThread = useMemo(
    () => new Map((navigation.data ?? []).map((row) => [row.thread.id, row.activity])),
    [navigation.data]
  );

  function viewAll() {
    onClose();
    navigate(searchPagePath(trimmed));
  }

  function openResult(result: SearchResult) {
    if (result.workspaceId && !admittedIds.has(result.workspaceId)) return;
    if (result.workspaceId) useWorkspaceStore.getState().setCurrentWorkspaceId(result.workspaceId);
    const threadId = result.group === 'thread' ? result.path.split('/').pop() : undefined;
    const activity = threadId ? activityByThread.get(decodeURIComponent(threadId)) : undefined;
    onClose();
    navigate(result.path, {
      state: activity && activity !== 'unknown' ? threadRouteState(activity) : undefined,
    });
  }

  // Capture-phase keys, before the search field and the menu see them: Escape closes at once
  // (the field would clear its text first), and ⌃Enter / ⌘Enter opens all results.
  const dialogRef = useRef<HTMLElement>(null);
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || !trimmed) return;
    event.preventDefault();
    event.stopPropagation();
    viewAll();
  };
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const listener = (event: KeyboardEvent) => keys.current(event);
    dialog.addEventListener('keydown', listener, true);
    return () => dialog.removeEventListener('keydown', listener, true);
  }, []);

  return (
    <Dialog ref={dialogRef} aria-label="Search" className="flex max-h-[70vh] flex-col outline-none">
      <Autocomplete inputValue={query} onInputChange={setQuery}>
        <SearchField
          aria-label="Search"
          autoFocus
          className="flex items-center gap-2 border-b border-separator px-4"
        >
          <Icon name="search" />
          <Input
            placeholder="Search Threads, Workspaces, Artifacts and Settings"
            className="h-12 min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-muted [&::-webkit-search-cancel-button]:hidden"
          />
        </SearchField>
        {/* With a query the list always holds "View all results", so the no-match line sits
            above it. A failed read claims nothing about matches; its alert sits below. */}
        {trimmed && groups.length === 0 && !search.isError ? (
          <p role="status" className="px-5 pt-4 text-sm text-fg-muted">
            {currentRead ? 'No matching names.' : 'Searching…'}
          </p>
        ) : null}
        <Menu
          aria-label="Search results"
          disabledKeys={disabledKeys}
          className="min-h-0 flex-1 overflow-y-auto p-2 outline-none"
          onAction={(key) => {
            if (key === VIEW_ALL) {
              viewAll();
              return;
            }
            const result = byKey.get(String(key));
            if (result) openResult(result);
          }}
          renderEmptyState={() => (
            <p className="px-3 py-6 text-center text-sm text-fg-muted">No recent Threads.</p>
          )}
        >
          {groups.map((group) => (
            <MenuSection key={group.id} id={group.id} className="pb-1">
              <Header className="px-3 pb-1 pt-2 text-eyebrow font-bold text-fg-muted">
                {trimmed ? group.title : 'Recent Threads'}
              </Header>
              {group.results.map((result) => (
                <MenuItem
                  key={result.key}
                  id={result.key}
                  textValue={result.title}
                  className="ok-menu-item flex cursor-default items-center gap-2 rounded-ok text-sm text-fg outline-none data-[focused]:bg-overlay data-[disabled]:text-disabled-fg"
                >
                  <span className="min-w-0 flex-1 truncate">{result.title}</span>
                </MenuItem>
              ))}
            </MenuSection>
          ))}
          {trimmed ? (
            <MenuSection id="view-all" className="border-t border-separator pt-1">
              <MenuItem
                id={VIEW_ALL}
                textValue={`View all results for ${trimmed}`}
                className="ok-menu-item flex cursor-default items-center gap-2 rounded-ok text-sm text-accent outline-none data-[focused]:bg-overlay"
              >
                <span className="min-w-0 flex-1 truncate">View all results for “{trimmed}”</span>
                <kbd aria-hidden className="text-xs text-fg-muted">
                  {usesCommandKey() ? '⌘↵' : '⌃↵'}
                </kbd>
              </MenuItem>
            </MenuSection>
          ) : null}
        </Menu>
      </Autocomplete>
      {search.isError && trimmed ? (
        <div className="border-t border-separator p-3">
          <InlineAlert message="Couldn't search." onRetry={() => void search.refetch()} />
        </div>
      ) : null}
    </Dialog>
  );
}
