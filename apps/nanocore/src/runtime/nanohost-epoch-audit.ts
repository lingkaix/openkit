import type { AuditEvent } from '@openkit/protocol';

import { recordServerAuditEvent } from '../audit-events.js';
import type { CoreDb } from '../storage/db.js';

const INVALIDATION_CLASSIFICATIONS = new Set([
  'uncertain-create',
  'uncertain-delete',
  'member-exit',
  'member-identity-change',
  'member-local-restart',
  'containment-loss',
  'epoch-creation-failure',
  'operator-action',
]);
const OPAQUE_LINEAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const REPORT_REFERENCE_PATTERN = /^nanohost-report:[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SECRET_REFERENCE_PATTERN =
  /(?:^|[._:-])(?:api[-_]?key|authorization|bearer|cookie|credential|password|private[-_]?key|secret|token)(?:$|[._:-])|(?:^|[._:-])(?:gho_|ghp_|github_pat_|hf_|okt_|sk-)[A-Za-z0-9_-]{4,}|AKIA[A-Z0-9]{16}|xoxb-[A-Za-z0-9_-]{4,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/i;
const MAX_LINEAGE_LENGTH = 1_024;
const MAX_REPORT_REFERENCE_LENGTH = 160;

/**
 * Records one redacted server-owned NanoHost epoch invalidation boundary.
 *
 * @param input Invalidation classification, timing, and redacted lineage.
 * @returns The stored protocol audit event.
 * @throws When input is private, unbounded, or outside the closed classification vocabulary.
 */
export function recordNanoHostEpochInvalidationAudit(input: {
  affectedSessionLineage: readonly string[];
  auditEventId?: string;
  classification: string;
  coreDb: CoreDb;
  epochLifetimeMs: number;
  now?: Date;
  outcome: AuditEvent['outcome'];
  reportRef: string | null;
}): AuditEvent {
  const {
    affectedSessionLineage,
    auditEventId,
    classification,
    coreDb,
    epochLifetimeMs,
    now,
    outcome,
    reportRef,
    ...unsafeFields
  } = input;
  if (Object.keys(unsafeFields).length > 0) {
    throw new Error('NanoHost epoch audit input contains unsafe private fields.');
  }
  if (!INVALIDATION_CLASSIFICATIONS.has(classification)) {
    throw new Error('Unknown NanoHost epoch invalidation classification.');
  }
  if (!Number.isSafeInteger(epochLifetimeMs) || epochLifetimeMs < 0) {
    throw new Error('NanoHost epoch lifetime must be a non-negative safe integer.');
  }

  const lineage = affectedSessionLineage.join(',');
  if (
    lineage.length > MAX_LINEAGE_LENGTH ||
    affectedSessionLineage.some(
      (reference) =>
        reference.length === 0 ||
        !OPAQUE_LINEAGE_PATTERN.test(reference) ||
        SECRET_REFERENCE_PATTERN.test(reference)
    )
  ) {
    throw new Error('NanoHost affected-session lineage must be bounded and redacted.');
  }
  if (
    reportRef !== null &&
    (reportRef.length > MAX_REPORT_REFERENCE_LENGTH ||
      !REPORT_REFERENCE_PATTERN.test(reportRef) ||
      SECRET_REFERENCE_PATTERN.test(reportRef))
  ) {
    throw new Error('NanoHost report reference must be bounded and redacted.');
  }

  return recordServerAuditEvent({
    action: 'runtime.epoch.invalidate',
    category: 'system',
    coreDb,
    outcome,
    resource: `runtime-epoch:${classification}`,
    summary: `Epoch invalidated: classification=${classification}; lifetimeMs=${epochLifetimeMs}; sessions=${lineage || 'none'}; report=${reportRef ?? 'none'}.`,
    ...(auditEventId === undefined ? {} : { auditEventId }),
    ...(now === undefined ? {} : { now }),
  });
}

/**
 * Records one server-owned NanoHost epoch readiness boundary.
 *
 * @param input Fence-to-ready timing and outcome.
 * @returns The stored protocol audit event.
 * @throws When input is private or the elapsed time is invalid.
 */
export function recordNanoHostEpochReadyAudit(input: {
  auditEventId?: string;
  coreDb: CoreDb;
  fenceToReadyMs: number;
  now?: Date;
  outcome: AuditEvent['outcome'];
}): AuditEvent {
  const { auditEventId, coreDb, fenceToReadyMs, now, outcome, ...unsafeFields } = input;
  if (Object.keys(unsafeFields).length > 0) {
    throw new Error('NanoHost epoch audit input contains unsafe private fields.');
  }
  if (!Number.isSafeInteger(fenceToReadyMs) || fenceToReadyMs < 0) {
    throw new Error('NanoHost fence-to-ready time must be a non-negative safe integer.');
  }

  return recordServerAuditEvent({
    action: 'runtime.epoch.ready',
    category: 'system',
    coreDb,
    outcome,
    resource: 'runtime-epoch:ready',
    summary: `Epoch readiness boundary: fenceToReadyMs=${fenceToReadyMs}.`,
    ...(auditEventId === undefined ? {} : { auditEventId }),
    ...(now === undefined ? {} : { now }),
  });
}
