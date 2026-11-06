import { useMutationState, useQueries } from '@tanstack/react-query';
import { Fragment, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, CountBadge, Icon, type IconName, Menu, NavRow } from '../primitives';
import {
  chatKeys,
  conversationThreadPath,
  useConversationNavigation,
  useCurrentWorkspaceId,
  useWorkspaceSummaries,
  useWorkspaces,
  workspaceBelongsToCaller,
} from '../screens/chat/data';
import { goalKeys } from '../screens/goal/data';
import { AppSearch } from '../screens/operations';
import { useHumanAttention } from '../screens/workspace/data';
import { useWorkspaceStore } from '../screens/workspace-store';
import { AssistantEntry } from './AssistantEntry';
import { ConversationGoalGroups, type ConversationRow } from './ConversationGoalGroups';
import { useCoreClient } from './core-client';
import { NewGoalDialog, NewTaskDialog } from './StartWorkDialogs';
import { type NavGroup, type Surface, surfacesInGroup } from './surfaces';

/** Static wordmark for the brand row (DESIGN.md §8.2). Height matches the Search control. */
function BrandMark() {
  return (
    <img
      className="h-8 w-auto"
      src={`${import.meta.env.BASE_URL}brand/openkit-wordmark.svg`}
      alt="OpenKit"
    />
  );
}

/** True when a surface's route is the one currently shown. */
function isActive(surface: Surface, pathname: string): boolean {
  if (surface.path === '/settings/general') return pathname === '/settings/general';
  if (surface.path.startsWith('/settings')) return pathname === surface.path;
  return pathname === surface.path || pathname.startsWith(`${surface.path}/`);
}

/** True when the current route is a Thread or other lineage-detail page. */
function isLineageDetailPath(pathname: string): boolean {
  return /^\/(chat|tasks|goals|materials)\//.test(pathname);
}

/** True when Artifacts inventory currently carries Workspace or Artifact identity. */
function hasArtifactIdentityQuery(search: string): boolean {
  const params = new URLSearchParams(search);
  return Boolean(params.get('workspaceId')?.trim() || params.get('artifact')?.trim());
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

function SectionLabel({ children }: { children: string }) {
  return <p className="px-3 pb-1 pt-3 text-eyebrow font-bold text-fg-muted">{children}</p>;
}

type ListSegment = 'all' | 'tasks' | 'goals';

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
    <Button
      variant="quiet"
      className="min-h-11 justify-start px-3"
      isDisabled={navigation.isFetchingNextPage}
      onPress={() => void navigation.fetchNextPage()}
    >
      Load more
    </Button>
  );
}

/**
 * Assistant, Tasks, and Goals as separate lists.
 *
 * Necessity: the phone Work tab and the desktop sidebar show the same rows.
 * Ablation: a second copy of the row renderer would drift from the route each activity opens.
 */
