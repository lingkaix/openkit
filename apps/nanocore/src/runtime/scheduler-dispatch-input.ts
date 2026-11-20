import { sha256Hex } from '@openkit/protocol/digest';
import type { FsStore } from '../lib/store.js';
import { StoreRecordNotFoundError } from '../lib/store-errors.js';
import type { WorkInputRef } from '../storage/control-kernel-port.js';

/** Reads exact input from its scoped Item owner. Storage faults propagate to the dispatch hold. */
export function readWorkspaceInputItem(
  store: Pick<FsStore, 'getThreadItem'>,
  scope: { readonly workspaceId: string; readonly threadId: string; readonly turnId: string },
  ref: WorkInputRef
) {
  if (ref.owner.kind !== 'workspace' || ref.owner.workspaceId !== scope.workspaceId) return null;
  try {
    const item = store.getThreadItem(scope.workspaceId, scope.threadId, ref.inputId);
    if (
      item.id !== ref.inputId ||
      item.turnId !== scope.turnId ||
      item.type !== 'user-message' ||
      item.status !== 'completed' ||
      sha256Hex(item.text) !== ref.digest
    )
      return null;
    return item;
  } catch (error) {
    if (error instanceof StoreRecordNotFoundError) return null;
    throw error;
  }
}
