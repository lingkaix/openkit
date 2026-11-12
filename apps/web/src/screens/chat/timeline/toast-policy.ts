import { fillCopy } from './copy';
import { timelineNotices } from './notices';

/** One toast per thread inside this window. A burst in the window merges. */
export const TOAST_MERGE_MS = 120_000;
export const PHONE_TOAST_LIMIT = 1;
export const DESKTOP_TOAST_LIMIT = 3;
export const FAILURE_TOAST_MS = 8_000;

const DECISION_KINDS = new Set([
  'approval',
  'question',
  'artifact_review',
  'knowledge_review',
  'workspace_review',
  'external_side_effect',
  'pending_input',
]);

const RESPOND_ACTIONS = new Set([
  'grant_approval',
  'deny_approval',
  'answer_question',
  'accept_review',
  'request_refinement',
  'accept_knowledge',
  'reject_knowledge',
  'withdraw_request',
]);

export type PolicyEvent = 'decision' | 'failure' | 'handoff' | 'ignore';

/** One attention row, already classified, plus the facts the reads actually carry. */
export interface PolicyRow {
  id: string;
  objectId: string;
  blocking: boolean;
  threadId: string | null;
  threadName: string | null;
  /** Denied and unknown audiences never produce a title or a toast. */
  audience: 'open' | 'denied' | 'unknown';
  event: PolicyEvent;
  title: string;
  ageLabel: string | null;
  href: string | null;
  /** True only when an authorized record says the viewer waits on this work. */
  viewerWaitsOn?: boolean;
  /** True only when an authorized record says the viewer caused the handoff. */
  viewerCaused?: boolean;
}

export interface PolicyToast {
  id: string;
  message: string;
  href: string;
  actionLabel: 'View';
  lifetimeMs: number | null;
  objectIds: string[];
  threadId: string | null;
  overflow: boolean;
}

export interface ToastSession {
  /** The first read after mount or an account switch only records what is already there. */
  priming: boolean;
  seen: ReadonlyMap<string, boolean>;
  toastedObjectIds: ReadonlySet<string>;
  lastToastAtByThread: ReadonlyMap<string, number>;
  queued: readonly PolicyRow[];
  dismissedIds: ReadonlySet<string>;
  visible: readonly PolicyToast[];
}

export interface ToastPolicyInput {
  now: number;
  phone: boolean;
  focused: boolean;
  sheetOrDialogOpen: boolean;
  viewingThreadId: string | null;
  rows: readonly PolicyRow[];
}

export interface ToastPolicyStep {
  session: ToastSession;
  visible: readonly PolicyToast[];
  /** Row ids the step still leaves for Needs you and Action Center. Dismissal does not drop them. */
  retainedRowIds: readonly string[];
}

export function emptyToastSession(): ToastSession {
  return {
    priming: true,
    seen: new Map(),
    toastedObjectIds: new Set(),
    lastToastAtByThread: new Map(),
    queued: [],
    dismissedIds: new Set(),
    visible: [],
  };
}

/** Object toasted once per tab. An approval uses the request id so a later blocking change is the same object. */
export function attentionObjectId(row: {
  id: string;
  source: { type: string; approvalRequestId?: string };
}): string {
  if (row.source.type === 'approval' && row.source.approvalRequestId) {
    return row.source.approvalRequestId;
  }
  return row.id;
}

/**
 * Decision and failure toasts from an attention row. Anything else stays in Action Center.
 * Failure requires origin.viewerStartedRun. Null, false, and a missing origin stay off.
 * The caller does not infer that fact. An attention row never becomes a handoff toast.
 * That toast comes only from the admitted confirm or selection response in this tab.
 */
