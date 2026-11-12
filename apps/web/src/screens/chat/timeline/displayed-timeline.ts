import type { HeldTimeline } from './window';

/** The window the mounted stream is actually showing. Receipts read this, not the URL. */
export interface DisplayedTimeline {
  workspaceId: string;
  threadId: string;
  data: HeldTimeline | null;
}

interface Claim {
  ticket: number;
  snapshot: DisplayedTimeline;
}

let issued = 0;
let current: Claim | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function sameWindow(snapshot: DisplayedTimeline, next: DisplayedTimeline): boolean {
  return (
    snapshot.workspaceId === next.workspaceId &&
    snapshot.threadId === next.threadId &&
    snapshot.data === next.data
  );
}

/**
 * Record the stream's own window. Returns a new ticket that only that claim may clear.
 * An unchanged window keeps the exposed snapshot and does not notify. The ticket stays private.
 */
export function publishDisplayedTimeline(next: DisplayedTimeline): number {
  issued += 1;
  const ticket = issued;
  const previous = current?.snapshot;
  if (previous && sameWindow(previous, next)) {
    current = { ticket, snapshot: previous };
    return ticket;
  }
  current = {
    ticket,
    snapshot: {
      workspaceId: next.workspaceId,
      threadId: next.threadId,
      data: next.data,
    },
  };
  notify();
  return ticket;
}

/** Drop this claim when the stream unmounts. A newer claim for the same thread stays. */
export function clearDisplayedTimeline(ticket: number): void {
  if (current?.ticket !== ticket) return;
  current = null;
  notify();
}

export function subscribeDisplayedTimeline(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDisplayedTimeline(): DisplayedTimeline | null {
  return current?.snapshot ?? null;
}
