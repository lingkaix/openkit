import { createHash } from 'node:crypto';
import { readRetainedV1 } from '@openkit/protocol';
import { MAX_WORKER_RAW_OUTPUT_BYTES } from '@openkit/worker-protocol';
import { z } from 'zod';
import type { StartedCapabilityCall } from '../capability/usage-ledger.js';
import type { WorkspaceDb } from '../storage/db.js';

export { MAX_WORKER_RAW_OUTPUT_BYTES } from '@openkit/worker-protocol';

const NAMESPACE = 'openkit.worker/rawOutput';
const EXTENSION_BYTES = 1024 * 1024;
const POSITION_BYTES = 262_144;

/** Private canonical proof; absent legacy proof is unknown, never a zero measurement. */
export const WorkerRawOutputStateSchema = z
  .object({
    byteLength: z.number().int().nonnegative().safe(),
    coverage: z.enum(['pending', 'complete', 'unavailable']),
    positions: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.number().int().positive().safe()),
  })
  .strict()
  .superRefine((state, context) => {
    if (
      Object.values(state.positions).reduce((sum, value) => sum + value, 0) !== state.byteLength ||
      Buffer.byteLength(JSON.stringify(state.positions)) > POSITION_BYTES
    )
      context.addIssue({ code: 'custom', message: 'Raw output aggregate and positions disagree.' });
  });
type RawState = z.infer<typeof WorkerRawOutputStateSchema>;
/** Existing call attribution, without a dependency on disposable Turn checkpoints. */
export interface WorkerRawOutputScope {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
}
interface CallRow {
  schema_version: number;
  call_id: string;
  status: string;
  extensions_json: string | null;
}
interface Component {
  row: CallRow;
  extensions: Record<string, unknown>;
  state: RawState;
}

/** Missing or contradictory authority cannot prove output coverage. */
export class WorkerRawOutputAuthorityError extends Error {
  constructor() {
    super('Worker raw output accounting requires recovery.');
  }
}
/** Exhaustion is durable; canonical budget_exhausted still requires the native stop owner. */
export class WorkerRawOutputBudgetExceededError extends Error {
  constructor() {
    super('The Worker raw model output budget is exhausted.');
  }
}
/** First final admission waits while a source can still emit measured fields. */
export class WorkerRawOutputPendingError extends Error {
  constructor() {
    super('Worker inference is still settling.');
  }
}

