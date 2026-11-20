import type { BootReadinessSnapshot } from '@openkit/app-api-schemas';
import { deriveEntityId, KernelAuditEvidenceSchema } from '@openkit/protocol';
import { prepareAuditEvent } from '../audit-events.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import type { DataRootLockAcquisition } from './lock.js';
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
  lockAcquisition?: DataRootLockAcquisition;
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

type BootReason = BootReadinessSnapshot['subsystems']['config']['reasons'][number];
type BootStartEvidence = Extract<
  NonNullable<Parameters<typeof prepareAuditEvent>[0]['kernelEvidence']>,
  { kind: 'boot.start' }
>;

/** Keeps machine-readable diagnostics and operation blocks without retaining arbitrary messages. */
function redactedReason({ code, blocks }: BootReason) {
  return { code, blocks };
}

/** The lock's previous holder is untrusted metadata, never replayed as an opaque object. */
function redactedLock(lock: DataRootLockAcquisition | undefined): BootStartEvidence['lock'] {
  if (!lock) return null;
  const stale = lock.staleHolder as Record<string, unknown> | null;
  const staleHolder =
    lock.status === 'stale_broken' &&
    typeof stale?.bootId === 'string' &&
    stale.bootId.length > 0 &&
    typeof stale.pid === 'number' &&
    Number.isSafeInteger(stale.pid) &&
    stale.pid > 0
      ? {
          bootId: stale.bootId,
          pid: stale.pid,
          ...(typeof stale.hostname === 'string' && stale.hostname.length > 0
            ? { hostname: stale.hostname }
            : {}),
        }
      : null;
  return { status: lock.status, staleHolder };
}

/** Records one durable Server boot start in Core Audit. */
export async function recordBootStartAuditEvent(
  input: RecordBootStartAuditEventInput
): Promise<void> {
  const now = input.now ?? new Date();
  const kernelEvidence = KernelAuditEvidenceSchema.parse({
    kind: 'boot.start',
    bootId: input.bootId,
    layoutVersion: input.layoutVersion ?? null,
    migrationIds: input.migrationIds,
    lock: redactedLock(input.lockAcquisition),
    indexRebuilds: (input.indexRebuildEvents ?? []).map((entry) => {
      const event = entry as Record<string, unknown>;
      return { workspaceId: event.workspaceId, itemCount: event.itemCount };
    }),
    storageRecovery: (input.storageRecoveryEvents ?? []).map((entry) => {
      const event = entry as Record<string, unknown>;
      return { scope: event.scope, reason: event.reason };
    }),
  });
  await getControlStoreWorkerClient().coreBootAudit(
    input.coreDb,
    prepareAuditEvent({
      action: 'boot.start',
      auditEventId: deriveEntityId('aud', [input.bootId, 'start']),
      category: 'system',
      workspaceId: null,
      outcome: 'succeeded',
      resource: `server:boot:${input.bootId}`,
      severity: 'info',
      summary: 'NanoCore boot started.',
      now,
      occurredAt: now,
      kernelEvidence,
    })
  );
}

/** Records the original ordered phase and readiness facts under the boot outcome's Audit ID. */
export async function recordBootAuditEvent(input: RecordBootAuditEventInput): Promise<void> {
  const now = input.now ?? new Date();
  const readiness = input.result.readiness;
  const failed = readiness.overall === 'failed';
  const degraded = readiness.overall === 'degraded';
  const kernelEvidence = KernelAuditEvidenceSchema.parse({
    kind: 'boot.outcome',
    bootId: readiness.bootId,
    acceptingProductWork: readiness.acceptingProductWork,
    overall: readiness.overall,
    subsystems: Object.fromEntries(
      Object.entries(readiness.subsystems).map(([subsystem, status]) => [
        subsystem,
        { state: status.state, reasons: status.reasons.map(redactedReason) },
      ])
    ),
    phases: input.result.outcomes.map(({ name, subsystem, critical, outcome }) => ({
      name,
      subsystem,
      critical,
      status: outcome.status,
      reasons: (outcome.status === 'ok' ? (outcome.reasons ?? []) : [outcome.reason]).map(
        redactedReason
      ),
    })),
  });
  await getControlStoreWorkerClient().coreBootAudit(
    input.coreDb,
    prepareAuditEvent({
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
      now,
      occurredAt: now,
      kernelEvidence,
    })
  );
}

/** Records ordered shutdown completion in Core Audit under the original boot ID. */
export async function recordShutdownAuditEvent(
  input: RecordShutdownAuditEventInput
): Promise<void> {
  const now = input.now ?? new Date();
  await getControlStoreWorkerClient().coreBootAudit(
    input.coreDb,
    prepareAuditEvent({
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
      now,
      occurredAt: now,
      kernelEvidence: {
        kind: 'boot.shutdown',
        bootId: input.bootId,
        reason: input.reason,
        stepsCompleted: input.stepsCompleted,
        deadlineForcedExit: input.deadlineForcedExit,
      },
    })
  );
}
