import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldMain } from 'node:timers/promises';
import type { Item } from '@openkit/protocol';
import { type FsStore, StoreRecordNotFoundError } from './lib/store.js';
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
export async function readThreadReadState(owner: ThreadReadOwner & { itemIds: readonly string[] }) {
  owner.store.getThread(owner.workspaceId, owner.threadId);
  const selected = [...new Set(owner.itemIds)];
  await selectedMessageItemIds(owner, selected, false);
  const db = await getControlStoreWorkerClient().openInitializedUserReadDb(
    owner.coreDb.dataRoot,
    owner.userId
  );
  try {
    await owner.recheckAdmission?.();
    const currentEligible = await selectedMessageItemIds(owner, selected, false);
    const state = projectReadState(
      currentEligible,
      readThreadReadReceipt(db, owner.workspaceId, owner.threadId)
    );
    return { scope: 'window' as const, ...state };
  } finally {
    db.sqlite.close();
  }
}

/** Rechecks selected canonical sources; reads filter ineligible Items, display writes refuse them. */
async function selectedMessageItemIds(
  owner: ThreadReadOwner,
  selected: readonly string[],
  requireEligible: boolean
): Promise<string[]> {
  const eligible: string[] = [];
  let deadline = performance.now() + 8;
  for (const id of selected) {
    let item: Item | undefined;
    try {
      item = owner.store.getThreadItem(owner.workspaceId, owner.threadId, id);
    } catch (error) {
      if (!(error instanceof StoreRecordNotFoundError)) throw error;
      // A missing Thread retains its original not-found result; a foreign/missing target is invalid.
      owner.store.getThread(owner.workspaceId, owner.threadId);
    }
    const isEligible = item !== undefined && receiptMessageItemIds([item], owner.userId).length > 0;
    if (!item || (requireEligible && !isEligible))
      throw new OperationError(
        'invalid_input',
        'Read receipts require completed messages in this Thread.',
        400
      );
    if (isEligible) eligible.push(id);
    if (performance.now() >= deadline) {
      await yieldMain();
      await owner.recheckAdmission?.();
      deadline = performance.now() + 8;
    }
  }
  return eligible;
}

/** Unions actual displayed identities and returns only their FULL-acknowledged selection, not history. */
export async function markThreadRead(
  owner: ThreadReadOwner & { itemIds?: readonly string[] | undefined }
) {
  owner.store.getThread(owner.workspaceId, owner.threadId);
  const explicit = owner.itemIds !== undefined;
  const selected = explicit ? [...new Set(owner.itemIds)] : await eligibleMessageItemIds(owner);
  if (explicit) await selectedMessageItemIds(owner, selected, true);
  const revalidate = async () => {
    await owner.recheckAdmission?.();
    if (explicit) {
      await selectedMessageItemIds(owner, selected, true);
      return;
    }
    // Bulk selection and current eligibility are separate proofs across native waits.
    const allowed = new Set(await eligibleMessageItemIds(owner));
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
    // The existing native owner still returns the full retained union internally.
    // Empty selections are reads there and never publish a membership row.
    await advanceThreadReadReceipt(db, owner.workspaceId, owner.threadId, selected, revalidate);
    return explicit
      ? { scope: 'window' as const, acknowledgedItemIds: selected }
      : { scope: 'thread' as const, acknowledgedCount: selected.length };
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
