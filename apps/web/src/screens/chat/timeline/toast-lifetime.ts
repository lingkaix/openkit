/** Pauses a failure toast's 8s close while the pointer or focus is inside it. */

interface Lifetime {
  remaining: number;
  started: number;
  paused: boolean;
  handle: ReturnType<typeof setTimeout> | null;
  close: (key: string) => void;
}

const lifetimes = new Map<string, Lifetime>();

function clearHandle(lifetime: Lifetime) {
  if (lifetime.handle) clearTimeout(lifetime.handle);
  lifetime.handle = null;
}

/** Starts the close timer. A second call for the same key replaces the first. */
export function armToastLifetime(
  key: string,
  lifetimeMs: number,
  close: (key: string) => void
): void {
  const previous = lifetimes.get(key);
  if (previous) clearHandle(previous);
  const lifetime: Lifetime = {
    remaining: lifetimeMs,
    started: Date.now(),
    paused: false,
    handle: null,
    close,
  };
  lifetime.handle = setTimeout(() => {
    lifetimes.delete(key);
    close(key);
  }, lifetimeMs);
  lifetimes.set(key, lifetime);
}

/** Hover or focus holds the remaining time. Leaving resumes it. */
export function pauseToastLifetime(key: string, paused: boolean): void {
  const lifetime = lifetimes.get(key);
  if (!lifetime || lifetime.paused === paused) return;
  if (paused) {
    lifetime.remaining -= Date.now() - lifetime.started;
    lifetime.paused = true;
    clearHandle(lifetime);
    return;
  }
  lifetime.paused = false;
  lifetime.started = Date.now();
  const wait = Math.max(0, lifetime.remaining);
  lifetime.handle = setTimeout(() => {
    lifetimes.delete(key);
    lifetime.close(key);
  }, wait);
}

/** Drops a timer when the toast is already gone. */
export function clearToastLifetime(key: string): void {
  const lifetime = lifetimes.get(key);
  if (!lifetime) return;
  clearHandle(lifetime);
  lifetimes.delete(key);
}

/** Test hook. Production reset goes through clearToastLifetime per key. */
export function clearAllToastLifetimes(): void {
  for (const key of [...lifetimes.keys()]) clearToastLifetime(key);
}