export function classifyAttentionEvent(
  row: {
    kind: string;
    blocking?: boolean;
    actions: readonly { kind: string }[];
    source: { type: string; itemType?: string; disposition?: string };
  },
  facts: { viewerWaitsOn?: boolean; viewerCaused?: boolean } = {}
): PolicyEvent {
  if (
    DECISION_KINDS.has(row.kind) &&
    row.blocking === true &&
    row.actions.some((action) => RESPOND_ACTIONS.has(action.kind))
  ) {
    return 'decision';
  }
  const failed = row.kind === 'blocked_turn' || row.kind === 'checkpoint_recovery';
  const unknownOutcome =
    row.source.type === 'execution_attempt' && row.source.disposition === 'unknown';
  if ((failed || unknownOutcome) && facts.viewerWaitsOn === true) return 'failure';
  return 'ignore';
}

export function attentionAgeLabel(ageSeconds: number | undefined): string | null {
  if (ageSeconds === undefined || ageSeconds < 0) return null;
  if (ageSeconds < 60) return 'now';
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

function canShow(row: PolicyRow, viewingThreadId: string | null): boolean {
  if (row.event === 'ignore') return false;
  if (row.event === 'failure' && row.viewerWaitsOn !== true) return false;
  if (row.event === 'handoff' && row.viewerCaused !== true) return false;
  if (row.audience !== 'open') return false;
  if (!row.href) return false;
  if (row.threadId && row.threadId === viewingThreadId) return false;
  if (row.event === 'decision' && !row.blocking) return false;
  return true;
}

function isFresh(row: PolicyRow, seen: ReadonlyMap<string, boolean>): boolean {
  const previous = seen.get(row.id);
  if (row.event === 'decision') {
    if (previous === undefined) return row.blocking;
    return previous === false && row.blocking;
  }
  return previous === undefined;
}

function stillCurrent(
  queued: PolicyRow,
  rows: readonly PolicyRow[],
  viewingThreadId: string | null
): PolicyRow | null {
  const current = rows.find((row) => row.id === queued.id);
  if (!current) return null;
  if (current.objectId !== queued.objectId) return null;
  if (!canShow(current, viewingThreadId)) return null;
  return current;
}

function toastOf(row: PolicyRow): PolicyToast {
  const threadName = row.threadName?.trim() || timelineNotices.untitledConversation;
  const parts = [row.title, threadName];
  if (row.ageLabel) parts.push(row.ageLabel);
  return {
    id: `toast-${row.objectId}`,
    message: parts.join(' · '),
    href: row.href ?? '/attention',
    actionLabel: 'View',
    lifetimeMs: row.event === 'decision' ? null : FAILURE_TOAST_MS,
    objectIds: [row.objectId],
    threadId: row.threadId,
    overflow: false,
  };
}

function mergedToast(rows: readonly PolicyRow[], now: number): PolicyToast {
  const threadName = rows[0]?.threadName?.trim() || timelineNotices.untitledConversation;
  const threadId = rows[0]?.threadId ?? null;
  return {
    id: `toast-merge-${threadId ?? 'workspace'}-${now}`,
    message: fillCopy(timelineNotices.mergedDecisions, { count: rows.length, thread: threadName }),
    href: rows[0]?.href ?? '/attention',
    actionLabel: 'View',
    lifetimeMs: null,
    objectIds: rows.map((row) => row.objectId),
    threadId,
    overflow: false,
  };
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

function mergeRows(
  rows: readonly PolicyRow[],
  now: number,
  lastToastAtByThread: ReadonlyMap<string, number>,
  visible: readonly PolicyToast[]
): {
  toasts: PolicyToast[];
  suppressedObjectIds: string[];
  revisions: PolicyToast[];
  carriedObjectIds: string[];
} {
  const decisions = new Map<string, PolicyRow[]>();
  const toasts: PolicyToast[] = [];
  const suppressedObjectIds: string[] = [];
  const revisions: PolicyToast[] = [];
  const carriedObjectIds: string[] = [];
  for (const row of rows) {
    if (row.event === 'decision' && row.threadId) {
      const group = decisions.get(row.threadId) ?? [];
      group.push(row);
      decisions.set(row.threadId, group);
      continue;
    }
    toasts.push(toastOf(row));
  }
  for (const [threadId, group] of decisions) {
    const last = lastToastAtByThread.get(threadId);
    const insideWindow = last !== undefined && now - last < TOAST_MERGE_MS;
    if (insideWindow) {
      const existing = visible.find((toast) => !toast.overflow && toast.threadId === threadId);
      if (existing) {
        // Decision toasts do not expire. A failure toast does, so a decision that
        // replaces one counts only decisions and uses the decision lifetime.
        const priorDecisions = existing.lifetimeMs === null ? existing.objectIds : [];
        const objectIds = uniqueIds([...priorDecisions, ...group.map((row) => row.objectId)]);
        const threadName = group[0]?.threadName?.trim() || timelineNotices.untitledConversation;
        if (priorDecisions.length === 0 && group.length === 1) {
          revisions.push({ ...toastOf(group[0]!), id: existing.id, lifetimeMs: null });
          continue;
        }
        revisions.push({
          ...existing,
          message: fillCopy(timelineNotices.mergedDecisions, {
            count: objectIds.length,
            thread: threadName,
          }),
          objectIds,
          lifetimeMs: null,
        });
        continue;
      }
      // The thread toast was collapsed. Keep the new objects in "+N more".
      if (visible.some((toast) => toast.overflow)) {
        carriedObjectIds.push(...group.map((row) => row.objectId));
        continue;
      }
      suppressedObjectIds.push(...group.map((row) => row.objectId));
      continue;
    }
    toasts.push(group.length === 1 ? toastOf(group[0]!) : mergedToast(group, now));
  }
  return { toasts, suppressedObjectIds, revisions, carriedObjectIds };
}

function capToasts(
  toasts: readonly PolicyToast[],
  limit: number,
  now: number,
  carriedIds: readonly string[]
): PolicyToast[] {
  const covered = new Set(toasts.flatMap((toast) => toast.objectIds));
  const carried = carriedIds.filter((id) => !covered.has(id));
  if (toasts.length <= limit && carried.length === 0) return [...toasts];
  const kept = Math.max(0, limit - 1);
  const hiddenIds = uniqueIds([
    ...toasts.slice(kept).flatMap((toast) => toast.objectIds),
    ...carried,
  ]);
  if (hiddenIds.length === 0) return [...toasts];
  const collapse: PolicyToast = {
    id: `overflow-${now}`,
    message: fillCopy(timelineNotices.moreToasts, { count: hiddenIds.length }),
    href: '/attention',
    actionLabel: 'View',
    lifetimeMs: null,
    objectIds: hiddenIds,
    threadId: null,
    overflow: true,
  };
  return [...toasts.slice(0, kept), collapse];
}

function objectDenied(objectId: string, rows: readonly PolicyRow[]): boolean {
  const matched = rows.filter((row) => row.objectId === objectId);
  return matched.length > 0 && matched.every((row) => row.audience === 'denied');
}

/** Drops a toast whose source is now denied. An overflow count loses only those objects. */
function admitVisible(toasts: readonly PolicyToast[], rows: readonly PolicyRow[]): PolicyToast[] {
  const visible: PolicyToast[] = [];
  for (const toast of toasts) {
    const denied = new Set(toast.objectIds.filter((id) => objectDenied(id, rows)));
    if (denied.size === 0) {
      visible.push(toast);
      continue;
    }
    const objectIds = toast.objectIds.filter((id) => !denied.has(id));
    if (objectIds.length === 0 || !toast.overflow) continue;
    visible.push({
      ...toast,
      objectIds,
      message: fillCopy(timelineNotices.moreToasts, { count: objectIds.length }),
    });
  }
  return visible;
}

function rememberSeen(
  seen: ReadonlyMap<string, boolean>,
  rows: readonly PolicyRow[]
): Map<string, boolean> {
  const next = new Map(seen);
  for (const row of rows) next.set(row.id, row.blocking);
  return next;
}

/** Compare one attention read with the session. Dismissal never removes the underlying rows. */
export function stepToastPolicy(session: ToastSession, input: ToastPolicyInput): ToastPolicyStep {
  const retainedRowIds = input.rows.map((row) => row.id);
  const seen = rememberSeen(session.seen, input.rows);
  if (session.priming) {
    return {
      retainedRowIds,
      visible: [],
      session: { ...session, priming: false, seen, visible: [] },
    };
  }
  const fresh = input.rows.filter(
    (row) =>
      canShow(row, input.viewingThreadId) &&
      !session.toastedObjectIds.has(row.objectId) &&
      isFresh(row, session.seen)
  );
  const blocked = !input.focused || input.sheetOrDialogOpen;
  if (blocked) {
    const queued = [...session.queued];
    for (const row of fresh) {
      if (!queued.some((queuedRow) => queuedRow.objectId === row.objectId)) queued.push(row);
    }
    const visible = admitVisible(
      session.visible.filter((toast) => !session.dismissedIds.has(toast.id)),
      input.rows
    );
    return {
      retainedRowIds,
      visible,
      session: { ...session, seen, queued, visible },
    };
  }
  const ready: PolicyRow[] = [];
  for (const queued of session.queued) {
    const current = stillCurrent(queued, input.rows, input.viewingThreadId);
    if (current && !session.toastedObjectIds.has(current.objectId)) ready.push(current);
  }
  for (const row of fresh) {
    if (!ready.some((item) => item.objectId === row.objectId)) ready.push(row);
  }
  const lastToastAtByThread = new Map(session.lastToastAtByThread);
  const visibleNow = admitVisible(
    session.visible.filter((toast) => !session.dismissedIds.has(toast.id)),
    input.rows
  );
  const { toasts, suppressedObjectIds, revisions, carriedObjectIds } = mergeRows(
    ready,
    input.now,
    lastToastAtByThread,
    visibleNow
  );
  const toastedObjectIds = new Set(session.toastedObjectIds);
  for (const id of suppressedObjectIds) toastedObjectIds.add(id);
  for (const id of carriedObjectIds) toastedObjectIds.add(id);
  for (const toast of revisions) {
    for (const id of toast.objectIds) toastedObjectIds.add(id);
  }
  for (const toast of toasts) {
    for (const id of toast.objectIds) toastedObjectIds.add(id);
    if (toast.threadId) lastToastAtByThread.set(toast.threadId, input.now);
  }
  const limit = input.phone ? PHONE_TOAST_LIMIT : DESKTOP_TOAST_LIMIT;
  const revisionById = new Map(revisions.map((toast) => [toast.id, toast]));
  const revised = visibleNow.map((toast) => revisionById.get(toast.id) ?? toast);
  const carried = [
    ...revised.filter((toast) => toast.overflow).flatMap((toast) => toast.objectIds),
    ...carriedObjectIds,
  ];
  // A later read with no new events keeps the collapse. Recapping would drop "+N more".
  const visible =
    toasts.length === 0 && carriedObjectIds.length === 0
      ? revised
      : capToasts(
          [...revised.filter((toast) => !toast.overflow), ...toasts],
          limit,
          input.now,
          carried
        );
  return {
    retainedRowIds,
    visible,
    session: {
      ...session,
      seen,
      queued: [],
      toastedObjectIds,
      lastToastAtByThread,
      visible,
    },
  };
}

let liveSession = emptyToastSession();
const sessionListeners = new Set<() => void>();

/** Session for the mounted timeline toasts. Unit tests use stepToastPolicy directly. */
export function getToastSession(): ToastSession {
  return liveSession;
}

/** Publishes a step. Does not notify, so a render effect can store it without looping. */
export function publishToastSession(session: ToastSession): void {
  liveSession = session;
}

/** Account switch and a denied read start over. The next attention read is a baseline. */
export function resetToastPolicy(): void {
  liveSession = emptyToastSession();
  for (const listener of sessionListeners) listener();
}

/** Fires after resetToastPolicy. */
export function subscribeToastSession(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

/** Dismiss one toast. The attention rows stay. */
export function dismissToast(session: ToastSession, toastId: string): ToastSession {
  const dismissedIds = new Set(session.dismissedIds);
  dismissedIds.add(toastId);
  return {
    ...session,
    dismissedIds,
    visible: session.visible.filter((toast) => toast.id !== toastId),
  };
}
