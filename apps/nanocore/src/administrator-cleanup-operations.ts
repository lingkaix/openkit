import { Buffer } from 'node:buffer';
import {
  ADMINISTRATOR_CLEANUP_MAX_BYTES,
  ADMINISTRATOR_CLEANUP_MAX_ENTRIES,
  type ADMINISTRATOR_CLEANUP_OPERATION_DEFINITIONS,
  ADMINISTRATOR_CLEANUP_SOURCE_OWNERS,
  ADMINISTRATOR_CLEANUP_SOURCES,
  type AdministratorCleanupReadResponse,
  AdministratorCleanupReadResponseSchema,
  type AdministratorCleanupSourceObservation,
  AdministratorCleanupWorkspaceDeletionItemSchema,
  AdministratorCleanupWorkspaceRegistryItemSchema,
} from '@openkit/app-api-schemas';
import Database from 'better-sqlite3';
import type { Actor } from './auth/identity.js';
import {
  DeploymentAdminRequiredError,
  requireAdministratorOperation,
} from './auth/operation-authorizer.js';
import { scopeAdmissionFailures } from './bootstrap/readiness.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import { type FamilyImplementations, publicOperationActor } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { readRuntimeCleanupView } from './runtime/administrator-cleanup-view.js';
import {
  listSchedulerExecutionAttemptsForTurn,
  requireSchedulerExecutionAttempt,
  type SchedulerExecutionAttemptRecord,
} from './runtime/execution-attempt-records.js';
import {
  CORE_SANDBOX_RELEASE_REFUSAL_DEFINITION,
  readExecutionJournalInvocation,
  readExecutionJournalRoot,
} from './runtime/execution-journal.js';
import { commandInputHash } from './storage/control-store-input.js';
import type { CoreDb } from './storage/db.js';
import {
  visitWorkspaceDeletionRequests,
  type WorkspaceDeletionRequestRecord,
} from './workspace-deletion-request.js';
import { getWorkspaceRegistryLifecycleFact } from './workspace-sharing.js';

