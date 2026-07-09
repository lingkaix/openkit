import { recordServerAuditEvent } from '../audit-events.js';
import type { CoreDb } from '../storage/db.js';
import type { BootPhaseRunResult } from './phases.js';

/** Input for recording one boot start audit event. */
export interface RecordBootStartAuditEventInput {
  /** Server-scope database that owns boot audit rows. */
  coreDb: CoreDb;
  /** Boot id for the process being started. */
  bootId: string;
  /** DATA_ROOT layout version accepted by this boot. */
  layoutVersion?: number;
  /** Data-root lock acquisition summary. */
  lockAcquisition?: unknown;
  /** Known migration ids after the migration phase reaches writable storage. */
  migrationIds: string[];
  /** Storage recovery events produced before migrations ran. */
  storageRecoveryEvents?: unknown[];
  /** Derived index rebuild events produced during boot recovery. */
  indexRebuildEvents?: unknown[];
  /** Event creation time. */
  now?: Date;
}

/** Input for recording one boot audit event. */
export interface RecordBootAuditEventInput {
  /** Server-scope database that owns boot audit rows. */
  coreDb: CoreDb;
  /** Boot phase run result to record. */
  result: BootPhaseRunResult;
  /** Event creation time. */
  now?: Date;
}

/** Input for recording one shutdown audit event. */
export interface RecordShutdownAuditEventInput {
  /** Server-scope database that owns shutdown audit rows. */
  coreDb: CoreDb;
  /** Boot id for the process being shut down. */
  bootId: string;
  /** Shutdown reason or signal. */
  reason: string;
  /** Ordered shutdown steps completed before this row is written. */
  stepsCompleted: string[];
  /** Whether the shutdown deadline forced process exit. */
  deadlineForcedExit: boolean;
  /** Event creation time. */
  now?: Date;
}

/**
 * Records one durable server-scope boot lifecycle audit row.
 *
 * @param input Boot start audit event input.
 */
export function recordBootStartAuditEvent(input: RecordBootStartAuditEventInput): void {
  const createdAt = (input.now ?? new Date()).toISOString();

  input.coreDb.sqlite
    .prepare(
      `INSERT INTO boot_audit_events (
        boot_event_id,
        boot_id,
        event_type,
        outcome,
        accepting_product_work,
        phase_outcomes_json,
        readiness_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `${input.bootId}_start`,
      input.bootId,
      'boot.start',
      'started',
      0,
      JSON.stringify([]),
      JSON.stringify({
        bootId: input.bootId,
        ...(input.layoutVersion ? { layoutVersion: input.layoutVersion } : {}),
        ...(input.lockAcquisition ? { lockAcquisition: input.lockAcquisition } : {}),
        migrationIds: input.migrationIds,
        storageRecoveryEvents: input.storageRecoveryEvents ?? [],
        indexRebuildEvents: input.indexRebuildEvents ?? [],
      }),
      createdAt
    );
  recordServerAuditEvent({
    action: 'boot.start',
    auditEventId: `aud_${input.bootId}_start`,
    category: 'system',
    coreDb: input.coreDb,
    outcome: 'succeeded',
    resource: `server:boot:${input.bootId}`,
    severity: 'info',
    summary: 'NanoCore boot started.',
    ...(input.now ? { now: input.now, occurredAt: input.now } : {}),
  });
}

/**
 * Records one durable server-scope boot outcome audit row.
 *
 * @param input Boot audit event input.
 */
export function recordBootAuditEvent(input: RecordBootAuditEventInput): void {
  const createdAt = (input.now ?? new Date()).toISOString();
  const readiness = input.result.readiness;
  const failed = readiness.overall === 'failed';
  const degraded = readiness.overall === 'degraded';

  input.coreDb.sqlite
    .prepare(
      `INSERT INTO boot_audit_events (
        boot_event_id,
        boot_id,
        event_type,
        outcome,
        accepting_product_work,
        phase_outcomes_json,
        readiness_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `${input.result.readiness.bootId}_outcome`,
      input.result.readiness.bootId,
      'boot.outcome',
      input.result.readiness.overall,
      input.result.readiness.acceptingProductWork ? 1 : 0,
      JSON.stringify(input.result.outcomes),
      JSON.stringify(readiness),
      createdAt
    );
  recordServerAuditEvent({
    action: 'boot.outcome',
    auditEventId: `aud_${readiness.bootId}_outcome`,
    category: 'system',
    coreDb: input.coreDb,
    errorCode: failed ? 'boot_failed' : degraded ? 'boot_degraded' : null,
    outcome: failed ? 'failed' : 'succeeded',
    resource: `server:boot:${readiness.bootId}`,
    severity: failed ? 'error' : degraded ? 'warning' : 'info',
    summary: failed
      ? 'NanoCore boot failed.'
      : degraded
        ? 'NanoCore boot completed with degraded readiness.'
        : 'NanoCore boot completed.',
    ...(input.now ? { now: input.now, occurredAt: input.now } : {}),
  });
}

/**
 * Records one durable server-scope orderly shutdown audit row.
 *
 * @param input Shutdown audit event input.
 */
export function recordShutdownAuditEvent(input: RecordShutdownAuditEventInput): void {
  const createdAt = (input.now ?? new Date()).toISOString();

  input.coreDb.sqlite
    .prepare(
      `INSERT INTO boot_audit_events (
        boot_event_id,
        boot_id,
        event_type,
        outcome,
        accepting_product_work,
        phase_outcomes_json,
        readiness_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `${input.bootId}_shutdown`,
      input.bootId,
      'boot.shutdown',
      input.deadlineForcedExit ? 'forced_exit' : 'ok',
      0,
      JSON.stringify(input.stepsCompleted),
      JSON.stringify({
        bootId: input.bootId,
        deadlineForcedExit: input.deadlineForcedExit,
        shutdownReason: input.reason,
      }),
      createdAt
    );
  recordServerAuditEvent({
    action: 'boot.shutdown',
    auditEventId: `aud_${input.bootId}_shutdown`,
    category: 'system',
    coreDb: input.coreDb,
    errorCode: input.deadlineForcedExit ? 'shutdown_deadline_forced_exit' : null,
    outcome: input.deadlineForcedExit ? 'failed' : 'succeeded',
    resource: `server:boot:${input.bootId}`,
    severity: input.deadlineForcedExit ? 'error' : 'info',
    summary: input.deadlineForcedExit
      ? 'NanoCore shutdown deadline forced exit.'
      : 'NanoCore shutdown completed.',
    ...(input.now ? { now: input.now, occurredAt: input.now } : {}),
  });
}
