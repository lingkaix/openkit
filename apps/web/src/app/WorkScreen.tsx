import { CountBadge, Tabs } from '../primitives';
import { useCurrentWorkspaceId } from '../screens/chat/data';
import { useHumanAttention } from '../screens/workspace/data';
import { ThreadLists } from './Sidebar';

/** Phone Work tab: Tasks and Goals, one segment at a time. */
export function WorkScreen() {
  const workspaceId = useCurrentWorkspaceId();
  const attention = useHumanAttention(workspaceId);
  const count = attention.data?.length ?? 0;
  return (
    <Tabs
      aria-label="Work"
      className="[&_[role=tab]]:min-h-11 [&_[role=tab]]:px-4"
      items={[
        {
          id: 'tasks',
          label: (
            <span className="inline-flex items-center gap-1">
              Tasks
              <CountBadge count={count} label="need you" />
            </span>
          ),
          content: <ThreadLists segment="tasks" />,
        },
        { id: 'goals', label: 'Goals', content: <ThreadLists segment="goals" /> },
      ]}
    />
  );
}
