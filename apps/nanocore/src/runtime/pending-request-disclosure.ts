import type { ApprovalEffectPreview } from '@openkit/app-api-schemas';
import type { Actor } from '../auth/identity.js';
import {
  currentWorkspaceAuthority,
  isCurrentDeploymentAdministrator,
} from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import type { FsStore } from '../lib/store.js';
import type { CoreDb } from '../storage/db.js';
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
    const intent = record.serverId
      ? JSON.parse(record.canonicalArgumentsJson!)
      : record.governedIntent;
    // Project only effect fields, never transport configuration, credentials or runtime context.
    const effect =
      record.serverId && record.serverId !== 'openkit-repository'
        ? {
            serverId: record.serverId,
            toolName: record.toolName,
            argumentsDigest: record.argumentsDigest,
            arguments: intent,
          }
        : record.serverId === 'openkit-repository' || intent.resourceId
          ? {
              repository: intent.resourceId,
              sourceRef: intent.sourceRef,
              commitIds: intent.commitIds,
              targetBranch: intent.targetBranch,
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
