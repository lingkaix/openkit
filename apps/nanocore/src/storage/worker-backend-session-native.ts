import type Database from 'better-sqlite3';
import * as records from '../runtime/worker-backend-session-records.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import type { ControlBackendSessionInput } from './worker-backend-session-codecs.js';

/** Applies the original session tuple on the admitted owner and reserves launch decisions for Core. */
export function applyControlBackendSession(
  db: CoreDb | { readonly scope?: never; readonly sqlite: Database.Database },
  input: ControlBackendSessionInput,
  admittedPreparation?: {
    readonly coreDb: CoreDb;
    readonly attempt: NonNullable<
      Parameters<typeof records.recordWorkerBackendSessionMaterializing>[2]
    >['attempt'];
  }
) {
  assertControlProductWriter(db.sqlite);
  if (
    db.scope === 'core' &&
    !db.sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_backend_sessions'")
      .get()
  )
    throw new ControlProductPreconditionError();
  const { kind, observedAt } = input;
  // An absent caller override stays absent: current wall time is sampled inside the deciding section.
  const clock = observedAt === undefined ? {} : { now: () => observedAt };
  if (kind === 'transition') {
    if (db.scope !== 'core' && input.toState === 'launching')
      throw new ControlProductPreconditionError();
    return records.transitionWorkerBackendSessionState(db, { ...input, ...clock });
  }
  if (kind === 'handoff')
    return records.markWorkerBackendWorkspaceHandoffComplete(db, { ...input, ...clock });
  if (kind === 'materializing' && admittedPreparation)
    return records.recordWorkerBackendSessionMaterializing(
      admittedPreparation.coreDb,
      { ...input, ...clock },
      { owner: db, attempt: admittedPreparation.attempt }
    );
  if (db.scope !== 'core') throw new ControlProductPreconditionError();
  switch (kind) {
    case 'materializing':
      return records.recordWorkerBackendSessionMaterializing(db, { ...input, ...clock });
    case 'launching':
      return records.markWorkerBackendSessionLaunching(db, { ...input, ...clock });
    case 'retire-orphan':
      return records.retireOrphanWorkerBackendSession(db, { ...input, ...clock });
  }
}

/** Derives predecessor lanes from the actual attempt, never a caller-supplied authority projection. */
export function controlBackendSessionLanes(db: CoreDb, input: ControlBackendSessionInput) {
  const row =
    input.kind === 'materializing'
      ? db.sqlite
          .prepare(`SELECT turn_id, agent_session_id FROM scheduler_execution_attempts
        WHERE binding_ref = ? ORDER BY created_at DESC, attempt_id DESC LIMIT 1`)
          .get(input.sandboxBindingRef)
      : db.sqlite
          .prepare(`SELECT turn_id, agent_session_id FROM scheduler_execution_attempts
        WHERE attempt_id = ?`)
          .get(input.attemptId);
  const actual = row as { turn_id: string; agent_session_id: string | null } | undefined;
  const lanes = new Set<string>();
  if (actual) {
    lanes.add(actual.turn_id);
    if (actual.agent_session_id) lanes.add(`session:${actual.agent_session_id}`);
  }
  return lanes;
}