/** Iterates bounded individual extensions. A corrupt oversized row is never loaded into JS whole. */
function components(db: WorkspaceDb, scope: WorkerRawOutputScope): Component[] {
  if (db.workspaceId !== scope.workspaceId) throw new WorkerRawOutputAuthorityError();
  const result: Component[] = [];
  // The Turn's raw allowance bounds content, not call count. Iterate the ledger without allocating
  // an unbounded SQL result. A bounded proof inventory refusal cannot become a clean result.
  let bytes = 0;
  for (const row of db.sqlite
    .prepare(`SELECT schema_version, call_id, status,
      CASE WHEN length(CAST(extensions_json AS BLOB)) <= ? THEN extensions_json ELSE NULL END AS extensions_json
      FROM capability_calls WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?
      AND service_ref = 'worker-inference-gateway' AND family = 'llm'`)
    .iterate(
      EXTENSION_BYTES,
      scope.workspaceId,
      scope.threadId,
      scope.turnId
    ) as Iterable<CallRow>) {
    readRetainedV1({ schemaVersion: row.schema_version }, () => undefined);
    if (!row.extensions_json) throw new WorkerRawOutputAuthorityError();
    bytes += Buffer.byteLength(row.extensions_json);
    if (bytes > 8 * 1024 * 1024) throw new WorkerRawOutputAuthorityError();
    try {
      const extensions = JSON.parse(row.extensions_json) as Record<string, unknown>;
      if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions))
        throw new WorkerRawOutputAuthorityError();
      const state = WorkerRawOutputStateSchema.parse(extensions[NAMESPACE]);
      result.push({ row, extensions, state });
    } catch {
      throw new WorkerRawOutputAuthorityError();
    }
  }
  return result;
}
/** Updates only this private namespace; existing canonical route and usage evidence survives. */
function write(db: WorkspaceDb, component: Component): void {
  component.extensions[NAMESPACE] = WorkerRawOutputStateSchema.parse(component.state);
  const encoded = JSON.stringify(component.extensions);
  if (Buffer.byteLength(encoded) > EXTENSION_BYTES) throw new WorkerRawOutputAuthorityError();
  db.sqlite
    .prepare('UPDATE capability_calls SET extensions_json = ? WHERE call_id = ?')
    .run(encoded, component.row.call_id);
}
/** Only a freshly inserted trusted inference call can acquire an empty proof. Replays cannot reset it. */
export function initializeWorkerRawOutput(
  db: WorkspaceDb,
  call: StartedCapabilityCall,
  scope: WorkerRawOutputScope
): void {
  if (
    !call.inserted ||
    call.context.workspaceId !== scope.workspaceId ||
    call.context.threadId !== scope.threadId ||
    call.context.turnId !== scope.turnId ||
    call.context.serviceRef !== 'worker-inference-gateway' ||
    call.context.family !== 'llm'
  )
    throw new WorkerRawOutputAuthorityError();
  db.sqlite
    .transaction(() => {
      const row = db.sqlite
        .prepare(
          'SELECT schema_version, call_id, status, extensions_json FROM capability_calls WHERE call_id = ?'
        )
        .get(call.id) as CallRow | undefined;
      if (row) readRetainedV1({ schemaVersion: row.schema_version }, () => undefined);
      if (!row || row.status !== 'running') throw new WorkerRawOutputAuthorityError();
      let extensions: Record<string, unknown>;
      try {
        extensions =
          row.extensions_json === null
            ? {}
            : (JSON.parse(row.extensions_json) as Record<string, unknown>);
      } catch {
        throw new WorkerRawOutputAuthorityError();
      }
      if (
        !extensions ||
        typeof extensions !== 'object' ||
        Array.isArray(extensions) ||
        NAMESPACE in extensions
      )
        throw new WorkerRawOutputAuthorityError();
      write(db, { row, extensions, state: { byteLength: 0, coverage: 'pending', positions: {} } });
    })
    .immediate();
}
/** Returns the exact Turn aggregate after validating every component, including failed retries and children. */
export function readWorkerRawOutput(
  db: WorkspaceDb,
  scope: WorkerRawOutputScope
): { rawOutputBytes: number; exhausted: boolean } {
  const all = components(db, scope);
  if (
    all.some(
      (c) =>
        c.state.coverage === 'unavailable' ||
        c.row.status === 'unknown' ||
        (c.state.coverage === 'pending' && c.row.status !== 'running')
    )
  )
    throw new WorkerRawOutputAuthorityError();
  const rawOutputBytes = all.reduce((sum, c) => sum + c.state.byteLength, 0);
  if (!Number.isSafeInteger(rawOutputBytes)) throw new WorkerRawOutputAuthorityError();
  return { rawOutputBytes, exhausted: rawOutputBytes > MAX_WORKER_RAW_OUTPUT_BYTES };
}
/** Empty new Turns are measurable without a checkpoint; any legacy inference component blocks inference. */
export function requireWorkerRawOutputAvailable(
  db: WorkspaceDb,
  scope: WorkerRawOutputScope
): void {
  if (readWorkerRawOutput(db, scope).exhausted) throw new WorkerRawOutputBudgetExceededError();
}
/** Marks the existing component unavailable without deleting its measured byte positions. */
export function invalidateWorkerRawOutputProof(
  db: WorkspaceDb,
  scope: WorkerRawOutputScope,
  callId: string
): void {
  db.sqlite
    .transaction(() => {
      const component = components(db, scope).find((c) => c.row.call_id === callId);
      if (!component) throw new WorkerRawOutputAuthorityError();
      component.state.coverage = 'unavailable';
      write(db, component);
    })
    .immediate();
}
/** Seals only after actual native sources settle. Early public cancellation permanently retains unknown coverage. */
export function settleWorkerRawOutput(
  db: WorkspaceDb,
  scope: WorkerRawOutputScope,
  callId: string,
  complete: boolean
): void {
  db.sqlite
    .transaction(() => {
      const component = components(db, scope).find((c) => c.row.call_id === callId);
      if (!component) throw new WorkerRawOutputAuthorityError();
      if (component.state.coverage === 'pending') {
        component.state.coverage = complete ? 'complete' : 'unavailable';
        write(db, component);
      }
    })
    .immediate();
}
/** Public call completion is not source settlement. Only exact complete coverage admits a completed Turn. */
export function assertWorkerRawOutputFinalStatus(
  db: WorkspaceDb,
  scope: WorkerRawOutputScope,
  completion: boolean
): void {
  const all = components(db, scope);
  if (all.some((c) => c.row.status === 'running')) throw new WorkerRawOutputPendingError();
  if (
    completion &&
    (all.some((c) => c.state.coverage !== 'complete' || c.row.status === 'unknown') ||
      all.reduce((sum, c) => sum + c.state.byteLength, 0) > MAX_WORKER_RAW_OUTPUT_BYTES)
  )
    throw new WorkerRawOutputAuthorityError();
}
/** Commits one trusted source-attempt/part watermark and the Turn-wide sum in one immediate transaction. */
export function observeWorkerRawOutput(
  db: WorkspaceDb,
  input: WorkerRawOutputScope & {
    readonly callId: string;
    readonly attemptId: string;
    readonly partId: number;
    readonly field: 'text' | 'tool-arguments' | 'reasoning';
    readonly fromBytePosition: number;
    readonly bytePosition: number;
  }
): { rawOutputBytes: number; exhausted: boolean; chargedBytes: number } {
  assertWorkerRawOutputPosition(input);
  const key = createHash('sha256')
    .update(JSON.stringify([input.attemptId, input.partId, input.field]))
    .digest('hex');
  return db.sqlite
    .transaction(() => {
      const all = components(db, input);
      const component = all.find((c) => c.row.call_id === input.callId);
      if (
        !component ||
        all.some(
          (c) =>
            c.state.coverage === 'unavailable' ||
            c.row.status === 'unknown' ||
            (c.state.coverage === 'pending' && c.row.status !== 'running')
        )
      )
        throw new WorkerRawOutputAuthorityError();
      const previous = component.state.positions[key] ?? 0;
      if (input.fromBytePosition > previous) throw new WorkerRawOutputAuthorityError();
      const chargedBytes = Math.max(0, input.bytePosition - previous);
      // A complete source cannot acquire more bytes. Prefix/final replay remains free.
      if (chargedBytes && component.state.coverage !== 'pending')
        throw new WorkerRawOutputAuthorityError();
      if (chargedBytes) component.state.positions[key] = input.bytePosition;
      component.state.byteLength += chargedBytes;
      write(db, component);
      const rawOutputBytes = all.reduce((sum, c) => sum + c.state.byteLength, 0);
      if (!Number.isSafeInteger(rawOutputBytes)) throw new WorkerRawOutputAuthorityError();
      return {
        rawOutputBytes,
        exhausted: rawOutputBytes > MAX_WORKER_RAW_OUTPUT_BYTES,
        chargedBytes,
      };
    })
    .immediate();
}

