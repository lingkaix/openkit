import type { ApprovalEffectPreview } from '@openkit/app-api-schemas';
import type { Actor } from '../auth/identity.js';
import {
  currentWorkspaceAuthority,
  isCurrentDeploymentAdministrator,
} from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import { readMemorySuppressions } from '../knowledge/memory-maintenance.js';
import type { FsStore } from '../lib/store.js';
import type { CoreDb } from '../storage/db.js';
import { userMemoryRoot } from '../storage/fs-layout.js';
import { canonicalJsonText, type PendingRequestRecord } from './pending-requests.js';

/** Inclusive encoded presentation limits, independent of capture and delivery limits. */
export const APPROVAL_DETAIL_BYTES = 524_288;
export const APPROVAL_SUMMARY_BYTES = 2_048;

/** Bounds ordinary copy on UTF-8 boundaries and visibly labels it as a summary. */
export function approvalCardCopy(
  title: string,
  description: string
): { title: string; description: string } {
  return {
    title: shorten(title.startsWith('Summary: ') ? title : `Summary: ${title}`, 512),
    description: shorten(description, APPROVAL_SUMMARY_BYTES - 513),
  };
}

/** Projects complete immutable effect for the responsible user with current Thread access. No projection or read receipt is persisted. */
export function projectApprovalEffect(input: {
  record: PendingRequestRecord;
  store: FsStore;
  coreDb?: CoreDb | undefined;
  actor?: Actor | undefined;
}): ApprovalEffectPreview {
  const { record, store, actor, coreDb } = input;
  const administrator = Boolean(coreDb && actor && isCurrentDeploymentAdministrator(coreDb, actor));
  if (
    !actor ||
    (actor.userId !== record.responsibleUserId && !administrator) ||
    (coreDb &&
      !currentWorkspaceAuthority(
        coreDb,
        record.workspaceId,
        { kind: 'user', id: actor.userId },
        'thread.read',
        true,
        actor
      )) ||
    !isThreadIdVisible(store, record.workspaceId, record.threadId, actor.userId, administrator)
  )
    return { status: 'unavailable', reason: 'Current Thread access is unavailable.' };
  try {
    if (record.governedIntent?.operation === 'memory.forget') {
      // Retained confirmation evidence must not become a model-readable copy of forgotten Memory.
      const owner = record.governedIntent.ownerScope as
        | { kind?: unknown; userId?: unknown }
        | undefined;
      const pageId = record.governedIntent.pageId;
      if (
        !coreDb ||
        !isCanonicalUserActive(coreDb, record.responsibleUserId) ||
        owner?.kind !== 'user' ||
        owner.userId !== record.responsibleUserId ||
        typeof pageId !== 'string' ||
        readMemorySuppressions(
          userMemoryRoot(coreDb.dataRoot, record.responsibleUserId),
          record.responsibleUserId
        ).some((row) => row.payload.pageId === pageId)
      )
        return { status: 'unavailable', reason: 'The Memory target is unavailable.' };
    }
    const intent = record.serverId
      ? JSON.parse(record.canonicalArgumentsJson!)
      : record.governedIntent;
    if (!intent || typeof intent !== 'object' || Array.isArray(intent))
      return { status: 'unavailable', reason: 'Complete captured effect could not be loaded.' };
    // Project only effect fields, never transport configuration, credentials or runtime context.
    const effect = record.serverId
      ? {
          serverId: record.serverId,
          toolName: record.toolName,
          argumentsDigest: record.argumentsDigest,
          arguments: intent,
        }
      : intent;
    const detail = canonicalJsonText(effect);
    if (Buffer.byteLength(detail, 'utf8') > APPROVAL_DETAIL_BYTES)
      return { status: 'unavailable', reason: 'Complete exact effect exceeds the detail limit.' };
    const copy = approvalCardCopy(
      record.title ?? 'Approval requested',
      record.description ?? 'Inspect the complete exact effect.'
    );
    return { status: 'available', summary: `${copy.title}\n${copy.description}`, detail };
  } catch {
    return { status: 'unavailable', reason: 'Complete captured effect could not be loaded.' };
  }
}

/** Fits display text by encoded bytes without splitting a Unicode scalar value. */
function shorten(value: string, bytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= bytes) return value;
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(`${result}${character}…`, 'utf8') > bytes) break;
    result += character;
  }
  return `${result}…`;
}