/** Joins existing deletion and runtime observations without opening or changing a Workspace. */
export function createAdministratorCleanupOperationImplementations(
  dependencies: Pick<OperationInvocationDependencies, 'coreDb' | 'dataRoot'>
) {
  return {
    'administration.sandbox-hold-read': ({ cursor }, context) => {
      const actor = publicOperationActor(context);
      const coreDb = dependencies.coreDb;
      if (!coreDb) throw unavailable();
      requireAdministrator(coreDb, actor);
      let result: ReturnType<typeof readSandboxHolds>;
      try {
        result = coreDb.sqlite.transaction(() => readSandboxHolds(coreDb, cursor))();
      } catch (error) {
        throw unavailable(error);
      }
      requireAdministrator(coreDb, actor);
      return result;
    },
    'administration.cleanup-read': (_input, context) => {
      const actor = publicOperationActor(context);
      const coreDb = dependencies.coreDb;
      if (!coreDb) throw unavailable();
      const now = new Date();
      requireAdministrator(coreDb, actor);
      const observedAt = now.toISOString();
      const items: AdministratorCleanupReadResponse['items'] = [];
      const deletion: AdministratorCleanupSourceObservation = {
        source: 'workspace-deletion',
        availability: 'available',
        incomplete: false,
        reasons: [],
      };
      const registryCoverage: AdministratorCleanupSourceObservation = {
        source: 'workspace-registry',
        availability: 'available',
        incomplete: false,
        reasons: [],
      };
      // Coverage can grow after an item is read. Reserve its complete maximum encoding first,
      // including both array separators when deletion and runtime each contribute items.
      const reservedSources = ADMINISTRATOR_CLEANUP_SOURCES.map(maximumCoverage);
      const reservedMetadata =
        jsonBytes({
          observedAt,
          items: [],
          sources: reservedSources,
          incomplete: true,
        }) + 1;
      let itemBytes = 0;
      let exhausted: 'count_limit' | 'byte_limit' | undefined;
      try {
        if (!dependencies.dataRoot) throw new Error('Deletion storage is unavailable.');
        const coverage = visitWorkspaceDeletionRequests(
          dependencies.dataRoot,
          ADMINISTRATOR_CLEANUP_MAX_ENTRIES,
          (record) => {
            requireAdministrator(coreDb, actor);
            const registry = getWorkspaceRegistryLifecycleFact(coreDb, record.workspaceId);
            if (
              !registry ||
              !['active', 'deleting', 'deleted', 'retired'].includes(registry.status)
            ) {
              throw new Error('Deletion source authority is unavailable.');
            }
            const item = projectDeletion(record, observedAt);
            const addedBytes = jsonBytes(item) + (items.length > 0 ? 1 : 0);
            if (reservedMetadata + itemBytes + addedBytes > ADMINISTRATOR_CLEANUP_MAX_BYTES) {
              exhausted = 'byte_limit';
              return false;
            }
            items.push(item);
            itemBytes += addedBytes;
            return true;
          }
        );
        if (coverage.limited) {
          exhausted ??= 'count_limit';
          addReason(deletion, exhausted);
        }
        if (coverage.changed) addReason(deletion, 'source_changed');
      } catch (error) {
        // A current authority failure denies the aggregate, rather than exposing another source.
        if (error instanceof OperationError) throw error;
        deletion.availability = 'unavailable';
        addReason(deletion, 'source_unavailable');
      }
      requireAdministrator(coreDb, actor);
      if (exhausted) {
        registryCoverage.availability = 'unavailable';
        addReason(registryCoverage, 'source_unavailable');
        addReason(registryCoverage, exhausted);
      } else {
        try {
          const failures = scopeAdmissionFailures(coreDb.dataRoot).filter(
            (failure) =>
              failure.scope === 'workspace' &&
              failure.check !== 'index' &&
              failure.check !== 'retired'
          );
          const checks = new Map(failures.map((failure) => [failure.id, failure.check]));
          const refusedIds = JSON.stringify([...checks.keys()]);
          // A missing authority cannot turn a current quarantine diagnosis into an empty all-clear.
          if (
            coreDb.sqlite
              .prepare(
                `SELECT 1 FROM json_each(?) AS refused LEFT JOIN workspace_registry AS registry ON registry.workspace_id = refused.value WHERE registry.workspace_id IS NULL OR registry.status NOT IN ('active', 'deleting', 'deleted', 'retired') LIMIT 1`
              )
              .get(refusedIds)
          ) {
            throw new Error('Quarantined registry authority is unavailable.');
          }
          const rows = coreDb.sqlite
            .prepare(`SELECT workspace_id AS workspaceId, status, revision, updated_at AS updatedAt FROM workspace_registry
            WHERE status = 'retired' OR workspace_id IN (SELECT value FROM json_each(?))
            ORDER BY workspace_id LIMIT ?`)
            .all(refusedIds, ADMINISTRATOR_CLEANUP_MAX_ENTRIES - items.length + 1) as Array<{
            workspaceId: string;
            status: string;
            revision: number;
            updatedAt: string;
          }>;
          for (const row of rows) {
            requireAdministrator(coreDb, actor);
            if (items.length === ADMINISTRATOR_CLEANUP_MAX_ENTRIES) {
              exhausted = 'count_limit';
              addReason(registryCoverage, exhausted);
              break;
            }
            const target = { kind: 'workspace-registry' as const, workspaceId: row.workspaceId };
            const item = AdministratorCleanupWorkspaceRegistryItemSchema.parse({
              source: 'workspace-registry',
              sourceOwner: ADMINISTRATOR_CLEANUP_SOURCE_OWNERS['workspace-registry'],
              target,
              state: {
                registryStatus: row.status,
                registryRevision: row.revision,
                quarantineCheck: checks.get(row.workspaceId) ?? null,
                retirement:
                  row.status === 'retired' ? { dataRetained: true, storageReclaimed: false } : null,
              },
              sourceUpdatedAt: row.updatedAt,
              observedAt,
              evidence: { kind: 'unknown', reason: 'unavailable' },
              nextInspection: {
                kind: 'source-record',
                sourceOwner: ADMINISTRATOR_CLEANUP_SOURCE_OWNERS['workspace-registry'],
                target,
              },
            });
            const addedBytes = jsonBytes(item) + (items.length > 0 ? 1 : 0);
            if (reservedMetadata + itemBytes + addedBytes > ADMINISTRATOR_CLEANUP_MAX_BYTES) {
              exhausted = 'byte_limit';
              addReason(registryCoverage, exhausted);
              break;
            }
            items.push(item);
            itemBytes += addedBytes;
          }
        } catch (error) {
          if (error instanceof OperationError) throw error;
          registryCoverage.availability = 'unavailable';
          addReason(registryCoverage, 'source_unavailable');
        }
      }
      requireAdministrator(coreDb, actor);
      let runtime: ReturnType<typeof readRuntimeCleanupView>;
      try {
        runtime = readRuntimeCleanupView({
          coreDb,
          actor,
          now,
          maxEntries: exhausted ? 0 : ADMINISTRATOR_CLEANUP_MAX_ENTRIES - items.length,
          maxBytes:
            ADMINISTRATOR_CLEANUP_MAX_BYTES -
            itemBytes -
            jsonBytes(deletion) -
            jsonBytes(registryCoverage) -
            2 -
            (items.length > 0 ? 1 : 0),
        });
      } finally {
        // The runtime owner uses its native denial type. Recheck with public error projection
        // after acquisition, including a revocation observed inside its read transaction.
        requireAdministrator(coreDb, actor);
      }
      if (exhausted === 'byte_limit') {
        // The runtime reader's zero-ceiling path performs no enumeration. Its unvisited-source
        // count reason is replaced by the aggregate byte ceiling that caused that zero budget.
        for (const source of runtime.sources) {
          source.reasons = source.reasons.map((reason) =>
            reason === 'count_limit' ? 'byte_limit' : reason
          );
        }
      }
      const result: AdministratorCleanupReadResponse = {
        observedAt,
        items: [...items, ...runtime.items],
        sources: [deletion, registryCoverage, ...runtime.sources],
        incomplete: deletion.incomplete || registryCoverage.incomplete || runtime.incomplete,
      };
      // Admit the full known-field response again after joining actual coverage flags. No
      // strings or identities are shortened, and no further source work follows truncation.
      while (jsonBytes(result) > ADMINISTRATOR_CLEANUP_MAX_BYTES && result.items.length) {
        const omitted = result.items.pop()!;
        addReason(result.sources.find((source) => source.source === omitted.source)!, 'byte_limit');
        result.incomplete = true;
      }
      requireAdministrator(coreDb, actor);
      return AdministratorCleanupReadResponseSchema.parse(result);
    },
  } satisfies FamilyImplementations<typeof ADMINISTRATOR_CLEANUP_OPERATION_DEFINITIONS>;
}

