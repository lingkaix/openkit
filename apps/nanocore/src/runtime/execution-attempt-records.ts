import { isDeepStrictEqual } from 'node:util';
import { AgentEnvironmentCredentialDeclarationSchema } from '@openkit/config-schema';
import {
  allocateEntityId,
  readRetainedV1,
  type WorkOwner,
  workspaceIdForOwner,
  writeRetainedV1,
} from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { z } from 'zod';
import { currentSchedulerAdmissionWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { revokeRunBoundAccessTokensInDb } from '../auth/run-bound-access-token-native.js';
import {
  type CoreSchedulerQueueEntry,
  requireSchedulerAdmissionEntry,
  schedulerAdmissionInputHash,
} from '../scheduler-records.js';
import type { ExecutionGrant } from '../storage/control-kernel-port.js';
import { commandInputHash } from '../storage/control-store-input.js';
import type { CoreDb } from '../storage/db.js';
import {
  SchedulerExecutionAttemptSchema as AttemptSchema,
  ExecutionAttemptRefusal,
} from '../storage/execution-attempt-codecs.js';
import type {
  ExecutionBackendCorrelation,
  ExecutionBackendObservation,
  ExecutionOperationDisposition,
  ExecutionReleaseProof,
} from './execution-backend.js';
import {
  admitKernelSchedulerGrantInDb,
  commitSchedulerAttemptLifecycleStepInDb,
  kernelSchedulerGrantClockAllowsOperation,
  kernelSchedulerScopeIsHeld,
  readKernelSchedulerGrantInDb,
} from './execution-journal.js';
import {
  type ExecutionJournalIntent,
  type SchedulerPreparationClaim,
  SchedulerPreparationClaimSchema,
} from './execution-step-journal.js';
import { nanoHostStartupDeadline } from './nanohost-attempt-clocks.js';

/** The production execution authority budget, fixed once at native submission. */
export const EXECUTION_ATTEMPT_BUDGET_MS = 7_200_000;

/** Neither external adapter has qualified input processing or a fence for this release. */
const heldExternalBackends = new Set(['openai-agents', 'e2b', 'e2b-mock']);

function requireQualifiedSchedulerBackend(backendId: string): void {
  if (heldExternalBackends.has(backendId))
    throw new ExecutionAttemptRefusal('Execution backend effects are unavailable.');
}

/** Generic durable attempt projection deliberately excludes NanoHost proof fields. */
export type SchedulerExecutionAttemptRecord = z.infer<typeof AttemptSchema>;

const attemptSelect = `SELECT attempt.schema_version AS schemaVersion, attempt.attempt_id AS attemptId,
  attempt.queue_entry_id AS queueEntryId, admission.backend_id AS backendId,
  attempt.workspace_id AS workspaceId, attempt.thread_id AS threadId, attempt.turn_id AS turnId,
  attempt.agent_session_id AS agentSessionId, attempt.input_ref AS inputRef,
  attempt.binding_ref AS bindingRef, attempt.phase, attempt.disposition,
  attempt.operation_id AS operationId, attempt.deadline, attempt.terminal_cause AS terminalCause,
  attempt.created_at AS createdAt,
  json_extract(claim.invocation_json, '$.carriage.schedulerPreparation') AS claim,
  (SELECT json_extract(step.span_json, '$.endTimeUnixNano')
     FROM control_execution_steps AS step
     WHERE step.execution_id = claim.execution_id AND step.state = 'completed'
     ORDER BY step.ordinal DESC LIMIT 1) AS lifecycleClock,
  (SELECT substr(ref.value, 9)
     FROM control_execution_steps AS step, json_each(step.control_json, '$.outputRefs') AS ref
     WHERE step.execution_id = claim.execution_id AND step.state = 'completed'
       AND json_extract(step.control_json, '$.kind') IN ('observe', 'cancel')
       AND ref.value GLOB 'outcome:*' ORDER BY step.ordinal LIMIT 1) AS outcomeRef,
  (SELECT substr(ref.value, 7)
     FROM control_execution_steps AS step, json_each(step.control_json, '$.outputRefs') AS ref
     WHERE step.execution_id = claim.execution_id AND step.state = 'completed'
       AND json_extract(step.control_json, '$.kind') IN ('observe', 'release')
       AND (attempt.phase <> 'closed' OR json_extract(step.control_json, '$.kind') = 'release')
       AND json_extract(step.control_json, '$.operationId') IS attempt.operation_id
       AND ref.value GLOB 'fence:*' ORDER BY step.ordinal LIMIT 1) AS fenceRef
  FROM scheduler_execution_attempts AS attempt LEFT JOIN scheduler_admission_entries AS admission
    ON admission.queue_entry_id = attempt.queue_entry_id AND admission.workspace_id = attempt.workspace_id
    AND admission.thread_id = attempt.thread_id AND admission.turn_id = attempt.turn_id
    AND admission.schema_version = ${writeRetainedV1({}).schemaVersion}
  LEFT JOIN control_executions AS lifecycle ON lifecycle.id = 'scheduler-lifecycle:' || attempt.attempt_id
    AND lifecycle.schema_version = 1 AND lifecycle.work_id = attempt.turn_id
    AND lifecycle.definition_version = 'core-scheduler-lifecycle/v1'
    AND lifecycle.input_fingerprint = admission.input_hash
  LEFT JOIN control_execution_steps AS claim ON claim.execution_id = lifecycle.id
    AND claim.step_id = 'claim' AND claim.state = 'completed'
    AND json_extract(claim.control_json, '$.attemptId') = attempt.attempt_id`;

const preparationSnapshot = z.object({
  admission: z
    .object({ queueEntryId: z.string(), inputHash: z.string() })
    .optional()
    .catch(undefined),
  manifest: z
    .object({
      id: z.string(),
      sandbox: z.object({ credentialDeclarations: z.array(z.unknown()).optional() }).optional(),
    })
    .optional(),
});

function preparationClaim(
  entry: CoreSchedulerQueueEntry,
  input: unknown
): SchedulerPreparationClaim {
  const { admission, manifest } = preparationSnapshot.parse(input);
  if (
    entry.inputHash !== schedulerAdmissionInputHash(entry) ||
    (admission &&
      (admission.queueEntryId !== entry.queueEntryId || admission.inputHash !== entry.inputHash))
  )
    throw new ExecutionAttemptRefusal('Attempt preparation conflicts with the original admission.');
  const declarations =
    manifest?.sandbox?.credentialDeclarations?.flatMap((value) => {
      const parsed = AgentEnvironmentCredentialDeclarationSchema.safeParse(value);
      return parsed.success && parsed.data.id === 'security_honey_inbound' ? [parsed.data] : [];
    }) ?? [];
  return SchedulerPreparationClaimSchema.parse({
    version: 1,
    queueEntryId: entry.queueEntryId,
    admissionHash: entry.inputHash,
    inputId: entry.inputRef.inputId,
    inputDigest: entry.inputRef.digest,
    preparationDigest: sha256Hex(JSON.stringify(input)),
    credential:
      manifest?.id === entry.requestedAgentId && declarations.length === 1
        ? { agentId: manifest.id, declaration: declarations[0]! }
        : null,
  });
}

const projectionRow = z.looseObject({
  queueEntryId: z.string(),
  workspaceId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
  backendId: z.string(),
  lifecycleClock: z.string().regex(/^\d+$/),
  claim: z.string(),
});

const projectionAdmissionKey = projectionRow.pick({ queueEntryId: true });

function decodeAttempt(coreDb: CoreDb, row: unknown): SchedulerExecutionAttemptRecord {
  return readRetainedV1(row, (value) => {
    const { queueEntryId } = projectionAdmissionKey.parse(value);
    const admission = requireSchedulerAdmissionEntry(coreDb, queueEntryId);
    const fields = projectionRow.parse(value);
    const claim = SchedulerPreparationClaimSchema.parse(JSON.parse(fields.claim));
    if (
      claim.queueEntryId !== admission.queueEntryId ||
      claim.admissionHash !== admission.inputHash ||
      claim.admissionHash !== schedulerAdmissionInputHash(admission) ||
      claim.inputId !== admission.inputRef.inputId ||
      claim.inputDigest !== admission.inputRef.digest ||
      fields.workspaceId !== admission.workspaceId ||
      fields.threadId !== admission.threadId ||
      fields.turnId !== admission.turnId ||
      fields.backendId !== admission.backendId ||
      (claim.credential && claim.credential.agentId !== admission.requestedAgentId)
    )
      throw new ExecutionAttemptRefusal('Attempt preparation has no exact original claim.');
    return AttemptSchema.parse({
      ...fields,
      updatedAt: new Date(Number(BigInt(fields.lifecycleClock) / 1_000_000n)).toISOString(),
      // These are the exact pre-AEP facts used by recovery and run-bound Vault authorization.
      preparationInputJson: JSON.stringify({
        admission: { ...admission, status: 'queued', denialReason: null },
        ...(claim.credential
          ? {
              manifest: {
                id: claim.credential.agentId,
                sandbox: { credentialDeclarations: [claim.credential.declaration] },
              },
            }
          : {}),
      }),
    });
  });
}

function recordLifecycle(
  db: CoreDb,
  attempt: Pick<
    SchedulerExecutionAttemptRecord,
    'attemptId' | 'queueEntryId' | 'turnId' | 'operationId'
  >,
  input: Omit<
    Parameters<typeof commitSchedulerAttemptLifecycleStepInDb>[1],
    'attemptId' | 'actor' | 'turnId' | 'admissionHash' | 'operationId'
  >
): void {
  const admission = requireSchedulerAdmissionEntry(db, attempt.queueEntryId);
  commitSchedulerAttemptLifecycleStepInDb(db, {
    ...input,
    attemptId: attempt.attemptId,
    actor: admission.triggerActor,
    turnId: attempt.turnId,
    admissionHash: admission.inputHash,
    operationId: attempt.operationId,
  });
}

/** Loads exact current authority and refuses unknown core values rather than guessing a phase. */
export function requireSchedulerExecutionAttempt(
  coreDb: CoreDb,
  attemptId: string
): SchedulerExecutionAttemptRecord {
  return decodeAttempt(
    coreDb,
    coreDb.sqlite.prepare(`${attemptSelect} WHERE attempt.attempt_id = ?`).get(attemptId)
  );
}

/**
 * Reads at most the requested attempt-ID prefix inside the caller's Core snapshot.
 * Invoke the returned decoder for an observed item only, after testing the count sentinel.
 */
export function* readSchedulerExecutionAttemptPrefix(
  coreDb: CoreDb,
  limit: number
): Generator<() => SchedulerExecutionAttemptRecord, void, undefined> {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError('Attempt prefix requires a finite nonnegative row limit.');
  if (!coreDb.sqlite.inTransaction)
    throw new ExecutionAttemptRefusal('Attempt prefix requires its Core snapshot.');
  const rows = coreDb.sqlite
    .prepare(`${attemptSelect} ORDER BY attempt.attempt_id LIMIT ?`)
    .iterate(limit);
  for (const row of rows) yield () => decodeAttempt(coreDb, row);
}

/** Lists exact Turn attempts in creation order; closed history cannot grant new authority. */
export function listSchedulerExecutionAttemptsForTurn(
  coreDb: CoreDb,
  input: { readonly workspaceId: string; readonly threadId: string; readonly turnId: string }
): SchedulerExecutionAttemptRecord[] {
  // Preserve the original single-SELECT snapshot for synchronous authority consumers.
  return coreDb.sqlite
    .transaction(() => {
      const result: SchedulerExecutionAttemptRecord[] = [];
      for (const page of readSchedulerExecutionAttemptPagesForTurn(coreDb, input))
        result.push(...page);
      return result;
    })
    .deferred();
}

/**
 * Reads the exact Turn's complete attempts in bounded creation-rowid pages through the same decoder.
 * Every SELECT ends before yielding; cooperative callers must not hold an enclosing transaction.
 * Rowid is a local continuation only and does not enter the retained attempt or public projection.
 */
export function* readSchedulerExecutionAttemptPagesForTurn(
  coreDb: CoreDb,
  input: { readonly workspaceId: string; readonly threadId: string; readonly turnId: string }
): Generator<readonly SchedulerExecutionAttemptRecord[], void, void> {
  let after: string | undefined;
  for (;;) {
    const rows = coreDb.sqlite
      .prepare(
        `${attemptSelect.replace('SELECT ', 'SELECT CAST(attempt.rowid AS TEXT) AS pageRowid, ')}
        WHERE attempt.workspace_id = ? AND attempt.thread_id = ? AND attempt.turn_id = ?
          ${after === undefined ? '' : 'AND attempt.rowid > ?'}
        ORDER BY attempt.rowid LIMIT 128`
      )
      .all(
        input.workspaceId,
        input.threadId,
        input.turnId,
        ...(after === undefined ? [] : [after])
      ) as Array<{ pageRowid: string } & Record<string, unknown>>;
    if (!rows.length) return;
    const page = rows.map(({ pageRowid: _pageRowid, ...row }) => decodeAttempt(coreDb, row));
    after = rows.at(-1)!.pageRowid;
    yield page;
  }
}

/** Lists every retained owner of one Turn id so exclusion checks cannot hide conflicting scope. */
export function listSchedulerExecutionAttemptsByTurnId(
  coreDb: CoreDb,
  turnId: string
): SchedulerExecutionAttemptRecord[] {
  return coreDb.sqlite
    .prepare(`${attemptSelect} WHERE attempt.turn_id = ? ORDER BY attempt.rowid`)
    .all(turnId)
    .map((row) => decodeAttempt(coreDb, row));
}

/** Closed busy refusals contain no execution and cannot compete with the later original-Turn attempt. */
export function isSchedulerExecutionBusyRefusal(attempt: SchedulerExecutionAttemptRecord): boolean {
  return (
    attempt.phase === 'closed' &&
    attempt.disposition === 'not_accepted' &&
    attempt.operationId === null &&
    attempt.terminalCause === 'backend-busy'
  );
}

/** Enumerates held exclusion for the existing restart and maintenance owner. */
export function listOpenSchedulerExecutionAttempts(
  coreDb: CoreDb
): SchedulerExecutionAttemptRecord[] {
  return coreDb.sqlite
    .prepare(`${attemptSelect} WHERE attempt.phase <> 'closed' ORDER BY attempt.rowid`)
    .all()
    .map((row) => decodeAttempt(coreDb, row));
}

/** Acquires only the selected entry's product boundaries, before any preparation effect. */
export function createSchedulerExecutionAttempt(
  coreDb: CoreDb,
  input: {
    readonly entry: CoreSchedulerQueueEntry;
    readonly attemptId?: string;
    readonly preparationInput: unknown;
    readonly now?: () => string;
  }
): SchedulerExecutionAttemptRecord {
  const timestamp = input.now?.() ?? new Date().toISOString();
  const attemptId = input.attemptId ?? allocateEntityId('attempt');
  return coreDb.sqlite
    .transaction(() => {
      const entry = requireSchedulerAdmissionEntry(coreDb, input.entry.queueEntryId);
      requireQualifiedSchedulerBackend(entry.backendId);
      if (
        entry.status !== 'queued' ||
        entry.backendId !== input.entry.backendId ||
        !currentSchedulerAdmissionWorkspaceAuthority(coreDb, entry, 'runtime.launch', true)
      ) {
        throw new ExecutionAttemptRefusal('The exact queued admission is no longer dispatchable.');
      }
      const storage = entry.workerStorageChoice;
      if (
        kernelSchedulerScopeIsHeld(coreDb, [
          `workspace:${entry.workspaceId}`,
          `thread:${entry.threadId}`,
          `turn:${entry.turnId}`,
          ...(storage?.kind === 'selected' ? [storage.storageRef] : []),
        ])
      )
        throw new ExecutionAttemptRefusal(
          'Execution placement has an unresolved writer.',
          'placement-held'
        );
      coreDb.sqlite
        .prepare(`INSERT INTO scheduler_execution_attempts
      (attempt_id, queue_entry_id, workspace_id, thread_id, turn_id,
       phase, disposition, created_at, schema_version)
      VALUES (?, ?, ?, ?, ?, 'open', 'not_accepted', ?, ?)`)
        .run(
          attemptId,
          entry.queueEntryId,
          entry.workspaceId,
          entry.threadId,
          entry.turnId,
          timestamp,
          writeRetainedV1({}).schemaVersion
        );
      const acquired = coreDb.sqlite
        .prepare(
          "UPDATE scheduler_admission_entries SET status = 'admitted' WHERE queue_entry_id = ? AND status = 'queued'"
        )
        .run(entry.queueEntryId);
      if (acquired.changes !== 1)
        throw new ExecutionAttemptRefusal('Admission ownership changed before preparation.');
      recordLifecycle(
        coreDb,
        { ...entry, attemptId, operationId: null },
        {
          kind: 'admit',
          timestamp,
          preparation: preparationClaim(entry, input.preparationInput),
        }
      );
      return requireSchedulerExecutionAttempt(coreDb, attemptId);
    })
    .immediate();
}

/** Binds the selected AgentSession conditionally under its unique live-attempt constraint. */
export function bindSchedulerExecutionAttemptSession(
  coreDb: CoreDb,
  input: {
    readonly attemptId: string;
    readonly agentSessionId: string;
    readonly now?: () => string;
  }
): SchedulerExecutionAttemptRecord {
  return coreDb.sqlite
    .transaction(() => {
      const attempt = requireSchedulerExecutionAttempt(coreDb, input.attemptId);
      if (
        attempt.phase !== 'open' ||
        (attempt.agentSessionId !== null && attempt.agentSessionId !== input.agentSessionId)
      )
        throw new ExecutionAttemptRefusal('Attempt AgentSession ownership changed.');
      if (
        kernelSchedulerScopeIsHeld(
          coreDb,
          [`session:${input.agentSessionId}`, input.agentSessionId],
          attempt.attemptId
        )
      )
        throw new ExecutionAttemptRefusal('Selected AgentSession has an unresolved writer.');
      if (attempt.agentSessionId === input.agentSessionId) return attempt;
      const updated = coreDb.sqlite
        .prepare(`UPDATE scheduler_execution_attempts SET agent_session_id = ?
    WHERE attempt_id = ? AND phase = 'open' AND agent_session_id IS ?`)
        .run(input.agentSessionId, attempt.attemptId, attempt.agentSessionId);
      if (updated.changes !== 1)
        throw new ExecutionAttemptRefusal('Attempt lost its AgentSession binding race.');
      recordLifecycle(coreDb, attempt, {
        kind: 'open-session',
        timestamp: input.now?.() ?? new Date().toISOString(),
      });
      return requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
    })
    .immediate();
}

/** Publishes the immutable finalized package and compatible binding before native submission. */
export function finalizeSchedulerExecutionAttemptInput(
  coreDb: CoreDb,
  input: {
    readonly attemptId: string;
    readonly inputRef: string;
    readonly bindingRef: string;
    readonly now?: () => string;
  }
): SchedulerExecutionAttemptRecord {
  return coreDb.sqlite
    .transaction(() => {
      const attempt = requireSchedulerExecutionAttempt(coreDb, input.attemptId);
      if (
        attempt.phase !== 'open' ||
        !attempt.agentSessionId ||
        (attempt.inputRef && attempt.inputRef !== input.inputRef) ||
        (attempt.bindingRef && attempt.bindingRef !== input.bindingRef)
      )
        throw new ExecutionAttemptRefusal('Finalized attempt input contradicts its owner.');
      if (attempt.inputRef === input.inputRef && attempt.bindingRef === input.bindingRef)
        return attempt;
      const updated = coreDb.sqlite
        .prepare(`UPDATE scheduler_execution_attempts SET input_ref = ?, binding_ref = ?
      WHERE attempt_id = ? AND phase = 'open' AND input_ref IS ? AND binding_ref IS ?`)
        .run(
          input.inputRef,
          input.bindingRef,
          attempt.attemptId,
          attempt.inputRef,
          attempt.bindingRef
        );
      if (updated.changes !== 1)
        throw new ExecutionAttemptRefusal('Finalized input lost its attempt ownership race.');
      recordLifecycle(coreDb, attempt, {
        kind: 'resolve-setup',
        timestamp: input.now?.() ?? new Date().toISOString(),
      });
      return requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
    })
    .immediate();
}

/** Records exact possible acceptance before an operation can affect the backend. */
export function recordSchedulerExecutionOperation(
  coreDb: CoreDb,
  input: {
    readonly attemptId: string;
    readonly operationId: string;
    readonly submission?: boolean;
    readonly now?: () => string;
  }
): SchedulerExecutionAttemptRecord {
  return coreDb.sqlite
    .transaction(() => {
      if (!input.operationId)
        throw new ExecutionAttemptRefusal(
          'Backend operation identity is required before an effect.'
        );
      const attempt = requireSchedulerExecutionAttempt(coreDb, input.attemptId);
      const entry = requireSchedulerAdmissionEntry(coreDb, attempt.queueEntryId);
      requireQualifiedSchedulerBackend(attempt.backendId);
      const timestamp = input.now?.() ?? new Date().toISOString();
      if (
        attempt.phase !== 'open' ||
        !currentSchedulerAdmissionWorkspaceAuthority(coreDb, entry, 'runtime.launch', true)
      )
        throw new ExecutionAttemptRefusal('Execution authority was revoked before the operation.');
      if (input.submission && (!attempt.agentSessionId || !attempt.inputRef || !attempt.bindingRef))
        throw new ExecutionAttemptRefusal(
          'Submission has no finalized package or assigned binding.'
        );
      if (attempt.disposition === 'unknown')
        throw new ExecutionAttemptRefusal(
          'An unknown operation must be inspected or fenced before another effect.'
        );
      if (input.submission && attempt.deadline !== null)
        throw new ExecutionAttemptRefusal('This attempt already owns a possible submission.');
      const deadline = input.submission
        ? new Date(Date.parse(timestamp) + EXECUTION_ATTEMPT_BUDGET_MS).toISOString()
        : attempt.deadline;
      const updated = coreDb.sqlite
        .prepare(`UPDATE scheduler_execution_attempts SET operation_id = ?, disposition = 'unknown', deadline = ?
      WHERE attempt_id = ? AND phase = 'open' AND operation_id IS ? AND deadline IS ?`)
        .run(input.operationId, deadline, attempt.attemptId, attempt.operationId, attempt.deadline);
      if (updated.changes !== 1)
        throw new ExecutionAttemptRefusal('Operation intent lost its attempt ownership race.');
      recordLifecycle(
        coreDb,
        { ...attempt, operationId: input.operationId },
        { kind: 'deliver-start', timestamp }
      );
      return requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
    })
    .immediate();
}

/** Returns the original operation identity for inspection, cancellation, or release without replay. */
export function schedulerExecutionCorrelation(
  attempt: SchedulerExecutionAttemptRecord
): ExecutionBackendCorrelation {
  // Agents API cancellation targets the session's current Turn, which may be a successor.
  requireQualifiedSchedulerBackend(attempt.backendId);
  if (!attempt.operationId)
    throw new ExecutionAttemptRefusal('Attempt has no outstanding operation identity.');
  return {
    attemptId: attempt.attemptId,
    backendId: attempt.backendId,
    bindingRef: attempt.bindingRef,
    inputRef: attempt.inputRef,
    operationId: attempt.operationId,
  };
}

/** Core decides the original operation and its qualified generation in the same savepoint. */
export function recordSchedulerExecutionGrantInDb(
  coreDb: CoreDb,
  input: Parameters<typeof recordSchedulerExecutionOperation>[1] & {
    readonly generation: string;
    readonly proposal: ExecutionJournalIntent;
  },
  verifyCurrentPlacement: (original: ExecutionGrant) => boolean
): { readonly state: 'admitted-now' | 'inspect-original'; readonly grant: ExecutionGrant } {
  if (!coreDb.sqlite.inTransaction)
    throw new ExecutionAttemptRefusal('Execution grant requires the Core writer transaction.');
  const execution = {
    owner: { kind: 'server' as const },
    executionId: input.attemptId,
  };
  return coreDb.sqlite.transaction(() => {
    const currentAttempt = requireSchedulerExecutionAttempt(coreDb, input.attemptId);
    const entry = requireSchedulerAdmissionEntry(coreDb, currentAttempt.queueEntryId);
    if (
      !isDeepStrictEqual(input.proposal.control.actor, entry.triggerActor) ||
      input.proposal.execution.fingerprint !== entry.inputHash
    )
      throw new ExecutionAttemptRefusal('Execution grant conflicts with the admitted work.');
    const original = readKernelSchedulerGrantInDb(coreDb, execution, input.operationId);
    if (original) {
      if (
        original.generation !== input.generation ||
        (input.submission === true && original.deadline === null) ||
        admitKernelSchedulerGrantInDb(
          coreDb,
          input.proposal,
          original,
          () => false,
          input.submission
        ).state !== 'settled'
      )
        throw new ExecutionAttemptRefusal('Execution grant conflicts with its original operation.');
      return { state: 'inspect-original', grant: original } as const;
    }
    const timestamp = input.now?.() ?? new Date().toISOString();
    const currentMs = Date.parse(timestamp);
    const startedMs = Date.parse(currentAttempt.createdAt);
    const deadlineMs =
      currentAttempt.deadline === null
        ? startedMs + EXECUTION_ATTEMPT_BUDGET_MS
        : Date.parse(currentAttempt.deadline);
    if (!(currentMs >= startedMs && currentMs < deadlineMs))
      throw new ExecutionAttemptRefusal('Original execution clock is unavailable or expired.');
    const now = BigInt(currentMs) * 1_000_000n;
    const proposalDeadline = input.proposal.control.deadlineUnixNano;
    const preparation =
      input.submission === true &&
      currentAttempt.backendId === 'nanohost' &&
      currentAttempt.deadline === null &&
      currentAttempt.operationId !== null &&
      currentAttempt.disposition === 'accepted'
        ? {
            operationId: currentAttempt.operationId,
            actor: entry.triggerActor,
            turnId: currentAttempt.turnId,
            admissionHash: entry.inputHash,
            started: BigInt(startedMs) * 1_000_000n,
            startupDeadline:
              BigInt(Date.parse(nanoHostStartupDeadline(currentAttempt))) * 1_000_000n,
          }
        : undefined;
    if (
      (proposalDeadline !== null && now >= proposalDeadline) ||
      (currentAttempt.operationId !== null &&
        !kernelSchedulerGrantClockAllowsOperation(
          coreDb,
          execution,
          currentAttempt.deadline !== null,
          now,
          BigInt(deadlineMs) * 1_000_000n,
          preparation
        ))
    )
      throw new ExecutionAttemptRefusal('Original execution clock is unavailable or expired.');
    const attempt = recordSchedulerExecutionOperation(coreDb, { ...input, now: () => timestamp });
    const coordinates = {
      ...schedulerExecutionCorrelation(attempt),
      execution,
      turnId: attempt.turnId,
      generation: input.generation,
    };
    const grant: ExecutionGrant = attempt.deadline
      ? { ...coordinates, deadline: attempt.deadline }
      : {
          ...coordinates,
          deadline: null,
          preparationStep: { execution, stepId: input.proposal.stepId },
        };
    const decision = admitKernelSchedulerGrantInDb(
      coreDb,
      input.proposal,
      grant,
      verifyCurrentPlacement,
      input.submission
    );
    if (decision.state !== 'settled')
      throw new ExecutionAttemptRefusal('The original execution grant is unavailable.');
    return { state: 'admitted-now', grant: decision.receipt } as const;
  })();
}

/** Rejects missing, stale, or contradictory observations without changing held exclusion. */
export function acceptSchedulerExecutionObservation(
  coreDb: CoreDb,
  observation: ExecutionBackendObservation | null
): SchedulerExecutionAttemptRecord | null {
  return coreDb.sqlite
    .transaction(() => {
      if (!observation) return null;
      const found = coreDb.sqlite
        .prepare(`${attemptSelect} WHERE attempt.attempt_id = ?`)
        .get(observation.attemptId);
      if (!found) return null;
      const attempt = decodeAttempt(coreDb, found);
      if (
        attempt.backendId !== observation.backendId ||
        attempt.bindingRef !== observation.bindingRef ||
        attempt.inputRef !== observation.inputRef ||
        attempt.operationId !== observation.operationId ||
        !['not_accepted', 'accepted', 'unknown'].includes(observation.disposition) ||
        !['pending', 'running', 'terminal', 'unknown'].includes(observation.execution) ||
        (observation.outcomeRef !== null &&
          (typeof observation.outcomeRef !== 'string' || !observation.outcomeRef)) ||
        (observation.fenceRef !== null &&
          (typeof observation.fenceRef !== 'string' || !observation.fenceRef)) ||
        (attempt.outcomeRef !== null &&
          observation.outcomeRef !== null &&
          attempt.outcomeRef !== observation.outcomeRef) ||
        (attempt.fenceRef !== null &&
          observation.fenceRef !== null &&
          attempt.fenceRef !== observation.fenceRef)
      )
        return null;
      // Uncertainty cannot erase definite acceptance; cancellation never reopens authority.
      const disposition: ExecutionOperationDisposition =
        attempt.disposition === 'accepted' && observation.disposition === 'unknown'
          ? 'accepted'
          : observation.disposition;
      if (attempt.disposition === 'accepted' && disposition === 'not_accepted') return null;
      if (attempt.phase === 'closed') return attempt;
      const outputRefs = [
        ...(attempt.outcomeRef === null && observation.outcomeRef !== null
          ? [`outcome:${observation.outcomeRef}`]
          : []),
        ...(attempt.fenceRef === null && observation.fenceRef !== null
          ? [`fence:${observation.fenceRef}`]
          : []),
      ];
      if (disposition === attempt.disposition && outputRefs.length === 0) return attempt;
      const updated = coreDb.sqlite
        .prepare(`UPDATE scheduler_execution_attempts SET disposition = ?
      WHERE attempt_id = ? AND phase = ? AND operation_id = ?`)
        .run(disposition, attempt.attemptId, attempt.phase, attempt.operationId);
      if (updated.changes !== 1) return null;
      recordLifecycle(coreDb, attempt, {
        kind: 'observe',
        timestamp: new Date().toISOString(),
        outputRefs,
      });
      return requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
    })
    .immediate();
}

/** Revokes new authority before cancellation or terminal handoff; the first cause survives late facts. */
export function markSchedulerExecutionAttemptClosing(
  coreDb: CoreDb,
  input: {
    readonly attemptId: string;
    readonly cause: string;
    readonly requireUnsubmitted?: true;
    readonly outcomeRef?: string | null;
    readonly now?: () => string;
  }
): SchedulerExecutionAttemptRecord {
  return coreDb.sqlite
    .transaction(() => {
      const current = requireSchedulerExecutionAttempt(coreDb, input.attemptId);
      // The native owner decides whether submission or expiry owns this transition.
      if (
        current.phase === 'closed' ||
        (input.requireUnsubmitted && (current.phase !== 'open' || current.deadline !== null))
      )
        return current;
      const outcomeRef = current.outcomeRef === null ? input.outcomeRef : null;
      if (current.phase === 'closing' && !outcomeRef) return current;
      revokeRunBoundAccessTokensInDb(coreDb, input.attemptId);
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_execution_attempts SET phase = 'closing', terminal_cause = COALESCE(terminal_cause, ?) WHERE attempt_id = ? AND phase <> 'closed'`
        )
        .run(input.cause, input.attemptId);
      recordLifecycle(coreDb, current, {
        kind: 'cancel',
        timestamp: input.now?.() ?? new Date().toISOString(),
        outputRefs: outcomeRef ? [`outcome:${outcomeRef}`] : [],
      });
      return requireSchedulerExecutionAttempt(coreDb, input.attemptId);
    })
    .immediate();
}

/** Closes only the entire attempt's definite no-effect refusal, preserving the same queued Turn on busy. */
export function closeSchedulerExecutionAttemptWithoutEffects(
  coreDb: CoreDb,
  input: {
    readonly attemptId: string;
    readonly noOutstandingEffects: true;
    readonly cause: string;
    readonly requeue?: boolean;
    readonly now?: () => string;
  }
): SchedulerExecutionAttemptRecord {
  return coreDb.sqlite
    .transaction(() => {
      const attempt = requireSchedulerExecutionAttempt(coreDb, input.attemptId);
      if (input.noOutstandingEffects !== true)
        throw new ExecutionAttemptRefusal(
          'Attempt closure requires definite whole-attempt no-effect proof.'
        );
      if (attempt.phase === 'closed') return attempt;
      if (attempt.disposition === 'accepted')
        throw new ExecutionAttemptRefusal('Accepted effects require the proved release fence.');
      if (input.requeue) requireSchedulerAdmissionEntry(coreDb, attempt.queueEntryId);
      const timestamp = input.now?.() ?? new Date().toISOString();
      revokeRunBoundAccessTokensInDb(coreDb, input.attemptId);
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_execution_attempts SET phase = 'closed', disposition = 'not_accepted', terminal_cause = COALESCE(terminal_cause, ?) WHERE attempt_id = ? AND phase <> 'closed'`
        )
        .run(input.cause, attempt.attemptId);
      if (input.requeue)
        coreDb.sqlite
          .prepare(
            "UPDATE scheduler_admission_entries SET status = 'queued' WHERE queue_entry_id = ? AND status = 'admitted'"
          )
          .run(attempt.queueEntryId);
      recordLifecycle(coreDb, attempt, {
        kind: 'release',
        timestamp,
        closed: true,
      });
      return requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
    })
    .immediate();
}

