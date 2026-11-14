import { OpenKitConfigSchema, PRODUCT_OPERATION_ACCESS_RIGHTS } from '@openkit/config-schema';
import { compareCodeUnits, type PolicyDocumentV1 } from '@openkit/protocol';
import { type WorkerLineage, WorkerLineageSchema } from '@openkit/worker-protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import { parseJsoncObject } from '../config/jsonc.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import type { FsStore } from '../lib/store.js';
import {
  EMPTY_POLICY_DOCUMENT,
  policyDigest,
  preparePolicyDocument,
  validatePolicyDocument,
} from '../policy/statements.js';
import { publishCoreJournal } from '../runtime/core-journal-owner.js';
import {
  acceptSchedulerExecutionObservation,
  requireSchedulerExecutionAttempt,
  schedulerExecutionCorrelation,
} from '../runtime/execution-attempt-records.js';
import {
  createExecutionStepJournalReader,
  decodeExecutionJournalInvocation,
} from '../runtime/execution-journal.js';
import type { TurnExecutor } from '../runtime/types.js';
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

  /** Applies only the native-admitted exact deny through the existing file/reload owner, never a publication Turn. */
  async consumeCanary(lineage: WorkerLineage, manager: RuntimeConfigManager) {
    const policy = validatePolicyDocument(
      manager.current().openKitConfig.policy?.mediation ?? EMPTY_POLICY_DOCUMENT
    );
    // Presence only avoids work in observation mode. The native owner still decides all authority.
    if (
      !policy.statements.some(
        (statement) =>
          statement.kind === 'permission' &&
          statement.state === 'active' &&
          statement.effect === 'allow' &&
          statement.scope.actions.includes('security.containment')
      )
    )
      return { kind: 'not-admitted' as const };
    if (manager.getDataRoot() !== this.db.dataRoot)
      throw new TypeError('Containment requires its original runtime owner.');
    const intent = await this.prepareContainment({ lineage, policy });
    if (intent === null) return { kind: 'not-admitted' as const };
    const author = intent.control.actor;
    if (author.kind !== 'system' || author.responsibleUserId === null)
      throw new TypeError('Containment author is unavailable.');
    const originalReferences = intent.control.inputRefs.filter((ref) => ref.startsWith('lineage:'));
    if (originalReferences.length !== 1)
      throw new TypeError('Original containment scope is unavailable.');
    const original = WorkerLineageSchema.parse(JSON.parse(originalReferences[0]!.slice(8)));
    const quarantine: PolicyDocumentV1['statements'][number] = {
      id: intent.ref.execution.executionId,
      kind: 'permission',
      state: 'active',
      effect: 'prohibit',
      grant: { kind: 'ordinary' },
      author: { kind: 'human', id: author.responsibleUserId },
      authority: { kind: 'human', userId: author.responsibleUserId },
      authoredAt: new Date(Number(intent.clock.admittedUnixNano / 1_000_000n)).toISOString(),
      scope: {
        subjects: [
          {
            kind: 'process',
            workspaceId: original.workspaceId,
            threadId: original.threadId,
            turnId: original.turnId,
          },
        ],
        actions: [...new Set([...Object.keys(PRODUCT_OPERATION_ACCESS_RIGHTS), 'tool.use'])].sort(
          compareCodeUnits
        ),
        resources: [
          {
            kind: 'container',
            container: {
              owner: { kind: 'workspace', workspaceId: original.workspaceId },
              kind: 'workspace',
              id: original.workspaceId,
            },
          },
        ],
      },
      lifetime: {
        anchor: { owner: { kind: 'server' }, kind: 'quarantine', id: intent.control.workId },
      },
    };
    const files = new RuntimeConfigFileService({
      dataRoot: this.db.dataRoot,
      workspaceIds: [],
      userId: author.responsibleUserId,
      runtimeConfigManager: manager,
      readRuntimeConfigStatus: () => manager.status(),
    });
    const read = files.readFile('server.jsonc');
    const raw = parseJsoncObject(read.content, 'server.jsonc');
    const config = OpenKitConfigSchema.parse(raw);
    const current = validatePolicyDocument(config.policy?.mediation ?? EMPTY_POLICY_DOCUMENT);
    const installed = current.statements.find((statement) => statement.id === quarantine.id);
    if (installed && policyDigest(installed) !== policyDigest(quarantine))
      throw new TypeError('Containment Policy receipt conflicts.');
    const ref = {
      execution: {
        owner: { kind: 'server' as const },
        executionId: intent.ref.execution.executionId,
      },
      stepId: intent.ref.stepId,
    };
    if (!installed) {
      const prepared = preparePolicyDocument({
        current,
        proposed: { schemaVersion: 1, statements: [...current.statements, quarantine] },
        userId: author.responsibleUserId,
        now: quarantine.authoredAt,
      });
      if (
        prepared.diff.added.length !== 1 ||
        prepared.diff.added[0] !== quarantine.id ||
        prepared.diff.changed.length ||
        prepared.diff.removed.length ||
        policyDigest(prepared.document) !==
          policyDigest({ schemaVersion: 1, statements: [...current.statements, quarantine] })
      )
        throw new TypeError('Containment exceeds its fixed deny template.');
      // This final native check follows preparation and immediately precedes the optimistic owner write.
      if ((await this.checkContainment(current, ref)) === null)
        return { kind: 'not-admitted' as const };
      const existingPolicy =
        raw.policy && typeof raw.policy === 'object' && !Array.isArray(raw.policy)
          ? raw.policy
          : {};
      await files.updateFile(
        {
          id: 'server.jsonc',
          kind: 'server',
          expectedRevision: read.file.revision,
          content: `${JSON.stringify({ ...raw, policy: { ...existingPolicy, mediation: prepared.document } }, null, 2)}\n`,
        },
        { policyWrite: true }
      );
      await manager.reload({ dryRun: false, mode: 'safe' });
    }
    const actual = validatePolicyDocument(
      manager.current().openKitConfig.policy?.mediation ?? EMPTY_POLICY_DOCUMENT
    );
    const receipt = await publishCoreJournal(this.db, {
      kind: 'containment-settle',
      policy: actual,
      ref,
    });
    if (receipt === null) throw new TypeError('Containment Policy outcome is unknown.');
    return {
      kind: 'quarantined' as const,
      sensorAuditEventId: intent.control.workId,
      execution: ref.execution,
      policyRevision: policyDigest(actual),
    };
  }

  /** Advances the later control phase from the existing maintenance pass, never the sensor response. */
  async advanceContainment(manager: RuntimeConfigManager, store: FsStore, executor: TurnExecutor) {
    if (!executor.interruptTurn || !executor.executionBackend)
      throw new TypeError('Containment requires the original executor.');
    const policy = validatePolicyDocument(
      manager.current().openKitConfig.policy?.mediation ?? EMPTY_POLICY_DOCUMENT
    );
    const quarantines = policy.statements.filter(
      (statement) => statement.lifetime.anchor.kind === 'quarantine'
    );
    if (quarantines.length > SECURITY_CONTAINMENT_LIMITS.currentServer)
      throw new TypeError('Containment control inventory exceeds its static bound.');
    const journal = createExecutionStepJournalReader(this.db, { kind: 'server' });
    for (const statement of quarantines) {
      const execution = { owner: { kind: 'server' as const }, executionId: statement.id };
      let original: Awaited<ReturnType<typeof journal.readInvocation>>;
      try {
        original = await journal.readInvocation({ execution, stepId: 'quarantine' });
      } catch {
        continue;
      } // An unrelated human quarantine grants no consumer effects.
      if (original.control.definitionVersion !== 'containment') continue;
      await publishCoreJournal(this.db, {
        kind: 'containment-settle',
        policy,
        ref: { execution, stepId: 'quarantine' },
      });
      const ref = { execution, stepId: 'cancel' };
      const admitted = await publishCoreJournal(this.db, {
        kind: 'containment-cancel',
        policy,
        ref,
      });
      if (admitted !== null) {
        const cancel = decodeExecutionJournalInvocation(admitted);
        if ((await this.checkContainment(policy, ref)) === null) continue;
        const references = cancel.control.inputRefs.filter((value) => value.startsWith('lineage:'));
        if (references.length !== 1)
          throw new TypeError('Containment cancellation lost its lineage.');
        const lineage = WorkerLineageSchema.parse(JSON.parse(references[0]!.slice(8)));
        try {
          await executor.interruptTurn(store, lineage.turnId, { requestId: null });
        } finally {
          await publishCoreJournal(this.db, { kind: 'containment-outcome', policy, ref });
        }
      } else {
        let cancel: Awaited<ReturnType<typeof journal.readInvocation>>;
        try {
          cancel = await journal.readInvocation(ref);
        } catch {
          continue;
        }
        if (!cancel.control.attemptId)
          throw new TypeError('Containment cancellation lost its attempt.');
        const attempt = requireSchedulerExecutionAttempt(this.db, cancel.control.attemptId);
        // Inspect the original even after monitoring or action authority ends. Never call cancel again.
        if (attempt.phase !== 'closed')
          await acceptSchedulerExecutionObservation(
            this.db,
            await executor.executionBackend.inspect(schedulerExecutionCorrelation(attempt))
          );
        await publishCoreJournal(this.db, { kind: 'containment-outcome', policy, ref });
      }
    }
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
