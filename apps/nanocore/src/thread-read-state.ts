import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldMain } from 'node:timers/promises';
import type { Item } from '@openkit/protocol';
import type { FsStore } from './lib/store.js';
import { OperationError } from './operation-error.js';
import { getControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { type CoreDb, openUserReadDb } from './storage/db.js';
import { userDbPath } from './storage/fs-layout.js';
import { advanceThreadReadReceipt, readThreadReadReceipt } from './storage/thread-read-receipts.js';

/** Current source identity and authenticated receipt owner; no caller-selected User is accepted by the API. */
interface ThreadReadOwner {
  store: FsStore;
  coreDb: CoreDb;
  userId: string;
  workspaceId: string;
  threadId: string;
  /** Existing dispatcher admission; remains on Main across native opening. */
  recheckAdmission?: (() => Promise<void>) | undefined;
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

/** Drains the same complete source proof without holding Main across released contributions. */
async function eligibleMessageItemIds(owner: ThreadReadOwner): Promise<string[]> {
  const steps = owner.store.listThreadTurnsSteps(owner.workspaceId, owner.threadId);
  let deadline = performance.now() + 8;
  try {
    for (;;) {
      const step = steps.next();
      if (step.done)
        return receiptMessageItemIds(
          step.value.flatMap((turn) => turn.items),
          owner.userId
        );
      if (performance.now() >= deadline) {
        await yieldMain();
        await owner.recheckAdmission?.();
        deadline = performance.now() + 8;
      }
    }
  } finally {
    steps.return([]);
  }
}

/** Reads one authenticated User's receipt after the operation's current Workspace and Thread admission. */
export async function readThreadReadState(owner: ThreadReadOwner) {
  await eligibleMessageItemIds(owner);
  const db = await getControlStoreWorkerClient().openInitializedUserReadDb(
    owner.coreDb.dataRoot,
    owner.userId
  );
  try {
    await owner.recheckAdmission?.();
    const currentEligible = await eligibleMessageItemIds(owner);
    return projectReadState(
      currentEligible,
      readThreadReadReceipt(db, owner.workspaceId, owner.threadId)
    );
  } finally {
    db.sqlite.close();
  }
}

/** Unions actual displayed identities; omitted identities mean the caller explicitly selected Mark read. */
export async function markThreadRead(
  owner: ThreadReadOwner & { itemIds?: readonly string[] | undefined }
) {
  const eligible = await eligibleMessageItemIds(owner);
  const selected = owner.itemIds ?? eligible;
  const allowed = new Set(eligible);
  if (selected.some((id) => !allowed.has(id))) {
    throw new OperationError(
      'invalid_input',
      'Read receipts require completed messages in this Thread.',
      400
    );
  }
  let currentEligible = eligible;
  const revalidate = async () => {
    await owner.recheckAdmission?.();
    currentEligible = await eligibleMessageItemIds(owner);
    const allowed = new Set(currentEligible);
    if (selected.some((id) => !allowed.has(id)))
      throw new OperationError(
        'invalid_input',
        'Read receipts require completed messages in this Thread.',
        400
      );
  };
  const db = await getControlStoreWorkerClient().openInitializedUserReadDb(
    owner.coreDb.dataRoot,
    owner.userId
  );
  try {
    await revalidate();
    const recorded = await advanceThreadReadReceipt(
      db,
      owner.workspaceId,
      owner.threadId,
      selected,
      revalidate
    );
    return projectReadState(currentEligible, recorded);
  } finally {
    db.sqlite.close();
  }
}

/** Reads only the authenticated User's retained membership; eligibility is resolved by the timeline's source snapshot. */
export function readThreadReceiptMembership(owner: Omit<ThreadReadOwner, 'store'>): string[] {
  if (!existsSync(userDbPath(owner.coreDb.dataRoot, owner.userId))) return [];
  const db = openUserReadDb(owner.coreDb.dataRoot, owner.userId);
  try {
    return readThreadReadReceipt(db, owner.workspaceId, owner.threadId);
  } finally {
    db.sqlite.close();
  }
}
