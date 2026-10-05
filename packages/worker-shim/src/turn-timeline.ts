import { constants } from 'node:os';

/** Temporary shared vocabulary; the forthcoming runtime lifecycle owner can replace it here. */
export const TURN_TIMELINE_LABELS = [
  'turn_start',
  'native_accepted',
  'native_first',
  'native_last',
  'transcript',
  'heartbeat',
  'reconnect',
  'interrupt',
  'terminal',
  'host_exit',
  'native_stop',
  'loopback_drain',
  'sealed',
] as const;

/** Serialized diagnostics key/value budget, including JSON escaping in its enclosing map. */
export const TURN_TIMELINE_BYTES = 4096;
const MAX_ENTRIES = 48;
const REASONS = [
  'attempt',
  'accepted',
  'rejected',
  'completed',
  'failed',
  'interrupted',
  'proved',
  'unknown',
] as const;

/** Value-free observations admitted by the single shared recorder. Native adapters supply only events and exit evidence. */
export interface TurnLifecycleFact {
  readonly label:
    | (typeof TURN_TIMELINE_LABELS)[number]
    | 'native_event'
    | 'transcript_enqueue'
    | 'transcript_delivered'
    | 'transcript_failed';
  readonly reason?: (typeof REASONS)[number];
  readonly count?: number;
  readonly durationMs?: number;
  readonly code?: number | null;
  readonly signal?: NodeJS.Signals | null;
}

/** Single optional contribution function, with no native payload or arbitrary metadata. */
export type TurnLifecycleRecorder = (fact: TurnLifecycleFact) => void;

/** Wraps a diagnostic callback once at admission so instrumentation cannot alter its caller's outcome. */
export function containTurnLifecycleRecorder(
  recorder: TurnLifecycleRecorder
): TurnLifecycleRecorder;
export function containTurnLifecycleRecorder(
  recorder: TurnLifecycleRecorder | undefined
): TurnLifecycleRecorder | undefined;
export function containTurnLifecycleRecorder(
  recorder: TurnLifecycleRecorder | undefined
): TurnLifecycleRecorder | undefined {
  if (!recorder) return undefined;
  return (fact) => {
    try {
      recorder(fact);
    } catch {
      /* Optional diagnostic failure has no execution authority. */
    }
  };
}

/** Compact bounded observation emitted in the sealed diagnostic value. */
interface Entry {
  label: (typeof TURN_TIMELINE_LABELS)[number];
  ms: number;
  reason?: (typeof REASONS)[number];
  count?: number;
  durationMs?: number;
  code?: number;
  signal?: NodeJS.Signals;
  delivered?: number;
  failed?: number;
}

/** Bounds numeric evidence and rejects non-finite values rather than serializing native data. */
function boundedNumber(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0
    ? Math.min(1_000_000_000, Math.floor(value))
    : undefined;
}

/** One bounded in-memory recorder owned by the shared Turn, frozen at terminal sealing. */
export class TurnTimeline {
  private readonly start = performance.now();
  private readonly startedAt = new Date().toISOString();
  private readonly entries: Entry[] = [{ label: 'turn_start', ms: 0 }];
  private dropped = 0;
  private sealed = false;
  private hostExitSeen = false;
  private nativeCount = 0;
  private lastNativeMs = 0;
  private enqueued = 0;
  private delivered = 0;
  private failed = 0;
  private longestWait = 0;

  /** Copies only closed, bounded fields; callbacks after sealing cannot change the payload. */
  public readonly record: TurnLifecycleRecorder = containTurnLifecycleRecorder((fact) => {
    if (this.sealed) return;
    // Read core fields once so getters cannot substitute unchecked values after validation.
    const { label, reason, count, durationMs, code, signal } = fact;
    const ms = boundedNumber(performance.now() - this.start) ?? 0;
    if (label === 'native_event') {
      if (this.nativeCount === 0) this.append({ label: 'native_first', ms });
      this.nativeCount = Math.min(1_000_000_000, this.nativeCount + 1);
      this.lastNativeMs = ms;
      return;
    }
    if (label === 'transcript_enqueue') {
      this.enqueued = Math.min(1_000_000_000, this.enqueued + 1);
      return;
    }
    if (label === 'transcript_delivered' || label === 'transcript_failed') {
      if (label === 'transcript_delivered')
        this.delivered = Math.min(1_000_000_000, this.delivered + 1);
      else this.failed = Math.min(1_000_000_000, this.failed + 1);
      this.longestWait = Math.max(this.longestWait, boundedNumber(durationMs ?? 0) ?? 0);
      return;
    }
    if (!TURN_TIMELINE_LABELS.includes(label)) return;
    if (label === 'host_exit') {
      if (this.hostExitSeen) return;
      this.hostExitSeen = true;
    }
    const entry: Entry = { label: label, ms };
    if (reason !== undefined && REASONS.includes(reason)) entry.reason = reason;
    if (count !== undefined) {
      const boundedCount = boundedNumber(count);
      if (boundedCount !== undefined) entry.count = boundedCount;
    }
    if (durationMs !== undefined) {
      const boundedDuration = boundedNumber(durationMs);
      if (boundedDuration !== undefined) entry.durationMs = boundedDuration;
    }
    if (code !== undefined && code !== null && Number.isInteger(code) && Math.abs(code) <= 65535)
      entry.code = code;
    if (typeof signal === 'string' && Object.hasOwn(constants.signals, signal))
      entry.signal = signal;
    this.append(entry);
  });

  /** Freezes observed facts even when snapshot construction fails; successful closeout needs no serialization. */
  public freeze(): void {
    if (this.sealed) return;
    try {
      if (this.nativeCount > 0) {
        // Insert the last event at its observed time, not the later sealing time.
        this.append({ label: 'native_last', ms: this.lastNativeMs, count: this.nativeCount });
        this.entries.sort((a, b) => a.ms - b.ms);
      }
      this.record({ label: 'transcript', count: this.enqueued, durationMs: this.longestWait });
      const summary = this.entries.at(-1)!;
      summary.delivered = this.delivered;
      summary.failed = this.failed;
      this.record({ label: 'sealed' });
    } finally {
      this.sealed = true;
    }
  }

  /** Serializes the frozen value-free snapshot and enforces its enclosing key/value byte budget. */
  public seal(): string {
    this.freeze();
    let value = this.serialize();
    while (
      Buffer.byteLength(JSON.stringify({ timeline: value })) > TURN_TIMELINE_BYTES &&
      this.entries.length > 2
    ) {
      this.entries.splice(1, 1);
      this.dropped += 1;
      value = this.serialize();
    }
    return value;
  }

  /** Keeps the first observations and a rolling tail; memory never grows with Turn duration. */
  private append(entry: Entry): void {
    if (this.entries.length === MAX_ENTRIES) {
      this.entries.splice(MAX_ENTRIES / 2, 1);
      this.dropped += 1;
    }
    this.entries.push(entry);
  }

  /** Compact value-free JSON, with one wall-clock anchor and monotonic offsets. */
  private serialize(): string {
    return JSON.stringify({
      startedAt: this.startedAt,
      entries: this.entries,
      dropped: this.dropped,
    });
  }
}
