import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-aria-components';
import { type NavigateOptions, useHref, useLocation, useNavigate } from 'react-router-dom';
import {
  ActionButton,
  Avatar,
  CountBadge,
  Icon,
  Menu,
  type MenuSection,
  NavRow,
} from '../primitives';
import {
  type useConversationNavigation,
  useCurrentWorkspaceId,
  useWorkspaceSummaries,
  workspaceBelongsToCaller,
} from '../screens/chat/data';
import { useHumanAttention } from '../screens/workspace/data';
import { useWorkspaceStore } from '../screens/workspace-store';
import { NewGoalDialog, NewTaskDialog } from './StartWorkDialogs';
import { searchShortcutLabel, useSearchPalette, usesCommandKey } from './search/SearchPalette';
import type { ThreadTypeFilter } from './sidebar/thread-tree';
import { WorkspaceThreadTree } from './sidebar/WorkspaceThreadTree';
import { type NavGroup, type Surface, surfacesInGroup } from './surfaces';

declare module 'react-aria-components' {
  interface RouterConfig {
    routerOptions: NavigateOptions;
  }
}

/** The 20px mark for the brand row (ia.md §1: the 32px wordmark is gone). */
function BrandMark() {
  return (
    <img
      className="size-5"
      src={`${import.meta.env.BASE_URL}brand/openkit-mark-small.svg`}
      alt="OpenKit"
    />
  );
}

/** True when a surface's route is the one currently shown. */
function isActive(surface: Surface, pathname: string): boolean {
  if (surface.path === '/settings/general') return pathname === '/settings/general';
  return pathname === surface.path || pathname.startsWith(`${surface.path}/`);
}

function NavSection({
  group,
  heading,
  pathname,
  go,
}: {
  group: NavGroup;
  heading?: string;
  pathname: string;
  go: (path: string) => void;
}) {
  const items = surfacesInGroup(group);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      {heading ? (
        <p className="px-3 pb-1 pt-3 text-eyebrow font-bold text-fg-muted">{heading}</p>
      ) : null}
      {items.map((surface) => (
        <NavRow
          key={surface.id}
          icon={surface.icon}
          label={surface.title}
          active={isActive(surface, pathname)}
          onPress={() => go(surface.path)}
        />
      ))}
    </div>
  );
}

/** Continues the bounded conversation list when the server returned a cursor. */
export function ConversationLoadMore({
  navigation,
}: {
  navigation: Pick<
    ReturnType<typeof useConversationNavigation>,
    'hasNextPage' | 'isFetchingNextPage' | 'fetchNextPage'
  >;
}) {
  if (!navigation.hasNextPage) return null;
  return (
    <ActionButton
      isQuiet
      className="justify-start px-3"
      isDisabled={navigation.isFetchingNextPage}
      onPress={() => void navigation.fetchNextPage()}
    >
      Load more
    </ActionButton>
  );
}

/** The New row's shortcut label: ⌘N on Apple platforms, ⌃N elsewhere. */
export function newShortcutLabel(): string {
  return usesCommandKey() ? '⌘N' : '⌃N';
}

/** The Search row (ia.md §1a): the palette on desktop, the `/search` page on a phone. */
function SearchRow({ active }: { active: boolean }) {
  const palette = useSearchPalette();
  return (
    <NavRow
      icon="search"
      label="Search"
      active={active}
      trailing={
        <kbd aria-hidden className="font-sans text-xs text-fg-muted">
          {searchShortcutLabel()}
        </kbd>
      }
      onPress={palette.open}
    />
  );
}

/** A dialog opened from a group ⋯ menu, bound to that group's Workspace. */
type StartRequest = { kind: 'task' | 'goal'; workspaceId: string; workspaceName: string };

const FILTERS: { id: ThreadTypeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'chat', label: 'Chats' },
  { id: 'task', label: 'Tasks' },
  { id: 'goal', label: 'Goals' },
];

/** The group ⋯ menu (ia.md §1): Workspace places, new work here, and the type filter. */
function groupMenuSections(kind: string, filter: ThreadTypeFilter): MenuSection[] {
  const places = surfacesInGroup('workspace-compact', kind);
  return [
    {
      id: 'places',
      items: [
        { id: 'place:/settings/general', label: 'Workspace settings', icon: 'settings' },
        ...(kind === 'general'
          ? [{ id: 'place:/settings/account', label: 'Members', icon: 'settings' as const }]
          : []),
        ...places.map((surface) => ({
          id: `place:${surface.path}`,
          label: surface.title,
          icon: surface.icon,
        })),
      ],
    },
    {
      id: 'new',
      items: [
        { id: 'new:thread', label: 'New Thread here', icon: 'add' },
        // Until B3's composer mode control, New Task and New Goal start from here.
        { id: 'new:task', label: 'New Task', icon: 'agents' },
        { id: 'new:goal', label: 'New Goal', icon: 'goal' },
      ],
    },
    {
      id: 'show',
      title: 'Show',
      selectedKey: `show:${filter}`,
      items: FILTERS.map((item) => ({ id: `show:${item.id}`, label: item.label })),
    },
  ];
}