export function ThreadLists({ segment = 'all' }: { segment?: ListSegment }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const workspaceId = useCurrentWorkspaceId();
  const workspaces = useWorkspaces();
  const workspace = workspaces.data?.find((candidate) => candidate.id === workspaceId) ?? null;
  const navigation = useConversationNavigation(workspaceId);
  const go = (path: string) => navigate(path);
  const submissions = useMutationState({
    filters: { mutationKey: chatKeys.submitMutation, status: 'pending' },
    select: (mutation) => mutation.state.variables as { workspaceId: string; threadId: string },
  });
  const waiting = new Set(
    submissions.filter((input) => input.workspaceId === workspaceId).map((input) => input.threadId)
  );
  const conversations = [...(navigation.data ?? [])].sort(
    (a, b) => Number(waiting.has(b.thread.id)) - Number(waiting.has(a.thread.id))
  );
  const chats = conversations.filter((row) => row.activity === 'chat');
  const assistant = chats.find((row) => row.thread.name === 'Assistant') ?? chats[0];
  const tasks = conversations.filter((row) => row.activity === 'task');
  const goals = conversations.filter((row) => row.activity === 'goal');
  const unknown = conversations.filter((row) => row.activity === 'unknown');
  const client = useCoreClient();
  const goalViews = useQueries({
    queries: goals.map(({ thread }) => ({
      queryKey: goalKeys.view(workspaceId ?? '', thread.id),
      queryFn: () =>
        client.operations['goal.read']({
          workspaceId: workspaceId as string,
          threadId: thread.id,
        }),
      enabled: Boolean(workspaceId),
      retry: false,
      refetchInterval: 5_000,
      refetchIntervalInBackground: false,
    })),
  });
  const linkedTaskIds = new Set(
    goalViews.flatMap((view) => view.data?.tasks.map((task) => task.threadId) ?? [])
  );
  const listedTasks = tasks.filter((row) => !linkedTaskIds.has(row.thread.id));

  function renderConversation(
    { thread, activity: observedActivity, state: serverState, unreadCount }: ConversationRow,
    indent: 0 | 1 = 0,
    linkedTask = false,
    labelOverride?: string
  ) {
    if (!workspace) return null;
    const activity = linkedTask ? 'task' : observedActivity;
    const awaitingReply = waiting.has(thread.id);
    const state =
      serverState === 'needs-you' ? serverState : awaitingReply ? 'working' : serverState;
    const icons: Record<typeof activity, IconName> = {
      chat: 'chat',
      task: 'agents',
      goal: 'goal',
      unknown: 'info',
    };
    const labels = {
      chat: 'Personal Assistant',
      task: 'Task',
      goal: 'Goal',
      unknown: 'Activity type unknown',
    };
    const status = navigation.isError
      ? 'Status unavailable'
      : state === 'working'
        ? awaitingReply
          ? 'Waiting for response'
          : 'Working'
        : state === 'needs-you'
          ? 'Needs you'
          : 'Idle';
    const suffix = `/${encodeURIComponent(workspace.id)}/${encodeURIComponent(thread.id)}`;
    return (
      <NavRow
        key={thread.id}
        indent={indent}
        icon={icons[activity]}
        label={labelOverride ?? thread.name ?? thread.preview}
        description={`${labels[activity]} · ${status}${!navigation.isError && unreadCount > 0 ? ` · ${unreadCount} unread ${unreadCount === 1 ? 'reply' : 'replies'}` : ''}`}
        trailing={
          !navigation.isError && unreadCount > 0 ? (
            <CountBadge count={unreadCount} tone="neutral" />
          ) : undefined
        }
        iconBadge={
          !navigation.isError && state !== 'idle' ? (
            <span
              aria-hidden
              className={`absolute -right-0.5 -top-0.5 size-1.5 rounded-full ring-1 ring-sunken ${state === 'working' ? 'bg-info-fg' : 'border border-notice-fg bg-attention-dot'}`}
            />
          ) : undefined
        }
        active={['chat', 'tasks', 'goals'].some(
          (route) => pathname === `/${route}${suffix}` || pathname.startsWith(`/${route}${suffix}/`)
        )}
        onPress={() => go(conversationThreadPath(workspace.id, thread.id, activity))}
      />
    );
  }

  if (!workspace) return null;
  const showAssistant = segment === 'all';
  const showTasks = segment === 'all' || segment === 'tasks';
  const showGoals = segment === 'all' || segment === 'goals';

  return (
    <div className="flex flex-col gap-0.5">
      {showAssistant ? (
        <>
          <SectionLabel>Assistant</SectionLabel>
          {assistant ? (
            renderConversation(assistant, 0, false, 'Personal Assistant')
          ) : (
            <AssistantEntry key={`assistant:${workspace.id}`} workspaceId={workspace.id} />
          )}
        </>
      ) : null}
      {navigation.isPending ? (
        <p className="px-3 text-xs text-fg-muted">Loading conversations…</p>
      ) : null}
      {navigation.isError ? (
        <div className="px-3 text-xs text-notice-fg">
          <p>
            Conversation status unavailable
            {conversations.length ? ' — showing the last update.' : '.'}
          </p>
          <Button
            variant="quiet"
            size="sm"
            onPress={() => {
              void navigation.refetch();
            }}
          >
            Retry conversations
          </Button>
        </div>
      ) : null}
      {showTasks ? (
        <>
          {segment === 'all' ? <SectionLabel>Tasks</SectionLabel> : null}
          <NewTaskDialog
            key={`task:${workspace.id}`}
            workspaceId={workspace.id}
            workspaceLabel={workspace.name}
          />
          {listedTasks.map((row) => (
            <Fragment key={row.thread.id}>{renderConversation(row)}</Fragment>
          ))}
        </>
      ) : null}
      {showGoals ? (
        <>
          {segment === 'all' ? <SectionLabel>Goals</SectionLabel> : null}
          <NewGoalDialog key={`goal:${workspace.id}`} workspaceId={workspace.id} />
          <ConversationGoalGroups
            key={workspace.id}
            workspaceId={workspace.id}
            rows={goals}
            unavailable={navigation.isError}
            pathname={pathname}
            go={go}
            renderConversation={renderConversation}
          />
        </>
      ) : null}
      {segment === 'all' && unknown.length > 0 ? (
        <>
          <SectionLabel>Recovery</SectionLabel>
          {unknown.map((row) => (
            <Fragment key={row.thread.id}>{renderConversation(row)}</Fragment>
          ))}
        </>
      ) : null}
      <ConversationLoadMore navigation={navigation} />
    </div>
  );
}

