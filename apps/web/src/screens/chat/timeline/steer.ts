import type { TimelineItem } from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { lintCopyText, timelineCopy } from './copy';

/**
 * Sentences for live steer. They live beside the timeline copy module because
 * that file is owned by another lane for this landing. The same U11 lint covers them.
 */
export const steerCopy = {
  sending: 'Sending',
  steer: 'Steer',
  keepDraft: 'Keep draft',
  check: 'Check',
  retry: 'Retry',
  clearExtras: 'Remove extra choices',
  consequence:
    "Sends this note into the run in progress. Accepted means the worker's runtime took it, not that the model acted on it. Work already done is not undone.",
  unqualified: "This worker can't take notes while running.",
  accepted: 'Accepted by the running worker',
  notDelivered: 'Not delivered',
  notDeliveredDetail: 'The draft is still here. Try again, or stop the run.',
  unknown: 'Delivery unknown',
  unknownDetail: "We can't confirm the worker took this note. Check before trying again.",
  ended: 'The run ended before this note arrived.',
  busy: 'The worker is already taking another note.',
  conflict: 'This note does not match the one already sent.',
  inapplicable:
    'This note can only include text. Remove the other choices, or stop the run and send them as a new run.',
} as const;

export type SteerDeliveryState = 'sending' | 'accepted' | 'not-delivered' | 'unknown';

/** A command result that has no timeline receipt yet. */
export interface SteerFailureView {
  kind: 'not-delivered' | 'unknown';
  reason: string | null;
  replay: SteerReplay;
}

/** Exact target, text, and request identifier for Check or Retry. */
export interface SteerReplay {
  turnId: string;
  requestId: string;
  text: string;
}

/** Receipt joined onto one user message by the timeline read. */
export interface SteerReceiptView {
  requestId: string;
  state: SteerDeliveryState;
  reason: string | null;
  /** Exact text when the read included the complete message. Null when only a preview is present. */
  text: string | null;
  turnId: string;
}

export interface SteerLiveMode {
  mode: 'steer' | 'keep-draft';
  turnId: string;
  consequence: string;
  actionLabel: string;
}

const KNOWN_REASONS: Record<string, string> = {
  steer_unsupported: steerCopy.unqualified,
  steer_target_stale: steerCopy.ended,
  steer_busy: steerCopy.busy,
  idempotency_key_conflict: steerCopy.conflict,
};

/** Plain reason. Codes and identifiers stay off the outcome line. */
export function steerReasonSentence(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const known = KNOWN_REASONS[reason];
  if (known) return known;
  if (reason.includes('_') || lintCopyText(reason).length > 0) return null;
  return reason;
}

/** Visible title and optional detail for one receipt state. */
export function steerOutcomeCopy(
  state: SteerDeliveryState,
  reason: string | null
): { title: string; detail: string | null } {
  switch (state) {
    case 'sending':
      return { title: steerCopy.sending, detail: null };
    case 'accepted':
      return { title: steerCopy.accepted, detail: null };
    case 'not-delivered':
      return {
        title: steerCopy.notDelivered,
        detail: steerReasonSentence(reason) ?? steerCopy.notDeliveredDetail,
      };
    case 'unknown':
      return {
        title: steerCopy.unknown,
        detail: steerReasonSentence(reason) ?? steerCopy.unknownDetail,
      };
  }
}

const STEER_STATES = ['available', 'busy', 'unsupported', 'unavailable'] as const;

type SteerState = (typeof STEER_STATES)[number];

/** Catalog fields the composer may read. Anything absent is not availability. */
export interface SteerCatalogTarget {
  kind: string;
  activeTurnId?: string | null;
  steerAvailability?: string | null;
  steerUnavailableReason?: string | null;
}

function steerState(value: string | null | undefined): SteerState | null {
  return STEER_STATES.find((state) => state === value) ?? null;
}

function exactTurnId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Composer action while a Task run is open.
 * Steer only when the running Worker read says available and names the exact Turn.
 * After the run ends, a leftover activeTurnId does not keep Steer on screen.
 * The Coordinator is never a steer target. A missing field keeps the draft.
 */
