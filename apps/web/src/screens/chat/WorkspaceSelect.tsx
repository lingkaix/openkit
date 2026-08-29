import { Select } from '../../primitives';
import { useWorkspaceStore } from '../workspace-store';
import { useCurrentWorkspaceId, useWorkspaces } from './data';

/** Selects the Workspace that owns Chat reads and commands. */
export function WorkspaceSelect({ onWorkspaceChange }: { onWorkspaceChange?: () => void }) {
  const workspaces = useWorkspaces();
  const workspaceId = useCurrentWorkspaceId();
  const setWorkspaceId = useWorkspaceStore((state) => state.setCurrentWorkspaceId);

  return (
    <Select
      label="Workspace"
      className="w-52 shrink-0"
      items={(workspaces.data ?? []).map((workspace) => ({
        id: workspace.id,
        label: workspace.name,
      }))}
      selectedKey={workspaceId}
      isDisabled={!workspaces.isSuccess || workspaces.data.length === 0}
      onSelectionChange={(key) => {
        const nextWorkspaceId = key == null ? null : String(key);
        if (!nextWorkspaceId || nextWorkspaceId === workspaceId) return;
        setWorkspaceId(nextWorkspaceId);
        onWorkspaceChange?.();
      }}
    />
  );
}
