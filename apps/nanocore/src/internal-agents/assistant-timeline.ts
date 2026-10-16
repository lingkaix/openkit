import type { FsStore } from '../lib/store.js';

/**
 * Resolves the user's single ordinary Assistant Timeline from canonical Threads.
 *
 * Existing conversations retain their identities and history. The earliest private conversation is the continuing Timeline; administration uses a separate entry. No pointer or second conversation store is required.
 *
 * @param store Canonical Thread owner after current Workspace admission.
 * @param workspaceId Exact authorized Workspace.
 * @param userId Authenticated Timeline owner.
 * @returns The existing Timeline, including its archived state, or undefined.
 */
export function findAssistantTimeline(store: FsStore, workspaceId: string, userId: string) {
  return store
    .listThreads(workspaceId)
    .filter(
      (thread) =>
        thread.entryPath === 'conversation' &&
        thread.visibility === 'private' &&
        thread.privateOwnerUserId === userId
    )
    .sort((left, right) => {
      const chronological = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      return chronological || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    })[0];
}

/**
 * Opens the Timeline without renaming, reopening, or replacing existing history.
 *
 * The synchronous store boundary prevents two fresh commands from allocating two Timelines. The enclosing command owner retains request replay and conflicts.
 *
 * @param store Canonical Thread owner after current Workspace admission.
 * @param workspaceId Exact authorized Workspace.
 * @param userId Authenticated Timeline owner.
 * @param initialName Name used only when creating the first Timeline.
 * @returns The existing or newly created private Assistant Thread.
 */
export function openAssistantTimeline(
  store: FsStore,
  workspaceId: string,
  userId: string,
  initialName: string
) {
  return (
    findAssistantTimeline(store, workspaceId, userId) ??
    store.createThread(workspaceId, initialName, undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: userId,
    })
  );
}
