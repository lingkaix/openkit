import type { FsStore } from '../lib/store.js';
import type { ControlAdmission } from '../storage/control-store-admission.js';

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
 * Native command admission selects existing history and commits its original receipt in the same SQL transaction. The enclosing command owner retains request replay and conflicts.
 *
 * @param store Canonical Thread owner after current Workspace admission.
 * @param workspaceId Exact authorized Workspace.
 * @param userId Authenticated Timeline owner.
 * @param initialName Name used only when creating the first Timeline.
 * @param admission Original command receipt and admitted Audit when opening the Timeline is a native command.
 * @returns Existing or newly committed private Assistant Thread after acknowledgement.
 */
export async function openAssistantTimeline(
  store: FsStore,
  workspaceId: string,
  userId: string,
  initialName: string,
  admission?: Pick<ControlAdmission, 'receipt' | 'audit'>
) {
  const existing = findAssistantTimeline(store, workspaceId, userId);
  if (existing && (!admission || !store.getDataRoot())) return existing;
  return store.createThread(
    workspaceId,
    initialName,
    admission?.receipt.response.id,
    'conversation',
    { visibility: 'private', privateOwnerUserId: userId },
    admission
  );
}
