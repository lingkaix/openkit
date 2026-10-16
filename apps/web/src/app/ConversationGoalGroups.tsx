import type { ConversationNavigationResponse } from '@openkit/app-api-schemas';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Fragment, type ReactNode, useState } from 'react';
import { Button, Icon, NavRow } from '../primitives';
import { chatKeys, conversationThreadPath } from '../screens/chat/data';
import { goalKeys } from '../screens/goal/data';
import { useCoreClient } from './core-client';

/** One current conversation observation; Goal membership comes from goal.read alone. */
export type ConversationRow = ConversationNavigationResponse['items'][number];

/** Project canonical Goal card links and all Task attempts without admitting new work. */
export function ConversationGoalGroups({
  workspaceId,
  rows,
  unavailable,
  pathname,
  go,
  renderConversation,
}: {
  workspaceId: string;
  rows: ConversationRow[];
  unavailable: boolean;
  pathname: string;
  go: (path: string) => void;
  renderConversation: (row: ConversationRow, indent?: 0 | 1, linkedTask?: boolean) => ReactNode;
}) {
  const client = useCoreClient();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const goals = rows.filter((row) => row.activity === 'goal');
  const views = useQueries({
    queries: goals.map(({ thread }) => ({
      queryKey: goalKeys.view(workspaceId, thread.id),
      queryFn: () => client.operations['goal.read']({ workspaceId, threadId: thread.id }),
      enabled: !unavailable,
      retry: false,
      refetchInterval: 5_000,
      refetchIntervalInBackground: false,
    })),
  });
  const threads = useQuery({
    queryKey: chatKeys.threads(workspaceId),
    queryFn: async () => (await client.operations['thread.list']({ workspaceId })).items,
    enabled: goals.length > 0 && !unavailable,
    retry: false,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  const linked = new Set(
    views.flatMap((view) => view.data?.tasks.map((task) => task.threadId) ?? [])
  );

  return rows.map((row) => {
    if (row.activity !== 'goal') {
      return linked.has(row.thread.id) ? null : (
        <Fragment key={row.thread.id}>{renderConversation(row)}</Fragment>
      );
    }
    const view = views[goals.findIndex((goal) => goal.thread.id === row.thread.id)];
    const open = expanded.has(row.thread.id);
    const failed = unavailable || view?.isError || threads.isError;
    const data =
      !failed && view?.isSuccess && threads.isSuccess && view.data.goal ? view.data : null;
    const currentThreads = threads.data ?? [];
    const label = row.thread.name ?? row.thread.preview;
    return (
      <div key={row.thread.id} className="flex flex-col gap-0.5">
        <div className="flex items-center">
          <div className="min-w-0 flex-1">{renderConversation(row)}</div>
          <Button
            variant="quiet"
            size="sm"
            className="shrink-0 px-1!"
            aria-label={`${open ? 'Hide' : 'Show'} tasks for ${label}`}
            aria-expanded={open}
            onPress={() =>
              setExpanded((current) => {
                const next = new Set(current);
                if (open) next.delete(row.thread.id);
                else next.add(row.thread.id);
                return next;
              })
            }
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          </Button>
        </div>
        {open ? (
          failed || (view?.isSuccess && !view.data.goal) ? (
            <div className="pl-7 text-xs text-notice-fg">
              <p>Goal tasks are unavailable.</p>
              <Button
                variant="quiet"
                size="sm"
                onPress={() => {
                  void view?.refetch();
                  void threads.refetch();
                }}
              >
                Try again
              </Button>
            </div>
          ) : data ? (
            <>
              {data.cards.map((card) => {
                const tasks = data.tasks.filter((task) => task.cardId === card.cardId);
                return (
                  <div key={card.cardId} className="flex flex-col gap-0.5">
                    <p className="pl-7 pt-1 text-xs text-fg-muted">{card.description}</p>
                    {tasks.map((task) => {
                      const thread = currentThreads.find(
                        (candidate) => candidate.id === task.threadId
                      );
                      if (task.missing || !thread) {
                        return (
                          <p key={task.threadId} className="pl-10 text-xs text-fg-muted">
                            Task unavailable
                          </p>
                        );
                      }
                      const active = rows.find(
                        (candidate) => candidate.thread.id === task.threadId
                      );
                      const taskLabel = thread.name ?? thread.preview;
                      const path = conversationThreadPath(workspaceId, thread.id, 'task');
                      return (
                        <div key={task.threadId}>
                          {active ? (
                            renderConversation(active, 1, true)
                          ) : (
                            <NavRow
                              icon="agents"
                              label={taskLabel}
                              indent={1}
                              description={thread.status === 'archived' ? 'Archived Task' : 'Task'}
                              active={pathname === path || pathname.startsWith(`${path}/`)}
                              onPress={() => go(path)}
                            />
                          )}
                          {task.turns.length ? (
                            <ul
                              aria-label={`Attempts for ${taskLabel}`}
                              className="pl-10 text-xs text-fg-muted"
                            >
                              {task.turns.map((turn, index) => (
                                <li key={turn.turnId}>
                                  Attempt {index + 1} · {turn.status}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="pl-10 text-xs text-fg-muted">No attempts yet</p>
                          )}
                        </div>
                      );
                    })}
                    {!tasks.length ? (
                      <p className="pl-10 text-xs text-fg-muted">No Task linked</p>
                    ) : null}
                  </div>
                );
              })}
              {!data.cards.length ? (
                <p className="pl-7 text-xs text-fg-muted">No Goal cards yet</p>
              ) : null}
            </>
          ) : (
            <p className="pl-7 text-xs text-fg-muted">Loading Goal tasks…</p>
          )
        ) : null}
      </div>
    );
  });
}