/** Brand-row Search command that opens the existing search overlay. */
function BrandSearch() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <div>
      <Button
        variant="quiet"
        aria-expanded={open}
        aria-label="Search"
        title="Search"
        className="size-11 shrink-0 px-0!"
        onPress={() => setOpen((current) => !current)}
      >
        <Icon name="search" />
      </Button>
      {open ? (
        <section
          aria-label="Search"
          className="absolute inset-x-0 top-full z-20 mt-1 rounded-ok-lg border border-border bg-elevated p-3 shadow-ok-menu"
        >
          <AppSearch onClose={() => setOpen(false)} />
        </section>
      ) : null}
    </div>
  );
}

/** Optional overlay-drawer close control used by the narrow App shell. */
export interface SidebarProps {
  /** When set, the sidebar shows an explicit Close control. */
  onClose?: () => void;
  /** `more` is the phone drawer: Artifacts and supporting screens, not the five bottom-nav items. */
  variant?: 'sidebar' | 'more';
}

/**
 * Left sidebar — navigation and persistent context (DESIGN.md §3.1).
 *
 * Desktop keeps Assistant, Tasks, Goals, Knowledge, Artifacts, and Action Center.
 * The phone More drawer lists Action Center and the supporting screens.
 * Theme selection is NOT here — it lives in Settings → Appearance (§4.5).
 * Identity lives inside Settings, not a stacked user row (D-002).
 */
