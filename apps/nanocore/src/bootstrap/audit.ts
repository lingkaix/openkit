import { deriveEntityId } from '@openkit/protocol';
import { prepareAuditEvent } from '../audit-events.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
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
export async function recordBootStartAuditEvent(
  input: RecordBootStartAuditEventInput
): Promise<void> {
  const createdAt = (input.now ?? new Date()).toISOString();

  await getControlStoreWorkerClient().coreBootAudit(input.coreDb, {
    bootEventId: `${input.bootId}_start`,
    bootId: input.bootId,
    eventType: 'boot.start',
    outcome: 'started',
    acceptingProductWork: false,
    phaseOutcomesJson: JSON.stringify([]),
    readinessJson: JSON.stringify({
      bootId: input.bootId,
      ...(input.layoutVersion ? { layoutVersion: input.layoutVersion } : {}),
      ...(input.lockAcquisition ? { lockAcquisition: input.lockAcquisition } : {}),
      migrationIds: input.migrationIds,
      storageRecoveryEvents: input.storageRecoveryEvents ?? [],
      indexRebuildEvents: input.indexRebuildEvents ?? [],
    }),
    createdAt,
    audit: prepareAuditEvent({
      action: 'boot.start',
      auditEventId: deriveEntityId('aud', [input.bootId, 'start']),
      category: 'system',
      workspaceId: null,
      outcome: 'succeeded',
      resource: `server:boot:${input.bootId}`,
      severity: 'info',
      summary: 'NanoCore boot started.',
      ...(input.now ? { now: input.now, occurredAt: input.now } : {}),
    }),
  });
}

/**
 * Records one durable server-scope boot outcome audit row.
 *
 * @param input Boot audit event input.
 */
export async function recordBootAuditEvent(input: RecordBootAuditEventInput): Promise<void> {
  const createdAt = (input.now ?? new Date()).toISOString();
  const readiness = input.result.readiness;
  const failed = readiness.overall === 'failed';
  const degraded = readiness.overall === 'degraded';

  await getControlStoreWorkerClient().coreBootAudit(input.coreDb, {
    bootEventId: `${readiness.bootId}_outcome`,
    bootId: readiness.bootId,
    eventType: 'boot.outcome',
    outcome: readiness.overall,
    acceptingProductWork: readiness.acceptingProductWork,
    phaseOutcomesJson: JSON.stringify(input.result.outcomes),
    readinessJson: JSON.stringify(readiness),
    createdAt,
    audit: prepareAuditEvent({
      action: 'boot.outcome',
      auditEventId: deriveEntityId('aud', [readiness.bootId, 'outcome']),
      category: 'system',
      workspaceId: null,
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
    }),
  });
}

/**
 * Records one durable server-scope orderly shutdown audit row.
 *
 * @param input Shutdown audit event input.
 */
export async function recordShutdownAuditEvent(
  input: RecordShutdownAuditEventInput
): Promise<void> {
  const createdAt = (input.now ?? new Date()).toISOString();

  await getControlStoreWorkerClient().coreBootAudit(input.coreDb, {
    bootEventId: `${input.bootId}_shutdown`,
    bootId: input.bootId,
    eventType: 'boot.shutdown',
    outcome: input.deadlineForcedExit ? 'forced_exit' : 'ok',
    acceptingProductWork: false,
    phaseOutcomesJson: JSON.stringify(input.stepsCompleted),
    readinessJson: JSON.stringify({
      bootId: input.bootId,
      deadlineForcedExit: input.deadlineForcedExit,
      shutdownReason: input.reason,
    }),
    createdAt,
    audit: prepareAuditEvent({
      action: 'boot.shutdown',
      auditEventId: deriveEntityId('aud', [input.bootId, 'shutdown']),
      category: 'system',
      workspaceId: null,
      errorCode: input.deadlineForcedExit ? 'shutdown_deadline_forced_exit' : null,
      outcome: input.deadlineForcedExit ? 'failed' : 'succeeded',
      resource: `server:boot:${input.bootId}`,
      severity: input.deadlineForcedExit ? 'error' : 'info',
      summary: input.deadlineForcedExit
        ? 'NanoCore shutdown deadline forced exit.'
        : 'NanoCore shutdown completed.',
      ...(input.now ? { now: input.now, occurredAt: input.now } : {}),
    }),
  });
}
