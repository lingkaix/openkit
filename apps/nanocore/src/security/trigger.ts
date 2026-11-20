import type { PolicyDocumentV1 } from '@openkit/protocol';
import type { WorkerLineage } from '@openkit/worker-protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import { publishCoreJournal } from '../runtime/core-journal-owner.js';
import type { ExecutionInvocation } from '../runtime/execution-step-journal.js';
import type { TurnExecutor } from '../runtime/types.js';
import {
  SECURITY_CONTAINMENT_LIMITS,
  SECURITY_OBSERVATION_LIMITS,
} from '../storage/core-journal-codecs.js';
import type { CoreDb } from '../storage/db.js';
import {
  type SecurityAlarmNotice,
  type SecurityAlarmRow,
  type SecurityAuditAssessment,
  type SecurityAuditCursor,
  type SecurityEventOutboxRow,
  SecurityTriggerRefusal,
  type SecurityTriggerSnapshot,
} from '../storage/security-trigger-codecs.js';
import { SECURITY_TRIGGER_DISABLED_SNAPSHOT } from '../storage/security-trigger-native.js';
import {
  SECURITY_TRIGGER_OWNER,
  type SecurityTriggerStore as SecurityTriggerStorePort,
} from '../storage/security-trigger-port.js';

export type {
  SecurityAlarmNotice,
  SecurityAlarmRow,
  SecurityAuditAssessment,
  SecurityAuditCursor,
  SecurityEventOutboxRow,
  SecurityTriggerSnapshot,
} from '../storage/security-trigger-codecs.js';

const EMPTY_DETECTION = {
  cursor: null,
  scanned: 0,
  detected: 0,
  unsupported: 0,
} as const;

/** Internal closed Server facade. v0.2.0 reports disabled and does not write the six tables. */
export class SecurityTriggerStore implements SecurityTriggerStorePort {
  constructor(private readonly db: CoreDb) {}

  /** Does not open the service file or read Core. */
  status() {
    return {
      state: 'unavailable' as const,
      owner: SECURITY_TRIGGER_OWNER.owner,
      reason: 'disabled' as const,
    };
  }

  async current(_now = new Date().toISOString()): Promise<SecurityTriggerSnapshot> {
    return SECURITY_TRIGGER_DISABLED_SNAPSHOT;
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
      observationLimits: SECURITY_OBSERVATION_LIMITS,
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

  /** No containment intent is prepared while the trigger is disabled. */
  async prepareContainment(_input: {
    policy: PolicyDocumentV1;
    lineage: WorkerLineage;
  }): Promise<ExecutionInvocation | null> {
    return null;
  }

  /** No containment check admits an effect while the trigger is disabled. */
  async checkContainment(
    _policy: PolicyDocumentV1,
    _ref: { execution: { owner: { kind: 'server' }; executionId: string }; stepId: string }
  ): Promise<ExecutionInvocation | null> {
    return null;
  }

  /** Automatic containment does not start. Policy prohibit statements stay with the kernel. */
  async consumeSensor(
    _lineage: WorkerLineage,
    _manager: RuntimeConfigManager
  ): Promise<{ kind: 'not-admitted' }> {
    return { kind: 'not-admitted' };
  }

  /** Replay does not interrupt a Turn or revoke credentials. */
  async advanceContainment(
    _manager: RuntimeConfigManager,
    _store: FsStore,
    _executor: TurnExecutor
  ): Promise<void> {
    return;
  }

  /** Activation is refused. The call does not persist state `on`. */
  async enable(_actor: Actor, _now = new Date().toISOString()): Promise<SecurityTriggerSnapshot> {
    throw new SecurityTriggerRefusal('forbidden');
  }

  async stop(_actor: Actor, _now = new Date().toISOString()): Promise<SecurityTriggerSnapshot> {
    throw new SecurityTriggerRefusal('forbidden');
  }

  async readAudit(
    _input: {
      after?: { createdAt: string; auditEventId: string };
      limit?: number;
      now?: string;
    } = {}
  ) {
    return { events: [], next: null };
  }

  /** Detection does not scan Audit or write assessments. */
  async detectAudit(_input: { limit?: number } = {}) {
    return { ...EMPTY_DETECTION };
  }

  async readDetectionProgress(): Promise<{ cursor: SecurityAuditCursor | null; assessed: number }> {
    return { cursor: null, assessed: 0 };
  }

  async readDetections(_input: { after?: SecurityAuditCursor; limit?: number } = {}): Promise<{
    events: SecurityAuditAssessment[];
    next: SecurityAuditCursor | null;
  }> {
    return { events: [], next: null };
  }

  async readEventOutbox(): Promise<SecurityEventOutboxRow[]> {
    return [];
  }

  async readAlarmNotice(_requestId: string): Promise<SecurityAlarmNotice | null> {
    return null;
  }

  async readAlarms(): Promise<SecurityAlarmRow[]> {
    return [];
  }
}
