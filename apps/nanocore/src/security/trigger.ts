import type { Actor } from '../auth/identity.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import {
  type ControlSecurityTrigger,
  type SecurityAlarmRow,
  SecurityTriggerRefusal,
  type SecurityTriggerSnapshot,
} from '../storage/security-trigger-codecs.js';

export type {
  SecurityAlarmRow,
  SecurityTriggerSnapshot,
} from '../storage/security-trigger-codecs.js';

/** Internal closed Server facade. No SQLite writes, public activation route or new connection owner. */
export class SecurityTriggerStore {
  constructor(private readonly db: CoreDb) {}

  private apply(input: ControlSecurityTrigger) {
    return getControlStoreWorkerClient().securityTrigger(this.db, input);
  }

  async current(now = new Date().toISOString()): Promise<SecurityTriggerSnapshot> {
    const result = await this.apply({ action: 'current', timestamp: now });
    if (result.kind !== 'state') throw new TypeError('Unexpected security trigger state result.');
    return result.snapshot;
  }

  /** The caller supplies its original authenticated Actor; native admission rechecks current rows. */
  async enable(actor: Actor, now = new Date().toISOString()): Promise<SecurityTriggerSnapshot> {
    const result = await this.apply({ action: 'enable', actor, timestamp: now });
    if (result.kind !== 'state') throw new TypeError('Unexpected security trigger enable result.');
    return result.snapshot;
  }

  async stop(actor: Actor, now = new Date().toISOString()): Promise<SecurityTriggerSnapshot> {
    const result = await this.apply({ action: 'stop', actor, timestamp: now });
    if (result.kind !== 'state') throw new TypeError('Unexpected security trigger stop result.');
    return result.snapshot;
  }

  async readAudit(
    input: {
      after?: { createdAt: string; auditEventId: string };
      limit?: number;
      now?: string;
    } = {}
  ) {
    const result = await this.apply({
      action: 'audit',
      after: input.after,
      limit: input.limit ?? 128,
      timestamp: input.now ?? new Date().toISOString(),
    });
    // The original native check/stop/alarm transaction has ACKed before this facade refusal.
    if (result.kind === 'audit-unavailable') throw new SecurityTriggerRefusal('forbidden');
    if (result.kind !== 'audit') throw new TypeError('Unexpected security trigger Audit result.');
    return { events: result.events, next: result.next };
  }

  async readAlarms(): Promise<SecurityAlarmRow[]> {
    const result = await this.apply({ action: 'alarms' });
    if (result.kind !== 'alarms') throw new TypeError('Unexpected security trigger alarm result.');
    return result.rows;
  }
}