export function composerLiveMode(input: {
  task: boolean;
  runningTurnId: string | null;
  targets?: readonly SteerCatalogTarget[] | null;
}): SteerLiveMode | null {
  if (!input.task || !input.runningTurnId) return null;
  const worker = input.targets?.find((target) => target.kind === 'running-worker');
  const availability = steerState(worker?.steerAvailability);
  const activeTurnId = exactTurnId(worker?.activeTurnId);
  if (worker && availability === 'available' && activeTurnId) {
    return {
      mode: 'steer',
      turnId: activeTurnId,
      consequence: steerCopy.consequence,
      actionLabel: steerCopy.steer,
    };
  }
  const refused = availability === 'busy' || availability === 'unavailable';
  return {
    mode: 'keep-draft',
    turnId: input.runningTurnId,
    consequence: refused ? timelineCopy.keepDraft : steerCopy.unqualified,
    actionLabel: steerCopy.keepDraft,
  };
}

/** Check and Retry only when the exact text is still in the read. */
export function steerReplayFrom(receipt: SteerReceiptView): SteerReplay | null {
  if (!receipt.text) return null;
  if (receipt.state !== 'not-delivered' && receipt.state !== 'unknown') return null;
  return { turnId: receipt.turnId, requestId: receipt.requestId, text: receipt.text };
}

/** A transport loss or an unproved outcome is unknown. A definite refusal is not delivered. */
export function classifySteerError(error: unknown): 'not-delivered' | 'unknown' {
  if (error instanceof ApiCallError && error.code === 'steer_outcome_unknown') return 'unknown';
  if (error instanceof ApiCallError) {
    if (error.status === 0 || error.status === 408 || error.status === 504 || error.status >= 500) {
      return 'unknown';
    }
    return 'not-delivered';
  }
  return 'unknown';
}

export function steerErrorCode(error: unknown): string | null {
  if (error instanceof ApiCallError && error.code) return error.code;
  return null;
}

function messageText(item: TimelineItem): string | null {
  if (item.detail.kind !== 'complete') return null;
  const value = item.detail.value;
  if (value.type === 'user-message') return value.text;
  return null;
}

function addReceipt(map: Map<string, SteerReceiptView>, item: TimelineItem | null | undefined) {
  if (!item?.steer) return;
  map.set(item.id, {
    requestId: item.steer.requestId,
    state: item.steer.state,
    reason: item.steer.reason,
    text: messageText(item),
    turnId: item.turnId,
  });
}

/** Receipt states from the timeline window. An item with no receipt is omitted. */
export function steerReceipts(
  held:
    | {
        runs?: readonly {
          narrative?: readonly TimelineItem[];
          plan?: TimelineItem | null;
        }[];
        itemWindow?: { items?: readonly TimelineItem[] } | null;
      }
    | null
    | undefined
): ReadonlyMap<string, SteerReceiptView> {
  const map = new Map<string, SteerReceiptView>();
  for (const run of held?.runs ?? []) {
    for (const item of run.narrative ?? []) addReceipt(map, item);
    addReceipt(map, run.plan);
  }
  for (const item of held?.itemWindow?.items ?? []) addReceipt(map, item);
  return map;
}

/** Receipts from every held window of this thread. The first window that has one wins. */
export function steerReceiptsFromWindows(
  windows: readonly unknown[]
): ReadonlyMap<string, SteerReceiptView> {
  const map = new Map<string, SteerReceiptView>();
  for (const held of windows) {
    if (held != null && typeof held !== 'object') continue;
    for (const [id, receipt] of steerReceipts(held as Parameters<typeof steerReceipts>[0])) {
      if (!map.has(id)) map.set(id, receipt);
    }
  }
  return map;
}

/** True when this request already has a timeline receipt, so the banner is not a second source. */
export function receiptCoversRequest(
  receipts: ReadonlyMap<string, SteerReceiptView>,
  requestId: string | undefined
): boolean {
  if (!requestId) return false;
  for (const receipt of receipts.values()) {
    if (receipt.requestId === requestId) return true;
  }
  return false;
}