/** Reads one page from Core alone, including when the original resident is gone. */
function readSandboxHolds(coreDb: CoreDb, cursor: string | undefined) {
  const limit = ADMINISTRATOR_CLEANUP_MAX_ENTRIES;
  const rows = coreDb.sqlite
    .prepare(`SELECT root.id AS holdRef, repair.step_id IS NOT NULL AS repairing
      FROM control_executions root
      JOIN control_execution_steps fence ON fence.execution_id = root.id AND fence.step_id = 'fence'
      LEFT JOIN control_execution_steps repair ON repair.execution_id = root.id
        AND repair.step_id = 'repair'
      WHERE root.definition_version = ? AND root.id > ? AND root.phase <> 'closed'
        AND json_extract(fence.invocation_json, '$.carriage.operation') = 'sandbox.release-refusal-hold'
        AND NOT EXISTS (
          SELECT 1 FROM scheduler_execution_attempts attempt
          WHERE attempt.attempt_id = json_extract(fence.control_json, '$.attemptId')
            AND attempt.binding_ref = json_extract(fence.invocation_json, '$.carriage.bindingRef')
            AND attempt.phase = 'closed' AND attempt.fence_ref = root.id
            AND attempt.terminal_cause = 'sandbox-release-refusal'
            AND attempt.deadline IS NULL AND attempt.disposition = 'not_accepted'
            AND attempt.input_ref IS NOT NULL AND attempt.agent_session_id IS NOT NULL
            AND json_extract(repair.invocation_json, '$.carriage.operation') = 'sandbox.release-repair'
        )
      ORDER BY root.id LIMIT ?`)
    .all(CORE_SANDBOX_RELEASE_REFUSAL_DEFINITION, cursor ?? '', limit + 1) as {
    holdRef: string;
    repairing: 0 | 1;
  }[];
  const incomplete = rows.length > limit;
  return {
    holds: rows.slice(0, limit).map(({ holdRef, repairing }) => {
      const hold = readRefusalJournalFence(coreDb, holdRef, 'sandbox.release-refusal-hold');
      if (!hold) throw new Error('Sandbox hold conflicts with its original journal binding.');
      if (repairing && !hasExactSandboxRepair(coreDb, hold))
        throw new Error('Sandbox repair conflicts with its hold.');
      const repairBlockedReason = originalRefusalProblem(coreDb, hold);
      return {
        sandboxRuntimeId: hold.sandboxRuntimeId,
        holdRef,
        revision: hold.root.revision,
        reason: 'worker_release_incompatible' as const,
        repairable: repairBlockedReason === null && !repairing,
        repairBlockedReason,
        correctiveAction: repairBlockedReason
          ? ('inspect-original-refusal-order' as const)
          : repairing
            ? ('await-exact-release' as const)
            : ('activate-compatible-worker-image-and-repair' as const),
      };
    }),
    incomplete,
    nextCursor: incomplete ? rows[limit - 1]!.holdRef : null,
  };
}

