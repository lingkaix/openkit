import { useMutationState } from '@tanstack/react-query';
import { useId, useState } from 'react';
import {
  Button as AriaButton,
  type Key,
  Link,
  NavigationTree,
  NavigationTreeItem,
  NavigationTreeItemContent,
  TooltipTrigger,
} from 'react-aria-components';
import { useLocation } from 'react-router-dom';
import {
  ActionButton,
  CountBadge,
  Icon,
  type IconName,
  Tooltip,
  useFullWidthRows,
} from '../../primitives';
import {
  chatKeys,
  threadPath,
  threadRouteState,
  useConversationNavigation,
} from '../../screens/chat/data';
import {
  filterThreadRows,
  GROUP_PAGE_ROWS,
  nestThreadRows,
  type ThreadIndicator,
  type ThreadNode,
  type ThreadTypeFilter,
  threadActivityLabel,
  threadIndicator,
  threadRowDescription,
  threadRowName,
} from './thread-tree';

const GLYPH: Record<ThreadNode['row']['activity'], IconName> = {
  chat: 'chat',
  task: 'agents',
  goal: 'goal',
  unknown: 'info',
};

const EMPTY: Record<ThreadTypeFilter, string> = {
  all: 'No Threads yet.',
  chat: 'No Chats yet.',
  task: 'No Tasks yet.',
  goal: 'No Goals yet.',
};

/** The Thread route open in the main view, without an Artifact review suffix. */
function currentThreadRoute(pathname: string): string | null {
  const match = /^\/w\/([^/]+)\/t\/([^/]+)/.exec(pathname);
  return match ? `/w/${match[1]}/t/${match[2]}` : null;
}

/** The one trailing indicator (ia.md §1): attention dot, unread count, or a quiet spinner. */
function Indicator({ indicator }: { indicator: ThreadIndicator }) {
  if (indicator.kind === 'needs-you') {
    return (
      <span
        aria-hidden
        data-indicator="needs-you"
        className="size-2 shrink-0 rounded-full border border-notice-fg bg-attention-dot"
      />
    );
  }
  if (indicator.kind === 'unread') {
    return (
      <span data-indicator="unread" className="shrink-0">
        <CountBadge count={indicator.count} tone="neutral" />
      </span>
    );
  }
  if (indicator.kind === 'working') {
    return (
      <span data-indicator="working" aria-hidden className="shrink-0 text-fg-muted">
        <Icon name="spinner" size="sm" className="animate-spin motion-reduce:animate-none" />
      </span>
    );
  }
  return null;
}

/**
 * One Workspace's Threads as a navigation tree (ia.md §1).
 *
 * One list for every type: the glyph tells the type, and a Task sits under its Goal by
 * `thread.parentThreadId`. Each row is a link, so the open Thread is `aria-current="page"`,
 * and arrow keys move between rows and expand or collapse a parent.
 *
 * Necessity: the desktop sidebar, the phone drawer and the phone Work page show the same rows.
 * Ablation: a second row renderer would drift from the route and hint each activity opens.
 */