export function Sidebar({ onClose, variant = 'sidebar' }: SidebarProps = {}) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const summaries = useWorkspaceSummaries();
  const workspaceId = useCurrentWorkspaceId();
  const setWorkspaceId = useWorkspaceStore((state) => state.setCurrentWorkspaceId);
  const workspace = workspaces.data?.find((candidate) => candidate.id === workspaceId) ?? null;
  const inSettings = pathname === '/workspace' || pathname.startsWith('/settings');
  const attention = useHumanAttention(inSettings ? null : workspaceId);
  const go = (path: string) => navigate(path);
  const compactSurfaces = surfacesInGroup('workspace-compact', workspace?.kind);

  function switchWorkspace(nextWorkspaceId: string) {
    if (!nextWorkspaceId || nextWorkspaceId === workspaceId) return;
    setWorkspaceId(nextWorkspaceId);
    if (isLineageDetailPath(pathname)) {
      navigate('/chat');
    } else if (pathname === '/artifacts' && hasArtifactIdentityQuery(search)) {
      navigate('/artifacts');
    }
  }

  const moreDestinations =
    variant === 'more' && !inSettings ? (
      <>
        {workspace ? (
          <NavRow
            icon="home"
            label="Action Center"
            active={pathname === '/attention' || pathname.startsWith('/attention/')}
            trailing={
              <CountBadge count={attention.data?.length ?? 0} label="need you" tone="notice" />
            }
            onPress={() => go('/attention')}
          />
        ) : null}
        {compactSurfaces.map((surface) => (
          <NavRow
            key={surface.id}
            icon={surface.icon}
            label={surface.title}
            active={isActive(surface, pathname)}
            onPress={() => go(surface.path)}
          />
        ))}
        {workspace?.kind === 'general' ? (
          <NavRow icon="settings" label="Members" onPress={() => go('/settings/account')} />
        ) : null}
        <NavRow icon="settings" label="Settings" onPress={() => go('/settings/account')} />
      </>
    ) : null;

  return (
    <nav
      aria-label={inSettings ? 'Settings sections' : 'Primary workspace navigation'}
      className="flex h-full w-[264px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-separator bg-sunken p-3"
    >
      <div className="relative mb-1 flex min-w-0 items-center justify-between gap-2">
        <BrandMark />
        <div className="flex min-w-0 items-center gap-1">
          <BrandSearch />
          {onClose ? (
            <Button
              variant="quiet"
              aria-label="Close navigation"
              title="Close navigation"
              className="size-11 shrink-0 px-0!"
              onPress={onClose}
            >
              <Icon name="close" />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="mb-2">
        <Menu
          fill
          label={workspace?.name ?? 'Select workspace'}
          selectedKey={workspaceId}
          items={(summaries.data ?? [])
            .filter((item) => workspaceBelongsToCaller(item))
            .map((item) => ({
              id: item.workspace.id,
              label: item.workspace.name,
            }))}
          onAction={(key) => switchWorkspace(String(key))}
        />
      </div>
      {inSettings ? (
        <>
          <NavRow icon="chevron-right" label="Back to app" onPress={() => go('/')} />
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
          <NavSection group="settings-admin" heading="Administration" pathname={pathname} go={go} />
        </>
      ) : variant === 'more' ? (
        moreDestinations
      ) : (
        <>
          <ThreadLists />
          <NavSection group="primary" pathname={pathname} go={go} />
          {workspace ? (
            <NavRow
              icon="home"
              label="Action Center"
              active={pathname === '/attention' || pathname.startsWith('/attention/')}
              trailing={
                <CountBadge count={attention.data?.length ?? 0} label="need you" tone="notice" />
              }
              onPress={() => go('/attention')}
            />
          ) : null}
          {workspace?.kind === 'general' ? (
            <NavRow icon="settings" label="Members" onPress={() => go('/settings/account')} />
          ) : null}
          <div className="mt-auto border-t border-separator pt-2">
            <fieldset
              className="grid min-w-0 grid-cols-4 justify-items-center gap-0.5 border-0 p-0"
              aria-label="Sidebar shortcuts"
            >
              <Button
                variant="quiet"
                title="Settings"
                aria-label="Settings"
                className="size-11 shrink-0 px-0!"
                onPress={() => go('/settings/account')}
              >
                <Icon name="settings" />
              </Button>
              {(workspace ? compactSurfaces : []).map((surface) => (
                <Button
                  key={surface.id}
                  variant="quiet"
                  title={surface.title}
                  aria-label={surface.title}
                  aria-current={isActive(surface, pathname) ? 'page' : undefined}
                  className={[
                    'size-11 shrink-0 px-0!',
                    isActive(surface, pathname) ? 'bg-selected text-accent-content' : '',
                  ].join(' ')}
                  onPress={() => go(surface.path)}
                >
                  {surface.icon ? <Icon name={surface.icon} /> : null}
                </Button>
              ))}
            </fieldset>
          </div>
        </>
      )}
    </nav>
  );
}