/** Validates the exact binding and invocation recorded in a hold or automatic order. */
function readRefusalJournalFence(
  coreDb: CoreDb,
  executionId: string,
  operation: 'sandbox.release-refusal-hold' | 'sandbox.release-refusal'
) {
  const execution = { owner: { kind: 'server' as const }, executionId };
  const root = readExecutionJournalRoot(coreDb, execution);
  const fence = readExecutionJournalInvocation(coreDb, { execution, stepId: 'fence' });
  const { bindingRef } = fence.carriage;
  const { attemptId, target } = fence.control;
  const [epoch] = fence.control.physicalFenceRefs;
  const [sandboxRuntimeId] = fence.control.authorityRefs;
  if (
    root.definitionVersion !== CORE_SANDBOX_RELEASE_REFUSAL_DEFINITION ||
    fence.state !== 'intent' ||
    fence.carriage.operation !== operation ||
    !attemptId ||
    !target ||
    !bindingRef ||
    target.backendKind !== 'openshell' ||
    target.allocationRef !== bindingRef ||
    fence.control.physicalFenceRefs.length !== 1 ||
    !epoch ||
    !/^[a-f0-9]{64}$/u.test(epoch) ||
    fence.control.authorityRefs.length !== 1 ||
    !sandboxRuntimeId ||
    sandboxRuntimeId.length > 512 ||
    root.workId !== bindingRef
  )
    return null;
  const fingerprint = commandInputHash([
    CORE_SANDBOX_RELEASE_REFUSAL_DEFINITION,
    target.targetId,
    epoch,
    bindingRef,
  ]);
  if (
    root.fingerprint !== fingerprint ||
    fence.control.fingerprint !== fingerprint ||
    fence.control.operationId !== fingerprint ||
    fence.carriage.requestId !== fingerprint ||
    fence.carriage.sequence !== null ||
    executionId !== `sandbox-release-refusal:${fingerprint}`
  )
    return null;
  return { root, fence, attemptId, target, epoch, bindingRef, sandboxRuntimeId };
}

type RefusalJournalFence = NonNullable<ReturnType<typeof readRefusalJournalFence>>;

