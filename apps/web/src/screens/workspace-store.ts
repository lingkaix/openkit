import { create } from 'zustand';

interface WorkspaceState {
  /** The workspace the chat/task surfaces act within; null until one is chosen or defaulted. */
  currentWorkspaceId: string | null;
  setCurrentWorkspaceId: (id: string | null) => void;
}

/**
 * UI-only selection of the active workspace (which workspace the chat starter and
 * thread surfaces operate on). This is a presentation choice, not server truth —
 * the workspace records themselves live in TanStack Query over core-client.
 */
export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  currentWorkspaceId: null,
  setCurrentWorkspaceId: (id) => set({ currentWorkspaceId: id }),
}));
