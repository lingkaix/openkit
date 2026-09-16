import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Browser storage key for the explicit Workspace switcher selection. */
export const WORKSPACE_SELECTION_STORAGE_KEY = 'openkit-workspace';

interface WorkspaceState {
  /** The workspace the chat/task surfaces act within; null until one is chosen or defaulted. */
  currentWorkspaceId: string | null;
  /**
   * Quick Chat Workspace id of the signed-in identity that made the selection.
   * Restores must match this key so a later account does not inherit it.
   */
  selectionUserKey: string | null;
  setCurrentWorkspaceId: (id: string | null) => void;
  /** Records the signed-in identity that owns the current explicit selection. */
  bindSelectionUserKey: (key: string | null) => void;
}

/**
 * UI-only selection of the active workspace (which workspace the chat starter and
 * thread surfaces operate on). This is a presentation choice, not server truth —
 * the workspace records themselves live in TanStack Query over core-client.
 * Explicit switcher or route selection persists in local storage under
 * `openkit-workspace`, scoped to the signed-in identity. Logout calls
 * `setCurrentWorkspaceId(null)`, which clears both the Workspace and the identity key.
 */
export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      currentWorkspaceId: null,
      selectionUserKey: null,
      setCurrentWorkspaceId: (id) =>
        set((state) => ({
          currentWorkspaceId: id,
          selectionUserKey: id === null ? null : state.selectionUserKey,
        })),
      bindSelectionUserKey: (key) => set({ selectionUserKey: key }),
    }),
    { name: WORKSPACE_SELECTION_STORAGE_KEY }
  )
);
