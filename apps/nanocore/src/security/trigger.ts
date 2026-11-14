import type { PolicyDocumentV1 } from '@openkit/protocol';
import type { WorkerLineage } from '@openkit/worker-protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import { publishCoreJournal } from '../runtime/core-journal-owner.js';
import { decodeExecutionJournalInvocation } from '../runtime/execution-journal.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { SECURITY_CONTAINMENT_LIMITS } from '../storage/core-journal-codecs.js';
import type { CoreDb } from '../storage/db.js';
import {
  type ControlSecurityTrigger,
  type SecurityAlarmNotice,
  type SecurityAlarmRow,
  type SecurityAuditAssessment,
  type SecurityAuditCursor,
  type SecurityEventOutboxRow,
  SecurityTriggerRefusal,
  type SecurityTriggerSnapshot,
} from '../storage/security-trigger-codecs.js';

export type {
  SecurityAlarmNotice,
  SecurityAlarmRow,
  SecurityAuditAssessment,
  SecurityAuditCursor,
  SecurityEventOutboxRow,
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

  /** Native current usage is review evidence, never a caller-provided counter or positive grant. */
  async containmentUsage(policy: PolicyDocumentV1, workspaceId?: string) {
    const bytes = await publishCoreJournal(this.db, {
      kind: 'containment-inspect',
      policy,
      workspaceId,
    });
    if (bytes === null) throw new TypeError('Containment usage is unavailable.');
    const count = z.number().int().nonnegative().safe();
    return {
      limits: SECURITY_CONTAINMENT_LIMITS,
      usage: z
        .object({
          currentServer: count,
          currentWorkspace: count,
          cumulativeServer: count,
          cumulativeWorkspace: count,
          pendingServer: count,
          pendingWorkspace: count,
          windowStart: z.iso.datetime(),
          workspaces: z
            .array(
              z
                .object({
                  workspaceId: z.string(),
                  current: count,
                  cumulative: count,
                  pending: count,
                })
                .strict()
            )
            .max(40),
        })
        .strict()
        .parse(JSON.parse(bytes)),
    };
  }

  /** Commits capacity and the review deadline before any effect; null grants no containment. */
  async prepareContainment(input: { policy: PolicyDocumentV1; lineage: WorkerLineage }) {
    const bytes = await publishCoreJournal(this.db, { kind: 'containment-intent', ...input });
    return bytes === null ? null : decodeExecutionJournalInvocation(bytes);
  }

  /** Every new effect rechecks the actual current Policy, E4 authority and original action clock. */
  async checkContainment(
    policy: PolicyDocumentV1,
    ref: { execution: { owner: { kind: 'server' }; executionId: string }; stepId: string }
  ) {
    const bytes = await publishCoreJournal(this.db, { kind: 'containment-check', policy, ref });
    return bytes === null ? null : decodeExecutionJournalInvocation(bytes);
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

  /** Native source, cursor, assessment and every initial recipient commit before this resolves. */
  async detectAudit(input: { limit?: number } = {}) {
    const result = await this.apply({
      action: 'audit-detect',
      limit: input.limit ?? 128,
      timestamp: new Date().toISOString(),
    });
    // A discovered delegation loss has already committed its original R8 before refusal.
    if (result.kind === 'audit-unavailable') throw new SecurityTriggerRefusal('forbidden');
    if (result.kind !== 'audit-detection')
      throw new TypeError('Unexpected Audit detection result.');
    return {
      cursor: result.cursor,
      scanned: result.scanned,
      detected: result.detected,
      unsupported: result.unsupported,
    };
  }

  async readDetectionProgress(): Promise<{ cursor: SecurityAuditCursor | null; assessed: number }> {
    const result = await this.apply({ action: 'detection-progress' });
    if (result.kind !== 'detection-progress')
      throw new TypeError('Unexpected detection progress result.');
    return { cursor: result.cursor, assessed: result.assessed };
  }

  async readDetections(input: { after?: SecurityAuditCursor; limit?: number } = {}): Promise<{
    events: SecurityAuditAssessment[];
    next: SecurityAuditCursor | null;
  }> {
    const result = await this.apply({
      action: 'detections',
      after: input.after,
      limit: input.limit ?? 128,
    });
    if (result.kind !== 'detections') throw new TypeError('Unexpected detection page result.');
    return { events: result.events, next: result.next };
  }

  async readEventOutbox(): Promise<SecurityEventOutboxRow[]> {
    const result = await this.apply({ action: 'event-outbox' });
    if (result.kind !== 'event-outbox') throw new TypeError('Unexpected event outbox result.');
    return result.rows;
  }

  /** Reads stored native notice progress, not current send or publication authority. */
  async readAlarmNotice(requestId: string): Promise<SecurityAlarmNotice | null> {
    const result = await this.apply({ action: 'alarm-notice-read', requestId });
    if (result.kind !== 'alarm-notice') throw new TypeError('Unexpected alarm notice result.');
    return result.notice;
  }

  async readAlarms(): Promise<SecurityAlarmRow[]> {
    const result = await this.apply({ action: 'alarms' });
    if (result.kind !== 'alarms') throw new TypeError('Unexpected security trigger alarm result.');
    return result.rows;
  }
}
