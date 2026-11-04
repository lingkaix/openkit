import { useSyncExternalStore } from 'react';

let unsent = false;
const listeners = new Set<() => void>();

/**
 * Records whether the composer holds text or files that have not been sent.
 *
 * @param next - True while a draft would be lost by an immediate reload.
 */
export function setUnsentDraft(next: boolean): void {
  if (unsent === next) return;
  unsent = next;
  for (const listener of listeners) listener();
}

/**
 * @returns Whether an unsent composer draft is present.
 */
export function readUnsentDraft(): boolean {
  return unsent;
}

/**
 * Subscribes the update prompt to the composer draft flag.
 *
 * @returns Whether an unsent draft is present.
 */
export function useUnsentDraft(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readUnsentDraft,
    () => false
  );
}