/** Releases exclusion only after complete Core barriers and the exact backend fence. */
export function closeSchedulerExecutionAttemptWithFence(
  coreDb: CoreDb,
  input: {
    readonly correlation: ExecutionBackendCorrelation;
    readonly proof: ExecutionReleaseProof;
    readonly fenceRef: string;
    readonly now?: () => string;
  }
): SchedulerExecutionAttemptRecord {
  return coreDb.sqlite
    .transaction(() => {
      const attempt = requireSchedulerExecutionAttempt(coreDb, input.correlation.attemptId);
      if (
        commandInputHash(schedulerExecutionCorrelation(attempt)) !==
          commandInputHash(input.correlation) ||
        !input.fenceRef ||
        ((attempt.phase === 'closed' || attempt.fenceRef !== null) &&
          attempt.fenceRef !== input.fenceRef) ||
        ![
          input.proof.terminalHandoff,
          input.proof.output,
          input.proof.evidence,
          input.proof.outsideWorkspaceCollection,
          input.proof.integrationDrain,
          input.proof.routesRevoked,
        ].every((value) => value === true)
      )
        throw new ExecutionAttemptRefusal(
          'Attempt release has unresolved handoff or fencing proof.'
        );
      if (attempt.phase === 'closed') return attempt;
      if (attempt.phase !== 'closing')
        throw new ExecutionAttemptRefusal('Attempt release has no revoked owner.');
      const updated = coreDb.sqlite
        .prepare(
          `UPDATE scheduler_execution_attempts SET phase = 'closed' WHERE attempt_id = ? AND phase = 'closing' AND operation_id = ?`
        )
        .run(attempt.attemptId, attempt.operationId);
      if (updated.changes !== 1)
        throw new ExecutionAttemptRefusal('Release proof lost its attempt ownership race.');
      recordLifecycle(coreDb, attempt, {
        kind: 'release',
        timestamp: input.now?.() ?? new Date().toISOString(),
        closed: true,
        outputRefs: [`fence:${input.fenceRef}`],
      });
      return requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
    })
    .immediate();
}

/** Terminal product publication revokes authority; only the backend's complete release proof closes it. */
export function markSchedulerAttemptForTerminalTurn(
  coreDb: CoreDb | undefined,
  turn: {
    readonly id: string;
    readonly owner: WorkOwner;
    readonly threadId: string;
    readonly status: string;
  }
): void {
  if (!coreDb || !['completed', 'interrupted', 'cancelled', 'failed'].includes(turn.status)) return;
  for (const attempt of listSchedulerExecutionAttemptsForTurn(coreDb, {
    workspaceId: workspaceIdForOwner(turn.owner),
    threadId: turn.threadId,
    turnId: turn.id,
  })) {
    if (attempt.phase === 'closed') continue;
    markSchedulerExecutionAttemptClosing(coreDb, {
      attemptId: attempt.attemptId,
      cause: `turn-${turn.status}`,
      outcomeRef: `turn:${turn.id}:${turn.status}`,
    });
  }
}
