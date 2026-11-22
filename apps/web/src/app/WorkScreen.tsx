import { CountBadge, Tabs } from '../primitives';
import { useCurrentWorkspaceId, useWorkspaces } from '../screens/chat/data';
import { useHumanAttention } from '../screens/workspace/data';
import { NewGoalDialog, NewTaskDialog } from './StartWorkDialogs';
import { WorkspaceThreadTree } from './sidebar/WorkspaceThreadTree';

/**
 * Phone Work section: the current Workspace's Tasks or Goals, one type at a time, with the
 * start button for that type. Rows come from the same tree as the sidebar group.
 */
export function WorkScreen() {
  const workspaceId = useCurrentWorkspaceId();
  const workspaces = useWorkspaces();
  const workspace = workspaces.data?.find((candidate) => candidate.id === workspaceId) ?? null;
  const attention = useHumanAttention(workspaceId);
  const count = attention.data?.length ?? 0;
  if (!workspace) return null;
  return (
    <Tabs
      aria-label="Work"
      items={[
        {
          id: 'tasks',
          label: (
            <span className="inline-flex items-center gap-1">
              Tasks
              <CountBadge count={count} label="need you" />
            </span>
          ),
          content: (
            <div className="flex flex-col gap-1">
              <NewTaskDialog
                key={`task:${workspace.id}`}
                workspaceId={workspace.id}
                workspaceLabel={workspace.name}
              />
              <WorkspaceThreadTree
                workspaceId={workspace.id}
                workspaceName={workspace.name}
                filter="task"
              />
            </div>
          ),
        },
        {
          id: 'goals',
          label: 'Goals',
          content: (
            <div className="flex flex-col gap-1">
              <NewGoalDialog key={`goal:${workspace.id}`} workspaceId={workspace.id} />
              <WorkspaceThreadTree
                workspaceId={workspace.id}
                workspaceName={workspace.name}
                filter="goal"
              />
            </div>
          ),
        },
      ]}
    />
  );
}
