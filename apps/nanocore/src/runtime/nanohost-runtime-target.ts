import type { CoreDb } from '../storage/db.js';

/** Durable configured NanoHost target projection returned to scheduler consumers. */
export interface NanoHostRuntimeTargetRecord {
  /** Scheduler target id. */
  readonly targetId: string;
  /** Configured NanoHost IntegrationIdentity id. */
  readonly identityId: string;
  /** Deployment binding for the configured NanoHost. */
  readonly deploymentId: string;
  /** Current authoritative connection generation. */
  readonly connectionGeneration: number;
  /** Whether the prior connection has been fenced. */
  readonly predecessorFenced: boolean;
  /** Whether the current generation reports ready admission. */
  readonly ready: boolean;
  /** Whether the current generation proved a fresh empty Runtime Epoch. */
  readonly freshEmpty: boolean;
  /** Timestamp of the current readiness observation. */
  readonly observedAt: string;
  /** Fixed V1 slot count. */
  readonly slotCount: 1;
}

/** Input for recording current configured NanoHost readiness. */
export interface UpsertNanoHostRuntimeTargetInput {
  /** Scheduler target id. */
  readonly targetId: string;
  /** Configured NanoHost IntegrationIdentity id. */
  readonly identityId: string;
  /** Deployment binding for the configured NanoHost. */
  readonly deploymentId: string;
  /** Authoritative connection generation. */
  readonly connectionGeneration: number;
  /** Whether the prior connection is fenced. */
  readonly predecessorFenced: boolean;
  /** Whether the current generation reports ready capacity. */
  readonly ready: boolean;
  /** Whether the current generation proved a fresh empty Runtime Epoch. */
  readonly freshEmpty: boolean;
  /** Observation timestamp. */
  readonly observedAt: string;
}

/** Input for allocating the next durable NanoHost connection generation. */
export interface AllocateNanoHostRuntimeTargetConnectionGenerationInput {
  /** Scheduler target id. */
  readonly targetId: string;
  /** Configured NanoHost IntegrationIdentity id. */
  readonly identityId: string;
  /** Deployment binding for the configured NanoHost. */
  readonly deploymentId: string;
  /** Allocation observation timestamp. */
  readonly observedAt: string;
}

/** Input for projecting one server-observed physical connection close. */
export interface RecordNanoHostRuntimeTargetConnectionCloseInput {
  /** Scheduler target id. */
  readonly targetId: string;
  /** Generation carried by the physical connection that closed. */
  readonly closedGeneration: number;
  /** Remaining process-local authoritative generation after the close. */
  readonly authoritativeGeneration: number | null;
  /** Close observation timestamp. */
  readonly observedAt: string;
}

/** Raw configured NanoHost target database row. */
interface NanoHostRuntimeTargetRow {
  readonly target_id: string;
  readonly identity_id: string;
  readonly deployment_id: string;
  readonly connection_generation: number;
  readonly predecessor_fenced: 0 | 1;
  readonly ready: 0 | 1;
  readonly fresh_empty: 0 | 1;
  readonly observed_at: string;
  readonly slot_count: number;
}

/**
 * Allocates and persists the next NanoHost connection generation.
 *
 * Allocation is one checked SQLite transaction. A new target receives generation
 * one; an existing exact identity/deployment receives durable high-water plus one.
 * The committed generation starts non-ready and unfenced. Rejected identity,
 * deployment, target, concurrent, or overflow attempts do not advance it.
 *
 * @param coreDb Open Core database handle.
 * @param input Configured target identity and allocation timestamp.
 * @returns Newly allocated durable target projection.
 * @throws Error when target ownership conflicts or generation would overflow.
 */