export function WorkspaceThreadTree({
  workspaceId,
  workspaceName,
  filter = 'all',
}: {
  workspaceId: string;
  workspaceName: string;
  filter?: ThreadTypeFilter;
}) {
  const { pathname } = useLocation();
  const navigation = useConversationNavigation(workspaceId);
  const descriptionPrefix = useId();
  const wide = !useFullWidthRows();
  const submissions = useMutationState({
    filters: { mutationKey: chatKeys.submitMutation, status: 'pending' },
    select: (mutation) => mutation.state.variables as { workspaceId: string; threadId: string },
  });
  const waiting = new Set(
    submissions.filter((input) => input.workspaceId === workspaceId).map((input) => input.threadId)
  );
  const rows = (navigation.data ?? []).toSorted(
    (a, b) => Number(waiting.has(b.thread.id)) - Number(waiting.has(a.thread.id))
  );
  const nodes = nestThreadRows(filterThreadRows(rows, filter));
  const [limit, setLimit] = useState(GROUP_PAGE_ROWS);
  const shown = nodes.slice(0, limit);
  const hiddenLoaded = Math.max(0, nodes.length - limit);
  const selectedRoute = currentThreadRoute(pathname);

  // Keep the parent of the open Thread expanded when the route moves to one of its children.
  const openParent =
    shown.find((node) =>
      node.children.some((child) => threadPath(workspaceId, child.row.thread.id) === selectedRoute)
    )?.row.thread.id ?? null;
  const [expanded, setExpanded] = useState<Set<Key>>(() =>
    openParent ? new Set([openParent]) : new Set()
  );
  const [syncedParent, setSyncedParent] = useState(openParent);
  if (openParent !== syncedParent) {
    setSyncedParent(openParent);
    if (openParent && !expanded.has(openParent)) setExpanded(new Set([...expanded, openParent]));
  }

  function renderNode(node: ThreadNode) {
    const { row } = node;
    const name = threadRowName(row);
    const awaitingReply = waiting.has(row.thread.id);
    const indicator = navigation.isError
      ? ({ kind: 'none' } as const)
      : threadIndicator(row, awaitingReply);
    const description = navigation.isError
      ? `${threadActivityLabel(row.activity)} · Status unavailable`
      : threadRowDescription(row, awaitingReply, node.via);
    const descriptionId = `${descriptionPrefix}-${row.thread.id}`;
    return (
      <NavigationTreeItem
        key={row.thread.id}
        id={row.thread.id}
        textValue={name}
        href={threadPath(workspaceId, row.thread.id)}
        routerOptions={{ state: threadRouteState(row.activity) }}
        className="group/row relative rounded-ok outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-solid data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
      >
        <NavigationTreeItemContent>
          {({ isCurrent, isExpanded, hasChildItems, level }) => (
            <div
              className={[
                'relative flex h-control-md min-w-0 items-center gap-2 rounded-ok pr-2 text-sm transition-colors',
                isCurrent
                  ? 'bg-selected font-bold text-fg-strong'
                  : 'font-medium text-fg hover:bg-overlay',
              ].join(' ')}
              style={{ paddingInlineStart: level > 1 ? '28px' : '12px' }}
            >
              {hasChildItems ? (
                <AriaButton
                  slot="chevron"
                  className="absolute left-0 z-10 flex size-3 items-center justify-center rounded-sm text-fg-muted outline-none hover:text-fg data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
                >
                  <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size="sm" />
                </AriaButton>
              ) : null}
              <TooltipTrigger delay={0} closeDelay={0}>
                <Link
                  aria-describedby={descriptionId}
                  className="flex min-w-0 flex-1 items-center gap-2 outline-none after:absolute after:inset-0 after:content-['']"
                >
                  <Icon name={GLYPH[row.activity] ?? 'info'} />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                </Link>
                {/* The full name and state, and "via <parent>" for a flattened row (ia.md §1). */}
                <Tooltip
                  placement={wide ? 'right top' : 'bottom start'}
                  className="flex max-h-[100vh] min-w-0 flex-col overflow-hidden break-all"
                >
                  <span className="line-clamp-3 break-all font-bold">{name}</span>
                  <span className="break-all">{description}</span>
                </Tooltip>
              </TooltipTrigger>
              <Indicator indicator={indicator} />
              <span id={descriptionId} hidden>
                {description}
              </span>
            </div>
          )}
        </NavigationTreeItemContent>
        {node.children.map(renderNode)}
      </NavigationTreeItem>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {navigation.isPending ? (
        <p role="status" className="px-3 text-xs text-fg-muted">
          Loading Threads…
        </p>
      ) : null}
      {navigation.isError ? (
        <div role="status" className="px-3 text-xs text-notice-fg">
          <p>
            Thread status unavailable
            {rows.length ? ' — showing the last update.' : '.'}
          </p>
          <ActionButton isQuiet size="sm" onPress={() => void navigation.refetch()}>
            Retry Threads
          </ActionButton>
        </div>
      ) : null}
      {navigation.isSuccess && nodes.length === 0 ? (
        <p className="px-3 py-1 text-xs text-fg-muted">{EMPTY[filter]}</p>
      ) : null}
      {shown.length > 0 ? (
        <NavigationTree
          aria-label={`${workspaceName} Threads`}
          selectedRoute={selectedRoute}
          expandedKeys={expanded}
          onExpandedChange={setExpanded}
          className="flex flex-col gap-0.5 outline-none"
        >
          {shown.map(renderNode)}
        </NavigationTree>
      ) : null}
      {hiddenLoaded > 0 || navigation.hasNextPage ? (
        <ActionButton
          isQuiet
          className="justify-start px-3 text-fg-muted"
          isDisabled={navigation.isFetchingNextPage}
          onPress={() => {
            setLimit(limit + GROUP_PAGE_ROWS);
            if (hiddenLoaded < GROUP_PAGE_ROWS && navigation.hasNextPage) {
              void navigation.fetchNextPage();
            }
          }}
        >
          {hiddenLoaded > 0 ? `Show ${hiddenLoaded} more` : 'Show more'}
        </ActionButton>
      ) : null}
    </div>
  );
}
