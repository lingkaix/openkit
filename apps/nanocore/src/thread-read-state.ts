import type { Item } from '@openkit/protocol';
import type { FsStore } from './lib/store.js';
import { OperationError } from './operation-error.js';
import { type CoreDb, openUserDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';
import { advanceThreadReadReceipt, readThreadReadReceipt } from './storage/thread-read-receipts.js';

/** Current source identity and authenticated receipt owner; no caller-selected User is accepted by the API. */
interface ThreadReadOwner {
  store: FsStore;
  coreDb: CoreDb;
  userId: string;
  workspaceId: string;
  threadId: string;
}

/** Selects completed displayed-message kinds, excluding the viewer's own input and hidden gate input. */
export function receiptMessageItemIds(items: readonly Item[], userId: string): string[] {
  return items
    .filter((item) => {
      if (item.status !== 'completed') return false;
      if (item.type === 'assistant-message') return item.text.trim().length > 0;
      if (item.type !== 'user-message' || item.text.trim().length === 0) return false;
      if (item.actor.kind === 'user' && item.actor.id === userId) return false;
      return !(item.actor.kind === 'system' && item.actor.id === 'nanocore-pending-request');
    })
    .map((item) => item.id);
}

/** Projects only current eligible message identities; retained receipt references grant no source access. */
function projectReadState(eligible: readonly string[], recorded: readonly string[]) {
  const read = new Set(recorded);
  return {
    readItemIds: eligible.filter((id) => read.has(id)),
    unreadItemIds: eligible.filter((id) => !read.has(id)),
  };
}

/** Reads one authenticated User's receipt after the operation's current Workspace and Thread admission. */
export function readThreadReadState(owner: ThreadReadOwner) {
  const eligible = receiptMessageItemIds(
    owner.store.listThreadItems(owner.workspaceId, owner.threadId),
    owner.userId
  );
  const db = openUserDb(owner.coreDb.dataRoot, owner.userId);
  try {
    applyScopedMigrations(db);
    return projectReadState(eligible, readThreadReadReceipt(db, owner.workspaceId, owner.threadId));
  } finally {
    db.sqlite.close();
  }
}

/** Unions actual displayed identities; omitted identities mean the caller explicitly selected Mark read. */
export function markThreadRead(
  owner: ThreadReadOwner & { itemIds?: readonly string[] | undefined }
) {
  const eligible = receiptMessageItemIds(
    owner.store.listThreadItems(owner.workspaceId, owner.threadId),
    owner.userId
  );
  const selected = owner.itemIds ?? eligible;
  const allowed = new Set(eligible);
  if (selected.some((id) => !allowed.has(id))) {
    throw new OperationError(
      'invalid_input',
      'Read receipts require completed messages in this Thread.',
      400
    );
  }
  const db = openUserDb(owner.coreDb.dataRoot, owner.userId);
  try {
    applyScopedMigrations(db);
    return projectReadState(
      eligible,
      advanceThreadReadReceipt(db, owner.workspaceId, owner.threadId, selected)
    );
  } finally {
    db.sqlite.close();
  }
}