export function allocateNanoHostRuntimeTargetConnectionGeneration(
  coreDb: CoreDb,
  input: AllocateNanoHostRuntimeTargetConnectionGenerationInput
): NanoHostRuntimeTargetRecord {
  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const existing = selectNanoHostRuntimeTarget(coreDb, input.targetId);
    if (!existing) {
      const configuredTarget = coreDb.sqlite
        .prepare('SELECT target_id FROM nanohost_runtime_targets LIMIT 1')
        .get() as { readonly target_id: string } | undefined;
      if (configuredTarget) {
        throw new Error('A different NanoHost RuntimeTarget is already configured.');
      }
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, observed_at,
             slot_count
           ) VALUES (?, ?, ?, 1, 0, 0, 0, ?, 1)`
        )
        .run(input.targetId, input.identityId, input.deploymentId, input.observedAt);
    } else {
      if (
        existing.identity_id !== input.identityId ||
        existing.deployment_id !== input.deploymentId
      ) {
        throw new Error('NanoHost RuntimeTarget identity or deployment conflicts with allocation.');
      }
      if (existing.connection_generation >= Number.MAX_SAFE_INTEGER) {
        throw new Error('NanoHost RuntimeTarget connection generation overflow.');
      }
      const nextGeneration = existing.connection_generation + 1;
      const updated = coreDb.sqlite
        .prepare(
          `UPDATE nanohost_runtime_targets
           SET connection_generation = ?, predecessor_fenced = 0, ready = 0,
               fresh_empty = 0, observed_at = ?
           WHERE target_id = ? AND identity_id = ? AND deployment_id = ?
             AND connection_generation = ?`
        )
        .run(
          nextGeneration,
          input.observedAt,
          input.targetId,
          input.identityId,
          input.deploymentId,
          existing.connection_generation
        );
      if (updated.changes !== 1) {
        throw new Error('NanoHost RuntimeTarget connection generation changed before allocation.');
      }
    }
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }

  return requireNanoHostRuntimeTarget(coreDb, input.targetId);
}

/**
 * Projects one native physical close without lowering the durable generation high-water.
 *
 * @param coreDb Open Core database handle.
 * @param input Closed generation, remaining authority, and observation timestamp.
 * @returns Current durable target projection after the monotone close projection.
 * @throws Error when the target is absent or close generations exceed durable high-water.
 */
export function recordNanoHostRuntimeTargetConnectionClose(
  coreDb: CoreDb,
  input: RecordNanoHostRuntimeTargetConnectionCloseInput
): NanoHostRuntimeTargetRecord {
  const current = selectNanoHostRuntimeTarget(coreDb, input.targetId);
  if (!current) {
    throw new Error('NanoHost RuntimeTarget is not configured.');
  }
  if (
    input.closedGeneration > current.connection_generation ||
    (input.authoritativeGeneration !== null &&
      input.authoritativeGeneration > current.connection_generation)
  ) {
    throw new Error('NanoHost RuntimeTarget close generation exceeds durable high-water.');
  }
  const provesPredecessorFenced =
    input.authoritativeGeneration === current.connection_generation ||
    (input.closedGeneration === current.connection_generation &&
      input.authoritativeGeneration === null);
  const projected = coreDb.sqlite
    .prepare(
      `UPDATE nanohost_runtime_targets
       SET predecessor_fenced = CASE
             WHEN predecessor_fenced = 1 OR ? = 1 THEN 1
             ELSE 0
           END,
           ready = 0, fresh_empty = 0, observed_at = ?
       WHERE target_id = ? AND connection_generation = ?`
    )
    .run(
      provesPredecessorFenced ? 1 : 0,
      input.observedAt,
      input.targetId,
      current.connection_generation
    );
  if (projected.changes !== 1) {
    throw new Error('NanoHost RuntimeTarget generation changed before close projection.');
  }
  return requireNanoHostRuntimeTarget(coreDb, input.targetId);
}

/** Fences the sole durable RuntimeTarget after process-local transport authority is lost. */
export function fenceNanoHostRuntimeTargetAfterRestart(
  coreDb: CoreDb,
  observedAt: string
): NanoHostRuntimeTargetRecord | null {
  const targets = coreDb.sqlite
    .prepare(
      `SELECT target_id AS targetId, connection_generation AS connectionGeneration
       FROM nanohost_runtime_targets`
    )
    .all() as Array<{ readonly connectionGeneration: number; readonly targetId: string }>;
  const target = targets[0];
  if (!target) return null;
  if (targets.length !== 1) {
    throw new Error('NanoHost restart found multiple configured RuntimeTargets.');
  }
  return recordNanoHostRuntimeTargetConnectionClose(coreDb, {
    authoritativeGeneration: null,
    closedGeneration: target.connectionGeneration,
    observedAt,
    targetId: target.targetId,
  });
}

/**
 * Records the configured NanoHost's current connection and readiness projection.
 *
 * Only the already-allocated exact current generation may become fresh-empty and
 * ready. This record is an admission gate; scheduler rows remain capacity authority.
 *
 * @param coreDb Open Core database handle.
 * @param input Configured identity and readiness observation.
 * @returns Current durable target projection.
 * @throws Error when allocation, identity, deployment, generation, observation, or proof conflicts.
 */
export function upsertNanoHostRuntimeTarget(
  coreDb: CoreDb,
  input: UpsertNanoHostRuntimeTargetInput
): NanoHostRuntimeTargetRecord {
  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const existing = selectNanoHostRuntimeTarget(coreDb, input.targetId);
    if (!existing) {
      throw new Error('NanoHost RuntimeTarget must be allocated before readiness.');
    }
    if (input.identityId !== existing.identity_id) {
      throw new Error('NanoHost RuntimeTarget readiness identity does not match.');
    }
    if (input.deploymentId !== existing.deployment_id) {
      throw new Error('NanoHost RuntimeTarget readiness deployment does not match.');
    }
    if (input.connectionGeneration !== existing.connection_generation) {
      throw new Error('NanoHost RuntimeTarget readiness generation is not current.');
    }
    if (input.observedAt < existing.observed_at) {
      throw new Error('NanoHost RuntimeTarget readiness observation is stale.');
    }
    if (!isReadyObservation(input)) {
      throw new Error('NanoHost RuntimeTarget readiness proof is incomplete.');
    }

    const update = coreDb.sqlite
      .prepare(
        `UPDATE nanohost_runtime_targets
         SET predecessor_fenced = ?, ready = ?, fresh_empty = ?, observed_at = ?,
             last_fresh_ready_at = ?
         WHERE target_id = ? AND identity_id = ? AND deployment_id = ?
           AND connection_generation = ?`
      )
      .run(
        input.predecessorFenced ? 1 : 0,
        input.ready ? 1 : 0,
        input.freshEmpty ? 1 : 0,
        input.observedAt,
        input.observedAt,
        input.targetId,
        input.identityId,
        input.deploymentId,
        input.connectionGeneration
      );
    if (update.changes !== 1) {
      throw new Error('NanoHost RuntimeTarget readiness target changed before projection.');
    }
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }

  return requireNanoHostRuntimeTarget(coreDb, input.targetId);
}

/**
 * Reads one configured NanoHost RuntimeTarget.
 *
 * @param coreDb Open Core database handle.
 * @param targetId Scheduler target id.
 * @returns Durable target projection or null when absent.
 */
export function getNanoHostRuntimeTarget(
  coreDb: CoreDb,
  targetId: string
): NanoHostRuntimeTargetRecord | null {
  const row = selectNanoHostRuntimeTarget(coreDb, targetId);
  return row ? mapNanoHostRuntimeTargetRow(row) : null;
}

/** Returns whether one observation proves the configured readiness gate. */
function isReadyObservation(input: UpsertNanoHostRuntimeTargetInput): boolean {
  return input.predecessorFenced && input.ready && input.freshEmpty;
}

/** Selects one raw configured target row. */
function selectNanoHostRuntimeTarget(
  coreDb: CoreDb,
  targetId: string
): NanoHostRuntimeTargetRow | undefined {
  return coreDb.sqlite
    .prepare(
      `SELECT target_id, identity_id, deployment_id, connection_generation,
              predecessor_fenced, ready, fresh_empty, observed_at,
              slot_count
       FROM nanohost_runtime_targets
       WHERE target_id = ?`
    )
    .get(targetId) as NanoHostRuntimeTargetRow | undefined;
}

/** Reads one configured target or throws. */
function requireNanoHostRuntimeTarget(
  coreDb: CoreDb,
  targetId: string
): NanoHostRuntimeTargetRecord {
  const target = getNanoHostRuntimeTarget(coreDb, targetId);
  if (!target) {
    throw new Error(`NanoHost RuntimeTarget not found: ${targetId}`);
  }
  return target;
}

/** Maps one raw configured-target row to its public runtime projection. */
function mapNanoHostRuntimeTargetRow(row: NanoHostRuntimeTargetRow): NanoHostRuntimeTargetRecord {
  if (row.slot_count !== 1) {
    throw new Error('NanoHost RuntimeTarget slot count is not the configured V1 value.');
  }
  return {
    targetId: row.target_id,
    identityId: row.identity_id,
    deploymentId: row.deployment_id,
    connectionGeneration: row.connection_generation,
    predecessorFenced: row.predecessor_fenced === 1,
    ready: row.ready === 1,
    freshEmpty: row.fresh_empty === 1,
    observedAt: row.observed_at,
    slotCount: 1,
  };
}
