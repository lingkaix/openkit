/**
 * Clock offset from one admitted `thread.dashboard` `serverTime` sample.
 * The sample is compared with the client round-trip midpoint. It does not
 * claim network-delay accuracy, sync quality, liveness, or that an event happened.
 * An absent or unreadable sample supplies no offset. Recorded run and event
 * times stay as the server wrote them.
 */

type ClockSample = {
  sentAtMs: number;
  offsetMs: number | null;
};

const samples = new Map<string, ClockSample>();
const listeners = new Set<() => void>();

function sampleKey(workspaceId: string, threadId: string): string {
  return `${workspaceId}\0${threadId}`;
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** Server instant minus the client round-trip midpoint, or null when the sample is absent. */
export function midpointOffsetMs(input: {
  serverTime: string | undefined;
  sentAtMs: number;
  receivedAtMs: number;
}): number | null {
  if (input.serverTime == null) return null;
  const server = Date.parse(input.serverTime);
  if (!Number.isFinite(server)) return null;
  if (!Number.isFinite(input.sentAtMs) || !Number.isFinite(input.receivedAtMs)) return null;
  const midpoint = (input.sentAtMs + input.receivedAtMs) / 2;
  return server - midpoint;
}

/**
 * Keep the newest admitted sample for one Thread.
 * A response that started before the sample already kept is ignored.
 * A missing `serverTime` clears the offset for that Thread.
 */
export function publishDashboardClockSample(input: {
  workspaceId: string;
  threadId: string;
  serverTime: string | undefined;
  sentAtMs: number;
  receivedAtMs: number;
}): void {
  const key = sampleKey(input.workspaceId, input.threadId);
  const previous = samples.get(key);
  if (previous && input.sentAtMs < previous.sentAtMs) return;
  const offsetMs = midpointOffsetMs(input);
  if (previous && previous.sentAtMs === input.sentAtMs && previous.offsetMs === offsetMs) return;
  samples.set(key, { sentAtMs: input.sentAtMs, offsetMs });
  if (previous?.offsetMs !== offsetMs) emit();
}

/** The current offset for one Thread, or null when no sample is admitted. */
export function readDashboardClockOffset(
  workspaceId: string | null,
  threadId: string
): number | null {
  if (!workspaceId) return null;
  return samples.get(sampleKey(workspaceId, threadId))?.offsetMs ?? null;
}

export function subscribeDashboardClock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drop every sample. The next admitted read is the only source of an offset. */
export function clearDashboardClockSamples(): void {
  if (samples.size === 0) return;
  samples.clear();
  emit();
}

/** Client instant plus the admitted offset. No sample leaves the client clock unchanged. */
export function correctedNow(clientNow: number, offsetMs: number | null): number {
  if (offsetMs == null) return clientNow;
  return clientNow + offsetMs;
}
