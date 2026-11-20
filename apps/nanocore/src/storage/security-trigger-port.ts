import type { StorageStatus } from './storage-owner.js';

/**
 * Fixed composition data for A2. v0.2.0 has no enable, so boot and a refused
 * activation must not create the service file. Absence stays `disabled`.
 */
export const SECURITY_TRIGGER_OWNER = {
  owner: 'security-trigger',
  requiredTables: [
    'security_trigger_state',
    'security_trigger_alarms',
    'security_trigger_audit_progress',
    'security_trigger_audit_assessments',
    'security_trigger_outbox',
    'security_thread_destinations',
  ],
  journalFolder: 'drizzle/services/security-trigger',
  databasePath: 'server/services/security-trigger/state.sqlite',
  provision: 'none',
} as const;

/** A6 reports disabled at cutover before dispatch, replay or background work can post effects. */
export interface SecurityTriggerStore {
  status(): StorageStatus<'security-trigger'>;
}