/** The keyed administrator decision must name the same hold and physical binding as its fence. */
function hasExactSandboxRepair(coreDb: CoreDb, hold: RefusalJournalFence): boolean {
  if (
    !coreDb.sqlite
      .prepare(
        "SELECT 1 FROM control_execution_steps WHERE execution_id = ? AND step_id = 'repair'"
      )
      .get(hold.root.ref.executionId)
  )
    return false;
  const repair = readExecutionJournalInvocation(coreDb, {
    execution: hold.root.ref,
    stepId: 'repair',
  });
  const { target, inputRefs, physicalFenceRefs } = repair.control;
  return (
    repair.state === 'intent' &&
    repair.control.actor.kind === 'user' &&
    repair.control.attemptId === hold.attemptId &&
    repair.control.operationId === repair.carriage.requestId &&
    repair.carriage.operation === 'sandbox.release-repair' &&
    repair.carriage.sequence === null &&
    repair.carriage.bindingRef === hold.bindingRef &&
    inputRefs.length === 1 &&
    inputRefs[0] === hold.root.ref.executionId &&
    target?.backendKind === hold.target.backendKind &&
    target.targetId === hold.target.targetId &&
    target.allocationRef === hold.target.allocationRef &&
    physicalFenceRefs.length === 1 &&
    physicalFenceRefs[0] === hold.epoch
  );
}

/** Matches the retained attempt to its own pre-submission refusal fence. */
function matchesRefusedAttempt(
  attempt: SchedulerExecutionAttemptRecord,
  fence: RefusalJournalFence
): boolean {
  return (
    attempt.attemptId === fence.attemptId &&
    attempt.bindingRef === fence.bindingRef &&
    attempt.terminalCause === 'sandbox-release-refusal' &&
    attempt.deadline === null &&
    attempt.disposition === 'not_accepted' &&
    attempt.inputRef !== null &&
    attempt.agentSessionId !== null
  );
}

/** Only the committed pre-submission handoff records closure against this refusal. */
function completedSandboxHandoff(
  attempt: SchedulerExecutionAttemptRecord,
  fence: RefusalJournalFence
): boolean {
  return attempt.phase === 'closed' && attempt.fenceRef === fence.root.ref.executionId;
}

/** Authenticates the original order and every completed deliberate handoff in one Core snapshot. */
function originalRefusalProblem(
  coreDb: CoreDb,
  hold: RefusalJournalFence
): 'original-refusal-missing' | 'original-refusal-conflicting' | null {
  const [reference] = hold.fence.control.inputRefs;
  if (!reference) return 'original-refusal-missing';
  if (
    hold.fence.control.inputRefs.length !== 1 ||
    !/^sandbox-release-refusal:sha256:[a-f0-9]{64}$/u.test(reference) ||
    reference === hold.root.ref.executionId
  )
    return 'original-refusal-conflicting';
  if (
    !coreDb.sqlite
      .prepare(`SELECT 1 FROM control_execution_steps
      WHERE execution_id = ? AND step_id = 'fence'`)
      .get(reference)
  )
    return 'original-refusal-missing';

  try {
    const original = readRefusalJournalFence(coreDb, reference, 'sandbox.release-refusal');
    if (
      !original ||
      original.target.targetId !== hold.target.targetId ||
      original.fence.control.inputRefs.length
    )
      return 'original-refusal-conflicting';
    const held = requireSchedulerExecutionAttempt(coreDb, hold.attemptId);
    const attempts = listSchedulerExecutionAttemptsForTurn(coreDb, held);
    const start = attempts.findIndex(({ attemptId }) => attemptId === original.attemptId);
    const end = attempts.length - 1;
    if (
      start === -1 ||
      start >= end ||
      attempts[end]?.attemptId !== held.attemptId ||
      held.phase !== 'closing' ||
      !matchesRefusedAttempt(held, hold) ||
      attempts
        .slice(0, start)
        .some(({ terminalCause }) => terminalCause === 'sandbox-release-refusal')
    )
      return 'original-refusal-conflicting';

    const bindings = new Set([hold.bindingRef]);
    for (const attempt of attempts.slice(start, end)) {
      if (
        attempt.queueEntryId !== held.queueEntryId ||
        attempt.agentSessionId !== held.agentSessionId ||
        !attempt.bindingRef ||
        bindings.has(attempt.bindingRef)
      )
        return 'original-refusal-conflicting';
      bindings.add(attempt.bindingRef);

      if (attempt.attemptId === original.attemptId) {
        if (
          !matchesRefusedAttempt(attempt, original) ||
          !completedSandboxHandoff(attempt, original)
        )
          return 'original-refusal-conflicting';
        continue;
      }

      // Resolve the intermediate fence independently of the claimed release receipt.
      const candidates = coreDb.sqlite
        .prepare(`SELECT execution_id AS executionId FROM control_execution_steps
          WHERE step_id = 'fence'
            AND json_extract(invocation_json, '$.carriage.bindingRef') = ?
            AND json_extract(control_json, '$.definitionVersion') = ?
            AND json_extract(invocation_json, '$.carriage.operation') IN
              ('sandbox.release-refusal-hold', 'sandbox.release-refusal')
          LIMIT 2`)
        .all(attempt.bindingRef, CORE_SANDBOX_RELEASE_REFUSAL_DEFINITION) as {
        executionId: string;
      }[];
      if (candidates.length !== 1) return 'original-refusal-conflicting';
      const prior = readRefusalJournalFence(
        coreDb,
        candidates[0]!.executionId,
        'sandbox.release-refusal-hold'
      );
      if (
        !prior ||
        prior.target.targetId !== hold.target.targetId ||
        prior.fence.control.inputRefs.length !== 1 ||
        prior.fence.control.inputRefs[0] !== reference ||
        !matchesRefusedAttempt(attempt, prior) ||
        !hasExactSandboxRepair(coreDb, prior) ||
        !completedSandboxHandoff(attempt, prior)
      )
        return 'original-refusal-conflicting';
    }
    return null;
  } catch (error) {
    if (error instanceof Database.SqliteError) throw error;
    return 'original-refusal-conflicting';
  }
}