/** Existing source identity and positions, without a second call or scope representation. */
export type WorkerRawOutputPosition = Omit<
  Parameters<typeof observeWorkerRawOutput>[1],
  keyof WorkerRawOutputScope | 'callId'
>;

/** Applies the same closed source-position predicate to direct observations and coalesced watermarks. */
function assertWorkerRawOutputPosition(position: WorkerRawOutputPosition): void {
  if (
    typeof position.attemptId !== 'string' ||
    !position.attemptId ||
    position.attemptId.length > 4096 ||
    !Number.isSafeInteger(position.partId) ||
    position.partId < 0 ||
    !Number.isSafeInteger(position.fromBytePosition) ||
    position.fromBytePosition < 0 ||
    !Number.isSafeInteger(position.bytePosition) ||
    position.bytePosition < position.fromBytePosition ||
    !['text', 'tool-arguments', 'reasoning'].includes(position.field)
  )
    throw new WorkerRawOutputAuthorityError();
}

/** Shared provisional Turn total, initialized from acknowledged canonical proof by the Gateway. */
export interface WorkerRawOutputTurnWatermark {
  rawOutputBytes: number;
  exhausted: boolean;
}

/** Coalesces one actual Call; sender resolution must mean its native outer FULL acknowledgement. */
export function createWorkerRawOutputCoalescer(
  initial: RawState,
  turn: WorkerRawOutputTurnWatermark,
  send: (positions: readonly WorkerRawOutputPosition[], force: boolean) => Promise<void>
) {
  const state = WorkerRawOutputStateSchema.parse(initial);
  if (
    state.coverage !== 'pending' ||
    !Number.isSafeInteger(turn.rawOutputBytes) ||
    turn.rawOutputBytes < state.byteLength ||
    turn.exhausted !== turn.rawOutputBytes > MAX_WORKER_RAW_OUTPUT_BYTES
  )
    throw new WorkerRawOutputAuthorityError();
  const positions = { ...state.positions };
  let keys = Object.keys(positions).length;
  let inventoryBytes = Buffer.byteLength(JSON.stringify(positions));
  const pending = new Map<string, WorkerRawOutputPosition>();
  let version = 0;
  let acknowledged = 0;
  let forcePending = false;
  let failure: { error: unknown } | undefined;
  let inFlight: Promise<void> | undefined;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  const schedule = () => {
    if (scheduled || inFlight || failure || !pending.size) return;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      void flush();
    });
  };
  const flush = (): Promise<void> => {
    if (failure) return Promise.reject(failure.error);
    if (inFlight) return inFlight;
    if (!pending.size) return Promise.resolve();
    if (scheduled) clearImmediate(scheduled);
    scheduled = undefined;
    const batch = [...pending.values()];
    const target = version;
    const force = forcePending;
    forcePending = false;
    pending.clear();
    inFlight = Promise.resolve()
      .then(() => send(batch, force))
      .then(
        () => {
          acknowledged = target;
        },
        (error: unknown) => {
          failure = { error };
          throw error;
        }
      )
      .finally(() => {
        inFlight = undefined;
        schedule();
      });
    // Scheduled sends have no immediate waiter; retain their rejection for every later barrier.
    void inFlight.catch(() => {});
    return inFlight;
  };
  return {
    /** Runs synchronously before normalization; merge only after checking this exact source prefix. */
    observe(position: WorkerRawOutputPosition) {
      if (failure) throw failure.error;
      assertWorkerRawOutputPosition(position);
      const key = createHash('sha256')
        .update(JSON.stringify([position.attemptId, position.partId, position.field]))
        .digest('hex');
      const previous = positions[key] ?? 0;
      if (position.fromBytePosition > previous) throw new WorkerRawOutputAuthorityError();
      const chargedBytes = Math.max(0, position.bytePosition - previous);
      if (chargedBytes) {
        // Canonical JSON adds quoted key, colon, digits and an optional comma.
        const bytes =
          inventoryBytes +
          (previous
            ? String(position.bytePosition).length - String(previous).length
            : key.length + 3 + String(position.bytePosition).length + (keys ? 1 : 0));
        const total = turn.rawOutputBytes + chargedBytes;
        if (bytes > POSITION_BYTES || !Number.isSafeInteger(total))
          throw new WorkerRawOutputAuthorityError();
        inventoryBytes = bytes;
        if (!previous) keys += 1;
        positions[key] = position.bytePosition;
        turn.rawOutputBytes = total;
        turn.exhausted = total > MAX_WORKER_RAW_OUTPUT_BYTES;
        const earlier = pending.get(key);
        pending.set(key, { ...position, fromBytePosition: earlier?.fromBytePosition ?? previous });
        version += 1;
        schedule();
      }
      return { rawOutputBytes: turn.rawOutputBytes, exhausted: turn.exhausted, chargedBytes };
    },
    /** Captures this immutable sufficient prefix; later arrivals cannot advance its ACK target. */
    cover(force = false): Promise<void> {
      const target = version;
      if (force && pending.size) forcePending = true;
      const wait = (): Promise<void> => {
        if (failure) return Promise.reject(failure.error);
        if (acknowledged >= target) return Promise.resolve();
        return flush().then(wait);
      };
      return wait();
    },
  };
}