/**
 * Workspace groups (ia.md §1): one Thread list each. The selected Workspace is first and
 * open; the others follow alphabetically, closed, and load their Threads when opened.
 */
function WorkspaceGroups({ onStart }: { onStart: (request: StartRequest) => void }) {
  const navigate = useNavigate();
  const summaries = useWorkspaceSummaries();
  const workspaceId = useCurrentWorkspaceId();
  const setWorkspaceId = useWorkspaceStore((state) => state.setCurrentWorkspaceId);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [filters, setFilters] = useState<Record<string, ThreadTypeFilter>>({});
  const workspaces = (summaries.data ?? [])
    .filter((item) => workspaceBelongsToCaller(item))
    .map((item) => item.workspace)
    .toSorted((a, b) =>
      a.id === workspaceId ? -1 : b.id === workspaceId ? 1 : a.name.localeCompare(b.name)
    );

  return (
    <div className="flex flex-col gap-2 pt-3">
      {workspaces.map((workspace) => {
        const expanded = open[workspace.id] ?? workspace.id === workspaceId;
        const filter = filters[workspace.id] ?? 'all';
        const bodyId = `workspace-group-${workspace.id}`;
        return (
          <section key={workspace.id} aria-label={workspace.name} className="flex flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-1 pl-1">
              <ActionButton
                isQuiet
                size="sm"
                aria-expanded={expanded}
                aria-controls={expanded ? bodyId : undefined}
                className="min-w-0 flex-1 justify-start gap-1 px-2 text-eyebrow font-bold text-fg-muted"
                onPress={() => setOpen({ ...open, [workspace.id]: !expanded })}
              >
                <span className="min-w-0 truncate">{workspace.name}</span>
                <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size="sm" />
              </ActionButton>
              <Menu
                icon="more"
                label={`${workspace.name} options`}
                sections={groupMenuSections(workspace.kind, filter)}
                onAction={(key) => {
                  const [kind, value] = String(key).split(/:(.*)/s);
                  if (kind === 'show') {
                    setFilters({ ...filters, [workspace.id]: value as ThreadTypeFilter });
                    setOpen({ ...open, [workspace.id]: true });
                    return;
                  }
                  setWorkspaceId(workspace.id);
                  if (kind === 'place' && value) navigate(value);
                  else if (value === 'thread') navigate('/new');
                  else if (value === 'task' || value === 'goal') {
                    onStart({
                      kind: value,
                      workspaceId: workspace.id,
                      workspaceName: workspace.name,
                    });
                  }
                }}
              />
            </div>
            {expanded ? (
              <div id={bodyId}>
                <WorkspaceThreadTree
                  workspaceId={workspace.id}
                  workspaceName={workspace.name}
                  filter={filter}
                />
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/**
 * The account row (ia.md §1): avatar, "Account" and a menu with Profile and Appearance; the
 * gear opens Settings. Sign out sits on the Profile page.
 *
 * The web app has no read for the caller's name yet (`caller.read` is roadmap R044), and the
 * auth session route does not exist in local mode, so the row names the place, not the person.
 */
function AccountRow({ go }: { go: (path: string) => void }) {
  return (
    <div className="flex min-w-0 items-center gap-1 border-t border-separator pt-2">
      <div className="min-w-0 flex-1">
        <Menu
          label="Account"
          trigger={
            <>
              <span aria-hidden className="contents">
                <Avatar hue="you" initials="A" name="Account" size="sm" />
              </span>
              <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">Account</span>
              <Icon name="chevron-down" size="sm" className="text-fg-muted" />
            </>
          }
          items={[
            { id: '/settings/account', label: 'Profile' },
            { id: '/settings/appearance', label: 'Appearance' },
          ]}
          onAction={(key) => go(String(key))}
        />
      </div>
      <ActionButton
        isQuiet
        aria-label="Settings"
        title="Settings"
        className="shrink-0"
        onPress={() => go('/settings/account')}
      >
        <Icon name="settings" />
      </ActionButton>
    </div>
  );
}

/** Optional overlay-drawer close control used by the narrow App shell. */
export interface SidebarProps {
  /** When set (the phone drawer), the sidebar shows an explicit Close control. */
  onClose?: () => void;
}

/**
 * Left sidebar (DESIGN.md §3.1, ia.md §1), 240px. The phone drawer holds the same content.
 *
 * Top: New (the only creation entry), Search, Needs you, Personal Assistant, Artifacts,
 * Knowledge and Automations. Then one group per Workspace, each with one Thread list, and
 * "New workspace". The account row and the Settings gear sit at the bottom.
 * Settings pages swap the list for the settings sections.
 */
export function Sidebar({ onClose }: SidebarProps = {}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const summaries = useWorkspaceSummaries();
  const workspaceId = useCurrentWorkspaceId();
  const setWorkspaceId = useWorkspaceStore((state) => state.setCurrentWorkspaceId);
  const workspace =
    summaries.data?.find((candidate) => candidate.workspace.id === workspaceId)?.workspace ?? null;
  const inSettings = pathname === '/workspace' || pathname.startsWith('/settings');
  const attention = useHumanAttention(inSettings ? null : workspaceId);
  const [start, setStart] = useState<StartRequest | null>(null);
  // A Workspace change drops an open New Task or New Goal, and its late result opens nothing.
  if (start && start.workspaceId !== workspaceId) setStart(null);
  const go = (path: string) => navigate(path);
  const persistent = !onClose;

  // ⌃N / ⌘N opens New on the desktop shell. Browsers keep the key for a new window in a
  // normal tab, so it works where the page receives it (an installed app window).
  useEffect(() => {
    if (!persistent) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== 'n') return;
      event.preventDefault();
      navigate('/new');
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, persistent]);

  const top = ['artifacts', 'knowledge', 'automations']
    .map((id) => surfacesInGroup('primary').find((surface) => surface.id === id))
    .filter((surface): surface is Surface => Boolean(surface));

  return (
    <RouterProvider navigate={(path, options) => navigate(path, options)} useHref={useHref}>
      <nav
        aria-label={inSettings ? 'Settings sections' : 'Primary workspace navigation'}
        className="flex h-full w-[240px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-separator bg-sunken p-3"
      >
        <div className="mb-2 flex min-w-0 items-center justify-between gap-2 px-1">
          <BrandMark />
          {onClose ? (
            <ActionButton
              isQuiet
              aria-label="Close navigation"
              title="Close navigation"
              className="shrink-0"
              onPress={onClose}
            >
              <Icon name="close" />
            </ActionButton>
          ) : null}
        </div>
        {inSettings ? (
          <>
            <NavRow icon="chevron-right" label="Back to app" onPress={() => go('/')} />
            <div className="my-2">
              <Menu
                fill
                label={workspace?.name ?? 'Select workspace'}
                selectedKey={workspaceId}
                items={(summaries.data ?? [])
                  .filter((item) => workspaceBelongsToCaller(item))
                  .map((item) => ({ id: item.workspace.id, label: item.workspace.name }))}
                onAction={(key) => setWorkspaceId(String(key))}
              />
            </div>
            {workspace ? (
              <NavSection
                group="settings-workspace"
                heading="Workspace"
                pathname={pathname}
                go={go}
              />
            ) : null}
            <NavSection group="settings-user" heading="User" pathname={pathname} go={go} />
            <NavSection group="settings-server" heading="Server" pathname={pathname} go={go} />
            <NavSection
              group="settings-admin"
              heading="Administration"
              pathname={pathname}
              go={go}
            />
          </>
        ) : (
          <>
            <NavRow
              icon="add"
              label="New"
              active={pathname === '/new'}
              trailing={
                persistent ? (
                  <kbd aria-hidden className="font-sans text-xs text-fg-muted">
                    {newShortcutLabel()}
                  </kbd>
                ) : undefined
              }
              onPress={() => go('/new')}
            />
            <SearchRow active={pathname === '/search'} />
            <NavRow
              icon="home"
              label="Needs you"
              active={pathname === '/needs-you' || pathname.startsWith('/needs-you/')}
              trailing={
                <CountBadge count={attention.data?.length ?? 0} label="need you" tone="notice" />
              }
              onPress={() => go('/needs-you')}
            />
            <NavRow
              icon="chat"
              label="Personal Assistant"
              active={pathname === '/assistant'}
              onPress={() => go('/assistant')}
            />
            {top.map((surface) => (
              <NavRow
                key={surface.id}
                icon={surface.icon}
                label={surface.title}
                active={isActive(surface, pathname)}
                onPress={() => go(surface.path)}
              />
            ))}
            <WorkspaceGroups onStart={setStart} />
            <NavRow
              icon="add"
              label="New workspace"
              active={pathname === '/settings/workspaces/new'}
              onPress={() => go('/settings/workspaces/new')}
            />
          </>
        )}
        {/* Settings lists Account and Appearance itself, so its sidebar has no account row. */}
        {inSettings ? null : (
          <div className="mt-auto pt-2">
            <AccountRow go={go} />
          </div>
        )}
        {start?.kind === 'task' ? (
          <NewTaskDialog
            key={`task:${start.workspaceId}`}
            workspaceId={start.workspaceId}
            workspaceLabel={start.workspaceName}
            opener={{ open: true, onOpenChange: (next) => (next ? undefined : setStart(null)) }}
          />
        ) : null}
        {start?.kind === 'goal' ? (
          <NewGoalDialog
            key={`goal:${start.workspaceId}`}
            workspaceId={start.workspaceId}
            opener={{ open: true, onOpenChange: (next) => (next ? undefined : setStart(null)) }}
          />
        ) : null}
      </nav>
    </RouterProvider>
  );
}