/** Keeps authority loss distinct from safe source-specific uncertainty. */
function requireAdministrator(coreDb: CoreDb, actor: Actor): void {
  try {
    requireAdministratorOperation(coreDb, actor, 'audit.read');
  } catch (error) {
    if (error instanceof DeploymentAdminRequiredError) {
      throw new OperationError(
        'deployment_admin_required',
        'Current deployment administrator authority is required.',
        403,
        { cause: error }
      );
    }
    if (error instanceof Database.SqliteError || !coreDb.sqlite.open) throw unavailable(error);
    throw error;
  }
}

/** Returns no raw storage details when the authority owner cannot be read. */
function unavailable(cause?: unknown): OperationError {
  return new OperationError(
    'administrator_cleanup_unavailable',
    'Administrator cleanup authority storage is unavailable.',
    503,
    { cause }
  );
}

/** Bounds flag growth before any item admission, without guessing source availability. */
function maximumCoverage(
  source: AdministratorCleanupSourceObservation['source']
): AdministratorCleanupSourceObservation {
  return {
    source,
    availability: 'unavailable',
    incomplete: true,
    reasons: ['count_limit', 'byte_limit', 'source_unavailable', 'source_changed'],
  };
}

/** Retains the precise reason without duplicates or a second aggregate cleanup state. */
function addReason(
  source: AdministratorCleanupSourceObservation,
  reason: AdministratorCleanupSourceObservation['reasons'][number]
): void {
  source.incomplete = true;
  if (!source.reasons.includes(reason)) source.reasons.push(reason);
}

/** Measures the complete compact known-field UTF-8 JSON representation. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Exposes only request-owner facts; phases without a timestamp remain explicitly undated. */
function projectDeletion(record: WorkspaceDeletionRequestRecord, observedAt: string) {
  const source = 'workspace-deletion' as const;
  const sourceOwner = ADMINISTRATOR_CLEANUP_SOURCE_OWNERS[source];
  const target = { kind: source, workspaceId: record.workspaceId, requestId: record.requestId };
  return AdministratorCleanupWorkspaceDeletionItemSchema.parse({
    source,
    sourceOwner,
    target,
    state: {
      phase: record.phase,
      retainedStaging: record.retainedStaging,
      cleanedAt: record.cleanedAt,
    },
    sourceUpdatedAt: record.cleanedAt,
    observedAt,
    evidence: record.cleanedAt
      ? { kind: 'recorded', recordedAt: record.cleanedAt, reference: target }
      : { kind: 'unknown', reason: 'missing' },
    nextInspection: { kind: 'source-record', sourceOwner, target },
  });
}
