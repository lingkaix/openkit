import type { CoreDb } from './db.js';
import {
  type ControlSecurityTrigger,
  type ControlSecurityTriggerResult,
  type SecurityAlarmNotice,
  SecurityTriggerRefusal,
  type SecurityTriggerSnapshot,
} from './security-trigger-codecs.js';

/**
 * Closed snapshot. v0.2.0 does not read `security_trigger_state`, so a leftover
 * `on` row cannot start trigger-gated containment.
 */
export const SECURITY_TRIGGER_DISABLED_SNAPSHOT: SecurityTriggerSnapshot = {
  state: 'off',
  enableGeneration: 0,
  enablingUserId: null,
  delegationCurrent: false,
  stoppingReason: null,
  failedOutcome: null,
};

/** Stored notice progress is absent. This does not read the six tables or Attention. */
export function readSecurityAlarmNoticeInDb(
  _db: CoreDb,
  _requestId: string
): SecurityAlarmNotice | null {
  return null;
}

/** E12 notice enqueue writes nothing. Callers can still commit their own Audit. */
export function enqueueE12NoticeInDb(_db: CoreDb, _auditEventId: string): void {
  return;
}

/**
 * Refuses every security-trigger effect before SQL.
 * `current` returns the closed service snapshot.
 */
export function applySecurityTriggerInDb(
  _db: CoreDb,
  input: ControlSecurityTrigger
): ControlSecurityTriggerResult {
  if (input.action === 'current') {
    return { kind: 'state', snapshot: SECURITY_TRIGGER_DISABLED_SNAPSHOT };
  }
  throw new SecurityTriggerRefusal('forbidden');
}
