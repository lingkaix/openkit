import type Database from 'better-sqlite3';
import * as records from '../runtime/worker-backend-session-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import {
  BackendSessionRefusal,
  type ControlBackendSessionInput,
} from './worker-backend-session-codecs.js';

/** Applies the original native state CAS or a previously committed Workspace handoff. */
function applyNanoHostLocalBackendSession(
  owner: { readonly sqlite: Database.Database },
  input: Extract<ControlBackendSessionInput, { kind: 'transition' | 'handoff' }>
) {
  assertControlProductWriter(owner.sqlite);
  const { observedAt } = input;
  const clock = observedAt === undefined ? {} : { now: () => observedAt };
  return input.kind === 'transition'
    ? records.transitionWorkerBackendSessionState(owner, { ...input, ...clock })
    : records.markWorkerBackendWorkspaceHandoffComplete(owner, { ...input, ...clock });
}

/** Applies one complete existing backend tuple within the Core savepoint and covering FULL commit. */
export function applyControlBackendSession(
  db: CoreDb | { readonly scope: 'nanohost'; readonly sqlite: Database.Database },
  input: ControlBackendSessionInput
) {
  if (input.kind === 'transition' || input.kind === 'handoff')
    return applyNanoHostLocalBackendSession(db, input);
  assertControlProductWriter(db.sqlite);
  if (db.scope !== 'core')
    throw new BackendSessionRefusal('Backend session tuple requires deciding Core authority.');
  const { kind, observedAt } = input;
  // An absent caller override stays absent: current wall time is sampled inside the deciding section.
  const clock = observedAt === undefined ? {} : { now: () => observedAt };
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
