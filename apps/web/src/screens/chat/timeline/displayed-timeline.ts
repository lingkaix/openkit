import type { HeldTimeline } from './window';

/** The window the mounted stream is actually showing. Receipts read this, not the URL. */
export interface DisplayedTimeline {
  workspaceId: string;
  threadId: string;
  data: HeldTimeline | null;
}

interface Claim extends DisplayedTimeline {
  ticket: number;
}

let issued = 0;
let current: Claim | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Record the stream's own window. Returns a ticket that only that claim may clear. */
export function publishDisplayedTimeline(next: DisplayedTimeline): number {
  issued += 1;
  const ticket = issued;
  const changed =
    current === null ||
    current.workspaceId !== next.workspaceId ||
    current.threadId !== next.threadId ||
    current.data !== next.data;
  current = { ticket, ...next };
  if (changed) notify();
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
  return current;
}
